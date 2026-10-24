// Step 2: historical analysis, external context and parameter approval.
//
// Order of work: local context (incl. past and forecast temperatures) ->
// product sizes -> Python analysis -> Python storage capacity. Results are
// cached against the approved dataset, the date, the horizon and the
// context they used. Parameters start from the analysis; a value a manager
// changes is labelled as their own.

const express = require('express');
const storage = require('../services/storageService');
const context = require('../services/contextService');
const sizeService = require('../services/sizeService');
const catalog = require('../services/catalog');
const { runPython } = require('../services/pythonBridge');
const { requireStep } = require('../services/workflowService');

const router = express.Router();

// Fixed settings. Stock counts can't show delivery reliability, so every
// delivery is assumed to arrive (the Delivery disruption scenario tests
// otherwise). Policy protection levels are fixed per policy and can be
// fine-tuned on the plan page.
const DEFAULT_GLOBAL = {
  reviewPeriodDays: 7,
  leadTimeDays: 7,
  deliverySuccessProbability: 1.0,
  reserveDays: 7,
  runs: 10000,
  seed: 42,
};
const SHELF_LIFE_DAYS = {
  staple_carbohydrates: 365,
  tinned_vegetables: 730,
  tinned_protein: 730,
  fresh_produce: 10,
  baby_food_infant_formula: 180,
  hygiene_products: null,
  allergy_safe_dietary: 120,
  other: null,
};
const EDITABLE = ['dailyDemand', 'dailyVariance', 'currentStock', 'leadTimeDays', 'shelfLifeDays'];
const SOURCE_OF_DEFAULT = {
  dailyDemand: 'inferred',
  dailyVariance: 'inferred',
  seasonalMultiplier: 'inferred',
  currentStock: 'approved_data',
  leadTimeDays: 'assumption',
  shelfLifeDays: 'assumption',
};

const todayIso = () => new Date().toISOString().slice(0, 10);
const datasetVersion = (data) => Math.max(0, ...Object.values(data.audit.datasets || {}).map((d) => d.version));
const round = (x, n = 2) => (x === null || x === undefined ? null : Math.round(x * 10 ** n) / 10 ** n);
const historyFrom = (data) => Object.values(data.historicalStock).map((r) => r.date).sort()[0] || null;

function horizonOf(data) {
  return data.parameters.global?.planningHorizonDays || data.organisation.planningHorizonDays || 28;
}

function analysisIsCurrent(data, horizon) {
  const m = data.analysis.meta;
  return m && m.datasetVersion === datasetVersion(data) && m.asOf === todayIso() && m.horizonDays === horizon
    && m.contextFetchedAt === (data.externalContext?.other?.fetchedAt ?? null);
}

async function runAnalysis(data, ctx, horizon) {
  const temps = ctx?.weather?.temperatures;
  const result = await runPython('analyse', {
    asOf: todayIso(),
    horizonDays: horizon,
    holidays: context.ENGLAND_SCHOOL_HOLIDAYS,
    weather: temps?.status === 'ok' ? { history: temps.history, horizon: temps.horizon, source: temps.source } : null,
    products: data.products,
    records: Object.values(data.historicalStock),
    batches: Object.values(data.inventory),
  });
  return {
    products: result.products,
    patterns: { methods: result.methods, assumptions: result.assumptions },
    warnings: {},
    meta: {
      datasetVersion: datasetVersion(data),
      asOf: result.asOf,
      horizonDays: horizon,
      contextFetchedAt: ctx?.other?.fetchedAt ?? null,
      ranAt: new Date().toISOString(),
    },
  };
}

function inferredDefaults(product, a, global) {
  const dm = a?.demand || {};
  return {
    dailyDemand: dm.available ? dm.dailyMean : null,
    dailyVariance: dm.available ? dm.dailyVariance ?? dm.dailyMean : null,
    seasonalMultiplier: a?.adjustment?.multiplier ?? 1,
    currentStock: a?.stock?.current ?? 0,
    leadTimeDays: global.leadTimeDays,
    shelfLifeDays: SHELF_LIFE_DAYS[product.category] ?? null,
  };
}

function buildDraft(data, horizon) {
  const global = { ...DEFAULT_GLOBAL, planningHorizonDays: horizon, productCapacity: {} };
  const products = {};
  for (const [id, p] of Object.entries(data.products)) {
    products[id] = { ...inferredDefaults(p, data.analysis.products[id], global), sources: { ...SOURCE_OF_DEFAULT } };
  }
  return { products, global, approved: false, basedOnDataset: datasetVersion(data), approvedAt: null, approvedBy: null, approvedVersion: null };
}

