/* =========================================================================
   Shekhar Compute Tech Services — Invoicing frontend
   Vanilla JS. Talks to the Node/Express API in server/ over fetch().
   PDF and Excel files are generated server-side by Python (see server/python/).
   ========================================================================= */

/* ---------------------------- Currency / formatting ---------------------------- */
const CURRENCY_META = {
  INR: { symbol: '₹', locale: 'en-IN' },
  USD: { symbol: '$', locale: 'en-US' }
};
function curMeta() { return CURRENCY_META[cache.settings?.currency] || CURRENCY_META.INR; }
function fmt(n) {
  const m = curMeta();
  return m.symbol + (Number(n) || 0).toLocaleString(m.locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtDate(d) {
  if (!d) return '-';
  const dt = new Date(d + 'T00:00:00');
  if (isNaN(dt)) return d;
  return dt.toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric' });
}
function todayISO() { return new Date().toISOString().slice(0, 10); }
function addDays(iso, days) { const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + days); return d.toISOString().slice(0, 10); }

/* Client-side mirror of the server's GST calculation (server/utils.js) —
   used only for instant on-screen totals while building an invoice.
   The server recomputes and stores the authoritative numbers on save.
   Mirrors the same proportional-allocation approach for the overall
   invoice-level discount so on-screen tax figures match what gets saved. */
function calcInvoiceTotals(items, customer, settings, overallDiscount) {
  const gstEnabled = settings.taxType !== 'Non-GST';
  const odValue = Number(overallDiscount?.value) || 0;
  const odType = overallDiscount?.type === 'flat' ? 'flat' : 'percent';

  let subtotal = 0, itemDiscountTotal = 0;
  const lines = items.map(it => {
    const qty = Number(it.qty) || 0, rate = Number(it.rate) || 0;
    const discount = Number(it.discount) || 0;
    const discountType = it.discountType === 'flat' ? 'flat' : 'percent';
    const gst = Number(it.gst) || 0;
    const gross = qty * rate;
    const itemDiscAmt = discountType === 'flat' ? Math.min(discount, gross) : gross * discount / 100;
    const lineTaxable = gross - itemDiscAmt;
    subtotal += gross; itemDiscountTotal += itemDiscAmt;
    return { lineTaxable, gst };
  });

  const sumTaxableBeforeOverall = lines.reduce((s, l) => s + l.lineTaxable, 0);
  const overallDiscountAmt = Math.max(0, Math.min(
    odType === 'flat' ? odValue : sumTaxableBeforeOverall * odValue / 100,
    sumTaxableBeforeOverall
  ));

  let totalTax = 0;
  lines.forEach(l => {
    const share = sumTaxableBeforeOverall > 0 ? l.lineTaxable / sumTaxableBeforeOverall : 0;
    const allocatedDiscount = overallDiscountAmt * share;
    totalTax += gstEnabled ? (l.lineTaxable - allocatedDiscount) * l.gst / 100 : 0;
  });

  const taxable = sumTaxableBeforeOverall - overallDiscountAmt;
  const discountTotal = itemDiscountTotal + overallDiscountAmt;
  const sameState = customer ? (customer.state || '').trim().toLowerCase() === (settings.businessState || '').trim().toLowerCase() : true;
  let cgst = 0, sgst = 0, igst = 0;
  if (gstEnabled) { if (sameState) { cgst = totalTax / 2; sgst = totalTax / 2; } else { igst = totalTax; } }
  return {
    subtotal, itemDiscountTotal, additionalDiscountAmt: overallDiscountAmt, discountTotal,
    taxable, cgst, sgst, igst, totalTax, grandTotal: taxable + totalTax, sameState, gstEnabled
  };
}

function shadeColor(hex, percent) {
  hex = (hex || '#1E3A8A').replace('#', '');
  if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
  let f = parseInt(hex, 16), t = percent < 0 ? 0 : 255, p = percent < 0 ? percent * -1 : percent;
  let R = f >> 16, G = f >> 8 & 0x00FF, B = f & 0x0000FF;
  return "#" + (0x1000000 + (Math.round((t - R) * p) + R) * 0x10000 + (Math.round((t - G) * p) + G) * 0x100 + (Math.round((t - B) * p) + B)).toString(16).slice(1);
}
function applyPrimaryColor(hex) {
  hex = hex || '#1E3A8A';
  document.documentElement.style.setProperty('--primary', hex);
  document.documentElement.style.setProperty('--primary-dark', shadeColor(hex, -0.25));
  document.documentElement.style.setProperty('--primary-light', shadeColor(hex, 0.87));
}
function renderLogoEverywhere() {
  const url = cache.settings?.logoDataUrl;
  document.querySelectorAll('#sidebar-logo, #lb-logo').forEach(el => {
    el.innerHTML = url ? `<img src="${url}" style="width:100%;height:100%;object-fit:contain;border-radius:inherit;">` : 'S';
  });
}
function applyDarkModePreference() {
  if (localStorage.getItem('shekhar_dark') === '1') document.documentElement.classList.add('dark');
}

/* ---------------------------- In-memory cache ---------------------------- */
// Customers/products/settings are small and read constantly across pages,
// so we cache them client-side and refresh after any mutation.
const cache = { customers: [], products: [], settings: {} };

async function refreshCustomers() { cache.customers = await api.get('/customers'); return cache.customers; }
async function refreshProducts() { cache.products = await api.get('/products'); return cache.products; }
async function refreshSettings() { cache.settings = await api.get('/settings'); return cache.settings; }
function getCustomer(id) { return cache.customers.find(c => c.id === id); }

async function loadCoreData() {
  await Promise.all([refreshCustomers(), refreshProducts(), refreshSettings()]);
}

/* ---------------------------- Auth ---------------------------- */
function showLogin() {
  document.getElementById('app').style.display = 'none';
  document.getElementById('login-screen').style.display = 'flex';
  document.getElementById('login-password').value = '';
  document.getElementById('login-error').classList.remove('show');
  setTimeout(() => document.getElementById('login-email').focus(), 50);
}
async function enterApp() {
  await loadCoreData();
  applyPrimaryColor(cache.settings.primaryColor);
  renderLogoEverywhere();
  renderSidebarFoot();
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('app').style.display = 'flex';
  goPage('dashboard');
}
function doLogout() {
  api.clearToken();
  editingInvoiceId = null; draftItems = [];
  showLogin();
}
window.onSessionExpired = () => showLogin();

async function attemptLogin() {
  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  const remember = document.getElementById('login-remember').checked;
  const errEl = document.getElementById('login-error');
  errEl.classList.remove('show');
  if (!email || !password) {
    errEl.textContent = 'Please enter both email and password.'; errEl.classList.add('show'); return;
  }
  try {
    const data = await api.post('/auth/login', { email, password });
    api.setToken(data.token, remember);
    await enterApp();
  } catch (e) {
    errEl.textContent = e.message || 'Incorrect email or password.';
    errEl.classList.add('show');
  }
}
document.getElementById('login-submit').addEventListener('click', attemptLogin);
document.getElementById('login-password').addEventListener('keydown', e => { if (e.key === 'Enter') attemptLogin(); });
document.getElementById('login-email').addEventListener('keydown', e => { if (e.key === 'Enter') attemptLogin(); });
document.getElementById('login-pw-toggle').addEventListener('click', () => {
  const pw = document.getElementById('login-password');
  pw.type = pw.type === 'password' ? 'text' : 'password';
});
document.getElementById('login-forgot').addEventListener('click', () => {
  openModal('Forgot password', `<p style="font-size:13.5px;color:var(--text-soft);line-height:1.6;">This app has no email server connected, so password resets can't be sent automatically. As the admin, reset it directly from <b>Profile → Security</b> once signed in, or check the server console for the first-run credentials.</p>`,
    [{ label: 'Got it', cls: 'btn-primary', action: closeModal }]);
});

/* ---------------------------- Router ---------------------------- */
const PAGE_TITLES = {
  dashboard: 'Dashboard', 'create-invoice': 'Create Invoice', invoices: 'Invoices', customers: 'Customers',
  products: 'Products / Services', payments: 'Payments', expenses: 'Expenses', reports: 'Reports & Analytics',
  settings: 'Settings', profile: 'Profile'
};
function goPage(page) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById('page-' + page).classList.add('active');
  document.querySelectorAll('#sidebar .nav-item[data-page]').forEach(n => n.classList.toggle('active', n.dataset.page === page));
  document.getElementById('page-title').textContent = PAGE_TITLES[page] || page;
  document.getElementById('sidebar').classList.remove('open');
  const renderers = {
    dashboard: renderDashboard, 'create-invoice': () => renderCreateInvoice(), invoices: renderInvoices,
    customers: renderCustomers, products: renderProducts, payments: renderPayments, expenses: renderExpenses,
    reports: renderReports, settings: renderSettings, profile: renderProfile
  };
  if (renderers[page]) renderers[page]();
  window.scrollTo(0, 0);
}
document.querySelectorAll('#sidebar .nav-item[data-page]').forEach(n => n.addEventListener('click', () => goPage(n.dataset.page)));
document.getElementById('new-invoice-btn').addEventListener('click', () => { editingInvoiceId = null; draftItems = []; goPage('create-invoice'); });
document.getElementById('hamburger').addEventListener('click', () => document.getElementById('sidebar').classList.toggle('open'));
document.getElementById('logout-btn').addEventListener('click', () => {
  openModal('Log out?', '<p style="font-size:13.5px;color:var(--text-soft);">You\'ll need to sign in again to access the workspace.</p>',
    [{ label: 'Cancel', cls: 'btn-outline', action: closeModal }, { label: 'Log out', cls: 'btn-primary', action: () => { closeModal(); doLogout(); } }]);
});
document.getElementById('dark-toggle').addEventListener('click', () => {
  document.documentElement.classList.toggle('dark');
  localStorage.setItem('shekhar_dark', document.documentElement.classList.contains('dark') ? '1' : '0');
});

/* ---------------------------- Modal helpers ---------------------------- */
function openModal(title, bodyHtml, buttons) {
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-body').innerHTML = bodyHtml;
  const foot = document.getElementById('modal-foot');
  foot.innerHTML = '';
  buttons.forEach(b => {
    const btn = document.createElement('button');
    btn.className = 'btn ' + b.cls; btn.textContent = b.label;
    btn.addEventListener('click', b.action);
    foot.appendChild(btn);
  });
  document.getElementById('modal-overlay').classList.add('open');
}
function closeModal() { document.getElementById('modal-overlay').classList.remove('open'); }
document.getElementById('modal-close').addEventListener('click', closeModal);
document.getElementById('modal-overlay').addEventListener('click', e => { if (e.target.id === 'modal-overlay') closeModal(); });
function shake(id) { const e = document.getElementById(id); e.style.borderColor = 'var(--red)'; e.focus(); setTimeout(() => e.style.borderColor = '', 1200); }
function val(id) { return document.getElementById(id).value; }
function statusBadge(status) {
  const map = { Draft: 'badge-draft', Paid: 'badge-paid', Pending: 'badge-pending', Overdue: 'badge-overdue', Cancelled: 'badge-cancelled' };
  return `<span class="badge ${map[status] || 'badge-draft'}">${status}</span>`;
}
async function withErrorAlert(fn) {
  try { return await fn(); } catch (e) { alert(e.message || 'Something went wrong.'); throw e; }
}

