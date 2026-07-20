/**
 * Frappe Web Page Bridge Script
 *
 * This script is injected into the Frappe web page after it loads.
 * It provides a Frappe-friendly wrapper around the electronAPI hardware APIs.
 *
 * Printing uses pure JS TSPL generation + Windows Spooler RAW mode.
 * Chinese text uses printer-stored fonts (e.g., SourceHa.TTF, SimsunEx).
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
    version: '3.1.0',

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
        this._updateScaleWeightDialog(data);
        // Log weight data to debug file
        const logLine = `[${new Date().toISOString()}] weight=${data.value} unit=${data.unit} stable=${data.stable} raw=${data.raw}\n`;
        window.electronAPI.app.debugLog(logLine).catch(() => {});
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
      try {
        await window.electronAPI.scale.connect(port, options);
        this.scaleConnected = true;
        this._showScaleDialog(true, `串口 ${port} 连接成功`, null);
      } catch (err) {
        this.scaleConnected = false;
        this._showScaleDialog(false, `串口 ${port} 连接失败`, err.message);
        throw err;
      }
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
     * Print a label by sending a structured config to the main process.
     * The main process generates TSPL commands and sends them via Spooler RAW mode.
     *
     * @param {Object} labelConfig - Structured label configuration
     * @returns {Promise<{success: boolean}>}
     */
    async printLabel(labelConfig) {
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
        this._showPrintResultDialog(false, '没有可用的打印机', null, null);
        throw new Error('No printer available');
      }

      const printer = this.printers.find((p) => p.id === printerId);

      this._showPrintProgressDialog(printer, labelConfig);

      const timeoutMs = 10000;
      try {
        const result = await Promise.race([
          window.electronAPI.printer.printLabelConfig(printerId, labelConfig),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`打印超时 (${timeoutMs / 1000}秒无响应)`)), timeoutMs)
          ),
        ]);
        this._showPrintResultDialog(true, null, printer, null);
        return result;
      } catch (err) {
        this._showPrintResultDialog(false, err.message, printer, null);
        throw err;
      }
    },

    /**
     * Build a structured label configuration from a JSON description.
     * The config is sent to the main process which generates TSPL commands.
     *
     * @param {Object} options
     * @param {number} options.width - Label width in mm
     * @param {number} options.height - Label height in mm
     * @param {number} [options.dpi=203] - Printer DPI
     * @param {number} [options.copies=1] - Number of copies
     * @param {Array} options.elements - Label elements
     * @returns {Object} Structured label configuration for IPC transport
     */
    buildLabelConfig(options) {
      const { width, height, dpi = 203, copies = 1, elements } = options;

      // Normalize elements — ensure all fields are present and properly typed
      const normalizedElements = elements.map((el, i) => {
        console.log(`[OptiBot Bridge] Element ${i}: type=${el.type}, x=${el.x}, y=${el.y}`);

        switch (el.type) {
          case 'text':
          case 'date':
            return {
              type: el.type,
              x: el.x || 0,
              y: el.y || 0,
              content: el.content || '',
              font_size: el.font_size || (el.type === 'date' ? 20 : 24),
              font_width: el.font_width || null,
              bold: !!el.bold,
              rotation: el.rotation || 0,
              chinese: el.chinese,
              font_name: el.font_name || 'SourceHa.TTF',
            };

          case 'barcode':
            return {
              type: 'barcode',
              x: el.x || 0,
              y: el.y || 0,
              content: el.content || '',
              barcodeType: el.barcodeType || '128',
              height: el.height || 60,
              size: el.size || 6,
              gs1: !!el.gs1,
            };

          case 'qrcode':
            return {
              type: 'qrcode',
              x: el.x || 0,
              y: el.y || 0,
              content: el.content || '',
              size: el.size || 6,
              gs1: !!el.gs1,
            };

          case 'line':
            return {
              type: 'line',
              x: el.x || 0,
              y: el.y || 0,
              width: el.width || 50,
              thickness: el.thickness || 2,
            };

          case 'table':
            return {
              type: 'table',
              x: el.x || 0,
              y: el.y || 0,
              columns: el.columns || [],
              cell_overrides: el.cell_overrides || {},
              max_rows: el.max_rows || 6,
              row_height: el.row_height || 6,
              border: el.border !== false,
              border_thickness: el.border_thickness || 2,
              cell_font_size: el.cell_font_size || 16,
              header_font_size: el.header_font_size || 20,
              show_header: el.show_header !== false,
              font_name: el.font_name || 'SourceHa.TTF',
            };

          default:
            console.warn(`[OptiBot Bridge] Unknown element type: ${el.type}`);
            return { type: el.type, x: el.x || 0, y: el.y || 0 };
        }
      });

      return {
        width,
        height,
        dpi,
        copies,
        elements: normalizedElements,
      };
    },

    /**
     * Print a label from a JSON description.
     * Converts JSON → structured config → sends to main process for TSPL generation + RAW printing.
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

        const labelConfig = this.buildLabelConfig(json);
        console.log('[OptiBot Bridge] Built label config:', JSON.stringify(labelConfig).substring(0, 200));
        return await this.printLabel(labelConfig);
      } catch (err) {
        console.error('[OptiBot Bridge] printFromJSON error:', err.message, err.stack);
        this._showPrintResultDialog(false, err.message, null, null);
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
            <div style="margin-bottom:12px;font-size:14px;color:#333;">正在生成 TSPL 指令并发送打印</div>
            <div style="font-size:13px;color:#666;margin-bottom:16px;">${printerName}</div>
            <div style="display:inline-block;width:40px;height:40px;border:4px solid #e0e0e0;border-top:4px solid #ff9800;border-radius:50%;animation:optibot-spin 1s linear infinite;"></div>
            <style>@keyframes optibot-spin { to { transform: rotate(360deg); } }</style>
            <div style="margin-top:12px;font-size:12px;color:#999;">标签元素: ${data && data.elements ? data.elements.length : 0} 个</div>
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

      const dataPreview = data && data.elements && data.elements.length > 0
        ? `<details style="margin:8px 0;">
            <summary style="cursor:pointer;font-size:13px;color:#666;">📄 标签配置 (${data.elements.length} 个元素, ${data.width}×${data.height}mm)</summary>
            <pre style="margin:8px 0;padding:10px;background:#263238;color:#e0e0e0;border-radius:6px;font-size:11px;max-height:200px;overflow:auto;white-space:pre-wrap;word-break:break-all;">${JSON.stringify(data, null, 2).replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>
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
            <span>🖨️ TSC 标签打印机 (${printers.length} 台)</span>
            <button id="optibot-printer-dialog-close" style="background:rgba(255,255,255,0.2);border:none;color:#fff;width:32px;height:32px;border-radius:50%;font-size:18px;cursor:pointer;display:flex;align-items:center;justify-content:center;">✕</button>
          </div>
          <div style="padding:16px 24px;max-height:500px;overflow-y:auto;">
            <div style="font-weight:bold;font-size:15px;margin-bottom:8px;color:#333;">✅ 已安装的打印机 (TSPL 指令打印)</div>
            ${printerHtml}
            <div style="margin-top:12px;padding:10px;background:#f0f7ff;border-radius:6px;font-size:12px;color:#555;">
              <b>提示：</b>通过纯 JS 生成 TSPL 指令，经 Windows Spooler RAW 模式直接打印。
              中文使用打印机内置字库（如 SourceHa.TTF、SimsunEx），在 TEXT 指令中直接引用字库名称。
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

    /**
     * Show scale connection result dialog (success or failure)
     * @param {boolean} success
     * @param {string} message
     * @param {string|null} errorMsg
     * @private
     */
    _showScaleDialog(success, message, errorMsg) {
      const existing = document.getElementById('optibot-scale-dialog');
      if (existing) existing.remove();

      const overlay = document.createElement('div');
      overlay.id = 'optibot-scale-dialog';
      overlay.style.cssText =
        'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:999999;display:flex;align-items:center;justify-content:center;';

      const icon = success ? '✅' : '❌';
      const titleBg = success
        ? 'linear-gradient(135deg,#43a047,#2e7d32)'
        : 'linear-gradient(135deg,#e53935,#c62828)';

      const errorHtml = errorMsg
        ? `<div style="margin:12px 0;padding:10px;background:#ffebee;border-radius:6px;color:#c62828;font-size:13px;"><b>原因：</b>${errorMsg}</div>`
        : '';

      overlay.innerHTML = `
        <div style="background:#fff;border-radius:12px;padding:0;min-width:360px;max-width:450px;box-shadow:0 8px 32px rgba(0,0,0,0.3);font-family:-apple-system,sans-serif;overflow:hidden;">
          <div style="background:${titleBg};color:#fff;padding:16px 24px;font-size:18px;font-weight:bold;display:flex;justify-content:space-between;align-items:center;">
            <span>${icon} 电子秤连接</span>
            <button id="optibot-scale-dialog-close" style="background:rgba(255,255,255,0.2);border:none;color:#fff;width:32px;height:32px;border-radius:50%;font-size:18px;cursor:pointer;display:flex;align-items:center;justify-content:center;">✕</button>
          </div>
          <div style="padding:16px 24px;">
            <div style="font-size:15px;color:#333;">${message}</div>
            ${errorHtml}
          </div>
          <div style="padding:12px 24px;background:#f5f5f5;text-align:right;border-top:1px solid #eee;">
            <button id="optibot-scale-dialog-ok" style="background:#1a73e8;color:#fff;border:none;padding:8px 24px;border-radius:6px;font-size:14px;cursor:pointer;">确定</button>
          </div>
        </div>
      `;

      document.body.appendChild(overlay);

      const closeDialog = () => overlay.remove();
      document.getElementById('optibot-scale-dialog-close').onclick = closeDialog;
      document.getElementById('optibot-scale-dialog-ok').onclick = closeDialog;
      overlay.onclick = (e) => { if (e.target === overlay) closeDialog(); };

      // Auto-close success after 3 seconds
      if (success) setTimeout(closeDialog, 3000);
    },

    /**
     * Update or create a floating weight dialog showing current weight
     * @param {Object} data - Weight data { value, unit, stable, raw }
     * @private
     */
    _updateScaleWeightDialog(data) {
      let dialog = document.getElementById('optibot-weight-dialog');

      if (!dialog) {
        dialog = document.createElement('div');
        dialog.id = 'optibot-weight-dialog';
        dialog.style.cssText =
          'position:fixed;top:20px;right:20px;background:#fff;border-radius:12px;box-shadow:0 4px 24px rgba(0,0,0,0.2);z-index:999998;min-width:200px;font-family:-apple-system,sans-serif;overflow:hidden;';

        dialog.innerHTML = `
          <div style="background:linear-gradient(135deg,#1a73e8,#1557b0);color:#fff;padding:10px 16px;font-size:14px;font-weight:bold;display:flex;justify-content:space-between;align-items:center;">
            <span>⚖️ 电子秤重量</span>
            <button id="optibot-weight-dialog-close" style="background:rgba(255,255,255,0.2);border:none;color:#fff;width:24px;height:24px;border-radius:50%;font-size:14px;cursor:pointer;display:flex;align-items:center;justify-content:center;">✕</button>
          </div>
          <div style="padding:16px;text-align:center;">
            <div id="optibot-weight-dialog-value" style="font-size:32px;font-weight:bold;color:#333;">-- kg</div>
            <div id="optibot-weight-dialog-status" style="font-size:12px;color:#999;margin-top:6px;">等待数据...</div>
          </div>
        `;

        document.body.appendChild(dialog);

        // Close handler: hide dialog but keep receiving data
        document.getElementById('optibot-weight-dialog-close').onclick = () => {
          dialog.style.display = 'none';
        };

        // Make draggable
        this._makeDraggable(dialog);
      }

      dialog.style.display = '';

      // Update values
      const valueEl = document.getElementById('optibot-weight-dialog-value');
      const statusEl = document.getElementById('optibot-weight-dialog-status');

      if (valueEl) {
        valueEl.textContent = `${data.value} ${data.unit || 'kg'}`;
        valueEl.style.color = data.stable ? '#2e7d32' : '#f57c00';
      }

      if (statusEl) {
        statusEl.textContent = data.stable ? '✓ 稳定' : '○ 读取中...';
        statusEl.style.color = data.stable ? '#4caf50' : '#ff9800';
      }
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
