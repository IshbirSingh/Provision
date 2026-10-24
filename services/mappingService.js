// Step 1: turns a parsed spreadsheet into staged stock records.
//
// Nebius (advanced model) maps columns and groups product-name variants into
// categories. Every AI answer is checked against the file before use, and
// header/keyword rules take over when Nebius is unavailable or answers badly.
// Dates, quantities and expiry dates are always parsed deterministically.

const crypto = require('crypto');
const nebius = require('./nebiusService');
const catalog = require('./catalog');
const validation = require('./validationService');

const FIELDS = ['date', 'product', 'category', 'quantity', 'unit', 'expiry', 'notes', 'ignore'];
const REQUIRED = ['date', 'product', 'quantity'];
const SAMPLE_ROWS = 15;
const MAX_NAMES = 300;
const PROMPT_VERSION = 'map-v1';

// Header rules, checked in order so "Expiry date" is not taken as the date.
const HEADER_RULES = [
  ['expiry', /best.?before|\bbbe?\b|expir|use.?by|\bexp\b|\bbb\b/i],
  ['date', /date|counted|week|\bday\b|when|period/i],
  ['quantity', /qty|quantity|count|amount|on.?hand|level|stock|number|total/i],
  ['product', /item|product|description|name|food|line/i],
  ['category', /categor|type|group|class|section/i],
  ['unit', /\bunit|uom|measure|pack/i],
  ['notes', /note|comment|remark|reason/i],
];

function mapColumnsByRules(headers) {
  const mapping = Object.fromEntries(headers.map((h) => [h, 'ignore']));
  const taken = new Set();
  for (const [field, re] of HEADER_RULES) {
    const header = headers.find((h) => mapping[h] === 'ignore' && re.test(h));
    if (header && !taken.has(field)) {
      mapping[header] = field;
      taken.add(field);
    }
  }
  return mapping;
}

function checkMapping(mapping, headers) {
  const errors = [];
  if (!mapping || typeof mapping !== 'object') return ['No column mapping'];
  for (const h of headers) {
    if (!FIELDS.includes(mapping[h])) errors.push(`Column "${h}" has no valid field`);
  }
  for (const field of FIELDS.filter((f) => f !== 'ignore')) {
    const n = headers.filter((h) => mapping[h] === field).length;
    if (n > 1) errors.push(`More than one column is mapped to ${field}`);
    if (n === 0 && REQUIRED.includes(field)) errors.push(`No column for ${field}`);
  }
  return errors;
}

// --- Product grouping ---------------------------------------------------------

const normaliseName = (s) => String(s || '').toLowerCase().replace(/[()[\]_\-,.;:/]+/g, ' ').replace(/\s+/g, ' ').trim();
const withoutSizes = (s) => normaliseName(s).replace(/\b\d+(?:\.\d+)?\s*(kg|g|ml|l|ltr|litres?|x\d+)?\b/g, ' ').split(' ').filter(Boolean).sort().join(' ');

function slug(name, used) {
  const base = normaliseName(name).replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'product';
  let id = base;
  for (let n = 2; used.has(id); n++) id = `${base}_${n}`;
  used.add(id);
  return id;
}

function nameStats(rows, mapping) {
  const col = (field) => Object.keys(mapping).find((h) => mapping[h] === field);
  const productCol = col('product');
  const categoryCol = col('category');
  const unitCol = col('unit');
  const stats = new Map();
  for (const row of rows) {
    const name = String(row[productCol] || '').trim();
    if (!name) continue;
    const s = stats.get(name) || { name, rows: 0, categories: new Map(), units: new Map() };
    s.rows++;
    const cat = categoryCol ? String(row[categoryCol] || '').trim() : '';
    if (cat) s.categories.set(cat, (s.categories.get(cat) || 0) + 1);
    const unit = unitCol ? String(row[unitCol] || '').trim() : '';
    if (unit) s.units.set(unit, (s.units.get(unit) || 0) + 1);
    stats.set(name, s);
  }
  return [...stats.values()];
}