/* ---------------------------- Icons (shared) ---------------------------- */
function iconInvoices() { return `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 2h9l5 5v15H6z"/><path d="M9 12h6M9 16h6M9 8h2"/></svg>`; }
function iconRupee() { return `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 4h11M6 9h11M9 4c3 0 5 1.5 5 4s-2 4-5 4h-2l7 7"/></svg>`; }
function iconClock() { return `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>`; }
function iconCheck() { return `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M8 12l3 3 5-6"/></svg>`; }
function statCard(bg, color, label, value, sub, icon) {
  return `<div class="card stat-card"><div class="stat-icon" style="background:${bg};color:${color};">${icon}</div><div><div class="stat-label">${label}</div><div class="stat-value">${value}</div><div class="stat-sub">${sub}</div></div></div>`;
}
function offlineNoticeHtml(data) {
  if (!data || !data._offline) return '';
  const when = data._cachedAt ? new Date(data._cachedAt).toLocaleString('en-IN') : 'earlier';
  return `<div style="display:flex;align-items:center;gap:8px;background:var(--amber-bg);color:var(--amber);font-size:12.5px;font-weight:600;padding:9px 14px;border-radius:9px;margin-bottom:16px;">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="flex-shrink:0;"><path d="M1 1l22 22M16.7 16.7A9 9 0 015 5"/><path d="M9 9a3 3 0 014.2 0"/></svg>
    You're offline — showing data cached from ${when}.
  </div>`;
}

/* ---------------------------- Dashboard ---------------------------- */
async function renderDashboard() {
  const el = document.getElementById('page-dashboard');
  el.innerHTML = `<div class="empty-state">Loading dashboard…</div>`;
  let d;
  try { d = await api.get('/reports/dashboard'); } catch (e) { el.innerHTML = `<div class="empty-state">Could not load dashboard: ${e.message}</div>`; return; }

  el.innerHTML = `
    ${offlineNoticeHtml(d)}
    <div class="grid-4" style="margin-bottom:22px;">
      ${statCard('#EAF0FE', 'var(--primary)', 'Total Invoices', d.totalInvoices, 'All time', iconInvoices())}
      ${statCard('var(--green-bg)', 'var(--green)', 'Total Revenue', fmt(d.totalRevenue), 'All time', iconRupee())}
      ${statCard('var(--amber-bg)', 'var(--amber)', 'Pending Amount', fmt(d.pendingAmount), `From ${d.pendingCount} invoices`, iconClock())}
      ${statCard('#EDE9FE', '#6D28D9', 'Paid Amount', fmt(d.paidAmount), 'All time', iconCheck())}
    </div>
    <div class="grid-2" style="align-items:start;">
      <div class="card">
        <div class="section-title" style="display:flex;justify-content:space-between;align-items:center;">Recent Invoices <span style="cursor:pointer;color:var(--primary);font-size:12.5px;font-weight:600;" data-goto="invoices">View all →</span></div>
        <table><thead><tr><th>Invoice</th><th>Customer</th><th>Amount</th><th>Status</th></tr></thead>
        <tbody>
        ${d.recentInvoices.length ? d.recentInvoices.map(i => `<tr><td class="mono">${i.number}</td><td>${i.customer ? i.customer.name : '—'}</td><td>${fmt(i.grandTotal)}</td><td>${statusBadge(i.status)}</td></tr>`).join('') : `<tr><td colspan="4" class="empty-state">No invoices yet</td></tr>`}
        </tbody></table>
      </div>
      <div class="card" style="padding:20px;">
        <div style="font-size:14px;font-weight:700;margin-bottom:16px;">Quick actions</div>
        <div style="display:flex;flex-direction:column;gap:10px;">
          <button class="btn btn-primary" style="justify-content:flex-start;" data-goto="create-invoice">+ Create new invoice</button>
          <button class="btn btn-outline" style="justify-content:flex-start;" data-goto="customers">+ Add customer</button>
          <button class="btn btn-outline" style="justify-content:flex-start;" data-goto="products">+ Add product / service</button>
          <button class="btn btn-outline" style="justify-content:flex-start;" data-goto="reports">View reports</button>
        </div>
        <div style="margin-top:22px;padding-top:16px;border-top:1px solid var(--border);">
          <div style="font-size:12.5px;color:var(--text-soft);margin-bottom:6px;">Business</div>
          <div style="font-size:13px;font-weight:700;">${cache.settings.businessName}</div>
          <div style="font-size:11.5px;color:var(--text-faint);margin-top:3px;">${cache.settings.udyam}</div>
        </div>
      </div>
    </div>
  `;
  el.querySelectorAll('[data-goto]').forEach(b => b.addEventListener('click', () => goPage(b.dataset.goto)));
}

/* ---------------------------- Create Invoice ---------------------------- */
let draftItems = [];
let editingInvoiceId = null;

function newItemRow() { return { desc: '', hsn: '', qty: 1, rate: 0, discount: 0, discountType: 'percent', gst: cache.settings.defaultGst || 18 }; }

async function renderCreateInvoice(loadInvoiceId) {
  editingInvoiceId = loadInvoiceId || editingInvoiceId;
  let editing = null;
  if (editingInvoiceId) {
    try { editing = await api.get('/invoices/' + editingInvoiceId); } catch (e) { alert(e.message); editingInvoiceId = null; }
  }
  if (editing) { draftItems = JSON.parse(JSON.stringify(editing.items)); }
  else if (!draftItems.length) { draftItems = [newItemRow()]; }

  const el = document.getElementById('page-create-invoice');
  const s = cache.settings;
  const invNumber = editing ? editing.number : (s.prefix + String(s.nextNumber).padStart(5, '0'));
  const invDate = editing ? editing.date : todayISO();
  const dueDate = editing ? editing.dueDate : addDays(todayISO(), 10);

  el.innerHTML = `
  <div class="card" style="margin-bottom:20px;">
    <div class="section-title">${editing ? 'Edit Invoice ' + editing.number : 'Create New Invoice'}</div>
    <div style="padding:20px;">
      <div class="grid-3" style="margin-bottom:4px;">
        <div class="field">
          <label>Customer *</label>
          <div style="display:flex;gap:8px;">
            <select id="ci-customer" style="flex:1;">
              <option value="">Select customer</option>
              ${cache.customers.map(c => `<option value="${c.id}" ${editing && editing.customerId === c.id ? 'selected' : ''}>${c.name}</option>`).join('')}
            </select>
            <button class="btn btn-outline" id="ci-add-customer" style="padding:9px 12px;">+ New</button>
          </div>
        </div>
        <div class="field"><label>Invoice Date *</label><input type="date" id="ci-date" value="${invDate}"></div>
        <div class="field"><label>Due Date *</label><input type="date" id="ci-due" value="${dueDate}"></div>
      </div>
      <div class="grid-3" style="margin-bottom:4px;">
        <div class="field" style="max-width:260px;">
          <label>Invoice Number</label>
          <input type="text" id="ci-number" value="${invNumber}" class="mono" readonly style="background:var(--bg);color:var(--text-faint);">
          <div style="font-size:11px;color:var(--text-faint);margin-top:4px;">${editing ? 'Numbers are fixed once created.' : 'Assigned by the server when you save.'}</div>
        </div>
        <div class="field">
          <label>Status</label>
          <select id="ci-status">
            ${['Draft', 'Pending', 'Paid', 'Overdue', 'Cancelled'].map(st => `<option value="${st}" ${(editing ? editing.status : 'Draft') === st ? 'selected' : ''}>${st}</option>`).join('')}
          </select>
          <div style="font-size:11px;color:var(--text-faint);margin-top:4px;">Save Draft / Generate Invoice still set this automatically unless you change it here.</div>
        </div>
        <div class="field">
          <label>Shipping Address (optional)</label>
          <input type="text" id="ci-shipping" value="${editing ? (editing.shippingAddress || '') : ''}" placeholder="Leave blank to use billing address">
        </div>
      </div>

      <div style="margin-top:18px;">
        <label style="margin:0 0 6px;">Items</label>
        <div class="item-row-head">
          <div>#</div><div>Description</div><div>HSN/SAC</div><div>Qty</div><div>Rate (${curMeta().symbol})</div><div>Discount</div><div>GST %</div><div>Amount (${curMeta().symbol})</div><div></div>
        </div>
        <div id="ci-items"></div>
        <button class="btn btn-ghost" id="ci-add-item" style="margin-top:8px;color:var(--primary);"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M12 5v14M5 12h14"/></svg>Add Item</button>
      </div>

      <div style="display:flex;justify-content:flex-end;margin-top:18px;gap:16px;flex-wrap:wrap;">
        <div class="field" style="width:300px;margin-bottom:0;">
          <label>Additional Discount (on total)</label>
          <div style="display:flex;gap:6px;">
            <input type="number" id="ci-overall-discount" min="0" step="0.01" value="${editing ? (editing.additionalDiscount || 0) : 0}" style="flex:1;">
            <select id="ci-overall-discount-type" style="width:90px;">
              <option value="percent" ${(!editing || editing.additionalDiscountType !== 'flat') ? 'selected' : ''}>%</option>
              <option value="flat" ${editing && editing.additionalDiscountType === 'flat' ? 'selected' : ''}>${curMeta().symbol}</option>
            </select>
          </div>
          <div style="font-size:11px;color:var(--text-faint);margin-top:4px;">Applied on top of item discounts, before tax.</div>
        </div>
        <div style="width:300px;" id="ci-totals"></div>
      </div>

      <div class="grid-2" style="margin-top:6px;">
        <div class="field"><label>Notes</label><textarea id="ci-notes" rows="5">${editing ? editing.notes : s.notes}</textarea></div>
        <div class="field"><label>Terms & Conditions</label><textarea id="ci-terms" rows="5">${editing ? editing.terms : s.terms}</textarea></div>
      </div>
      <div class="grid-2">
        <div class="field"><label>Payment Terms</label><textarea id="ci-payment-terms" rows="5">${editing ? editing.paymentTerms : s.paymentTerms}</textarea></div>
        <div class="field"><label>Bank / UPI Details</label><input type="text" id="ci-bank" value="${s.bankName} · A/C ${s.bankAccount} · IFSC ${s.bankIfsc}${s.upiId ? ' · UPI ' + s.upiId : ''}" readonly style="background:var(--bg);color:var(--text-faint);"></div>
      </div>

      <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:10px;flex-wrap:wrap;">
        <button class="btn btn-outline" id="ci-cancel">Cancel</button>
        <button class="btn btn-outline" id="ci-save-draft">Save Draft</button>
        <button class="btn btn-outline" id="ci-preview"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>Save & Preview</button>
        <button class="btn btn-primary" id="ci-generate">Generate Invoice</button>
      </div>
    </div>
  </div>`;

  renderItemRows();
  updateTotals();

  document.getElementById('ci-add-item').addEventListener('click', () => { draftItems.push(newItemRow()); renderItemRows(); updateTotals(); });
  document.getElementById('ci-add-customer').addEventListener('click', () => openAddCustomerModal());
  document.getElementById('ci-customer').addEventListener('change', updateTotals);
  document.getElementById('ci-overall-discount').addEventListener('input', updateTotals);
  document.getElementById('ci-overall-discount-type').addEventListener('change', updateTotals);
  document.getElementById('ci-cancel').addEventListener('click', () => { editingInvoiceId = null; draftItems = []; goPage('dashboard'); });
  document.getElementById('ci-save-draft').addEventListener('click', () => { document.getElementById('ci-status').value = 'Draft'; saveInvoice(null, false); });
  document.getElementById('ci-preview').addEventListener('click', () => saveInvoice(null, true));
  document.getElementById('ci-generate').addEventListener('click', () => {
    const sel = document.getElementById('ci-status');
    if (sel.value === 'Draft') sel.value = 'Pending';
    saveInvoice(null, true);
  });
}

