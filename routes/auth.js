// Accounts: sign up, log in, log out and the organisation profile.
// One shared workspace: the first account creates the organisation, later
// accounts join it. Passwords are stored only as bcrypt hashes.

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

function findUserByEmail(data, email) {
  return Object.entries(data.users).find(([, u]) => u.email === email);
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

  const budget = numberOrNull(body.budgetAmount);
  const vehicles = numberOrNull(body.vehicles, { integer: true });
  const slots = numberOrNull(body.deliverySlotsPerWeek, { integer: true });
  if (Number.isNaN(budget)) errors.push('Budget must be a positive number.');
  if (Number.isNaN(vehicles)) errors.push('Vehicles must be a whole number.');
  if (Number.isNaN(slots)) errors.push('Delivery slots must be a whole number.');

  return {
    errors,
    organisation: {
      name,
      postcode,
      planningHorizonDays: horizon,
      storage: storageAreas,
      storageNotes: String(body.storageNotes || '').trim() || null,
      budget: {
        amount: Number.isNaN(budget) ? null : budget,
        currency: 'GBP',
        period: budget === null ? null : ['week', 'month', 'year'].includes(body.budgetPeriod) ? body.budgetPeriod : 'month',
      },
      vehicles: Number.isNaN(vehicles) ? null : vehicles,
      deliverySlotsPerWeek: Number.isNaN(slots) ? null : slots,
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

router.get('/signup', async (req, res) => {
  const data = await storage.loadData();
  res.render('signup', { ...formLocals, title: 'Create account', errors: [], form: {}, orgExists: Boolean(data.organisation.name) });
});

router.post('/signup', async (req, res) => {
  const email = normEmail(req.body.email);
  const name = String(req.body.name || '').trim();
  const password = String(req.body.password || '');

  const errors = [];
  if (!name) errors.push('Enter your name.');
  if (!EMAIL_RE.test(email)) errors.push('Enter a valid email address.');
  if (password.length < 8) errors.push('Password must be at least 8 characters.');

  const current = await storage.loadData();
  const orgExists = Boolean(current.organisation.name);
  const org = orgExists ? null : parseOrganisation(req.body);
  if (org) errors.push(...org.errors);
  if (findUserByEmail(current, email)) errors.push('An account with this email already exists.');

  if (errors.length) {
    return res.status(422).render('signup', { ...formLocals, title: 'Create account', errors, form: req.body, orgExists });
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const userId = `user_${crypto.randomBytes(6).toString('hex')}`;
  await storage.mutate((data) => {
    if (findUserByEmail(data, email)) throw new Error('An account with this email already exists.');
    data.users[userId] = { email, name, passwordHash, createdAt: new Date().toISOString() };
    if (org && !data.organisation.name) {
      Object.assign(data.organisation, org.organisation, { createdAt: new Date().toISOString() });
    }
  });

  await establishSession(req, userId);
  res.redirect('/');
});

router.get('/login', (req, res) => {
  res.render('login', { title: 'Sign in', error: null, email: '', next: safeNext(req.query.next) });
});

router.post('/login', async (req, res) => {
  const email = normEmail(req.body.email);
  const data = await storage.loadData();
  const match = findUserByEmail(data, email);
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

  await storage.mutate((data) => {
    const before = data.organisation;
    // Horizon and capacities are planning assumptions (spec 13.5).
    const planningChanged = before.planningHorizonDays !== organisation.planningHorizonDays
      || JSON.stringify(before.storage) !== JSON.stringify(organisation.storage)
      || JSON.stringify(before.budget) !== JSON.stringify(organisation.budget);
    data.organisation = { ...before, ...organisation };
    if (planningChanged) storage.applyInvalidation(data, 'context');
  });

  req.session.flash = { type: 'success', message: 'Organisation details saved.' };
  res.redirect('/account');
});

module.exports = { router, requireAuth };
