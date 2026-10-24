// Turns finished calculations into plain-English plans (Steps 4.5 and 5.4).
//
// Nebius only writes text from a facts object built from stored results.
// Every sentence it returns is checked: a number or date that isn't in the
// facts, or a weekday deadline, gets the sentence removed. Sections that end
// up empty, or any failure, fall back to deterministic templates.

const crypto = require('crypto');
const nebius = require('./nebiusService');
const { POLICY_LABELS, SCENARIOS, policyResult } = require('./planService');

const pct = (p) => (p === null || p === undefined ? null : `${Math.round(p * 100)}%`);
const int = (x) => (x === null || x === undefined ? null : Math.round(x));
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const longDate = (iso) => {
  if (!iso) return null;
  const [y, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
};
const units = (n, unit) => `${n.toLocaleString('en-GB')} ${unit || 'unit'}${n === 1 ? '' : 's'}`;

// --- Facts --------------------------------------------------------------------

function scenarioLines(cfg) {
  const lines = [`Scenario: ${SCENARIOS[cfg.scenarioId]?.label || cfg.scenarioId}`];
  if (cfg.demandIncrease > 0) lines.push(`Demand ${pct(cfg.demandIncrease)} higher than forecast (hypothetical)`);
  if (cfg.applyReserve) lines.push(`Emergency reserve of ${cfg.reserveDays} days of average demand`);
  if (cfg.additionalDeliveryDelayDays > 0) lines.push(`Deliveries ${cfg.additionalDeliveryDelayDays} days late (hypothetical)`);
  if (cfg.deliveryQuantityReduction > 0) lines.push(`Deliveries ${pct(cfg.deliveryQuantityReduction)} smaller than ordered (hypothetical)`);
  return lines;
}

// Deterministic statements comparing the selected policy with the others, so
// the model doesn't have to (and isn't allowed to) make its own comparisons.
// Label for the selected plan, e.g. "Balanced" or "Balanced at 90%".
function selectedLabel(rec) {
  const base = POLICY_LABELS[rec.selectedPolicy];
  return rec.fineTune ? `${base} at ${Math.round(rec.fineTune.level * 100)}%` : base;
}

// The other plans to compare against: the other two policies, plus the
// standard version of the selected one when it has been fine-tuned.
function otherPlans(rec) {
  return Object.keys(POLICY_LABELS)
    .filter((p) => p !== rec.selectedPolicy || rec.fineTune)
    .map((p) => [p, p === rec.selectedPolicy ? `${POLICY_LABELS[p]} (standard)` : POLICY_LABELS[p]]);
}

function comparisons(rec, sim) {
  const measures = [
    ['requests', 'units now', (t) => t.initialOrder, (x) => String(x)],
    ['expected unmet demand of', 'units', (t) => t.expectedUnmet, (x) => String(int(x))],
    ['a chance of any critical or essential shortage of', '', (t) => t.protectedShortageProbability, (x) => pct(x)],
    ['expected waste of', 'units', (t) => t.expectedWaste, (x) => (x === null ? null : String(int(x)))],
    ['expected stock at the end of', 'units', (t) => t.expectedEnding, (x) => String(int(x))],
  ];
  const out = [];
  const me = policyResult(sim, rec.selectedPolicy).totals;
  const mine = selectedLabel(rec);
  for (const [other, label] of otherPlans(rec)) {
    const them = sim.policies[other].totals;
    for (const [what, unit, get, fmt] of measures) {
      const a = fmt(get(me));
      const b = fmt(get(them));
      if (a === null || b === null) continue;
      const relation = a === b ? 'the same as' : get(me) > get(them) ? 'higher than' : 'lower than';
      out.push(`${mine} has ${what} ${a}${unit ? ' ' + unit : ''}, ${relation} ${label} (${b}).`.replace('has requests', 'requests'));
    }
  }
  return out;
}

// "6 November 2026" for day n of the plan.
function dayToDate(asOf, n) {
  return longDate(new Date(Date.parse(asOf + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10));
}

function buildFacts(rec, sim, reviewPeriodDays) {
  const cfg = sim.config;
  const asOf = sim.asOf || new Date().toISOString().slice(0, 10);
  const rows = rec.order.map((id) => rec.products[id]);
  const totals = (t) => {
    return {
      requestNowUnits: t.initialOrder,
      expectedUnmetUnits: int(t.expectedUnmet),
      worst5PercentUnmetUnits: int(t.unmetCvar95),
      chanceAnyEssentialShortage: pct(t.protectedShortageProbability),
      expectedEssentialProductsShort: t.expectedProtectedProductsShort,
      expectedWasteUnits: t.expectedWaste === null ? 'insufficient data' : int(t.expectedWaste),
      expectedStockAtEndUnits: int(t.expectedEnding),
    };
  };
  return {
    selectedPolicy: selectedLabel(rec),
    otherPolicies: otherPlans(rec).map(([, label]) => label),
    planningHorizonDays: cfg.planningHorizonDays,
    orderReviewEveryDays: reviewPeriodDays,
    today: longDate(asOf),
    simulatedFutures: cfg.numberOfRuns,
    scenario: scenarioLines(cfg),
    products: rows.map((r) => ({
      product: r.name,
      unit: r.unit,
      priority: r.priority,
      urgency: r.urgency,
      currentStock: r.currentStock,
      requestNow: r.replenish,
      orderUpToTarget: r.target,
      emergencyReserve: r.emergencyReserve,
      expectedDemandOverHorizon: int(r.expectedDemand),
      chanceOfShortage: pct(r.shortageRisk),
      chanceOfRunningOutBeforeFirstDelivery: pct(r.shortageBeforeFirstDelivery),
      earliestDeliveryDay: r.firstPossibleDeliveryDay,
      typicalDayShortageStarts: r.medianFirstShortageDay,
      expiringSoon: r.expiring.quantity ? { quantity: r.expiring.quantity, earliestBestBefore: longDate(r.expiring.earliestDate) } : null,
      expectedWaste: r.expectedWaste === null ? 'insufficient data' : int(r.expectedWaste),
      whyShortageRiskIsHigh: r.riskReasons?.length ? r.riskReasons : null,
      // Typical order on each order day in the plan (day 0 is firm).
      orderPlan: (r.schedule || []).filter((x) => Math.round(x.mean) > 0).map((x) => ({ day: x.day, date: dayToDate(asOf, x.day), about: Math.round(x.mean) })),
      otherPolicies: Object.fromEntries(Object.entries(r.alternatives).map(([p, a]) => [p === rec.selectedPolicy ? `${POLICY_LABELS[p]} (standard)` : POLICY_LABELS[p], { requestNow: a.replenish, chanceOfShortage: pct(a.shortageRisk) }])),
    })),
    policyTotals: Object.fromEntries([
      [selectedLabel(rec), totals(policyResult(sim, rec.selectedPolicy).totals)],
      ...otherPlans(rec).map(([p, label]) => [label, totals(sim.policies[p].totals)]),
    ]),
    comparisons: comparisons(rec, sim),
    warnings: rec.summary.warnings,
    assumptions: sim.assumptions,
  };
}

// --- Checking AI text against the facts --------------------------------------

const NUMBER_RE = /\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g;
const MONTH_RE = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTHS.join('|')}|${MONTHS.map((m) => m.slice(0, 3)).join('|')})\\b`, 'gi');
const WEEKDAY_RE = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|next week|by the end of)\b/i;
const normNum = (s) => String(Number(String(s).replace(/,/g, '')));

function collect(value, numbers, dates) {
  const walk = (v) => {
    if (v === null || v === undefined) return;
    if (typeof v === 'number') numbers.add(normNum(v));
    else if (typeof v === 'string') {
      for (const m of v.matchAll(NUMBER_RE)) numbers.add(normNum(m[0]));
      for (const m of v.matchAll(MONTH_RE)) dates.add(`${Number(m[1])} ${m[2].slice(0, 3).toLowerCase()}`);
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(value);
}

// Names a sentence might use for a product: the full name, and the name
// without pack sizes or brackets ("Infant Formula", "Apples").
function aliases(name) {
  const base = name.replace(/\([^)]*\)/g, ' ').replace(/\b\d+(?:\.\d+)?\s*(kg|g|ml|l)\b/gi, ' ').replace(/\s+/g, ' ').trim();
  return [...new Set([name, base].filter((x) => x.length >= 3).map((x) => x.toLowerCase()))];
}

function allowedFrom(facts) {
  const numbers = new Set();
  const dates = new Set();
  collect(facts, numbers, dates);

  // Numbers that don't belong to any one product (totals, settings, comparisons).
  const globalNumbers = new Set();
  collect({ ...facts, products: [] }, globalNumbers, new Set());
  const products = (facts.products || []).map((p) => {
    const own = new Set(globalNumbers);
    collect(p, own, new Set());
    return { names: aliases(p.product || ''), numbers: own, stock: p.currentStock, priority: p.priority, unit: (p.unit || '').toLowerCase(), expiring: Boolean(p.expiringSoon) };
  });
  const units = new Set(products.map((p) => p.unit).filter(Boolean));
  // For trade-off sentences: the numbers of each comparison statement, and
  // which measures have at least one policy with the same value.
  const comparisonSets = (facts.comparisons || []).map((c) => new Set([...c.matchAll(NUMBER_RE)].map((m) => normNum(m[0]))));
  const sameMeasures = new Set();
  for (const c of facts.comparisons || []) {
    if (!c.includes('the same as')) continue;
    for (const [measure, re] of MEASURES) if (re.test(c)) sameMeasures.add(measure);
  }
  return { numbers, dates, products, units, comparisonSets, sameMeasures };
}

const MEASURES = [
  ['request', /\brequest|\border/i],
  ['unmet', /\bunmet\b/i],
  ['shortage', /\bshortage/i],
  ['waste', /\bwaste\b/i],
  ['ending', /\bstock at the end|\bending stock|\bleft at the end/i],
];
const SAME_RE = /\b(same|similar|unchanged|identical|no different|(does not|doesn't|do not|don't|without) (lower|reduce|increase|change|improve|cut))\b/i;
const TRADEOFF_SECTIONS = new Set(['risksAndTradeoffs', 'tradeoffSummary']);

function checkTradeoff(text, allowed) {
  const nums = [...text.replace(MONTH_RE, '').matchAll(NUMBER_RE)].map((m) => normNum(m[0]));
  if (nums.length && allowed.comparisonSets?.length && !allowed.comparisonSets.some((set) => nums.every((n) => set.has(n)))) {
    return 'mixes figures from different comparisons';
  }
  if (SAME_RE.test(text)) {
    for (const [measure, re] of MEASURES) {
      if (re.test(text) && !allowed.sameMeasures?.has(measure)) return `claims no difference in ${measure} where the results differ`;
    }
  }
  return null;
}

const EXPIRY_RE = /\bexpir|\bbest[- ]before|\bout of date|\bgoing off\b/i;
const NO_STOCK_RE = /\b(no|zero|without)\s+(current\s+)?stock\b|\bout of stock\b|\bnone (left|in stock)\b/i;
const PRIORITY_WORDS = ['critical', 'essential', 'standard'];

function checkSentence(text, allowed, section = null) {
  if (typeof text !== 'string' || !text.trim()) return 'empty';
  if (WEEKDAY_RE.test(text)) return 'invented timing';
  if (/\brequest(ing)? 0\b/i.test(text)) return 'nothing to request';
  if (TRADEOFF_SECTIONS.has(section)) {
    const problem = checkTradeoff(text, allowed);
    if (problem) return problem;
  }
  for (const m of text.matchAll(MONTH_RE)) {
    if (!allowed.dates.has(`${Number(m[1])} ${m[2].slice(0, 3).toLowerCase()}`)) return `date "${m[0]}" not in results`;
  }

  const lower = text.toLowerCase();
  const mentioned = (allowed.products || []).filter((p) => p.names.some((n) => lower.includes(n)));
  const pool = mentioned.length ? new Set(mentioned.flatMap((p) => [...p.numbers])) : allowed.numbers;
  const withoutDates = text.replace(MONTH_RE, '').replace(/\b(19|20)\d{2}\b/g, '');
  for (const m of withoutDates.matchAll(NUMBER_RE)) {
    if (!pool.has(normNum(m[0]))) return `number ${m[0]} not in results${mentioned.length ? ' for the products named' : ''}`;
  }

  if (NO_STOCK_RE.test(text) && mentioned.some((p) => p.stock > 0)) return 'says a product has no stock when it does';
  if (EXPIRY_RE.test(text) && mentioned.length && !mentioned.some((p) => p.expiring)) return 'says a product is expiring when no dated stock reaches its date';
  // A sentence about one product must use that product's priority and unit.
  if (mentioned.length === 1) {
    const p = mentioned[0];
    const wrong = PRIORITY_WORDS.filter((w) => w !== p.priority && new RegExp(`\\b${w}\\b`).test(lower));
    if (wrong.length && !lower.includes(p.priority)) return `calls a ${p.priority} product ${wrong[0]}`;
    const nameText = p.names.join(' ');
    const otherUnit = [...(allowed.units || [])].find((u) => u !== p.unit && new RegExp(`\\b${u}s?\\b`).test(lower) && !new RegExp(`\\b${u}s?\\b`).test(nameText));
    if (otherUnit) return `uses "${otherUnit}" for a product counted in ${p.unit}s`;
  }
  return null;
}

function cleanSections(answer, keys, allowed) {
  const sections = {};
  const removed = [];
  for (const key of keys) {
    const items = Array.isArray(answer?.[key]) ? answer[key] : typeof answer?.[key] === 'string' ? [answer[key]] : [];
    sections[key] = [];
    for (const item of items.slice(0, 8)) {
      const text = typeof item === 'string' ? item.trim().slice(0, 400) : '';
      const problem = checkSentence(text, allowed, key);
      if (problem) removed.push({ section: key, text: text.slice(0, 160), reason: problem });
      else sections[key].push(text);
    }
  }
  return { sections, removed };
}

// --- Templates (no AI) --------------------------------------------------------

// One sentence per future order date, from the order plan.
function orderDates(rows) {
  const byDate = new Map();
  for (const r of rows) {
    for (const o of r.orderPlan || []) {
      if (o.day === 0) continue;
      if (!byDate.has(o.date)) byDate.set(o.date, { day: o.day, items: [] });
      byDate.get(o.date).items.push(`about ${o.about} ${r.unit || 'unit'}s of ${r.product}`);
    }
  }
  return [...byDate.entries()].sort((a, b) => a[1].day - b[1].day).slice(0, 4)
    .map(([date, x]) => `On ${date}, expect to order ${x.items.slice(0, 4).join(', ')}${x.items.length > 4 ? ' and others' : ''}.`);
}

function templateActionPlan(facts) {
  const rows = facts.products;
  const requests = rows.filter((r) => r.requestNow > 0);
  const urgent = rows.filter((r) => r.urgency === 'act_now' || r.urgency === 'high');
  const expiring = rows.filter((r) => r.expiringSoon);
  const t = facts.policyTotals[facts.selectedPolicy];
  const others = facts.otherPolicies.map((p) => `${p} would request ${facts.policyTotals[p].requestNowUnits} units now with ${facts.policyTotals[p].expectedUnmetUnits} units of expected unmet demand`);
  return {
    whatToRequest: requests.length
      ? requests.map((r) => `${r.product}: request ${units(r.requestNow, r.unit)} (order-up-to target ${r.orderUpToTarget}).`)
      : ['No replenishment is needed now under this policy: stock and expected deliveries already reach every target.'],
    whenToAct: [
      `Place today's request now. It arrives on day ${Math.min(...rows.map((r) => r.earliestDeliveryDay))} at the earliest.`,
      ...orderDates(rows),
      ...rows.filter((r) => r.urgency === 'act_now').map((r) => `${r.product} has a ${r.chanceOfRunningOutBeforeFirstDelivery} chance of running out before any delivery can arrive. Look for stock you can get sooner.`),
    ],
    immediatePriorities: [
      ...urgent.map((r) => `${r.product} (${r.priority}): ${r.chanceOfShortage} chance of a shortage over the ${facts.planningHorizonDays} days.${r.whyShortageRiskIsHigh ? ' ' + r.whyShortageRiskIsHigh[0] : ''}`),
      ...expiring.map((r) => `${r.product}: ${units(r.expiringSoon.quantity, r.unit)} reach their best-before date by ${r.expiringSoon.earliestBestBefore}. Distribute these first.`),
    ].slice(0, 8),
    risksAndTradeoffs: [
      `${facts.selectedPolicy} requests ${t.requestNowUnits} units now, with ${t.expectedUnmetUnits} units of expected unmet demand and ${t.expectedWasteUnits} units of expected waste.`,
      ...(facts.comparisons?.length ? facts.comparisons.filter((c) => /unmet|shortage/.test(c)) : others.map((s) => `${s}.`)),
    ].slice(0, 6),
    contingency: [
      ...facts.scenario.slice(1).map((s) => `If this happens (${s.toLowerCase()}), check the critical items first and re-run the comparison with updated stock counts.`),
      'Re-count critical and essential items before the next order review and update the plan if stock differs.',
    ].slice(0, 4),
    tradeoffSummary: [
      `${facts.selectedPolicy} is one option, not a universally best choice. Across ${facts.simulatedFutures.toLocaleString('en-GB')} simulated futures it requests ${t.requestNowUnits} units now and gives ${t.expectedUnmetUnits} units of expected unmet demand; ${others.join(', and ')}.`,
    ],
  };
}

