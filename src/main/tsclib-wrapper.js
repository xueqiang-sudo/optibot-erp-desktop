/**
 * TSCLIB.dll Wrapper — FFI bindings for TSC label printing via Windows driver
 *
 * Uses koffi to load TSCLIB.dll (x64) and call its exported C++ functions.
 * Text rendering uses Windows system fonts (SimSun/宋体) via windowsfontUnicode(),
 * eliminating the dependency on printer flash-stored fonts (SimsunEx.TTF).
 *
 * Bold text is supported via the bold parameter of windowsfontUnicode().
 *
 * DLL exported function signatures were reverse-engineered from the .lib symbol table.
 */

const koffi = require('koffi');
const path = require('path');
const log = require('electron-log');

// ─── DLL Path Resolution ──────────────────────────────────────────

/**
 * Resolve the path to TSCLIB.dll based on dev vs packaged mode.
 * - Dev: src/tsclib/x64/TSCLIB.dll (relative to __dirname)
 * - Packaged: resources/tsclib/x64/TSCLIB.dll (via process.resourcesPath)
 */
function getDllPath() {
  // Detect packaged mode: app.isPackaged or __dirname doesn't contain 'src'
  let base;
  try {
    const { app } = require('electron');
    if (app.isPackaged) {
      base = path.join(process.resourcesPath, 'tsclib', 'x64');
    } else {
      base = path.join(__dirname, '..', 'tsclib', 'x64');
    }
  } catch {
    // Fallback if electron app not available (e.g., testing)
    base = path.join(__dirname, '..', 'tsclib', 'x64');
  }
  return path.join(base, 'TSCLIB.dll');
}

// ─── TSCLibWrapper Class ──────────────────────────────────────────

class TSCLibWrapper {
  constructor() {
    this._lib = null;
    this._portOpen = false;
    this._printing = false;

    // DLL function references (bound after load)
    this._openport = null;
    this._closeport = null;
    this._setup = null;
    this._clearbuffer = null;
    this._printlabel = null;
    this._windowsfont = null;
    this._windowsfontUnicode = null;
    this._barcode = null;
    this._qrcode = null;
    this._sendcommand = null;
    this._sendcommandutf8 = null;
    this._formfeed = null;
    this._nobackfeed = null;

    this._loaded = false;
  }

