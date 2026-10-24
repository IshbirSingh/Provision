// Step 5: recommendations dashboard, explanations and plan finalisation.

const express = require('express');
const { requireStep } = require('../services/workflowService');

const router = express.Router();

router.get('/plan', requireStep('plan'), (req, res) => {
  res.render('recommendations', { title: 'Replenishment plan' });
});

module.exports = router;
