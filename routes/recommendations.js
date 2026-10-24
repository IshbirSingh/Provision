// Step 5: recommendations dashboard, explanations and plan finalisation.
//
// The dashboard and the finalised plan render from the same record shape.
// A finalised record is immutable apart from attaching the final AI plan,
// which is written after all numbers are stored.

const crypto = require('crypto');
const express = require('express');
const storage = require('../services/storageService');
const plan = require('../services/planService');
const explanation = require('../services/explanationService');
const { requireStep } = require('../services/workflowService');
const { runPython } = require('../services/pythonBridge');

const router = express.Router();

// Each formula as [name, TeX, plain-English meaning].
const FORMULAS = [
  ['Daily demand', String.raw`\hat\mu = \frac{\sum c}{\sum L},\quad \hat v = \frac{1}{n-1}\sum \frac{(c - \hat\mu L)^2}{L}`, 'Average and spread of daily consumption from the falls in stock between counts (c units over L days).'],
  ['Demand distribution', String.raw`D \sim \mathrm{Poisson}(\mu)\ \text{if}\ \hat v \le \hat\mu,\ \text{else}\ \mathrm{NegBin}(\mu, \alpha),\ \alpha = \frac{\hat v - \hat\mu}{\hat\mu^2}`, 'Poisson when demand varies about as much as chance alone; negative binomial when it varies more.'],
  ['Forecast', String.raw`\mu = \hat\mu \times a \times (1 + r_D)`, 'a is the school-holiday and temperature adjustment where your records show an effect; r_D is any scenario increase.'],
  ['Order-up-to level', String.raw`T = \left\lceil F^{-1}_{D_h}(q) \right\rceil,\quad h = L + R`, 'The q-th percentile of demand over the lead time L plus the order period R. With a reserve: T = max(T, ⌈days × μ⌉).'],
  ['Order now', String.raw`Q = \max(0,\ T - \text{on hand} - \text{on order})`, 'Capped so stock never exceeds the space available for the product.'],
  ['Shortage chance', String.raw`P(\text{shortage}) = \frac{\text{futures with any unmet demand}}{\text{all futures}}`, 'Share of the simulated futures in which the product runs out at least once.'],
  ['Severe outcome', String.raw`\mathrm{CVaR}_{95} = \eta + \frac{\mathbb{E}[\max(U - \eta, 0)]}{0.05}`, 'Average unmet demand in the worst 5% of futures (η is the 95th percentile).'],
];

