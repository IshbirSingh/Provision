// Step 1: upload, AI extraction, review and approval of stock records.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');

const storage = require('../services/storageService');
const fileService = require('../services/fileService');
const mapping = require('../services/mappingService');
const validation = require('../services/validationService');
const catalog = require('../services/catalog');
const { requireStep } = require('../services/workflowService');

const router = express.Router();
const SAMPLE_DIR = path.join(__dirname, '..', 'data', 'sample');
const SAMPLE_FILES = { 'sample_stock_history.csv': 'text/csv', 'sample_stock_history.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
const MAX_AI_CACHE = 10;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => cb(null, fileService.isAllowed(file.originalname)),
});

const hasStaging = (data) => Object.keys(data.staging.records).length > 0 || data.staging.method === 'manual';

function approvedSummary(data) {
  const dates = Object.values(data.historicalStock).map((r) => r.date).sort();
  const dataset = data.audit.datasets?.[`dataset_v${data.audit.inputVersion}`] || null;
  return {
    records: Object.keys(data.historicalStock).length,
    products: Object.keys(data.products).length,
    from: dates[0] || null,
    to: dates.at(-1) || null,
    version: data.audit.inputVersion,
    sourceFile: dataset?.sourceFile || null,
  };
}

function renderUpload(res, { error = null, status = 200 } = {}) {
  const { data } = res.locals;
  res.status(status).render('upload', {
    title: 'Upload stock records',
    error,
    pending: hasStaging(data) ? { sourceFile: data.staging.sourceFile, rows: Object.keys(data.staging.records).length } : null,
    approved: approvedSummary(data),
  });
}

// Interpret a file and replace the staging area with the result.
async function stageFile(store, buffer, filename) {
  const parsed = fileService.parseFile(buffer, filename);
  const fileHash = crypto.createHash('sha256').update(buffer).digest('hex');
  const { aiCache } = (await store.loadData()).staging;
  const { staging, cacheEntry } = await mapping.interpretUpload(parsed, { filename, fileHash, cache: aiCache });

  await store.mutate((data) => {
    const cache = { ...(data.staging.aiCache || {}) };
    if (cacheEntry) {
      cache[cacheEntry.key] = { ...cacheEntry.value, savedAt: new Date().toISOString() };
      const keys = Object.keys(cache).sort((a, b) => (cache[a].savedAt || '').localeCompare(cache[b].savedAt || ''));
      while (keys.length > MAX_AI_CACHE) delete cache[keys.shift()];
    }
    validation.validateStaging(staging);
    data.staging = { ...staging, aiCache: cache };
  });
}

router.get('/upload', requireStep('data'), (req, res) => renderUpload(res));

router.post('/upload', requireStep('data'), upload.single('file'), async (req, res) => {
  if (!req.file) return renderUpload(res, { status: 422, error: 'Choose a .csv or .xlsx file to upload.' });
  try {
    await stageFile(req.store, req.file.buffer, req.file.originalname);
  } catch (err) {
    console.error('[upload]', err.message);
    return renderUpload(res, { status: 422, error: `The file could not be read: ${err.message}` });
  }
  res.redirect('/review');
});

router.post('/upload/sample', requireStep('data'), async (req, res) => {
  const file = 'sample_stock_history.csv';
  await stageFile(req.store, fs.readFileSync(path.join(SAMPLE_DIR, file)), file);
  res.redirect('/review');
});

router.post('/upload/manual', requireStep('data'), async (req, res) => {
  await req.store.mutate((data) => {
    data.staging = { ...mapping.emptyStaging(), aiCache: data.staging.aiCache || {} };
  });
  res.redirect('/review');
});

router.get('/sample/:file', (req, res) => {
  const type = SAMPLE_FILES[req.params.file];
  if (!type) return res.status(404).end();
  res.type(type).download(path.join(SAMPLE_DIR, req.params.file));
});

// --- Review ----------------------------------------------------------------

function clientRecord(id, r) {
  return {
    id,
    rowNumber: r.rowNumber,
    date: r.date,
    productId: r.productId,
    productName: r.productName,
    quantity: r.quantity,
    unit: r.unit,
    expiryDate: r.expiryDate,
    notes: r.notes,
    include: r.include !== false,
    status: r.status,
    issues: r.issues,
  };
}

