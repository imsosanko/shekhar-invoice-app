const express = require('express');
const db = require('../db');
const router = express.Router();

router.get('/', (req, res) => res.json(db.list('expenses')));

router.post('/', (req, res) => {
  const { date, category, description, amount, method } = req.body || {};
  if (!amount || Number(amount) <= 0) return res.status(400).json({ error: 'A valid amount is required.' });
  const record = db.insert('expenses', {
    date: date || new Date().toISOString().slice(0, 10),
    category: category || 'Other',
    description: (description || '').trim(),
    amount: Number(amount),
    method: method || 'Cash'
  });
  res.status(201).json(record);
});

router.put('/:id', (req, res) => {
  const existing = db.find('expenses', req.params.id);
  if (!existing) return res.status(404).json({ error: 'Expense not found.' });
  const { date, category, description, amount, method } = req.body || {};
  const updated = db.update('expenses', req.params.id, {
    date: date ?? existing.date,
    category: category ?? existing.category,
    description: description != null ? description.trim() : existing.description,
    amount: amount != null ? Number(amount) : existing.amount,
    method: method ?? existing.method
  });
  res.json(updated);
});

router.delete('/:id', (req, res) => {
  const ok = db.remove('expenses', req.params.id);
  if (!ok) return res.status(404).json({ error: 'Expense not found.' });
  res.json({ ok: true });
});

module.exports = router;