// A record-shaped snapshot of the current (not yet finalised) plan.
function draftRecord(data, user) {
  const sim = data.simulation;
  const rec = data.recommendations;
  const datasetKey = `dataset_v${Math.max(0, ...Object.values(data.audit.datasets || {}).map((d) => d.version))}`;
  const policySummary = (pol) => {
    const products = Object.fromEntries(Object.entries(pol.products).map(([id, r]) => {
      const { daily, ...rest } = r;
      return [id, rest];
    }));
    const protectedIds = Object.keys(pol.products).filter((id) => data.products[id].priority !== 'standard');
    return {
      totals: { ...pol.totals, dailyStock: undefined, emergencyReserveUnits: protectedIds.reduce((s, id) => s + pol.products[id].safetyStock, 0) },
      products,
      warnings: pol.warnings,
    };
  };
  const evidence = Object.fromEntries(Object.keys(data.products).map((id) => {
    const a = data.analysis.products?.[id] || {};
    return [id, {
      demand: a.demand || null,
      observations: a.observations ? { counts: a.observations.counts, from: a.observations.from, to: a.observations.to, byType: a.observations.byType } : null,
      stock: a.stock || null,
      adjustment: a.adjustment ? { multiplier: a.adjustment.multiplier, explanation: a.adjustment.explanation } : null,
      flags: (a.flags || []).filter((f) => f.level !== 'info' || f.code === 'excluded_movements'),
      parameterSources: data.parameters.products[id]?.sources || {},
    }];
  }));

  return {
    id: null,
    status: 'draft',
    createdAt: null,
    createdBy: user ? { id: user.id, name: user.name } : null,
    organisation: { name: data.organisation.name, postcode: data.organisation.postcode },
    inputVersion: data.audit.inputVersion,
    dataset: data.audit.datasets?.[datasetKey] ? (({ excludedRows, ...d }) => d)(data.audit.datasets[datasetKey]) : null,
    parameters: {
      approvedAt: data.parameters.approvedAt,
      approvedVersion: data.parameters.approvedVersion,
      global: data.parameters.global,
      products: data.parameters.products,
    },
    scenario: sim.config,
    scenarioLabel: plan.SCENARIOS[sim.config.scenarioId].label,
    calculation: {
      calculationVersion: sim.calculationVersion,
      seed: sim.seed,
      runs: sim.runs,
      ranAt: sim.ranAt,
      runtimeMs: sim.runtimeMs,
      methods: { ...data.analysis.patterns?.methods, ...sim.methods },
      checks: sim.checks,
      orderDays: sim.orderDays,
    },
    formulas: FORMULAS,
    forecastModel: sim.inputs,
    policyConstraints: {
      protectionLevels: sim.policyLevels,
      fineTune: rec.fineTune || null,
      reviewPeriodDays: data.parameters.global.reviewPeriodDays,
      productCapacity: data.parameters.global.productCapacity,
      selectionCriteria: 'The manager chose the policy after comparing simulated outcomes. No weighted score was used.',
    },
    storage: data.parameters.capacity ? { types: data.parameters.capacity.types, conversions: data.parameters.capacity.conversions, sizesSource: data.parameters.sizes?.source } : null,
    selectedPolicy: rec.selectedPolicy,
    fineTune: rec.fineTune || null,
    recommendation: { products: rec.products, order: rec.order, summary: rec.summary },
    policies: Object.fromEntries(plan.POLICIES.map((p) => [p, policySummary(sim.policies[p])])),
    adjusted: rec.fineTune ? policySummary(plan.policyResult(sim, rec.selectedPolicy)) : null,
    projected: Object.fromEntries(Object.entries(plan.policyResult(sim, rec.selectedPolicy).products).map(([id, r]) => [id, r.daily])),
    assumptions: sim.assumptions,
    warnings: rec.summary.warnings,
    evidence,
    explanations: { actionPlan: rec.explanations?.actionPlan || null, finalPlan: null },
  };
}

function viewOf(record, data) {
  return {
    title: 'Replenishment plan',
    record,
    labels: plan.POLICY_LABELS,
    urgency: plan.URGENCY,
    finalised: record.status === 'finalised',
    canSwitch: record.status !== 'finalised' && plan.simulationIsCurrent(data),
    defaultLevel: plan.DEFAULT_LEVELS[record.selectedPolicy],
    scripts: ['/vendor/plotly.min.js', '/vendor/katex/katex.min.js', '/js/charts.js', '/js/maths.js'],
  };
}

router.get('/plan', requireStep('plan'), (req, res) => {
  const data = res.locals.data;
  const rec = data.recommendations;
  if (rec.finalised && rec.recordId && data.audit.records[rec.recordId]) {
    return res.render('recommendations', viewOf(data.audit.records[rec.recordId], data));
  }
  if (!rec.selectedPolicy || !plan.simulationIsCurrent(data) || rec.calculationVersion !== data.simulation.calculationVersion) {
    req.session.flash = { type: 'info', message: 'Choose a policy from an up-to-date comparison first.' };
    return res.redirect('/compare');
  }
  res.render('recommendations', viewOf(draftRecord(data, res.locals.user), data));
});

