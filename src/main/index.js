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

  // ★ Error page HTML — shown when server is unreachable
  function buildErrorPage(errorMsg) {
    const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>OptiBot ERP</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{display:flex;justify-content:center;align-items:center;height:100vh;
  background:#f0f2f5;font-family:"Microsoft YaHei","PingFang SC",sans-serif}
.card{background:#fff;border-radius:12px;padding:48px;text-align:center;
  box-shadow:0 4px 24px rgba(0,0,0,0.1);max-width:420px}
.icon{font-size:64px;margin-bottom:20px}
.title{font-size:20px;color:#333;font-weight:bold;margin-bottom:12px}
.msg{font-size:14px;color:#666;line-height:1.6;margin-bottom:8px}
.url{font-size:12px;color:#999;word-break:break-all;margin-bottom:24px}
.btn{padding:10px 40px;font-size:15px;border-radius:6px;cursor:pointer;
  border:none;font-family:inherit;transition:background .2s}
.btn-retry{background:#1677ff;color:#fff}
.btn-retry:hover{background:#4096ff}
.btn-retry:active{background:#0958d9}
</style></head>
<body>
<div class="card">
  <div class="icon">⚠️</div>
  <div class="title">网络连接失败</div>
  <div class="msg">无法连接到 ERP 服务器，请检查网络</div>
  <div class="url">${FRAPPE_URL}<br>${errorMsg || ''}</div>
  <button class="btn btn-retry" onclick="doRefresh()">刷新重试</button>
</div>
<script>
const{ipcRenderer}=require('electron');
function doRefresh(){ipcRenderer.send('app:refresh-page')}
</script>
</body></html>`;
    return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
  }

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
        // Show error page instead of native dialog — app stays alive
        log.warn('All load attempts failed, showing error page');
        mainWindow.loadURL(buildErrorPage(err.message));
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

    // Show error page instead of native dialog — app stays alive
    log.warn('All load attempts failed, showing error page');
    mainWindow.loadURL(buildErrorPage(`${errorCode}: ${errorDescription}`));
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
    // 方法一：serialport 库
    try {
      const ports = await scaleService.listPorts();
      if (ports.length > 0) return ports;
    } catch (err) {
      log.warn('[scale:list-ports] scaleService.listPorts() failed:', err.message);
    }

    // 方法二：Windows 注册表回退
    if (process.platform === 'win32') {
      try {
        const { execSync } = require('child_process');
        let regOutput = '';
        try {
          regOutput = execSync(
            'reg query "HKLM\\HARDWARE\\DEVICEMAP\\SERIALCOMM"',
            { encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }
          );
        } catch (regErr) {
          regOutput = regErr.stdout || '';
        }

        const comPorts = [];
        for (const line of regOutput.split('\n')) {
          const match = line.match(/REG_SZ\s+(COM\d+)/i);
          if (match) {
            const comPath = match[1].toUpperCase();
            const nameMatch = line.match(/\\Device\\(\S+)/);
            const deviceName = nameMatch ? nameMatch[1] : comPath;
            comPorts.push({
              path: comPath,
              manufacturer: 'Unknown',
              serialNumber: '',
              pnpId: '',
              productId: '',
              vendorId: '',
              friendlyName: `${deviceName} (${comPath})`,
            });
          }
        }

        if (comPorts.length > 0) {
          log.info(`[scale:list-ports] Registry fallback found ${comPorts.length} port(s)`);
          return comPorts;
        }
      } catch (err) {
        log.warn('[scale:list-ports] Windows fallback failed:', err.message);
      }
    }

    return [];
  });

  ipcMain.handle('scale:connect', async (_event, port, options) => {
    log.info(`scale:connect called — port=${port}`);

    try {
      await scaleService.connect(port, options);
      store.set('lastScalePort', port);
      if (options) {
        store.set('lastScaleOptions', options);
      }
      store.set('autoConnectScale', true); // Enable auto-connect on next startup
      return { success: true };
    } catch (err) {
      throw err;
    }
  });

  ipcMain.handle('scale:disconnect', async () => {
    log.info(`scale:disconnect called`);

    try {
      await scaleService.disconnect();
    } catch (err) {
      log.warn('scale:disconnect error:', err.message);
    }
    store.set('autoConnectScale', false); // Disable auto-connect
    return { success: true };
  });

  ipcMain.handle('scale:get-status', () => {
    return scaleService.getStatus();
  });

  // ★ 重置称重状态（用户点"开始称重"时调用）
  ipcMain.handle('scale:reset-reading', () => {
    scaleService.resetReading();
    return { success: true };
  });

  // ★ List all serial ports with full properties
  ipcMain.handle('serial:list-ports', async () => {
    const mapPort = (p) => ({
      path: p.path || '',
      manufacturer: p.manufacturer || '',
      serialNumber: p.serialNumber || '',
      pnpId: p.pnpId || '',
      locationId: p.locationId || '',
      productId: p.productId || '',
      vendorId: p.vendorId || '',
      friendlyName: p.friendlyName || p.path || '',
    });

    // 方法一：使用 serialport 库（依赖原生模块）
    try {
      const { SerialPort } = require('serialport');
      log.info('[serial:list-ports] serialport module loaded OK');
      const ports = await SerialPort.list();
      log.info(`[serial:list-ports] SerialPort.list() returned ${ports.length} port(s)`);
      if (ports.length > 0) {
        return ports.map(mapPort);
      }
    } catch (err) {
      log.error('[serial:list-ports] serialport failed:', err.message);
    }

    // 方法二：Windows 回退 — 读注册表 SERIALCOMM（不需要原生模块）
    if (process.platform === 'win32') {
      try {
        const { execSync } = require('child_process');

        // 2a. 从注册表获取活跃的 COM 口列表
        // HKLM\HARDWARE\DEVICEMAP\SERIALCOMM 是所有活跃串口的权威来源
        let regOutput = '';
        try {
          regOutput = execSync(
            'reg query "HKLM\\HARDWARE\\DEVICEMAP\\SERIALCOMM"',
            { encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }
          );
        } catch (regErr) {
          // stderr 可能有输出，stdout 可能也有部分结果
          regOutput = regErr.stdout || '';
          log.warn('[serial:list-ports] reg query stderr:', regErr.stderr || regErr.message);
        }

        log.info('[serial:list-ports] reg query raw output:', regOutput.trim());

        // 解析 reg query 输出，格式如下：
        //   \Device\Serial0    REG_SZ    COM1
        //   \Device\VCP0       REG_SZ    COM3
        const comPorts = [];
        const lines = regOutput.split('\n');
        for (const line of lines) {
          // 匹配 REG_SZ 行，提取 COM 口号
          const match = line.match(/REG_SZ\s+(COM\d+)/i);
          if (match) {
            const comPath = match[1].toUpperCase();
            // 提取设备路径（行首有空格，不能用 ^ 锚定）
            const nameMatch = line.match(/\\Device\\(\S+)/);
            const deviceName = nameMatch ? nameMatch[1] : comPath;
            comPorts.push({
              path: comPath,
              manufacturer: '',
              serialNumber: '',
              pnpId: '',
              locationId: '',
              productId: '',
              vendorId: '',
              friendlyName: `${deviceName} (${comPath})`,
            });
          }
        }

        log.info(`[serial:list-ports] Registry fallback found ${comPorts.length} port(s):`,
          comPorts.map((p) => p.path).join(', '));

        if (comPorts.length > 0) {
          return comPorts;
        }

        // 2b. 注册表也为空时，尝试 wmic 作为最后手段
        try {
          const wmicOutput = execSync(
            'wmic path Win32_SerialPort get DeviceID,Caption,Description /format:csv',
            { encoding: 'utf8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] }
          );
          log.info('[serial:list-ports] wmic raw output:', wmicOutput.trim());
          const wmicPorts = [];
          for (const line of wmicOutput.split('\n')) {
            const cols = line.trim().split(',');
            // CSV 格式: Node, Caption, Description, DeviceID
            if (cols.length >= 4 && cols[3] && /^COM\d+/i.test(cols[3])) {
              wmicPorts.push({
                path: cols[3].trim(),
                manufacturer: '',
                serialNumber: '',
                pnpId: '',
                locationId: '',
                productId: '',
                vendorId: '',
                friendlyName: (cols[1] || cols[3]).trim(),
              });
            }
          }
          if (wmicPorts.length > 0) {
            log.info(`[serial:list-ports] WMIC fallback found ${wmicPorts.length} port(s)`);
            return wmicPorts;
          }
        } catch (wmicErr) {
          log.warn('[serial:list-ports] wmic fallback failed:', wmicErr.message);
        }
      } catch (fallbackErr) {
        log.error('[serial:list-ports] Windows fallback error:', fallbackErr.message);
      }
    }

    log.warn('[serial:list-ports] All methods returned 0 ports');
    return [];
  });

  ipcMain.handle('printer:list', async () => {
    return await printerService.listPrinters();
  });

  ipcMain.handle('printer:print-label', async (_event, printerId, labelConfig) => {
    try {
      log.info(`[IPC] printer:print-label called for "${printerId}"`);
      const result = await printerService.printLabel(printerId, labelConfig);
      log.info(`[IPC] printer:print-label completed successfully`);
      store.set('lastPrinterId', printerId); // Save last used printer
      return result;
    } catch (err) {
      log.error(`[IPC] printer:print-label failed:`, err.message);
      throw err;
    }
  });

  ipcMain.handle('printer:get-status', () => {
    return printerService.getStatus();
  });

  // ★ Device info query — returns current scale & printer state
  ipcMain.handle('device:get-info', () => {
    const scaleStatus = scaleService ? scaleService.getStatus() : { connected: false, port: null };
    const printerStatus = printerService ? printerService.getStatus() : { connected: false, printers: [] };

    return {
      scale: {
        connected: scaleStatus.connected || false,
        port: scaleStatus.port || null,
        options: store.get('lastScaleOptions') || null,
        autoConnect: store.get('autoConnectScale') || false,
        savedPort: store.get('lastScalePort') || null,
      },
      printer: {
        savedId: store.get('lastPrinterId') || null,
        available: printerStatus.printers || [],
      },
    };
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

  // ★ Refresh page — triggered by error page's "刷新重试" button
  ipcMain.on('app:refresh-page', () => {
    log.info('[IPC] app:refresh-page — reloading ERP URL');
    if (mainWindow && !mainWindow.isDestroyed()) {
      // Show loading page briefly, then load ERP URL
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
          <div class="sub">正在重新连接服务器...</div>
        </div></body></html>
      `)}`;
      mainWindow.loadURL(loadingHtml);
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.loadURL(FRAPPE_URL).catch((err) => {
            log.error('Refresh load failed:', err.message);
          });
        }
      }, 500);
    }
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

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('scale:error', error.message || String(error));
    }
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

  // TSPL commands generated in pure JS — no DLL or font preloading needed
  // Chinese text uses printer-stored fonts (e.g., SourceHa.TTF, SimsunEx) referenced in TEXT commands

  printerService.initUSBWatcher();

  // Auto-connect scale
  const lastPort = store.get('lastScalePort');
  const lastScaleOptions = store.get('lastScaleOptions');
  const autoConnect = store.get('autoConnectScale');
  if (autoConnect && lastPort) {
    setTimeout(async () => {
      try {
        await scaleService.connect(lastPort, lastScaleOptions || {});
        log.info(`Auto-connected scale on ${lastPort}`);
      } catch (err) {
        log.warn(`Auto-connect scale failed on ${lastPort}: ${err.message}`);
        // Port may not exist anymore (unplugged/changed) — clear saved config
        store.set('autoConnectScale', false);
        store.set('lastScalePort', null);
        store.set('lastScaleOptions', null);
        // Notify renderer that auto-connect failed
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('scale:auto-connect-failed', {
            port: lastPort,
            error: err.message,
          });
        }
      }
    }, 3000);
  }

  // Check if saved printer still exists (after initial scan)
  const savedPrinterId = store.get('lastPrinterId');
  if (savedPrinterId) {
    setTimeout(async () => {
      try {
        const printers = await printerService.listPrinters();
        const found = printers.some((p) => p.id === savedPrinterId || p.name === savedPrinterId);
        if (!found) {
          log.warn(`Saved printer "${savedPrinterId}" no longer available, clearing config`);
          store.set('lastPrinterId', null);
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('printer:saved-not-found', {
              printerId: savedPrinterId,
            });
          }
        }
      } catch (err) {
        log.warn('Failed to verify saved printer:', err.message);
      }
    }, 5000);
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