function renderItemRows() {
  const wrap = document.getElementById('ci-items');
  wrap.innerHTML = draftItems.map((it, idx) => {
    const gross = it.qty * it.rate;
    const disc = it.discountType === 'flat' ? Math.min(it.discount || 0, gross) : gross * (it.discount || 0) / 100;
    const amt = gross - disc;
    return `<div class="item-row-grid" data-idx="${idx}">
      <div style="color:var(--text-faint);font-size:12px;">${idx + 1}</div>
      <input type="text" class="it-desc" placeholder="Item / description" value="${(it.desc || '').replace(/"/g, '&quot;')}" list="product-list">
      <input type="text" class="it-hsn" placeholder="HSN" value="${it.hsn || ''}">
      <input type="number" class="it-qty" min="0" step="1" value="${it.qty}">
      <input type="number" class="it-rate" min="0" step="0.01" value="${it.rate}">
      <div style="display:flex;gap:3px;">
        <input type="number" class="it-disc" min="0" step="0.01" value="${it.discount}" style="min-width:0;">
        <select class="it-disc-type" style="width:52px;padding:9px 2px;flex-shrink:0;">
          <option value="percent" ${it.discountType !== 'flat' ? 'selected' : ''}>%</option>
          <option value="flat" ${it.discountType === 'flat' ? 'selected' : ''}>${curMeta().symbol}</option>
        </select>
      </div>
      <input type="number" class="it-gst" min="0" max="28" step="0.5" value="${it.gst}">
      <div class="mono" style="font-weight:600;text-align:right;padding-right:4px;">${amt.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
      <div style="cursor:pointer;color:var(--red);text-align:center;" class="it-del" title="Delete row"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m2 0v14a2 2 0 01-2 2H8a2 2 0 01-2-2V6h12z"/></svg></div>
    </div>`;
  }).join('') + `<datalist id="product-list">${cache.products.map(p => `<option value="${p.name}">`).join('')}</datalist>`;

  wrap.querySelectorAll('.item-row-grid').forEach(row => {
    const idx = Number(row.dataset.idx);
    row.querySelector('.it-desc').addEventListener('input', e => {
      draftItems[idx].desc = e.target.value;
      const prod = cache.products.find(p => p.name === e.target.value);
      if (prod) {
        draftItems[idx].hsn = prod.hsn; draftItems[idx].rate = prod.rate; draftItems[idx].gst = prod.gst;
        renderItemRows(); updateTotals();
      }
    });
    row.querySelector('.it-hsn').addEventListener('input', e => { draftItems[idx].hsn = e.target.value; });
    row.querySelector('.it-qty').addEventListener('input', e => { draftItems[idx].qty = Number(e.target.value) || 0; refreshRowAmount(row, idx); updateTotals(); });
    row.querySelector('.it-rate').addEventListener('input', e => { draftItems[idx].rate = Number(e.target.value) || 0; refreshRowAmount(row, idx); updateTotals(); });
    row.querySelector('.it-disc').addEventListener('input', e => { draftItems[idx].discount = Number(e.target.value) || 0; refreshRowAmount(row, idx); updateTotals(); });
    row.querySelector('.it-disc-type').addEventListener('change', e => { draftItems[idx].discountType = e.target.value; refreshRowAmount(row, idx); updateTotals(); });
    row.querySelector('.it-gst').addEventListener('input', e => { draftItems[idx].gst = Number(e.target.value) || 0; updateTotals(); });
    row.querySelector('.it-del').addEventListener('click', () => {
      if (draftItems.length === 1) { draftItems[0] = newItemRow(); } else { draftItems.splice(idx, 1); }
      renderItemRows(); updateTotals();
    });
  });
}
function refreshRowAmount(row, idx) {
  const it = draftItems[idx];
  const gross = it.qty * it.rate;
  const disc = it.discountType === 'flat' ? Math.min(it.discount || 0, gross) : gross * (it.discount || 0) / 100;
  const amt = gross - disc;
  row.querySelector('.mono').textContent = amt.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function updateTotals() {
  const custId = document.getElementById('ci-customer')?.value;
  const customer = getCustomer(custId);
  const odValue = Number(document.getElementById('ci-overall-discount')?.value) || 0;
  const odType = document.getElementById('ci-overall-discount-type')?.value || 'percent';
  const t = calcInvoiceTotals(draftItems, customer, cache.settings, { value: odValue, type: odType });
  document.getElementById('ci-totals').innerHTML = `
    <div style="display:flex;justify-content:space-between;padding:5px 0;font-size:13px;"><span style="color:var(--text-soft);">Subtotal</span><span class="mono">${fmt(t.subtotal)}</span></div>
    ${t.itemDiscountTotal > 0 ? `<div style="display:flex;justify-content:space-between;padding:5px 0;font-size:13px;"><span style="color:var(--text-soft);">Item Discounts</span><span class="mono" style="color:var(--red);">-${fmt(t.itemDiscountTotal)}</span></div>` : ''}
    ${t.additionalDiscountAmt > 0 ? `<div style="display:flex;justify-content:space-between;padding:5px 0;font-size:13px;"><span style="color:var(--text-soft);">Additional Discount</span><span class="mono" style="color:var(--red);">-${fmt(t.additionalDiscountAmt)}</span></div>` : ''}
    ${!t.gstEnabled ? `<div style="display:flex;justify-content:space-between;padding:5px 0;font-size:12.5px;color:var(--text-faint);font-style:italic;">Tax not applicable (Non-GST invoicing)</div>` :
      t.sameState ? `
    <div style="display:flex;justify-content:space-between;padding:5px 0;font-size:13px;"><span style="color:var(--text-soft);">CGST</span><span class="mono">${fmt(t.cgst)}</span></div>
    <div style="display:flex;justify-content:space-between;padding:5px 0;font-size:13px;"><span style="color:var(--text-soft);">SGST</span><span class="mono">${fmt(t.sgst)}</span></div>
    ` : `<div style="display:flex;justify-content:space-between;padding:5px 0;font-size:13px;"><span style="color:var(--text-soft);">IGST</span><span class="mono">${fmt(t.igst)}</span></div>`}
    <div style="display:flex;justify-content:space-between;padding:5px 0;font-size:13px;border-top:1px solid var(--border);margin-top:4px;padding-top:9px;"><span style="color:var(--text-soft);">Total Tax</span><span class="mono">${fmt(t.totalTax)}</span></div>
    <div style="display:flex;justify-content:space-between;padding:11px 14px;background:var(--primary);color:#fff;border-radius:9px;margin-top:8px;font-weight:800;font-size:15px;"><span>Grand Total</span><span class="mono">${fmt(t.grandTotal)}</span></div>
  `;
}

function openAddCustomerModal() {
  openModal('Add New Customer', `
    <div class="field"><label>Customer Name *</label><input type="text" id="nc-name"></div>
    <div class="field"><label>Mobile *</label><input type="text" id="nc-mobile"></div>
    <div class="field"><label>Email</label><input type="email" id="nc-email"></div>
    <div class="field"><label>Address</label><textarea id="nc-address" rows="2"></textarea></div>
    <div class="grid-2">
      <div class="field"><label>State</label><input type="text" id="nc-state" value="Bihar"></div>
      <div class="field"><label>GSTIN (if applicable)</label><input type="text" id="nc-gstin"></div>
    </div>
  `, [
    { label: 'Cancel', cls: 'btn-outline', action: closeModal },
    {
      label: 'Add Customer', cls: 'btn-primary', action: async () => {
        const name = document.getElementById('nc-name').value.trim();
        const mobile = document.getElementById('nc-mobile').value.trim();
        if (!name || !mobile) { shake('nc-name'); return; }
        try {
          const c = await api.post('/customers', {
            name, mobile, email: document.getElementById('nc-email').value.trim(),
            address: document.getElementById('nc-address').value.trim(),
            state: document.getElementById('nc-state').value.trim() || 'Bihar',
            gstin: document.getElementById('nc-gstin').value.trim()
          });
          await refreshCustomers();
          closeModal();
          const sel = document.getElementById('ci-customer');
          if (sel) { const opt = document.createElement('option'); opt.value = c.id; opt.textContent = c.name; sel.appendChild(opt); sel.value = c.id; updateTotals(); }
          if (document.getElementById('page-customers').classList.contains('active')) renderCustomers();
        } catch (e) { alert(e.message); }
      }
    }
  ]);
}

async function saveInvoice(status, preview) {
  const customerId = document.getElementById('ci-customer').value;
  if (!customerId) { shake('ci-customer'); alert('Please select a customer.'); return; }
  const items = draftItems.filter(it => (it.desc || '').trim() !== '' || it.qty > 0);
  if (!items.length) { alert('Please add at least one item.'); return; }
  const payload = {
    customerId,
    date: document.getElementById('ci-date').value || todayISO(),
    dueDate: document.getElementById('ci-due').value || addDays(todayISO(), 10),
    items,
    notes: document.getElementById('ci-notes').value,
    terms: document.getElementById('ci-terms').value,
    paymentTerms: document.getElementById('ci-payment-terms').value,
    shippingAddress: document.getElementById('ci-shipping').value,
    additionalDiscount: Number(document.getElementById('ci-overall-discount').value) || 0,
    additionalDiscountType: document.getElementById('ci-overall-discount-type').value,
    status: status || document.getElementById('ci-status').value
  };

  try {
    const invoice = editingInvoiceId
      ? await api.put('/invoices/' + editingInvoiceId, payload)
      : await api.post('/invoices', payload);
    await refreshSettings(); // nextNumber changed
    editingInvoiceId = null; draftItems = [];
    if (preview) { openPdfPreview(invoice.id, invoice.number); }
    else { goPage('invoices'); }
  } catch (e) { alert(e.message); }
}

/* ---------------------------- PDF preview (real PDF from Python/ReportLab) ---------------------------- */
let currentPreviewInvoiceId = null;
let currentPreviewBlobUrl = null;

function pdfQueryString() {
  const format = document.getElementById('pdf-format').value;
  const params = new URLSearchParams({ format });
  if (format !== 'thermal') params.set('template', document.getElementById('pdf-template').value);
  return params.toString();
}

async function fetchAndShowPdf() {
  document.getElementById('pdf-loading').style.display = 'flex';
  document.getElementById('pdf-loading').textContent = 'Generating PDF…';
  const frame = document.getElementById('pdf-frame');
  frame.style.display = 'none';
  try {
    const blob = await api.getBlob(`/invoices/${currentPreviewInvoiceId}/pdf?` + pdfQueryString());
    if (currentPreviewBlobUrl) URL.revokeObjectURL(currentPreviewBlobUrl);
    currentPreviewBlobUrl = URL.createObjectURL(blob);
    frame.src = currentPreviewBlobUrl;
    frame.style.display = 'block';
    document.getElementById('pdf-loading').style.display = 'none';
  } catch (e) {
    document.getElementById('pdf-loading').textContent = 'Could not generate PDF: ' + e.message;
  }
}

async function openPdfPreview(id, number) {
  currentPreviewInvoiceId = id;
  document.getElementById('pdf-title').textContent = number ? `Invoice ${number}` : 'Invoice';
  document.getElementById('pdf-format').value = cache.settings.defaultPaperSize || 'a4';
  document.getElementById('pdf-template').value = cache.settings.template || 'modern';
  document.getElementById('pdf-template').style.display = document.getElementById('pdf-format').value === 'thermal' ? 'none' : '';
  document.getElementById('pdf-preview-overlay').classList.add('open');
  await fetchAndShowPdf();
}
document.getElementById('pdf-format').addEventListener('change', e => {
  document.getElementById('pdf-template').style.display = e.target.value === 'thermal' ? 'none' : '';
  fetchAndShowPdf();
});
document.getElementById('pdf-template').addEventListener('change', fetchAndShowPdf);

function closePdfPreview() {
  document.getElementById('pdf-preview-overlay').classList.remove('open');
  document.getElementById('pdf-frame').src = '';
  if (document.getElementById('page-invoices').classList.contains('active')) renderInvoices();
}
document.getElementById('pdf-close').addEventListener('click', closePdfPreview);
document.getElementById('pdf-download').addEventListener('click', () => {
  if (!currentPreviewBlobUrl) return;
  const suffix = document.getElementById('pdf-format').value === 'thermal' ? '-thermal' : '';
  const a = document.createElement('a');
  a.href = currentPreviewBlobUrl;
  a.download = (document.getElementById('pdf-title').textContent || 'invoice').replace(/\s+/g, '-') + suffix + '.pdf';
  document.body.appendChild(a); a.click(); a.remove();
});
document.getElementById('pdf-print').addEventListener('click', () => {
  const frame = document.getElementById('pdf-frame');
  try { frame.contentWindow.focus(); frame.contentWindow.print(); }
  catch (e) { window.open(currentPreviewBlobUrl, '_blank'); }
});
document.getElementById('pdf-share').addEventListener('click', async () => {
  if (navigator.share && currentPreviewBlobUrl) {
    try {
      const resp = await fetch(currentPreviewBlobUrl);
      const blob = await resp.blob();
      const file = new File([blob], 'invoice.pdf', { type: 'application/pdf' });
      await navigator.share({ title: document.getElementById('pdf-title').textContent, files: [file] });
    } catch (e) { /* user cancelled or share failed silently */ }
  } else {
    alert('Sharing is not available in this browser. Use Download PDF instead.');
  }
});

/* ---------------------------- Invoices list ---------------------------- */
let invoiceFilters = { search: '', status: '', from: '', to: '' };
let invPage = 1;
const INV_PAGE_SIZE = 5;

function renderInvoices() {
  const el = document.getElementById('page-invoices');
  el.innerHTML = `
    <div id="inv-offline-notice"></div>
    <div class="card">
      <div style="display:flex;flex-wrap:wrap;gap:10px;align-items:center;padding:16px 20px;border-bottom:1px solid var(--border);">
        <div style="flex:1;min-width:180px;position:relative;">
          <input type="text" id="inv-search" placeholder="Search invoices..." value="${invoiceFilters.search}" style="padding-left:34px;">
          <svg width="15" height="15" style="position:absolute;left:11px;top:50%;transform:translateY(-50%);color:var(--text-faint);" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.35-4.35"/></svg>
        </div>
        <select id="inv-status" style="width:150px;">
          <option value="">All statuses</option>
          ${['Draft', 'Paid', 'Pending', 'Overdue', 'Cancelled'].map(s => `<option ${invoiceFilters.status === s ? 'selected' : ''}>${s}</option>`).join('')}
        </select>
        <input type="date" id="inv-from" value="${invoiceFilters.from}" style="width:150px;">
        <input type="date" id="inv-to" value="${invoiceFilters.to}" style="width:150px;">
        <button class="btn btn-outline" id="inv-clear">Clear</button>
        <button class="btn btn-outline" id="inv-export"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v12m0 0l-4-4m4 4l4-4"/><path d="M4 17v3a2 2 0 002 2h12a2 2 0 002-2v-3"/></svg>Export to Excel</button>
      </div>
      <div style="overflow-x:auto;">
      <table>
        <thead><tr><th>Invoice No.</th><th>Customer</th><th>Date</th><th>Due Date</th><th>Amount</th><th>Status</th><th>Actions</th></tr></thead>
        <tbody id="inv-tbody"><tr><td colspan="7"><div class="empty-state">Loading…</div></td></tr></tbody>
      </table>
      </div>
      <div id="inv-pagination" style="display:flex;justify-content:space-between;align-items:center;padding:14px 20px;font-size:12.5px;color:var(--text-soft);"></div>
    </div>
  `;
  document.getElementById('inv-search').addEventListener('input', e => { invoiceFilters.search = e.target.value; invPage = 1; renderInvRows(); });
  document.getElementById('inv-status').addEventListener('change', e => { invoiceFilters.status = e.target.value; invPage = 1; renderInvRows(); });
  document.getElementById('inv-from').addEventListener('change', e => { invoiceFilters.from = e.target.value; invPage = 1; renderInvRows(); });
  document.getElementById('inv-to').addEventListener('change', e => { invoiceFilters.to = e.target.value; invPage = 1; renderInvRows(); });
  document.getElementById('inv-clear').addEventListener('click', () => { invoiceFilters = { search: '', status: '', from: '', to: '' }; invPage = 1; renderInvRows(); });
  document.getElementById('inv-export').addEventListener('click', exportInvoicesToExcel);
  renderInvRows();
}

function invoiceQueryString(extra) {
  const params = new URLSearchParams();
  if (invoiceFilters.search) params.set('search', invoiceFilters.search);
  if (invoiceFilters.status) params.set('status', invoiceFilters.status);
  if (invoiceFilters.from) params.set('from', invoiceFilters.from);
  if (invoiceFilters.to) params.set('to', invoiceFilters.to);
  Object.entries(extra || {}).forEach(([k, v]) => params.set(k, v));
  return params.toString();
}

async function renderInvRows() {
  const tbody = document.getElementById('inv-tbody');
  let data;
  try {
    data = await api.get('/invoices?' + invoiceQueryString({ page: invPage, pageSize: INV_PAGE_SIZE }));
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="7"><div class="empty-state">Could not load invoices: ${e.message}</div></td></tr>`;
    return;
  }
  const noticeEl = document.getElementById('inv-offline-notice');
  if (noticeEl) noticeEl.innerHTML = offlineNoticeHtml(data);
  const { items, total, page, pageSize } = data;

  tbody.innerHTML = items.length ? items.map(inv => `<tr>
      <td class="mono">${inv.number}</td>
      <td>${inv.customer ? inv.customer.name : '—'}</td>
      <td>${fmtDate(inv.date)}</td>
      <td>${fmtDate(inv.dueDate)}</td>
      <td class="mono">${fmt(inv.grandTotal)}</td>
      <td>${statusBadge(inv.status)}</td>
      <td>
        <div style="display:flex;gap:10px;color:var(--text-soft);align-items:center;">
          ${inv.status !== 'Paid' && inv.status !== 'Cancelled' ? `<svg data-act="pay" data-id="${inv.id}" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="cursor:pointer;color:var(--green);" title="Record Payment"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/><path d="M6 15h4"/></svg>` : ''}
          <svg data-act="view" data-id="${inv.id}" data-num="${inv.number}" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="cursor:pointer;" title="View / Print"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>
          <svg data-act="edit" data-id="${inv.id}" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="cursor:pointer;" title="Edit"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>
          <svg data-act="delete" data-id="${inv.id}" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="cursor:pointer;color:var(--red);" title="Delete"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m2 0v14a2 2 0 01-2 2H8a2 2 0 01-2-2V6h12z"/></svg>
        </div>
      </td>
    </tr>`).join('') : `<tr><td colspan="7"><div class="empty-state">No invoices match your filters.</div></td></tr>`;

  tbody.querySelectorAll('[data-act]').forEach(icon => {
    icon.addEventListener('click', () => {
      const id = icon.dataset.id, act = icon.dataset.act;
      if (act === 'view') openPdfPreview(id, icon.dataset.num);
      if (act === 'edit') { editingInvoiceId = id; draftItems = []; goPage('create-invoice'); }
      if (act === 'pay') addPaymentModal(id);
      if (act === 'delete') {
        openModal('Delete invoice?', `<p style="font-size:13.5px;color:var(--text-soft);">This will permanently remove this invoice. This can't be undone.</p>`,
          [{ label: 'Cancel', cls: 'btn-outline', action: closeModal },
          {
            label: 'Delete', cls: 'btn-primary', action: async () => {
              try { await api.del('/invoices/' + id); closeModal(); renderInvRows(); } catch (e) { alert(e.message); }
            }
          }]);
      }
    });
  });

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  document.getElementById('inv-pagination').innerHTML = `
    <span>Showing ${total ? ((page - 1) * pageSize + 1) : 0} to ${Math.min(page * pageSize, total)} of ${total} invoices</span>
    <div style="display:flex;gap:6px;">
      <button class="btn btn-ghost" id="pg-prev" ${page <= 1 ? 'disabled' : ''}>‹</button>
      ${Array.from({ length: totalPages }, (_, i) => i + 1).slice(0, 6).map(p => `<button class="btn ${p === page ? 'btn-primary' : 'btn-ghost'}" data-p="${p}">${p}</button>`).join('')}
      <button class="btn btn-ghost" id="pg-next" ${page >= totalPages ? 'disabled' : ''}>›</button>
    </div>`;
  document.getElementById('pg-prev').addEventListener('click', () => { invPage--; renderInvRows(); });
  document.getElementById('pg-next').addEventListener('click', () => { invPage++; renderInvRows(); });
  document.querySelectorAll('[data-p]').forEach(b => b.addEventListener('click', () => { invPage = Number(b.dataset.p); renderInvRows(); }));
}

