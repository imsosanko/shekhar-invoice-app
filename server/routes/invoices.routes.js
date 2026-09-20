const express = require('express');
const path = require('path');
const { spawn } = require('child_process');
const db = require('../db');
const { calcInvoiceTotals, round2 } = require('../utils');

const router = express.Router();
const PY = process.env.PYTHON_BIN || 'python3';
// Packaged into an .asar archive by electron-builder, these two script paths
// resolve to a location INSIDE that virtual archive — which is fine for
// Node's own fs/require calls (Electron transparently reads from asar), but
// NOT fine for spawning an external process: Python has no idea how to read
// from inside an asar blob. server/python/** is configured as "asarUnpack"
// in package.json specifically so these files exist for real on disk in a
// sibling app.asar.unpacked folder — this just points at that real location
// instead of the virtual one. No-op outside of a packaged Electron build.
function unpackedPath(p) {
  return p.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
}
const PDF_SCRIPT = unpackedPath(path.join(__dirname, '..', 'python', 'generate_pdf.py'));
const EXCEL_SCRIPT = unpackedPath(path.join(__dirname, '..', 'python', 'export_excel.py'));

function runPython(scriptPath, inputJson, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const proc = spawn(PY, [scriptPath]);
    const chunks = [];
    let stderr = '';

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill('SIGKILL');
      reject(new Error(`PDF/Excel generation timed out after ${timeoutMs / 1000}s. The Python process may be stuck — check that reportlab/openpyxl are installed correctly.`));
    }, timeoutMs);

    proc.stdout.on('data', d => chunks.push(d));
    proc.stderr.on('data', d => { stderr += d.toString(); });
    // CRITICAL: an 'error' event with no listener crashes the entire Node
    // process, not just this request (this is exactly what happened — see
    // the "write EOF" crash report). Writing to a child process's stdin can
    // throw EPIPE/EOF if the child exits or closes its stdin before (or
    // while) we're still writing to it — e.g. because it crashed on startup
    // (missing Python package) before it even got to reading stdin. That
    // must surface as a normal rejected promise / clean HTTP error, never
    // as an unhandled crash.
    proc.stdin.on('error', err => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`Could not send data to the Python process (${err.code || err.message}). It likely exited immediately — check that reportlab/openpyxl are installed for the Python interpreter at "${PY}".`));
    });

    proc.on('error', err => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    proc.on('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(stderr || `Python script exited with code ${code}`));
      resolve(Buffer.concat(chunks));
    });
    try {
      proc.stdin.write(JSON.stringify(inputJson));
      proc.stdin.end();
    } catch (e) {
      if (!settled) { settled = true; clearTimeout(timer); reject(e); }
    }
  });
}

function withCustomer(inv) {
  return { ...inv, customer: db.find('customers', inv.customerId) || null };
}

function filterInvoices(query) {
  const { search, status, from, to } = query;
  let list = [...db.list('invoices')].sort((a, b) => b.createdAt - a.createdAt);
  if (search) {
    const q = search.toLowerCase();
    list = list.filter(i => {
      const cust = db.find('customers', i.customerId);
      return i.number.toLowerCase().includes(q) || (cust && cust.name.toLowerCase().includes(q));
    });
  }
  if (status) list = list.filter(i => i.status === status);
  if (from) list = list.filter(i => i.date >= from);
  if (to) list = list.filter(i => i.date <= to);
  return list;
}

// GET /api/invoices — filtered, paginated list
router.get('/', (req, res) => {
  const list = filterInvoices(req.query).map(withCustomer);
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.max(1, Number(req.query.pageSize) || 5);
  const total = list.length;
  const start = (page - 1) * pageSize;
  const items = list.slice(start, start + pageSize);
  res.json({ items, total, page, pageSize });
});

// GET /api/invoices/:id
router.get('/:id', (req, res) => {
  const inv = db.find('invoices', req.params.id);
  if (!inv) return res.status(404).json({ error: 'Invoice not found.' });
  res.json(withCustomer(inv));
});

// POST /api/invoices — create
router.post('/', (req, res) => {
  const { customerId, date, dueDate, items, notes, terms, paymentTerms, status,
    additionalDiscount, additionalDiscountType, shippingAddress } = req.body || {};
  if (!customerId) return res.status(400).json({ error: 'A customer is required.' });
  const customer = db.find('customers', customerId);
  if (!customer) return res.status(400).json({ error: 'Customer not found.' });
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'At least one item is required.' });

  const settings = db.getSettings();
  const totals = calcInvoiceTotals(items, customer, settings, { value: additionalDiscount, type: additionalDiscountType });
  const number = settings.prefix + String(settings.nextNumber).padStart(5, '0');

  const invoice = db.insert('invoices', {
    number, customerId, date, dueDate, items,
    notes: notes || settings.notes,
    terms: terms || settings.terms,
    paymentTerms: paymentTerms || settings.paymentTerms,
    shippingAddress: shippingAddress || '',
    status: status || 'Draft',
    ...totals
  });

  db.updateSettings({ nextNumber: settings.nextNumber + 1 });
  res.status(201).json(withCustomer(invoice));
});