  /**
   * Load TSCLIB.dll and bind function signatures.
   * Must be called before any printing operations.
   * @throws {Error} if DLL cannot be loaded
   */
  load() {
    if (this._loaded) return;

    const dllPath = getDllPath();
    log.info(`[TSCLIB] Loading DLL: ${dllPath}`);

    try {
      this._lib = koffi.load(dllPath);
    } catch (err) {
      log.error(`[TSCLIB] Failed to load DLL: ${err.message}`);
      throw new Error(`TSCLIB.dll 加载失败: ${err.message}\n路径: ${dllPath}`);
    }

    // ── Bind functions using C++ mangled names ──
    // Signatures reverse-engineered from .lib symbol table
    try {
      // Port management
      // ?openport@@YAHPEAD@Z → int openport(char* portName)
      this._openport = this._lib.func('?openport@@YAHPEAD@Z', 'int', ['str']);
      // ?closeport@@YAHXZ → int closeport()
      this._closeport = this._lib.func('?closeport@@YAHXZ', 'int', []);

      // Label setup — 7 string params (NOT integers)
      // ?setup@@YAHPEAD000000@Z → int setup(char* w, char* h, char* speed, char* density, char* sensor, char* vertical, char* gap)
      this._setup = this._lib.func('?setup@@YAHPEAD000000@Z', 'int', ['str', 'str', 'str', 'str', 'str', 'str', 'str']);

      // Buffer & print
      // ?clearbuffer@@YAHXZ → int clearbuffer()
      this._clearbuffer = this._lib.func('?clearbuffer@@YAHXZ', 'int', []);
      // ?printlabel@@YAHPEAD0@Z → int printlabel(char* setName, char* copies)
      this._printlabel = this._lib.func('?printlabel@@YAHPEAD0@Z', 'int', ['str', 'str']);

      // Text rendering
      // ?windowsfont@@YAHHHHHHHPEAD0@Z → int windowsfont(int, int, int, int, int, int, int, char*, char*)
      this._windowsfont = this._lib.func('?windowsfont@@YAHHHHHHHPEAD0@Z', 'int', [
        'int', 'int', 'int', 'int', 'int', 'int', 'int', 'str', 'str',
      ]);

      // ?windowsfontUnicode@@YAHHHHHHHPEADPEA_W@Z → int windowsfontUnicode(int x, int y, int fontH, int fontW, int bold, int italic, int underline, char* fontName, wchar_t* text)
      this._windowsfontUnicode = this._lib.func('?windowsfontUnicode@@YAHHHHHHHPEADPEA_W@Z', 'int', [
        'int', 'int', 'int', 'int', 'int', 'int', 'int', 'str', 'str16',
      ]);

      // Barcode — 9 string params
      // ?barcode@@YAHPEAD000000000@Z → int barcode(char* ×9)
      this._barcode = this._lib.func('?barcode@@YAHPEAD000000000@Z', 'int', [
        'str', 'str', 'str', 'str', 'str', 'str', 'str', 'str', 'str',
      ]);

      // QR code — 8 string params
      // ?qrcode@@YAHPEAD00000000@Z → int qrcode(char* ×8)
      this._qrcode = this._lib.func('?qrcode@@YAHPEAD00000000@Z', 'int', [
        'str', 'str', 'str', 'str', 'str', 'str', 'str', 'str',
      ]);

      // Raw TSPL passthrough
      // ?sendcommand@@YAHPEAD@Z → int sendcommand(char* cmd)
      this._sendcommand = this._lib.func('?sendcommand@@YAHPEAD@Z', 'int', ['str']);
      // sendcommandutf8 — plain export (no mangling)
      this._sendcommandutf8 = this._lib.func('sendcommandutf8', 'int', ['str']);

      // Utility
      // ?formfeed@@YAHXZ → int formfeed()
      this._formfeed = this._lib.func('?formfeed@@YAHXZ', 'int', []);
      // ?nobackfeed@@YAHXZ → int nobackfeed()
      this._nobackfeed = this._lib.func('?nobackfeed@@YAHXZ', 'int', []);

      this._loaded = true;
      log.info('[TSCLIB] DLL loaded successfully, all functions bound');
    } catch (err) {
      log.error(`[TSCLIB] Failed to bind DLL functions: ${err.message}`);
      // Try alternative: use plain (unmangled) export names
      // Some DLL versions export both mangled and unmangled names
      try {
        log.info('[TSCLIB] Trying plain export names...');
        this._openport = this._lib.func('openport', 'int', ['str']);
        this._closeport = this._lib.func('closeport', 'int', []);
        this._setup = this._lib.func('setup', 'int', ['str', 'str', 'str', 'str', 'str', 'str', 'str']);
        this._clearbuffer = this._lib.func('clearbuffer', 'int', []);
        this._printlabel = this._lib.func('printlabel', 'int', ['str', 'str']);
        this._windowsfont = this._lib.func('windowsfont', 'int', [
          'int', 'int', 'int', 'int', 'int', 'int', 'int', 'str', 'str',
        ]);
        this._windowsfontUnicode = this._lib.func('windowsfontUnicode', 'int', [
          'int', 'int', 'int', 'int', 'int', 'int', 'int', 'str', 'str16',
        ]);
        this._barcode = this._lib.func('barcode', 'int', [
          'str', 'str', 'str', 'str', 'str', 'str', 'str', 'str', 'str',
        ]);
        this._qrcode = this._lib.func('qrcode', 'int', [
          'str', 'str', 'str', 'str', 'str', 'str', 'str', 'str',
        ]);
        this._sendcommand = this._lib.func('sendcommand', 'int', ['str']);
        this._sendcommandutf8 = this._lib.func('sendcommandutf8', 'int', ['str']);
        this._formfeed = this._lib.func('formfeed', 'int', []);
        this._nobackfeed = this._lib.func('nobackfeed', 'int', []);

        this._loaded = true;
        log.info('[TSCLIB] DLL loaded with plain export names');
      } catch (err2) {
        log.error(`[TSCLIB] Plain exports also failed: ${err2.message}`);
        throw new Error(`TSCLIB.dll 函数绑定失败: ${err.message}`);
      }
    }
  }

  /**
   * Safe DLL call wrapper — logs return values and catches exceptions.
   * @param {string} name - Function name for logging
   * @param {Function} fn - DLL function reference
   * @param {Array} args - Arguments to pass
   * @returns {number} Return value from DLL
   */
  _call(name, fn, ...args) {
    try {
      const result = fn(...args);
      if (result === 0) {
        log.warn(`[TSCLIB] ${name} returned 0 (possible failure)`);
      }
      return result;
    } catch (err) {
      log.error(`[TSCLIB] ${name} threw: ${err.message}`);
      throw new Error(`TSCLIB ${name} 调用失败: ${err.message}`);
    }
  }

