const express = require('express');
const db = require('../db');
const router = express.Router();

router.get('/', (req, res) => {
  const payments = db.list('payments').map(p => ({ ...p, invoice: db.find('invoices', p.invoiceId) || null }));
  res.json(payments);
});

router.post('/', (req, res) => {
  const { invoiceId, amount, date, method, transactionId } = req.body || {};
  if (!invoiceId || !amount) return res.status(400).json({ error: 'Invoice and amount are required.' });
  const invoice = db.find('invoices', invoiceId);
  if (!invoice) return res.status(400).json({ error: 'Invoice not found.' });

  const record = db.insert('payments', {
    invoiceId, amount: Number(amount), date: date || new Date().toISOString().slice(0, 10),
    method: method || 'Cash', transactionId: transactionId || ''
  });

  const totalPaid = db.list('payments')
    .filter(p => p.invoiceId === invoiceId)
    .reduce((s, p) => s + p.amount, 0);
  if (totalPaid >= invoice.grandTotal) {
    db.update('invoices', invoiceId, { status: 'Paid' });
  }

  res.status(201).json(record);
});

module.exports = router;
