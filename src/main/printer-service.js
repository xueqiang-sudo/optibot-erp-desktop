/**
 * Label Printer Service - Windows Spooler API Raw Printing (TSPL)
 *
 * Generates TSPL command strings from JSON label configurations and sends
 * them to TSC label printers through the Windows print driver using the
 * Spooler API in RAW mode.
 *
 * Architecture:
 * 1. JSON label config → generateTSPL() → complete TSPL command string
 * 2. TSPL string → sendRaw() → Windows Spooler API (winspool.drv) → printer
 *
 * No DLL dependency. Pure JavaScript TSPL generation + PowerShell RAW print.
 *
 * TSPL is TSC's native printer language, so the TSC Windows driver
 * passes TSPL data directly to the printer without modification.
 *
 * Chinese text uses fonts stored on the printer's flash drive (e.g., "SourceHa.TTF", "SimsunEx").
 * The font is referenced directly by name in TEXT commands — no separate
 * font mapping step is needed.
 *
 * Encoding:
 * - PowerShell scripts are written to UTF-8 BOM temp files and executed with -File
 * - TSPL data is base64-encoded to safely embed in the PowerShell script
 */

const { EventEmitter } = require('events');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const log = require('electron-log');
const { generateTSPL } = require('./tspl-converter');

// PowerShell path (available on all modern Windows systems)
const POWERSHELL = 'powershell.exe';
const POWERSHELL_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];

// Polling disabled — printers are scanned on demand when user opens print settings

// Timeout for PowerShell commands (ms)
const LIST_TIMEOUT = 10000;
const PRINT_TIMEOUT = 15000;

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

