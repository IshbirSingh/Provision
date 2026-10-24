// Steps 3 and 4: scenario selection, simulation and policy comparison.

const express = require('express');
const storage = require('../services/storageService');
const plan = require('../services/planService');
const explanation = require('../services/explanationService');
const { runPython } = require('../services/pythonBridge');
const { requireStep } = require('../services/workflowService');

const router = express.Router();

function intIn(value, lo, hi, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n >= lo && n <= hi ? n : fallback;
}

// Read the scenario form. Adjustments that don't belong to the chosen
// preset are only applied when the manager ticks "combine" for them, so a
// slider left over from another preset never changes this one silently.
function parseScenario(body, defaults) {
  const id = plan.SCENARIOS[body.scenarioId] ? body.scenarioId : null;
  if (!id) return { error: 'Choose a scenario.' };
  const combine = body.combine || {};
  const useDemand = id === 'increased_demand' || combine.demand === 'on';
  const useReserve = id === 'safety_first' || combine.reserve === 'on';
  const useDelivery = id === 'delivery_disruption' || combine.delivery === 'on';
  const reduce = useDelivery && body.reduceQuantities === 'on';

  return {
    scenario: {
      type: plan.SCENARIOS[id].storeAs,
      demandMultiplier: useDemand ? 1 + intIn(body.demandIncreasePct, 0, 100, 0) / 100 : 1.0,
      reserveDays: useReserve ? intIn(body.reserveDays, 0, 21, defaults.reserveDays) : defaults.reserveDays,
      applyReserve: useReserve,
      additionalDeliveryDelayDays: useDelivery ? intIn(body.delayDays, 0, 14, 0) : 0,
      supplyFulfilmentMultiplier: reduce ? 1 - intIn(body.quantityReductionPct, 0, 100, 0) / 100 : 1.0,
      planningHorizonDays: defaults.planningHorizonDays,
      combined: { demand: useDemand && id !== 'increased_demand', reserve: useReserve && id !== 'safety_first', delivery: useDelivery && id !== 'delivery_disruption' },
      reduceQuantities: reduce,
      setAt: new Date().toISOString(),
    },
  };
}

router.get('/scenario', requireStep('scenario'), async (req, res) => {
  const data = res.locals.data;
  const payload = plan.buildSimulationPayload(data);
  let preview = null;
  try {
    preview = await runPython('preview', { ...payload, config: { ...payload.config, demandIncrease: 0, additionalDeliveryDelayDays: 0, deliveryQuantityReduction: 0 } });
  } catch (err) {
    console.error('[scenario] preview failed:', err.message);
  }
  const seasonal = Object.values(data.parameters.products).filter((p) => Math.abs((p.seasonalMultiplier ?? 1) - 1) > 1e-9).length;
  res.render('scenarios', {
    title: 'Scenario',
    scenario: data.scenario,
    config: plan.scenarioConfig(data),
    global: data.parameters.global,
    preview,
    seasonalProducts: seasonal,
    hasResults: plan.simulationIsCurrent(data),
    scripts: ['/js/scenarios.js'],
  });
});

router.post('/scenario', requireStep('scenario'), async (req, res) => {
  const data = res.locals.data;
  const g = data.parameters.global;
  const parsed = parseScenario(req.body, { reserveDays: g.reserveDays, planningHorizonDays: g.planningHorizonDays });
  if (parsed.error) {
    req.session.flash = { type: 'error', message: parsed.error };
    return res.redirect('/scenario');
  }

  // Save the scenario (clears old results), then simulate from the saved state.
  const saved = await req.store.mutate((d) => {
    storage.applyInvalidation(d, 'scenario');
    d.scenario = parsed.scenario;
  });
  const payload = plan.buildSimulationPayload(saved);
  const calcVersion = plan.calculationVersion(saved, payload);
  let result;
  try {
    result = await runPython('simulate', payload, { timeoutMs: 180000 });
  } catch (err) {
    console.error('[simulate]', err.message, err.details?.trace || '');
    req.session.flash = { type: 'error', message: `The simulation could not run: ${err.message}` };
    return res.redirect('/scenario');
  }

  await req.store.mutate((d) => {
    d.simulation = {
      seed: payload.config.randomSeed,
      runs: payload.config.numberOfRuns,
      calculationVersion: calcVersion,
      inputVersion: d.audit.inputVersion,
      ranAt: new Date().toISOString(),
      ...result,
    };
    d.audit.calculationVersion = calcVersion;
    d.metadata.currentStep = 4;
  });
  res.redirect('/compare');
});

router.get('/compare', requireStep('compare'), (req, res) => {
  const data = res.locals.data;
  if (!plan.simulationIsCurrent(data)) {
    req.session.flash = { type: 'info', message: 'Choose a scenario and compare policies to see results.' };
    return res.redirect('/scenario');
  }
  res.render('compare-policies', {
    title: 'Compare policies',
    sim: data.simulation,
    products: data.products,
    selected: data.recommendations.selectedPolicy,
    labels: plan.POLICY_LABELS,
    scenarioLabel: plan.SCENARIOS[data.simulation.config.scenarioId].label,
    scripts: ['/vendor/plotly.min.js', '/js/charts.js'],
  });
});

// Select a policy: store the numerical recommendation first, then ask
// Nebius (or the template) to explain it.
router.post('/compare/select', requireStep('compare'), async (req, res) => {
  const policy = req.body.policy;
  if (!plan.POLICIES.includes(policy)) {
    req.session.flash = { type: 'error', message: 'Choose Lean, Balanced or Resilient.' };
    return res.redirect('/compare');
  }
  const current = await req.store.loadData();
  if (!plan.simulationIsCurrent(current)) {
    req.session.flash = { type: 'error', message: 'These results are out of date. Run the comparison again.' };
    return res.redirect('/scenario');
  }
  if (current.recommendations.finalised) {
    req.session.flash = { type: 'info', message: 'This plan is already finalised. Run a new comparison to make another.' };
    return res.redirect('/plan');
  }

  const stored = await req.store.mutate((d) => {
    storage.applyInvalidation(d, 'policy');
    delete d.simulation.fineTuned; // a newly chosen policy starts from its standard level
    d.recommendations = plan.buildRecommendation(d, policy);
    d.metadata.currentStep = 5;
  });

  await explanation.attachActionPlan(req.store, stored);
  res.redirect('/plan');
});

module.exports = router;