async function exportInvoicesToExcel() {
  try {
    const blob = await api.getBlob('/invoices/export/excel?' + invoiceQueryString());
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Shekhar-Compute-Invoices-${todayISO()}.xlsx`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  } catch (e) { alert(e.message); }
}

/* ---------------------------- Customers ---------------------------- */
function renderCustomers() {
  const el = document.getElementById('page-customers');
  el.innerHTML = `
    <div class="card">
      <div class="section-title" style="display:flex;justify-content:space-between;align-items:center;">
        Customers
        <button class="btn btn-primary" id="cust-add">+ Add Customer</button>
      </div>
      <table>
        <thead><tr><th>Name</th><th>Mobile</th><th>Email</th><th>GSTIN</th><th>Invoices</th><th>Outstanding</th><th>Actions</th></tr></thead>
        <tbody id="cust-tbody"><tr><td colspan="7"><div class="empty-state">Loading…</div></td></tr></tbody>
      </table>
    </div>`;
  document.getElementById('cust-add').addEventListener('click', () => openAddCustomerModal());
  renderCustRows();
}
async function renderCustRows() {
  const tbody = document.getElementById('cust-tbody');
  await refreshCustomers();
  tbody.innerHTML = cache.customers.length ? cache.customers.map(c => `<tr>
      <td style="font-weight:600;">${c.name}</td><td>${c.mobile}</td><td>${c.email || '-'}</td><td class="mono">${c.gstin || '-'}</td>
      <td>${c.invoiceCount}</td><td class="mono">${fmt(c.outstanding)}</td>
      <td><div style="display:flex;gap:10px;color:var(--text-soft);">
        <svg data-edit="${c.id}" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="cursor:pointer;" title="Edit"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>
        <svg data-del="${c.id}" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="cursor:pointer;color:var(--red);" title="Delete"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m2 0v14a2 2 0 01-2 2H8a2 2 0 01-2-2V6h12z"/></svg>
      </div></td>
    </tr>`).join('') : `<tr><td colspan="7"><div class="empty-state">No customers yet. Add your first customer.</div></td></tr>`;

  tbody.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => editCustomer(b.dataset.edit)));
  tbody.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => {
    openModal('Delete customer?', `<p style="font-size:13.5px;color:var(--text-soft);">This won't delete their past invoices.</p>`,
      [{ label: 'Cancel', cls: 'btn-outline', action: closeModal },
      {
        label: 'Delete', cls: 'btn-primary', action: async () => {
          try { await api.del('/customers/' + b.dataset.del); closeModal(); renderCustRows(); } catch (e) { alert(e.message); }
        }
      }]);
  }));
}
function editCustomer(id) {
  const c = getCustomer(id);
  openModal('Edit Customer', `
    <div class="field"><label>Customer Name *</label><input type="text" id="ec-name" value="${c.name}"></div>
    <div class="field"><label>Mobile *</label><input type="text" id="ec-mobile" value="${c.mobile}"></div>
    <div class="field"><label>Email</label><input type="email" id="ec-email" value="${c.email || ''}"></div>
    <div class="field"><label>Address</label><textarea id="ec-address" rows="2">${c.address || ''}</textarea></div>
    <div class="grid-2">
      <div class="field"><label>State</label><input type="text" id="ec-state" value="${c.state || 'Bihar'}"></div>
      <div class="field"><label>GSTIN</label><input type="text" id="ec-gstin" value="${c.gstin || ''}"></div>
    </div>
  `, [
    { label: 'Cancel', cls: 'btn-outline', action: closeModal },
    {
      label: 'Save Changes', cls: 'btn-primary', action: async () => {
        try {
          await api.put('/customers/' + id, {
            name: val('ec-name').trim(), mobile: val('ec-mobile').trim(), email: val('ec-email').trim(),
            address: val('ec-address').trim(), state: val('ec-state').trim(), gstin: val('ec-gstin').trim()
          });
          closeModal(); renderCustRows();
        } catch (e) { alert(e.message); }
      }
    }
  ]);
}