/**
 * Build a PowerShell script that sends raw data to a printer
 * via the Windows Spooler API (P/Invoke).
 *
 * The script:
 * 1. Defines P/Invoke signatures for winspool.drv functions
 * 2. Decodes base64-encoded raw data
 * 3. Opens the printer, starts a RAW doc, writes data, ends doc, close printer
 *
 * @param {string} printerName - Windows printer name
 * @param {string} base64Data - Base64-encoded UTF-8 TSPL data
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

    this.knownPrinters = new Map(); // printerName → { name, driverName, portName, ... }
  }

  /**
   * Initialize printer service.
   * Polling removed — printers are scanned on demand via listPrinters()
   * when user opens the print settings page.
   */
  initUSBWatcher() {
    log.info('[PrinterService] Initialized (on-demand scan mode, no polling)');
    // No polling — listPrinters() is called explicitly by the renderer when needed
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
   * Print a label by generating TSPL commands in pure JavaScript and sending
   * them to the printer via the Windows Spooler API in RAW mode.
   *
   * Replaces the former TSCLIB.dll FFI path with:
   * 1. generateTSPL(config) → complete TSPL command string
   * 2. sendRaw(printerName, tsplString) → Spooler API RAW write
   *
   * @param {string} printerId - Windows printer name
   * @param {Object} labelConfig - Structured label configuration
   * @returns {Promise<{success: boolean}>}
   */
  async printLabel(printerId, labelConfig) {
    const printer = this.knownPrinters.get(printerId);
    const printerName = printer ? printer.name : printerId;
    log.info(`[PrinterService] Printing label to "${printerName}" (TSPL via Spooler RAW)`);

    const elCount = labelConfig.elements ? labelConfig.elements.length : 0;
    log.info(`[PrinterService] Label: ${labelConfig.width}×${labelConfig.height}mm, ${elCount} elements, ${labelConfig.copies || 1} copies`);

    // Step 1: Generate TSPL command Buffer from JSON config (includes binary QR data)
    const tsplData = generateTSPL(labelConfig);

    // Step 1.5: Dump TSPL debug text file for troubleshooting
    this._dumpTSPLDebug(tsplData, printerName);

    // Step 2: Send raw TSPL to printer via Windows Spooler API
    const timeoutMs = PRINT_TIMEOUT;
    await Promise.race([
      this.sendRaw(printerName, tsplData),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`打印超时 (${timeoutMs / 1000}秒)`)), timeoutMs)
      ),
    ]);

    log.info('[PrinterService] Label print completed');
    return { success: true };
  }

  /**
   * Send TSPL data to the printer via Windows Spooler API (RAW mode).
   * Convenience wrapper around sendRaw() with timeout.
   *
   * @param {string} printerId - Windows printer name
   * @param {string} tsplData - Complete TSPL command string
   * @returns {Promise<{success: boolean}>}
   */
  async printTSPL(printerId, tsplData) {
    log.info(`[PrinterService] Printing TSPL to "${printerId}" (${tsplData.length} chars)`);

    const timeoutMs = PRINT_TIMEOUT;
    await Promise.race([
      this.sendRaw(printerId, tsplData),
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
   * Uses a temp file approach to avoid command-line encoding issues:
   * 1. Write PowerShell script to a UTF-8 BOM temp file
   * 2. Execute with powershell.exe -File (more reliable than -Command for complex scripts)
   * 3. Clean up temp file after execution
   *
   * @param {string} printerId - Windows printer name
   * @param {string|Buffer} data - TSPL command data (Buffer from generateTSPL, supports binary QR)
   * @returns {Promise<void>}
   */
  async sendRaw(printerId, data) {
    if (!printerId) {
      throw new Error('Printer name is required');
    }

    // generateTSPL returns Buffer (supports binary QR data with 0x80 bytes).
    // If data is already a Buffer, use directly; otherwise convert string to UTF-8.
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf-8');
    const base64Data = buffer.toString('base64');

    log.info(
      `[PrinterService] Sending raw data to "${printerId}" (${buffer.length} bytes)`
    );

    // Build the PowerShell script with embedded base64 data
    const docName = `TSPL Label ${new Date().toISOString().replace(/[:.]/g, '-')}`;
    const script = buildRawPrintScript(printerId, base64Data, docName);

    // Execute the PowerShell script (using temp file for reliable encoding)
    const result = await this._runPowerShell(script, PRINT_TIMEOUT);

    if (result && result.trim() === 'OK') {
      log.info(`[PrinterService] TSPL data sent successfully to "${printerId}" (${buffer.length} bytes)`);
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
    this.knownPrinters.clear();
    this.removeAllListeners();
  }

  // ─── Private Methods ─────────────────────────────────────────

  /**
   * Dump TSPL command data to a debug text file for troubleshooting.
   * Writes to tspl-debug.txt in the app directory with hex dump for binary data.
   *
   * @param {Buffer} tsplData - TSPL command buffer from generateTSPL()
   * @param {string} printerName - Target printer name
   * @private
   */
  _dumpTSPLDebug(tsplData, printerName) {
    try {
      // Split buffer into lines by CRLF
      const lines = [];
      let start = 0;
      for (let i = 0; i < tsplData.length - 1; i++) {
        if (tsplData[i] === 0x0d && tsplData[i + 1] === 0x0a) {
          lines.push(tsplData.slice(start, i));
          start = i + 2;
        }
      }
      if (start < tsplData.length) lines.push(tsplData.slice(start));

      let txt = `=== TSPL Debug Output ===\r\n`;
      txt += `Time: ${new Date().toISOString()}\r\n`;
      txt += `Printer: ${printerName}\r\n`;
      txt += `Total bytes: ${tsplData.length}\r\n`;
      txt += `Commands: ${lines.length}\r\n\r\n`;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Check if line contains binary data (0x1E or 0x80)
        let hasBinary = false;
        for (const b of line) {
          if (b === 0x1e || b === 0x80) { hasBinary = true; break; }
        }

        if (hasBinary) {
          const firstQuote = line.indexOf(0x22);
          const lastQuote = line.lastIndexOf(0x22);

          if (firstQuote >= 0 && lastQuote > firstQuote) {
            const prefix = line.slice(0, firstQuote + 1).toString('utf-8');
            const data = line.slice(firstQuote + 1, lastQuote);

            txt += `--- Command ${i + 1} (binary) ---\r\n`;
            txt += `${prefix}<binary_data>"\r\n\r\n`;
            txt += `Binary data (${data.length} bytes):\r\n`;

            // Hex dump: 16 bytes per line
            for (let j = 0; j < data.length; j += 16) {
              const chunk = data.slice(j, j + 16);
              const hex = [];
              const asc = [];
              for (let k = 0; k < chunk.length; k++) {
                hex.push(chunk[k].toString(16).padStart(2, '0').toUpperCase());
                asc.push(chunk[k] >= 0x20 && chunk[k] <= 0x7e ? String.fromCharCode(chunk[k]) : '.');
              }
              const offset = j.toString(16).padStart(4, '0').toUpperCase();
              txt += `  ${offset}: ${hex.join(' ').padEnd(48)}  ${asc.join('')}\r\n`;
            }

            // Decode 0x80-separated fields
            if (data[0] === 0x80) {
              const fields = [];
              let current = [];
              for (let j = 1; j < data.length; j++) {
                if (data[j] === 0x80) {
                  fields.push(Buffer.from(current).toString('utf-8'));
                  current = [];
                } else {
                  current.push(data[j]);
                }
              }
              fields.push(Buffer.from(current).toString('utf-8'));

              txt += `\r\nQR fields (${fields.length}):\r\n`;
              for (let j = 0; j < fields.length; j++) {
                txt += `  [${j}] "${fields[j]}"\r\n`;
              }
            }
          }
        } else {
          txt += `Line ${i + 1}: ${line.toString('utf-8')}\r\n`;
        }
      }

      txt += `\r\n=== End ===\r\n`;

      // Write debug file to app directory
      const debugPath = path.join(__dirname, '..', '..', 'tspl-debug.txt');
      fs.writeFileSync(debugPath, txt, 'utf-8');
      log.info(`[PrinterService] TSPL debug file: ${debugPath}`);

      // Also save raw .prn file
      const prnPath = path.join(__dirname, '..', '..', 'tspl-debug.prn');
      fs.writeFileSync(prnPath, tsplData);
    } catch (err) {
      log.warn(`[PrinterService] Failed to dump TSPL debug file: ${err.message}`);
    }
  }

  // ★ Polling removed — printers are scanned on demand via listPrinters()

  /**
   * Run a PowerShell script using a temp file for reliable encoding.
   *
   * Why temp file + -File instead of -Command:
   * - The -Command parameter passes the script through the Windows command line,
   *   which can mangle Unicode/Chinese characters in certain environments.
   * - Writing to a UTF-8 BOM file and using -File guarantees correct encoding
   *   regardless of the system's code page or console encoding.
   *
   * @param {string} script - PowerShell script to execute
   * @param {number} timeout - Timeout in milliseconds
   * @returns {Promise<string>} stdout output
   * @private
   */
  _runPowerShell(script, timeout = 10000) {
    return new Promise((resolve, reject) => {
      // Write script to temp file with UTF-8 BOM encoding
      const scriptFile = path.join(
        TEMP_DIR,
        `optibot-ps-${process.pid}-${Date.now()}.ps1`
      );

      // UTF-8 BOM ensures PowerShell reads the file correctly
      const BOM = '﻿';
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