function templateFinalPlan(facts) {
  const rows = facts.products;
  return {
    request: rows.filter((r) => r.requestNow > 0).map((r) => `${r.product}: ${units(r.requestNow, r.unit)}.`).concat(rows.some((r) => r.requestNow > 0) ? [] : ['Nothing to request now.']),
    prioritise: rows.filter((r) => r.priority !== 'standard' && (r.urgency === 'act_now' || r.urgency === 'high'))
      .map((r) => `${r.product} (${r.priority}): ${r.chanceOfShortage} chance of a shortage.${r.whyShortageRiskIsHigh ? ' ' + r.whyShortageRiskIsHigh[0] : ''}`)
      .concat(rows.some((r) => r.urgency === 'act_now' || r.urgency === 'high') ? [] : ['No critical or essential item has a high shortage risk under this plan.']),
    distributeFirst: rows.filter((r) => r.expiringSoon).map((r) => `${r.product}: ${units(r.expiringSoon.quantity, r.unit)} with best-before by ${r.expiringSoon.earliestBestBefore}.`)
      .concat(rows.some((r) => r.expiringSoon) ? [] : ['No current stock reaches its best-before date within the horizon.']),
    maintain: rows.filter((r) => r.priority !== 'standard' && r.emergencyReserve > 0).map((r) => `${r.product}: keep about ${units(r.emergencyReserve, r.unit)} above expected use as a buffer.`).slice(0, 8),
    monitor: [
      ...facts.scenario.slice(1),
      ...facts.warnings,
      'Demand figures are inferred from stock counts, so compare them with actual distribution and update the counts before the next review.',
    ].slice(0, 6),
  };
}

