/**
 * Label Printer Service - Windows Spooler API Raw Printing
 *
 * Sends ZPL commands to label printers (e.g., TSC TE344) through the
 * Windows print driver using the Spooler API in RAW mode.
 *
 * How it works:
 * - The printer must be installed in Windows with its driver (e.g., TSC driver)
 * - We use the Windows Spooler API (OpenPrinter, WritePrinter, etc.) via PowerShell
 * - RAW mode sends ZPL data directly to the printer without driver processing
 * - This is more reliable than direct USB access (libusb) because:
 *   - Windows manages the USB communication through the driver
 *   - No need to claim USB interfaces or find endpoints
 *   - Works with shared printers, network printers, etc.
 *   - No conflicts with other applications using the printer
 *
 * Important:
 * - ZPL strings are sent as UTF-8 encoded data to support Chinese text
 * - Font code 'C' must be pre-loaded via FontPreloader before using ^AC in ZPL
 * - Printer ID is the Windows printer name (e.g., "TSC TE344")
 */

const { EventEmitter } = require('events');
const { execFile } = require('child_process');
const log = require('electron-log');

// PowerShell path (available on all modern Windows systems)
const POWERSHELL = 'powershell.exe';
const POWERSHELL_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];

// Polling interval for printer change detection (ms)
const POLL_INTERVAL = 5000;

// Timeout for PowerShell commands (ms)
const LIST_TIMEOUT = 10000;
const PRINT_TIMEOUT = 15000;

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

/**
 * Build a PowerShell script that sends raw data to a printer
 * via the Windows Spooler API (P/Invoke).
 *
 * The script:
 * 1. Defines P/Invoke signatures for winspool.drv functions
 * 2. Decodes base64-encoded raw data
 * 3. Opens the printer, starts a RAW doc, writes data, ends doc, closes printer
 *
 * @param {string} printerName - Windows printer name
 * @param {string} base64Data - Base64-encoded UTF-8 ZPL data
 * @param {string} docName - Document name for the print spooler
 * @returns {string} PowerShell script
 */
