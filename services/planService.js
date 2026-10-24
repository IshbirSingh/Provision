// Steps 3-5: builds the simulation input from approved data, and turns a
// chosen policy's simulation results into recommendation records.
// No numbers are created here beyond selecting, summing and sorting what the
// Python engine returned.

const crypto = require('crypto');
const catalog = require('./catalog');

const POLICIES = ['lean', 'balanced', 'resilient'];
const POLICY_LABELS = { lean: 'Lean', balanced: 'Balanced', resilient: 'Resilient' };
const SCENARIOS = {
  normal_operations: { label: 'Normal operations', storeAs: 'normal' },
  increased_demand: { label: 'Increased demand', storeAs: 'increased_demand' },
  safety_first: { label: 'Safety first', storeAs: 'safety_first' },
  delivery_disruption: { label: 'Delivery disruption', storeAs: 'delivery_disruption' },
};
const SCENARIO_FROM_STORED = Object.fromEntries(Object.entries(SCENARIOS).map(([id, s]) => [s.storeAs, id]));

const todayIso = () => new Date().toISOString().slice(0, 10);
const DEFAULT_QUANTILES = { lean: 0.5, balanced: 0.8, resilient: { critical: 0.95, essential: 0.9, standard: 0.8 } };
const HIGH_RISK = 0.2;
// Standard protection level of each policy (Resilient: for critical items).
const DEFAULT_LEVELS = { lean: 0.5, balanced: 0.8, resilient: 0.95 };

// Scenario config in the spec 3.5 contract shape, from data.scenario.
function scenarioConfig(data) {
  const s = data.scenario;
  const g = data.parameters.global;
  return {
    scenarioId: SCENARIO_FROM_STORED[s.type] || 'normal_operations',
    demandIncrease: Math.round(((s.demandMultiplier ?? 1) - 1) * 1000) / 1000,
    reserveDays: s.reserveDays ?? g.reserveDays,
    applyReserve: Boolean(s.applyReserve),
    additionalDeliveryDelayDays: s.additionalDeliveryDelayDays ?? 0,
    deliveryQuantityReduction: Math.round((1 - (s.supplyFulfilmentMultiplier ?? 1)) * 1000) / 1000,
    planningHorizonDays: g.planningHorizonDays,
    numberOfRuns: g.runs || 1000,
    randomSeed: g.seed ?? 42,
    policyIds: POLICIES,
  };
}

function buildSimulationPayload(data, { policyLevels = null } = {}) {
  const products = {};
  for (const [id, p] of Object.entries(data.products)) {
    const params = data.parameters.products[id];
    products[id] = {
      name: p.name,
      category: p.category,
      priority: p.priority,
      unit: p.unit,
      dailyDemand: params.dailyDemand,
      dailyVariance: params.dailyVariance,
      seasonalMultiplier: params.seasonalMultiplier,
      currentStock: params.currentStock,
      leadTimeDays: params.leadTimeDays,
      shelfLifeDays: params.shelfLifeDays,
      batches: Object.values(data.inventory)
        .filter((b) => b.productId === id)
        .map((b) => ({ quantity: b.quantity, expiryDate: b.expiryDate })),
    };
  }
  const g = data.parameters.global;
  return {
    config: scenarioConfig(data),
    asOf: todayIso(),
    global: {
      reviewPeriodDays: g.reviewPeriodDays,
      // Stock counts can't show delivery reliability; the Delivery disruption
      // scenario is how unreliable deliveries are tested.
      deliverySuccessProbability: 1.0,
      quantiles: g.quantiles || DEFAULT_QUANTILES,
      productCapacity: g.productCapacity || {},
    },
    products,
    ...(policyLevels ? { policyLevels } : {}),
  };
}

function calculationVersion(data, payload) {
  const hash = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 12);
  return `calc_v${data.audit.inputVersion}_${hash}`;
}

// Is the stored simulation still the one for the current inputs?
function simulationIsCurrent(data) {
  const sim = data.simulation;
  return Boolean(sim.calculationVersion)
    && sim.inputVersion === data.audit.inputVersion
    && sim.calculationVersion === data.audit.calculationVersion
    && data.parameters.approved === true;
}

