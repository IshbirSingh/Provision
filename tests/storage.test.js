const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'supplyshield-storage-'));
process.env.SUPPLYSHIELD_DATA_FILE = path.join(dir, 'data.json');
const storage = require('../services/storageService');

before(() => fs.rmSync(storage.DATA_FILE, { force: true }));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('initialises data.json with the default structure when missing', async () => {
  const data = await storage.loadData();
  assert.ok(fs.existsSync(storage.DATA_FILE));
  assert.equal(data.metadata.schemaVersion, storage.SCHEMA_VERSION);
  assert.deepEqual(storage.validateStructure(data), []);
});

test('serialises concurrent writes so none are lost', async () => {
  await Promise.all(
    Array.from({ length: 25 }, (_, i) => storage.updateNestedValue(['analysis', 'patterns', `p${i}`], i)),
  );
  const data = await storage.loadData();
  assert.equal(Object.keys(data.analysis.patterns).length, 25);
});

test('rejects invalid writes and leaves the file unchanged', async () => {
  const before = fs.readFileSync(storage.DATA_FILE, 'utf8');
  await assert.rejects(storage.updateSection('products', []), storage.StorageValidationError);
  await assert.rejects(
    storage.mutate((d) => { d.historicalStock.r1 = { productId: 'missing', date: '2026-01-01', quantity: 1 }; }),
    /unknown product/,
  );
  assert.equal(fs.readFileSync(storage.DATA_FILE, 'utf8'), before);
});

test('refuses prototype-polluting paths', () => {
  assert.throws(() => storage.updateNestedValue('__proto__.polluted', true), /Invalid path/);
});

test('fills sections missing from an older file without overwriting values', async () => {
  const data = JSON.parse(fs.readFileSync(storage.DATA_FILE, 'utf8'));
  delete data.staging;
  data.organisation.name = 'Kept Food Bank';
  fs.writeFileSync(storage.DATA_FILE, JSON.stringify(data));
  const loaded = await storage.loadData();
  assert.ok(loaded.staging);
  assert.equal(loaded.organisation.name, 'Kept Food Bank');
});

test('historical changes invalidate downstream results but keep audit records', async () => {
  await storage.mutate((d) => {
    d.parameters = { products: { a: {} }, global: {}, approved: true };
    d.simulation.policies = { lean: {} };
    d.recommendations.selectedPolicy = 'lean';
    d.audit.records.rec_1 = { id: 'rec_1' };
  });
  const startVersion = (await storage.loadData()).audit.inputVersion;
  await storage.invalidate('historical');
  const data = await storage.loadData();
  assert.equal(data.parameters.approved, false);
  assert.deepEqual(data.simulation.policies, {});
  assert.equal(data.recommendations.selectedPolicy, null);
  assert.equal(data.audit.inputVersion, startVersion + 1);
  assert.ok(data.audit.records.rec_1);
});

test('scenario changes clear simulations without bumping the input version', async () => {
  await storage.mutate((d) => { d.simulation.policies = { lean: {} }; });
  const startVersion = (await storage.loadData()).audit.inputVersion;
  await storage.invalidate('scenario');
  const data = await storage.loadData();
  assert.deepEqual(data.simulation.policies, {});
  assert.equal(data.audit.inputVersion, startVersion);
});

test('reset keeps accounts and the organisation profile', async () => {
  await storage.mutate((d) => {
    d.users.user_1 = { email: 'a@b.co', name: 'A', passwordHash: 'x' };
    d.organisation.name = 'Keep Me';
    d.analysis.patterns.junk = 1;
  });
  await storage.resetDemoData();
  const data = await storage.loadData();
  assert.ok(data.users.user_1);
  assert.equal(data.organisation.name, 'Keep Me');
  assert.equal(data.analysis.patterns.junk, undefined);
});

test('backs up an unreadable file instead of discarding it', async () => {
  fs.writeFileSync(storage.DATA_FILE, '{ not json');
  const data = await storage.loadData();
  assert.ok(data.audit.warnings.storage_recovered);
  const backups = fs.readdirSync(dir).filter((f) => f.startsWith('data.corrupt-'));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, backups[0]), 'utf8'), '{ not json');
});
