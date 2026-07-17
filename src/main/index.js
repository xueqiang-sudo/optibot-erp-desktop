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
const TrayManager = require('./tray');
const UpdaterService = require('./updater');

// ─── Configuration ───────────────────────────────────────────────
const FRAPPE_URL = 'http://erp.optibot.cn:8080/';
const store = new Store({
  defaults: {
    windowBounds: { width: 1400, height: 900 },
    lastScalePort: null,
    lastScaleOptions: null,
    lastPrinterId: null,
    autoConnectScale: false,
    scaleAverageWindow: 5,
  },
});

// ─── Globals ─────────────────────────────────────────────────────
let mainWindow = null;
let scaleService = null;
let printerService = null;
let trayManager = null;
let updaterService = null;
let quitDialog = null;

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

  // ★ Intercept close: show custom confirmation dialog before quitting
  mainWindow.on('close', (event) => {
    if (!global.isQuitting) {
      event.preventDefault();

      // Don't create multiple dialogs
      if (quitDialog && !quitDialog.isDestroyed()) {
        quitDialog.focus();
        return;
      }

      const dialogHtml = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>退出确认</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{display:flex;justify-content:center;align-items:center;height:100vh;
background:#f5f5f5;font-family:"Microsoft YaHei","PingFang SC",sans-serif;
-webkit-app-region:drag;user-select:none}
.card{background:#fff;border-radius:10px;padding:36px 48px;
box-shadow:0 4px 24px rgba(0,0,0,0.1);text-align:center;-webkit-app-region:no-drag}
.msg{font-size:17px;color:#333;margin-bottom:28px}
.btns{display:flex;gap:20px;justify-content:center}
button{padding:9px 36px;font-size:15px;border-radius:6px;cursor:pointer;
border:none;font-family:inherit;transition:background .2s}
.yes{background:#1677ff;color:#fff}
.yes:hover{background:#4096ff}
.yes:active{background:#0958d9}
.no{background:#fff;color:#333;border:1px solid #d9d9d9}
.no:hover{color:#1677ff;border-color:#1677ff}
.no:active{color:#0958d9;border-color:#0958d9}
</style></head>
<body>
<div class="card">
<p class="msg">是否退出程序？</p>
<div class="btns">
<button class="yes" id="y">是</button>
<button class="no" id="n">否</button>
</div>
</div>
<script>
const{ipcRenderer}=require('electron');
document.getElementById('y').onclick=()=>ipcRenderer.send('quit-dialog:response',true);
document.getElementById('n').onclick=()=>ipcRenderer.send('quit-dialog:response',false);
</script>
</body></html>`;

      quitDialog = new BrowserWindow({
        width: 320,
        height: 180,
        parent: mainWindow,
        modal: true,
        frame: false,
        resizable: false,
        minimizable: false,
        maximizable: false,
        alwaysOnTop: true,
        skipTaskbar: true,
        autoHideMenuBar: true,
        backgroundColor: '#f5f5f5',
        webPreferences: {
          nodeIntegration: true,
          contextIsolation: false,
        },
      });

      const encodedHtml = Buffer.from(dialogHtml).toString('base64');
      quitDialog.loadURL(`data:text/html;base64,${encodedHtml}`);

      quitDialog.on('closed', () => {
        quitDialog = null;
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

  // ★ Fix nginx virtual host issue: ensure correct Host header
  // ★ Register hook BEFORE loading URL — intercept ALL requests and filter manually
  const { session } = require('electron');
  const targetUrl = new URL(FRAPPE_URL);

  session.defaultSession.webRequest.onBeforeSendHeaders(
    (details, callback) => {
      // Only modify requests to our target origin
      try {
        const reqUrl = new URL(details.url);
        if (reqUrl.hostname === targetUrl.hostname && reqUrl.port === targetUrl.port) {
          details.requestHeaders['Host'] = targetUrl.host;
          details.requestHeaders['User-Agent'] = details.requestHeaders['User-Agent'].replace(
            /Electron\/[\d.]+/,
            'Chrome/120.0.0.0'
          );
        }
      } catch (e) {
        // ignore URL parse errors
      }
      callback({ requestHeaders: details.requestHeaders });
    }
  );

  // ★ Show loading page first, then navigate to Frappe URL after a short delay
  // This ensures the onBeforeSendHeaders hook is fully registered before the main request
  const loadingHtml = `data:text/html;charset=utf-8,${encodeURIComponent(`
    <!DOCTYPE html>
    <html><head><meta charset="utf-8"><title>OptiBot ERP</title>
    <style>
      body{margin:0;display:flex;justify-content:center;align-items:center;height:100vh;
        background:#f0f2f5;font-family:"Microsoft YaHei","PingFang SC",sans-serif;}
      .wrap{text-align:center}
      .spinner{width:48px;height:48px;border:4px solid #e0e0e0;border-top:4px solid #1677ff;
        border-radius:50%;animation:spin .8s linear infinite;margin:0 auto 20px}
      @keyframes spin{to{transform:rotate(360deg)}}
      .title{font-size:22px;color:#333;font-weight:bold;margin-bottom:8px}
      .sub{font-size:14px;color:#999}
    </style></head>
    <body><div class="wrap">
      <div class="spinner"></div>
      <div class="title">OptiBot ERP</div>
      <div class="sub">正在连接服务器...</div>
    </div></body></html>
  `)}`;

  mainWindow.loadURL(loadingHtml);

  // Navigate to actual URL after hook has time to register
  let loadAttempts = 0;
  const MAX_LOAD_ATTEMPTS = 3;

  function loadFrappeUrl() {
    loadAttempts++;
    log.info(`Loading URL (attempt ${loadAttempts}): ${FRAPPE_URL}`);

    mainWindow.loadURL(FRAPPE_URL).then(() => {
      log.info('Page loaded successfully');
    }).catch((err) => {
      log.error('Page load failed:', err.message);
      if (loadAttempts < MAX_LOAD_ATTEMPTS) {
        log.info(`Retrying in 2 seconds...`);
        setTimeout(loadFrappeUrl, 2000);
      } else {
        dialog.showMessageBox(mainWindow, {
          type: 'error',
          title: '页面加载失败',
          message: '无法加载 ERP 页面',
          detail: `URL: ${FRAPPE_URL}\n错误: ${err.message}\n\n请检查：\n1. 网络连接是否正常\n2. 服务器 ${FRAPPE_URL} 是否可访问\n3. 防火墙是否阻止了连接\n\n点击"重试"重新加载，点击"退出"关闭程序。`,
          buttons: ['重试', '退出'],
          defaultId: 0,
        }).then((r) => {
          if (r.response === 0) {
            loadAttempts = 0;
            loadFrappeUrl();
          } else {
            global.isQuitting = true;
            app.quit();
          }
        });
      }
    });
  }

  // Delay to ensure hook is ready, then load
  setTimeout(loadFrappeUrl, 500);

  // ★ Page load failure handler
  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
    log.error(`Page load failed: ${errorCode} - ${errorDescription} (${validatedURL})`);

    // Auto-retry on failure
    if (loadAttempts < MAX_LOAD_ATTEMPTS) {
      log.info(`Auto-retrying in 2 seconds (attempt ${loadAttempts}/${MAX_LOAD_ATTEMPTS})...`);
      setTimeout(loadFrappeUrl, 2000);
      return;
    }

    dialog.showMessageBox(mainWindow, {
      type: 'error',
      title: '页面加载失败',
      message: `错误代码: ${errorCode}`,
      detail: `描述: ${errorDescription}\nURL: ${validatedURL || FRAPPE_URL}\n\n点击"重试"重新加载。`,
      buttons: ['重试', '打开调试工具', '退出'],
      defaultId: 0,
    }).then((r) => {
      if (r.response === 0) {
        loadAttempts = 0;
        loadFrappeUrl();
      } else if (r.response === 1) {
        mainWindow.webContents.openDevTools({ mode: 'detach' });
        loadAttempts = 0;
        loadFrappeUrl();
      } else {
        global.isQuitting = true;
        app.quit();
      }
    });
  });

  // Inject bridge script after page loads
  mainWindow.webContents.on('did-finish-load', async () => {
    const title = mainWindow.getTitle();
    log.info(`Page finished loading, title: "${title}"`);

    // ★ Detect nginx welcome page and auto-retry
    const isNginxWelcome =
      title.toLowerCase().includes('welcome to nginx') ||
      title.toLowerCase().includes('test nginx') ||
      title === 'Welcome to nginx!';

    if (isNginxWelcome && loadAttempts < MAX_LOAD_ATTEMPTS) {
      log.warn(`Detected nginx welcome page (attempt ${loadAttempts}), retrying in 2s...`);
      setTimeout(loadFrappeUrl, 2000);
      return;
    }

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

  ipcMain.handle('scale:connect', async (_event, port, options) => {
    await scaleService.connect(port, options);
    store.set('lastScalePort', port);
    if (options) {
      store.set('lastScaleOptions', options);
    }
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

  ipcMain.handle('printer:print', async (_event, printerId, tsplData) => {
    return await printerService.printTSPL(printerId, tsplData);
  });

  ipcMain.handle('printer:get-status', () => {
    return printerService.getStatus();
  });

  ipcMain.handle('app:get-version', () => {
    return app.getVersion();
  });

  ipcMain.handle('app:get-config', () => {
    return {
      lastScalePort: store.get('lastScalePort'),
      lastScaleOptions: store.get('lastScaleOptions'),
      lastPrinterId: store.get('lastPrinterId'),
      autoConnectScale: store.get('autoConnectScale'),
    };
  });

  ipcMain.handle('app:set-config', (_event, key, value) => {
    store.set(key, value);
    return { success: true };
  });

  // ★ Quit dialog response handler
  ipcMain.on('quit-dialog:response', (_event, confirmed) => {
    if (confirmed) {
      global.isQuitting = true;
      app.quit();
    } else {
      if (quitDialog && !quitDialog.isDestroyed()) {
        quitDialog.destroy();
      }
      quitDialog = null;
    }
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

  // TSPL does not need font preloading — Chinese fonts are referenced
  // directly by name (e.g., "CHN") in TEXT commands

  printerService.initUSBWatcher();

  // Auto-connect scale
  const lastPort = store.get('lastScalePort');
  const lastScaleOptions = store.get('lastScaleOptions');
  const autoConnect = store.get('autoConnectScale');
  if (autoConnect && lastPort) {
    setTimeout(async () => {
      try {
        await scaleService.connect(lastPort, lastScaleOptions || {});
      } catch (err) {
        log.warn('Auto-connect scale failed:', err.message);
      }
    }, 3000);
  }

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
