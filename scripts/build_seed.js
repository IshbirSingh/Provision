// Build data/sample/seed.json (the "Reset to sample data" workspace) and the
// XLSX copy of the sample file, by running the sample CSV through the same
// Step 1 pipeline the app uses. Header/keyword rules are used rather than
// Nebius so the seed is deterministic.
//
// Usage: node scripts/build_seed.js   (after scripts/generate_sample_data.py)

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

delete process.env.NEBIUS_API_KEY;
const fileService = require('../services/fileService');
const mapping = require('../services/mappingService');
const validation = require('../services/validationService');

const DIR = path.join(__dirname, '..', 'data', 'sample');
const CSV = 'sample_stock_history.csv';

(async () => {
  const buffer = fs.readFileSync(path.join(DIR, CSV));
  const { staging } = await mapping.interpretUpload(fileService.parseFile(buffer, CSV), { filename: CSV });
  const built = validation.buildApprovedDataset(staging);
  if (built.error) throw new Error(built.error);

  const seed = {
    products: built.products,
    historicalStock: built.historicalStock,
    inventory: built.inventory,
    audit: {
      inputVersion: 1,
      calculationVersion: null,
      warnings: {},
      datasets: {
        dataset_v1: {
          version: 1,
          approvedAt: null,
          approvedBy: 'sample',
          sourceFile: CSV,
          method: 'rules',
          model: null,
          columnMapping: staging.columnMapping,
          dateFormat: staging.dateFormat,
          ...built.summary,
        },
      },
      records: {},
    },
  };
  fs.writeFileSync(path.join(DIR, 'seed.json'), JSON.stringify(seed, null, 2));

  const src = XLSX.read(buffer, { type: 'buffer', raw: true });
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, src.Sheets[src.SheetNames[0]], 'Stock counts');
  XLSX.writeFile(book, path.join(DIR, 'sample_stock_history.xlsx'));

  const s = built.summary;
  console.log(`seed.json: ${s.products} products, ${s.recordsCreated} counts, ${s.batches} batches, ${s.rowsExcluded} rows left out`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
