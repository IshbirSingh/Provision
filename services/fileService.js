// Parses uploaded CSV / XLSX files into header + row objects.
// No interpretation happens here; values are kept as the original strings.

const path = require('path');
const { parse } = require('csv-parse/sync');
const XLSX = require('xlsx');

const MAX_ROWS = 20000;
const ALLOWED = new Set(['.csv', '.xlsx', '.xls']);

function isAllowed(filename) {
  return ALLOWED.has(path.extname(filename || '').toLowerCase());
}

function parseCsv(buffer) {
  const rows = parse(buffer, {
    bom: true,
    skip_empty_lines: true,
    relax_column_count: true,
    trim: true,
  });
  return rowsFromMatrix(rows);
}

function parseWorkbook(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error('The workbook has no sheets');
  const sheet = workbook.Sheets[sheetName];

  // Real date cells become ISO dates rather than Excel's ambiguous m/d/yy text.
  const pad = (n) => String(n).padStart(2, '0');
  for (const [ref, cell] of Object.entries(sheet)) {
    if (ref[0] === '!' || cell.t !== 'd' || !(cell.v instanceof Date)) continue;
    const d = cell.v;
    cell.w = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  const matrix = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    raw: false,
    defval: '',
    blankrows: false,
  });
  return { ...rowsFromMatrix(matrix), sheetName, sheetNames: workbook.SheetNames };
}

// First non-empty row is treated as the header. Duplicate or blank headers
// get a positional suffix so no column is lost.
function rowsFromMatrix(matrix) {
  const nonEmpty = matrix.filter((r) => r.some((c) => String(c ?? '').trim() !== ''));
  if (nonEmpty.length < 2) throw new Error('The file needs a header row and at least one data row');
  if (nonEmpty.length - 1 > MAX_ROWS) throw new Error(`The file has more than ${MAX_ROWS} rows`);

  const seen = new Map();
  const headers = nonEmpty[0].map((h, i) => {
    let name = String(h ?? '').trim() || `column_${i + 1}`;
    const count = seen.get(name) || 0;
    seen.set(name, count + 1);
    if (count) name = `${name}_${count + 1}`;
    return name;
  });

  const rows = nonEmpty.slice(1).map((r) =>
    Object.fromEntries(headers.map((h, i) => [h, String(r[i] ?? '').trim()])),
  );
  return { headers, rows };
}

function parseFile(buffer, filename) {
  const ext = path.extname(filename || '').toLowerCase();
  if (ext === '.csv') return { ...parseCsv(buffer), format: 'csv' };
  if (ext === '.xlsx' || ext === '.xls') return { ...parseWorkbook(buffer), format: 'xlsx' };
  throw new Error('Upload a .csv or .xlsx file');
}

module.exports = { isAllowed, parseFile };
