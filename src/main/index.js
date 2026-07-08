/**
 * OptiBot ERP Desktop Application - Main Process Entry Point
 */

const { app, BrowserWindow, ipcMain, Menu, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const log = require('electron-log');
const Store = require('electron-store');

// ★ Global flag shared across modules
global.isQuitting = false;

// ★ Remove menu BEFORE app ready
Menu.setApplicationMenu(null);

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
log.info(`OptiBot ERP starting, target URL: ${FRAPPE_URL}`);

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
    show: true, // Show immediately for debugging
    // ★ Force no menu
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: false,
      allowRunningInsecureContent: true,
    },
  });

  // ★ Force hide menu bar (multiple methods for reliability)
  mainWindow.setMenuBarVisibility(false);
  mainWindow.removeMenu();

  // Save window size on resize
  mainWindow.on('resize', () => {
    const bounds = mainWindow.getBounds();
    store.set('windowBounds', { width: bounds.width, height: bounds.height });
  });

  // ★ Intercept close: show confirmation dialog before quitting
  mainWindow.on('close', (event) => {
    if (!global.isQuitting) {
      event.preventDefault();
      dialog.showMessageBox(mainWindow, {
        type: 'question',
        title: 'OptiBot ERP',
        message: '确认退出',
        detail: '是否退出程序？',
        buttons: ['是', '否'],
        defaultId: 0,
        cancelId: 1,
      }).then((result) => {
        if (result.response === 0) {
          global.isQuitting = true;
          app.quit();
        }
      });
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

  // ★ Show debug dialog: confirm URL before loading
  dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: 'OptiBot ERP - 调试信息',
    message: '即将加载以下页面：',
    detail: `URL: ${FRAPPE_URL}\n\n版本: ${app.getVersion()}\nElectron: ${process.versions.electron}\nNode: ${process.versions.node}\nChrome: ${process.versions.chrome}\n平台: ${process.platform}\n\n点击"确定"继续加载，点击"取消"打开开发者工具。`,
    buttons: ['确定 - 加载页面', '取消 - 打开调试工具'],
    defaultId: 0,
    cancelId: 1,
  }).then((result) => {
    if (result.response === 1) {
      // User clicked cancel - open DevTools for debugging
      mainWindow.webContents.openDevTools({ mode: 'detach' });
    }

    log.info(`Loading URL: ${FRAPPE_URL}`);
    mainWindow.loadURL(FRAPPE_URL).then(() => {
      log.info('Page loaded successfully');
    }).catch((err) => {
      log.error('Page load failed:', err.message);
      // ★ Show error dialog
      dialog.showMessageBox(mainWindow, {
        type: 'error',
        title: '页面加载失败',
        message: '无法加载 ERP 页面',
        detail: `URL: ${FRAPPE_URL}\n错误: ${err.message}\n\n请检查：\n1. 网络连接是否正常\n2. 服务器 ${FRAPPE_URL} 是否可访问\n3. 防火墙是否阻止了连接\n\n点击"重试"重新加载，点击"退出"关闭程序。`,
        buttons: ['重试', '退出'],
        defaultId: 0,
      }).then((r) => {
        if (r.response === 0) {
          mainWindow.loadURL(FRAPPE_URL);
        } else {
          global.isQuitting = true;
          app.quit();
        }
      });
    });
  });

  // ★ Page load failure handler
  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
    log.error(`Page load failed: ${errorCode} - ${errorDescription} (${validatedURL})`);

    dialog.showMessageBox(mainWindow, {
      type: 'error',
      title: '页面加载失败',
      message: `错误代码: ${errorCode}`,
      detail: `描述: ${errorDescription}\nURL: ${validatedURL || FRAPPE_URL}\n\n点击"重试"重新加载。`,
      buttons: ['重试', '打开调试工具', '退出'],
      defaultId: 0,
    }).then((r) => {
      if (r.response === 0) {
        mainWindow.loadURL(FRAPPE_URL);
      } else if (r.response === 1) {
        mainWindow.webContents.openDevTools({ mode: 'detach' });
        mainWindow.loadURL(FRAPPE_URL);
      } else {
        global.isQuitting = true;
        app.quit();
      }
    });
  });

  // Inject bridge script after page loads
  mainWindow.webContents.on('did-finish-load', () => {
    log.info('Frappe page loaded successfully');
    _injectBridge();
  });

  // Handle SPA navigation
  mainWindow.webContents.on('did-navigate-in-page', () => {
    log.debug('In-page navigation detected');
    _injectBridge();
  });

  // Log the page title after load
  mainWindow.webContents.on('page-title-updated', (event, title) => {
    log.info(`Page title: ${title}`);
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
    log.error('Scale error:', error);
  });

  printerService = new PrinterService();

  printerService.on('status', (status) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('printer:status', status);
    }
  });

  printerService.on('error', (error) => {
    log.error('Printer error:', error);
  });

  fontPreloader = new FontPreloader(printerService);
  printerService.setFontPreloader(fontPreloader);

  printerService.on('printer-attached', async (printerId) => {
    try {
      await fontPreloader.preloadFont(printerId);
    } catch (err) {
      log.error('Auto font preload failed:', err);
    }
  });

  printerService.on('printer-detached', (printerId) => {
    fontPreloader.markUnloaded(printerId);
  });

  printerService.initUSBWatcher();

  // Auto-connect scale
  const lastPort = store.get('lastScalePort');
  const autoConnect = store.get('autoConnectScale');
  if (autoConnect && lastPort) {
    setTimeout(async () => {
      try {
        await scaleService.connect(lastPort);
      } catch (err) {
        log.warn('Auto-connect scale failed:', err.message);
      }
    }, 3000);
  }

  // Auto-preload fonts
  setTimeout(async () => {
    try {
      const printers = await printerService.listPrinters();
      for (const printer of printers) {
        await fontPreloader.preloadFont(printer.id);
      }
    } catch (err) {
      log.warn('Auto font preload failed:', err.message);
    }
  }, 5000);

  // Tray manager
  trayManager = new TrayManager(mainWindow);

  // Updater
  updaterService = new UpdaterService(mainWindow);
  updaterService.checkForUpdates();
}

// ─── App Lifecycle ───────────────────────────────────────────────
app.whenReady().then(() => {
  log.info('App ready, creating window...');

  // ★ Ensure no menu
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
  global.isQuitting = true;
});

app.on('quit', () => {
  if (scaleService) scaleService.destroy();
  if (printerService) printerService.destroy();
  if (trayManager) trayManager.destroy();
});

// ★ Do NOT quit when all windows closed — stay in tray
app.on('window-all-closed', () => {
  // Intentionally empty: keep app alive in tray
});

process.on('uncaughtException', (error) => {
  log.error('Uncaught exception:', error);
});

process.on('unhandledRejection', (reason) => {
  log.error('Unhandled rejection:', reason);
});
