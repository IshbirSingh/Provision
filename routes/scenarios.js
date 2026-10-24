// Steps 3 and 4: scenario selection, simulation and policy comparison.

const express = require('express');
const { requireStep } = require('../services/workflowService');

const router = express.Router();

router.get('/scenario', requireStep('scenario'), (req, res) => {
  res.render('scenarios', { title: 'Scenario' });
});

router.get('/compare', requireStep('compare'), (req, res) => {
  res.render('compare-policies', { title: 'Compare policies' });
});

module.exports = router;