/* ---------------------------- Products ---------------------------- */
function renderProducts() {
  const el = document.getElementById('page-products');
  el.innerHTML = `
    <div class="card">
      <div class="section-title" style="display:flex;justify-content:space-between;align-items:center;">
        Products & Services Catalogue
        <button class="btn btn-primary" id="prod-add">+ Add Product / Service</button>
      </div>
      <table>
        <thead><tr><th>Name</th><th>Description</th><th>HSN/SAC</th><th>Unit</th><th>Default Rate</th><th>GST %</th><th>Actions</th></tr></thead>
        <tbody id="prod-tbody"><tr><td colspan="7"><div class="empty-state">Loading…</div></td></tr></tbody>
      </table>
    </div>`;
  document.getElementById('prod-add').addEventListener('click', () => editProduct(null));
  renderProdRows();
}
async function renderProdRows() {
  const tbody = document.getElementById('prod-tbody');
  await refreshProducts();
  tbody.innerHTML = cache.products.map(p => `<tr>
      <td style="font-weight:600;">${p.name}</td><td style="color:var(--text-soft);max-width:260px;">${p.description || '-'}</td>
      <td class="mono">${p.hsn}</td><td>${p.unit}</td><td class="mono">${fmt(p.rate)}</td><td>${p.gst}%</td>
      <td><div style="display:flex;gap:10px;color:var(--text-soft);">
        <svg data-edit="${p.id}" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="cursor:pointer;" title="Edit"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>
        <svg data-del="${p.id}" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="cursor:pointer;color:var(--red);" title="Delete"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m2 0v14a2 2 0 01-2 2H8a2 2 0 01-2-2V6h12z"/></svg>
      </div></td>
    </tr>`).join('');
  tbody.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => editProduct(b.dataset.edit)));
  tbody.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async () => {
    try { await api.del('/products/' + b.dataset.del); renderProdRows(); } catch (e) { alert(e.message); }
  }));
}
function editProduct(id) {
  const p = id ? cache.products.find(x => x.id === id) : { name: '', description: '', hsn: '', rate: 0, gst: cache.settings.defaultGst, unit: 'Unit' };
  openModal(id ? 'Edit Product / Service' : 'Add Product / Service', `
    <div class="field"><label>Name *</label><input type="text" id="ep-name" value="${p.name}"></div>
    <div class="field"><label>Description</label><textarea id="ep-desc" rows="2">${p.description}</textarea></div>
    <div class="grid-2">
      <div class="field"><label>HSN/SAC</label><input type="text" id="ep-hsn" value="${p.hsn}"></div>
      <div class="field"><label>Unit</label><input type="text" id="ep-unit" value="${p.unit}"></div>
    </div>
    <div class="grid-2">
      <div class="field"><label>Default Rate (${curMeta().symbol})</label><input type="number" id="ep-rate" value="${p.rate}"></div>
      <div class="field"><label>GST Rate (%)</label><input type="number" id="ep-gst" value="${p.gst}"></div>
    </div>
  `, [
    { label: 'Cancel', cls: 'btn-outline', action: closeModal },
    {
      label: id ? 'Save Changes' : 'Add Product', cls: 'btn-primary', action: async () => {
        const name = val('ep-name').trim();
        if (!name) { shake('ep-name'); return; }
        const data = {
          name, description: val('ep-desc').trim(), hsn: val('ep-hsn').trim(),
          unit: val('ep-unit').trim() || 'Unit', rate: Number(val('ep-rate')) || 0, gst: Number(val('ep-gst')) || 0
        };
        try {
          if (id) await api.put('/products/' + id, data); else await api.post('/products', data);
          closeModal(); renderProdRows();
        } catch (e) { alert(e.message); }
      }
    }
  ]);
}

/* ---------------------------- Payments ---------------------------- */
function renderPayments() {
  const el = document.getElementById('page-payments');
  el.innerHTML = `
    <div class="card">
      <div class="section-title" style="display:flex;justify-content:space-between;align-items:center;">
        Payments
        <button class="btn btn-primary" id="pay-add">+ Record Payment</button>
      </div>
      <table>
        <thead><tr><th>Invoice</th><th>Customer</th><th>Invoice Amount</th><th>Paid</th><th>Pending</th><th>Date</th><th>Method</th><th>Transaction ID</th></tr></thead>
        <tbody id="pay-tbody"><tr><td colspan="8"><div class="empty-state">Loading…</div></td></tr></tbody>
      </table>
    </div>`;
  document.getElementById('pay-add').addEventListener('click', addPaymentModal);
  renderPayRows();
}
async function renderPayRows() {
  const tbody = document.getElementById('pay-tbody');
  let payments;
  try { payments = await api.get('/payments'); } catch (e) { tbody.innerHTML = `<tr><td colspan="8"><div class="empty-state">${e.message}</div></td></tr>`; return; }
  const list = [...payments].sort((a, b) => b.date.localeCompare(a.date));
  tbody.innerHTML = list.length ? list.map(p => {
    const inv = p.invoice;
    const pending = inv ? Math.max(0, inv.grandTotal - p.amount) : 0;
    return `<tr>
      <td class="mono">${inv ? inv.number : '—'}</td><td>${inv && inv.customer ? inv.customer.name : '—'}</td>
      <td class="mono">${inv ? fmt(inv.grandTotal) : '-'}</td><td class="mono" style="color:var(--green);">${fmt(p.amount)}</td>
      <td class="mono">${fmt(pending)}</td><td>${fmtDate(p.date)}</td><td>${p.method}</td><td class="mono">${p.transactionId || '-'}</td>
    </tr>`;
  }).join('') : `<tr><td colspan="8"><div class="empty-state">No payments recorded yet.</div></td></tr>`;
}
async function addPaymentModal(preselectInvoiceId) {
  let invoices;
  try { invoices = (await api.get('/invoices?pageSize=1000')).items.filter(i => i.status !== 'Cancelled'); }
  catch (e) { alert(e.message); return; }

  function balanceFor(inv) {
    // invoices list doesn't carry a running "paid so far" figure, so this is
    // a reasonable estimate for the modal — Paid means fully settled, other
    // statuses are treated as fully outstanding until a partial payment is
    // recorded (the balance shown then updates next time the modal opens).
    return inv.status === 'Paid' ? 0 : inv.grandTotal;
  }

  openModal('Record Payment', `
    <div class="field"><label>Invoice *</label><select id="pp-invoice">
      <option value="">Select invoice</option>
      ${invoices.map(i => `<option value="${i.id}" data-balance="${balanceFor(i)}" ${preselectInvoiceId === i.id ? 'selected' : ''}>${i.number} — ${i.customer ? i.customer.name : ''} (${fmt(i.grandTotal)})</option>`).join('')}
    </select></div>
    <div id="pp-balance-note" style="font-size:12px;color:var(--text-faint);margin:-8px 0 12px;"></div>
    <div class="grid-2">
      <div class="field"><label>Paid Amount (${curMeta().symbol}) *</label><input type="number" id="pp-amount"></div>
      <div class="field"><label>Payment Date *</label><input type="date" id="pp-date" value="${todayISO()}"></div>
    </div>
    <div class="grid-2">
      <div class="field"><label>Payment Method</label><select id="pp-method">
        ${['Cash', 'Cheque', 'QR', 'Bank Account', 'UPI', 'Card'].map(m => `<option>${m}</option>`).join('')}
      </select></div>
      <div class="field"><label>Transaction ID / Ref</label><input type="text" id="pp-txn"></div>
    </div>
    <label style="display:flex;align-items:center;gap:8px;font-size:13px;font-weight:500;color:var(--text-soft);cursor:pointer;margin-top:2px;">
      <input type="checkbox" id="pp-full" style="width:auto;">
      Full payment — mark this invoice as Paid
    </label>
  `, [
    { label: 'Cancel', cls: 'btn-outline', action: closeModal },
    {
      label: 'Record Payment', cls: 'btn-primary', action: async () => {
        const invoiceId = val('pp-invoice');
        const amount = Number(val('pp-amount'));
        if (!invoiceId || !amount) { alert('Select an invoice and enter an amount.'); return; }
        try {
          await api.post('/payments', {
            invoiceId, amount, date: val('pp-date'), method: val('pp-method'), transactionId: val('pp-txn')
          });
          closeModal(); renderPayRows();
          if (document.getElementById('page-invoices').classList.contains('active')) renderInvRows();
        } catch (e) { alert(e.message); }
      }
    }
  ]);

  const invoiceSelect = document.getElementById('pp-invoice');
  const amountInput = document.getElementById('pp-amount');
  const fullCheckbox = document.getElementById('pp-full');
  function syncFromSelection() {
    const opt = invoiceSelect.selectedOptions[0];
    const balance = opt ? Number(opt.dataset.balance) || 0 : 0;
    document.getElementById('pp-balance-note').textContent = opt && opt.value ? `Balance due: ${fmt(balance)}` : '';
    if (fullCheckbox.checked) amountInput.value = balance || '';
  }
  invoiceSelect.addEventListener('change', syncFromSelection);
  fullCheckbox.addEventListener('change', syncFromSelection);
  syncFromSelection();
}