function buildRawPrintScript(printerName, base64Data, docName) {
  // Escape single quotes in printer name and doc name for PowerShell
  const escapedName = printerName.replace(/'/g, "''");
  const escapedDoc = docName.replace(/'/g, "''");

  return `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# ── Define Windows Spooler API via P/Invoke ──
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
public struct DOC_INFO_1 {
    [MarshalAs(UnmanagedType.LPWStr)] public string pDocName;
    [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile;
    [MarshalAs(UnmanagedType.LPWStr)] public string pDatatype;
}

public static class Winspool {
    [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool OpenPrinterW(string pPrinterName, out IntPtr phPrinter, IntPtr pDefault);

    [DllImport("winspool.drv", SetLastError = true)]
    public static extern bool ClosePrinter(IntPtr hPrinter);

    [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool StartDocPrinterW(IntPtr hPrinter, int Level, ref DOC_INFO_1 pDocInfo);

    [DllImport("winspool.drv", SetLastError = true)]
    public static extern bool EndDocPrinter(IntPtr hPrinter);

    [DllImport("winspool.drv", SetLastError = true)]
    public static extern bool WritePrinter(IntPtr hPrinter, byte[] pBytes, int dwCount, out int dwWritten);
}
"@

# ── Decode base64 data to bytes ──
$bytes = [System.Convert]::FromBase64String('${base64Data}')

# ── Open the printer ──
$printerName = '${escapedName}'
$handle = [IntPtr]::Zero

if (-not [Winspool]::OpenPrinterW($printerName, [ref]$handle, [IntPtr]::Zero)) {
    $err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
    throw "OpenPrinterW failed for '$printerName' (error code: $err)"
}

try {
    # ── Start a RAW print job ──
    $docInfo = New-Object DOC_INFO_1
    $docInfo.pDocName = '${escapedDoc}'
    $docInfo.pOutputFile = $null
    $docInfo.pDatatype = 'RAW'

    if (-not [Winspool]::StartDocPrinterW($handle, 1, [ref]$docInfo)) {
        $err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
        throw "StartDocPrinterW failed (error code: $err)"
    }

    try {
        # ── Write raw data to the printer ──
        $written = 0
        if (-not [Winspool]::WritePrinter($handle, $bytes, $bytes.Length, [ref]$written)) {
            $err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
            throw "WritePrinter failed (error code: $err)"
        }

        if ($written -ne $bytes.Length) {
            throw "WritePrinter: only $written of $($bytes.Length) bytes written"
        }

        # ── End the print job ──
        if (-not [Winspool]::EndDocPrinter($handle)) {
            $err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
            throw "EndDocPrinter failed (error code: $err)"
        }

        Write-Output "OK"
    }
    catch {
        [Winspool]::EndDocPrinter($handle) | Out-Null
        throw
    }
}
finally {
    [Winspool]::ClosePrinter($handle) | Out-Null
}
`.trim();
}

class PrinterService extends EventEmitter {
  constructor() {
    super();

    this.fontPreloader = null;
    this.knownPrinters = new Map(); // printerName → { name, driverName, portName, ... }
    this.pollTimer = null;
    this.polling = false;

    // Bind methods
    this._pollPrinters = this._pollPrinters.bind(this);
  }

  /**
   * Set the font preloader instance
   * @param {FontPreloader} fontPreloader
   */
  setFontPreloader(fontPreloader) {
    this.fontPreloader = fontPreloader;
  }

  /**
   * Initialize periodic polling for printer change detection.
   * Replaces the USB hot-plug watcher used in the old libusb-based implementation.
   */
  initUSBWatcher() {
    if (this.pollTimer) return;

    log.info('[PrinterService] Starting printer polling (interval: %dms)', POLL_INTERVAL);
    // Do an initial scan
    this._pollPrinters();
    // Set up periodic polling
    this.pollTimer = setInterval(this._pollPrinters, POLL_INTERVAL);
  }

  /**
   * List available printers installed in Windows.
   * @returns {Promise<Array<{id: string, name: string, manufacturer: string, product: string, serialNumber: string, port: string, driverName: string}>>}
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
          manufacturer: '',                 // Not directly available from Get-Printer
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
   * Send ZPL data to the printer (with automatic font preload check).
   * Uses the Windows Spooler API to send raw data through the printer driver.
   *
   * @param {string} printerId - Windows printer name
   * @param {string} zplData - Complete ZPL string
   * @returns {Promise<{success: boolean}>}
   */
  async printZPL(printerId, zplData) {
    // Auto-preload font if not loaded
    if (this.fontPreloader && !this.fontPreloader.isFontLoaded(printerId)) {
      log.info(`[PrinterService] Font not loaded for "${printerId}", preloading...`);
      try {
        await this.fontPreloader.preloadFont(printerId);
      } catch (fontErr) {
        log.warn(`[PrinterService] Font preload failed for "${printerId}": ${fontErr.message}, continuing with print...`);
      }
    }

    // Send the raw ZPL data with timeout
    const timeoutMs = PRINT_TIMEOUT;
    await Promise.race([
      this.sendRaw(printerId, zplData),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`打印超时 (${timeoutMs / 1000}秒)`)), timeoutMs)
      ),
    ]);
    return { success: true };
  }

  /**
   * Send raw data to the printer via Windows Spooler API.
   * The data is sent in RAW mode — no processing by the printer driver.
   *
   * @param {string} printerId - Windows printer name
   * @param {string} data - Data string to send (ZPL commands)
   * @returns {Promise<void>}
   */
  async sendRaw(printerId, data) {
    if (!printerId) {
      throw new Error('Printer name is required');
    }

    // Convert ZPL string to UTF-8 Buffer, then Base64 for PowerShell
    const buffer = Buffer.from(data, 'utf-8');
    const base64Data = buffer.toString('base64');

    log.info(
      `[PrinterService] Sending raw data to "${printerId}" (${buffer.length} bytes, ${data.length} chars)`
    );

    // Build the PowerShell script with embedded data
    const docName = `ZPL Label ${new Date().toISOString().replace(/[:.]/g, '-')}`;
    const script = buildRawPrintScript(printerId, base64Data, docName);

    // Execute the PowerShell script
    const result = await this._runPowerShell(script, PRINT_TIMEOUT);

    if (result && result.trim() === 'OK') {
      log.info(`[PrinterService] ZPL data sent successfully to "${printerId}" (${buffer.length} bytes)`);
    } else {
      log.warn(`[PrinterService] Print completed with unexpected output: ${result}`);
    }
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
   * Run a PowerShell script and return stdout.
   *
   * @param {string} script - PowerShell script to execute
   * @param {number} timeout - Timeout in milliseconds
   * @returns {Promise<string>} stdout output
   * @private
   */
  _runPowerShell(script, timeout = 10000) {
    return new Promise((resolve, reject) => {
      const args = [...POWERSHELL_ARGS, '-Command', script];

      const child = execFile(POWERSHELL, args, {
        timeout,
        maxBuffer: 1024 * 1024,  // 1MB buffer
        windowsHide: true,
        encoding: 'utf-8',
      }, (error, stdout, stderr) => {
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
