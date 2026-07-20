/**
 * TSCLIB.dll Wrapper — PowerShell P/Invoke bridge for TSC label printing
 *
 * Uses PowerShell's Add-Type with [DllImport] to call TSCLIB.dll functions.
 * This approach is stable and reliable — same mechanism as the old raw TSPL printing,
 * but calling individual DLL functions instead of sending raw TSPL strings.
 *
 * Text rendering uses Windows system fonts (SimSun/宋体) via WindowsFontUnicode(),
 * eliminating the dependency on printer flash-stored fonts.
 * Bold text is supported via the bold parameter.
 *
 * DLL function signatures verified from .lib symbol table and objdump exports.
 */

const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const log = require('electron-log');

const POWERSHELL = 'powershell.exe';
const POWERSHELL_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];
const TEMP_DIR = os.tmpdir();
const PRINT_TIMEOUT = 15000;

// ─── DLL Path Resolution ──────────────────────────────────────────

function getDllPath() {
  let base;
  try {
    const { app } = require('electron');
    if (app.isPackaged) {
      base = path.join(process.resourcesPath, 'tsclib', 'x64');
    } else {
      base = path.join(__dirname, '..', 'tsclib', 'x64');
    }
  } catch {
    base = path.join(__dirname, '..', 'tsclib', 'x64');
  }
  return path.join(base, 'TSCLIB.dll');
}

// ─── PowerShell Helpers ───────────────────────────────────────────

/**
 * Escape a string for PowerShell single-quoted string.
 * In PS single-quoted strings, only ' needs escaping (doubled to '').
 */
