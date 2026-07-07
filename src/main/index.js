/**
 * OptiBot ERP Desktop Application - Main Process Entry Point
 *
 * Loads the remote Frappe ERP application in a BrowserWindow and
 * initializes hardware services (electronic scale + label printer).
 */

const { app, BrowserWindow, ipcMain, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const log = require('electron-log');
const Store = require('electron-store');

// ★ Remove ALL default menus immediately (before anything else)
Menu.setApplicationMenu(null);

// ★ Allow loading HTTP pages (disable web security for remote HTTP content)
app.commandLine.appendSwitch('allow-insecure-localhost', 'true');
app.commandLine.appendSwitch('ignore-certificate-errors', 'true');

const ScaleService = require('./scale-service');
const PrinterService = require('./printer-service');
const FontPreloader = require('./font-preloader');
const TrayManager = require('./tray');
const UpdaterService = require('./updater');

// ─── Configuration ───────────────────────────────────────────────
const FRAPPE_URL = 'http://erp.optibot.cn:8080/';
const store = new Store({
  defaults: {
    windowBounds: { width: 1400, height: 900 },
    lastScalePort: null,
    lastPrinterId: null,
    autoConnectScale: false,
    scaleAverageWindow: 5,
  },
});

// ─── Globals ─────────────────────────────────────────────────────
let mainWindow = null;
let scaleService = null;
let printerService = null;
let fontPreloader = null;
let trayManager = null;
let updaterService = null;
let isQuitting = false;

// ─── Logging ─────────────────────────────────────────────────────
log.transports.file.level = 'info';
log.transports.console.level = 'debug';

// ─── Window Creation ─────────────────────────────────────────────
function createMainWindow() {
  const { width, height } = store.get('windowBounds');

  mainWindow = new BrowserWindow({
    width,
    height,
    minWidth: 800,
    minHeight: 600,
    title: 'OptiBot ERP',
    icon: path.join(__dirname, '../../assets/icon.ico'),
    // ★ Remove menu bar completely
    autoHideMenuBar: true,
    // ★ Start hidden, show after page loads (avoid white flash)
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // ★ Allow loading remote HTTP content
      webSecurity: false,
      allowRunningInsecureContent: true,
    },
  });

  // ★ Force remove menu after window creation (double safety)
  mainWindow.setMenuBarVisibility(false);
  mainWindow.setAutoHideMenuBar(true);

  // Show window once page is ready
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // Load the remote Frappe application
  mainWindow.loadURL(FRAPPE_URL);

  // Save window size on resize
  mainWindow.on('resize', () => {
    const bounds = mainWindow.getBounds();
    store.set('windowBounds', { width: bounds.width, height: bounds.height });
  });

  // ★ Intercept close: minimize to tray instead of quitting
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
      if (trayManager) {
        trayManager.showBalloon();
      }
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Open DevTools with Ctrl+Shift+I
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.control && input.shift && input.key === 'I') {
      mainWindow.webContents.toggleDevTools();
      event.preventDefault();
    }
  });

  // Inject bridge script after page loads
  mainWindow.webContents.on('did-finish-load', () => {
    log.info('Frappe page loaded successfully');
    _injectBridge();
  });

  // Handle navigation (SPA routing)
  mainWindow.webContents.on('did-navigate-in-page', () => {
    log.debug('In-page navigation detected');
    _injectBridge();
  });

  // Log page load failures for debugging
  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
    log.error(`Page load failed: ${errorCode} - ${errorDescription}`);
  });

  return mainWindow;
}

/**
 * Inject the bridge script into the Frappe web page
 */
function _injectBridge() {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  const bridgePath = path.join(__dirname, '../renderer/bridge.js');

  try {
    const bridgeCode = fs.readFileSync(bridgePath, 'utf-8');
    mainWindow.webContents.executeJavaScript(bridgeCode).catch((err) => {
      log.warn('Bridge injection failed:', err.message);
    });
  } catch (err) {
    log.warn('Could not read bridge script:', err.message);
  }
}

