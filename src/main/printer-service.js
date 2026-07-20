/**
 * Label Printer Service — TSCLIB.dll via PowerShell P/Invoke
 *
 * Uses TSCLIB.dll (x64) to print labels through the TSC Windows driver.
 * DLL functions are called via PowerShell Add-Type + [DllImport] P/Invoke.
 *
 * Text rendering uses Windows system fonts (SimSun/宋体) via windowsfontUnicode(),
 * eliminating the dependency on printer flash-stored fonts.
 * Bold text is supported via the bold parameter.
 *
 * Printer discovery uses PowerShell Get-Printer cmdlet.
 */

const { EventEmitter } = require('events');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const log = require('electron-log');
const TSCLibWrapper = require('./tsclib-wrapper');

// PowerShell path (available on all modern Windows systems)
const POWERSHELL = 'powershell.exe';
const POWERSHELL_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];

// Polling interval for printer change detection (ms)
const POLL_INTERVAL = 5000;

// Timeout for PowerShell commands (ms)
const LIST_TIMEOUT = 10000;

// Temp directory for PowerShell scripts
const TEMP_DIR = os.tmpdir();

/**
 * PowerShell script to list installed printers.
 * Uses Get-Printer cmdlet (available since Windows 8 / Server 2012).
 * Returns JSON array of printer objects.
 */
