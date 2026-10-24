// Step 2: historical analysis, external context and parameter approval.
//
// Analysis runs in Python and is cached against the approved dataset version,
// as-of date and planning horizon. Parameters start from the analysis; any
// value a manager changes is labelled as their own assumption.

const express = require('express');
const storage = require('../services/storageService');
const context = require('../services/contextService');
const catalog = require('../services/catalog');
const { runPython } = require('../services/pythonBridge');
const { requireStep } = require('../services/workflowService');

const router = express.Router();

// Labelled assumptions used where stock counts can't tell us the answer.
const DEFAULT_GLOBAL = {
  reviewPeriodDays: 7,
  leadTimeDays: 7,
  deliverySuccessProbability: 0.9,
  reserveDays: 7,
  quantiles: { lean: 0.5, balanced: 0.8, resilient: { critical: 0.95, essential: 0.9, standard: 0.8 } },
  runs: 1000,
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

const todayIso = () => new Date().toISOString().slice(0, 10);
const datasetVersion = (data) => Math.max(0, ...Object.values(data.audit.datasets || {}).map((d) => d.version));
const round = (x, n = 2) => (x === null || x === undefined ? null : Math.round(x * 10 ** n) / 10 ** n);

function horizonOf(data) {
  return data.parameters.global?.planningHorizonDays || data.organisation.planningHorizonDays || 28;
}

function analysisIsCurrent(data, horizon) {
  const m = data.analysis.meta;
  return m && m.datasetVersion === datasetVersion(data) && m.asOf === todayIso() && m.horizonDays === horizon;
}

async function runAnalysis(data, horizon) {
  const result = await runPython('analyse', {
    asOf: todayIso(),
    horizonDays: horizon,
    holidays: context.ENGLAND_SCHOOL_HOLIDAYS,
    products: data.products,
    records: Object.values(data.historicalStock),
    batches: Object.values(data.inventory),
  });
  return {
    products: result.products,
    patterns: { methods: result.methods, assumptions: result.assumptions },
    warnings: {},
    meta: { datasetVersion: datasetVersion(data), asOf: result.asOf, horizonDays: horizon, ranAt: new Date().toISOString() },
  };
}

function inferredDefaults(product, a, global) {
  const dm = a?.demand || {};
  return {
    dailyDemand: dm.available ? dm.dailyMean : null,
    dailyVariance: dm.available ? dm.dailyVariance ?? dm.dailyMean : null,
    seasonalMultiplier: a?.seasonality?.suggestedMultiplier ?? 1,
    currentStock: a?.stock?.current ?? 0,
    leadTimeDays: global.leadTimeDays,
    shelfLifeDays: SHELF_LIFE_DAYS[product.category] ?? null,
    unitCost: product.unitCost ?? null,
  };
}

const SOURCE_OF_DEFAULT = {
  dailyDemand: 'inferred',
  dailyVariance: 'inferred',
  seasonalMultiplier: 'inferred',
  currentStock: 'approved_data',
  leadTimeDays: 'assumption',
  shelfLifeDays: 'assumption',
  unitCost: 'not_provided',
};

function buildDraft(data, horizon) {
  const global = {
    ...DEFAULT_GLOBAL,
    planningHorizonDays: horizon,
    categoryCapacity: Object.fromEntries(Object.keys(catalog.CATEGORIES).map((c) => [c, null])),
  };
  const products = {};
  for (const [id, p] of Object.entries(data.products)) {
    const values = inferredDefaults(p, data.analysis.products[id], global);
    products[id] = { ...values, sources: { ...SOURCE_OF_DEFAULT } };
  }
  return { products, global, approved: false, basedOnDataset: datasetVersion(data), approvedAt: null, approvedBy: null, approvedVersion: null };
}

// After the analysis changes (new day or horizon), refresh values that still
// come from it; values the manager set are left alone.
function refreshInferred(params, data) {
  for (const [id, p] of Object.entries(params.products)) {
    const defaults = inferredDefaults(data.products[id], data.analysis.products[id], params.global);
    for (const key of ['dailyDemand', 'dailyVariance', 'seasonalMultiplier', 'currentStock']) {
      if (p.sources?.[key] === SOURCE_OF_DEFAULT[key]) p[key] = defaults[key];
    }
  }
}

// Bring analysis, context and the parameter draft up to date. Returns the
// fresh data. Context failures never block the page.
async function ensureCurrent(data) {
  const horizon = horizonOf(data);
  const needAnalysis = !analysisIsCurrent(data, horizon);
  const needContext = !context.isFresh(data.externalContext, data.organisation, horizon);
  const needDraft = !Object.keys(data.parameters.products).length || data.parameters.basedOnDataset !== datasetVersion(data);
  if (!needAnalysis && !needContext && !needDraft) return data;

  const [analysis, ctx] = await Promise.all([
    needAnalysis ? runAnalysis(data, horizon) : null,
    needContext ? context.gatherContext(data.organisation, { asOf: todayIso(), horizonDays: horizon }) : null,
  ]);

  return storage.mutate((d) => {
    if (analysis) d.analysis = analysis;
    if (ctx) d.externalContext = ctx;
    if (needDraft || d.parameters.basedOnDataset !== datasetVersion(d)) {
      d.parameters = buildDraft(d, horizon);
    } else if (analysis) {
      refreshInferred(d.parameters, d);
    }
  });
}

function modelFor(mean, variance) {
  // Display only: the Python engine applies the same rule authoritatively.
  if (!mean || variance === null || variance <= mean) return { model: 'Poisson', alpha: 0 };
  return { model: 'Negative binomial', alpha: (variance - mean) / mean ** 2 };
}

// The weekly figures shown on the form. Variability is the model's weekly
// standard deviation: never below Poisson (variance = mean).
function displayValues(p) {
  const has = (x) => x !== null && x !== undefined;
  return {
    weeklyDemand: has(p.dailyDemand) ? round(7 * p.dailyDemand, 1) : null,
    weeklySd: has(p.dailyVariance) ? round(Math.sqrt(7 * Math.max(p.dailyVariance, p.dailyDemand || 0)), 1) : null,
    seasonalMultiplier: has(p.seasonalMultiplier) ? round(p.seasonalMultiplier, 3) : null,
  };
}

function viewRows(data) {
  const params = data.parameters;
  return Object.entries(data.products)
    .map(([id, product]) => {
      const p = params.products[id] || {};
      const a = data.analysis.products[id] || {};
      const shown = displayValues(p);
      return {
        id,
        product,
        params: p,
        analysis: a,
        weeklyDemand: shown.weeklyDemand,
        weeklySd: shown.weeklySd,
        ...modelFor(p.dailyDemand, p.dailyVariance),
        daysOfCover: p.dailyDemand ? round(p.currentStock / (p.dailyDemand * (p.seasonalMultiplier || 1)), 1) : null,
      };
    })
    .sort((x, y) => catalog.PRIORITIES[x.product.priority].rank - catalog.PRIORITIES[y.product.priority].rank
      || (x.daysOfCover ?? Infinity) - (y.daysOfCover ?? Infinity));
}

function categoryRows(data) {
  return Object.entries(catalog.CATEGORIES)
    .map(([id, c]) => {
      const products = Object.entries(data.products).filter(([, p]) => p.category === id);
      return {
        id,
        label: c.label,
        products: products.map(([, p]) => p.name),
        units: [...new Set(products.map(([, p]) => p.unit).filter(Boolean))],
        stock: products.reduce((s, [pid]) => s + (data.parameters.products[pid]?.currentStock || 0), 0),
        capacity: data.parameters.global.categoryCapacity?.[id] ?? null,
      };
    })
    .filter((c) => c.products.length);
}

router.get('/parameters', requireStep('parameters'), async (req, res) => {
  const data = await ensureCurrent(res.locals.data);
  res.render('parameters', {
    title: 'Planning parameters',
    analysis: data.analysis,
    ctx: data.externalContext,
    params: data.parameters,
    rows: viewRows(data),
    categoryRows: categoryRows(data),
    organisation: data.organisation,
    priorities: catalog.PRIORITIES,
    categories: catalog.CATEGORIES,
    errors: [],
    scripts: ['/vendor/plotly.min.js', '/js/charts.js'],
  });
});

router.post('/parameters/context', requireStep('parameters'), async (req, res) => {
  const data = res.locals.data;
  const ctx = await context.gatherContext(data.organisation, { asOf: todayIso(), horizonDays: horizonOf(data) });
  await storage.mutate((d) => {
    d.externalContext = ctx;
  });
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
    planningHorizonDays: take('Planning horizon', g.planningHorizonDays, { min: 1, max: 90, integer: true }),
    reviewPeriodDays: take('Order review period', g.reviewPeriodDays, { min: 1, max: 28, integer: true }),
    leadTimeDays: take('Default lead time', g.leadTimeDays, { min: 0, max: 60, integer: true }),
    deliverySuccessProbability: (() => {
      const pct = take('Delivery success rate', g.deliverySuccessPercent, { min: 0, max: 100 });
      return pct === null || pct === undefined ? pct : pct / 100;
    })(),
    reserveDays: take('Reserve days', g.reserveDays, { min: 0, max: 21, integer: true }),
    quantiles: {
      lean: take('Lean quantile', g.qLean, { min: 0.01, max: 0.99 }),
      balanced: take('Balanced quantile', g.qBalanced, { min: 0.01, max: 0.99 }),
      resilient: {
        critical: take('Resilient quantile (critical)', g.qCritical, { min: 0.01, max: 0.999 }),
        essential: take('Resilient quantile (essential)', g.qEssential, { min: 0.01, max: 0.999 }),
        standard: take('Resilient quantile (standard)', g.qStandard, { min: 0.01, max: 0.999 }),
      },
    },
    runs: data.parameters.global.runs || DEFAULT_GLOBAL.runs,
    seed: data.parameters.global.seed ?? DEFAULT_GLOBAL.seed,
    categoryCapacity: {},
  };
  const q = global.quantiles;
  if (q.lean !== undefined && q.balanced !== undefined && q.lean >= q.balanced) {
    errors.push('The Lean quantile must be lower than the Balanced quantile.');
  }
  for (const id of Object.keys(catalog.CATEGORIES)) {
    global.categoryCapacity[id] = take(`Capacity for ${catalog.CATEGORIES[id].label}`, body.capacity?.[id], { min: 0, integer: true, allowBlank: true }) ?? null;
  }

  const products = {};
  const priorities = {};
  for (const [id, product] of Object.entries(data.products)) {
    const f = body.p?.[id] || {};
    const label = product.name;
    const before = data.parameters.products[id] || {};
    const weekly = take(`${label}: weekly demand`, f.weeklyDemand, { min: 0, allowBlank: true });
    const sd = take(`${label}: weekly variability`, f.weeklySd, { min: 0, allowBlank: true });
    const p = {
      dailyDemand: weekly === null || weekly === undefined ? null : weekly / 7,
      dailyVariance: sd === null || sd === undefined ? null : (sd * sd) / 7,
      seasonalMultiplier: take(`${label}: seasonal adjustment`, f.seasonalMultiplier, { min: 0.5, max: 2 }),
      currentStock: take(`${label}: current stock`, f.currentStock, { min: 0, integer: true }),
      leadTimeDays: take(`${label}: lead time`, f.leadTimeDays, { min: 0, max: 60, integer: true }),
      shelfLifeDays: take(`${label}: shelf life`, f.shelfLifeDays, { min: 1, max: 3650, integer: true, allowBlank: true }),
      unitCost: take(`${label}: unit cost`, f.unitCost, { min: 0, allowBlank: true }),
    };
    if (p.dailyDemand !== null && p.dailyVariance === null) p.dailyVariance = p.dailyDemand;

    // A value keeps its original source unless the manager changed what the
    // form showed. Compare at the precision the form displays.
    const sources = { ...SOURCE_OF_DEFAULT, ...(before.sources || {}) };
    const shown = displayValues(before);
    const changed = {
      dailyDemand: shown.weeklyDemand !== round(weekly, 1),
      dailyVariance: shown.weeklySd !== round(sd, 1),
      seasonalMultiplier: shown.seasonalMultiplier !== round(p.seasonalMultiplier, 3),
      currentStock: (before.currentStock ?? null) !== p.currentStock,
      leadTimeDays: (before.leadTimeDays ?? null) !== p.leadTimeDays,
      shelfLifeDays: (before.shelfLifeDays ?? null) !== p.shelfLifeDays,
      unitCost: round(before.unitCost, 2) !== round(p.unitCost, 2),
    };
    for (const [k, c] of Object.entries(changed)) if (c) sources[k] = 'manual';
    // Unchanged values keep their exact stored figures (no rounding drift).
    for (const [k, c] of Object.entries(changed)) if (!c && k in before) p[k] = before[k];
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
  if (errors.length) {
    return res.status(422).render('parameters', {
      title: 'Planning parameters',
      analysis: data.analysis,
      ctx: data.externalContext,
      params: data.parameters,
      rows: viewRows(data),
      categoryRows: categoryRows(data),
      organisation: data.organisation,
      priorities: catalog.PRIORITIES,
      categories: catalog.CATEGORIES,
      errors,
      scripts: ['/vendor/plotly.min.js', '/js/charts.js'],
    });
  }

  const horizonChanged = global.planningHorizonDays !== horizonOf(data);
  const analysis = horizonChanged ? await runAnalysis(data, global.planningHorizonDays) : null;
  const userId = res.locals.user.id;

  await storage.mutate((d) => {
    const priorityChanged = Object.entries(priorities).some(([id, pr]) => d.products[id]?.priority !== pr);
    for (const [id, pr] of Object.entries(priorities)) if (d.products[id]) d.products[id].priority = pr;
    if (priorityChanged) storage.applyInvalidation(d, 'products');
    if (analysis) d.analysis = analysis;

    // Any save clears results built on the previous parameters.
    storage.applyInvalidation(d, 'scenario');
    d.parameters = {
      ...d.parameters,
      products,
      global,
      approved: false,
      approvedAt: null,
      approvedBy: null,
      approvedVersion: null,
    };
    if (analysis) refreshInferred(d.parameters, d);

    if (approve) {
      d.audit.inputVersion += 1;
      d.parameters.approved = true;
      d.parameters.approvedAt = new Date().toISOString();
      d.parameters.approvedBy = userId;
      d.parameters.approvedVersion = d.audit.inputVersion;
      // Scenario starts from the approved defaults.
      d.scenario = {
        ...storage.defaultData().scenario,
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
