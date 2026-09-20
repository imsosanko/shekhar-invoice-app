require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const bcrypt = require('bcryptjs');

const db = require('./db');
const { requireAuth } = require('./middleware/auth');

const authRoutes = require('./routes/auth.routes');
const customersRoutes = require('./routes/customers.routes');
const productsRoutes = require('./routes/products.routes');
const invoicesRoutes = require('./routes/invoices.routes');
const paymentsRoutes = require('./routes/payments.routes');
const expensesRoutes = require('./routes/expenses.routes');
const settingsRoutes = require('./routes/settings.routes');
const reportsRoutes = require('./routes/reports.routes');

const DEFAULT_ADMIN_PASSWORD = process.env.ADMIN_DEFAULT_PASSWORD || 'admin123';

// Safety net: a single unhandled error anywhere (e.g. a stray stream 'error'
// event, a rejected promise nobody awaited) should never be allowed to take
// the entire server down for every user — it should be logged loudly and
// the process should keep serving requests. This is exactly what previously
// let a Python child-process stdin write error ("write EOF") crash the whole
// app; see server/routes/invoices.routes.js for the actual fix to that bug,
// and treat this as the last line of defense for anything else like it.
process.on('uncaughtException', err => {
  console.error('\n[uncaughtException] This should not happen — please report it. The server is staying up, but this request likely failed:');
  console.error(err);
});
process.on('unhandledRejection', err => {
  console.error('\n[unhandledRejection] This should not happen — please report it. The server is staying up, but this request likely failed:');
  console.error(err);
});

/**
 * Builds and returns the Express app. Doesn't start listening — see
 * startServer() below. Split out so both the CLI entry point (bottom of this
 * file) and the Electron desktop app (electron/main.js) share the exact same
 * server code with no duplication.
 */
function createApp() {
  // First-boot setup: seed demo data and set the initial admin password.
  // Uses whatever data directory db.js is currently pointed at (see
  // SHEKHAR_DATA_DIR — Electron sets this to the OS's per-user app data
  // folder before requiring this module, so the desktop app's data lives
  // in the right place instead of next to a possibly read-only install dir).
  db.seedIfEmpty();
  const auth = db.getAuth();
  if (!auth.passwordHash) {
    auth.passwordHash = bcrypt.hashSync(DEFAULT_ADMIN_PASSWORD, 10);
    db.setAuth(auth);
    console.log(`\n  First run: admin login created.`);
    console.log(`  Email:    ${auth.email}`);
    console.log(`  Password: ${DEFAULT_ADMIN_PASSWORD}  (change this in Profile → Security after signing in)\n`);
  }

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '10mb' })); // generous limit — logo/QR images are sent as base64

  // --- API routes ---
  app.use('/api/auth', authRoutes);
  app.use('/api/customers', requireAuth, customersRoutes);
  app.use('/api/products', requireAuth, productsRoutes);
  app.use('/api/invoices', requireAuth, invoicesRoutes);
  app.use('/api/payments', requireAuth, paymentsRoutes);
  app.use('/api/expenses', requireAuth, expensesRoutes);
  app.use('/api/settings', requireAuth, settingsRoutes);
  app.use('/api/reports', requireAuth, reportsRoutes);

  app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

  // Serve the service worker with no-cache so browsers always check for an
  // updated version immediately, rather than reusing a stale cached copy of
  // sw.js itself (which would then keep enforcing its own old caching rules).
  app.get('/sw.js', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.sendFile(path.join(__dirname, '..', 'public', 'sw.js'));
  });

  // --- Static frontend (vanilla JS/HTML/CSS) ---
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.get('*', (req, res) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
  });

  return app;
}

/**
 * Starts listening and returns the underlying http.Server (so callers, e.g.
 * Electron on quit, can close it cleanly). Resolves once listening.
 */
function startServer(port) {
  const app = createApp();
  return new Promise((resolve, reject) => {
    // CHANGED: '0.0.0.0' allows Railway (and other cloud hosts) to route external traffic into the container
    const server = app.listen(port, '0.0.0.0', () => {
      console.log(`Shekhar Compute Tech Services — Invoicing app running on port ${port}`);
      resolve(server);
    });
    server.on('error', reject);
  });
}

module.exports = { createApp, startServer };

// CLI entry point: `node server/server.js` / `npm start` — unchanged behavior
// for anyone running this as a plain web app rather than through Electron.
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  startServer(PORT).catch(err => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });
}