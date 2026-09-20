// Lightweight file-backed JSON datastore.
// No native build tools required (unlike sqlite3/better-sqlite3), so `npm install`
// works on any machine out of the box. Swap this module out for a real SQL layer
// later without touching route/controller code — every route only calls db.* methods.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// SHEKHAR_DATA_DIR lets the Electron desktop app point this at the OS's
// per-user app-data folder (via app.getPath('userData')) instead of a
// folder next to the installed application, which may not be writable once
// installed to Program Files. Plain `npm start` web usage doesn't set this
// and keeps using ./data as before.
const DATA_DIR = process.env.SHEKHAR_DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

const COLLECTIONS = ['customers', 'products', 'invoices', 'payments', 'expenses'];

function uid() {
  return crypto.randomBytes(6).toString('hex');
}

const DEFAULT_SETTINGS = {
  businessName: 'Shekhar Compute Tech Services',
  businessType: 'Micro Enterprise',
  activity: 'Trading & IT Services',
  udyam: 'UDYAM-BR-15-0015734',
  address: 'Adarsh Colony, Road Number 3C, Khemnichak, Patna, Bihar',
  businessCity: 'Patna',
  businessState: 'Bihar',
  mobile: '8083541336',
  email: 'sshashank1997@gmail.com',
  showEmail: true,
  tagline: 'Web Development | Software Solutions | Digital Services',
  prefix: 'INV-2025-',
  nextNumber: 1,
  currency: 'INR',
  taxType: 'GST',
  defaultGst: 18,
  showBank: true,
  showUdyam: true,
  template: 'taxinvoice',
  defaultPaperSize: 'a4',
  primaryColor: '#1E3A8A',
  logoDataUrl: '',
  bankName: 'State Bank of India',
  bankAccount: '12345678901',
  bankIfsc: 'SBIN0001234',
  upiId: '8083541336@okbizaxis',
  showUpiQr: true,
  qrCodeDataUrl: '',
  paymentTerms: [
    '1. Payment must be made on or before the due date.',
    '2. Advance payment, where applicable, is required before commencement of work.',
    '3. Payments for completed services are non-refundable.',
    '4. Please mention the Invoice Number while making payment.',
    '5. Applicable taxes are charged as mentioned in the invoice.'
  ].join('\n'),
  terms: [
    '1. Goods/Services once delivered are subject to the agreed terms.',
    '2. Additional work beyond the agreed scope will be charged separately.',
    '3. Domain, hosting, licences and third-party charges are non-refundable.',
    '4. Delayed payment may result in suspension of services.',
    '5. All disputes are subject to Jehanabad, Bihar jurisdiction.'
  ].join('\n'),
  notes: [
    '1. Thank you for choosing Shekhar Compute Tech Services.',
    '2. Please verify the invoice details before making payment.',
    '3. For billing queries, please quote your Invoice Number.',
    '4. This is a computer-generated invoice and does not require a physical signature.'
  ].join('\n')
};

function defaultData() {
  return {
    auth: { email: DEFAULT_SETTINGS.email, passwordHash: null }, // set on first boot in server.js
    settings: { ...DEFAULT_SETTINGS },
    customers: [],
    products: [],
    invoices: [],
    payments: [],
    expenses: []
  };
}

let cache = null;
const BACKUP_FILE = path.join(DATA_DIR, 'db.backup.json');

function load() {
  if (cache) return cache;
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) {
    cache = defaultData();
    persistSync();
  } else {
    try {
      const raw = fs.readFileSync(DB_FILE, 'utf8');
      cache = { ...defaultData(), ...JSON.parse(raw) };
      cache.settings = { ...DEFAULT_SETTINGS, ...cache.settings };
    } catch (e) {
      console.error('db.json is unreadable (%s) — trying the last known-good backup instead.', e.message);
      try {
        const raw = fs.readFileSync(BACKUP_FILE, 'utf8');
        cache = { ...defaultData(), ...JSON.parse(raw) };
        cache.settings = { ...DEFAULT_SETTINGS, ...cache.settings };
        console.log('Recovered from data/db.backup.json.');
      } catch (e2) {
        console.error('No usable backup either — starting fresh. Corrupted file kept as db.json.corrupt for inspection.');
        try { fs.copyFileSync(DB_FILE, DB_FILE + '.corrupt'); } catch (e3) { /* best effort */ }
        cache = defaultData();
      }
    }
  }
  return cache;
}

