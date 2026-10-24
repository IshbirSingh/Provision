// Derives the state of the five-step workflow from data.json so pages can
// show progress and block steps whose inputs are not approved yet.

const STEPS = [
  { id: 'data', number: 1, label: 'Data', path: '/upload' },
  { id: 'parameters', number: 2, label: 'Parameters', path: '/parameters' },
  { id: 'scenario', number: 3, label: 'Scenario', path: '/scenario' },
  { id: 'compare', number: 4, label: 'Compare', path: '/compare' },
  { id: 'plan', number: 5, label: 'Plan', path: '/plan' },
];

const count = (obj) => Object.keys(obj || {}).length;

function workflowStatus(data) {
  const hasData = count(data.historicalStock) > 0;
  const hasStaged = count(data.staging?.records) > 0;
  const paramsApproved = data.parameters.approved === true;
  const hasSimulation = count(data.simulation.policies) > 0;
  const hasPolicy = Boolean(data.recommendations.selectedPolicy);
  const finalised = data.recommendations.finalised === true;

  const done = {
    data: hasData,
    parameters: paramsApproved,
    scenario: hasSimulation,
    compare: hasPolicy,
    plan: finalised,
  };
  const unlocked = {
    data: true,
    parameters: hasData,
    scenario: paramsApproved,
    compare: paramsApproved,
    plan: hasPolicy,
  };

  return {
    steps: STEPS.map((s) => ({ ...s, done: done[s.id], unlocked: unlocked[s.id] })),
    hasStaged,
    done,
    unlocked,
  };
}

// Express middleware factory: redirect to the earliest incomplete step when a
// later step is opened before its inputs exist.
function requireStep(stepId) {
  return (req, res, next) => {
    const status = res.locals.workflow;
    if (status?.unlocked[stepId]) return next();
    const firstOpen = status.steps.find((s) => s.unlocked && !s.done) || STEPS[0];
    req.session.flash = { type: 'info', message: 'Complete the earlier steps first.' };
    return res.redirect(firstOpen.path);
  };
}

module.exports = { STEPS, workflowStatus, requireStep };
