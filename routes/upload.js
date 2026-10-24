// Step 1: upload, AI extraction, review and approval of stock records.

const express = require('express');
const { requireStep } = require('../services/workflowService');

const router = express.Router();

router.get('/upload', requireStep('data'), (req, res) => {
  res.render('upload', { title: 'Upload stock records' });
});

router.get('/review', requireStep('data'), (req, res) => {
  res.render('review-data', { title: 'Review extracted records' });
});

module.exports = router;