// ─── IPC Handlers ────────────────────────────────────────────────
function registerIPCHandlers() {
  // ── Scale IPC ──
  ipcMain.handle('scale:list-ports', async () => {
    return await scaleService.listPorts();
  });

  ipcMain.handle('scale:connect', async (_event, port) => {
    await scaleService.connect(port);
    store.set('lastScalePort', port);
    return { success: true };
  });

  ipcMain.handle('scale:disconnect', async () => {
    await scaleService.disconnect();
    return { success: true };
  });

  ipcMain.handle('scale:get-status', () => {
    return scaleService.getStatus();
  });

  // ── Printer IPC ──
  ipcMain.handle('printer:list', async () => {
    return await printerService.listPrinters();
  });

  ipcMain.handle('printer:print', async (_event, printerId, zplData) => {
    return await printerService.printZPL(printerId, zplData);
  });

  ipcMain.handle('printer:get-status', () => {
    return printerService.getStatus();
  });

  ipcMain.handle('printer:preload-font', async (_event, printerId) => {
    await fontPreloader.preloadFont(printerId);
    return { success: true };
  });

  ipcMain.handle('printer:is-font-loaded', (_event, printerId) => {
    return fontPreloader.isFontLoaded(printerId);
  });

  // ── App IPC ──
  ipcMain.handle('app:get-version', () => {
    return app.getVersion();
  });

  ipcMain.handle('app:get-config', () => {
    return {
      lastScalePort: store.get('lastScalePort'),
      lastPrinterId: store.get('lastPrinterId'),
      autoConnectScale: store.get('autoConnectScale'),
    };
  });

  ipcMain.handle('app:set-config', (_event, key, value) => {
    store.set(key, value);
    return { success: true };
  });
}

// ─── Service Initialization ──────────────────────────────────────
function initServices() {
  // Scale service
  scaleService = new ScaleService({
    averageWindow: store.get('scaleAverageWindow'),
  });

  scaleService.on('weight', (weight) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('scale:weight', weight);
    }
  });

  scaleService.on('status', (status) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('scale:status', status);
    }
  });

  scaleService.on('error', (error) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('scale:error', error.message || error);
    }
    log.error('Scale error:', error);
  });

  // Printer service
  printerService = new PrinterService();

  printerService.on('status', (status) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('printer:status', status);
    }
  });

  printerService.on('error', (error) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('printer:error', error.message || error);
    }
    log.error('Printer error:', error);
  });

  // Font preloader
  fontPreloader = new FontPreloader(printerService);
  printerService.setFontPreloader(fontPreloader);

  // USB hot-plug: auto-preload font when TSC printer is connected
  printerService.on('printer-attached', async (printerId) => {
    log.info(`TSC printer attached: ${printerId}`);
    try {
      await fontPreloader.preloadFont(printerId);
    } catch (err) {
      log.error('Auto font preload failed:', err);
    }
  });

  printerService.on('printer-detached', (printerId) => {
    log.info(`TSC printer detached: ${printerId}`);
    fontPreloader.markUnloaded(printerId);
  });

  printerService.initUSBWatcher();

  // Auto-connect scale if configured
  const lastPort = store.get('lastScalePort');
  const autoConnect = store.get('autoConnectScale');
  if (autoConnect && lastPort) {
    setTimeout(async () => {
      try {
        await scaleService.connect(lastPort);
        log.info(`Auto-connected scale on port: ${lastPort}`);
      } catch (err) {
        log.warn(`Auto-connect scale failed on ${lastPort}:`, err.message);
      }
    }, 3000);
  }

  // Auto-preload fonts for connected printers
  setTimeout(async () => {
    try {
      const printers = await printerService.listPrinters();
      for (const printer of printers) {
        await fontPreloader.preloadFont(printer.id);
        log.info(`Auto-preloaded font for printer: ${printer.id}`);
      }
    } catch (err) {
      log.warn('Auto font preload on startup failed:', err.message);
    }
  }, 5000);

  // ★ Create tray BEFORE assigning close handler
  trayManager = new TrayManager(mainWindow);

  // Updater
  updaterService = new UpdaterService(mainWindow);
  updaterService.checkForUpdates();
}

// ─── App Lifecycle ───────────────────────────────────────────────
app.whenReady().then(() => {
  log.info('OptiBot ERP Desktop starting...');
  log.info(`Target URL: ${FRAPPE_URL}`);

  // ★ Ensure menu is removed (again, for safety)
  Menu.setApplicationMenu(null);

  registerIPCHandlers();
  createMainWindow();
  initServices();

  app.on('activate', () => {
    if (mainWindow === null) {
      createMainWindow();
    } else {
      mainWindow.show();
    }
  });
});

// ★ Set isQuitting flag on before-quit
app.on('before-quit', () => {
  isQuitting = true;
});

app.on('quit', () => {
  // Cleanup services
  if (scaleService) scaleService.destroy();
  if (printerService) printerService.destroy();
  if (trayManager) trayManager.destroy();
});

// ★ Do NOT quit when all windows are closed — keep running in tray
app.on('window-all-closed', (e) => {
  // Prevent default quit behavior
  e.preventDefault();
});

// Handle uncaught errors gracefully
process.on('uncaughtException', (error) => {
  log.error('Uncaught exception:', error);
});

process.on('unhandledRejection', (reason) => {
  log.error('Unhandled rejection:', reason);
});
