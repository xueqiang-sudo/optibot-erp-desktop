/**
 * TSCLIB.dll Wrapper — FFI bindings for TSC label printing via Windows driver
 *
 * Uses koffi to load TSCLIB.dll (x64) and call its exported functions.
 * Text rendering uses Windows system fonts (SimSun/宋体) via windowsfontUnicode(),
 * eliminating the dependency on printer flash-stored fonts (SimsunEx.TTF).
 *
 * Bold text is supported via the bold parameter of windowsfontUnicode().
 *
 * DLL export names verified via objdump - all are plain C names (no C++ mangling).
 */

const koffi = require('koffi');
const path = require('path');
const log = require('electron-log');

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

// ─── Safe bind helper ─────────────────────────────────────────────

/**
 * Try to bind a DLL function. Returns null on failure.
 * Tries plain name first, then ordinal fallback.
 *
 * @param {object} lib - koffi library handle
 * @param {string} name - Plain export name
 * @param {string} retType - Return type (e.g. 'int')
 * @param {string[]} paramTypes - Parameter types (e.g. ['str', 'int'])
 * @param {number|null} ordinal - Export ordinal as fallback
 * @returns {Function|null}
 */
function bindFunc(lib, name, retType, paramTypes, ordinal) {
  // Try plain name first
  try {
    const fn = lib.func(name, retType, paramTypes);
    log.info(`[TSCLIB] Bound: ${name}(${paramTypes.join(', ')}) → ${retType}`);
    return fn;
  } catch (err) {
    log.warn(`[TSCLIB] Plain name "${name}" failed: ${err.message}`);
  }

  // Try ordinal fallback
  if (ordinal != null) {
    try {
      const fn = lib.func(ordinal, retType, paramTypes);
      log.info(`[TSCLIB] Bound ordinal ${ordinal} as ${name}(${paramTypes.join(', ')}) → ${retType}`);
      return fn;
    } catch (err2) {
      log.warn(`[TSCLIB] Ordinal ${ordinal} also failed: ${err2.message}`);
    }
  }

  log.error(`[TSCLIB] ✗ Failed to bind: ${name}`);
  return null;
}

// ─── TSCLibWrapper Class ──────────────────────────────────────────

class TSCLibWrapper {
  constructor() {
    this._lib = null;
    this._portOpen = false;
    this._printing = false;
    this._loaded = false;

    // Function references
    this._fn = {};
  }

  /**
   * Load TSCLIB.dll and bind all function signatures.
   * @throws {Error} if DLL cannot be loaded
   */
  load() {
    if (this._loaded) return;

    const dllPath = getDllPath();
    log.info(`[TSCLIB] Loading DLL: ${dllPath}`);

    const fs = require('fs');
    if (!fs.existsSync(dllPath)) {
      throw new Error(`TSCLIB.dll 不存在: ${dllPath}`);
    }

    try {
      this._lib = koffi.load(dllPath);
      log.info('[TSCLIB] DLL loaded successfully');
    } catch (err) {
      log.error(`[TSCLIB] Failed to load DLL: ${err.message}`);
      throw new Error(`TSCLIB.dll 加载失败: ${err.message}\n路径: ${dllPath}`);
    }

    // ── Bind functions using plain export names (verified via objdump) ──
    // All signatures decoded from .lib C++ mangled names
    //
    // Key: setup() takes 7 char* params (not 8 ints!)
    //      barcode() takes 9 char* params
    //      qrcode() takes 8 char* params
    //      windowsfontUnicode() takes 7 ints + char* fontName + wchar_t* text

    // Bindings: [name, returnType, paramTypes[], ordinal]
    // All signatures decoded from .lib C++ mangled names, plain names verified via objdump
    const bindings = [
      // Port management
      ['openport',    'int', ['str'],                                         92],
      ['closeport',   'int', [],                                               33],

      // Label setup — 7 string params (confirmed from mangled name ?setup@@YAHPEAD000000@Z)
      ['setup',       'int', ['str','str','str','str','str','str','str'],     127],

      // Buffer & print
      ['clearbuffer', 'int', [],                                               29],
      ['printlabel',  'int', ['str','str'],                                   104],

      // Text — windowsfont: 7 ints + char* fontName + char* text (ASCII only)
      ['windowsfont', 'int', ['int','int','int','int','int','int','int','str','str'], 155],

      // Text — windowsfontUnicode: 7 ints + char* fontName + wchar_t* text (UTF-16, for Chinese)
      ['windowsfontUnicode', 'int', ['int','int','int','int','int','int','int','str','str16'], 162],

      // Barcode — 9 string params (confirmed from ?barcode@@YAHPEAD000000000@Z)
      ['barcode',     'int', ['str','str','str','str','str','str','str','str','str'], 24],

      // QR code — 8 string params (confirmed from ?qrcode@@YAHPEAD00000000@Z)
      ['qrcode',      'int', ['str','str','str','str','str','str','str','str'], 107],

      // Raw TSPL passthrough
      ['sendcommand',    'int', ['str'],                                      115],
      ['sendcommandutf8','int', ['str'],                                      123],

      // Utility
      ['formfeed',    'int', [],                                               81],
      ['nobackfeed',  'int', [],                                               85],
    ];

    let boundCount = 0;
    let failCount = 0;

    for (const [name, retType, paramTypes, ordinal] of bindings) {
      const fn = bindFunc(this._lib, name, retType, paramTypes, ordinal);
      if (fn) {
        this._fn[name] = fn;
        boundCount++;
      } else {
        failCount++;
      }
    }

    log.info(`[TSCLIB] Function binding complete: ${boundCount} bound, ${failCount} failed`);

    if (failCount > 0 && !this._fn.openport) {
      throw new Error('TSCLIB.dll 关键函数绑定失败 (openport)，无法打印');
    }

    this._loaded = true;
  }

