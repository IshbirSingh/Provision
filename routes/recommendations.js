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

const router = express.Router();

const FORMULAS = [
  ['Daily demand estimate', 'μ̂ = Σc ÷ ΣL and v̂ = Σ(c − μ̂L)² ÷ L ÷ (n − 1), over intervals where stock fell (c units over L days)'],
  ['Demand distribution', 'Poisson if v̂ ≤ μ̂; otherwise negative binomial with α̂ = (v̂ − μ̂) ÷ μ̂², so Var(D) = μ + αμ²'],
  ['Scenario adjustment', 'μ = μ̂ × seasonal adjustment × (1 + demand increase); L′ = L + extra delay; delivered = ⌊Q × (1 − reduction)⌋'],
  ['Order-up-to target', 'T = ⌈F⁻¹(q)⌉ of demand over h = lead time + order period (Resilient uses L′). With a reserve: T = max(T, ⌈R × μ_base⌉)'],
  ['Order quantity', 'Q = max(0, T − IP), where IP = stock on hand + stock on order; capped at max(0, C − IP) if capacity C is known'],
  ['Simulation', 'Each day: deliveries arrive, out-of-date stock is removed, orders are placed on order days, then demand is met oldest-date-first'],
  ['Shortage chance', 'Share of simulated futures with at least one unit of unmet demand over the horizon'],
  ['Severe outcome (CVaR 95%)', 'Average total unmet demand in the worst 5% of futures: η + E[max(L − η, 0)] ÷ 0.05, η = 95th percentile'],
];

// A record-shaped snapshot of the current (not yet finalised) plan.
function draftRecord(data, user) {
  const sim = data.simulation;
  const rec = data.recommendations;
  const datasetKey = `dataset_v${Math.max(0, ...Object.values(data.audit.datasets || {}).map((d) => d.version))}`;
  const policySummary = (p) => {
    const pol = sim.policies[p];
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
      seasonality: a.seasonality ? { suggestedMultiplier: a.seasonality.suggestedMultiplier, reason: a.seasonality.reason } : null,
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
      quantiles: data.parameters.global.quantiles,
      reviewPeriodDays: data.parameters.global.reviewPeriodDays,
      deliverySuccessProbability: data.parameters.global.deliverySuccessProbability,
      categoryCapacity: data.parameters.global.categoryCapacity,
      budget: data.organisation.budget,
      selectionCriteria: 'The manager chose the policy after comparing simulated outcomes. No weighted score was used.',
    },
    selectedPolicy: rec.selectedPolicy,
    recommendation: { products: rec.products, order: rec.order, summary: rec.summary },
    policies: Object.fromEntries(plan.POLICIES.map((p) => [p, policySummary(p)])),
    projected: Object.fromEntries(Object.entries(sim.policies[rec.selectedPolicy].products).map(([id, r]) => [id, r.daily])),
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
    scripts: ['/vendor/plotly.min.js', '/js/charts.js'],
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

router.post('/plan/finalise', requireStep('plan'), async (req, res) => {
  const user = res.locals.user;
  const id = `rec_${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}_${crypto.randomBytes(3).toString('hex')}`;

  // 1. Validate and freeze every number.
  const result = await storage.mutate((d) => {
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
  await storage.mutate((d) => {
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
  res.setHeader('Content-Disposition', `attachment; filename="supplyshield-${record.id}.json"`);
  res.type('application/json').send(JSON.stringify(record, null, 2));
});

router.get('/plan/print', (req, res) => {
  const data = res.locals.data;
  const record = findRecord(data, req.query.id);
  if (!record) return res.status(404).render('error', { title: 'Plan not found', message: 'Finalise a plan to print it.' });
  res.render('plan-print', { title: `Plan ${record.id}`, record, labels: plan.POLICY_LABELS, urgency: plan.URGENCY });
});

module.exports = router;