function psEscape(str) {
  return (str || '').replace(/'/g, "''");
}

/**
 * Run a PowerShell script via temp file.
 * @param {string} script - PowerShell script content
 * @param {number} timeout - Timeout in ms
 * @returns {Promise<string>} stdout
 */
function runPowerShell(script, timeout = PRINT_TIMEOUT) {
  return new Promise((resolve, reject) => {
    const scriptFile = path.join(
      TEMP_DIR,
      `optibot-tsc-${process.pid}-${Date.now()}.ps1`
    );

    // UTF-8 BOM for correct PowerShell encoding
    const BOM = '';
    fs.writeFileSync(scriptFile, BOM + script, 'utf-8');

    const args = [...POWERSHELL_ARGS, '-File', scriptFile];

    const child = execFile(POWERSHELL, args, {
      timeout,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
      encoding: 'utf-8',
    }, (error, stdout, stderr) => {
      try { fs.unlinkSync(scriptFile); } catch (e) { /* ignore */ }

      if (error) {
        if (error.killed) {
          reject(new Error(`TSCLIB 打印超时 (${timeout / 1000}秒)`));
        } else {
          const errMsg = stderr ? stderr.trim() : error.message;
          reject(new Error(`TSCLIB 执行失败: ${errMsg}`));
        }
        return;
      }

      if (stderr && stderr.trim()) {
        log.warn('[TSCLIB] PowerShell stderr:', stderr.trim());
      }

      resolve(stdout ? stdout.trim() : '');
    });
  });
}

// ─── TSCLibWrapper Class ──────────────────────────────────────────

class TSCLibWrapper {
  constructor() {
    this._dllPath = getDllPath();
    this._printing = false;
  }

  /**
   * Verify DLL exists and is loadable.
   * Called during init to catch problems early.
   */
  load() {
    if (!fs.existsSync(this._dllPath)) {
      throw new Error(`TSCLIB.dll 不存在: ${this._dllPath}`);
    }
    log.info(`[TSCLIB] DLL found at: ${this._dllPath}`);
  }

  /**
   * Print a label using TSCLIB.dll via PowerShell P/Invoke.
   *
   * @param {string} printerName - Windows printer name
   * @param {Object} config - Label configuration
   * @returns {Promise<{success: boolean}>}
   */
  async printLabel(printerName, config) {
    if (this._printing) {
      throw new Error('打印机忙，请稍后再试');
    }

    this._printing = true;

    try {
      const { width, height, dpi = 203, copies = 1, elements } = config;
      const dotsPerMM = dpi / 25.4;

      log.info(`[TSCLIB] Building script: ${width}×${height}mm, ${elements.length} elements, ${copies} copies`);

      // Build the complete PowerShell script
      const script = this._buildScript(printerName, width, height, copies, elements, dotsPerMM);

      // Save script for debugging
      const appDir = path.dirname(process.execPath);
      const debugFile = path.join(appDir, 'debug-last-tsclib.ps1');
      try {
        fs.writeFileSync(debugFile, script, 'utf-8');
        log.info(`[TSCLIB] Script saved to: ${debugFile}`);
      } catch (e) { /* ignore */ }

      // Execute
      log.info(`[TSCLIB] Executing PowerShell script (${script.length} chars)`);
      const result = await runPowerShell(script, PRINT_TIMEOUT);

      if (result === 'OK') {
        log.info('[TSCLIB] Print job sent successfully');
        return { success: true };
      } else {
        log.warn(`[TSCLIB] Unexpected output: ${result}`);
        return { success: true };
      }
    } finally {
      this._printing = false;
    }
  }

  /**
   * Build the complete PowerShell script for a label.
   * @private
   */
  _buildScript(printerName, width, height, copies, elements, dotsPerMM) {
    // Normalize DLL path: use forward slashes to avoid C# backslash escape issues
    const dllPath = this._dllPath.replace(/\\/g, '/');

    let s = `$ErrorActionPreference = 'Stop'\n`;
    s += `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n\n`;

    // ── Define P/Invoke wrappers ──
    // TSCLibA: ANSI string marshaling (most functions)
    // TSCLibU: Unicode string marshaling (windowsfontUnicode only)
    s += `Add-Type -TypeDefinition @"\n`;
    s += `using System;\n`;
    s += `using System.Runtime.InteropServices;\n\n`;

    // ANSI class — for all functions except WindowsFontUnicode
    s += `public static class TSCLibA {\n`;
    s += `    [DllImport("${dllPath}", CharSet = CharSet.Ansi, CallingConvention = CallingConvention.Cdecl)]\n`;
    s += `    public static extern int openport(string portName);\n\n`;
    s += `    [DllImport("${dllPath}", CallingConvention = CallingConvention.Cdecl)]\n`;
    s += `    public static extern int closeport();\n\n`;
    s += `    [DllImport("${dllPath}", CharSet = CharSet.Ansi, CallingConvention = CallingConvention.Cdecl)]\n`;
    s += `    public static extern int setup(string w, string h, string speed, string density, string sensor, string vertical, string gap);\n\n`;
    s += `    [DllImport("${dllPath}", CallingConvention = CallingConvention.Cdecl)]\n`;
    s += `    public static extern int clearbuffer();\n\n`;
    s += `    [DllImport("${dllPath}", CharSet = CharSet.Ansi, CallingConvention = CallingConvention.Cdecl)]\n`;
    s += `    public static extern int printlabel(string setName, string copies);\n\n`;
    s += `    [DllImport("${dllPath}", CharSet = CharSet.Ansi, CallingConvention = CallingConvention.Cdecl)]\n`;
    s += `    public static extern int windowsfont(int x, int y, int fontH, int fontW, int bold, int italic, int underline, string fontName, string text);\n\n`;
    s += `    [DllImport("${dllPath}", CharSet = CharSet.Ansi, CallingConvention = CallingConvention.Cdecl)]\n`;
    s += `    public static extern int barcode(string x, string y, string type, string height, string hr, string align, string rot, string narrow, string data);\n\n`;
    s += `    [DllImport("${dllPath}", CharSet = CharSet.Ansi, CallingConvention = CallingConvention.Cdecl)]\n`;
    s += `    public static extern int qrcode(string x, string y, string ec, string cell, string mode, string rot, string data, string extra);\n\n`;
    s += `    [DllImport("${dllPath}", CharSet = CharSet.Ansi, CallingConvention = CallingConvention.Cdecl)]\n`;
    s += `    public static extern int sendcommand(string cmd);\n\n`;
    s += `    [DllImport("${dllPath}", CharSet = CharSet.Ansi, CallingConvention = CallingConvention.Cdecl)]\n`;
    s += `    public static extern int sendcommandutf8(string cmd);\n\n`;
    s += `    [DllImport("${dllPath}", CallingConvention = CallingConvention.Cdecl)]\n`;
    s += `    public static extern int formfeed();\n`;
    s += `}\n\n`;

    // Unicode class — for windowsfontUnicode (wchar_t* text)
    s += `public static class TSCLibU {\n`;
    s += `    [DllImport("${dllPath}", CharSet = CharSet.Unicode, CallingConvention = CallingConvention.Cdecl)]\n`;
    s += `    public static extern int windowsfontUnicode(int x, int y, int fontH, int fontW, int bold, int italic, int underline, string fontName, string text);\n`;
    s += `}\n`;
    s += `"@\n\n`;

    // ── Open port ──
    s += `$printerName = '${psEscape(printerName)}'\n`;
    s += `$r = [TSCLibA]::openport($printerName)\n`;
    s += `if ($r -ne 1) { throw "openport failed for '$printerName' (returned $r)" }\n\n`;

    s += `try {\n`;

    // ── Setup ──
    s += `    [TSCLibA]::setup('${width}', '${height}', '4', '8', '0', '0', '2,0') | Out-Null\n`;
    s += `    [TSCLibA]::clearbuffer() | Out-Null\n\n`;

    // ── Render elements ──
    for (let i = 0; i < elements.length; i++) {
      const el = elements[i];
      const x = Math.round((el.x || 0) * dotsPerMM);
      const y = Math.round((el.y || 0) * dotsPerMM);

      s += `    # Element ${i}: ${el.type}\n`;
      s += this._renderElement(el, x, y, dotsPerMM);
    }

    // ── Print ──
    s += `\n    [TSCLibA]::printlabel('1', '${copies}') | Out-Null\n`;
    s += `    Write-Output 'OK'\n`;
    s += `}\n`;
    s += `finally {\n`;
    s += `    [TSCLibA]::closeport() | Out-Null\n`;
    s += `}\n`;

    return s;
  }

  // ─── Element Renderers ──────────────────────────────────────────

  _renderElement(el, x, y, dotsPerMM) {
    switch (el.type) {
      case 'text':
      case 'date':
        return this._renderText(el, x, y);
      case 'barcode':
        return this._renderBarcode(el, x, y);
      case 'qrcode':
        return this._renderQRCode(el, x, y);
      case 'line':
        return this._renderLine(el, x, y, dotsPerMM);
      case 'table':
        return this._renderTable(el, x, y, dotsPerMM);
      default:
        log.warn(`[TSCLIB] Unknown element type: ${el.type}`);
        return '';
    }
  }

  _renderText(el, x, y) {
    const content = el.content || '';
    if (!content) return '';

    const fontH = Math.max(8, el.font_size || el.fontSize || 24);
    const fontW = el.font_width || el.fontWidth || fontH;
    const bold = el.bold ? 1 : 0;
    const fontName = el.font_name || 'SimSun';

    return `    [TSCLibU]::windowsfontUnicode(${x}, ${y}, ${fontH}, ${fontW}, ${bold}, 0, 0, '${psEscape(fontName)}', '${psEscape(content)}') | Out-Null\n`;
  }

  _renderBarcode(el, x, y) {
    if (el.barcodeType === 'QR') {
      return this._renderQRCode(el, x, y);
    }
    const h = el.height || 60;
    const content = el.content || '';
    return `    [TSCLibA]::barcode('${x}', '${y}', '128', '${h}', '1', '0', '2', '2', '${psEscape(content)}') | Out-Null\n`;
  }

  _renderQRCode(el, x, y) {
    const cellSize = el.size || 6;
    let content = el.content || '';
    if (el.gs1) content = '>8' + content;
    return `    [TSCLibA]::qrcode('${x}', '${y}', 'L', '${cellSize}', 'A', '0', '${psEscape(content)}', '') | Out-Null\n`;
  }

  _renderLine(el, x, y, dotsPerMM) {
    const lineW = Math.round((el.width || 50) * dotsPerMM);
    const thickness = el.thickness || 2;
    return `    [TSCLibA]::sendcommand('BAR ${x},${y},${lineW},${thickness}') | Out-Null\n`;
  }

  /**
   * Render table — same layout logic as old _tsplTable, but calling DLL via P/Invoke.
   */
  _renderTable(el, tableX, tableY, dotsPerMM) {
    let s = '';
    const columns = el.columns || [];
    const cellOverrides = el.cell_overrides || {};
    const maxRows = el.max_rows || 6;
    const rowHeightMM = el.row_height || 6;
    const rowHeightDots = Math.round(rowHeightMM * dotsPerMM);
    const border = el.border !== false;
    const borderThickness = el.border_thickness || 2;
    const defaultCellFontSize = el.cell_font_size || 16;
    const headerFontSize = el.header_font_size || 20;
    const showHeader = el.show_header !== false;
    const fontName = el.font_name || 'SimSun';

    const colWidthsDots = columns.map((col) => Math.round((col.width || 20) * dotsPerMM));
    const totalTableWidthDots = colWidthsDots.reduce((a, w) => a + w, 0);
    const totalTableHeightDots = rowHeightDots * maxRows;

    // Cell visibility & colspan
    const isCellHidden = {};
    const cellSpan = {};
    for (const [key, override] of Object.entries(cellOverrides)) {
      if (override && override.hidden) isCellHidden[key] = true;
      if (override && override.colspan > 1) cellSpan[key] = override.colspan;
    }
    function cellHidden(r, c) { return isCellHidden[`${r},${c}`] === true; }
    function getColspan(r, c) { return cellSpan[`${r},${c}`] || 1; }
    function skipVerticalLine(r, c) {
      for (let lc = c - 1; lc >= 0; lc--) {
        if (lc + getColspan(r, lc) > c) return true;
      }
      for (let rc = c; rc < columns.length; rc++) {
        const span = getColspan(r, rc);
        if (span > 1 && rc < c) return true;
      }
      return cellHidden(r, c - 1) && cellHidden(r, c);
    }

    // Border grid
    if (border) {
      const xEnd = tableX + totalTableWidthDots - 1;
      const yEnd = tableY + totalTableHeightDots - 1;
      s += `    [TSCLibA]::sendcommand('BOX ${tableX},${tableY},${xEnd},${yEnd},${borderThickness}') | Out-Null\n`;

      for (let r = 1; r < maxRows; r++) {
        const ly = tableY + r * rowHeightDots;
        let belowHasHidden = false;
        for (let c = 0; c < columns.length; c++) {
          if (cellHidden(r, c)) { belowHasHidden = true; break; }
        }
        if (belowHasHidden) {
          s += `    [TSCLibA]::sendcommand('BAR ${tableX},${ly},${totalTableWidthDots},${borderThickness}') | Out-Null\n`;
        } else {
          let lx = tableX;
          for (let c = 0; c < columns.length; c++) {
            s += `    [TSCLibA]::sendcommand('BAR ${lx},${ly},${colWidthsDots[c]},${borderThickness}') | Out-Null\n`;
            lx += colWidthsDots[c];
          }
        }
      }

      let cx = tableX;
      for (let c = 1; c < columns.length; c++) {
        cx += colWidthsDots[c - 1];
        for (let r = 0; r < maxRows; r++) {
          if (!skipVerticalLine(r, c)) {
            const vy = tableY + r * rowHeightDots;
            s += `    [TSCLibA]::sendcommand('BAR ${cx},${vy},${borderThickness},${rowHeightDots}') | Out-Null\n`;
          }
        }
      }
    }

    // Text width estimation
    function estimateTextWidth(text, fontSize) {
      const charW = Math.max(8, fontSize);
      let w = 0;
      for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        w += (code <= 0x7F ? 1 : code <= 0x7FF ? 2 : 3) * charW;
      }
      return w;
    }

    // Header row
    if (showHeader) {
      let hx = tableX;
      const hFontSize = Math.max(8, headerFontSize);
      for (let c = 0; c < columns.length; c++) {
        const header = columns[c].header || '';
        if (header) {
          const cellW = colWidthsDots[c];
          const textW = estimateTextWidth(header, headerFontSize);
          const offsetX = Math.max(2, Math.round((cellW - textW) / 2));
          s += `    [TSCLibU]::windowsfontUnicode(${hx + offsetX}, ${tableY + 2}, ${hFontSize}, ${hFontSize}, 1, 0, 0, '${psEscape(fontName)}', '${psEscape(header)}') | Out-Null\n`;
        }
        hx += colWidthsDots[c];
      }
    }

    // Cell content
    for (let r = 0; r < maxRows; r++) {
      const cellY = tableY + r * rowHeightDots;
      let cellX = tableX;
      for (let c = 0; c < columns.length; c++) {
        const key = `${r},${c}`;
        const override = cellOverrides[key];

        if (override && override.hidden) {
          cellX += colWidthsDots[c];
          continue;
        }

        const rawContent = override ? override.content || '' : '';
        if (rawContent) {
          const fontSize = (override && override.font_size) || defaultCellFontSize;
          const align = columns[c].align || 'left';
          let cellW = colWidthsDots[c];
          const colspan = (override && override.colspan) || 1;
          if (colspan > 1) {
            cellW = 0;
            for (let ci = c; ci < Math.min(c + colspan, columns.length); ci++) {
              cellW += colWidthsDots[ci];
            }
          }

          const cFontSize = Math.max(8, fontSize);
          const textW = estimateTextWidth(rawContent, fontSize);
          const ascentShift = Math.round(cFontSize * 0.25);
          const textOffsetY = Math.max(1, Math.round((rowHeightDots - cFontSize) / 2) - ascentShift);

          let offsetX;
          if (textW >= cellW) {
            offsetX = Math.max(0, Math.round((cellW - textW) / 2));
          } else if (align === 'center') {
            offsetX = Math.max(2, Math.round((cellW - textW) / 2));
          } else if (align === 'right') {
            offsetX = Math.max(2, cellW - textW - 4);
          } else {
            offsetX = 2;
          }

          s += `    [TSCLibU]::windowsfontUnicode(${cellX + offsetX}, ${cellY + textOffsetY}, ${cFontSize}, ${cFontSize}, 0, 0, 0, '${psEscape(fontName)}', '${psEscape(rawContent)}') | Out-Null\n`;
        }
        cellX += colWidthsDots[c];
      }
    }

    return s;
  }

  close() {
    // No persistent state to clean up — each print spawns a new PowerShell process
  }
}

module.exports = TSCLibWrapper;
