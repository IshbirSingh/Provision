// Deterministic parsing and validation of stock records (Step 1).
// Nothing here guesses a missing value: unreadable or missing fields leave
// the row out and say why.

// --- Parsing ----------------------------------------------------------------

const ISO_RE = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s].*)?$/;
const SLASH_RE = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/;
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const TEXT_RE = /^(\d{1,2})(?:st|nd|rd|th)?[\s-]+([a-z]{3,9})\.?[\s-,]+(\d{2}|\d{4})$/i;

function isoFrom(y, m, d) {
  const year = y < 100 ? 2000 + y : y;
  const dt = new Date(Date.UTC(year, m - 1, d));
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

// Decide whether slash dates are day-first or month-first from the values
// themselves. Ambiguous columns default to UK day-first and say so.
function detectDateFormat(values) {
  let dayFirst = 0;
  let monthFirst = 0;
  let iso = 0;
  for (const v of values) {
    const s = String(v || '').trim();
    if (ISO_RE.test(s)) { iso++; continue; }
    const m = SLASH_RE.exec(s);
    if (!m) continue;
    if (Number(m[1]) > 12) dayFirst++;
    if (Number(m[2]) > 12) monthFirst++;
  }
  if (dayFirst && monthFirst) return { format: 'DMY', ambiguous: true, conflicting: true };
  if (monthFirst) return { format: 'MDY', ambiguous: false };
  if (dayFirst) return { format: 'DMY', ambiguous: false };
  if (iso) return { format: 'ISO', ambiguous: false };
  return { format: 'DMY', ambiguous: true };
}

function parseDate(value, format = 'DMY') {
  const s = String(value ?? '').trim();
  if (!s) return null;
  let m = ISO_RE.exec(s);
  if (m) return isoFrom(Number(m[1]), Number(m[2]), Number(m[3]));
  m = SLASH_RE.exec(s);
  if (m) {
    const [a, b, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
    return format === 'MDY' ? isoFrom(y, a, b) : isoFrom(y, b, a);
  }
  m = TEXT_RE.exec(s);
  if (m) {
    const month = MONTHS[m[2].toLowerCase().slice(0, 4)] || MONTHS[m[2].toLowerCase().slice(0, 3)];
    if (month) return isoFrom(Number(m[3]), month, Number(m[1]));
  }
  return null;
}

// "120", "1,200", "approx 40", "~40", "c. 40", "40?", "40 tins".
function parseQuantity(value) {
  const s = String(value ?? '').trim();
  if (!s) return { quantity: null, approximate: false, readable: true };
  const approximate = /approx|about|around|roughly|circa|\bca?\.|~|\?|est/i.test(s);
  const m = /-?\d[\d,]*(?:\.\d+)?/.exec(s);
  if (!m) return { quantity: null, approximate, readable: false };
  const n = Number(m[0].replace(/,/g, ''));
  if (!Number.isFinite(n)) return { quantity: null, approximate, readable: false };
  return { quantity: n, approximate, readable: true };
}

const MOVEMENT_HINTS = [
  ['transfer', /transfer|moved to|sent to|given to .*(pantry|bank|hub)/i, 'Notes mention a transfer, so a fall in stock here may not be demand.'],
  ['correction', /correct|stock ?take|recount|adjust|miscount/i, 'Notes mention a stock correction, so a change here may not be real movement.'],
  ['waste', /\bbin|binned|waste|spoil|expired|out of date|past date|damaged|thrown|mould/i, 'Notes mention waste, so a fall in stock here may not be demand.'],
  ['donation', /donat|harvest|collection|appeal|food drive/i, null],
  ['delivery', /deliver|fareshare|order|purchase|bought/i, null],
];

function movementHint(notes) {
  const s = String(notes || '');
  for (const [hint, re] of MOVEMENT_HINTS) if (re.test(s)) return hint;
  return null;
}

// --- Validation ---------------------------------------------------------------

const todayIso = () => new Date().toISOString().slice(0, 10);

function issue(level, code, message) {
  return { level, code, message };
}

// Validate one staged record in isolation. Levels: "exclude" (row is left
// out), "warning" (kept, check it) and "info".
function validateRecord(rec, products) {
  const issues = [];
  const raw = rec.raw || {};
  const rawOf = (field) => (rec.rawFields?.[field] ? raw[rec.rawFields[field]] : '');

  if (!rec.date) {
    const r = rawOf('date');
    issues.push(issue('exclude', 'date_missing', r ? `Date "${r}" could not be read.` : 'No date.'));
  } else if (rec.date > todayIso()) {
    issues.push(issue('exclude', 'date_future', `Date ${rec.date} is in the future.`));
  }

  if (!rec.productId || !products[rec.productId]) {
    issues.push(issue('exclude', 'product_missing', 'No product.'));
  }

  if (rec.quantity === null || rec.quantity === undefined) {
    const r = rawOf('quantity');
    issues.push(issue('exclude', 'quantity_missing', r ? `Quantity "${r}" could not be read.` : 'No quantity recorded.'));
  } else if (rec.quantity < 0) {
    issues.push(issue('exclude', 'quantity_negative', 'Quantity is negative.'));
  } else if (!Number.isInteger(rec.quantity)) {
    issues.push(issue('warning', 'quantity_fraction', `Quantity ${rec.quantity} is not a whole number. Counts must be whole units; correct it or it will be rounded down.`));
  }
  if (rec.approximate) {
    issues.push(issue('warning', 'quantity_approximate', `Recorded as "${rawOf('quantity')}". Confirm or correct the count.`));
  }

  if (rec.rawFields?.expiry && rawOf('expiry') && !rec.expiryDate) {
    issues.push(issue('warning', 'expiry_unreadable', `Best-before "${rawOf('expiry')}" could not be read and will be ignored.`));
  }

  const product = products[rec.productId];
  if (product && rec.unit && product.unit && rec.unit.toLowerCase() !== product.unit.toLowerCase()) {
    issues.push(issue('warning', 'unit_mismatch', `Unit "${rec.unit}" differs from this product's usual unit "${product.unit}".`));
  }

  const hint = MOVEMENT_HINTS.find(([h]) => h === rec.movementHint);
  if (hint && hint[2]) issues.push(issue('info', `movement_${hint[0]}`, hint[2]));

  if (rec.mergedFrom) {
    issues.push(issue('info', 'name_merged', `"${rec.mergedFrom}" was treated as ${product ? product.name : 'this product'}.`));
  }
  return issues;
}

// Snapshot totals per product per date (batches on the same date are summed).
function snapshotsByProduct(records) {
  const byProduct = {};
  for (const rec of records) {
    if (!rec.usable) continue;
    const dates = (byProduct[rec.productId] ??= {});
    dates[rec.date] = (dates[rec.date] || 0) + Math.floor(rec.quantity);
  }
  return byProduct;
}

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

// Validate every record, then add the cross-row checks (duplicates and
// unusually large falls). Mutates `staging.records` and returns counts.
function validateStaging(staging) {
  const records = Object.values(staging.records);
  for (const rec of records) {
    rec.issues = validateRecord(rec, staging.products);
    rec.usable = rec.include !== false && !rec.issues.some((i) => i.level === 'exclude');
  }

  const seen = new Map();
  for (const rec of records) {
    if (!rec.usable) continue;
    const key = [rec.productId, rec.date, rec.quantity, rec.expiryDate || '', rec.notes || ''].join('|');
    if (seen.has(key)) {
      rec.issues.push(issue('warning', 'duplicate', `Looks like a duplicate of row ${seen.get(key)}. Untick "Include" if it is.`));
    } else {
      seen.set(key, rec.rowNumber);
    }
  }

  const snapshots = snapshotsByProduct(records);
  const flagged = new Set();
  for (const [productId, dates] of Object.entries(snapshots)) {
    const series = Object.entries(dates).sort(([a], [b]) => a.localeCompare(b));
    const falls = [];
    for (let i = 1; i < series.length; i++) {
      const d = series[i][1] - series[i - 1][1];
      if (d < 0) falls.push(-d);
    }
    const typical = median(falls);
    if (!typical) continue;
    for (let i = 1; i < series.length; i++) {
      const fall = series[i - 1][1] - series[i][1];
      if (fall > Math.max(3 * typical, 10)) flagged.add(`${productId}|${series[i][0]}|${fall}|${typical}`);
    }
  }
  for (const key of flagged) {
    const [productId, date, fall, typical] = key.split('|');
    for (const rec of records) {
      if (rec.usable && rec.productId === productId && rec.date === date) {
        rec.issues.push(issue('warning', 'large_fall', `Stock fell by ${fall} since the previous count, against a typical fall of ${Math.round(typical)}. Check for waste, transfers or a miscount.`));
      }
    }
  }

  const counts = { total: records.length, ok: 0, warning: 0, excluded: 0 };
  for (const rec of records) {
    if (!rec.usable) rec.status = 'excluded';
    else if (rec.issues.some((i) => i.level === 'warning')) rec.status = 'warning';
    else rec.status = 'ok';
    counts[rec.status === 'excluded' ? 'excluded' : rec.status]++;
  }
  return counts;
}

// Observed patterns per product, for the review page. Rises suggest
// deliveries or donations; falls are inferred consumption and may include
// waste, transfers or corrections.
function productPatterns(staging) {
  const records = Object.values(staging.records);
  const snapshots = snapshotsByProduct(records);
  const out = {};
  for (const productId of Object.keys(staging.products)) {
    const series = Object.entries(snapshots[productId] || {}).sort(([a], [b]) => a.localeCompare(b));
    const intervals = [];
    let rises = 0;
    let falls = 0;
    let zeros = 0;
    for (let i = 0; i < series.length; i++) {
      if (series[i][1] === 0) zeros++;
      if (i === 0) continue;
      intervals.push(daysBetween(series[i - 1][0], series[i][0]));
      const d = series[i][1] - series[i - 1][1];
      if (d > 0) rises++;
      if (d < 0) falls++;
    }
    const last = series.at(-1);
    const expiries = records.filter((r) => r.usable && r.productId === productId && r.expiryDate && last && r.date === last[0]);
    out[productId] = {
      counts: series.length,
      from: series[0]?.[0] ?? null,
      to: last?.[0] ?? null,
      typicalIntervalDays: median(intervals),
      rises,
      falls,
      zeroCounts: zeros,
      latestStock: last ? last[1] : null,
      expiryBatches: expiries.length,
      earliestExpiry: expiries.map((r) => r.expiryDate).sort()[0] ?? null,
      flaggedRows: records.filter((r) => r.productId === productId && r.status !== 'ok').length,
    };
  }
  return out;
}

// Turn reviewed staging rows into the approved dataset:
//  - historicalStock: one snapshot per product per count date (batches summed)
//  - inventory: the batches from each product's latest count (current stock)
// Validation is re-run here rather than trusting stored statuses.
function buildApprovedDataset(staging) {
  validateStaging(staging);
  const all = Object.values(staging.records);
  const usable = all.filter((r) => r.usable).sort((a, b) => a.rowNumber - b.rowNumber);
  if (!usable.length) return { error: 'There are no usable rows to approve. Fix or include at least one row.' };

  const usedIds = [...new Set(usable.map((r) => r.productId))].sort();
  const products = {};
  for (const id of usedIds) {
    const { edited, ...p } = staging.products[id];
    products[id] = p;
  }

  const groups = new Map();
  for (const r of usable) {
    const key = `${r.productId}|${r.date}`;
    const g = groups.get(key) || { productId: r.productId, date: r.date, quantity: 0, notes: new Set(), hints: new Set(), rows: [], approximate: false, edited: false };
    g.quantity += Math.floor(r.quantity);
    if (r.notes) g.notes.add(r.notes);
    if (r.movementHint) g.hints.add(r.movementHint);
    g.rows.push(r.rowNumber);
    g.approximate ||= Boolean(r.approximate);
    g.edited ||= Boolean(r.edited);
    groups.set(key, g);
  }

  const sorted = [...groups.values()].sort((a, b) => a.productId.localeCompare(b.productId) || a.date.localeCompare(b.date));
  const historicalStock = {};
  sorted.forEach((g, i) => {
    historicalStock[`record_${String(i + 1).padStart(5, '0')}`] = {
      productId: g.productId,
      date: g.date,
      quantity: g.quantity,
      unit: products[g.productId].unit,
      note: g.notes.size ? [...g.notes].join('; ') : null,
      movementHints: [...g.hints],
      approximate: g.approximate,
      editedInReview: g.edited,
      sourceRows: g.rows,
    };
  });

  const latest = {};
  for (const g of sorted) latest[g.productId] = g.date;
  const inventory = {};
  let n = 0;
  for (const r of usable) {
    if (latest[r.productId] !== r.date || Math.floor(r.quantity) <= 0) continue;
    n++;
    inventory[`batch_${String(n).padStart(3, '0')}`] = {
      productId: r.productId,
      quantity: Math.floor(r.quantity),
      snapshotDate: r.date,
      expiryDate: r.expiryDate || null,
      expiryType: r.expiryDate ? staging.expiryType || 'best_before' : null,
      sourceRow: r.rowNumber,
    };
  }

  const dates = sorted.map((g) => g.date).sort();
  const excluded = all.filter((r) => !r.usable).sort((a, b) => a.rowNumber - b.rowNumber);
  return {
    products,
    historicalStock,
    inventory,
    summary: {
      rowsTotal: all.length,
      rowsUsed: usable.length,
      rowsExcluded: excluded.length,
      rowsWithWarnings: usable.filter((r) => r.issues.some((i) => i.level === 'warning')).length,
      excludedRows: excluded.slice(0, 200).map((r) => ({
        rowNumber: r.rowNumber,
        reason: r.include === false ? 'Excluded by reviewer' : r.issues.filter((i) => i.level === 'exclude').map((i) => i.message).join(' '),
      })),
      recordsCreated: sorted.length,
      products: usedIds.length,
      batches: n,
      from: dates[0],
      to: dates.at(-1),
    },
  };
}

module.exports = {
  buildApprovedDataset,
  detectDateFormat,
  parseDate,
  parseQuantity,
  movementHint,
  validateRecord,
  validateStaging,
  productPatterns,
  snapshotsByProduct,
};