// --- Generation ---------------------------------------------------------------

const ACTION_KEYS = ['whatToRequest', 'whenToAct', 'immediatePriorities', 'risksAndTradeoffs', 'contingency', 'tradeoffSummary'];
const FINAL_KEYS = ['request', 'prioritise', 'distributeFirst', 'maintain', 'monitor'];

const SYSTEM = `You write short, plain action plans for UK food bank managers in British English.
You are given finished calculations as JSON facts. Use only those facts.
Never calculate, add up, round differently, estimate or introduce any number, percentage or date that is not in the facts.
Never give deadlines, weekdays or dates that are not in the facts. "Today" is allowed for the request.
Never name suppliers, prices or actions the facts don't support. Probabilities are estimates from simulation; say so where useful.
Do not call the selected policy the best or optimal; describe its trade-offs.
To compare policies, use only the statements in "comparisons", keeping their numbers and wording of higher, lower or the same.
When you give a figure for a product, write about one product per sentence and use that product's own figures and priority word.
Each item is one sentence of at most 35 words. Reply with one JSON object only.`;

const ACTION_TASK = {
  whatToRequest: 'Products to request now, with the exact requestNow quantities and units. Skip products with requestNow 0.',
  whenToAct: 'The order plan for at least the next 14 days: for each order date in orderPlan, which products to order and about how much. Use the dates and amounts exactly as given; say "about" for later amounts.',
  immediatePriorities: 'Critical and essential shortage risks and items expiring soon. For any high chance of shortage, give the reason from whyShortageRiskIsHigh.',
  risksAndTradeoffs: 'How the selected policy differs from the other two, using policyTotals.',
  contingency: 'What to consider if the scenario conditions happen. Only actions supported by the facts.',
  tradeoffSummary: 'Exactly one item: two or three sentences on the main trade-offs of the selected policy.',
};