const PS_LIST_PRINTERS = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
try {
    $printers = Get-Printer | Select-Object Name, DriverName, PortName, Shared, PrinterStatus
    $printers | ConvertTo-Json -Compress
} catch {
    '[]'
}
`.trim();

class PrinterService extends EventEmitter {
  constructor() {
    super();

    this.knownPrinters = new Map(); // printerName → { name, driverName, portName, ... }
    this.pollTimer = null;
    this.polling = false;

    // TSCLIB.dll wrapper for printing
    this.tsclib = new TSCLibWrapper();

    // Bind methods
    this._pollPrinters = this._pollPrinters.bind(this);
  }

  /**
   * Initialize periodic polling for printer change detection.
   */
  initUSBWatcher() {
    if (this.pollTimer) return;

    log.info('[PrinterService] Starting printer polling (interval: %dms)', POLL_INTERVAL);

    // Pre-load TSCLIB.dll
    try {
      this.tsclib.load();
      log.info('[PrinterService] TSCLIB.dll pre-loaded successfully');
    } catch (err) {
      log.error('[PrinterService] TSCLIB.dll pre-load failed:', err.message);
      // Will retry on first print attempt
    }

    // Do an initial scan
    this._pollPrinters();
    // Set up periodic polling
    this.pollTimer = setInterval(this._pollPrinters, POLL_INTERVAL);
  }

  /**
   * List available printers installed in Windows.
   * @returns {Promise<Array<{id: string, name: string, driverName: string, port: string}>>}
   */
  async listPrinters() {
    try {
      const output = await this._runPowerShell(PS_LIST_PRINTERS, LIST_TIMEOUT);
      let printers;

      if (!output || output.trim() === '' || output.trim() === '[]') {
        printers = [];
      } else {
        try {
          const parsed = JSON.parse(output);
          // PowerShell returns a single object if there's only one printer
          printers = Array.isArray(parsed) ? parsed : [parsed];
        } catch (parseErr) {
          log.warn('[PrinterService] Failed to parse printer list:', parseErr.message);
          printers = [];
        }
      }

      log.info(`[PrinterService] Found ${printers.length} printer(s) in Windows`);

      const result = [];
      this.knownPrinters.clear();

      for (const p of printers) {
        const name = p.Name || '';
        if (!name) continue;

        const info = {
          id: name,                         // Use Windows printer name as ID
          name: name,
          manufacturer: '',
          product: '',
          serialNumber: '',
          port: p.PortName || '',
          driverName: p.DriverName || '',
          shared: p.Shared || false,
          status: p.PrinterStatus,
        };

        result.push(info);
        this.knownPrinters.set(name, info);

        log.info(
          `  → Printer: "${name}" [Driver: ${info.driverName}] [Port: ${info.port}]`
        );
      }

      log.info(`[PrinterService] Printer scan complete: ${result.length} printer(s)`);
      return result;
    } catch (err) {
      log.error('[PrinterService] Failed to list printers:', err.message);
      return [];
    }
  }

  /**
   * Print a label using TSCLIB.dll (new method).
   *
   * Accepts a structured label configuration (JSON object) and renders
   * the label via TSCLIB.dll function calls using Windows system fonts.
   *
   * @param {string} printerId - Windows printer name
   * @param {Object} labelConfig - Label configuration
   * @param {number} labelConfig.width - Label width in mm
   * @param {number} labelConfig.height - Label height in mm
   * @param {number} [labelConfig.dpi=203] - Printer DPI
   * @param {number} [labelConfig.copies=1] - Number of copies
   * @param {Array} labelConfig.elements - Label elements
   * @returns {Promise<{success: boolean}>}
   */
  async printLabel(printerId, labelConfig) {
    const printer = this.knownPrinters.get(printerId);
    if (!printer) {
      // Printer might not be in knownPrinters if it was just connected
      // Try using the printerId as the name directly
      log.warn(`[PrinterService] Printer "${printerId}" not in known printers, using name directly`);
    }

    const printerName = printer ? printer.name : printerId;
    log.info(`[PrinterService] Printing label to "${printerName}" via TSCLIB.dll`);

    // Log label config summary
    const elCount = labelConfig.elements ? labelConfig.elements.length : 0;
    log.info(`[PrinterService] Label: ${labelConfig.width}×${labelConfig.height}mm, ${elCount} elements, ${labelConfig.copies || 1} copies`);

    const result = await this.tsclib.printLabel(printerName, labelConfig);

    log.info(`[PrinterService] Label printed successfully via TSCLIB.dll`);
    return result;
  }

  /**
   * Get printer status
   * @returns {{connected: boolean, printers: Array}}
   */
  getStatus() {
    return {
      connected: this.knownPrinters.size > 0,
      printers: Array.from(this.knownPrinters.keys()),
    };
  }

  /**
   * Clean up resources
   */
  destroy() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    // Close TSCLIB port if open
    if (this.tsclib) {
      this.tsclib.close();
      this.tsclib = null;
    }

    this.knownPrinters.clear();
    this.removeAllListeners();
  }

  // ─── Private Methods ─────────────────────────────────────────

  /**
   * Poll for printer changes by re-scanning installed printers.
   * Emits 'printer-attached' and 'printer-detached' events when changes are detected.
   * @private
   */
  async _pollPrinters() {
    if (this.polling) return; // Skip if previous poll is still running
    this.polling = true;

    try {
      const currentPrinters = await this._scanPrinters();
      const currentNames = new Set(currentPrinters.map((p) => p.name));
      const previousNames = new Set(this.knownPrinters.keys());

      // Detect newly attached printers
      for (const name of currentNames) {
        if (!previousNames.has(name)) {
          const info = currentPrinters.find((p) => p.name === name);
          log.info(`[PrinterService] Printer attached: "${name}"`);
          this.knownPrinters.set(name, info);
          this.emit('printer-attached', name);
        }
      }

      // Detect detached printers
      for (const name of previousNames) {
        if (!currentNames.has(name)) {
          log.info(`[PrinterService] Printer detached: "${name}"`);
          this.knownPrinters.delete(name);
          this.emit('printer-detached', name);
        }
      }

      // Emit status if changed
      if (currentNames.size !== previousNames.size ||
          [...currentNames].some((n) => !previousNames.has(n))) {
        this.emit('status', {
          connected: this.knownPrinters.size > 0,
          printers: Array.from(this.knownPrinters.keys()),
        });
      }
    } catch (err) {
      log.debug('[PrinterService] Poll error:', err.message);
    } finally {
      this.polling = false;
    }
  }

  /**
   * Quick scan of installed printers (without updating knownPrinters map).
   * @returns {Promise<Array<{name: string, driverName: string, port: string}>>}
   * @private
   */
  async _scanPrinters() {
    try {
      const output = await this._runPowerShell(PS_LIST_PRINTERS, LIST_TIMEOUT);
      if (!output || output.trim() === '' || output.trim() === '[]') {
        return [];
      }
      const parsed = JSON.parse(output);
      const printers = Array.isArray(parsed) ? parsed : [parsed];
      return printers
        .filter((p) => p.Name)
        .map((p) => ({
          name: p.Name,
          driverName: p.DriverName || '',
          port: p.PortName || '',
          shared: p.Shared || false,
          status: p.PrinterStatus,
        }));
    } catch (err) {
      log.debug('[PrinterService] Scan error:', err.message);
      return [];
    }
  }

  /**
   * Run a PowerShell script using a temp file for reliable encoding.
   * Used only for printer discovery (Get-Printer).
   *
   * @param {string} script - PowerShell script to execute
   * @param {number} timeout - Timeout in milliseconds
   * @returns {Promise<string>} stdout output
   * @private
   */
  _runPowerShell(script, timeout = 10000) {
    return new Promise((resolve, reject) => {
      const scriptFile = path.join(
        TEMP_DIR,
        `optibot-ps-${process.pid}-${Date.now()}.ps1`
      );

      // UTF-8 BOM ensures PowerShell reads the file correctly
      const BOM = '';
      fs.writeFileSync(scriptFile, BOM + script, 'utf-8');

      const args = [...POWERSHELL_ARGS, '-File', scriptFile];

      const child = execFile(POWERSHELL, args, {
        timeout,
        maxBuffer: 1024 * 1024,  // 1MB buffer
        windowsHide: true,
        encoding: 'utf-8',
      }, (error, stdout, stderr) => {
        // Clean up temp file
        try {
          fs.unlinkSync(scriptFile);
        } catch (e) {
          // Ignore cleanup errors
        }

        if (error) {
          if (error.killed) {
            reject(new Error(`PowerShell 命令执行超时 (${timeout / 1000}秒)`));
          } else {
            const errMsg = stderr ? stderr.trim() : error.message;
            reject(new Error(`PowerShell 执行失败: ${errMsg}`));
          }
          return;
        }

        if (stderr && stderr.trim()) {
          log.warn('[PrinterService] PowerShell stderr:', stderr.trim());
        }

        resolve(stdout ? stdout.trim() : '');
      });
    });
  }
}

module.exports = PrinterService;
