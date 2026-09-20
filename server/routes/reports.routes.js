const express = require('express');
const db = require('../db');
const router = express.Router();

router.get('/dashboard', (req, res) => {
  const invoices = db.list('invoices');
  const total = invoices.length;
  const revenue = invoices.filter(i => i.status !== 'Cancelled').reduce((s, i) => s + i.grandTotal, 0);
  const paidAmt = invoices.filter(i => i.status === 'Paid').reduce((s, i) => s + i.grandTotal, 0);
  const pendingInvoices = invoices.filter(i => i.status === 'Pending' || i.status === 'Overdue');
  const pendingAmt = pendingInvoices.reduce((s, i) => s + i.grandTotal, 0);

  const recent = [...invoices]
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 6)
    .map(i => ({ ...i, customer: db.find('customers', i.customerId) || null }));

  res.json({
    totalInvoices: total,
    totalRevenue: revenue,
    pendingAmount: pendingAmt,
    pendingCount: pendingInvoices.length,
    paidAmount: paidAmt,
    recentInvoices: recent
  });
});

router.get('/analytics', (req, res) => {
  const invoices = db.list('invoices');
  const expenses = db.list('expenses');

  const months = [];
  const now = new Date();
  for (let i = 5; i >= 0; i--) months.push(new Date(now.getFullYear(), now.getMonth() - i, 1));
  const monthlyRevenue = months.map(d => {
    const label = d.toLocaleDateString('en-IN', { month: 'short' });
    const sum = invoices
      .filter(inv => {
        const idt = new Date(inv.date);
        return idt.getFullYear() === d.getFullYear() && idt.getMonth() === d.getMonth() && inv.status !== 'Cancelled';
      })
      .reduce((s, i) => s + i.grandTotal, 0);
    return { label, sum };
  });

  const statusCounts = {};
  invoices.forEach(i => { statusCounts[i.status] = (statusCounts[i.status] || 0) + 1; });

  const custTotals = {};
  invoices.forEach(i => {
    if (i.status === 'Cancelled') return;
    const cust = db.find('customers', i.customerId);
    const name = cust ? cust.name : 'Unknown';
    custTotals[name] = (custTotals[name] || 0) + i.grandTotal;
  });
  const topCustomers = Object.entries(custTotals).sort((a, b) => b[1] - a[1]).slice(0, 5);

  const svcTotals = {};
  invoices.forEach(i => {
    if (i.status === 'Cancelled') return;
    i.items.forEach(it => { svcTotals[it.desc] = (svcTotals[it.desc] || 0) + (it.qty * it.rate); });
  });
  const topServices = Object.entries(svcTotals).sort((a, b) => b[1] - a[1]).slice(0, 5);

  const collected = invoices.filter(i => i.status === 'Paid').reduce((s, i) => s + i.grandTotal, 0);
  const totalBilled = invoices.filter(i => i.status !== 'Cancelled').reduce((s, i) => s + i.grandTotal, 0);
  const totalExpenses = expenses.reduce((s, e) => s + e.amount, 0);

  const pending = invoices
    .filter(i => i.status === 'Pending' || i.status === 'Overdue')
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
    .map(i => ({ ...i, customer: db.find('customers', i.customerId) || null }));

  res.json({
    monthlyRevenue, statusCounts, topCustomers, topServices,
    collected, totalBilled, totalExpenses, netProfit: totalBilled - totalExpenses,
    collectionRate: totalBilled ? Math.round((collected / totalBilled) * 100) : 0,
    pending
  });
});

module.exports = router;
