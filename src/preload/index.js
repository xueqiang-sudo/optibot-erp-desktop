/**
 * Preload Script - Bridge between Main Process and Frappe Web Page
 *
 * Uses contextBridge to expose a safe, limited API to the renderer process.
 * The Frappe web page can access hardware features via window.electronAPI.
 *
 * Security: contextIsolation=true, nodeIntegration=false
 * The remote Frappe page cannot access Node.js APIs directly.
 */

const { contextBridge, ipcRenderer } = require('electron');

// Weight data callback registry
const weightCallbacks = [];
const statusCallbacks = [];
const scaleErrorCallbacks = [];
const printerStatusCallbacks = [];
const printerErrorCallbacks = [];
const menuActionCallbacks = [];

// ─── Listen for events from Main Process ─────────────────────────
ipcRenderer.on('scale:weight', (_event, weight) => {
  weightCallbacks.forEach((cb) => {
    try {
      cb(weight);
    } catch (err) {
      console.error('[electronAPI] weight callback error:', err);
    }
  });
});

ipcRenderer.on('scale:status', (_event, status) => {
  statusCallbacks.forEach((cb) => {
    try {
      cb(status);
    } catch (err) {
      console.error('[electronAPI] scale status callback error:', err);
    }
  });
});

ipcRenderer.on('scale:error', (_event, error) => {
  scaleErrorCallbacks.forEach((cb) => {
    try {
      cb(error);
    } catch (err) {
      console.error('[electronAPI] scale error callback error:', err);
    }
  });
});

ipcRenderer.on('printer:status', (_event, status) => {
  printerStatusCallbacks.forEach((cb) => {
    try {
      cb(status);
    } catch (err) {
      console.error('[electronAPI] printer status callback error:', err);
    }
  });
});

ipcRenderer.on('printer:error', (_event, error) => {
  printerErrorCallbacks.forEach((cb) => {
    try {
      cb(error);
    } catch (err) {
      console.error('[electronAPI] printer error callback error:', err);
    }
  });
});

ipcRenderer.on('menu:action', (_event, action) => {
  menuActionCallbacks.forEach((cb) => {
    try {
      cb(action);
    } catch (err) {
      console.error('[electronAPI] menu action callback error:', err);
    }
  });
});