// After the analysis changes, refresh values that still come from it. The
// holiday and weather adjustment always comes from the analysis.
function refreshInferred(params, data) {
  for (const [id, p] of Object.entries(params.products)) {
    const defaults = inferredDefaults(data.products[id], data.analysis.products[id], params.global);
    p.seasonalMultiplier = defaults.seasonalMultiplier;
    for (const key of ['dailyDemand', 'dailyVariance', 'currentStock']) {
      if (p.sources?.[key] === SOURCE_OF_DEFAULT[key]) p[key] = defaults[key];
    }
  }
}

async function computeCapacity(data, sizes) {
  const products = {};
  for (const [id, p] of Object.entries(data.parameters.products)) {
    const s = sizes.sizes[id];
    if (!s) continue;
    products[id] = {
      storageType: s.storageType,
      unitVolumeL: s.unitVolumeL,
      unitWeightKg: s.unitWeightKg,
      dailyDemand: (p.dailyDemand || 0) * (p.seasonalMultiplier || 1),
      currentStock: p.currentStock || 0,
    };
  }
  return runPython('capacity', { storageAreas: Object.values(data.organisation.storage || {}), products });
}

function applyCapacity(params, capacity) {
  params.capacity = capacity;
  params.global.productCapacity = Object.fromEntries(Object.entries(capacity.products).map(([id, c]) => [id, c.capacity]));
  delete params.global.categoryCapacity;
}

// Bring context, sizes, analysis, capacity and the draft up to date.
// Returns the fresh data. Context failures never block the page.
async function ensureCurrent(store, data, { forceContext = false } = {}) {
  const horizon = horizonOf(data);
  // Approved parameters stay as approved until the data or horizon changes,
  // or the manager refreshes the context.
  const m = data.analysis.meta;
  if (!forceContext && data.parameters.approved && data.parameters.capacity
      && m?.datasetVersion === datasetVersion(data) && m?.horizonDays === horizon) {
    return data;
  }
  const from = historyFrom(data);
  const needContext = forceContext || !context.isFresh(data.externalContext, data.organisation, horizon, from);
  const ctx = needContext ? await context.gatherContext(data.organisation, { asOf: todayIso(), horizonDays: horizon, historyFrom: from }) : data.externalContext;
  const withCtx = { ...data, externalContext: ctx };

  const needAnalysis = !analysisIsCurrent(withCtx, horizon);
  const needDraft = !Object.keys(data.parameters.products).length || data.parameters.basedOnDataset !== datasetVersion(data);
  const [analysis, sizes] = await Promise.all([
    needAnalysis ? runAnalysis(data, ctx, horizon) : null,
    sizeService.inferSizes(data.products, data.parameters.sizes),
  ]);
  const needSizes = sizes.key !== data.parameters.sizes?.key;
  const needCapacity = needAnalysis || needDraft || needSizes || needContext || !data.parameters.capacity;
  if (!needContext && !needAnalysis && !needDraft && !needCapacity) return data;

  // Assemble the next parameters, then compute capacity from them.
  const next = structuredClone(withCtx);
  if (analysis) next.analysis = analysis;
  if (needDraft) next.parameters = buildDraft(next, horizon);
  else if (analysis) refreshInferred(next.parameters, next);
  next.parameters.sizes = sizes;
  const capacity = await computeCapacity(next, sizes);

  return store.mutate((d) => {
    d.externalContext = ctx;
    if (analysis) d.analysis = analysis;
    // Approval stays only if nothing the approval depended on changed.
    const keepApproval = d.parameters.approved && !needDraft && !analysis;
    d.parameters = next.parameters;
    applyCapacity(d.parameters, capacity);
    if (!keepApproval && d.parameters.approved) d.parameters.approved = false;
  });
}

// The weekly figures shown on the form. Variability is the model's weekly
// standard deviation: never below Poisson (variance = mean).
function displayValues(p) {
  const has = (x) => x !== null && x !== undefined;
  return {
    weeklyDemand: has(p.dailyDemand) ? round(7 * p.dailyDemand, 1) : null,
    weeklySd: has(p.dailyVariance) ? round(Math.sqrt(7 * Math.max(p.dailyVariance, p.dailyDemand || 0)), 1) : null,
  };
}

