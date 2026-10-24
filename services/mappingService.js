// Step 1: maps inconsistent spreadsheet columns, product names, dates and
// units onto the SupplyShield schema. Uses Nebius when available, with a
// deterministic header-matching fallback. Ambiguities are flagged, never filled.

async function mapUpload(_parsed) {
  throw new Error('Column mapping is not implemented yet');
}

module.exports = { mapUpload };
