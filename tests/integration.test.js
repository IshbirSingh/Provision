const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'supplyshield-app-'));
process.env.SUPPLYSHIELD_DATA_FILE = path.join(dir, 'data.json');
process.env.SESSION_SECRET = 'test-secret';
const { app, checkEngine } = require('../app');

let server;
let base;
let cookie = '';

async function request(urlPath, { method = 'GET', form } = {}) {
  const res = await fetch(base + urlPath, {
    method,
    redirect: 'manual',
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
    },
    body: form ? new URLSearchParams(form).toString() : undefined,
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
