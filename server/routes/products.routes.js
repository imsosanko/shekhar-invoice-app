const express = require('express');
const db = require('../db');
const router = express.Router();

router.get('/', (req, res) => res.json(db.list('products')));

router.post('/', (req, res) => {
  const { name, description, hsn, rate, gst, unit } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Name is required.' });
  const record = db.insert('products', {
    name: name.trim(), description: (description || '').trim(), hsn: (hsn || '').trim(),
    rate: Number(rate) || 0, gst: Number(gst) || 0, unit: (unit || 'Unit').trim()
  });
  res.status(201).json(record);
});

router.put('/:id', (req, res) => {
  const existing = db.find('products', req.params.id);
  if (!existing) return res.status(404).json({ error: 'Product not found.' });
  const { name, description, hsn, rate, gst, unit } = req.body || {};
  const updated = db.update('products', req.params.id, {
    name: name?.trim() ?? existing.name,
    description: description?.trim() ?? existing.description,
    hsn: hsn?.trim() ?? existing.hsn,
    rate: rate != null ? Number(rate) : existing.rate,
    gst: gst != null ? Number(gst) : existing.gst,
    unit: unit?.trim() ?? existing.unit
  });
  res.json(updated);
});

router.delete('/:id', (req, res) => {
  const ok = db.remove('products', req.params.id);
  if (!ok) return res.status(404).json({ error: 'Product not found.' });
  res.json({ ok: true });
});

module.exports = router;
