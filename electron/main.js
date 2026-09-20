// Electron main process for the Shekhar Compute Tech Services desktop app.
//
// This does NOT reimplement the app — it starts the exact same Express
// server (server/server.js) in-process, points a native window at it, and
// stores data in the OS's proper per-user app-data folder instead of next
// to the installed program files (which may not be writable once installed).
//
// Python (for PDF/Excel generation) is still an external dependency — see
// checkPython() below, which shows a clear dialog instead of a silent
// failure if it's missing.

const { app, BrowserWindow, dialog, shell, Menu } = require('electron');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

const PREFERRED_PORT = 51837; // an uncommon port, unlikely to clash with anything else
let mainWindow = null;
let httpServer = null;
let resolvedPort = null;

function isPortFree(port) {
  return new Promise(resolve => {
    const tester = net.createServer()
      .once('error', () => resolve(false))
      .once('listening', () => tester.close(() => resolve(true)))
      .listen(port, '127.0.0.1');
  });
}

async function findFreePort(startPort) {
  let port = startPort;
  for (let i = 0; i < 20; i++) {
    if (await isPortFree(port)) return port;
    port++;
  }
  throw new Error('Could not find a free port to start the app on.');
}

function resolvePythonBin() {
  // Packaged builds bundle python/ under resources (see package.json
  // "extraResources"); dev mode just uses whatever's on PATH.
  return process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3');
}

function checkPython() {
  return new Promise(resolve => {
    const bin = resolvePythonBin();
    const proc = spawn(bin, ['-c', 'import reportlab, openpyxl; print("ok")']);
    let ok = false;
    proc.stdout.on('data', d => { if (d.toString().includes('ok')) ok = true; });
    proc.on('error', () => resolve({ ok: false, bin }));
    proc.on('close', () => resolve({ ok, bin }));
  });
}

async function warnIfPythonMissing() {
  const result = await checkPython();
  if (result.ok) return;
  const { response } = await dialog.showMessageBox({
    type: 'warning',
    title: 'Python not found',
    message: `Shekhar Compute — Invoicing needs Python 3 with "reportlab" and "openpyxl" installed to generate PDFs and Excel exports.`,
    detail: `Tried to run "${result.bin}" and it either isn't installed or is missing those packages.\n\n` +
      `To fix this:\n` +
      `1. Install Python 3 from python.org (check "Add python.exe to PATH" during install)\n` +
      `2. Open Command Prompt and run:\n   pip install reportlab openpyxl\n` +
      `3. Restart this app\n\n` +
      `Everything else in the app will work normally — only PDF/Excel generation needs Python.`,
    buttons: ['Open python.org', 'Continue anyway'],
    defaultId: 1,
    cancelId: 1
  });
  if (response === 0) shell.openExternal('https://www.python.org/downloads/');
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: '#F4F6FB',
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    },
    show: false
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.loadURL(`http://127.0.0.1:${resolvedPort}`);

  // Open any target="_blank" links (e.g. "Open python.org") in the OS browser
  // instead of a new Electron window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ label: app.getName(), submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'quit' }] }] : []),
    {
      label: 'File',
      submenu: [isMac ? { role: 'close' } : { role: 'quit' }]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Help',
      submenu: [{
        label: 'Open Data Folder',
        click: () => shell.openPath(app.getPath('userData'))
      }]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(async () => {
  // Point the server's JSON datastore at Electron's proper per-user data
  // folder (e.g. %APPDATA%\shekhar-invoice-app on Windows) BEFORE requiring
  // server.js, since db.js reads this env var at module-load time.
  process.env.SHEKHAR_DATA_DIR = path.join(app.getPath('userData'), 'data');
  process.env.PYTHON_BIN = resolvePythonBin();

  const { startServer } = require('../server/server');
  resolvedPort = await findFreePort(PREFERRED_PORT);
  httpServer = await startServer(resolvedPort);

  buildMenu();
  createWindow();
  warnIfPythonMissing();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (httpServer) httpServer.close();
  if (process.platform !== 'darwin') app.quit();
});