// --- Recommendations -------------------------------------------------------

const URGENCY = {
  act_now: { rank: 0, label: 'Act now' },
  high: { rank: 1, label: 'High' },
  expiry: { rank: 2, label: 'Expiry' },
  normal: { rank: 3, label: 'Routine' },
};

function expiringBatches(data, productId, horizon) {
  const a = data.analysis.products?.[productId];
  return (a?.expiry?.batches || []).filter((b) => b.daysToExpiry <= horizon);
}

function urgencyOf(r) {
  const protectedPriority = r.priority === 'critical' || r.priority === 'essential';
  if (r.shortageBeforeFirstDelivery >= 0.5) return 'act_now';
  if (protectedPriority && r.shortageRisk >= 0.25) return 'high';
  if (r.expiring.quantity > 0 && (r.expectedWaste ?? 0) > 0) return 'expiry';
  return 'normal';
}

// Why a shortage chance is high, in plain words, from the simulation's own
// inputs and results. Only reasons the numbers support are given.
function riskReasons(r, inputs, pr, cfg, policy) {
  if (r.shortageRisk < HIGH_RISK) return [];
  const reasons = [];
  const before = inputs.expectedDemandBeforeFirstDelivery;
  if (inputs.leadTimeDisrupted >= cfg.planningHorizonDays) {
    reasons.push(`No order can arrive within the ${cfg.planningHorizonDays}-day horizon (the earliest delivery is day ${inputs.leadTimeDisrupted}), so only current stock can be given out.`);
  } else if (before !== null && inputs.currentStock < before) {
    reasons.push(`Current stock (${inputs.currentStock}) is less than the ${Math.round(before)} expected to be needed before the earliest delivery on day ${inputs.leadTimeDisrupted}. No order can arrive sooner.`);
  }
  if (pr.capacityShortfallPerOrder > 0 && inputs.capacity !== null) {
    reasons.push(`Storage space limits this product to about ${inputs.capacity} at a time, below the order-up-to level of ${pr.target}.`);
  }
  if (cfg.additionalDeliveryDelayDays > 0) reasons.push(`Deliveries arrive ${cfg.additionalDeliveryDelayDays} days late in this scenario.`);
  if (cfg.deliveryQuantityReduction > 0) reasons.push(`Deliveries bring ${Math.round(cfg.deliveryQuantityReduction * 100)}% less than ordered in this scenario.`);
  if (cfg.demandIncrease > 0) reasons.push(`Demand is ${Math.round(cfg.demandIncrease * 100)}% above the forecast in this scenario.`);
  if (policy === 'lean') reasons.push('Lean only orders up to the typical (median) demand, so it accepts more risk by design.');
  if (inputs.weeklyCv !== null && inputs.weeklyCv > 0.5) reasons.push('Demand changes a lot from week to week, so shortages are hard to rule out.');
  if (!reasons.length) reasons.push('In a share of the simulated futures, demand is higher than the order-up-to level. A higher protection level would lower this.');
  return reasons;
}

// The results to use for a policy: its fine-tuned version if there is one.
function policyResult(sim, policy) {
  return sim.fineTuned?.policy === policy ? sim.fineTuned.result : sim.policies[policy];
}