const mostCommon = (map) => [...map.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

function categoryFromFile(group) {
  const counts = new Map();
  for (const s of group) for (const [c, n] of s.categories) counts.set(c, (counts.get(c) || 0) + n);
  return catalog.categoryFromLabel(mostCommon(counts));
}

// Rule-based grouping: identical after normalisation, then size-less names
// that match exactly one sized product ("Beans - baked" -> "Baked Beans 415g").
function groupByRules(stats) {
  const groups = new Map();
  for (const s of stats) {
    const key = normaliseName(s.name);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  const keys = [...groups.keys()];
  const merges = [];
  for (const key of keys) {
    if (/\d/.test(key)) continue;
    const loose = withoutSizes(key);
    const targets = keys.filter((k) => k !== key && /\d/.test(k) && withoutSizes(k) === loose);
    if (targets.length === 1) merges.push([key, targets[0]]);
  }
  const merged = new Map();
  for (const [from, to] of merges) {
    groups.get(to).push(...groups.get(from).map((s) => ({ ...s, merged: true })));
    groups.delete(from);
    merged.set(from, to);
  }

  return [...groups.values()].map((group) => {
    const canonical = group.filter((s) => !s.merged).sort((a, b) => b.rows - a.rows)[0] || group[0];
    const units = new Map();
    for (const s of group) for (const [u, n] of s.units) units.set(u, (units.get(u) || 0) + n);
    const category = categoryFromFile(group) || catalog.categoriseByName(canonical.name);
    return {
      name: canonical.name,
      rawNames: group.map((s) => s.name),
      mergedNames: group.filter((s) => s.merged).map((s) => s.name),
      category,
      unit: mostCommon(units),
      ...catalog.packSizeFromName(canonical.name),
      source: 'rules',
      confidence: null,
    };
  });
}

// --- Nebius ---------------------------------------------------------------------

const SYSTEM_PROMPT = `You interpret food bank stock-count spreadsheets for Provision.
You only classify and group. You never calculate, estimate, total or fill in missing values.
Reply with a single JSON object and nothing else.`;

function buildPrompt(headers, sampleRows, stats) {
  return {
    task: 'Map spreadsheet columns to fields and group product names into products.',
    fields: {
      date: 'date the stock was counted',
      product: 'product or item name',
      category: 'product category written in the sheet',
      quantity: 'stock count / quantity on hand',
      unit: 'unit of the count (tin, bag, kg...)',
      expiry: 'best-before or use-by date',
      notes: 'free-text notes',
      ignore: 'anything else',
    },
    categories: Object.entries(catalog.CATEGORIES).map(([id, c]) => ({ id, label: c.label, examples: c.examples })),
    headers,
    sampleRows,
    productNames: stats.slice(0, MAX_NAMES).map((s) => ({
      name: s.name,
      rows: s.rows,
      categoryValues: [...s.categories.keys()].slice(0, 3),
      units: [...s.units.keys()].slice(0, 3),
    })),
    rules: [
      'Map every header to exactly one field. Use each field other than "ignore" at most once.',
      'Group names only when they clearly mean the same product, e.g. different capitalisation, punctuation or word order. Never merge different products (for example pasta and gluten-free pasta, or 500g and 1kg packs).',
      'Every product name must appear in exactly one group, spelled exactly as given.',
      'Use the category written in the sheet when there is one. Otherwise choose the closest category id; use "other" if none fits.',
      'Only give packSize and packSizeUnit when the size is written in a product name. Otherwise use null.',
      'confidence is "high", "medium" or "low" for each group.',
    ],
    responseFormat: {
      columns: { '<header>': '<field>' },
      products: [{ canonicalName: 'string', rawNames: ['string'], category: '<category id>', unit: 'string or null', packSize: 'number or null', packSizeUnit: 'g|kg|ml|L or null', confidence: 'high|medium|low' }],
      issues: ['short notes about anything ambiguous'],
    },
  };
}

// Check the AI's product groups against the real names. Returns the usable
// groups plus the names it failed to cover.
function checkProducts(aiProducts, stats) {
  const names = new Map(stats.map((s) => [s.name, s]));
  const assigned = new Set();
  const groups = [];
  const problems = [];
  if (!Array.isArray(aiProducts)) return { groups, uncovered: [...names.keys()], problems: ['No product list'] };

  for (const p of aiProducts) {
    const rawNames = (Array.isArray(p?.rawNames) ? p.rawNames : []).filter((n) => names.has(n) && !assigned.has(n));
    if (!rawNames.length) continue;
    rawNames.forEach((n) => assigned.add(n));
    const group = rawNames.map((n) => names.get(n));
    const category = categoryFromFile(group) || (catalog.CATEGORIES[p.category] ? p.category : catalog.categoriseByName(rawNames[0]));

    // Pack size must be visible in a name; otherwise drop it.
    let packSize = Number.isFinite(p.packSize) && p.packSize > 0 ? p.packSize : null;
    let packSizeUnit = packSize && ['g', 'kg', 'ml', 'L', 'l'].includes(p.packSizeUnit) ? (p.packSizeUnit === 'l' ? 'L' : p.packSizeUnit) : null;
    if (packSize && !rawNames.some((n) => n.includes(String(packSize)))) {
      problems.push(`Pack size ${packSize} for "${p.canonicalName}" is not in its name and was dropped`);
      packSize = null;
      packSizeUnit = null;
    }
    if (!packSizeUnit) packSize = null;

    const units = new Map();
    for (const s of group) for (const [u, n] of s.units) units.set(u, (units.get(u) || 0) + n);
    const canonicalName = typeof p.canonicalName === 'string' && p.canonicalName.trim() ? p.canonicalName.trim().slice(0, 80) : rawNames[0];
    // Only names that differ beyond case and punctuation count as merges.
    const primary = normaliseName([...group].sort((a, b) => b.rows - a.rows)[0].name);
    groups.push({
      name: canonicalName,
      rawNames,
      mergedNames: rawNames.filter((n) => normaliseName(n) !== primary),
      category,
      unit: mostCommon(units) || (typeof p.unit === 'string' ? p.unit.slice(0, 20) : null),
      packSize,
      packSizeUnit,
      source: 'nebius',
      confidence: ['high', 'medium', 'low'].includes(p.confidence) ? p.confidence : null,
    });
  }
  const uncovered = [...names.keys()].filter((n) => !assigned.has(n));
  return { groups, uncovered, problems };
}

async function askNebius(headers, rows, stats, cache) {
  const sampleRows = rows.slice(0, SAMPLE_ROWS);
  const prompt = buildPrompt(headers, sampleRows, stats);
  const key = crypto.createHash('sha256').update(PROMPT_VERSION + JSON.stringify(prompt)).digest('hex');
  if (cache?.[key]) return { ...cache[key], cacheKey: key, cached: true };

  const { content, model } = await nebius.chat({
    tier: 'advanced',
    system: SYSTEM_PROMPT,
    user: prompt,
    json: true,
    temperature: 0,
    maxTokens: 6000,
  });
  return { answer: content, model, cacheKey: key, cached: false };
}

// --- Main entry -------------------------------------------------------------

const pad = (n, w) => String(n).padStart(w, '0');

async function interpretUpload(parsed, { filename, fileHash, cache = {}, columnOverride = null } = {}) {
  const { headers, rows } = parsed;
  const warnings = [];
  let method = 'rules';
  let model = null;
  let aiAnswer = null;
  let cacheEntry = null;

  // 1. Columns
  let mapping = columnOverride;
  if (mapping) {
    const errors = checkMapping(mapping, headers);
    if (errors.length) throw Object.assign(new Error(errors.join('. ')), { status: 422, expose: true });
  } else {
    if (nebius.isConfigured()) {
      try {
        const res = await askNebius(headers, rows, nameStats(rows, mapColumnsByRules(headers)), cache);
        aiAnswer = res.answer;
        model = res.model;
        if (!res.cached) cacheEntry = { key: res.cacheKey, value: { answer: res.answer, model: res.model } };
        const errors = checkMapping(aiAnswer?.columns, headers);
        if (errors.length) {
          warnings.push({ level: 'warning', message: `Nebius's column mapping was not usable (${errors[0]}), so header matching was used.` });
        } else {
          mapping = aiAnswer.columns;
          method = 'nebius';
        }
      } catch (err) {
        warnings.push({ level: 'warning', message: `Nebius could not interpret the file (${err.message}). Header matching and keyword rules were used instead.` });
      }
    } else {
      warnings.push({ level: 'info', message: 'Nebius is not configured. Header matching and keyword rules were used.' });
    }
    if (!mapping) mapping = mapColumnsByRules(headers);
  }

  const mappingErrors = checkMapping(mapping, headers);
  if (mappingErrors.length) {
    warnings.push({ level: 'warning', message: `Some columns could not be identified: ${mappingErrors.join('; ')}. Set them under "Columns" below.` });
  }

  const col = (field) => Object.keys(mapping).find((h) => mapping[h] === field) || null;
  const rawFields = Object.fromEntries(['date', 'product', 'category', 'quantity', 'unit', 'expiry', 'notes'].map((f) => [f, col(f)]));

  // 2. Products (AI groups are only reused if the product column is the same)
  const stats = rawFields.product ? nameStats(rows, mapping) : [];
  let groups = [];
  if (method === 'nebius' && aiAnswer) {
    const checked = checkProducts(aiAnswer.products, stats);
    groups = checked.groups;
    for (const p of checked.problems) warnings.push({ level: 'info', message: p });
    if (checked.uncovered.length) {
      groups.push(...groupByRules(stats.filter((s) => checked.uncovered.includes(s.name))));
      warnings.push({ level: 'warning', message: `${checked.uncovered.length} product name(s) were not grouped by Nebius and were grouped by rules: ${checked.uncovered.slice(0, 5).join(', ')}${checked.uncovered.length > 5 ? '…' : ''}` });
    }
    for (const note of (Array.isArray(aiAnswer.issues) ? aiAnswer.issues : []).slice(0, 8)) {
      if (typeof note === 'string' && note.trim()) warnings.push({ level: 'info', message: `Nebius: ${note.trim().slice(0, 300)}` });
    }
  } else {
    groups = groupByRules(stats);
  }

  const used = new Set();
  const products = {};
  const nameToProduct = new Map();
  const mergedNames = new Set();
  for (const g of groups) {
    const id = slug(g.name, used);
    products[id] = {
      name: g.name,
      category: g.category,
      unit: g.unit,
      packSize: g.packSize,
      packSizeUnit: g.packSizeUnit,
      priority: catalog.defaultPriority(g.category),
      rawNames: g.rawNames,
      source: g.source,
      confidence: g.confidence,
    };
    g.rawNames.forEach((n) => nameToProduct.set(n, id));
    g.mergedNames.forEach((n) => mergedNames.add(n));
  }

  // 3. Rows (deterministic)
  const dateInfo = validation.detectDateFormat(rows.map((r) => r[rawFields.date]));
  const expiryInfo = validation.detectDateFormat(rows.map((r) => r[rawFields.expiry]).filter(Boolean));
  const expiryFormat = expiryInfo.ambiguous ? dateInfo.format : expiryInfo.format;
  if (rawFields.date && dateInfo.ambiguous) {
    warnings.push({
      level: 'warning',
      message: dateInfo.conflicting
        ? 'Dates are written in mixed day/month orders. They were read as day/month/year (UK). Check the dates below.'
        : 'Every date could be either day/month or month/day. They were read as day/month/year (UK).',
    });
  }

  const records = {};
  rows.forEach((row, i) => {
    const productName = rawFields.product ? String(row[rawFields.product] || '').trim() : '';
    const q = validation.parseQuantity(rawFields.quantity ? row[rawFields.quantity] : '');
    const notes = rawFields.notes ? String(row[rawFields.notes] || '').trim() || null : null;
    records[`row_${pad(i + 1, 5)}`] = {
      rowNumber: i + 2, // spreadsheet row, after the header
      raw: row,
      rawFields,
      date: validation.parseDate(rawFields.date ? row[rawFields.date] : '', dateInfo.format),
      productId: nameToProduct.get(productName) || null,
      productName,
      mergedFrom: mergedNames.has(productName) ? productName : null,
      quantity: q.quantity,
      approximate: q.approximate,
      unit: rawFields.unit ? String(row[rawFields.unit] || '').trim() || null : null,
      expiryDate: rawFields.expiry ? validation.parseDate(row[rawFields.expiry], expiryFormat) : null,
      notes,
      movementHint: validation.movementHint(notes),
      include: true,
    };
  });

  const expiryType = rawFields.expiry && /use.?by/i.test(rawFields.expiry) ? 'use_by' : 'best_before';

  return {
    staging: {
      sourceFile: filename || null,
      fileHash: fileHash || null,
      format: parsed.format || null,
      sheetName: parsed.sheetName || null,
      extractedAt: new Date().toISOString(),
      method,
      model,
      headers,
      columnMapping: mapping,
      dateFormat: dateInfo.format,
      expiryType,
      products,
      records,
      warnings: Object.fromEntries(warnings.map((w, i) => [`w_${pad(i + 1, 2)}`, w])),
    },
    cacheEntry,
  };
}

// Manual entry starts from an empty staging area.
function emptyStaging() {
  return {
    sourceFile: null,
    fileHash: null,
    format: 'manual',
    sheetName: null,
    extractedAt: new Date().toISOString(),
    method: 'manual',
    model: null,
    headers: [],
    columnMapping: {},
    dateFormat: 'ISO',
    expiryType: 'best_before',
    products: {},
    records: {},
    warnings: {},
  };
}

function newProduct(products, { name, category, unit }) {
  const used = new Set(Object.keys(products));
  const id = slug(name, used);
  const cat = catalog.CATEGORIES[category] ? category : catalog.categoriseByName(name);
  products[id] = {
    name: String(name).trim().slice(0, 80),
    category: cat,
    unit: unit ? String(unit).trim().slice(0, 20) : null,
    ...catalog.packSizeFromName(name),
    priority: catalog.defaultPriority(cat),
    rawNames: [],
    source: 'manual',
    confidence: null,
  };
  return id;
}

module.exports = { FIELDS, REQUIRED, interpretUpload, emptyStaging, newProduct, mapColumnsByRules, checkMapping, groupByRules, nameStats };
