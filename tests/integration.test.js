const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'supplyshield-app-'));
process.env.SUPPLYSHIELD_DATA_FILE = path.join(dir, 'data.json');
process.env.SESSION_SECRET = 'test-secret';
process.env.NEBIUS_API_KEY = ''; // deterministic rules path; no tokens used
process.env.TAVILY_API_KEY = '';
process.env.SUPPLYSHIELD_OFFLINE = '1';
const { app, checkEngine } = require('../app');

let server;
let base;
let cookie = '';

const readData = () => JSON.parse(fs.readFileSync(process.env.SUPPLYSHIELD_DATA_FILE, 'utf8'));

async function request(urlPath, { method = 'GET', form, json, body } = {}) {
  const res = await fetch(base + urlPath, {
    method,
    redirect: 'manual',
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
      ...(json ? { 'content-type': 'application/json' } : {}),
    },
    body: form ? new URLSearchParams(form).toString() : json ? JSON.stringify(json) : body,
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  return res;
}

before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('sends visitors to sign up when no accounts exist', async () => {
  const res = await request('/');
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/signup');
});

test('rejects an invalid sign-up with field errors', async () => {
  const res = await request('/signup', { method: 'POST', form: { name: '', email: 'bad', password: 'short', orgName: '', postcode: 'nope', planningHorizonDays: '7' } });
  assert.equal(res.status, 422);
  const html = await res.text();
  assert.match(html, /valid UK postcode/);
});

test('signs up, creates the organisation and opens the overview', async () => {
  const res = await request('/signup', {
    method: 'POST',
    form: {
      name: 'Sam Manager',
      email: 'sam@example.org',
      password: 'correct horse',
      orgName: 'Riverside Food Bank',
      postcode: 'SW7 2AZ',
      planningHorizonDays: '14',
      'storage[0][label]': 'Warehouse',
      'storage[0][type]': 'ambient',
      'storage[0][count]': '1',
      'storage[0][capacity]': '40',
      'storage[0][unit]': 'pallets',
    },
  });
  assert.equal(res.status, 302);
  const home = await request('/');
  assert.equal(home.status, 200);
  assert.match(await home.text(), /Riverside Food Bank/);

  const data = JSON.parse(fs.readFileSync(process.env.SUPPLYSHIELD_DATA_FILE, 'utf8'));
  const [user] = Object.values(data.users);
  assert.equal(user.email, 'sam@example.org');
  assert.notEqual(user.passwordHash, 'correct horse');
  assert.equal(data.organisation.planningHorizonDays, 14);
  assert.equal(data.organisation.storage.storage_01.capacityUnit, 'pallets');
});

test('locks later steps until earlier ones are approved', async () => {
  const res = await request('/parameters');
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/upload');
  assert.equal((await request('/upload')).status, 200);
});

test('Step 1: stages the sample file for review', async () => {
  const res = await request('/upload/sample', { method: 'POST' });
  assert.equal(res.headers.get('location'), '/review');
  const html = await (await request('/review')).text();
  assert.match(html, /Baked Beans 415g/);
  assert.match(html, /header matching and keyword rules/);
  assert.equal(Object.keys(readData().historicalStock).length, 0, 'nothing is approved yet');
});

test('Step 1: editing a row revalidates it', async () => {
  const [id] = Object.entries(readData().staging.records).find(([, r]) => r.status === 'excluded');
  const res = await request('/review/record', { method: 'POST', json: { id, changes: { quantity: '57' } } });
  assert.equal(res.status, 200);
  const { record, counts } = await res.json();
  assert.equal(record.quantity, 57);
  assert.notEqual(record.status, 'excluded');
  assert.equal(counts.excluded, 1);

  const bad = await request('/review/record', { method: 'POST', json: { id, changes: { date: 'yesterday' } } });
  assert.equal(bad.status, 400);
});

test('Step 1: approval creates the dataset and unlocks parameters', async () => {
  const versionBefore = readData().audit.inputVersion;
  const res = await request('/review/approve', { method: 'POST' });
  assert.equal(res.headers.get('location'), '/parameters');

  const data = readData();
  assert.equal(Object.keys(data.products).length, 15);
  assert.equal(Object.keys(data.historicalStock).length, 779); // 778 + the row fixed above
  assert.ok(Object.keys(data.inventory).length > 0);
  assert.equal(data.audit.inputVersion, versionBefore + 1);
  const dataset = data.audit.datasets[`dataset_v${data.audit.inputVersion}`];
  assert.equal(dataset.rowsExcluded, 1);
  assert.equal(dataset.method, 'rules');
  assert.deepEqual(data.staging.records, {});
  assert.equal((await request('/parameters')).status, 200);
});

test('Step 1: uploads an Excel file', async () => {
  const file = fs.readFileSync(path.join(__dirname, '..', 'data', 'sample', 'sample_stock_history.xlsx'));
  const body = new FormData();
  body.append('file', new Blob([file]), 'stock.xlsx');
  const res = await request('/upload', { method: 'POST', body });
  assert.equal(res.headers.get('location'), '/review');
  assert.equal(Object.keys(readData().staging.records).length, 786);
  await request('/review/discard', { method: 'POST' });
  assert.deepEqual(readData().staging.records, {});
});

test('Step 1: rejects unsupported files', async () => {
  const body = new FormData();
  body.append('file', new Blob(['hello']), 'notes.txt');
  const res = await request('/upload', { method: 'POST', body });
  assert.equal(res.status, 422);
});

// Build the parameters form from the stored draft, as the page would post it.
function parameterForm(data, overrides = {}) {
  const g = data.parameters.global;
  const form = {
    'global[planningHorizonDays]': g.planningHorizonDays,
    'global[reviewPeriodDays]': g.reviewPeriodDays,
    'global[leadTimeDays]': g.leadTimeDays,
    'global[deliverySuccessPercent]': Math.round(g.deliverySuccessProbability * 100),
    'global[reserveDays]': g.reserveDays,
    'global[qLean]': g.quantiles.lean,
    'global[qBalanced]': g.quantiles.balanced,
    'global[qCritical]': g.quantiles.resilient.critical,
    'global[qEssential]': g.quantiles.resilient.essential,
    'global[qStandard]': g.quantiles.resilient.standard,
  };
  const r1 = (x) => (x === null ? '' : String(Math.round(x * 10) / 10));
  for (const [id, p] of Object.entries(data.parameters.products)) {
    form[`p[${id}][priority]`] = data.products[id].priority;
    form[`p[${id}][currentStock]`] = p.currentStock;
    form[`p[${id}][weeklyDemand]`] = p.dailyDemand === null ? '' : r1(7 * p.dailyDemand);
    form[`p[${id}][weeklySd]`] = p.dailyVariance === null ? '' : r1(Math.sqrt(7 * Math.max(p.dailyVariance, p.dailyDemand)));
    form[`p[${id}][seasonalMultiplier]`] = Math.round(p.seasonalMultiplier * 1000) / 1000;
    form[`p[${id}][leadTimeDays]`] = p.leadTimeDays;
    form[`p[${id}][shelfLifeDays]`] = p.shelfLifeDays ?? '';
    form[`p[${id}][unitCost]`] = p.unitCost ?? '';
  }
  return { ...form, ...overrides };
}

test('Step 2: analyses the approved data and drafts parameters', async () => {
  const res = await request('/parameters');
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Planning parameters/);
  assert.match(html, /inferred consumption/);

  const data = readData();
  assert.equal(Object.keys(data.analysis.products).length, 15);
  assert.equal(data.parameters.approved, false);
  const pasta = data.parameters.products.pasta_500g;
  assert.equal(pasta.sources.dailyDemand, 'inferred');
  assert.ok(pasta.dailyDemand > 10 && pasta.dailyDemand < 20, `pasta daily demand ${pasta.dailyDemand}`);
  assert.equal(pasta.currentStock, 303);
});