// ─── Expose API via contextBridge ────────────────────────────────
contextBridge.exposeInMainWorld('electronAPI', {
  /**
   * Serial Port API (通用串口)
   *
   * Usage:
   *   const ports = await window.electronAPI.serial.listPorts();
   */
  serial: {
    /**
     * List all serial ports with full properties
     * @returns {Promise<Array<{
     *   path: string,          // 系统路径 (COM3, /dev/ttyUSB0)
     *   manufacturer: string,  // 制造商
     *   serialNumber: string,  // 序列号
     *   pnpId: string,         // PnP ID (Windows)
     *   locationId: string,    // Location ID (macOS)
     *   productId: string,     // USB Product ID
     *   vendorId: string,      // USB Vendor ID
     *   friendlyName: string,  // 友好名称
     * }>>}
     */
    listPorts: () => ipcRenderer.invoke('serial:list-ports'),
  },

  /**
   * Electronic Scale API
   *
   * Usage:
   *   const ports = await window.electronAPI.scale.listPorts();
   *   await window.electronAPI.scale.connect('/dev/ttyUSB0');
   *   window.electronAPI.scale.onWeight((data) => console.log(data));
   */
  scale: {
    /**
     * List available serial ports
     * @returns {Promise<Array<{path: string, manufacturer: string, serialNumber: string}>>}
     */
    listPorts: () => ipcRenderer.invoke('scale:list-ports'),

    /**
     * Connect to electronic scale on specified serial port
     * @param {string} port - Serial port path (e.g., 'COM3' on Windows)
     * @param {Object} [options] - Serial port options (override defaults)
     * @param {number} [options.baudRate=9600] - Baud rate (e.g., 9600, 19200, 38400, 115200)
     * @param {number} [options.dataBits=8] - Data bits (5, 6, 7, or 8)
     * @param {string} [options.parity='none'] - Parity ('none', 'even', 'odd', 'mark', 'space')
     * @param {number} [options.stopBits=1] - Stop bits (1 or 2)
     * @returns {Promise<{success: boolean}>}
     */
    connect: (port, options) => ipcRenderer.invoke('scale:connect', port, options),

    /**
     * Disconnect from electronic scale
     * @returns {Promise<{success: boolean}>}
     */
    disconnect: () => ipcRenderer.invoke('scale:disconnect'),

    /**
     * Register callback for weight data updates (throttled ~5Hz)
     * @param {function} callback - Called with { value: number, unit: string, raw: string, stable: boolean }
     */
    onWeight: (callback) => {
      if (typeof callback === 'function') {
        weightCallbacks.push(callback);
      }
    },

    /**
     * Register callback for scale connection status changes
     * @param {function} callback - Called with { connected: boolean, port: string }
     */
    onStatus: (callback) => {
      if (typeof callback === 'function') {
        statusCallbacks.push(callback);
      }
    },

    /**
     * Register callback for scale errors
     * @param {function} callback - Called with error message string
     */
    onError: (callback) => {
      if (typeof callback === 'function') {
        scaleErrorCallbacks.push(callback);
      }
    },

    /**
     * Get current scale connection status
     * @returns {Promise<{connected: boolean, port: string|null}>}
     */
    getStatus: () => ipcRenderer.invoke('scale:get-status'),
  },

  /**
   * Label Printer API (TSC via Windows driver, TSPL commands)
   *
   * Printers are discovered through the Windows print driver (must be installed in Windows).
   * Raw TSPL data is sent through the Windows Spooler API.
   *
   * Usage:
   *   const printers = await window.electronAPI.printer.listPrinters();
   *   await window.electronAPI.printer.printTSPL(printers[0].id, 'SIZE 40 mm,30 mm\n...PRINT 1');
   *
   * TSPL with Chinese text (uses CHN font on printer flash):
   *   SIZE 40 mm,30 mm
   *   GAP 2 mm,0
   *   DIRECTION 1
   *   CODEPAGE UTF-8
   *   CLS
   *   TEXT 100,100,"CHN",0,1,1,"品名：蓝牙耳机"
   *   PRINT 1
   */
  printer: {
    /**
     * List available printers installed in Windows
     * @returns {Promise<Array<{id: string, name: string, driverName: string, port: string}>>}
     */
    listPrinters: () => ipcRenderer.invoke('printer:list'),

    /**
     * Send TSPL data to printer via Windows Spooler (RAW mode)
     * @param {string} printerId - Windows printer name from listPrinters()
     * @param {string} tsplData - Complete TSPL command string
     * @returns {Promise<{success: boolean}>}
     */
    printTSPL: (printerId, tsplData) =>
      ipcRenderer.invoke('printer:print', printerId, tsplData),

    /**
     * Get printer status
     * @returns {Promise<{connected: boolean, printers: Array}>}
     */
    getStatus: () => ipcRenderer.invoke('printer:get-status'),

    /**
     * Register callback for printer status changes
     * @param {function} callback
     */
    onStatus: (callback) => {
      if (typeof callback === 'function') {
        printerStatusCallbacks.push(callback);
      }
    },

    /**
     * Register callback for printer errors
     * @param {function} callback
     */
    onError: (callback) => {
      if (typeof callback === 'function') {
        printerErrorCallbacks.push(callback);
      }
    },
  },

  /**
   * Application API
   */
  app: {
    /**
     * Get application version
     * @returns {Promise<string>}
     */
    getVersion: () => ipcRenderer.invoke('app:get-version'),

    /**
     * Get saved configuration
     * @returns {Promise<Object>}
     */
    getConfig: () => ipcRenderer.invoke('app:get-config'),

    /**
     * Save configuration value
     * @param {string} key
     * @param {*} value
     * @returns {Promise<{success: boolean}>}
     */
    setConfig: (key, value) => ipcRenderer.invoke('app:set-config', key, value),

    /**
     * Append text to debug log file (debug-scale.log in app directory)
     * @param {string} text - Text to append
     * @returns {Promise<boolean>}
     */
    debugLog: (text) => ipcRenderer.invoke('app:debug-log', text),

    /**
     * Register callback for menu actions
     * @param {function} callback - Called with action name string
     */
    onMenuAction: (callback) => {
      if (typeof callback === 'function') {
        menuActionCallbacks.push(callback);
      }
    },

    /**
     * Check if running in Electron desktop environment
     * @returns {boolean}
     */
    isDesktop: true,
  },
});

// Log that preload is ready
console.log('[OptiBot ERP] Desktop API loaded. Access via window.electronAPI');
