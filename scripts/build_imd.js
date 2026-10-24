// Condense the official English Indices of Deprivation 2025 File 7 CSV
// (https://www.gov.uk/government/statistics/english-indices-of-deprivation-2025)
// into data/reference/imd2025_lsoa.json, keyed by 2021 LSOA code.
//
// Usage: node scripts/build_imd.js path/to/File_7_IoD2025_All_Ranks_Scores_Deciles_Population_Denominators.csv

const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');

const src = process.argv[2];
if (!src) throw new Error('Pass the path to the File 7 CSV');

const rows = parse(fs.readFileSync(src), { columns: true, bom: true, skip_empty_lines: true });
const find = (re) => {
  const key = Object.keys(rows[0]).find((k) => re.test(k));
  if (!key) throw new Error(`Column not found: ${re}`);
  return key;
};
const cols = {
  code: find(/^LSOA code \(2021\)/),
  lad: find(/^Local Authority District name/),
  imdRank: find(/^Index of Multiple Deprivation \(IMD\) Rank/),
  imdDecile: find(/^Index of Multiple Deprivation \(IMD\) Decile/),
  incomeDecile: find(/^Income Decile/),
  idaciDecile: find(/^Income Deprivation Affecting Children Index \(IDACI\) Decile/),
};

// Compact rows: [imdRank, imdDecile, incomeDecile, idaciDecile, ladIndex]
const lads = [];
const ladIndex = new Map();
const lsoa = {};
for (const r of rows) {
  const lad = r[cols.lad];
  if (!ladIndex.has(lad)) { ladIndex.set(lad, lads.length); lads.push(lad); }
  lsoa[r[cols.code]] = [Number(r[cols.imdRank]), Number(r[cols.imdDecile]), Number(r[cols.incomeDecile]), Number(r[cols.idaciDecile]), ladIndex.get(lad)];
}

const out = {
  source: 'English Indices of Deprivation 2025, File 7 (MHCLG, accredited official statistics)',
  url: 'https://www.gov.uk/government/statistics/english-indices-of-deprivation-2025',
  lsoaCount: Object.keys(lsoa).length,
  fields: ['imdRank', 'imdDecile', 'incomeDecile', 'idaciDecile', 'ladIndex'],
  lads,
  lsoa,
};
const dest = path.join(__dirname, '..', 'data', 'reference', 'imd2025_lsoa.json');
fs.writeFileSync(dest, JSON.stringify(out));
console.log(`${out.lsoaCount} LSOAs, ${lads.length} districts -> ${dest} (${(fs.statSync(dest).size / 1e6).toFixed(2)} MB)`);
