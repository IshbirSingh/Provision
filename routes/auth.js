// Accounts: sign up, log in, log out and the organisation profile.
// Every account is separate: signing up creates the account, its own
// organisation and an empty workspace. Passwords are stored only as bcrypt
// hashes.

const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const storage = require('../services/storageService');

const router = express.Router();

const STORAGE_TYPES = ['ambient', 'chilled', 'frozen'];
const CAPACITY_UNITS = ['kg', 'litres', 'm3', 'pallets', 'shelves', 'crates', 'units'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UK_POSTCODE_RE = /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i;

const normEmail = (e) => String(e || '').trim().toLowerCase();

function numberOrNull(value, { integer = false, min = 0 } = {}) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < min) return NaN;
  return integer ? Math.round(n) : n;
}

function findUserByEmail(root, email) {
  return Object.entries(root.users).find(([, u]) => u.email === email);
}

// Parse the organisation form. Storage rows are optional and flexible: a row
// can be "2 fridges, 300 litres each" or "1 warehouse, 40 pallets".
function parseOrganisation(body) {
  const errors = [];
  const name = String(body.orgName || '').trim();
  const postcode = String(body.postcode || '').trim().toUpperCase();
  const horizon = numberOrNull(body.planningHorizonDays, { integer: true, min: 1 });

  if (!name) errors.push('Enter the food bank name.');
  if (!UK_POSTCODE_RE.test(postcode)) errors.push('Enter a valid UK postcode.');
  if (horizon === null || Number.isNaN(horizon) || horizon > 90) errors.push('Planning horizon must be between 1 and 90 days.');

  const storageAreas = {};
  const rows = Array.isArray(body.storage) ? body.storage : Object.values(body.storage || {});
  rows.forEach((row, i) => {
    const label = String(row.label || '').trim();
    const capacity = numberOrNull(row.capacity);
    const count = numberOrNull(row.count, { integer: true, min: 1 });
    if (!label && capacity === null) return; // blank row
    if (!label) errors.push(`Storage row ${i + 1}: add a name.`);
    if (!STORAGE_TYPES.includes(row.type)) errors.push(`Storage row ${i + 1}: choose ambient, chilled or frozen.`);
    if (Number.isNaN(capacity)) errors.push(`Storage row ${i + 1}: capacity must be a positive number.`);
    if (Number.isNaN(count)) errors.push(`Storage row ${i + 1}: count must be a whole number.`);
    if (capacity !== null && !CAPACITY_UNITS.includes(row.unit)) errors.push(`Storage row ${i + 1}: choose a unit.`);
    storageAreas[`storage_${String(i + 1).padStart(2, '0')}`] = {
      label,
      type: row.type,
      count: count ?? 1,
      capacityEach: capacity,
      capacityUnit: capacity === null ? null : row.unit,
    };
  });

  return {
    errors,
    organisation: {
      name,
      postcode,
      planningHorizonDays: horizon,
      storage: storageAreas,
      storageNotes: String(body.storageNotes || '').trim() || null,
    },
  };
}

function establishSession(req, userId) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => {
      if (err) return reject(err);
      req.session.userId = userId;
      resolve();
    });
  });
}

function requireAuth(req, res, next) {
  if (res.locals.user) return next();
  return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
}

const safeNext = (n) => (typeof n === 'string' && n.startsWith('/') && !n.startsWith('//') ? n : '/');

const formLocals = { storageTypes: STORAGE_TYPES, capacityUnits: CAPACITY_UNITS };

router.get('/signup', (req, res) => {
  res.render('signup', { ...formLocals, title: 'Create account', errors: [], form: {} });
});

router.post('/signup', async (req, res) => {
  const email = normEmail(req.body.email);
  const name = String(req.body.name || '').trim();
  const password = String(req.body.password || '');

  const errors = [];
  if (!name) errors.push('Enter your name.');
  if (!EMAIL_RE.test(email)) errors.push('Enter a valid email address.');
  if (password.length < 8) errors.push('Password must be at least 8 characters.');

  const org = parseOrganisation(req.body);
  errors.push(...org.errors);
  if (findUserByEmail(await storage.loadRoot(), email)) errors.push('An account with this email already exists.');

  const reject = (list) => res.status(422).render('signup', { ...formLocals, title: 'Create account', errors: list, form: req.body });
  if (errors.length) return reject(errors);

  const passwordHash = await bcrypt.hash(password, 12);
  const userId = `user_${crypto.randomBytes(6).toString('hex')}`;
  try {
    await storage.createAccount(userId, { email, name, passwordHash, createdAt: new Date().toISOString() }, org.organisation);
  } catch (err) {
    if (err.code === 'EMAIL_TAKEN') return reject([err.message]);
    throw err;
  }

  await establishSession(req, userId);
  res.redirect('/');
});

router.get('/login', (req, res) => {
  res.render('login', { title: 'Sign in', error: null, email: '', next: safeNext(req.query.next) });
});

router.post('/login', async (req, res) => {
  const email = normEmail(req.body.email);
  const match = findUserByEmail(await storage.loadRoot(), email);
  const ok = match && (await bcrypt.compare(String(req.body.password || ''), match[1].passwordHash));
  if (!ok) {
    return res.status(401).render('login', { title: 'Sign in', error: 'Email or password is incorrect.', email, next: safeNext(req.body.next) });
  }
  await establishSession(req, match[0]);
  res.redirect(safeNext(req.body.next));
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

router.get('/account', requireAuth, (req, res) => {
  res.render('account', { ...formLocals, title: 'Organisation', errors: [], form: null });
});

router.post('/account', requireAuth, async (req, res) => {
  const { errors, organisation } = parseOrganisation(req.body);
  if (errors.length) {
    return res.status(422).render('account', { ...formLocals, title: 'Organisation', errors, form: req.body });
  }

  await req.store.mutate((data) => {
    const before = data.organisation;
    // Horizon and capacities are planning assumptions (spec 13.5).
    const planningChanged = before.planningHorizonDays !== organisation.planningHorizonDays
      || JSON.stringify(before.storage) !== JSON.stringify(organisation.storage);
    data.organisation = { ...before, ...organisation };
    if (planningChanged) storage.applyInvalidation(data, 'context');
  });

  req.session.flash = { type: 'success', message: 'Organisation details saved.' };
  res.redirect('/account');
});

module.exports = { router, requireAuth };
