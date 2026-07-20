/**
 * TSCLIB.dll Wrapper — Node.js FFI via koffi (with diagnostic)
 *
 * DLL loaded once at startup. On first load, calls dllversion() as a
 * safe diagnostic (no params, no port needed) to verify koffi + DLL work.
 * If the diagnostic crashes, we know it's a koffi/DLL compatibility issue.
 */

const path = require('path');
const fs = require('fs');
const log = require('electron-log');

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

class TSCLibWrapper {
  constructor() {
    this._lib = null;
    this._loaded = false;
    this._portOpen = false;
    this._printing = false;
    this._fn = {};
  }

  /**
   * Load DLL and bind functions. Called once at startup.
   * Step 1: require('koffi') — if this crashes, koffi binary is bad
   * Step 2: koffi.load(dll) — if this crashes, DLL is unloadable
   * Step 3: dllversion() — if this crashes, calling convention is wrong
   * Step 4: bind all other functions
   */
  load() {
    if (this._loaded) return;

    const dllPath = getDllPath();
    const diagFile = path.join(path.dirname(process.execPath || __dirname), 'tsclib-diag.txt');

    const diag = (msg) => {
      log.info(`[TSCLIB] ${msg}`);
      try { fs.appendFileSync(diagFile, `[${new Date().toISOString()}] ${msg}\n`, 'utf-8'); } catch (e) { /* ignore */ }
    };

    diag(`=== TSCLIB Diagnostic Start ===`);
    diag(`DLL path: ${dllPath}`);
    diag(`DLL exists: ${fs.existsSync(dllPath)}`);

    if (!fs.existsSync(dllPath)) {
      throw new Error(`TSCLIB.dll 不存在: ${dllPath}`);
    }

    const dllSize = fs.statSync(dllPath).size;
    diag(`DLL size: ${dllSize} bytes`);

    // Step 1: Load koffi module
    let koffi;
    try {
      diag('Step 1: require("koffi")...');
      koffi = require('koffi');
      diag(`Step 1 OK: koffi loaded`);
    } catch (err) {
      diag(`Step 1 FAILED: ${err.message}`);
      throw new Error(`koffi 模块加载失败: ${err.message}`);
    }

    // Step 2: Load DLL
    try {
      diag('Step 2: koffi.load(dll)...');
      this._lib = koffi.load(dllPath);
      diag('Step 2 OK: DLL loaded');
    } catch (err) {
      diag(`Step 2 FAILED: ${err.message}`);
      throw new Error(`TSCLIB.dll 加载失败: ${err.message}`);
    }

    // Step 3: Diagnostic test — call dllversion() (no params, safe)
    try {
      diag('Step 3: binding dllversion()...');
      const dllversion = this._lib.func('dllversion', 'str', []);
      diag('Step 3a: dllversion bound, calling...');
      const version = dllversion();
      diag(`Step 3 OK: DLL version = "${version}"`);
    } catch (err) {
      diag(`Step 3 FAILED: ${err.message}`);
      throw new Error(`TSCLIB.dll 诊断调用失败: ${err.message}`);
    }

    // Step 4: Bind all functions
    diag('Step 4: binding all functions...');
    const bindings = [
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

    let bound = 0, failed = 0;
    for (const [name, retType, params, ordinal] of bindings) {
      try {
        this._fn[name] = this._lib.func(name, retType, params);
        diag(`  Bound: ${name}`);
        bound++;
      } catch (err) {
        try {
          this._fn[name] = this._lib.func(ordinal, retType, params);
          diag(`  Bound ordinal: ${name}`);
          bound++;
        } catch (err2) {
          diag(`  FAILED: ${name} — ${err.message}`);
          failed++;
        }
      }
    }

    diag(`Step 4 done: ${bound} bound, ${failed} failed`);
    diag(`=== Diagnostic Complete ===`);

    if (!this._fn.openport) {
      throw new Error('TSCLIB 关键函数绑定失败');
    }

    this._loaded = true;
  }

  _call(name, ...args) {
    const fn = this._fn[name];
    if (!fn) throw new Error(`TSCLIB 函数 ${name} 未绑定`);
    log.debug(`[TSCLIB] → ${name}(${args.map(a => typeof a === 'string' ? `"${a.substring(0, 40)}"` : a).join(', ')})`);
    try {
      const result = fn(...args);
      log.debug(`[TSCLIB] ← ${name} = ${result}`);
      return result;
    } catch (err) {
      log.error(`[TSCLIB] ✗ ${name}: ${err.message}`);
      throw new Error(`TSCLIB ${name}: ${err.message}`);
    }
  }

  async printLabel(printerName, config) {
    if (!this._loaded) this.load();
    if (this._printing) throw new Error('打印机忙');

    this._printing = true;
    const r = this._call('openport', printerName);
    if (r !== 1) { this._printing = false; throw new Error(`无法打开端口: ${printerName}`); }
    this._portOpen = true;

    try {
      const { width, height, dpi = 203, copies = 1, elements } = config;
      const dpm = dpi / 25.4;

      this._call('setup', String(width), String(height), '4', '8', '0', '0', '2,0');
      this._call('clearbuffer');

      for (let i = 0; i < elements.length; i++) {
        const el = elements[i];
        const x = Math.round((el.x || 0) * dpm);
        const y = Math.round((el.y || 0) * dpm);
        try { this._renderElement(el, x, y, dpm); }
        catch (err) { log.error(`[TSCLIB] Element ${i} (${el.type}): ${err.message}`); }
      }

      this._call('printlabel', '1', String(copies));
      log.info(`[TSCLIB] Printed ${copies} copies`);
      return { success: true };
    } finally {
      if (this._portOpen) { try { this._call('closeport'); } catch (e) {} this._portOpen = false; }
      this._printing = false;
    }
  }

  _renderElement(el, x, y, dpm) {
    switch (el.type) {
      case 'text': case 'date': {
        const c = el.content || ''; if (!c) return;
        const h = Math.max(8, el.font_size || 24), w = el.font_width || h;
        this._call('windowsfontUnicode', x, y, h, w, el.bold ? 1 : 0, 0, 0, el.font_name || 'SimSun', c);
        break;
      }
      case 'barcode': {
        if (el.barcodeType === 'QR') { this._renderElement({ ...el, type: 'qrcode' }, x, y, dpm); return; }
        this._call('barcode', String(x), String(y), '128', String(el.height || 60), '1', '0', '2', '2', el.content || '');
        break;
      }
      case 'qrcode': {
        let c = el.content || ''; if (el.gs1) c = '>8' + c;
        this._call('qrcode', String(x), String(y), 'L', String(el.size || 6), 'A', '0', c, '');
        break;
      }
      case 'line': {
        const w = Math.round((el.width || 50) * dpm);
        this._call('sendcommand', `BAR ${x},${y},${w},${el.thickness || 2}`);
        break;
      }
      case 'table': this._renderTable(el, x, y, dpm); break;
      default: log.warn(`[TSCLIB] Unknown: ${el.type}`);
    }
  }

  _renderTable(el, tx, ty, dpm) {
    const cols = el.columns || [], co = el.cell_overrides || {};
    const mr = el.max_rows || 6, rh = Math.round((el.row_height || 6) * dpm);
    const bdr = el.border !== false, bt = el.border_thickness || 2;
    const dfs = el.cell_font_size || 16, hfs = el.header_font_size || 20;
    const sh = el.show_header !== false, fn = el.font_name || 'SimSun';
    const cw = cols.map(c => Math.round((c.width || 20) * dpm));
    const tw = cw.reduce((a, w) => a + w, 0), th = rh * mr;
    const hid = {}, sp = {};
    for (const [k, o] of Object.entries(co)) { if (o?.hidden) hid[k] = true; if (o?.colspan > 1) sp[k] = o.colspan; }
    const isH = (r, c) => hid[`${r},${c}`] === true;
    const gS = (r, c) => sp[`${r},${c}`] || 1;
    const skipV = (r, c) => {
      for (let l = c - 1; l >= 0; l--) if (l + gS(r, l) > c) return true;
      for (let rc = c; rc < cols.length; rc++) { const s = gS(r, rc); if (s > 1 && rc < c) return true; }
      return isH(r, c - 1) && isH(r, c);
    };
    if (bdr) {
      this._call('sendcommand', `BOX ${tx},${ty},${tx + tw - 1},${ty + th - 1},${bt}`);
      for (let r = 1; r < mr; r++) {
        const ly = ty + r * rh; let hh = false;
        for (let c = 0; c < cols.length; c++) if (isH(r, c)) { hh = true; break; }
        if (hh) this._call('sendcommand', `BAR ${tx},${ly},${tw},${bt}`);
        else { let lx = tx; for (let c = 0; c < cols.length; c++) { this._call('sendcommand', `BAR ${lx},${ly},${cw[c]},${bt}`); lx += cw[c]; } }
      }
      let cx = tx;
      for (let c = 1; c < cols.length; c++) { cx += cw[c - 1]; for (let r = 0; r < mr; r++) { if (!skipV(r, c)) this._call('sendcommand', `BAR ${cx},${ty + r * rh},${bt},${rh}`); } }
    }
    const ew = (t, s) => { const w = Math.max(8, s); let r = 0; for (let i = 0; i < t.length; i++) { const c = t.charCodeAt(i); r += (c <= 0x7F ? 1 : c <= 0x7FF ? 2 : 3) * w; } return r; };
    if (sh) {
      let hx = tx; const hf = Math.max(8, hfs);
      for (let c = 0; c < cols.length; c++) {
        const h = cols[c].header || '';
        if (h) { const tw2 = ew(h, hfs), ox = Math.max(2, Math.round((cw[c] - tw2) / 2)); this._call('windowsfontUnicode', hx + ox, ty + 2, hf, hf, 1, 0, 0, fn, h); }
        hx += cw[c];
      }
    }
    for (let r = 0; r < mr; r++) {
      const cy = ty + r * rh; let cx = tx;
      for (let c = 0; c < cols.length; c++) {
        const ov = co[`${r},${c}`]; if (ov?.hidden) { cx += cw[c]; continue; }
        const raw = ov?.content || '';
        if (raw) {
          const fs = ov?.font_size || dfs, al = cols[c].align || 'left';
          let cellW = cw[c]; const cs = ov?.colspan || 1;
          if (cs > 1) { cellW = 0; for (let ci = c; ci < Math.min(c + cs, cols.length); ci++) cellW += cw[ci]; }
          const cf = Math.max(8, fs), tw2 = ew(raw, fs);
          const oy = Math.max(1, Math.round((rh - cf) / 2) - Math.round(cf * 0.25));
          let ox; if (tw2 >= cellW) ox = Math.max(0, Math.round((cellW - tw2) / 2));
          else if (al === 'center') ox = Math.max(2, Math.round((cellW - tw2) / 2));
          else if (al === 'right') ox = Math.max(2, cellW - tw2 - 4);
          else ox = 2;
          this._call('windowsfontUnicode', cx + ox, cy + oy, cf, cf, 0, 0, 0, fn, raw);
        }
        cx += cw[c];
      }
    }
  }

  close() {
    if (this._portOpen && this._fn.closeport) { try { this._call('closeport'); } catch (e) {} this._portOpen = false; }
    this._printing = false;
  }
}

module.exports = TSCLibWrapper;
