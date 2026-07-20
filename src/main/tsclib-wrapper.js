/**
 * TSCLIB.dll Wrapper — Node.js FFI via koffi
 *
 * DLL is loaded ONCE at app startup. Function calls are direct — no PowerShell,
 * no process spawning, no compilation overhead.
 *
 * Text rendering uses Windows system fonts (SimSun/宋体) via windowsfontUnicode(),
 * no dependency on printer flash-stored fonts. Bold text is supported.
 *
 * DLL export names verified via objdump — all plain C names.
 * Signatures decoded from .lib C++ mangled names.
 *
 * IMPORTANT: Run `npm install` on the Windows target machine to get the correct
 * koffi binary (@koromix/koffi-win32-x64).
 */

const koffi = require('koffi');
const path = require('path');
const fs = require('fs');
const log = require('electron-log');

// ─── DLL Path Resolution ──────────────────────────────────────────

function getDllPath() {
  let base;
  try {
    const { app } = require('electron');
    base = app.isPackaged
      ? path.join(process.resourcesPath, 'tsclib', 'x64')
      : path.join(__dirname, '..', 'tsclib', 'x64');
  } catch {
    base = path.join(__dirname, '..', 'tsclib', 'x64');
  }
  return path.join(base, 'TSCLIB.dll');
}

// ─── TSCLibWrapper Class ──────────────────────────────────────────

class TSCLibWrapper {
  constructor() {
    this._lib = null;
    this._loaded = false;
    this._portOpen = false;
    this._printing = false;

    // Bound DLL functions
    this._fn = {};
  }

  /**
   * Load TSCLIB.dll and bind all function signatures.
   * Called once at app startup. DLL stays loaded for the app lifetime.
   * @throws {Error} if DLL cannot be loaded or key functions fail to bind
   */
  load() {
    if (this._loaded) return;

    const dllPath = getDllPath();
    log.info(`[TSCLIB] Loading DLL: ${dllPath}`);

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

    // Bind functions using plain export names (verified via objdump)
    // Signatures decoded from .lib mangled names:
    //   setup: 7× char*    barcode: 9× char*    qrcode: 8× char*
    //   windowsfontUnicode: 7× int + char* fontName + wchar_t* text
    const bindings = [
      // [name, returnType, paramTypes[], ordinal]
      ['openport',    'int', ['str'],                                             92],
      ['closeport',   'int', [],                                                   33],
      ['setup',       'int', ['str','str','str','str','str','str','str'],         127],
      ['clearbuffer', 'int', [],                                                   29],
      ['printlabel',  'int', ['str','str'],                                       104],
      ['windowsfont', 'int', ['int','int','int','int','int','int','int','str','str'], 155],
      ['windowsfontUnicode', 'int', ['int','int','int','int','int','int','int','str','str16'], 162],
      ['barcode',     'int', ['str','str','str','str','str','str','str','str','str'], 24],
      ['qrcode',      'int', ['str','str','str','str','str','str','str','str'],   107],
      ['sendcommand',    'int', ['str'],                                          115],
      ['sendcommandutf8','int', ['str'],                                          123],
      ['formfeed',    'int', [],                                                   81],
      ['nobackfeed',  'int', [],                                                   85],
    ];

    let bound = 0;
    let failed = 0;

    for (const [name, retType, params, ordinal] of bindings) {
      try {
        this._fn[name] = this._lib.func(name, retType, params);
        log.info(`[TSCLIB] Bound: ${name}(${params.join(', ')}) → ${retType}`);
        bound++;
      } catch (err) {
        // Try ordinal fallback
        try {
          this._fn[name] = this._lib.func(ordinal, retType, params);
          log.info(`[TSCLIB] Bound ordinal ${ordinal}: ${name}`);
          bound++;
        } catch (err2) {
          log.error(`[TSCLIB] Failed to bind: ${name} — ${err.message}`);
          failed++;
        }
      }
    }

    log.info(`[TSCLIB] Binding complete: ${bound} OK, ${failed} failed`);

    if (!this._fn.openport) {
      throw new Error('TSCLIB.dll 关键函数绑定失败，无法打印');
    }

    this._loaded = true;
  }