test('Step 2: a changed value is labelled as the manager\'s own', async () => {
  const form = parameterForm(readData(), { 'p[pasta_500g][weeklyDemand]': '120', action: 'save' });
  const res = await request('/parameters', { method: 'POST', form });
  assert.equal(res.headers.get('location'), '/parameters');
  const p = readData().parameters.products;
  assert.equal(p.pasta_500g.sources.dailyDemand, 'manual');
  assert.ok(Math.abs(p.pasta_500g.dailyDemand - 120 / 7) < 1e-9);
  assert.equal(p.rice_1kg.sources.dailyDemand, 'inferred', 'untouched values keep their source');
});

test('Step 2: approval needs every demand and bumps the input version', async () => {
  const blank = parameterForm(readData(), { 'p[rice_1kg][weeklyDemand]': '', action: 'approve' });
  assert.equal((await request('/parameters', { method: 'POST', form: blank })).status, 422);

  const before = readData().audit.inputVersion;
  const res = await request('/parameters', { method: 'POST', form: parameterForm(readData(), { action: 'approve' }) });
  assert.equal(res.headers.get('location'), '/scenario');
  const data = readData();
  assert.equal(data.parameters.approved, true);
  assert.equal(data.audit.inputVersion, before + 1);
  assert.equal(data.parameters.approvedVersion, data.audit.inputVersion);
  assert.equal(data.scenario.reserveDays, data.parameters.global.reserveDays);
});

