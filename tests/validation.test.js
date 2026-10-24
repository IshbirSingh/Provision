const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

process.env.NEBIUS_API_KEY = '';
const v = require('../services/validationService');
const mapping = require('../services/mappingService');
const catalog = require('../services/catalog');
const fileService = require('../services/fileService');

test('detects day-first, month-first and ambiguous date columns', () => {
  assert.deepEqual(v.detectDateFormat(['27/10/2025', '03/11/2025']), { format: 'DMY', ambiguous: false });
  assert.deepEqual(v.detectDateFormat(['10/27/2025']), { format: 'MDY', ambiguous: false });
  assert.equal(v.detectDateFormat(['01/02/2026']).ambiguous, true);
  assert.equal(v.detectDateFormat(['2026-01-02']).format, 'ISO');
});

test('parses dates without inventing impossible ones', () => {
  assert.equal(v.parseDate('27/10/2025', 'DMY'), '2025-10-27');
  assert.equal(v.parseDate('10/27/2025', 'MDY'), '2025-10-27');
  assert.equal(v.parseDate('2026-03-05'), '2026-03-05');
  assert.equal(v.parseDate('5 March 2026'), '2026-03-05');
  assert.equal(v.parseDate('31/02/2026', 'DMY'), null);
  assert.equal(v.parseDate('soon'), null);
  assert.equal(v.parseDate(''), null);
});

test('parses quantities and marks approximate ones', () => {
  assert.deepEqual(v.parseQuantity('120'), { quantity: 120, approximate: false, readable: true });
  assert.deepEqual(v.parseQuantity('1,200'), { quantity: 1200, approximate: false, readable: true });
  assert.deepEqual(v.parseQuantity('approx 40'), { quantity: 40, approximate: true, readable: true });
  assert.equal(v.parseQuantity('~15').approximate, true);
  assert.equal(v.parseQuantity('').quantity, null);
  assert.equal(v.parseQuantity('lots').readable, false);
});

test('tags notes that mean a fall is not demand', () => {
  assert.equal(v.movementHint("transfer to St Mark's pantry"), 'transfer');
  assert.equal(v.movementHint('stock take corrected'), 'correction');
  assert.equal(v.movementHint('binned - past date'), 'waste');
  assert.equal(v.movementHint('harvest festival donations'), 'donation');
  assert.equal(v.movementHint(''), null);
});

test('categorises products with the spec defaults', () => {
  const cases = {
    'Gluten Free Pasta 500g': 'allergy_safe_dietary',
    'Pasta 500g': 'staple_carbohydrates',
    'Infant Formula 800g': 'baby_food_infant_formula',
    'Baked Beans 415g': 'tinned_protein',
    'Tinned Peas': 'tinned_vegetables',
    'Potatoes 2.5kg': 'fresh_produce',
    'Sanitary Pads': 'hygiene_products',
    'Dog food': 'other',
  };
  for (const [name, cat] of Object.entries(cases)) assert.equal(catalog.categoriseByName(name), cat, name);
  assert.equal(catalog.defaultPriority('baby_food_infant_formula'), 'critical');
  assert.deepEqual(catalog.packSizeFromName('Lactose Free Milk UHT 1L'), { packSize: 1, packSizeUnit: 'L' });
});

test('maps common header names by rules', () => {
  const m = mapping.mapColumnsByRules(['Date Counted', 'Item', 'Category', 'Qty', 'Unit', 'Best Before', 'Notes']);
  assert.deepEqual(m, { 'Date Counted': 'date', Item: 'product', Category: 'category', Qty: 'quantity', Unit: 'unit', 'Best Before': 'expiry', Notes: 'notes' });
  assert.deepEqual(mapping.checkMapping(m, Object.keys(m)), []);
  assert.match(mapping.checkMapping({ A: 'date', B: 'ignore' }, ['A', 'B']).join(), /product/);
});

test('interprets the sample file deterministically without Nebius', async () => {
  const file = path.join(__dirname, '..', 'data', 'sample', 'sample_stock_history.csv');
  const parsed = fileService.parseFile(fs.readFileSync(file), 'sample.csv');
  const { staging } = await mapping.interpretUpload(parsed, { filename: 'sample.csv' });
  const counts = v.validateStaging(staging);

  assert.equal(staging.method, 'rules');
  assert.equal(Object.keys(staging.products).length, 15);
  assert.ok(staging.products.baked_beans_415g.rawNames.includes('Beans - baked'));
  assert.equal(counts.total, 786);
  assert.equal(counts.excluded, 2); // the two "not counted" rows

  const missing = Object.values(staging.records).filter((r) => r.status === 'excluded');
  assert.ok(missing.every((r) => r.issues.some((i) => i.code === 'quantity_missing')));
  assert.ok(Object.values(staging.records).some((r) => r.issues.some((i) => i.code === 'quantity_approximate')));

  const built = v.buildApprovedDataset(staging);
  assert.equal(built.summary.products, 15);
  assert.equal(built.summary.recordsCreated, 778);
  // Batches on the same date are summed into one snapshot.
  const beans = Object.values(built.historicalStock).filter((r) => r.productId === 'baked_beans_415g').at(-1);
  const beanBatches = Object.values(built.inventory).filter((b) => b.productId === 'baked_beans_415g');
  assert.equal(beans.quantity, beanBatches.reduce((s, b) => s + b.quantity, 0));
  assert.ok(beanBatches.some((b) => b.expiryDate === '2026-11-06'));
  // Values are never invented: no record has a null or negative quantity.
  assert.ok(Object.values(built.historicalStock).every((r) => Number.isInteger(r.quantity) && r.quantity >= 0));
});

test('flags duplicates and future dates', () => {
  const staging = {
    products: { rice: { name: 'Rice', unit: 'bag' } },
    records: {
      a: { rowNumber: 2, date: '2026-01-05', productId: 'rice', quantity: 10, include: true },
      b: { rowNumber: 3, date: '2026-01-05', productId: 'rice', quantity: 10, include: true },
      c: { rowNumber: 4, date: '2999-01-01', productId: 'rice', quantity: 10, include: true },
    },
  };
  v.validateStaging(staging);
  assert.equal(staging.records.b.status, 'warning');
  assert.ok(staging.records.b.issues.some((i) => i.code === 'duplicate'));
  assert.equal(staging.records.c.status, 'excluded');
});
