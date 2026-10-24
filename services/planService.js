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

function buildSimulationPayload(data) {
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
      unitCost: params.unitCost,
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
      deliverySuccessProbability: g.deliverySuccessProbability,
      quantiles: g.quantiles,
      categoryCapacity: g.categoryCapacity,
    },
    products,
    budget: data.organisation.budget?.amount ? data.organisation.budget : null,
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

function buildRecommendation(data, policy) {
  const sim = data.simulation;
  const horizon = sim.config.planningHorizonDays;
  const chosen = sim.policies[policy];
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
      cost: pr.initialOrderCost,
      capacityShortfallPerOrder: pr.capacityShortfallPerOrder,
      expiring: {
        quantity: batches.reduce((s, b) => s + b.quantity, 0),
        earliestDate: batches.map((b) => b.expiryDate).sort()[0] || null,
        batches: batches.map((b) => ({ quantity: b.quantity, expiryDate: b.expiryDate, daysToExpiry: b.daysToExpiry })),
      },
      alternatives: Object.fromEntries(POLICIES.filter((p) => p !== policy).map((p) => {
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
    cost: t.initialOrderCost,
    costCoverage: t.costCoverage,
    budget: t.budget,
    warnings: chosen.warnings,
  };

  return {
    selectedPolicy: policy,
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
};