  /**
   * Safe DLL call — catches exceptions and logs results.
   * @param {string} name - Function name for logging
   * @param  {...any} args - Arguments to pass to DLL function
   * @returns {number} Return value
   */
  _call(name, ...args) {
    const fn = this._fn[name];
    if (!fn) {
      throw new Error(`TSCLIB 函数 ${name} 未绑定`);
    }

    log.debug(`[TSCLIB] → ${name}(${args.map(a => typeof a === 'string' ? `"${a.substring(0, 30)}"` : a).join(', ')})`);

    try {
      const result = fn(...args);
      log.debug(`[TSCLIB] ← ${name} = ${result}`);
      return result;
    } catch (err) {
      log.error(`[TSCLIB] ✗ ${name} crashed: ${err.message}`);
      throw new Error(`TSCLIB ${name} 调用异常: ${err.message}`);
    }
  }

  /**
   * Print a label using TSCLIB.dll.
   *
   * @param {string} printerName - Windows printer name
   * @param {Object} config - Label configuration
   * @returns {Promise<{success: boolean}>}
   */
  async printLabel(printerName, config) {
    if (!this._loaded) {
      this.load();
    }

    if (this._printing) {
      throw new Error('打印机忙，请稍后再试');
    }

    this._printing = true;

    // ── Open port ──
    log.info(`[TSCLIB] Opening port: "${printerName}"`);
    const openResult = this._call('openport', printerName);
    if (openResult !== 1) {
      this._printing = false;
      throw new Error(`无法打开打印机端口: "${printerName}" (返回值: ${openResult})`);
    }
    this._portOpen = true;

    try {
      const { width, height, dpi = 203, copies = 1, elements } = config;
      const dotsPerMM = dpi / 25.4;

      // ── Setup label ──
      log.info(`[TSCLIB] Setup: ${width}×${height}mm, dpi=${dpi}`);
      this._call('setup',
        String(width), String(height),
        '4',    // speed
        '8',    // density
        '0',    // sensor (0=gap)
        '0',    // vertical
        '2,0'   // gap: 2mm,0mm
      );

      // ── Clear buffer ──
      this._call('clearbuffer');

      // ── Render elements ──
      for (let i = 0; i < elements.length; i++) {
        const el = elements[i];
        const x = Math.round((el.x || 0) * dotsPerMM);
        const y = Math.round((el.y || 0) * dotsPerMM);

        log.debug(`[TSCLIB] Element ${i}: type=${el.type}, x=${el.x}mm→${x}dots, y=${el.y}mm→${y}dots`);

        try {
          this._renderElement(el, x, y, dotsPerMM);
        } catch (elErr) {
          log.error(`[TSCLIB] Element ${i} (${el.type}) failed: ${elErr.message}`);
          // Continue with other elements — don't abort entire label
        }
      }

      // ── Print ──
      log.info(`[TSCLIB] Printing ${copies} copy/copies`);
      this._call('printlabel', '1', String(copies));

      log.info('[TSCLIB] Print job sent successfully');
      return { success: true };
    } finally {
      // Always close port
      if (this._portOpen) {
        try {
          this._call('closeport');
        } catch (err) {
          log.warn(`[TSCLIB] closeport error: ${err.message}`);
        }
        this._portOpen = false;
      }
      this._printing = false;
    }
  }