/* ---------------------------- Expenses ---------------------------- */
const EXPENSE_CATEGORIES = ['Office Supplies', 'Software & Subscriptions', 'Travel', 'Marketing', 'Utilities', 'Salaries', 'Rent', 'Other'];
async function renderExpenses() {
  const el = document.getElementById('page-expenses');
  el.innerHTML = `<div class="empty-state">Loading…</div>`;
  let expenses, dash;
  try {
    [expenses, dash] = await Promise.all([api.get('/expenses'), api.get('/reports/dashboard')]);
  } catch (e) { el.innerHTML = `<div class="empty-state">${e.message}</div>`; return; }

  const total = expenses.reduce((s, e) => s + e.amount, 0);
  const thisMonth = expenses.filter(e => {
    const d = new Date(e.date); const now = new Date();
    return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
  }).reduce((s, e) => s + e.amount, 0);

  el.innerHTML = `
    <div class="grid-4" style="margin-bottom:20px;">
      ${statCard('var(--red-bg)', 'var(--red)', 'Total Expenses', fmt(total), 'All time', iconRupee())}
      ${statCard('var(--amber-bg)', 'var(--amber)', 'This Month', fmt(thisMonth), 'Current month', iconClock())}
      ${statCard('var(--slate-bg)', 'var(--slate)', 'Entries', expenses.length, 'Recorded expenses', iconInvoices())}
      ${statCard('var(--green-bg)', 'var(--green)', 'Net (Revenue − Expenses)', fmt(dash.totalRevenue - total), 'All time', iconCheck())}
    </div>
    <div class="card">
      <div class="section-title" style="display:flex;justify-content:space-between;align-items:center;">
        Expenses
        <button class="btn btn-primary" id="exp-add">+ Add Expense</button>
      </div>
      <table>
        <thead><tr><th>Date</th><th>Category</th><th>Description</th><th>Method</th><th>Amount</th><th>Actions</th></tr></thead>
        <tbody id="exp-tbody"></tbody>
      </table>
    </div>`;
  document.getElementById('exp-add').addEventListener('click', () => editExpense(null));
  renderExpTable(expenses);
}
function renderExpTable(expenses) {
  const tbody = document.getElementById('exp-tbody');
  const list = [...expenses].sort((a, b) => b.date.localeCompare(a.date));
  tbody.innerHTML = list.length ? list.map(e => `<tr>
      <td>${fmtDate(e.date)}</td><td>${e.category}</td><td style="color:var(--text-soft);">${e.description || '-'}</td><td>${e.method}</td>
      <td class="mono" style="color:var(--red);">-${fmt(e.amount)}</td>
      <td><div style="display:flex;gap:10px;color:var(--text-soft);">
        <svg data-edit="${e.id}" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="cursor:pointer;" title="Edit"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>
        <svg data-del="${e.id}" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="cursor:pointer;color:var(--red);" title="Delete"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m2 0v14a2 2 0 01-2 2H8a2 2 0 01-2-2V6h12z"/></svg>
      </div></td>
    </tr>`).join('') : `<tr><td colspan="6"><div class="empty-state">No expenses logged yet.</div></td></tr>`;
  tbody.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', async () => {
    const all = await api.get('/expenses');
    editExpense(all.find(x => x.id === b.dataset.edit));
  }));
  tbody.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => {
    openModal('Delete expense?', `<p style="font-size:13.5px;color:var(--text-soft);">This can't be undone.</p>`,
      [{ label: 'Cancel', cls: 'btn-outline', action: closeModal },
      {
        label: 'Delete', cls: 'btn-primary', action: async () => {
          try { await api.del('/expenses/' + b.dataset.del); closeModal(); renderExpenses(); } catch (e2) { alert(e2.message); }
        }
      }]);
  }));
}
function editExpense(e) {
  const isEdit = !!e;
  e = e || { date: todayISO(), category: EXPENSE_CATEGORIES[0], description: '', amount: 0, method: 'Cash' };
  openModal(isEdit ? 'Edit Expense' : 'Add Expense', `
    <div class="grid-2">
      <div class="field"><label>Date *</label><input type="date" id="ee-date" value="${e.date}"></div>
      <div class="field"><label>Amount (${curMeta().symbol}) *</label><input type="number" id="ee-amount" value="${e.amount}"></div>
    </div>
    <div class="field"><label>Category</label><select id="ee-cat">${EXPENSE_CATEGORIES.map(c => `<option ${e.category === c ? 'selected' : ''}>${c}</option>`).join('')}</select></div>
    <div class="field"><label>Description</label><textarea id="ee-desc" rows="2">${e.description || ''}</textarea></div>
    <div class="field"><label>Payment Method</label><select id="ee-method">${['Cash', 'UPI', 'Bank Transfer', 'Card', 'Cheque'].map(m => `<option ${e.method === m ? 'selected' : ''}>${m}</option>`).join('')}</select></div>
  `, [
    { label: 'Cancel', cls: 'btn-outline', action: closeModal },
    {
      label: isEdit ? 'Save Changes' : 'Add Expense', cls: 'btn-primary', action: async () => {
        const amount = Number(val('ee-amount'));
        if (!amount || amount <= 0) { shake('ee-amount'); return; }
        const data = { date: val('ee-date') || todayISO(), category: val('ee-cat'), description: val('ee-desc').trim(), amount, method: val('ee-method') };
        try {
          if (isEdit) await api.put('/expenses/' + e.id, data); else await api.post('/expenses', data);
          closeModal(); renderExpenses();
        } catch (err) { alert(err.message); }
      }
    }
  ]);
}

/* ---------------------------- Reports ---------------------------- */
async function renderReports() {
  const el = document.getElementById('page-reports');
  el.innerHTML = `<div class="empty-state">Loading…</div>`;
  let r;
  try { r = await api.get('/reports/analytics'); } catch (e) { el.innerHTML = `<div class="empty-state">${e.message}</div>`; return; }

  const maxMonthly = Math.max(1, ...r.monthlyRevenue.map(m => m.sum));
  const statusColors = { Draft: 'var(--slate)', Paid: 'var(--green)', Pending: 'var(--amber)', Overdue: 'var(--red)', Cancelled: 'var(--text-faint)' };
  const totalInvoicesCount = Object.values(r.statusCounts).reduce((a, b) => a + b, 0);
  const maxCust = Math.max(1, ...r.topCustomers.map(c => c[1]));
  const maxSvc = Math.max(1, ...r.topServices.map(s => s[1]));

  el.innerHTML = `
    <div class="grid-3" style="margin-bottom:16px;">
      ${statCard('var(--green-bg)', 'var(--green)', 'Total Revenue', fmt(r.totalBilled), 'All non-cancelled invoices', iconRupee())}
      ${statCard('var(--red-bg)', 'var(--red)', 'Total Expenses', fmt(r.totalExpenses), 'All recorded expenses', iconInvoices())}
      ${statCard(r.netProfit >= 0 ? 'var(--green-bg)' : 'var(--red-bg)', r.netProfit >= 0 ? 'var(--green)' : 'var(--red)', 'Net Profit', fmt(r.netProfit), 'Revenue − Expenses', iconCheck())}
    </div>
    <div class="grid-2" style="margin-bottom:16px;">
      <div class="card" style="padding:20px;">
        <div style="font-weight:700;margin-bottom:14px;">Monthly Revenue</div>
        <div style="display:flex;align-items:flex-end;gap:10px;height:150px;">
          ${r.monthlyRevenue.map(m => `<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:6px;">
            <div style="font-size:11px;color:var(--text-faint);" class="mono">${m.sum ? (curMeta().symbol + Math.round(m.sum / 1000) + 'k') : ''}</div>
            <div style="width:100%;background:var(--primary);border-radius:6px 6px 0 0;height:${Math.max(4, (m.sum / maxMonthly) * 100)}px;"></div>
            <div style="font-size:11.5px;color:var(--text-soft);">${m.label}</div>
          </div>`).join('')}
        </div>
      </div>
      <div class="card" style="padding:20px;">
        <div style="font-weight:700;margin-bottom:14px;">Invoice Status Distribution</div>
        ${Object.keys(statusColors).map(s => {
    const c = r.statusCounts[s] || 0; const pct = totalInvoicesCount ? Math.round(c / totalInvoicesCount * 100) : 0;
    return `<div style="margin-bottom:10px;">
            <div style="display:flex;justify-content:space-between;font-size:12.5px;margin-bottom:4px;"><span>${s}</span><span class="mono">${c} · ${pct}%</span></div>
            <div class="bar"><div style="width:${pct}%;background:${statusColors[s]};"></div></div>
          </div>`;
  }).join('')}
      </div>
    </div>
    <div class="grid-2" style="margin-bottom:16px;">
      <div class="card" style="padding:20px;">
        <div style="font-weight:700;margin-bottom:6px;">Payment Collection</div>
        <div style="font-size:12.5px;color:var(--text-soft);margin-bottom:12px;">${fmt(r.collected)} collected of ${fmt(r.totalBilled)} billed</div>
        <div class="bar" style="height:14px;"><div style="width:${r.collectionRate}%;background:var(--green);"></div></div>
        <div style="text-align:right;font-size:12px;color:var(--text-faint);margin-top:6px;">${r.collectionRate}% collection rate</div>
      </div>
      <div class="card" style="padding:20px;">
        <div style="font-weight:700;margin-bottom:14px;">Top Customers</div>
        ${r.topCustomers.length ? r.topCustomers.map(([name, total]) => `<div style="margin-bottom:9px;">
          <div style="display:flex;justify-content:space-between;font-size:12.5px;margin-bottom:4px;"><span>${name}</span><span class="mono">${fmt(total)}</span></div>
          <div class="bar"><div style="width:${(total / maxCust) * 100}%;"></div></div>
        </div>`).join('') : `<div style="color:var(--text-faint);font-size:13px;">No data yet</div>`}
      </div>
    </div>
    <div class="grid-2">
      <div class="card" style="padding:20px;">
        <div style="font-weight:700;margin-bottom:14px;">Top Services</div>
        ${r.topServices.length ? r.topServices.map(([name, total]) => `<div style="margin-bottom:9px;">
          <div style="display:flex;justify-content:space-between;font-size:12.5px;margin-bottom:4px;"><span>${name}</span><span class="mono">${fmt(total)}</span></div>
          <div class="bar"><div style="width:${(total / maxSvc) * 100}%;background:#6D28D9;"></div></div>
        </div>`).join('') : `<div style="color:var(--text-faint);font-size:13px;">No data yet</div>`}
      </div>
      <div class="card">
        <div class="section-title">Pending Payments</div>
        <table><thead><tr><th>Invoice</th><th>Customer</th><th>Due Date</th><th>Amount</th></tr></thead>
        <tbody>
        ${r.pending.length ? r.pending.map(i => `<tr><td class="mono">${i.number}</td><td>${i.customer ? i.customer.name : '-'}</td><td>${fmtDate(i.dueDate)}</td><td class="mono">${fmt(i.grandTotal)}</td></tr>`).join('') : `<tr><td colspan="4" class="empty-state">Nothing pending 🎉</td></tr>`}
        </tbody></table>
      </div>
    </div>
  `;
}

