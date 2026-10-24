const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'provision-storage-'));
process.env.PROVISION_DATA_FILE = path.join(dir, 'data.json');
const storage = require('../services/storageService');

const user = (email) => ({ email, name: email, passwordHash: 'x', createdAt: new Date().toISOString() });
let alice;
let bob;

before(async () => {
  fs.rmSync(storage.DATA_FILE, { force: true });
  await storage.createAccount('user_alice', user('alice@example.org'), { name: 'Alice Food Bank', postcode: 'SW7 2AZ' });
  await storage.createAccount('user_bob', user('bob@example.org'), { name: 'Bob Pantry', postcode: 'M1 1AE' });
  alice = storage.forUser('user_alice');
  bob = storage.forUser('user_bob');
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('creates data.json with one workspace per account', async () => {
  const root = await storage.loadRoot();
  assert.equal(root.metadata.schemaVersion, storage.SCHEMA_VERSION);
  assert.deepEqual(Object.keys(root.workspaces).sort(), ['user_alice', 'user_bob']);
  assert.deepEqual(storage.validateStructure(root), []);
  assert.equal((await alice.loadData()).organisation.name, 'Alice Food Bank');
  assert.equal((await bob.loadData()).organisation.name, 'Bob Pantry');
});

test('refuses a second account with the same email', async () => {
  await assert.rejects(storage.createAccount('user_x', user('alice@example.org'), { name: 'X' }), /already exists/);
});

test('keeps each account\'s data separate', async () => {
  await alice.mutate((ws) => {
    ws.products.rice = { name: 'Rice', category: 'staple_carbohydrates', priority: 'essential' };
    ws.historicalStock.r1 = { productId: 'rice', date: '2026-01-05', quantity: 10 };
  });
  assert.equal(Object.keys((await alice.loadData()).products).length, 1);
  assert.deepEqual((await bob.loadData()).products, {});

  await bob.resetDemoData();
  assert.ok(Object.keys((await bob.loadData()).products).length > 1, 'Bob gets the sample data');
  assert.deepEqual(Object.keys((await alice.loadData()).products), ['rice'], 'Alice is untouched');
});

test('a store cannot be created for an unknown or missing account', async () => {
  assert.throws(() => storage.forUser(''), /signed-in account/);
  await assert.rejects(storage.forUser('user_ghost').mutate(() => {}), /Account not found/);
});

test('serialises concurrent writes so none are lost', async () => {
  await Promise.all(Array.from({ length: 25 }, (_, i) => alice.updateNestedValue(['analysis', 'patterns', `p${i}`], i)));
  assert.equal(Object.keys((await alice.loadData()).analysis.patterns).length, 25);
});

test('rejects invalid writes and leaves the file unchanged', async () => {
  const before = fs.readFileSync(storage.DATA_FILE, 'utf8');
  await assert.rejects(alice.updateSection('products', []), storage.StorageValidationError);
  await assert.rejects(
    alice.mutate((ws) => { ws.historicalStock.bad = { productId: 'missing', date: '2026-01-01', quantity: 1 }; }),
    /unknown product/,
  );
  assert.equal(fs.readFileSync(storage.DATA_FILE, 'utf8'), before);
});

test('refuses prototype-polluting paths', () => {
  assert.throws(() => alice.updateNestedValue('__proto__.polluted', true), /Invalid path/);
});

test('historical changes invalidate downstream results but keep audit records', async () => {
  await alice.mutate((ws) => {
    ws.parameters = { products: { a: {} }, global: {}, approved: true };
    ws.simulation.policies = { lean: {} };
    ws.recommendations.selectedPolicy = 'lean';
    ws.audit.records.rec_1 = { id: 'rec_1' };
  });
  const startVersion = (await alice.loadData()).audit.inputVersion;
  await alice.invalidate('historical');
  const ws = await alice.loadData();
  assert.equal(ws.parameters.approved, false);
  assert.deepEqual(ws.simulation.policies, {});
  assert.equal(ws.recommendations.selectedPolicy, null);
  assert.equal(ws.audit.inputVersion, startVersion + 1);
  assert.ok(ws.audit.records.rec_1);
});

test('scenario changes clear simulations without bumping the input version', async () => {
  await alice.mutate((ws) => { ws.simulation.policies = { lean: {} }; });
  const startVersion = (await alice.loadData()).audit.inputVersion;
  await alice.invalidate('scenario');
  const ws = await alice.loadData();
  assert.deepEqual(ws.simulation.policies, {});
  assert.equal(ws.audit.inputVersion, startVersion);
});

test('reset keeps the organisation and finalised records, and the version keeps rising', async () => {
  const before = await alice.loadData();
  await alice.resetDemoData();
  const ws = await alice.loadData();
  assert.equal(ws.organisation.name, 'Alice Food Bank');
  assert.ok(ws.audit.records.rec_1);
  assert.equal(ws.analysis.patterns.p0, undefined);
  assert.ok(ws.audit.inputVersion > before.audit.inputVersion);
});

test('migrates the old shared layout: the first account keeps the data', async () => {
  const old = {
    metadata: { schemaVersion: '1.0', project: 'SupplyShield', currentStep: 2 },
    users: {
      user_new: { email: 'new@example.org', createdAt: '2026-02-01T00:00:00Z' },
      user_old: { email: 'old@example.org', createdAt: '2026-01-01T00:00:00Z' },
    },
    organisation: { name: 'Shared Food Bank', postcode: 'SW7 2AZ' },
    products: { rice: { name: 'Rice' } },
    historicalStock: {},
  };
  fs.writeFileSync(storage.DATA_FILE, JSON.stringify(old));
  const root = await storage.loadRoot();
  assert.equal(root.metadata.schemaVersion, '2.0');
  assert.equal(root.workspaces.user_old.organisation.name, 'Shared Food Bank');
  assert.ok(root.workspaces.user_old.products.rice);
  assert.equal(root.workspaces.user_new.organisation.name, null, 'later accounts start empty');
  assert.deepEqual(root.workspaces.user_new.products, {});
  assert.equal(fs.readdirSync(dir).filter((f) => f.startsWith('data.v1-backup-')).length, 1);

  // Saved straight away: loading again doesn't migrate (or back up) twice.
  await storage.loadRoot();
  assert.equal(fs.readdirSync(dir).filter((f) => f.startsWith('data.v1-backup-')).length, 1);
});

test('drops organisation fields that are no longer collected', async () => {
  const root = await storage.loadRoot();
  const id = Object.keys(root.workspaces)[0];
  root.workspaces[id].organisation.budget = { amount: 500, currency: 'GBP', period: 'month' };
  root.workspaces[id].organisation.vehicles = 2;
  root.workspaces[id].organisation.deliverySlotsPerWeek = 3;
  fs.writeFileSync(storage.DATA_FILE, JSON.stringify(root));
  const org = (await storage.loadRoot()).workspaces[id].organisation;
  assert.equal('budget' in org || 'vehicles' in org || 'deliverySlotsPerWeek' in org, false);
});

test('backs up an unreadable file instead of discarding it', async () => {
  fs.writeFileSync(storage.DATA_FILE, '{ not json');
  const root = await storage.loadRoot();
  assert.ok(root.metadata.recoveredFrom);
  const backups = fs.readdirSync(dir).filter((f) => f.startsWith('data.corrupt-'));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, backups[0]), 'utf8'), '{ not json');
});