function viewRows(data) {
  const params = data.parameters;
  return Object.entries(data.products)
    .map(([id, product]) => {
      const p = params.products[id] || {};
      const shown = displayValues(p);
      return {
        id,
        product,
        params: p,
        analysis: data.analysis.products[id] || {},
        size: params.sizes?.sizes?.[id] || null,
        capacity: params.capacity?.products?.[id] || null,
        weeklyDemand: shown.weeklyDemand,
        weeklySd: shown.weeklySd,
        adjustedWeekly: p.dailyDemand ? round(7 * p.dailyDemand * (p.seasonalMultiplier || 1), 1) : null,
        daysOfCover: p.dailyDemand ? round(p.currentStock / (p.dailyDemand * (p.seasonalMultiplier || 1)), 1) : null,
      };
    })
    .sort((x, y) => catalog.PRIORITIES[x.product.priority].rank - catalog.PRIORITIES[y.product.priority].rank
      || (x.daysOfCover ?? Infinity) - (y.daysOfCover ?? Infinity));
}

function renderPage(res, data, { errors = [], status = 200 } = {}) {
  res.status(status).render('parameters', {
    title: 'Planning parameters',
    analysis: data.analysis,
    ctx: data.externalContext,
    params: data.parameters,
    rows: viewRows(data),
    organisation: data.organisation,
    priorities: catalog.PRIORITIES,
    categories: catalog.CATEGORIES,
    errors,
    scripts: ['/vendor/plotly.min.js', '/js/charts.js'],
  });
}

router.get('/parameters', requireStep('parameters'), async (req, res) => {
  renderPage(res, await ensureCurrent(req.store, res.locals.data));
});

router.post('/parameters/context', requireStep('parameters'), async (req, res) => {
  await ensureCurrent(req.store, res.locals.data, { forceContext: true });
  req.session.flash = { type: 'success', message: 'Local context refreshed.' };
  res.redirect('/parameters#context');
});

// --- Saving -------------------------------------------------------------------

function num(value, { min = -Infinity, max = Infinity, integer = false, allowBlank = false } = {}) {
  const s = String(value ?? '').trim();
  if (s === '') return allowBlank ? { value: null } : { error: 'is required' };
  const n = Number(s);
  if (!Number.isFinite(n)) return { error: 'must be a number' };
  if (integer && !Number.isInteger(n)) return { error: 'must be a whole number' };
  if (n < min || n > max) return { error: `must be between ${min} and ${max}` };
  return { value: n };
}

function parseForm(body, data) {
  const errors = [];
  const take = (label, value, opts) => {
    const r = num(value, opts);
    if (r.error) errors.push(`${label} ${r.error}.`);
    return r.value;
  };

  const g = body.global || {};
  const global = {
    ...DEFAULT_GLOBAL,
    planningHorizonDays: take('Planning horizon', g.planningHorizonDays, { min: 1, max: 90, integer: true }),
    reviewPeriodDays: take('Order every', g.reviewPeriodDays, { min: 1, max: 28, integer: true }),
    leadTimeDays: take('Usual lead time', g.leadTimeDays, { min: 0, max: 60, integer: true }),
    reserveDays: take('Emergency reserve', g.reserveDays, { min: 0, max: 21, integer: true }),
    runs: DEFAULT_GLOBAL.runs,
    seed: data.parameters.global.seed ?? DEFAULT_GLOBAL.seed,
    productCapacity: data.parameters.global.productCapacity || {},
  };

  const products = {};
  const priorities = {};
  for (const [id, product] of Object.entries(data.products)) {
    const f = body.p?.[id] || {};
    const label = product.name;
    const before = data.parameters.products[id] || {};
    const weekly = take(`${label}: weekly demand`, f.weeklyDemand, { min: 0, allowBlank: true });
    // Variability isn't on the form; it stays as estimated unless sent.
    const sd = f.weeklySd === undefined ? undefined : take(`${label}: variability`, f.weeklySd, { min: 0, allowBlank: true });
    const p = {
      dailyDemand: weekly === null || weekly === undefined ? null : weekly / 7,
      dailyVariance: sd === undefined ? before.dailyVariance ?? null : sd === null ? null : (sd * sd) / 7,
      seasonalMultiplier: before.seasonalMultiplier ?? 1,
      currentStock: take(`${label}: stock now`, f.currentStock, { min: 0, integer: true }),
      leadTimeDays: take(`${label}: lead time`, f.leadTimeDays, { min: 0, max: 60, integer: true }),
      shelfLifeDays: take(`${label}: shelf life`, f.shelfLifeDays, { min: 1, max: 3650, integer: true, allowBlank: true }),
    };
    if (p.dailyDemand !== null && p.dailyVariance === null) p.dailyVariance = p.dailyDemand;

    // A value keeps its original source unless the manager changed what the
    // form showed. Compare at the precision the form displays.
    const sources = { ...SOURCE_OF_DEFAULT, ...(before.sources || {}) };
    const shown = displayValues(before);
    const changed = {
      dailyDemand: shown.weeklyDemand !== round(weekly, 1),
      dailyVariance: sd !== undefined && shown.weeklySd !== round(sd, 1),
      currentStock: (before.currentStock ?? null) !== p.currentStock,
      leadTimeDays: (before.leadTimeDays ?? null) !== p.leadTimeDays,
      shelfLifeDays: (before.shelfLifeDays ?? null) !== p.shelfLifeDays,
    };
    for (const k of EDITABLE) {
      if (changed[k]) sources[k] = 'manual';
      else if (k in before) p[k] = before[k]; // no rounding drift
    }
    products[id] = { ...p, sources };

    if (f.priority && catalog.PRIORITIES[f.priority]) priorities[id] = f.priority;
  }
  return { errors, global, products, priorities };
}