const FINAL_TASK = {
  request: 'Exact products and requestNow quantities. Skip products with requestNow 0.',
  prioritise: 'Critical shortages and essential items to protect first, with the reason from whyShortageRiskIsHigh where given.',
  distributeFirst: 'Stock approaching its best-before date (expiringSoon).',
  maintain: 'Emergency reserves (emergencyReserve) for critical and essential items.',
  monitor: 'Important assumptions and disruption risks to watch.',
};

function factsHash(facts) {
  return crypto.createHash('sha256').update(JSON.stringify(facts)).digest('hex').slice(0, 16);
}

async function generate(kind, facts) {
  const keys = kind === 'action' ? ACTION_KEYS : FINAL_KEYS;
  const template = kind === 'action' ? templateActionPlan(facts) : templateFinalPlan(facts);
  const base = { kind, factsHash: factsHash(facts), generatedAt: new Date().toISOString() };

  if (!nebius.isConfigured()) {
    return { ...base, source: 'template', model: null, sections: template, removed: [], note: 'Nebius is not configured; template text was used.' };
  }

  try {
    const { content, model } = await nebius.chat({
      tier: 'efficient',
      system: SYSTEM,
      user: { task: kind === 'action' ? ACTION_TASK : FINAL_TASK, responseFormat: Object.fromEntries(keys.map((k) => [k, ['sentence']])), facts },
      json: true,
      temperature: 0.2,
      maxTokens: 2500,
    });
    const allowed = allowedFrom(facts);
    const { sections, removed } = cleanSections(content, keys, allowed);
    let templated = 0;
    for (const key of keys) {
      if (!sections[key].length && template[key]?.length) {
        sections[key] = template[key];
        templated++;
      }
    }
    return {
      ...base,
      source: templated === keys.length ? 'template' : 'nebius',
      model,
      sections,
      removed,
      templatedSections: templated,
      note: removed.length ? `${removed.length} AI sentence(s) were removed because they contained numbers or dates not in the results.` : null,
    };
  } catch (err) {
    return { ...base, source: 'template', model: null, sections: template, removed: [], note: `Nebius was unavailable (${err.message}); template text was used.` };
  }
}

