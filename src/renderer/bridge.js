/**
 * Frappe Web Page Bridge Script
 *
 * This script is injected into the Frappe web page after it loads.
 * It provides a Frappe-friendly wrapper around the electronAPI hardware APIs.
 *
 * Printing uses TSPL (TSC Printer Language) — the native language of TSC printers.
 * Chinese text uses the "CHN" TrueType font stored on the printer's flash drive.
 */

(function () {
  'use strict';

  // Guard: only run in Electron environment
  if (!window.electronAPI) {
    return;
  }

  // Guard: prevent double initialization
  if (window._optibotBridgeInitialized) {
    return;
  }
  window._optibotBridgeInitialized = true;

  console.log('[OptiBot Bridge] Initializing hardware bridge...');

  // ─── Bridge API ──────────────────────────────────────────────
  window.OptiBotBridge = {
    version: '2.0.0',

    // Current weight value
    currentWeight: null,

    // Scale connection status
    scaleConnected: false,

    // Printer list
    printers: [],

    // Currently selected default printer
    currentPrinter: null,

    /**
     * Initialize the bridge: connect scale, discover printers
     */
    async init() {
      const config = await window.electronAPI.app.getConfig();

      if (config.autoConnectScale && config.lastScalePort) {
        try {
          await this.connectScale(config.lastScalePort, config.lastScaleOptions);
        } catch (err) {
          console.warn('[OptiBot Bridge] Auto-connect scale failed:', err);
        }
      }

      try {
        await this.listPrinters();
        console.log('[OptiBot Bridge] Printers found:', this.printers.length);
      } catch (err) {
        console.warn('[OptiBot Bridge] Printer discovery failed:', err);
      }

      window.electronAPI.scale.onWeight((data) => {
        this.currentWeight = data;
        this._updateWeightWidget();
        window.dispatchEvent(new CustomEvent('optibot:weight', { detail: data }));
      });

      window.electronAPI.scale.onStatus((status) => {
        this.scaleConnected = status.connected;
        this._updateWeightWidget();
        window.dispatchEvent(new CustomEvent('optibot:scale-status', { detail: status }));
      });

      console.log('[OptiBot Bridge] Initialized');
    },

    async connectScale(port, options) {
      await window.electronAPI.scale.connect(port, options);
      this.scaleConnected = true;
    },

    async disconnectScale() {
      await window.electronAPI.scale.disconnect();
      this.scaleConnected = false;
    },

    getWeight() {
      return this.currentWeight ? this.currentWeight.value : null;
    },

    // ─── Printer Management ─────────────────────────────────────

    async listPrinters() {
      this.printers = await window.electronAPI.printer.listPrinters();

      if (this.currentPrinter) {
        const stillHere = this.printers.find((p) => p.id === this.currentPrinter.id);
        if (stillHere) {
          this.currentPrinter = stillHere;
        } else {
          this.currentPrinter = null;
          console.warn('[OptiBot Bridge] Selected printer no longer available');
        }
      }

      this._showPrinterDialog(this.printers);
      return this.printers;
    },

    async setPrinter(printerId) {
      if (this.printers.length === 0) {
        await this.listPrinters();
      }

      const printer = this.printers.find((p) => p.id === printerId);
      if (!printer) {
        const available = this.printers.map((p) => p.id).join(', ');
        throw new Error(`Printer "${printerId}" not found. Available: ${available || 'none'}`);
      }

      this.currentPrinter = printer;
      console.log(`[OptiBot Bridge] Default printer set: ${printer.name} (${printer.id})`);
      return printer;
    },

    getPrinter() {
      return this.currentPrinter;
    },

    /**
     * Print a label using TSPL commands.
     * @param {string} tsplData - TSPL command string
     * @returns {Promise<{success: boolean}>}
     */
    async printLabel(tsplData) {
      let printerId = this.currentPrinter ? this.currentPrinter.id : null;

      if (!printerId) {
        if (this.printers.length === 0) {
          await this.listPrinters();
        }
        if (this.printers.length > 0) {
          printerId = this.printers[0].id;
        }
      }

      if (!printerId) {
        this._showPrintResultDialog(false, '没有可用的打印机', null, tsplData);
        throw new Error('No printer available');
      }

      const printer = this.printers.find((p) => p.id === printerId);

      this._showPrintProgressDialog(printer, tsplData);

      const timeoutMs = 10000;
      try {
        const result = await Promise.race([
          window.electronAPI.printer.printTSPL(printerId, tsplData),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`打印超时 (${timeoutMs / 1000}秒无响应)`)), timeoutMs)
          ),
        ]);
        this._showPrintResultDialog(true, null, printer, tsplData);
        return result;
      } catch (err) {
        this._showPrintResultDialog(false, err.message, printer, tsplData);
        throw err;
      }
    },

    /**
     * Create TSPL commands from a JSON description.
     *
     * TSPL is TSC's native printer language — works directly with the TSC Windows driver.
     * Chinese text uses the "CHN" TrueType font stored on the printer's flash drive.
     *
     * @param {Object} options
     * @param {number} options.width - Label width in mm
     * @param {number} options.height - Label height in mm
     * @param {number} [options.dpi=203] - Printer DPI
     * @param {number} [options.copies=1] - Number of copies
     * @param {Array} options.elements - Label elements
     * @returns {string} Complete TSPL command string
     */
    buildTSPL(options) {
      const { width, height, dpi = 203, copies = 1, elements } = options;
      const dotsPerMM = dpi / 25.4;

      let tspl = '';

      // ── Label setup ──
      tspl += `SIZE ${width} mm,${height} mm\n`;
      tspl += `GAP 2 mm,0 mm\n`;
      tspl += `DIRECTION 1\n`;
      tspl += `CLS\n`;

      // ── Render elements ──
      for (let i = 0; i < elements.length; i++) {
        const el = elements[i];
        const x = Math.round((el.x || 0) * dotsPerMM);
        const y = Math.round((el.y || 0) * dotsPerMM);

        console.log(`[OptiBot Bridge] Element ${i}: type=${el.type}, x=${el.x}, y=${el.y}`);

        switch (el.type) {
          case 'text':
            tspl += this._tsplText(el, x, y);
            break;

          case 'date':
            tspl += this._tsplText(
              {
                content: el.content,
                fontSize: el.font_size || 20,
                fontWidth: el.font_width,
                chinese: el.chinese,
                bold: el.bold,
                rotation: el.rotation,
              },
              x,
              y
            );
            break;

          case 'barcode':
            if (el.barcodeType === 'QR') {
              const cellSize = el.size || 6;
              tspl += `QRCODE ${x},${y},L,${cellSize},A,0,"${el.content || ''}"\n`;
            } else {
              const h = el.height || 60;
              tspl += `BARCODE ${x},${y},"128",${h},1,0,2,2,"${el.content || ''}"\n`;
            }
            break;

          case 'qrcode': {
            const cellSize = el.size || 6;
            let content = el.content || '';
            // GS1 QR code: prepend FNC1
            if (el.gs1) {
              content = '>8' + content;
            }
            tspl += `QRCODE ${x},${y},L,${cellSize},A,0,"${content}"\n`;
            break;
          }

          case 'line': {
            const lineW = Math.round((el.width || 50) * dotsPerMM);
            const thickness = el.thickness || 2;
            // TSPL BAR: draw a solid rectangle (used as horizontal line)
            tspl += `BAR ${x},${y},${lineW},${thickness}\n`;
            break;
          }

          case 'table':
            tspl += this._tsplTable(el, x, y, dotsPerMM);
            break;

          default:
            console.warn(`[OptiBot Bridge] Unknown element type: ${el.type}`);
        }
      }

      // ── Print ──
      tspl += `PRINT ${copies}\n`;
      return tspl;
    },

    /**
     * Generate TSPL TEXT command for a text element.
     *
     * Chinese text: uses "CHN" TrueType font on printer's flash drive
     * English text: uses built-in font "1" (8x12 dots base)
     *
     * @private
     */
    _tsplText(el, x, y) {
      const h = el.fontSize || 24;
      const content = (el.content || '').replace(/"/g, '""');  // Escape double quotes
      if (!content) return '';

      // Rotation: 0, 90, 180, 270
      const rot = el.rotation || 0;

      if (el.chinese) {
        // Use "CHN" TrueType font from printer flash
        // CHN font base height is ~24 dots at multiplier 1
        // Multiply by 2 for readable Chinese text
        const mul = Math.max(2, Math.round(h / 24) * 2);
        return `TEXT ${x},${y},"CHN",${rot},${mul},${mul},"${content}"\n`;
      } else {
        // Built-in font "1" = 8x12 dots base
        const mulY = Math.max(1, Math.round(h / 12));
        const mulX = Math.max(1, Math.round((el.fontWidth || h) / 8));
        return `TEXT ${x},${y},"1",${rot},${mulX},${mulY},"${content}"\n`;
      }
    },

    /**
     * Generate TSPL commands for a table element.
     * Uses BAR for border lines and TEXT for cell content.
     *
     * @private
     */
    _tsplTable(el, tableX, tableY, dotsPerMM) {
      let tspl = '';
      const columns = el.columns || [];
      const cellOverrides = el.cell_overrides || {};
      const maxRows = el.max_rows || 6;
      const rowHeightMM = el.row_height || 6;
      const rowHeightDots = Math.round(rowHeightMM * dotsPerMM);
      const border = el.border !== false;
      const borderThickness = el.border_thickness || 2;
      const cellFontSize = el.cell_font_size || 16;
      const headerFontSize = el.header_font_size || 20;
      const chinese = el.chinese !== false;
      const showHeader = el.show_header !== false;

      // Calculate column widths in dots
      const colWidthsDots = columns.map((col) => Math.round((col.width || 20) * dotsPerMM));
      const totalTableWidthDots = colWidthsDots.reduce((s, w) => s + w, 0);
      const totalTableHeightDots = rowHeightDots * maxRows;

      // ── Draw border grid ──
      if (border) {
        // Outer border
        const xEnd = tableX + totalTableWidthDots - 1;
        const yEnd = tableY + totalTableHeightDots - 1;
        tspl += `BOX ${tableX},${tableY},${xEnd},${yEnd},${borderThickness}\n`;

        // Horizontal lines between rows
        for (let r = 1; r < maxRows; r++) {
          const ly = tableY + r * rowHeightDots;
          tspl += `BAR ${tableX},${ly},${totalTableWidthDots},${borderThickness}\n`;
        }

        // Vertical lines between columns
        let cx = tableX;
        for (let c = 1; c < columns.length; c++) {
          cx += colWidthsDots[c - 1];
          tspl += `BAR ${cx},${tableY},${borderThickness},${totalTableHeightDots}\n`;
        }
      }

      // Font multiplier for Chinese text (x2 for readable size)
      const chnMul = Math.max(2, Math.round(cellFontSize / 24) * 2);
      const chnHeaderMul = Math.max(2, Math.round(headerFontSize / 24) * 2);
      // Built-in font multipliers
      const engMulY = Math.max(1, Math.round(cellFontSize / 12));
      const engMulX = Math.max(1, Math.round(cellFontSize / 8));
      const engHeaderMulY = Math.max(1, Math.round(headerFontSize / 12));
      const engHeaderMulX = Math.max(1, Math.round(headerFontSize / 8));

      // ── Draw header row ──
      if (showHeader) {
        let hx = tableX;
        for (let c = 0; c < columns.length; c++) {
          if (columns[c].header) {
            const textX = hx + 2;
            const textY = tableY + 2;
            const header = (columns[c].header || '').replace(/"/g, '""');
            if (header) {
              if (chinese) {
                tspl += `TEXT ${textX},${textY},"CHN",0,${chnHeaderMul},${chnHeaderMul},"${header}"\n`;
              } else {
                tspl += `TEXT ${textX},${textY},"1",0,${engHeaderMulX},${engHeaderMulY},"${header}"\n`;
              }
            }
          }
          hx += colWidthsDots[c];
        }
      }

      // ── Draw cell content ──
      for (let r = 0; r < maxRows; r++) {
        const cellY = tableY + r * rowHeightDots;
        const textOffsetY = Math.max(1, Math.round((rowHeightDots - cellFontSize) / 2));

        let cellX = tableX;
        for (let c = 0; c < columns.length; c++) {
          const key = `${r},${c}`;
          const override = cellOverrides[key];
          const rawContent = override ? override.content || '' : '';
          const content = rawContent.replace(/"/g, '""');

          if (content) {
            const align = columns[c].align || 'left';
            const charWidth = cellFontSize * 0.6;
            const textWidthDots = rawContent.length * charWidth;
            const cellW = colWidthsDots[c];

            let offsetX;
            if (align === 'center') {
              offsetX = Math.max(2, Math.round((cellW - textWidthDots) / 2));
            } else if (align === 'right') {
              offsetX = Math.max(2, cellW - textWidthDots - 4);
            } else {
              offsetX = 2;
            }

            if (chinese) {
              tspl += `TEXT ${cellX + offsetX},${cellY + textOffsetY},"CHN",0,${chnMul},${chnMul},"${content}"\n`;
            } else {
              tspl += `TEXT ${cellX + offsetX},${cellY + textOffsetY},"1",0,${engMulX},${engMulY},"${content}"\n`;
            }
          }

          cellX += colWidthsDots[c];
        }
      }

      return tspl;
    },

    /**
     * Print a label from a JSON description.
     * Converts JSON → TSPL → sends to printer.
     */
    async printFromJSON(json) {
      try {
        console.log('[OptiBot Bridge] printFromJSON input type:', typeof json,
          'constructor:', json ? json.constructor.name : 'null');

        if (typeof json === 'string') {
          json = JSON.parse(json);
        }

        if (json && typeof json === 'object') {
          if (json.data && typeof json.data === 'string') {
            json = JSON.parse(json.data);
          } else if (json.data && typeof json.data === 'object' && json.data.elements) {
            json = json.data;
          } else if (json.message && typeof json.message === 'string') {
            json = JSON.parse(json.message);
          } else if (json.message && typeof json.message === 'object' && json.message.elements) {
            json = json.message;
          }
        }

        if (json && typeof json.elements === 'string') {
          json.elements = JSON.parse(json.elements);
        }

        if (json && Array.isArray(json.elements)) {
          json.elements = json.elements.map((el) => {
            if (typeof el === 'string') return JSON.parse(el);
            if (el.cell_overrides && typeof el.cell_overrides === 'string') {
              el.cell_overrides = JSON.parse(el.cell_overrides);
            }
            if (el.columns && typeof el.columns === 'string') {
              el.columns = JSON.parse(el.columns);
            }
            return el;
          });
        }

        if (!json || typeof json !== 'object') {
          throw new Error('Invalid input: expected JSON object');
        }
        if (!Array.isArray(json.elements)) {
          throw new Error('elements must be an array, got: ' + typeof json.elements);
        }

        console.log(
          `[OptiBot Bridge] printFromJSON: ${json.elements.length} elements, ` +
          `${json.width}x${json.height}mm`
        );

        const tsplData = this.buildTSPL(json);
        console.log('[OptiBot Bridge] Generated TSPL:\n', tsplData);
        return await this.printLabel(tsplData);
      } catch (err) {
        console.error('[OptiBot Bridge] printFromJSON error:', err.message, err.stack);
        this._showPrintResultDialog(false, err.message, null, '');
        throw err;
      }
    },

    // ─── Weight Widget ───────────────────────────────────────────

    showWeightWidget() {
      if (document.getElementById('optibot-weight-widget')) return;

      const widget = document.createElement('div');
      widget.id = 'optibot-weight-widget';
      widget.innerHTML = `
        <div style="
          position:fixed;bottom:20px;right:20px;background:#1a73e8;color:white;
          padding:12px 20px;border-radius:8px;font-family:-apple-system,sans-serif;
          font-size:18px;font-weight:bold;box-shadow:0 4px 12px rgba(0,0,0,0.3);
          z-index:99999;cursor:move;user-select:none;display:flex;align-items:center;gap:10px;
        ">
          <span style="font-size:14px;opacity:0.8;">⚖️</span>
          <span id="optibot-weight-value">-- kg</span>
          <span id="optibot-weight-status" style="
            width:8px;height:8px;border-radius:50%;background:#ccc;
          "></span>
        </div>
      `;
      document.body.appendChild(widget);
      this._makeDraggable(widget);
    },

    hideWeightWidget() {
      const widget = document.getElementById('optibot-weight-widget');
      if (widget) widget.remove();
    },

    _updateWeightWidget() {
      const valueEl = document.getElementById('optibot-weight-value');
      const statusEl = document.getElementById('optibot-weight-status');

      if (valueEl && this.currentWeight) {
        valueEl.textContent = `${this.currentWeight.value.toFixed(2)} kg`;
      }

      if (statusEl) {
        if (this.scaleConnected) {
          statusEl.style.background =
            this.currentWeight && this.currentWeight.stable ? '#4caf50' : '#ffc107';
        } else {
          statusEl.style.background = '#ccc';
          if (valueEl) valueEl.textContent = '-- kg';
        }
      }
    },

    // ─── Dialogs ─────────────────────────────────────────────────

    _showPrintProgressDialog(printer, data) {
      const existing = document.getElementById('optibot-print-result-dialog');
      if (existing) existing.remove();

      const overlay = document.createElement('div');
      overlay.id = 'optibot-print-result-dialog';
      overlay.style.cssText =
        'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:999999;display:flex;align-items:center;justify-content:center;';

      const printerName = printer ? printer.name : '未知';

      overlay.innerHTML = `
        <div style="background:#fff;border-radius:12px;padding:0;min-width:380px;box-shadow:0 8px 32px rgba(0,0,0,0.3);font-family:-apple-system,sans-serif;overflow:hidden;">
          <div style="background:linear-gradient(135deg,#ff9800,#f57c00);color:#fff;padding:16px 24px;font-size:18px;font-weight:bold;">⏳ 正在打印...</div>
          <div style="padding:20px 24px;text-align:center;">
            <div style="margin-bottom:12px;font-size:14px;color:#333;">正在发送 TSPL 指令到打印机</div>
            <div style="font-size:13px;color:#666;margin-bottom:16px;">${printerName}</div>
            <div style="display:inline-block;width:40px;height:40px;border:4px solid #e0e0e0;border-top:4px solid #ff9800;border-radius:50%;animation:optibot-spin 1s linear infinite;"></div>
            <style>@keyframes optibot-spin { to { transform: rotate(360deg); } }</style>
            <div style="margin-top:12px;font-size:12px;color:#999;">TSPL 数据: ${data ? data.length : 0} 字符</div>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);
    },

    _showPrintResultDialog(success, errorMsg, printer, data) {
      const existing = document.getElementById('optibot-print-result-dialog');
      if (existing) existing.remove();

      const overlay = document.createElement('div');
      overlay.id = 'optibot-print-result-dialog';
      overlay.style.cssText =
        'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:999999;display:flex;align-items:center;justify-content:center;';

      const icon = success ? '✅' : '❌';
      const title = success ? '打印成功' : '打印失败';
      const titleBg = success
        ? 'linear-gradient(135deg,#43a047,#2e7d32)'
        : 'linear-gradient(135deg,#e53935,#c62828)';

      const printerInfo = printer
        ? `<div style="margin:8px 0;padding:10px;background:#f5f5f5;border-radius:6px;font-size:13px;">
            <div><b>打印机：</b>${printer.name || '-'}</div>
            <div><b>驱动：</b>${printer.driverName || '-'}</div>
            <div><b>端口：</b>${printer.port || '-'}</div>
           </div>`
        : '<div style="color:#999;margin:8px 0;">无打印机信息</div>';

      const errorInfo = errorMsg
        ? `<div style="margin:8px 0;padding:10px;background:#ffebee;border-radius:6px;color:#c62828;font-size:13px;"><b>错误：</b>${errorMsg}</div>`
        : '';

      const dataPreview = data && data.length > 0
        ? `<details style="margin:8px 0;">
            <summary style="cursor:pointer;font-size:13px;color:#666;">📄 TSPL 指令 (${data.length} 字符)</summary>
            <pre style="margin:8px 0;padding:10px;background:#263238;color:#e0e0e0;border-radius:6px;font-size:11px;max-height:200px;overflow:auto;white-space:pre-wrap;word-break:break-all;">${data.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>
           </details>`
        : '';

      overlay.innerHTML = `
        <div style="background:#fff;border-radius:12px;padding:0;min-width:420px;max-width:550px;box-shadow:0 8px 32px rgba(0,0,0,0.3);font-family:-apple-system,sans-serif;overflow:hidden;">
          <div style="background:${titleBg};color:#fff;padding:16px 24px;font-size:18px;font-weight:bold;display:flex;justify-content:space-between;align-items:center;">
            <span>${icon} ${title}</span>
            <button id="optibot-print-result-close" style="background:rgba(255,255,255,0.2);border:none;color:#fff;width:32px;height:32px;border-radius:50%;font-size:18px;cursor:pointer;display:flex;align-items:center;justify-content:center;">✕</button>
          </div>
          <div style="padding:16px 24px;max-height:450px;overflow-y:auto;">
            ${printerInfo}${errorInfo}${dataPreview}
          </div>
          <div style="padding:12px 24px;background:#f5f5f5;text-align:right;border-top:1px solid #eee;">
            <button id="optibot-print-result-ok" style="background:#1a73e8;color:#fff;border:none;padding:8px 24px;border-radius:6px;font-size:14px;cursor:pointer;">确定</button>
          </div>
        </div>
      `;

      document.body.appendChild(overlay);

      const closeDialog = () => overlay.remove();
      document.getElementById('optibot-print-result-close').onclick = closeDialog;
      document.getElementById('optibot-print-result-ok').onclick = closeDialog;
      overlay.onclick = (e) => { if (e.target === overlay) closeDialog(); };

      if (success) {
        setTimeout(closeDialog, 3000);
      }
    },

    _showPrinterDialog(printers) {
      const existing = document.getElementById('optibot-printer-dialog');
      if (existing) existing.remove();

      const overlay = document.createElement('div');
      overlay.id = 'optibot-printer-dialog';
      overlay.style.cssText =
        'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:999999;display:flex;align-items:center;justify-content:center;';

      let printerHtml;
      if (printers.length === 0) {
        printerHtml =
          '<div style="color:#e74c3c;font-size:15px;padding:16px;text-align:center;">' +
          '❌ 未检测到打印机<br>' +
          '<span style="font-size:12px;color:#999;margin-top:8px;display:block;">请确保打印机驱动已安装并在 Windows 中添加了打印机</span>' +
          '</div>';
      } else {
        printerHtml =
          '<table style="width:100%;border-collapse:collapse;font-size:13px;">' +
          '<thead><tr style="background:#e8f5e9;">' +
          '<th style="padding:6px 10px;text-align:left;border-bottom:2px solid #4caf50;">名称</th>' +
          '<th style="padding:6px 10px;text-align:left;border-bottom:2px solid #4caf50;">驱动</th>' +
          '<th style="padding:6px 10px;text-align:left;border-bottom:2px solid #4caf50;">端口</th>' +
          '</tr></thead><tbody>';
        printers.forEach((p, i) => {
          printerHtml +=
            `<tr style="background:${i % 2 === 0 ? '#fff' : '#f9f9f9'};">` +
            `<td style="padding:6px 10px;border-bottom:1px solid #eee;font-weight:bold;">${p.name || '-'}</td>` +
            `<td style="padding:6px 10px;border-bottom:1px solid #eee;">${p.driverName || '-'}</td>` +
            `<td style="padding:6px 10px;border-bottom:1px solid #eee;">${p.port || '-'}</td>` +
            '</tr>';
        });
        printerHtml += '</tbody></table>';
      }

      overlay.innerHTML = `
        <div style="background:#fff;border-radius:12px;padding:0;min-width:500px;max-width:650px;box-shadow:0 8px 32px rgba(0,0,0,0.3);font-family:-apple-system,sans-serif;overflow:hidden;">
          <div style="background:linear-gradient(135deg,#1a73e8,#1557b0);color:#fff;padding:16px 24px;font-size:18px;font-weight:bold;display:flex;justify-content:space-between;align-items:center;">
            <span>🖨️ TSPL 打印机 (${printers.length} 台)</span>
            <button id="optibot-printer-dialog-close" style="background:rgba(255,255,255,0.2);border:none;color:#fff;width:32px;height:32px;border-radius:50%;font-size:18px;cursor:pointer;display:flex;align-items:center;justify-content:center;">✕</button>
          </div>
          <div style="padding:16px 24px;max-height:500px;overflow-y:auto;">
            <div style="font-weight:bold;font-size:15px;margin-bottom:8px;color:#333;">✅ 已安装的打印机 (TSPL 原始打印)</div>
            ${printerHtml}
            <div style="margin-top:12px;padding:10px;background:#f0f7ff;border-radius:6px;font-size:12px;color:#555;">
              <b>提示：</b>使用 TSPL (TSC 打印机原生语言) 通过 Windows 驱动 RAW 模式发送指令。
              中文使用打印机 Flash 中的 CHN 字体。
            </div>
          </div>
          <div style="padding:12px 24px;background:#f5f5f5;text-align:right;border-top:1px solid #eee;">
            <button id="optibot-printer-dialog-refresh" style="background:#1a73e8;color:#fff;border:none;padding:8px 20px;border-radius:6px;font-size:14px;cursor:pointer;margin-right:8px;">🔄 刷新</button>
            <button id="optibot-printer-dialog-ok" style="background:#e0e0e0;color:#333;border:none;padding:8px 20px;border-radius:6px;font-size:14px;cursor:pointer;">确定</button>
          </div>
        </div>
      `;

      document.body.appendChild(overlay);

      const closeDialog = () => overlay.remove();
      document.getElementById('optibot-printer-dialog-close').onclick = closeDialog;
      document.getElementById('optibot-printer-dialog-ok').onclick = closeDialog;
      overlay.onclick = (e) => { if (e.target === overlay) closeDialog(); };

      document.getElementById('optibot-printer-dialog-refresh').onclick = async () => {
        overlay.remove();
        await this.listPrinters();
      };
    },

    _makeDraggable(el) {
      const container = el.querySelector('div');
      if (!container) return;

      let isDragging = false;
      let startX, startY, initialX, initialY;

      container.addEventListener('mousedown', (e) => {
        isDragging = true;
        startX = e.clientX;
        startY = e.clientY;
        const rect = container.getBoundingClientRect();
        initialX = rect.left;
        initialY = rect.top;
        e.preventDefault();
      });

      document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        container.style.left = initialX + (e.clientX - startX) + 'px';
        container.style.top = initialY + (e.clientY - startY) + 'px';
        container.style.right = 'auto';
        container.style.bottom = 'auto';
      });

      document.addEventListener('mouseup', () => { isDragging = false; });
    },
  };

  // Auto-initialize
  window.OptiBotBridge.init().catch((err) => {
    console.error('[OptiBot Bridge] Init failed:', err);
  });
})();
