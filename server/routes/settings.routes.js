const express = require('express');
const db = require('../db');
const router = express.Router();

router.get('/', (req, res) => res.json(db.getSettings()));

router.put('/', (req, res) => {
  const patch = req.body || {};
  const updated = db.updateSettings(patch);
  res.json(updated);
});

module.exports = router;
