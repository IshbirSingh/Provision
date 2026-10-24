// External context for Step 2: UK bank holidays, school holidays, weather
// forecasts and warnings, IMD 2025 and benefit-payment timing.
// Context is shown as evidence; it is never applied as an automatic demand
// multiplier, and failures must not block the workflow.

async function gatherContext(_organisation) {
  throw new Error('External context gathering is not implemented yet');
}

module.exports = { gatherContext };