  // ─── Element Renderers ──────────────────────────────────────────

  _renderElement(el, x, y, dotsPerMM) {
    switch (el.type) {
      case 'text':
      case 'date':
        this._renderText(el, x, y);
        break;
      case 'barcode':
        this._renderBarcode(el, x, y);
        break;
      case 'qrcode':
        this._renderQRCode(el, x, y);
        break;
      case 'line':
        this._renderLine(el, x, y, dotsPerMM);
        break;
      case 'table':
        this._renderTable(el, x, y, dotsPerMM);
        break;
      default:
        log.warn(`[TSCLIB] Unknown element type: ${el.type}`);
    }
  }

  /**
   * Render text using windowsfontUnicode (Windows system font, supports Chinese + bold).
   */
  _renderText(el, x, y) {
    const content = el.content || '';
    if (!content) return;

    const fontH = Math.max(8, el.font_size || el.fontSize || 24);
    const fontW = el.font_width || el.fontWidth || fontH;
    const bold = el.bold ? 1 : 0;
    const fontName = el.font_name || 'SimSun';

    log.debug(`[TSCLIB] Text: "${content.substring(0, 30)}" fontH=${fontH} bold=${bold} font=${fontName}`);
    this._call('windowsfontUnicode', x, y, fontH, fontW, bold, 0, 0, fontName, content);
  }

  _renderBarcode(el, x, y) {
    if (el.barcodeType === 'QR') {
      this._renderQRCode(el, x, y);
      return;
    }
    const h = String(el.height || 60);
    const content = el.content || '';
    log.debug(`[TSCLIB] Barcode 128: "${content.substring(0, 30)}" h=${h}`);
    this._call('barcode',
      String(x), String(y), '128', h, '1', '0', '2', '2', content
    );
  }

  _renderQRCode(el, x, y) {
    const cellSize = String(el.size || 6);
    let content = el.content || '';
    if (el.gs1) content = '>8' + content;
    log.debug(`[TSCLIB] QR: "${content.substring(0, 30)}" cell=${cellSize}`);
    this._call('qrcode',
      String(x), String(y), 'L', cellSize, 'A', '0', content, ''
    );
  }

  _renderLine(el, x, y, dotsPerMM) {
    const lineW = Math.round((el.width || 50) * dotsPerMM);
    const thickness = el.thickness || 2;
    this._call('sendcommand', `BAR ${x},${y},${lineW},${thickness}`);
  }

  /**
   * Render table — migrated from bridge.js _tsplTable().
   */
  _renderTable(el, tableX, tableY, dotsPerMM) {
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
    const totalTableWidthDots = colWidthsDots.reduce((s, w) => s + w, 0);
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
      this._call('sendcommand', `BOX ${tableX},${tableY},${xEnd},${yEnd},${borderThickness}`);

      for (let r = 1; r < maxRows; r++) {
        const ly = tableY + r * rowHeightDots;
        let belowHasHidden = false;
        for (let c = 0; c < columns.length; c++) {
          if (cellHidden(r, c)) { belowHasHidden = true; break; }
        }
        if (belowHasHidden) {
          this._call('sendcommand', `BAR ${tableX},${ly},${totalTableWidthDots},${borderThickness}`);
        } else {
          let lx = tableX;
          for (let c = 0; c < columns.length; c++) {
            this._call('sendcommand', `BAR ${lx},${ly},${colWidthsDots[c]},${borderThickness}`);
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
            this._call('sendcommand', `BAR ${cx},${vy},${borderThickness},${rowHeightDots}`);
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
          this._call('windowsfontUnicode',
            hx + offsetX, tableY + 2, hFontSize, hFontSize, 1, 0, 0, fontName, header
          );
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

          this._call('windowsfontUnicode',
            cellX + offsetX, cellY + textOffsetY, cFontSize, cFontSize, 0, 0, 0, fontName, rawContent
          );
        }
        cellX += colWidthsDots[c];
      }
    }
  }

  /**
   * Close port and release resources.
   */
  close() {
    if (this._portOpen && this._fn.closeport) {
      try { this._call('closeport'); } catch (e) { /* ignore */ }
      this._portOpen = false;
    }
    this._printing = false;
  }
}

module.exports = TSCLibWrapper;