// Fine-tune the chosen policy's protection level. Only that policy is
// re-simulated, with the same seed and futures, so it stays comparable with
// the other two.
router.post('/plan/fine-tune', requireStep('plan'), async (req, res) => {
  const data = res.locals.data;
  const rec = data.recommendations;
  const level = Number(req.body.level) / 100;
  if (!rec.selectedPolicy || rec.finalised || !plan.simulationIsCurrent(data)) {
    req.session.flash = { type: 'error', message: 'Choose a policy from an up-to-date comparison first.' };
    return res.redirect('/plan');
  }
  if (!Number.isFinite(level) || level < 0.5 || level > 0.99) {
    req.session.flash = { type: 'error', message: 'Choose a protection level between 50% and 99%.' };
    return res.redirect('/plan#fine-tune');
  }

  const policy = rec.selectedPolicy;
  const isDefault = Math.abs(level - plan.DEFAULT_LEVELS[policy]) < 0.0001;
  let fineTuned = null;
  if (!isDefault) {
    const payload = plan.buildSimulationPayload(data, { policyLevels: { [policy]: level } });
    payload.config.policyIds = [policy];
    let result;
    try {
      result = await runPython('simulate', payload, { timeoutMs: 180000 });
    } catch (err) {
      req.session.flash = { type: 'error', message: `The plan could not be re-run: ${err.message}` };
      return res.redirect('/plan');
    }
    if (result.checks.demandChecksum !== data.simulation.checks.demandChecksum) {
      throw new Error('Fine-tuned run did not use the same simulated futures');
    }
    fineTuned = { policy, level, levels: result.policyLevels[policy], result: result.policies[policy], ranAt: new Date().toISOString() };
  }

  const stored = await req.store.mutate((d) => {
    if (fineTuned) d.simulation.fineTuned = fineTuned;
    else delete d.simulation.fineTuned;
    storage.applyInvalidation(d, 'policy');
    d.recommendations = plan.buildRecommendation(d, policy);
  });
  await explanation.attachActionPlan(req.store, stored);
  const label = plan.POLICY_LABELS[policy];
  req.session.flash = { type: 'success', message: isDefault ? `Back to the standard ${label} plan.` : `${label} re-run at ${Math.round(level * 100)}% protection.` };
  res.redirect('/plan');
});

router.post('/plan/finalise', requireStep('plan'), async (req, res) => {
  const user = res.locals.user;
  const id = `rec_${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}_${crypto.randomBytes(3).toString('hex')}`;

  // 1. Validate and freeze every number.
  const result = await req.store.mutate((d) => {
    const rec = d.recommendations;
    if (!rec.selectedPolicy) return { error: 'Choose a policy before finalising.' };
    if (rec.finalised) return { error: 'This plan is already finalised.' };
    if (!plan.simulationIsCurrent(d) || rec.calculationVersion !== d.simulation.calculationVersion || rec.inputVersion !== d.audit.inputVersion) {
      return { error: 'The recommendations no longer match the approved inputs and current calculation. Run the comparison again.' };
    }
    const record = draftRecord(d, user);
    record.id = id;
    record.status = 'finalised';
    record.createdAt = new Date().toISOString();
    d.audit.records[id] = record;
    d.recommendations.finalised = true;
    d.recommendations.recordId = id;
    d.recommendations.finalisedAt = record.createdAt;
    return { record, reviewPeriodDays: d.parameters.global.reviewPeriodDays, sim: d.simulation, rec: d.recommendations };
  });
  if (result.error) {
    req.session.flash = { type: 'error', message: result.error };
    return res.redirect(result.error.includes('Run the comparison') ? '/compare' : '/plan');
  }

  // 2. Write the final plan from the stored numbers, then attach it.
  const facts = explanation.buildFacts(result.rec, result.sim, result.reviewPeriodDays);
  const finalPlan = await explanation.generate('final', facts);
  await req.store.mutate((d) => {
    const record = d.audit.records[id];
    if (record && !record.explanations.finalPlan) {
      record.explanations.finalPlan = { ...finalPlan, calculationVersion: record.calculation.calculationVersion };
    }
  });

  req.session.flash = { type: 'success', message: `Plan finalised and saved as ${id}. The numbers are now fixed.` };
  res.redirect('/plan');
});

function findRecord(data, id) {
  if (id) return data.audit.records[id] || null;
  const rec = data.recommendations;
  return rec.finalised && rec.recordId ? data.audit.records[rec.recordId] : null;
}

router.get('/plan/download', (req, res) => {
  const record = findRecord(res.locals.data, req.query.id);
  if (!record) return res.status(404).render('error', { title: 'Plan not found', message: 'Finalise a plan to download it.' });
  res.setHeader('Content-Disposition', `attachment; filename="provision-${record.id}.json"`);
  res.type('application/json').send(JSON.stringify(record, null, 2));
});

router.get('/plan/print', (req, res) => {
  const data = res.locals.data;
  const record = findRecord(data, req.query.id);
  if (!record) return res.status(404).render('error', { title: 'Plan not found', message: 'Finalise a plan to print it.' });
  res.render('plan-print', { title: `Plan ${record.id}`, record, labels: plan.POLICY_LABELS, urgency: plan.URGENCY });
});

module.exports = router;
