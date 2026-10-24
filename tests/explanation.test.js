const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.NEBIUS_API_KEY = '';
const ex = require('../services/explanationService');

const facts = {
  selectedPolicy: 'Balanced',
  planningHorizonDays: 14,
  simulatedFutures: 1000,
  comparisons: ['Balanced requests 84 units now, higher than Lean (53).'],
  products: [
    { product: 'Infant Formula 800g', priority: 'critical', currentStock: 0, requestNow: 30, chanceOfShortage: '100%', earliestDeliveryDay: 7 },
    { product: 'Lactose Free Milk UHT 1L', priority: 'critical', currentStock: 2, requestNow: 41, chanceOfShortage: '99%' },
    { product: 'Toothpaste', priority: 'essential', currentStock: 69, requestNow: 13, chanceOfShortage: '22%' },
    { product: 'Baked Beans 415g', priority: 'essential', currentStock: 419, requestNow: 0, chanceOfShortage: '25%', expiringSoon: { quantity: 189, earliestBestBefore: '6 November 2026' } },
  ],
};
const allowed = ex.allowedFrom(facts);

test('accepts sentences that only use figures from the results', () => {
  assert.equal(ex.checkSentence('Request 30 tubs of Infant Formula 800g today.', allowed), null);
  assert.equal(ex.checkSentence('Toothpaste has a 22% chance of a shortage across 1,000 simulated futures.', allowed), null);
  assert.equal(ex.checkSentence('Distribute the 189 Baked Beans dated 6 November first.', allowed), null);
  assert.equal(ex.checkSentence('Balanced requests 84 units now, higher than Lean (53).', allowed), null);
  assert.equal(ex.checkSentence('Infant Formula is out of stock and critical.', allowed), null);
});

test('rejects invented numbers, dates and deadlines', () => {
  assert.match(ex.checkSentence('Request 35 tubs of formula.', allowed), /number 35/);
  assert.match(ex.checkSentence('Shortage risk falls to 12%.', allowed), /number 12/);
  assert.match(ex.checkSentence('Order the beans before 9 November.', allowed), /date/);
  assert.match(ex.checkSentence('Place the order by Monday.', allowed), /timing/);
});

test('rejects a real figure attached to the wrong product', () => {
  // 22% belongs to toothpaste, not formula.
  assert.match(ex.checkSentence('Infant Formula 800g has a 22% chance of a shortage.', allowed), /products named/);
});

test('rejects claims that contradict stock or priority', () => {
  assert.match(ex.checkSentence('Lactose Free Milk UHT 1L has no current stock.', allowed), /no stock/);
  assert.match(ex.checkSentence('Keep a reserve of Toothpaste, a critical item.', allowed), /essential product critical/);
});

test('rejects expiry claims for products without dated stock', () => {
  assert.match(ex.checkSentence('Toothpaste is expiring soon.', allowed), /expiring/);
  assert.equal(ex.checkSentence('Baked Beans 415g are expiring soon; distribute 189 first.', allowed), null);
});

test('rejects the wrong unit for a product', () => {
  const f = { ...facts, products: facts.products.map((p, i) => ({ ...p, unit: ['tub', 'carton', 'tube', 'tin'][i] })) };
  const a = ex.allowedFrom(f);
  assert.equal(ex.checkSentence('Request 30 tubs of Infant Formula 800g now.', a), null);
  assert.match(ex.checkSentence('Request 30 tins of Infant Formula 800g now.', a), /uses "tin"/);
});

test('trade-off sentences cannot merge comparisons or claim false equality', () => {
  const f = {
    ...facts,
    comparisons: [
      'Balanced requests 84 units now, higher than Lean (53).',
      'Balanced has expected unmet demand of 405 units, lower than Lean (463).',
      'Balanced has expected waste of 76 units, the same as Lean (76).',
    ],
  };
  const a = ex.allowedFrom(f);
  assert.equal(ex.checkSentence('Balanced requests 84 units now, higher than Lean (53).', a, 'risksAndTradeoffs'), null);
  assert.equal(ex.checkSentence('Waste is the same as Lean at 76 units.', a, 'risksAndTradeoffs'), null);
  assert.match(ex.checkSentence('Balanced requests 84 units, but has the same expected unmet demand of 76 units.', a, 'risksAndTradeoffs'), /mixes figures/);
  assert.match(ex.checkSentence('It does not lower expected unmet demand.', a, 'tradeoffSummary'), /no difference in unmet/);
  assert.match(ex.checkSentence('Request 0 bags of Apples now.', a, 'request'), /nothing to request/);
});

test('templates are built from the facts and pass the same checks', () => {
  const full = {
    ...facts,
    otherPolicies: ['Lean', 'Resilient'],
    orderReviewEveryDays: 7,
    scenario: ['Scenario: Normal operations'],
    warnings: [],
    products: facts.products.map((p, i) => ({ ...p, unit: ['tub', 'carton', 'tube', 'tin'][i], urgency: i < 2 ? 'act_now' : 'normal', orderUpToTarget: p.requestNow + p.currentStock, emergencyReserve: 6, chanceOfRunningOutBeforeFirstDelivery: '100%' })),
    policyTotals: {
      Lean: { requestNowUnits: 53, expectedUnmetUnits: 231, expectedWasteUnits: 96 },
      Balanced: { requestNowUnits: 84, expectedUnmetUnits: 144, expectedWasteUnits: 98 },
      Resilient: { requestNowUnits: 115, expectedUnmetUnits: 110, expectedWasteUnits: 98 },
    },
  };
  const action = ex.templateActionPlan(full);
  const final = ex.templateFinalPlan(full);
  assert.match(action.whatToRequest[0], /request 30 tubs/);
  assert.match(final.distributeFirst[0], /189 tins/);
  const allowedFull = ex.allowedFrom(full);
  for (const s of [...Object.values(action).flat(), ...Object.values(final).flat()]) {
    assert.equal(ex.checkSentence(s, allowedFull), null, s);
  }
});