  /**
   * Safe DLL call with logging and error handling.
   */
  _call(name, ...args) {
    const fn = this._fn[name];
    if (!fn) throw new Error(`TSCLIB 函数 ${name} 未绑定`);

    log.debug(`[TSCLIB] → ${name}(${args.map(a => typeof a === 'string' ? `"${a.substring(0, 40)}"` : a).join(', ')})`);

    try {
      const result = fn(...args);
      log.debug(`[TSCLIB] ← ${name} = ${result}`);
      return result;
    } catch (err) {
      log.error(`[TSCLIB] ✗ ${name} exception: ${err.message}`);
      throw new Error(`TSCLIB ${name} 调用异常: ${err.message}`);
    }
  }

  /**
   * Print a label. DLL is already loaded — just open port, render, print, close.
   *
   * @param {string} printerName - Windows printer name
   * @param {Object} config - Label configuration
   * @returns {Promise<{success: boolean}>}
   */
  async printLabel(printerName, config) {
    if (!this._loaded) this.load();
    if (this._printing) throw new Error('打印机忙，请稍后再试');

    this._printing = true;

    log.info(`[TSCLIB] Opening port: "${printerName}"`);
    const r = this._call('openport', printerName);
    if (r !== 1) {
      this._printing = false;
      throw new Error(`无法打开打印机端口: "${printerName}" (返回值: ${r})`);
    }
    this._portOpen = true;

    try {
      const { width, height, dpi = 203, copies = 1, elements } = config;
      const dotsPerMM = dpi / 25.4;

      // Setup label
      this._call('setup', String(width), String(height), '4', '8', '0', '0', '2,0');
      this._call('clearbuffer');

      // Render elements
      for (let i = 0; i < elements.length; i++) {
        const el = elements[i];
        const x = Math.round((el.x || 0) * dotsPerMM);
        const y = Math.round((el.y || 0) * dotsPerMM);
        try {
          this._renderElement(el, x, y, dotsPerMM);
        } catch (err) {
          log.error(`[TSCLIB] Element ${i} (${el.type}) failed: ${err.message}`);
        }
      }

      // Print
      this._call('printlabel', '1', String(copies));
      log.info(`[TSCLIB] Print job sent (${copies} copies)`);
      return { success: true };
    } finally {
      if (this._portOpen) {
        try { this._call('closeport'); } catch (e) { log.warn(`[TSCLIB] closeport: ${e.message}`); }
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

  _renderText(el, x, y) {
    const content = el.content || '';
    if (!content) return;
    const fontH = Math.max(8, el.font_size || el.fontSize || 24);
    const fontW = el.font_width || el.fontWidth || fontH;
    const bold = el.bold ? 1 : 0;
    const fontName = el.font_name || 'SimSun';
    this._call('windowsfontUnicode', x, y, fontH, fontW, bold, 0, 0, fontName, content);
  }

  _renderBarcode(el, x, y) {
    if (el.barcodeType === 'QR') { this._renderQRCode(el, x, y); return; }
    const h = String(el.height || 60);
    this._call('barcode', String(x), String(y), '128', h, '1', '0', '2', '2', el.content || '');
  }

  _renderQRCode(el, x, y) {
    const cell = String(el.size || 6);
    let content = el.content || '';
    if (el.gs1) content = '>8' + content;
    this._call('qrcode', String(x), String(y), 'L', cell, 'A', '0', content, '');
  }

  _renderLine(el, x, y, dotsPerMM) {
    const w = Math.round((el.width || 50) * dotsPerMM);
    const t = el.thickness || 2;
    this._call('sendcommand', `BAR ${x},${y},${w},${t}`);
  }

  _renderTable(el, tableX, tableY, dotsPerMM) {
    const columns = el.columns || [];
    const cellOverrides = el.cell_overrides || {};
    const maxRows = el.max_rows || 6;
    const rowHeightDots = Math.round((el.row_height || 6) * dotsPerMM);
    const border = el.border !== false;
    const bt = el.border_thickness || 2;
    const defaultFS = el.cell_font_size || 16;
    const headerFS = el.header_font_size || 20;
    const showHeader = el.show_header !== false;
    const fontName = el.font_name || 'SimSun';

    const colW = columns.map(c => Math.round((c.width || 20) * dotsPerMM));
    const totalW = colW.reduce((a, w) => a + w, 0);
    const totalH = rowHeightDots * maxRows;

    // Visibility & colspan maps
    const hidden = {};
    const span = {};
    for (const [k, o] of Object.entries(cellOverrides)) {
      if (o?.hidden) hidden[k] = true;
      if (o?.colspan > 1) span[k] = o.colspan;
    }
    const isHidden = (r, c) => hidden[`${r},${c}`] === true;
    const getSpan = (r, c) => span[`${r},${c}`] || 1;
    const skipVLine = (r, c) => {
      for (let lc = c - 1; lc >= 0; lc--) if (lc + getSpan(r, lc) > c) return true;
      for (let rc = c; rc < columns.length; rc++) { const s = getSpan(r, rc); if (s > 1 && rc < c) return true; }
      return isHidden(r, c - 1) && isHidden(r, c);
    };

    // Border
    if (border) {
      this._call('sendcommand', `BOX ${tableX},${tableY},${tableX + totalW - 1},${tableY + totalH - 1},${bt}`);
      for (let r = 1; r < maxRows; r++) {
        const ly = tableY + r * rowHeightDots;
        let hasHidden = false;
        for (let c = 0; c < columns.length; c++) if (isHidden(r, c)) { hasHidden = true; break; }
        if (hasHidden) {
          this._call('sendcommand', `BAR ${tableX},${ly},${totalW},${bt}`);
        } else {
          let lx = tableX;
          for (let c = 0; c < columns.length; c++) { this._call('sendcommand', `BAR ${lx},${ly},${colW[c]},${bt}`); lx += colW[c]; }
        }
      }
      let cx = tableX;
      for (let c = 1; c < columns.length; c++) {
        cx += colW[c - 1];
        for (let r = 0; r < maxRows; r++) {
          if (!skipVLine(r, c)) this._call('sendcommand', `BAR ${cx},${tableY + r * rowHeightDots},${bt},${rowHeightDots}`);
        }
      }
    }

    // Text width estimate
    const textW = (text, fs) => {
      const cw = Math.max(8, fs);
      let w = 0;
      for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        w += (code <= 0x7F ? 1 : code <= 0x7FF ? 2 : 3) * cw;
      }
      return w;
    };

    // Header
    if (showHeader) {
      let hx = tableX;
      const hfs = Math.max(8, headerFS);
      for (let c = 0; c < columns.length; c++) {
        const hdr = columns[c].header || '';
        if (hdr) {
          const tw = textW(hdr, headerFS);
          const ox = Math.max(2, Math.round((colW[c] - tw) / 2));
          this._call('windowsfontUnicode', hx + ox, tableY + 2, hfs, hfs, 1, 0, 0, fontName, hdr);
        }
        hx += colW[c];
      }
    }

    // Cells
    for (let r = 0; r < maxRows; r++) {
      const cy = tableY + r * rowHeightDots;
      let cx = tableX;
      for (let c = 0; c < columns.length; c++) {
        const ov = cellOverrides[`${r},${c}`];
        if (ov?.hidden) { cx += colW[c]; continue; }
        const raw = ov?.content || '';
        if (raw) {
          const fs = ov?.font_size || defaultFS;
          const align = columns[c].align || 'left';
          let cw = colW[c];
          const cs = ov?.colspan || 1;
          if (cs > 1) { cw = 0; for (let ci = c; ci < Math.min(c + cs, columns.length); ci++) cw += colW[ci]; }
          const cfs = Math.max(8, fs);
          const tw = textW(raw, fs);
          const oy = Math.max(1, Math.round((rowHeightDots - cfs) / 2) - Math.round(cfs * 0.25));
          let ox;
          if (tw >= cw) ox = Math.max(0, Math.round((cw - tw) / 2));
          else if (align === 'center') ox = Math.max(2, Math.round((cw - tw) / 2));
          else if (align === 'right') ox = Math.max(2, cw - tw - 4);
          else ox = 2;
          this._call('windowsfontUnicode', cx + ox, cy + oy, cfs, cfs, 0, 0, 0, fontName, raw);
        }
        cx += colW[c];
      }
    }
  }

  /**
   * Release DLL and clean up. Called on app quit.
   */
  close() {
    if (this._portOpen && this._fn.closeport) {
      try { this._call('closeport'); } catch (e) { /* ignore */ }
      this._portOpen = false;
    }
    this._printing = false;
    // Note: don't unload DLL — it stays loaded for app lifetime
  }
}

module.exports = TSCLibWrapper;
