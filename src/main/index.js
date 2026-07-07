/**
 * OptiBot ERP Desktop Application - Main Process Entry Point
 *
 * Loads the remote Frappe ERP application in a BrowserWindow and
 * initializes hardware services (electronic scale + label printer).
 */

const { app, BrowserWindow, ipcMain, Menu } = require('electron');
const path = require('path');
const log = require('electron-log');
const Store = require('electron-store');

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
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // Allow loading remote content with preload
      webSecurity: true,
    },
  });

  // Load the remote Frappe application
  mainWindow.loadURL(FRAPPE_URL);

  // Save window size on resize
  mainWindow.on('resize', () => {
    const bounds = mainWindow.getBounds();
    store.set('windowBounds', { width: bounds.width, height: bounds.height });
  });

  // Minimize to tray on close instead of quitting
  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
      if (trayManager) {
        trayManager.showBalloon();
      }
    }
    return false;
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
    // Re-inject bridge after SPA navigation
    _injectBridge();
  });

  return mainWindow;
}

/**
 * Inject the bridge script into the Frappe web page
 */
function _injectBridge() {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  const bridgePath = path.join(__dirname, '../renderer/bridge.js');
  const fs = require('fs');

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
    try {
      return await scaleService.listPorts();
    } catch (err) {
      log.error('scale:list-ports error:', err);
      throw err;
    }
  });

  ipcMain.handle('scale:connect', async (_event, port) => {
    try {
      await scaleService.connect(port);
      store.set('lastScalePort', port);
      return { success: true };
    } catch (err) {
      log.error('scale:connect error:', err);
      throw err;
    }
  });

  ipcMain.handle('scale:disconnect', async () => {
    try {
      await scaleService.disconnect();
      return { success: true };
    } catch (err) {
      log.error('scale:disconnect error:', err);
      throw err;
    }
  });

  ipcMain.handle('scale:get-status', () => {
    return scaleService.getStatus();
  });

  // ── Printer IPC ──
  ipcMain.handle('printer:list', async () => {
    try {
      return await printerService.listPrinters();
    } catch (err) {
      log.error('printer:list error:', err);
      throw err;
    }
  });

  ipcMain.handle('printer:print', async (_event, printerId, zplData) => {
    try {
      return await printerService.printZPL(printerId, zplData);
    } catch (err) {
      log.error('printer:print error:', err);
      throw err;
    }
  });

  ipcMain.handle('printer:get-status', () => {
    return printerService.getStatus();
  });

  ipcMain.handle('printer:preload-font', async (_event, printerId) => {
    try {
      await fontPreloader.preloadFont(printerId);
      return { success: true };
    } catch (err) {
      log.error('printer:preload-font error:', err);
      throw err;
    }
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

  // Forward weight data to renderer
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

  // Link font preloader to printer service
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

  // Initialize USB watcher
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
    }, 3000); // Wait 3s after startup
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
  }, 5000); // Wait 5s after startup

  // Tray manager
  trayManager = new TrayManager(mainWindow);

  // Updater
  updaterService = new UpdaterService(mainWindow);
  updaterService.checkForUpdates();
}

// ─── App Lifecycle ───────────────────────────────────────────────
app.whenReady().then(() => {
  log.info('OptiBot ERP Desktop starting...');

  // ★ Remove all default menus (File, Edit, View, etc.)
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

app.on('before-quit', () => {
  app.isQuitting = true;

  // Cleanup services
  if (scaleService) {
    scaleService.destroy();
  }
  if (printerService) {
    printerService.destroy();
  }
  if (trayManager) {
    trayManager.destroy();
  }
});

// ★ Do NOT quit when all windows are closed — keep running in system tray
app.on('window-all-closed', () => {
  // Intentionally empty: app stays alive in tray
  // Only quits via tray menu "退出" or app.quit()
});

// Handle uncaught errors gracefully
process.on('uncaughtException', (error) => {
  log.error('Uncaught exception:', error);
});

process.on('unhandledRejection', (reason) => {
  log.error('Unhandled rejection:', reason);
});
