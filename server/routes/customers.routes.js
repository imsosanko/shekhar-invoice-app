const express = require('express');
const db = require('../db');
const router = express.Router();

router.get('/', (req, res) => {
  const customers = db.list('customers');
  const invoices = db.list('invoices');
  const enriched = customers.map(c => {
    const custInvoices = invoices.filter(i => i.customerId === c.id);
    const outstanding = custInvoices
      .filter(i => i.status === 'Pending' || i.status === 'Overdue')
      .reduce((s, i) => s + i.grandTotal, 0);
    return { ...c, invoiceCount: custInvoices.length, outstanding };
  });
  res.json(enriched);
});

router.post('/', (req, res) => {
  const { name, mobile, email, address, state, gstin } = req.body || {};
  if (!name || !mobile) return res.status(400).json({ error: 'Name and mobile are required.' });
  const record = db.insert('customers', {
    name: name.trim(), mobile: mobile.trim(), email: (email || '').trim(),
    address: (address || '').trim(), state: (state || 'Bihar').trim(), gstin: (gstin || '').trim()
  });
  res.status(201).json(record);
});

router.put('/:id', (req, res) => {
  const existing = db.find('customers', req.params.id);
  if (!existing) return res.status(404).json({ error: 'Customer not found.' });
  const { name, mobile, email, address, state, gstin } = req.body || {};
  const updated = db.update('customers', req.params.id, {
    name: name?.trim() ?? existing.name,
    mobile: mobile?.trim() ?? existing.mobile,
    email: email?.trim() ?? existing.email,
    address: address?.trim() ?? existing.address,
    state: state?.trim() ?? existing.state,
    gstin: gstin?.trim() ?? existing.gstin
  });
  res.json(updated);
});

router.delete('/:id', (req, res) => {
  const ok = db.remove('customers', req.params.id);
  if (!ok) return res.status(404).json({ error: 'Customer not found.' });
  res.json({ ok: true });
});

module.exports = router;