let writeTimer = null;
function persist() {
  // Debounce writes slightly so bursts of updates don't thrash the disk.
  clearTimeout(writeTimer);
  writeTimer = setTimeout(persistSync, 30);
}
function persistSync() {
  clearTimeout(writeTimer);
  const json = JSON.stringify(cache, null, 2);
  const tmpFile = DB_FILE + '.tmp';
  try {
    // Keep a rolling backup of the last known-good write before overwriting,
    // and write atomically (write to temp file, then rename) so a crash or
    // power loss mid-write can never leave db.json half-written/corrupted.
    if (fs.existsSync(DB_FILE)) {
      try { fs.copyFileSync(DB_FILE, BACKUP_FILE); } catch (e) { /* best effort */ }
    }
    fs.writeFileSync(tmpFile, json, 'utf8');
    fs.renameSync(tmpFile, DB_FILE);
  } catch (e) {
    console.error('Failed to persist data/db.json:', e.message);
  }
}

const db = {
  uid,
  DEFAULT_SETTINGS,

  getAuth() { return load().auth; },
  setAuth(auth) { load().auth = auth; persist(); },

  getSettings() { return load().settings; },
  updateSettings(patch) {
    const s = load();
    s.settings = { ...s.settings, ...patch };
    persist();
    return s.settings;
  },

  list(collection) { return load()[collection] || []; },
  find(collection, id) { return load()[collection].find(x => x.id === id); },
  insert(collection, item) {
    const record = { id: uid(), createdAt: Date.now(), ...item };
    load()[collection].push(record);
    persist();
    return record;
  },
  update(collection, id, patch) {
    const list = load()[collection];
    const idx = list.findIndex(x => x.id === id);
    if (idx === -1) return null;
    list[idx] = { ...list[idx], ...patch, id };
    persist();
    return list[idx];
  },
  remove(collection, id) {
    const s = load();
    const before = s[collection].length;
    s[collection] = s[collection].filter(x => x.id !== id);
    persist();
    return s[collection].length < before;
  },

  seedIfEmpty() {
    const s = load();
    if (!s.customers.length) {
      s.customers = [
        { id: uid(), name: 'Demo Customer', mobile: '9000000000', email: '', address: 'Adarsh Colony, Road No. 3C, Jehanabad, Bihar - 804408', gstin: '', state: 'Bihar' },
        { id: uid(), name: 'ABC Enterprises', mobile: '9876500000', email: 'accounts@abcent.in', address: 'MG Road, Patna, Bihar - 800001', gstin: '10ABCDE1234F1Z5', state: 'Bihar' },
        { id: uid(), name: 'XYZ Solutions', mobile: '9822233344', email: 'info@xyzsol.com', address: 'Sector 5, Noida, UP - 201301', gstin: '09XYZAB5678G1Z2', state: 'Uttar Pradesh' }
      ];
    }
    if (!s.products.length) {
      s.products = [
        { id: uid(), name: 'Website Development', description: 'Custom responsive website design & development', hsn: '998313', rate: 15000, gst: 18, unit: 'Project' },
        { id: uid(), name: 'Software Solutions', description: 'Custom software / application development', hsn: '998313', rate: 25000, gst: 18, unit: 'Project' },
        { id: uid(), name: 'Domain & Hosting', description: 'Domain registration and web hosting (1 year)', hsn: '998315', rate: 1200, gst: 18, unit: 'Year' },
        { id: uid(), name: 'Logo Design', description: 'Brand logo design with revisions', hsn: '998314', rate: 1500, gst: 18, unit: 'Unit' },
        { id: uid(), name: 'Digital Marketing', description: 'Social media & digital marketing services', hsn: '998363', rate: 8000, gst: 18, unit: 'Month' },
        { id: uid(), name: 'Advertising Services', description: 'Online & print advertising campaign management', hsn: '998361', rate: 5000, gst: 18, unit: 'Campaign' },
        { id: uid(), name: 'Computer Services', description: 'Computer sales, repair & maintenance', hsn: '998719', rate: 800, gst: 18, unit: 'Service' },
        { id: uid(), name: 'Document Preparation', description: 'Typing, formatting & document preparation', hsn: '998312', rate: 200, gst: 18, unit: 'Page' },
        { id: uid(), name: 'Photocopying Services', description: 'Photocopy & printing services', hsn: '998912', rate: 2, gst: 18, unit: 'Copy' },
        { id: uid(), name: 'IT Consultancy', description: 'IT strategy & consultancy services', hsn: '998311', rate: 1500, gst: 18, unit: 'Hour' }
      ];
    }
    if (!s.expenses.length) {
      s.expenses = [
        { id: uid(), date: '2026-08-05', category: 'Software & Subscriptions', description: 'Domain renewal & cloud hosting', amount: 2400, method: 'UPI', createdAt: Date.now() },
        { id: uid(), date: '2026-08-12', category: 'Office Supplies', description: 'Printer ink & stationery', amount: 1150, method: 'Cash', createdAt: Date.now() },
        { id: uid(), date: '2026-08-27', category: 'Travel', description: 'Client site visit — Patna', amount: 900, method: 'Cash', createdAt: Date.now() }
      ];
    }
    persistSync();
  },

  raw() { return load(); },
  persistSync
};

module.exports = db;