router.post('/parameters', requireStep('parameters'), async (req, res) => {
  const data = res.locals.data;
  const approve = req.body.action === 'approve';
  const { errors, global, products, priorities } = parseForm(req.body, data);

  if (approve) {
    for (const [id, p] of Object.entries(products)) {
      if (p.dailyDemand === null) errors.push(`${data.products[id].name}: enter a weekly demand before approving.`);
    }
  }
  if (errors.length) return renderPage(res, data, { errors, status: 422 });

  // Recompute what depends on the edited values: analysis if the horizon
  // changed (holidays and weather), and storage capacity.
  const horizonChanged = global.planningHorizonDays !== horizonOf(data);
  const next = structuredClone(data);
  next.parameters = { ...data.parameters, products, global };
  if (horizonChanged) {
    const ctx = await context.gatherContext(data.organisation, { asOf: todayIso(), horizonDays: global.planningHorizonDays, historyFrom: historyFrom(data) });
    next.externalContext = ctx;
    next.analysis = await runAnalysis(next, ctx, global.planningHorizonDays);
    refreshInferred(next.parameters, next);
  }
  const capacity = data.parameters.sizes ? await computeCapacity(next, data.parameters.sizes) : null;
  const userId = res.locals.user.id;

  await req.store.mutate((d) => {
    const priorityChanged = Object.entries(priorities).some(([id, pr]) => d.products[id]?.priority !== pr);
    for (const [id, pr] of Object.entries(priorities)) if (d.products[id]) d.products[id].priority = pr;
    if (priorityChanged) storage.applyInvalidation(d, 'products');
    if (horizonChanged) {
      d.externalContext = next.externalContext;
      d.analysis = next.analysis;
    }

    // Any save clears results built on the previous parameters.
    storage.applyInvalidation(d, 'scenario');
    d.parameters = { ...next.parameters, approved: false, approvedAt: null, approvedBy: null, approvedVersion: null };
    if (capacity) applyCapacity(d.parameters, capacity);

    if (approve) {
      d.audit.inputVersion += 1;
      d.parameters.approved = true;
      d.parameters.approvedAt = new Date().toISOString();
      d.parameters.approvedBy = userId;
      d.parameters.approvedVersion = d.audit.inputVersion;
      // Scenario starts from the approved defaults.
      d.scenario = {
        ...storage.defaultWorkspace().scenario,
        reserveDays: global.reserveDays,
        planningHorizonDays: global.planningHorizonDays,
      };
      d.metadata.currentStep = 3;
    }
  });

  if (approve) {
    req.session.flash = { type: 'success', message: 'Parameters approved. Choose a scenario to test.' };
    return res.redirect('/scenario');
  }
  req.session.flash = { type: 'success', message: 'Draft saved. Approve the parameters when they look right.' };
  res.redirect('/parameters');
});

module.exports = router;