  /**
   * Print a label using TSCLIB.dll.
   *
   * @param {string} printerName - Windows printer name (from Get-Printer)
   * @param {Object} config - Label configuration
   * @param {number} config.width - Label width in mm
   * @param {number} config.height - Label height in mm
   * @param {number} [config.dpi=203] - Printer DPI
   * @param {number} [config.copies=1] - Number of copies
   * @param {Array} config.elements - Label elements
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

    // Open port
    log.info(`[TSCLIB] Opening port: ${printerName}`);
    const openResult = this._call('openport', this._openport, printerName);
    if (openResult !== 1) {
      this._printing = false;
      throw new Error(`无法打开打印机端口: ${printerName} (返回值: ${openResult})`);
    }
    this._portOpen = true;

    try {
      const { width, height, dpi = 203, copies = 1, elements } = config;
      const dotsPerMM = dpi / 25.4;

      // ── Setup label ──
      // setup(width, height, speed, density, sensor, vertical, gap)
      // All params are strings. gap is "gapW,gapH"
      this._call('setup', this._setup,
        width.toString(), height.toString(),
        '4',    // speed
        '8',    // density
        '0',    // sensor (0=gap sensor)
        '0',    // vertical
        '2,0'   // gap: 2mm width, 0mm height
      );

      // ── Clear buffer ──
      this._call('clearbuffer', this._clearbuffer);

      // ── Render elements ──
      for (let i = 0; i < elements.length; i++) {
        const el = elements[i];
        const x = Math.round((el.x || 0) * dotsPerMM);
        const y = Math.round((el.y || 0) * dotsPerMM);

        log.debug(`[TSCLIB] Element ${i}: type=${el.type}, x=${el.x}mm→${x}dots, y=${el.y}mm→${y}dots`);

        this._renderElement(el, x, y, dotsPerMM);
      }

      // ── Print ──
      log.info(`[TSCLIB] Printing ${copies} copy/copies`);
      this._call('printlabel', this._printlabel, '1', copies.toString());

      log.info(`[TSCLIB] Print job sent successfully`);
      return { success: true };
    } finally {
      // Always close port
      if (this._portOpen) {
        try {
          this._call('closeport', this._closeport);
        } catch (err) {
          log.warn(`[TSCLIB] closeport error: ${err.message}`);
        }
        this._portOpen = false;
      }
      this._printing = false;
    }
  }

  /**
   * Render a single label element via TSCLIB function calls.
   * @param {Object} el - Element descriptor
   * @param {number} x - X position in dots
   * @param {number} y - Y position in dots
   * @param {number} dotsPerMM - Conversion factor
   * @private
   */
  _renderElement(el, x, y, dotsPerMM) {
    switch (el.type) {
      case 'text':
        this._renderText(el, x, y);
        break;

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
   * Render text using windowsfontUnicode (Windows system font).
   * Supports bold via the bold parameter.
   * @private
   */
  _renderText(el, x, y) {
    const content = el.content || '';
    if (!content) return;

    const fontH = Math.max(8, el.font_size || el.fontSize || 24);
    const fontW = el.font_width || el.fontWidth || fontH; // square proportions
    const bold = el.bold ? 1 : 0;
    const fontName = el.font_name || 'SimSun'; // Windows 宋体

    log.debug(`[TSCLIB] Text: "${content.substring(0, 20)}..." fontH=${fontH} bold=${bold} font=${fontName}`);
    this._call('windowsfontUnicode', this._windowsfontUnicode,
      x, y, fontH, fontW, bold, 0, 0, fontName, content
    );
  }

  /**
   * Render a 1D barcode or QR barcode.
   * @private
   */
  _renderBarcode(el, x, y) {
    if (el.barcodeType === 'QR') {
      this._renderQRCode(el, x, y);
      return;
    }

    const h = (el.height || 60).toString();
    const content = el.content || '';
    log.debug(`[TSCLIB] Barcode 128: "${content.substring(0, 20)}" h=${h}`);
    // barcode(x, y, type, height, human_readable, alignment, rotation, narrow_width, content)
    // All 9 params as strings
    this._call('barcode', this._barcode,
      x.toString(), y.toString(), '128', h, '1', '0', '2', '2', content
    );
  }

  /**
   * Render a QR code.
   * @private
   */
  _renderQRCode(el, x, y) {
    const cellSize = (el.size || 6).toString();
    let content = el.content || '';

    // GS1 QR code: prepend FNC1
    if (el.gs1) {
      content = '>8' + content;
    }

    log.debug(`[TSCLIB] QR code: "${content.substring(0, 20)}" cell=${cellSize}`);
    // qrcode(x, y, ec_level, cell_size, mode, rotation, data, ??)
    // All 8 params as strings
    this._call('qrcode', this._qrcode,
      x.toString(), y.toString(), 'L', cellSize, 'A', '0', content, ''
    );
  }

  /**
   * Render a horizontal line (BAR command).
   * @private
   */
  _renderLine(el, x, y, dotsPerMM) {
    const lineW = Math.round((el.width || 50) * dotsPerMM);
    const thickness = el.thickness || 2;
    this._call('sendcommand', this._sendcommand, `BAR ${x},${y},${lineW},${thickness}`);
  }

  /**
   * Render a table with borders, headers, and cell content.
   * Migrated from bridge.js _tsplTable() — same layout logic, DLL calls instead of TSPL strings.
   * @private
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

    // Calculate column widths in dots
    const colWidthsDots = columns.map((col) => Math.round((col.width || 20) * dotsPerMM));
    const totalTableWidthDots = colWidthsDots.reduce((s, w) => s + w, 0);
    const totalTableHeightDots = rowHeightDots * maxRows;

    // ── Build cell visibility & colspan maps ──
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
        const span = getColspan(r, lc);
        if (lc + span > c) return true;
      }
      for (let rc = c; rc < columns.length; rc++) {
        const span = getColspan(r, rc);
        if (span > 1 && rc < c) return true;
      }
      return cellHidden(r, c - 1) && cellHidden(r, c);
    }

    // ── Draw border grid ──
    if (border) {
      const xEnd = tableX + totalTableWidthDots - 1;
      const yEnd = tableY + totalTableHeightDots - 1;
      this._call('sendcommand', this._sendcommand, `BOX ${tableX},${tableY},${xEnd},${yEnd},${borderThickness}`);

      // Horizontal internal lines
      for (let r = 1; r < maxRows; r++) {
        const ly = tableY + r * rowHeightDots;
        let belowHasHidden = false;
        for (let c = 0; c < columns.length; c++) {
          if (cellHidden(r, c)) { belowHasHidden = true; break; }
        }
        if (belowHasHidden) {
          this._call('sendcommand', this._sendcommand, `BAR ${tableX},${ly},${totalTableWidthDots},${borderThickness}`);
        } else {
          let lx = tableX;
          for (let c = 0; c < columns.length; c++) {
            this._call('sendcommand', this._sendcommand, `BAR ${lx},${ly},${colWidthsDots[c]},${borderThickness}`);
            lx += colWidthsDots[c];
          }
        }
      }

      // Vertical internal lines
      let cx = tableX;
      for (let c = 1; c < columns.length; c++) {
        cx += colWidthsDots[c - 1];
        for (let r = 0; r < maxRows; r++) {
          if (!skipVerticalLine(r, c)) {
            const vy = tableY + r * rowHeightDots;
            this._call('sendcommand', this._sendcommand, `BAR ${cx},${vy},${borderThickness},${rowHeightDots}`);
          }
        }
      }
    }

    // ── Helper: estimate text width in dots ──
    function estimateTextWidth(text, fontSize) {
      const charW = Math.max(8, fontSize);
      let w = 0;
      for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        let bytes;
        if (code <= 0x7F) bytes = 1;
        else if (code <= 0x7FF) bytes = 2;
        else bytes = 3;
        w += bytes * charW;
      }
      return w;
    }

    // ── Draw header row ──
    if (showHeader) {
      let hx = tableX;
      const hFontSize = Math.max(8, headerFontSize);

      for (let c = 0; c < columns.length; c++) {
        if (columns[c].header) {
          const header = columns[c].header || '';
          if (header) {
            const cellW = colWidthsDots[c];
            const textW = estimateTextWidth(header, headerFontSize);
            const offsetX = Math.max(2, Math.round((cellW - textW) / 2));
            const textY = tableY + 2;

            this._call('windowsfontUnicode', this._windowsfontUnicode,
              hx + offsetX, textY, hFontSize, hFontSize, 1, 0, 0, fontName, header
            );
          }
        }
        hx += colWidthsDots[c];
      }
    }

    // ── Draw cell content ──
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
        const content = rawContent;

        if (content) {
          const fontSize = (override && override.font_size) || defaultCellFontSize;
          const align = columns[c].align || 'left';

          // Handle colspan
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
          const renderedH = cFontSize;

          // Vertical centering
          const ascentShift = Math.round(cFontSize * 0.25);
          const textOffsetY = Math.max(1, Math.round((rowHeightDots - renderedH) / 2) - ascentShift);

          // Horizontal alignment
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

          this._call('windowsfontUnicode', this._windowsfontUnicode,
            cellX + offsetX, cellY + textOffsetY, cFontSize, cFontSize, 0, 0, 0, fontName, content
          );
        }

        cellX += colWidthsDots[c];
      }
    }
  }

  /**
   * Close the DLL port and release resources.
   */
  close() {
    if (this._portOpen && this._closeport) {
      try {
        this._call('closeport', this._closeport);
      } catch (err) {
        log.warn(`[TSCLIB] close on destroy error: ${err.message}`);
      }
      this._portOpen = false;
    }
    this._printing = false;
  }
}

module.exports = TSCLibWrapper;