function buildRecommendation(data, policy) {
  const sim = data.simulation;
  const horizon = sim.config.planningHorizonDays;
  const chosen = policyResult(sim, policy);
  const fineTune = sim.fineTuned?.policy === policy ? { level: sim.fineTuned.level, levels: sim.fineTuned.levels } : null;
  const products = {};

  for (const [id, pr] of Object.entries(chosen.products)) {
    const product = data.products[id];
    const inputs = sim.inputs[id];
    const batches = expiringBatches(data, id, horizon);
    const r = {
      productId: id,
      name: product.name,
      unit: product.unit,
      category: product.category,
      priority: product.priority,
      currentStock: inputs.currentStock,
      expectedDemand: inputs.expectedDemandHorizon,
      replenish: pr.initialOrder,
      target: pr.target,
      emergencyReserve: pr.safetyStock,
      reserveUnits: inputs.reserveUnits,
      reserveBinding: pr.reserveBinding,
      shortageRisk: pr.shortageProbability,
      shortageBeforeFirstDelivery: pr.shortageBeforeFirstDelivery,
      firstPossibleDeliveryDay: pr.firstPossibleDeliveryDay,
      medianFirstShortageDay: pr.medianFirstShortageDay,
      expectedUnmet: pr.expectedUnmet,
      unmetP95: pr.unmetP95,
      expectedWaste: pr.expectedWaste,
      expectedEnding: pr.expectedEnding,
      averageOrdered: pr.averageOrdered,
      serviceLevel: pr.serviceLevel,
      capacity: inputs.capacity,
      capacityShortfallPerOrder: pr.capacityShortfallPerOrder,
      expiring: {
        quantity: batches.reduce((s, b) => s + b.quantity, 0),
        earliestDate: batches.map((b) => b.expiryDate).sort()[0] || null,
        batches: batches.map((b) => ({ quantity: b.quantity, expiryDate: b.expiryDate, daysToExpiry: b.daysToExpiry })),
      },
      alternatives: Object.fromEntries(POLICIES.filter((p) => p !== policy || fineTune).map((p) => {
        const o = sim.policies[p].products[id];
        return [p, {
          replenish: o.initialOrder,
          target: o.target,
          shortageRisk: o.shortageProbability,
          expectedUnmet: o.expectedUnmet,
          expectedWaste: o.expectedWaste,
          expectedEnding: o.expectedEnding,
        }];
      })),
    };
    r.riskReasons = riskReasons(r, inputs, pr, sim.config, policy);
    r.urgency = urgencyOf(r);
    products[id] = r;
  }

  const ordered = Object.values(products).sort((a, b) => URGENCY[a.urgency].rank - URGENCY[b.urgency].rank
    || catalog.PRIORITIES[a.priority].rank - catalog.PRIORITIES[b.priority].rank
    || b.shortageRisk - a.shortageRisk
    || b.replenish - a.replenish);
  ordered.forEach((r, i) => { r.order = i + 1; });

  const t = chosen.totals;
  const protectedRows = ordered.filter((r) => r.priority !== 'standard');
  const summary = {
    policy,
    totalReplenish: t.initialOrder,
    productsToReplenish: ordered.filter((r) => r.replenish > 0).length,
    expectedUnmet: t.expectedUnmet,
    unmetCvar95: t.unmetCvar95,
    protectedShortageProbability: t.protectedShortageProbability,
    expectedProtectedProductsShort: t.expectedProtectedProductsShort,
    protectedProducts: t.protectedProducts,
    serviceLevel: t.serviceLevel,
    expectedWaste: t.expectedWaste,
    emergencyReserveUnits: protectedRows.reduce((s, r) => s + r.emergencyReserve, 0),
    expiryAlerts: ordered.filter((r) => r.expiring.quantity > 0).length,
    actNow: ordered.filter((r) => r.urgency === 'act_now').length,
    highRisk: ordered.filter((r) => r.riskReasons.length).length,
    warnings: chosen.warnings,
  };

  return {
    selectedPolicy: policy,
    fineTune,
    calculationVersion: sim.calculationVersion,
    inputVersion: sim.inputVersion,
    createdAt: new Date().toISOString(),
    products,
    order: ordered.map((r) => r.productId),
    summary,
    explanations: {},
    finalised: false,
  };
}

module.exports = {
  POLICIES,
  POLICY_LABELS,
  SCENARIOS,
  SCENARIO_FROM_STORED,
  URGENCY,
  scenarioConfig,
  buildSimulationPayload,
  calculationVersion,
  simulationIsCurrent,
  buildRecommendation,
  policyResult,
  riskReasons,
  HIGH_RISK,
  DEFAULT_LEVELS,
};