// PUT /api/invoices/:id — update (recompute totals, keep original number)
router.put('/:id', (req, res) => {
  const existing = db.find('invoices', req.params.id);
  if (!existing) return res.status(404).json({ error: 'Invoice not found.' });
  const { customerId, date, dueDate, items, notes, terms, paymentTerms, status,
    additionalDiscount, additionalDiscountType, shippingAddress } = req.body || {};
  const finalCustomerId = customerId || existing.customerId;
  const customer = db.find('customers', finalCustomerId);
  const finalItems = Array.isArray(items) && items.length ? items : existing.items;
  const settings = db.getSettings();
  const finalDiscount = additionalDiscount != null ? additionalDiscount : existing.additionalDiscount;
  const finalDiscountType = additionalDiscountType || existing.additionalDiscountType;
  const totals = calcInvoiceTotals(finalItems, customer, settings, { value: finalDiscount, type: finalDiscountType });

  const updated = db.update('invoices', req.params.id, {
    customerId: finalCustomerId,
    date: date ?? existing.date,
    dueDate: dueDate ?? existing.dueDate,
    items: finalItems,
    notes: notes ?? existing.notes,
    terms: terms ?? existing.terms,
    paymentTerms: paymentTerms ?? existing.paymentTerms,
    shippingAddress: shippingAddress ?? existing.shippingAddress,
    status: status ?? existing.status,
    ...totals
  });
  res.json(withCustomer(updated));
});

router.delete('/:id', (req, res) => {
  const ok = db.remove('invoices', req.params.id);
  if (!ok) return res.status(404).json({ error: 'Invoice not found.' });
  res.json({ ok: true });
});

// GET /api/invoices/:id/pdf — generated by the Python service (reportlab)
// Optional query params: ?format=a4|thermal  &template=modern|minimal|classic|bold|compact
router.get('/:id/pdf', async (req, res) => {
  const inv = db.find('invoices', req.params.id);
  if (!inv) return res.status(404).json({ error: 'Invoice not found.' });
  const customer = db.find('customers', inv.customerId);
  const settings = db.getSettings();
  const format = req.query.format === 'thermal' ? 'thermal' : 'a4';
  const template = req.query.template || undefined;

  // Payment/balance figures shown on the invoice itself (Received, Balance,
  // "You Saved" from discounts, and the customer's overall outstanding
  // balance across their other open invoices).
  const paidForThis = db.list('payments').filter(p => p.invoiceId === inv.id).reduce((s, p) => s + p.amount, 0);
  const balanceAmount = Math.max(0, round2(inv.grandTotal - paidForThis));
  const youSaved = round2((inv.itemDiscountTotal || 0) + (inv.additionalDiscountAmt || 0));
  const customerBalance = customer
    ? db.list('invoices')
      .filter(i => i.customerId === customer.id && (i.status === 'Pending' || i.status === 'Overdue'))
      .reduce((s, i) => {
        const paid = db.list('payments').filter(p => p.invoiceId === i.id).reduce((s2, p) => s2 + p.amount, 0);
        return s + Math.max(0, i.grandTotal - paid);
      }, 0)
    : 0;

  try {
    const pdfBuffer = await runPython(PDF_SCRIPT, {
      invoice: inv, customer, settings, format, template,
      receivedAmount: round2(paidForThis), balanceAmount, youSaved, customerBalance: round2(customerBalance)
    });
    const suffix = format === 'thermal' ? '-thermal' : '';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${inv.number}${suffix}.pdf"`);
    res.send(pdfBuffer);
  } catch (e) {
    console.error('PDF generation failed:', e.message);
    res.status(500).json({ error: 'Could not generate PDF. Is Python 3 with reportlab installed?', detail: e.message });
  }
});

// GET /api/invoices/export/excel — generated by the Python service (openpyxl)
router.get('/export/excel', async (req, res) => {
  const list = filterInvoices(req.query).map(withCustomer);
  if (!list.length) return res.status(400).json({ error: 'No invoices to export with the current filters.' });
  const settings = db.getSettings();
  try {
    const xlsxBuffer = await runPython(EXCEL_SCRIPT, { invoices: list, settings });
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="Shekhar-Compute-Invoices-${stamp}.xlsx"`);
    res.send(xlsxBuffer);
  } catch (e) {
    console.error('Excel export failed:', e.message);
    res.status(500).json({ error: 'Could not generate Excel file. Is Python 3 with openpyxl installed?', detail: e.message });
  }
});

module.exports = router;