function counts(staging) {
  const c = { total: 0, ok: 0, warning: 0, excluded: 0 };
  for (const r of Object.values(staging.records)) {
    c.total++;
    c[r.status] = (c[r.status] || 0) + 1;
  }
  return c;
}

router.get('/review', requireStep('data'), (req, res) => {
  const { staging } = res.locals.data;
  if (!hasStaging(res.locals.data)) return res.redirect('/upload');

  const records = Object.entries(staging.records)
    .map(([id, r]) => clientRecord(id, r))
    .sort((a, b) => a.rowNumber - b.rowNumber);
  res.render('review-data', {
    title: 'Review extracted records',
    staging,
    records,
    counts: counts(staging),
    patterns: validation.productPatterns(staging),
    categories: catalog.CATEGORIES,
    priorities: catalog.PRIORITIES,
    fields: mapping.FIELDS,
    mappingErrors: staging.method === 'manual' ? [] : mapping.checkMapping(staging.columnMapping, staging.headers),
    scripts: ['/js/upload.js'],
  });
});

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const badRequest = (res, message) => res.status(400).json({ error: message });

function textOrNull(v, max = 200) {
  const s = String(v ?? '').trim();
  return s ? s.slice(0, max) : null;
}

router.post('/review/record', requireStep('data'), async (req, res) => {
  const { id, changes } = req.body || {};
  if (typeof id !== 'string' || !changes || typeof changes !== 'object') return badRequest(res, 'Invalid request');

  const result = await req.store.mutate((data) => {
    const rec = data.staging.records[id];
    if (!rec) return { error: 'Row not found' };

    if ('date' in changes) {
      if (changes.date && !ISO_DATE.test(changes.date)) return { error: 'Invalid date' };
      rec.date = changes.date || null;
    }
    if ('expiryDate' in changes) {
      if (changes.expiryDate && !ISO_DATE.test(changes.expiryDate)) return { error: 'Invalid best-before date' };
      rec.expiryDate = changes.expiryDate || null;
      if (rec.rawFields) rec.rawFields = { ...rec.rawFields, expiry: null }; // user-entered now
    }
    if ('productId' in changes) {
      if (changes.productId && !data.staging.products[changes.productId]) return { error: 'Unknown product' };
      rec.productId = changes.productId || null;
      rec.mergedFrom = null;
    }
    if ('quantity' in changes) {
      const q = changes.quantity === '' || changes.quantity === null ? null : Number(changes.quantity);
      if (q !== null && !Number.isFinite(q)) return { error: 'Quantity must be a number' };
      rec.quantity = q;
      rec.approximate = false; // confirmed by the user
    }
    if ('unit' in changes) rec.unit = textOrNull(changes.unit, 20);
    if ('notes' in changes) {
      rec.notes = textOrNull(changes.notes, 300);
      rec.movementHint = validation.movementHint(rec.notes);
    }
    if ('include' in changes) rec.include = Boolean(changes.include);
    rec.edited = true;

    validation.validateStaging(data.staging);
    return { record: clientRecord(id, rec), counts: counts(data.staging) };
  });

  if (result.error) return badRequest(res, result.error);
  res.json(result);
});

router.post('/review/record/new', requireStep('data'), async (req, res) => {
  const result = await req.store.mutate((data) => {
    const { records } = data.staging;
    const nextRow = Math.max(1, ...Object.values(records).map((r) => r.rowNumber)) + 1;
    const nextId = `row_${String(Object.keys(records).length + 1).padStart(5, '0')}`;
    const id = nextId in records ? `row_m${Date.now()}` : nextId;
    records[id] = {
      rowNumber: nextRow,
      raw: null,
      rawFields: null,
      date: null,
      productId: null,
      productName: '',
      mergedFrom: null,
      quantity: null,
      approximate: false,
      unit: null,
      expiryDate: null,
      notes: null,
      movementHint: null,
      include: true,
      edited: true,
    };
    validation.validateStaging(data.staging);
    return { record: clientRecord(id, records[id]), counts: counts(data.staging) };
  });
  res.json(result);
});

