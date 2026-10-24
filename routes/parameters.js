// Step 2: historical analysis, external context and parameter approval.

const express = require('express');
const { requireStep } = require('../services/workflowService');

const router = express.Router();

router.get('/parameters', requireStep('parameters'), (req, res) => {
  res.render('parameters', { title: 'Planning parameters' });
});

module.exports = router;