/* ---------------------------- Settings ---------------------------- */
function renderSidebarFoot() {
  const s = cache.settings;
  const cityState = [s.businessCity, s.businessState].filter(Boolean).join(', ');
  document.getElementById('sidebar-foot').innerHTML = `<b>${s.businessName}</b><br>${cityState}<br>${s.udyam}`;
}

async function renderSettings() {
  const el = document.getElementById('page-settings');
  await refreshSettings();
  const s = cache.settings;
  el.innerHTML = `
    <div class="grid-2" style="align-items:start;">
      <div class="card" style="padding:20px;">
        <div style="font-weight:700;margin-bottom:16px;">Business Profile</div>
        <div class="field"><label>Business Name</label><input type="text" id="st-name" value="${s.businessName}"></div>
        <div class="grid-2">
          <div class="field"><label>Business Type</label><input type="text" id="st-type" value="${s.businessType}"></div>
          <div class="field"><label>Major Activity</label><input type="text" id="st-activity" value="${s.activity}"></div>
        </div>
        <div class="field"><label>UDYAM Registration Number</label><input type="text" id="st-udyam" value="${s.udyam}"></div>
        <div class="field"><label>Business Address</label><textarea id="st-address" rows="2">${s.address}</textarea></div>
        <div class="grid-2">
          <div class="field"><label>Business State</label><input type="text" id="st-state" value="${s.businessState}"></div>
          <div class="field"><label>Mobile</label><input type="text" id="st-mobile" value="${s.mobile}"></div>
        </div>
        <div class="field"><label>Email</label><input type="email" id="st-email" value="${s.email}"></div>
        <div class="field"><label>Tagline (shown on invoice)</label><input type="text" id="st-tagline" value="${s.tagline}"></div>

        <div style="font-weight:700;margin:20px 0 12px;padding-top:16px;border-top:1px solid var(--border);">Bank Details</div>
        <div class="field"><label>Bank Name</label><input type="text" id="st-bank" value="${s.bankName}"></div>
        <div class="grid-2">
          <div class="field"><label>Account Number</label><input type="text" id="st-acc" value="${s.bankAccount}"></div>
          <div class="field"><label>IFSC</label><input type="text" id="st-ifsc" value="${s.bankIfsc}"></div>
        </div>

        <div style="font-weight:700;margin:20px 0 12px;padding-top:16px;border-top:1px solid var(--border);">UPI / QR Payment</div>
        <div class="field"><label>UPI ID</label><input type="text" id="st-upi" value="${s.upiId}" placeholder="yourname@okbizaxis"></div>
        <div class="toggle-row"><span style="font-size:13.5px;">Show UPI QR code on invoice</span><label class="switch"><input type="checkbox" id="st-showupi" ${s.showUpiQr ? 'checked' : ''}><span class="slider"></span></label></div>
        <div class="field" style="margin-top:12px;">
          <label>UPI QR Code Image</label>
          <div style="display:flex;align-items:center;gap:14px;">
            <div id="st-qr-preview" style="width:76px;height:76px;border:1px dashed var(--border);border-radius:8px;flex-shrink:0;display:flex;align-items:center;justify-content:center;background:var(--bg);overflow:hidden;">
              ${s.qrCodeDataUrl ? `<img src="${s.qrCodeDataUrl}" style="width:100%;height:100%;object-fit:contain;">` : `<span style="font-size:10px;color:var(--text-faint);text-align:center;padding:4px;">No QR yet</span>`}
            </div>
            <div style="flex:1;">
              <input type="file" id="st-qr-upload" accept="image/*">
              <div style="font-size:11.5px;color:var(--text-faint);margin-top:4px;">Uploaded QR is saved on the server and shown on every invoice when the toggle above is on.</div>
              ${s.qrCodeDataUrl ? `<button class="btn btn-ghost" id="st-qr-remove" style="padding:4px 0;color:var(--red);margin-top:4px;">Remove QR code</button>` : ''}
            </div>
          </div>
        </div>

        <div style="font-weight:700;margin:20px 0 12px;padding-top:16px;border-top:1px solid var(--border);">Defaults</div>
        <div class="field"><label>Default Payment Terms</label><textarea id="st-payterms" rows="4">${s.paymentTerms}</textarea></div>
        <div class="field"><label>Default Terms & Conditions</label><textarea id="st-terms" rows="5">${s.terms}</textarea></div>
        <div class="field"><label>Default Notes</label><textarea id="st-notes" rows="4">${s.notes}</textarea></div>

        <button class="btn btn-primary" id="st-save" style="margin-top:6px;">Save Business Profile</button>
      </div>

      <div>
        <div class="card" style="padding:20px;margin-bottom:16px;">
          <div style="font-weight:700;margin-bottom:16px;">Invoice Settings</div>
          <div class="grid-2">
            <div class="field"><label>Invoice Prefix</label><input type="text" id="st-prefix" value="${s.prefix}"></div>
            <div class="field"><label>Next Invoice Number</label><input type="number" id="st-nextnum" value="${s.nextNumber}"></div>
          </div>
          <div class="grid-2">
            <div class="field"><label>Currency</label><select id="st-currency"><option ${s.currency === 'INR' ? 'selected' : ''}>INR</option><option ${s.currency === 'USD' ? 'selected' : ''}>USD</option></select></div>
            <div class="field"><label>Tax Type</label><select id="st-taxtype"><option ${s.taxType === 'GST' ? 'selected' : ''}>GST</option><option ${s.taxType === 'Non-GST' ? 'selected' : ''}>Non-GST</option></select></div>
          </div>
          <div class="field"><label>Default GST Percentage</label><input type="number" id="st-defgst" value="${s.defaultGst}"></div>
          <div class="toggle-row"><span style="font-size:13.5px;">Show Bank Details on invoice</span><label class="switch"><input type="checkbox" id="st-showbank" ${s.showBank ? 'checked' : ''}><span class="slider"></span></label></div>
          <div class="toggle-row"><span style="font-size:13.5px;">Show UDYAM Number on invoice</span><label class="switch"><input type="checkbox" id="st-showudyam" ${s.showUdyam ? 'checked' : ''}><span class="slider"></span></label></div>
          <div class="toggle-row"><span style="font-size:13.5px;">Show Email on invoice</span><label class="switch"><input type="checkbox" id="st-showemail" ${s.showEmail !== false ? 'checked' : ''}><span class="slider"></span></label></div>
          <div class="field" style="margin-top:12px;">
            <label>Upload Logo</label>
            <div style="display:flex;align-items:center;gap:14px;">
              <div id="st-logo-preview" style="width:56px;height:56px;border:1px dashed var(--border);border-radius:10px;flex-shrink:0;display:flex;align-items:center;justify-content:center;background:var(--bg);overflow:hidden;font-weight:800;font-family:'Inter Tight';color:var(--primary);">
                ${s.logoDataUrl ? `<img src="${s.logoDataUrl}" style="width:100%;height:100%;object-fit:contain;">` : 'S'}
              </div>
              <div style="flex:1;">
                <input type="file" id="st-logo" accept="image/*">
                <div style="font-size:11.5px;color:var(--text-faint);margin-top:4px;">Replaces the "S" mark in the sidebar, login screen and every invoice PDF.</div>
                ${s.logoDataUrl ? `<button class="btn btn-ghost" id="st-logo-remove" style="padding:4px 0;color:var(--red);margin-top:4px;">Remove logo</button>` : ''}
              </div>
            </div>
          </div>
          <button class="btn btn-primary" id="st-save-inv" style="margin-top:10px;">Save Invoice Settings</button>
        </div>

        <div class="card" style="padding:20px;margin-bottom:16px;">
          <div style="font-weight:700;margin-bottom:14px;">Invoice Design</div>
          <div class="grid-3" style="margin-bottom:10px;gap:12px;">
            <div class="tmpl-card ${s.template === 'modern' ? 'active' : ''}" data-tmpl="modern"><div class="swatch" style="background:linear-gradient(135deg,#1E3A8A,#3457C7);"></div><div class="label">Modern Blue</div></div>
            <div class="tmpl-card ${s.template === 'minimal' ? 'active' : ''}" data-tmpl="minimal"><div class="swatch" style="background:#F8F9FB;border:1px solid #DCE1EC;display:flex;align-items:center;justify-content:center;"><div style="width:70%;height:2px;background:#151B2C;"></div></div><div class="label">Minimal Professional</div></div>
            <div class="tmpl-card ${s.template === 'classic' ? 'active' : ''}" data-tmpl="classic"><div class="swatch" style="background:#fff;border:2px solid #151B2C;"></div><div class="label">Classic Business</div></div>
            <div class="tmpl-card ${s.template === 'bold' ? 'active' : ''}" data-tmpl="bold"><div class="swatch" style="background:linear-gradient(#1E3A8A,#1E3A8A 60%,#fff 60%);"></div><div class="label">Bold Header</div></div>
            <div class="tmpl-card ${s.template === 'compact' ? 'active' : ''}" data-tmpl="compact"><div class="swatch" style="background:repeating-linear-gradient(0deg,#EAF0FE,#EAF0FE 3px,#fff 3px,#fff 7px);border:1px solid #DCE1EC;"></div><div class="label">Compact</div></div>
            <div class="tmpl-card ${s.template === 'taxinvoice' ? 'active' : ''}" data-tmpl="taxinvoice"><div class="swatch" style="background:#fff;border:1.5px solid #151B2C;background-image:repeating-linear-gradient(#DCE1EC 0 1px, transparent 1px 8px), repeating-linear-gradient(90deg,#DCE1EC 0 1px, transparent 1px 16px);"></div><div class="label">Tax Invoice (Bordered)</div></div>
          </div>
          <div style="font-size:11.5px;color:var(--text-faint);margin-bottom:14px;">Selecting a design saves it immediately as the default used for every invoice PDF — you can still switch it per download from the preview screen.</div>
          <div class="field"><label>Primary Brand Color</label><input type="color" id="st-color" value="${s.primaryColor}" style="height:40px;padding:4px;"></div>
          <div style="font-size:11.5px;color:var(--text-faint);">Updates the sidebar highlight, buttons and invoice accent color immediately.</div>
        </div>

        <div class="card" style="padding:20px;">
          <div style="font-weight:700;margin-bottom:4px;">Print Format</div>
          <div style="font-size:12.5px;color:var(--text-soft);margin-bottom:14px;">Choose the default paper size invoices are generated for. You can still override this per-download.</div>
          <div class="grid-2" style="gap:12px;">
            <div class="tmpl-card ${(s.defaultPaperSize || 'a4') === 'a4' ? 'active' : ''}" data-paper="a4">
              <div class="swatch" style="background:#F8F9FB;border:1px solid #DCE1EC;display:flex;align-items:center;justify-content:center;"><div style="width:34px;height:46px;background:#fff;border:1px solid #B8BECC;"></div></div>
              <div class="label">A4 (standard printer)</div>
            </div>
            <div class="tmpl-card ${s.defaultPaperSize === 'thermal' ? 'active' : ''}" data-paper="thermal">
              <div class="swatch" style="background:#F8F9FB;border:1px solid #DCE1EC;display:flex;align-items:center;justify-content:center;"><div style="width:26px;height:38px;background:#fff;border:1px solid #B8BECC;"></div></div>
              <div class="label">4×6 Thermal (label/receipt printer)</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  document.getElementById('st-save').addEventListener('click', async () => {
    try {
      await api.put('/settings', {
        businessName: val('st-name'), businessType: val('st-type'), activity: val('st-activity'), udyam: val('st-udyam'),
        address: val('st-address'), businessState: val('st-state'), mobile: val('st-mobile'), email: val('st-email'),
        tagline: val('st-tagline'), bankName: val('st-bank'), bankAccount: val('st-acc'), bankIfsc: val('st-ifsc'),
        upiId: val('st-upi'), showUpiQr: document.getElementById('st-showupi').checked,
        paymentTerms: val('st-payterms'), terms: val('st-terms'), notes: val('st-notes')
      });
      await refreshSettings(); flashSaved('st-save'); renderSidebarFoot();
    } catch (e) { alert(e.message); }
  });
  document.getElementById('st-save-inv').addEventListener('click', async () => {
    try {
      await api.put('/settings', {
        prefix: val('st-prefix'), nextNumber: Number(val('st-nextnum')) || 1, currency: val('st-currency'), taxType: val('st-taxtype'),
        defaultGst: Number(val('st-defgst')) || 0, showBank: document.getElementById('st-showbank').checked, showUdyam: document.getElementById('st-showudyam').checked,
        showEmail: document.getElementById('st-showemail').checked
      });
      await refreshSettings(); flashSaved('st-save-inv');
    } catch (e) { alert(e.message); }
  });
  document.getElementById('st-qr-upload').addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 4 * 1024 * 1024) { alert('Please choose an image under 4MB.'); return; }
    const reader = new FileReader();
    reader.onload = async () => {
      try { await api.put('/settings', { qrCodeDataUrl: reader.result }); await refreshSettings(); renderSettings(); }
      catch (err) { alert(err.message); }
    };
    reader.readAsDataURL(file);
  });
  const qrRemoveBtn = document.getElementById('st-qr-remove');
  if (qrRemoveBtn) qrRemoveBtn.addEventListener('click', async () => {
    try { await api.put('/settings', { qrCodeDataUrl: '' }); await refreshSettings(); renderSettings(); } catch (e) { alert(e.message); }
  });
  document.getElementById('st-logo').addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 4 * 1024 * 1024) { alert('Please choose an image under 4MB.'); return; }
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        await api.put('/settings', { logoDataUrl: reader.result });
        await refreshSettings(); renderLogoEverywhere(); renderSettings();
      } catch (err) { alert(err.message); }
    };
    reader.readAsDataURL(file);
  });
  const logoRemoveBtn = document.getElementById('st-logo-remove');
  if (logoRemoveBtn) logoRemoveBtn.addEventListener('click', async () => {
    try { await api.put('/settings', { logoDataUrl: '' }); await refreshSettings(); renderLogoEverywhere(); renderSettings(); } catch (e) { alert(e.message); }
  });
  el.querySelectorAll('[data-tmpl]').forEach(c => c.addEventListener('click', async () => {
    try {
      await api.put('/settings', { template: c.dataset.tmpl });
      await refreshSettings();
      el.querySelectorAll('[data-tmpl]').forEach(x => x.classList.remove('active')); c.classList.add('active');
    } catch (e) { alert(e.message); }
  }));
  el.querySelectorAll('[data-paper]').forEach(c => c.addEventListener('click', async () => {
    try {
      await api.put('/settings', { defaultPaperSize: c.dataset.paper });
      await refreshSettings();
      el.querySelectorAll('[data-paper]').forEach(x => x.classList.remove('active')); c.classList.add('active');
    } catch (e) { alert(e.message); }
  }));
  document.getElementById('st-color').addEventListener('input', e => applyPrimaryColor(e.target.value));
  document.getElementById('st-color').addEventListener('change', async e => {
    applyPrimaryColor(e.target.value);
    try { await api.put('/settings', { primaryColor: e.target.value }); await refreshSettings(); } catch (err) { alert(err.message); }
  });
}
function flashSaved(btnId) {
  const b = document.getElementById(btnId); const orig = b.textContent;
  b.textContent = 'Saved ✓'; setTimeout(() => b.textContent = orig, 1400);
}

/* ---------------------------- Profile ---------------------------- */
async function renderProfile() {
  const el = document.getElementById('page-profile');
  const s = cache.settings;
  let me = { email: '' };
  try { me = await api.get('/auth/me'); } catch (e) { /* ignore */ }

  el.innerHTML = `
    <div class="grid-2" style="align-items:start;">
      <div class="card" style="padding:28px;">
        <div style="display:flex;align-items:center;gap:16px;margin-bottom:22px;">
          <div class="avatar" style="width:60px;height:60px;font-size:22px;">S</div>
          <div>
            <div style="font-size:17px;font-weight:700;">Shashank Shekhar</div>
            <div style="font-size:12.5px;color:var(--text-faint);">Admin · ${me.email || s.email}</div>
          </div>
        </div>
        <div style="font-weight:700;margin-bottom:4px;">Business Info</div>
        <div style="font-size:12.5px;color:var(--text-soft);margin-bottom:16px;">This is what shows in the sidebar and on invoices — edit it directly here.</div>
        <div id="prof-info-msg" style="display:none;font-size:12.5px;font-weight:600;padding:9px 12px;border-radius:8px;margin-bottom:14px;"></div>
        <div class="field"><label>Business Name</label><input type="text" id="pf-name" value="${s.businessName}"></div>
        <div class="grid-2">
          <div class="field"><label>City</label><input type="text" id="pf-city" value="${s.businessCity || ''}"></div>
          <div class="field"><label>State</label><input type="text" id="pf-state" value="${s.businessState || ''}"></div>
        </div>
        <div class="field"><label>UDYAM Registration Number</label><input type="text" id="pf-udyam" value="${s.udyam}"></div>
        <div class="field"><label>Full Address</label><textarea id="pf-address" rows="2">${s.address}</textarea></div>
        <div class="field"><label>Mobile</label><input type="text" id="pf-mobile" value="${s.mobile}"></div>
        <button class="btn btn-primary" id="prof-save">Save Business Info</button>
        <button class="btn btn-ghost" style="margin-left:8px;" id="prof-edit">More settings →</button>
      </div>

      <div class="card" style="padding:28px;">
        <div style="font-weight:700;margin-bottom:4px;">Security · Admin login</div>
        <div style="font-size:12.5px;color:var(--text-soft);margin-bottom:18px;">Update the email and password used to sign in to this admin panel.</div>
        <div id="prof-sec-msg" style="display:none;font-size:12.5px;font-weight:600;padding:9px 12px;border-radius:8px;margin-bottom:14px;"></div>
        <div class="field"><label>Admin email / username</label><input type="text" id="sec-email" value="${me.email || s.email}"></div>
        <div style="height:1px;background:var(--border);margin:16px 0;"></div>
        <div class="field"><label>Current password</label><input type="password" id="sec-current"></div>
        <div class="grid-2">
          <div class="field"><label>New password</label><input type="password" id="sec-new"></div>
          <div class="field"><label>Confirm new password</label><input type="password" id="sec-confirm"></div>
        </div>
        <button class="btn btn-primary" id="sec-save">Update Login Details</button>
        <div style="margin-top:18px;padding-top:16px;border-top:1px solid var(--border);">
          <div style="font-size:12.5px;color:var(--text-soft);margin-bottom:10px;">Session</div>
          <button class="btn btn-outline" id="sec-logout-all"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/></svg>Sign out</button>
        </div>
      </div>
    </div>`;
  document.getElementById('prof-save').addEventListener('click', async () => {
    const msgEl = document.getElementById('prof-info-msg');
    try {
      await api.put('/settings', {
        businessName: val('pf-name').trim(), businessCity: val('pf-city').trim(), businessState: val('pf-state').trim(),
        udyam: val('pf-udyam').trim(), address: val('pf-address').trim(), mobile: val('pf-mobile').trim()
      });
      await refreshSettings();
      renderSidebarFoot();
      showSecMsg(msgEl, 'Business info updated.', true);
    } catch (e) { showSecMsg(msgEl, e.message, false); }
  });
  document.getElementById('prof-edit').addEventListener('click', () => goPage('settings'));
  document.getElementById('sec-logout-all').addEventListener('click', () => {
    openModal('Sign out?', `<p style="font-size:13.5px;color:var(--text-soft);">You'll need to sign in again to access the workspace.</p>`,
      [{ label: 'Cancel', cls: 'btn-outline', action: closeModal }, { label: 'Sign out', cls: 'btn-primary', action: () => { closeModal(); doLogout(); } }]);
  });
  document.getElementById('sec-save').addEventListener('click', async () => {
    const msgEl = document.getElementById('prof-sec-msg');
    try {
      const resp = await api.post('/auth/change-password', {
        currentPassword: val('sec-current'), newEmail: val('sec-email').trim(),
        newPassword: val('sec-new'), confirmPassword: val('sec-confirm')
      });
      if (resp.token) api.setToken(resp.token, !!localStorage.getItem('shekhar_token'));
      document.getElementById('sec-current').value = '';
      document.getElementById('sec-new').value = '';
      document.getElementById('sec-confirm').value = '';
      showSecMsg(msgEl, 'Login details updated successfully.', true);
    } catch (e) { showSecMsg(msgEl, e.message, false); }
  });
}
function showSecMsg(el, text, ok) {
  el.textContent = text; el.style.display = 'block';
  el.style.background = ok ? 'var(--green-bg)' : 'var(--red-bg)';
  el.style.color = ok ? 'var(--green)' : 'var(--red)';
}