test('Step 3: ignores adjustments that belong to another preset unless combined', async () => {
  assert.equal((await request('/scenario')).status, 200);
  await request('/scenario', { method: 'POST', form: { scenarioId: 'normal_operations', demandIncreasePct: '50', delayDays: '9' } });
  const s = readData().scenario;
  assert.equal(s.type, 'normal');
  assert.equal(s.demandMultiplier, 1);
  assert.equal(s.additionalDeliveryDelayDays, 0);
});

test('Step 3-4: a disruption scenario runs the simulation for all three policies', async () => {
  const res = await request('/scenario', {
    method: 'POST',
    form: { scenarioId: 'delivery_disruption', delayDays: '7', reduceQuantities: 'on', quantityReductionPct: '20', 'combine[demand]': 'on', demandIncreasePct: '10' },
  });
  assert.equal(res.headers.get('location'), '/compare');
  const data = readData();
  const sim = data.simulation;
  assert.deepEqual(Object.keys(sim.policies), ['lean', 'balanced', 'resilient']);
  assert.equal(sim.config.scenarioId, 'delivery_disruption');
  assert.equal(sim.config.additionalDeliveryDelayDays, 7);
  assert.equal(sim.config.deliveryQuantityReduction, 0.2);
  assert.equal(sim.config.demandIncrease, 0.1);
  assert.equal(sim.config.numberOfRuns, 1000);
  assert.equal(data.audit.calculationVersion, sim.calculationVersion);
  assert.ok(sim.checks.inventoryNonNegative && sim.checks.inventoryBalances);
  const html = await (await request('/compare')).text();
  assert.match(html, /Compare policies/);
  assert.match(html, /Choose Resilient/);
  assert.doesNotMatch(html, /recommended policy|best policy/i);
});

test('Step 4: choosing a policy stores numbers, then a checked explanation', async () => {
  const res = await request('/compare/select', { method: 'POST', form: { policy: 'balanced' } });
  assert.equal(res.headers.get('location'), '/plan');
  const rec = readData().recommendations;
  assert.equal(rec.selectedPolicy, 'balanced');
  assert.equal(rec.order.length, 15);
  assert.equal(rec.explanations.actionPlan.source, 'template');
  const sim = readData().simulation;
  for (const [id, r] of Object.entries(rec.products)) {
    assert.equal(r.replenish, sim.policies.balanced.products[id].initialOrder, 'recommendation equals the simulated day-0 order');
  }
  const html = await (await request('/plan')).text();
  assert.match(html, /Why this recommendation\?/);
  assert.match(html, /Confirm &amp; finalise plan/);
});

test('Step 5: finalising freezes an audit record that can be downloaded', async () => {
  const res = await request('/plan/finalise', { method: 'POST' });
  assert.equal(res.headers.get('location'), '/plan');
  const data = readData();
  assert.equal(data.recommendations.finalised, true);
  const record = data.audit.records[data.recommendations.recordId];
  assert.equal(record.status, 'finalised');
  assert.equal(record.selectedPolicy, 'balanced');
  assert.equal(record.calculation.seed, 42);
  assert.equal(record.calculation.runs, 1000);
  assert.ok(record.explanations.finalPlan.sections.request.length);
  assert.equal(record.explanations.finalPlan.calculationVersion, record.calculation.calculationVersion);
  assert.ok(record.policies.lean && record.policies.resilient, 'all three policies are kept');

  const html = await (await request('/plan')).text();
  assert.match(html, /This plan is finalised/);
  const dl = await request(`/plan/download?id=${record.id}`);
  assert.equal(JSON.parse(await dl.text()).id, record.id);
  assert.equal((await request(`/plan/print?id=${record.id}`)).status, 200);
  const overview = await (await request('/')).text();
  assert.match(overview, /Finalised plans/);
  assert.match(overview, new RegExp(record.id));

  // A finalised plan can't be changed by selecting another policy.
  await request('/compare/select', { method: 'POST', form: { policy: 'lean' } });
  assert.equal(readData().audit.records[record.id].selectedPolicy, 'balanced');
  assert.equal(readData().recommendations.selectedPolicy, 'balanced');
});

test('signs out and requires sign-in again', async () => {
  await request('/logout', { method: 'POST' });
  const res = await request('/');
  assert.equal(res.status, 302);
  assert.match(res.headers.get('location'), /^\/login/);
});

test('rejects a wrong password', async () => {
  const res = await request('/login', { method: 'POST', form: { email: 'sam@example.org', password: 'wrong password' } });
  assert.equal(res.status, 401);
});

test('reaches the Python engine through the bridge', async () => {
  await checkEngine();
  assert.equal(app.locals.engine.status, 'ok', app.locals.engine.detail);
});