router.post('/review/product', requireStep('data'), async (req, res) => {
  const { id, changes } = req.body || {};
  if (typeof id !== 'string' || !changes || typeof changes !== 'object') return badRequest(res, 'Invalid request');

  const result = await req.store.mutate((data) => {
    const p = data.staging.products[id];
    if (!p) return { error: 'Product not found' };
    if ('name' in changes) {
      const name = textOrNull(changes.name, 80);
      if (!name) return { error: 'Name cannot be empty' };
      p.name = name;
    }
    if ('category' in changes) {
      if (!catalog.CATEGORIES[changes.category]) return { error: 'Unknown category' };
      p.category = changes.category;
    }
    if ('priority' in changes) {
      if (!catalog.PRIORITIES[changes.priority]) return { error: 'Unknown priority' };
      p.priority = changes.priority;
    }
    if ('unit' in changes) p.unit = textOrNull(changes.unit, 20);
    p.edited = true;
    validation.validateStaging(data.staging);
    return { product: { id, ...p }, counts: counts(data.staging) };
  });

  if (result.error) return badRequest(res, result.error);
  res.json(result);
});

router.post('/review/product/new', requireStep('data'), async (req, res) => {
  const name = textOrNull(req.body?.name, 80);
  if (!name) return badRequest(res, 'Enter a product name');
  const result = await req.store.mutate((data) => {
    const id = mapping.newProduct(data.staging.products, { name, category: req.body.category, unit: req.body.unit });
    return { product: { id, ...data.staging.products[id] } };
  });
  res.json(result);
});

// Re-read the stored rows with a corrected column mapping. Edits are lost.
router.post('/review/columns', requireStep('data'), async (req, res) => {
  const data = await req.store.loadData();
  const { staging } = data;
  const headers = staging.headers || [];
  const override = Object.fromEntries(headers.map((h, i) => [h, req.body[`col_${i}`]]));
  const errors = mapping.checkMapping(override, headers);
  if (errors.length) {
    req.session.flash = { type: 'error', message: `Columns not changed: ${errors.join('. ')}.` };
    return res.redirect('/review#columns');
  }

  const rows = Object.values(staging.records).filter((r) => r.raw).sort((a, b) => a.rowNumber - b.rowNumber).map((r) => r.raw);
  const { staging: next } = await mapping.interpretUpload(
    { headers, rows, format: staging.format, sheetName: staging.sheetName },
    { filename: staging.sourceFile, fileHash: staging.fileHash, columnOverride: override },
  );
  next.method = 'rules';
  next.model = null;
  next.warnings.w_manual = { level: 'info', message: 'Columns were set by hand, so product names were grouped by rules.' };
  await req.store.mutate((d) => {
    validation.validateStaging(next);
    d.staging = { ...next, aiCache: d.staging.aiCache || {} };
  });
  req.session.flash = { type: 'success', message: 'File re-read with the new columns.' };
  res.redirect('/review');
});

router.post('/review/discard', requireStep('data'), async (req, res) => {
  await req.store.mutate((data) => {
    data.staging = { ...storage.defaultWorkspace().staging, aiCache: data.staging.aiCache || {} };
  });
  req.session.flash = { type: 'info', message: 'Upload discarded. Your approved data has not changed.' };
  res.redirect('/upload');
});

router.post('/review/approve', requireStep('data'), async (req, res) => {
  const userId = res.locals.user.id;
  const result = await req.store.mutate((data) => {
    const built = validation.buildApprovedDataset(data.staging);
    if (built.error) return built;

    storage.applyInvalidation(data, 'historical');
    const version = data.audit.inputVersion;
    data.products = built.products;
    data.historicalStock = built.historicalStock;
    data.inventory = built.inventory;
    data.audit.datasets[`dataset_v${version}`] = {
      version,
      approvedAt: new Date().toISOString(),
      approvedBy: userId,
      sourceFile: data.staging.sourceFile,
      fileHash: data.staging.fileHash,
      method: data.staging.method,
      model: data.staging.model,
      columnMapping: data.staging.columnMapping,
      dateFormat: data.staging.dateFormat,
      ...built.summary,
    };
    data.staging = { ...storage.defaultWorkspace().staging, aiCache: data.staging.aiCache || {} };
    data.metadata.currentStep = 2;
    return { summary: built.summary };
  });

  if (result.error) {
    req.session.flash = { type: 'error', message: result.error };
    return res.redirect('/review');
  }
  const s = result.summary;
  req.session.flash = {
    type: 'success',
    message: `Approved ${s.recordsCreated} stock counts for ${s.products} products${s.rowsExcluded ? ` (${s.rowsExcluded} rows left out)` : ''}.`,
  };
  res.redirect('/parameters');
});

module.exports = router;