// Write (or reuse) the action plan for the stored recommendation and attach
// it, only if the recommendation is still the one it was written for.
async function attachActionPlan(store, stored) {
  const rec = stored.recommendations;
  const facts = buildFacts(rec, stored.simulation, stored.parameters.global.reviewPeriodDays);
  const key = rec.fineTune ? `${rec.selectedPolicy}@${rec.fineTune.level}` : rec.selectedPolicy;
  const cached = stored.simulation.explanationCache?.[key];
  const actionPlan = cached?.factsHash === factsHash(facts) ? cached : await generate('action', facts);

  await store.mutate((d) => {
    if (d.simulation.calculationVersion !== rec.calculationVersion) return;
    d.simulation.explanationCache = { ...(d.simulation.explanationCache || {}), [key]: actionPlan };
    const same = d.recommendations.calculationVersion === rec.calculationVersion && d.recommendations.selectedPolicy === rec.selectedPolicy
      && JSON.stringify(d.recommendations.fineTune ?? null) === JSON.stringify(rec.fineTune ?? null);
    if (same) d.recommendations.explanations = { actionPlan };
  });
}

module.exports = { attachActionPlan, buildFacts, factsHash, generate, checkSentence, allowedFrom, templateActionPlan, templateFinalPlan, ACTION_KEYS, FINAL_KEYS };