/* ---------------------------- Offline sync status ---------------------------- */
function renderSyncStatus({ online, pending }) {
  const el = document.getElementById('sync-status');
  if (online && !pending) { el.style.display = 'none'; return; }
  el.style.display = 'flex';
  el.style.cssText = 'display:flex;align-items:center;gap:6px;font-size:12px;font-weight:600;padding:6px 12px;border-radius:999px;margin-right:4px;' +
    (online ? 'background:var(--amber-bg);color:var(--amber);' : 'background:var(--red-bg);color:var(--red);');
  el.innerHTML = online
    ? `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M21 12a9 9 0 11-6.2-8.6"/></svg>Syncing ${pending} change${pending === 1 ? '' : 's'}…`
    : `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 1l22 22M16.7 16.7A9 9 0 015 5"/><path d="M9 9a3 3 0 014.2 0"/></svg>Offline — changes will sync${pending ? ` (${pending} pending)` : ''}`;
}

/* ---------------------------- Init ---------------------------- */
(async function init() {
  applyDarkModePreference();
  offlineSync.onStatusChange(renderSyncStatus);
  offlineSync.init(api.rawRequest);
  if (api.getToken()) {
    try {
      await api.get('/auth/me'); // validates the token (or resolves from offline cache)
      await enterApp();
      return;
    } catch (e) { /* fall through to login */ }
  }
  showLogin();
})();




