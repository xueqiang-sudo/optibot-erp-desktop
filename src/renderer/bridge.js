/**
 * Frappe Web Page Bridge Script
 *
 * This script is injected into the Frappe web page after it loads.
 * It provides a Frappe-friendly wrapper around the electronAPI hardware APIs.
 *
 * Note: This file is optional - the preload script already exposes
 * window.electronAPI. This bridge adds Frappe-specific convenience methods
 * and UI elements (like a floating weight widget).
 *
 * To use: Inject via mainWindow.webContents.executeJavaScript() or
 * include as a custom Frappe Client Script.
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
    version: '1.0.0',

    // Current weight value
    currentWeight: null,

    // Scale connection status
    scaleConnected: false,

    // Printer list
    printers: [],

    // Currently selected default printer (set via setPrinter)
    currentPrinter: null,

    /**
     * Initialize the bridge: connect scale, discover printers
     */
    async init() {
      // Load saved config
      const config = await window.electronAPI.app.getConfig();

      // Auto-connect scale if configured
      if (config.autoConnectScale && config.lastScalePort) {
        try {
          await this.connectScale(config.lastScalePort, config.lastScaleOptions);
        } catch (err) {
          console.warn('[OptiBot Bridge] Auto-connect scale failed:', err);
        }
      }

      // Discover printers
      try {
        await this.listPrinters();
        console.log(
          '[OptiBot Bridge] Printers found:',
          this.printers.length
        );
      } catch (err) {
        console.warn('[OptiBot Bridge] Printer discovery failed:', err);
      }

      // Set up weight listener
      window.electronAPI.scale.onWeight((data) => {
        this.currentWeight = data;
        this._updateWeightWidget();
        // Dispatch custom event for other scripts to listen
        window.dispatchEvent(
          new CustomEvent('optibot:weight', { detail: data })
        );
      });

      window.electronAPI.scale.onStatus((status) => {
        this.scaleConnected = status.connected;
        this._updateWeightWidget();
        window.dispatchEvent(
          new CustomEvent('optibot:scale-status', { detail: status })
        );
      });

      console.log('[OptiBot Bridge] Initialized');
    },

    /**
     * Connect to electronic scale
     * @param {string} port - Serial port path
     * @param {Object} [options] - Serial port options
     * @param {number} [options.baudRate=9600] - Baud rate
     * @param {number} [options.dataBits=8] - Data bits
     * @param {string} [options.parity='none'] - Parity
     * @param {number} [options.stopBits=1] - Stop bits
     */
    async connectScale(port, options) {
      await window.electronAPI.scale.connect(port, options);
      this.scaleConnected = true;
    },

    /**
     * Disconnect electronic scale
     */
    async disconnectScale() {
      await window.electronAPI.scale.disconnect();
      this.scaleConnected = false;
    },

    /**
     * Get current weight value
     * @returns {number|null} Weight in kg
     */
    getWeight() {
      return this.currentWeight ? this.currentWeight.value : null;
    },

    // ─── Printer Management ─────────────────────────────────────

    /**
     * List all available USB printers and refresh the internal list.
     * If a default printer was previously set and is still online, it is kept.
     * @returns {Promise<Array<{id: string, name: string, manufacturer: string, product: string, serialNumber: string, port: string, vid: string, pid: string}>>}
     */
    async listPrinters() {
      this.printers = await window.electronAPI.printer.listPrinters();

      // Keep current printer selection if it is still available
      if (this.currentPrinter) {
        const stillHere = this.printers.find(
          (p) => p.id === this.currentPrinter.id
        );
        if (stillHere) {
          this.currentPrinter = stillHere; // update to latest info
        } else {
          this.currentPrinter = null; // printer went offline
          console.warn(
            '[OptiBot Bridge] Selected printer no longer available'
          );
        }
      }

      // Fetch all USB devices for diagnostic dialog
      let allUsbDevices = [];
      try {
        allUsbDevices = await window.electronAPI.printer.listAllUSBDevices();
      } catch (e) {
        console.warn('[OptiBot Bridge] Failed to list USB devices:', e);
      }

      // Show debug dialog with printer list + all USB devices
      this._showPrinterDialog(this.printers, allUsbDevices);

      return this.printers;
    },

    /**
     * Set the default printer for subsequent printLabel() calls.
     * @param {string} printerId - Printer ID from listPrinters() (e.g. "1fc9:2016")
     * @returns {Object} The selected printer info
     * @throws {Error} If the printerId is not found in the current list
     */
    async setPrinter(printerId) {
      // Refresh list if empty
      if (this.printers.length === 0) {
        await this.listPrinters();
      }

      const printer = this.printers.find((p) => p.id === printerId);
      if (!printer) {
        const available = this.printers.map((p) => p.id).join(', ');
        throw new Error(
          `Printer "${printerId}" not found. Available: ${available || 'none'}`
        );
      }

      this.currentPrinter = printer;
      console.log(
        `[OptiBot Bridge] Default printer set: ${printer.name} (${printer.id})`
      );
      return printer;
    },

    /**
     * Get the currently selected default printer.
     * @returns {Object|null} Printer info or null if not set
     */
    getPrinter() {
      return this.currentPrinter;
    },

    /**
     * Print a label with Chinese text support.
     * Uses the previously set default printer (via setPrinter).
     * Falls back to the first available printer if none was set.
     *
     * @param {string} zplData - ZPL string (use ^ACN for Chinese, ^A0N for English)
     * @returns {Promise<{success: boolean}>}
     * @throws {Error} If no printer is available
     */
    async printLabel(zplData) {
      let printerId = this.currentPrinter ? this.currentPrinter.id : null;

      // Fallback: pick first available printer
      if (!printerId) {
        if (this.printers.length === 0) {
          await this.listPrinters();
        }
        if (this.printers.length > 0) {
          printerId = this.printers[0].id;
        }
      }

      if (!printerId) {
        this._showPrintResultDialog(false, '没有可用的打印机', null, zplData);
        throw new Error('No printer available');
      }

      const printer = this.printers.find((p) => p.id === printerId);

      // Show "printing..." dialog immediately
      this._showPrintProgressDialog(printer, zplData);

      // Add timeout: 10 seconds max
      const timeoutMs = 10000;
      try {
        const result = await Promise.race([
          window.electronAPI.printer.printZPL(printerId, zplData),
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error(`打印超时 (${timeoutMs / 1000}秒无响应)`)),
              timeoutMs
            )
          ),
        ]);
        this._showPrintResultDialog(true, null, printer, zplData);
        return result;
      } catch (err) {
        this._showPrintResultDialog(false, err.message, printer, zplData);
        throw err;
      }
    },

    /**
     * Create a ZPL label from a JSON description.
     *
     * Supported element types:
     *  - text:    { type:'text', x, y, content, fontSize, fontWidth, chinese, bold, rotation }
     *  - barcode: { type:'barcode', x, y, content, barcodeType, height, size }
     *  - qrcode:  { type:'qrcode', x, y, content, size, gs1 }
     *  - line:    { type:'line', x, y, width, thickness }
     *  - date:    { type:'date', x, y, content, font_size, chinese, bold, rotation }
     *  - table:   { type:'table', x, y, columns, cell_overrides, max_rows, row_height,
     *               border, border_thickness, header_font_size, cell_font_size,
     *               chinese, show_header }
     *
     * @param {Object} options
     * @param {number} options.width - Label width in mm
     * @param {number} options.height - Label height in mm
     * @param {number} [options.dpi=203] - Printer DPI
     * @param {number} [options.copies=1] - Number of copies
     * @param {Array} options.elements - Label elements
     * @param {Array} [options.variables] - Variable definitions for placeholder substitution
     * @returns {string} Complete ZPL string
     */
    buildZPL(options) {
      const { width, height, dpi = 203, copies = 1, elements } = options;
      const dotsPerMM = dpi / 25.4;
      const widthDots = Math.round(width * dotsPerMM);
      const heightDots = Math.round(height * dotsPerMM);

      let zpl = '^XA\n';
      zpl += `^PW${widthDots}\n`;
      zpl += `^LL${heightDots}\n`;

      for (const el of elements) {
        const x = Math.round((el.x || 0) * dotsPerMM);
        const y = Math.round((el.y || 0) * dotsPerMM);

        switch (el.type) {
          case 'text':
            zpl += this._zplText(el, x, y);
            break;

          case 'date':
            zpl += this._zplText(
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
              const size = el.size || 4;
              zpl += `^FO${x},${y}^BQN,2,${size}^FD${el.content || ''}^FS\n`;
            } else {
              const h = el.height || 60;
              zpl += `^FO${x},${y}^BCN,${h},Y,N,N^FD${el.content || ''}^FS\n`;
            }
            break;

          case 'qrcode': {
            const size = el.size || 4;
            let content = el.content || '';
            // GS1 QR code: prepend FNC1 (^FD>8)
            if (el.gs1) {
              content = '>8' + content;
            }
            zpl += `^FO${x},${y}^BQN,2,${size}^FD${content}^FS\n`;
            break;
          }

          case 'line': {
            const lineW = Math.round((el.width || 50) * dotsPerMM);
            const thickness = el.thickness || 2;
            zpl += `^FO${x},${y}^GB${lineW},${thickness},${thickness},B^FS\n`;
            break;
          }

          case 'table':
            zpl += this._zplTable(el, x, y, dotsPerMM);
            break;

          default:
            console.warn(`[OptiBot Bridge] Unknown element type: ${el.type}`);
        }
      }

      if (copies > 1) {
        zpl += `^PQ${copies}\n`;
      }

      zpl += '^XZ';
      return zpl;
    },

    /**
     * Generate ZPL for a text element
     * @private
     */
    _zplText(el, x, y) {
      const h = el.fontSize || 24;
      const w = el.fontWidth || h;
      const content = el.content || '';

      // Rotation: 0=N, 1=R(90°), 2=I(180°), 3=B(270°)
      const rotMap = { 0: 'N', 90: 'R', 180: 'I', 270: 'B' };
      const rot = rotMap[el.rotation] || 'N';

      if (el.chinese) {
        return `^FO${x},${y}^AC${rot},${h},${w}^FD${content}^FS\n`;
      } else {
        return `^FO${x},${y}^A0${rot},${h},${w}^FD${content}^FS\n`;
      }
    },

    /**
     * Generate ZPL for a table element.
     * Renders cell text and optional border grid lines.
     *
     * @private
     */
    _zplTable(el, tableX, tableY, dotsPerMM) {
      let zpl = '';
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
      const fontChar = chinese ? 'C' : '0';

      // Calculate column widths in dots
      const colWidthsDots = columns.map((col) =>
        Math.round((col.width || 20) * dotsPerMM)
      );
      const totalTableWidthDots = colWidthsDots.reduce((s, w) => s + w, 0);
      const totalTableHeightDots = rowHeightDots * maxRows;

      // ── Draw border grid ──
      if (border) {
        // Outer border
        zpl += `^FO${tableX},${tableY}^GB${totalTableWidthDots},${totalTableHeightDots},${borderThickness},B^FS\n`;

        // Horizontal lines between rows
        for (let r = 1; r < maxRows; r++) {
          const ly = tableY + r * rowHeightDots;
          zpl += `^FO${tableX},${ly}^GB${totalTableWidthDots},${borderThickness},${borderThickness},B^FS\n`;
        }

        // Vertical lines between columns
        let cx = tableX;
        for (let c = 1; c < columns.length; c++) {
          cx += colWidthsDots[c - 1];
          zpl += `^FO${cx},${tableY}^GB${borderThickness},${totalTableHeightDots},${borderThickness},B^FS\n`;
        }
      }

      // ── Draw header row (if enabled) ──
      if (showHeader) {
        let hx = tableX;
        for (let c = 0; c < columns.length; c++) {
          if (columns[c].header) {
            const textX = hx + 2;
            const textY = tableY + 2;
            const align = columns[c].align || 'left';
            const offsetX =
              align === 'center'
                ? Math.max(0, Math.round((colWidthsDots[c] - headerFontSize * columns[c].header.length * 0.6) / 2))
                : align === 'right'
                  ? Math.max(0, colWidthsDots[c] - headerFontSize * columns[c].header.length - 4)
                  : 0;
            zpl += `^FO${textX + offsetX},${textY}^A${fontChar}N,${headerFontSize},${headerFontSize}^FD${columns[c].header}^FS\n`;
          }
          hx += colWidthsDots[c];
        }
      }

      // ── Draw cell content ──
      for (let r = 0; r < maxRows; r++) {
        const cellY = tableY + r * rowHeightDots;
        // Vertical centering: offset text by (rowHeight - fontSize) / 2
        const textOffsetY = Math.max(1, Math.round((rowHeightDots - cellFontSize) / 2));

        let cellX = tableX;
        for (let c = 0; c < columns.length; c++) {
          const key = `${r},${c}`;
          const override = cellOverrides[key];
          const content = override ? override.content || '' : '';

          if (content) {
            const align = columns[c].align || 'left';
            // Estimate text width: each char ≈ fontSize * 0.6 dots (rough)
            const charWidth = cellFontSize * 0.6;
            const textWidthDots = content.length * charWidth;
            const cellW = colWidthsDots[c];

            let offsetX;
            if (align === 'center') {
              offsetX = Math.max(2, Math.round((cellW - textWidthDots) / 2));
            } else if (align === 'right') {
              offsetX = Math.max(2, cellW - textWidthDots - 4);
            } else {
              offsetX = 2;
            }

            zpl += `^FO${cellX + offsetX},${cellY + textOffsetY}^A${fontChar}N,${cellFontSize},${cellFontSize}^FD${content}^FS\n`;
          }

          cellX += colWidthsDots[c];
        }
      }

      return zpl;
    },

    /**
     * Print a label from a JSON description.
     * Converts JSON → ZPL → sends to printer.
     *
     * @param {Object} json - Label definition (see buildZPL for schema)
     * @returns {Promise<{success: boolean}>}
     * @throws {Error} If no printer available or print fails
     */
    async printFromJSON(json) {
      const zplData = this.buildZPL(json);
      console.log('[OptiBot Bridge] Generated ZPL:\n', zplData);
      return await this.printLabel(zplData);
    },

    // ─── Weight Widget ───────────────────────────────────────────

    /**
     * Show a floating weight widget on the page
     */
    showWeightWidget() {
      if (document.getElementById('optibot-weight-widget')) {
        return; // Already exists
      }

      const widget = document.createElement('div');
      widget.id = 'optibot-weight-widget';
      widget.innerHTML = `
        <div style="
          position: fixed;
          bottom: 20px;
          right: 20px;
          background: #1a73e8;
          color: white;
          padding: 12px 20px;
          border-radius: 8px;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          font-size: 18px;
          font-weight: bold;
          box-shadow: 0 4px 12px rgba(0,0,0,0.3);
          z-index: 99999;
          cursor: move;
          user-select: none;
          display: flex;
          align-items: center;
          gap: 10px;
        ">
          <span style="font-size: 14px; opacity: 0.8;">⚖️</span>
          <span id="optibot-weight-value">-- kg</span>
          <span id="optibot-weight-status" style="
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background: #ccc;
          "></span>
        </div>
      `;
      document.body.appendChild(widget);

      // Make draggable
      this._makeDraggable(widget);
    },

    /**
     * Hide the weight widget
     */
    hideWeightWidget() {
      const widget = document.getElementById('optibot-weight-widget');
      if (widget) {
        widget.remove();
      }
    },

    /**
     * Update the weight widget display
     * @private
     */
    _updateWeightWidget() {
      const valueEl = document.getElementById('optibot-weight-value');
      const statusEl = document.getElementById('optibot-weight-status');

      if (valueEl && this.currentWeight) {
        valueEl.textContent = `${this.currentWeight.value.toFixed(2)} kg`;
      }

      if (statusEl) {
        if (this.scaleConnected) {
          statusEl.style.background =
            this.currentWeight && this.currentWeight.stable
              ? '#4caf50'
              : '#ffc107';
        } else {
          statusEl.style.background = '#ccc';
          if (valueEl) valueEl.textContent = '-- kg';
        }
      }
    },

    /**
     * Show "printing in progress" dialog
     * @param {Object|null} printer
     * @param {string} zplData
     * @private
     */
    _showPrintProgressDialog(printer, zplData) {
      const existing = document.getElementById('optibot-print-result-dialog');
      if (existing) existing.remove();

      const overlay = document.createElement('div');
      overlay.id = 'optibot-print-result-dialog';
      overlay.style.cssText =
        'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:999999;display:flex;align-items:center;justify-content:center;';

      const printerName = printer ? `${printer.name} (${printer.id})` : '未知';

      overlay.innerHTML = `
        <div style="
          background:#fff;
          border-radius:12px;
          padding:0;
          min-width:380px;
          box-shadow:0 8px 32px rgba(0,0,0,0.3);
          font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
          overflow:hidden;
        ">
          <div style="
            background:linear-gradient(135deg,#ff9800,#f57c00);
            color:#fff;
            padding:16px 24px;
            font-size:18px;
            font-weight:bold;
          ">
            ⏳ 正在打印...
          </div>
          <div style="padding:20px 24px;text-align:center;">
            <div style="margin-bottom:12px;font-size:14px;color:#333;">
              正在发送 ZPL 指令到打印机
            </div>
            <div style="font-size:13px;color:#666;margin-bottom:16px;">
              ${printerName}
            </div>
            <div style="
              display:inline-block;
              width:40px;height:40px;
              border:4px solid #e0e0e0;
              border-top:4px solid #ff9800;
              border-radius:50%;
              animation:optibot-spin 1s linear infinite;
            "></div>
            <style>
              @keyframes optibot-spin { to { transform: rotate(360deg); } }
            </style>
            <div style="margin-top:12px;font-size:12px;color:#999;">
              ZPL 数据: ${zplData ? zplData.length : 0} 字符
            </div>
          </div>
        </div>
      `;

      document.body.appendChild(overlay);
    },

    /**
     * Show print result dialog (success or failure)
     * @param {boolean} success
     * @param {string|null} errorMsg
     * @param {Object|null} printer - Printer info
     * @param {string} zplData - The ZPL that was sent
     * @private
     */
    _showPrintResultDialog(success, errorMsg, printer, zplData) {
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
            <div><b>ID：</b><span style="font-family:monospace;color:#1a73e8;">${printer.id}</span></div>
            <div><b>端口：</b>${printer.port || '-'}</div>
           </div>`
        : '<div style="color:#999;margin:8px 0;">无打印机信息</div>';

      const errorInfo = errorMsg
        ? `<div style="margin:8px 0;padding:10px;background:#ffebee;border-radius:6px;color:#c62828;font-size:13px;">
            <b>错误：</b>${errorMsg}
           </div>`
        : '';

      // ZPL preview (truncated)
      const zplPreview =
        zplData && zplData.length > 0
          ? `<details style="margin:8px 0;">
              <summary style="cursor:pointer;font-size:13px;color:#666;">📄 ZPL 指令 (${zplData.length} 字符)</summary>
              <pre style="margin:8px 0;padding:10px;background:#263238;color:#e0e0e0;border-radius:6px;font-size:11px;max-height:200px;overflow:auto;white-space:pre-wrap;word-break:break-all;">${zplData.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>
             </details>`
          : '';

      overlay.innerHTML = `
        <div style="
          background:#fff;
          border-radius:12px;
          padding:0;
          min-width:420px;
          max-width:550px;
          box-shadow:0 8px 32px rgba(0,0,0,0.3);
          font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
          overflow:hidden;
        ">
          <div style="
            background:${titleBg};
            color:#fff;
            padding:16px 24px;
            font-size:18px;
            font-weight:bold;
            display:flex;
            justify-content:space-between;
            align-items:center;
          ">
            <span>${icon} ${title}</span>
            <button id="optibot-print-result-close" style="
              background:rgba(255,255,255,0.2);
              border:none;
              color:#fff;
              width:32px;
              height:32px;
              border-radius:50%;
              font-size:18px;
              cursor:pointer;
              display:flex;
              align-items:center;
              justify-content:center;
            ">✕</button>
          </div>
          <div style="padding:16px 24px;max-height:450px;overflow-y:auto;">
            ${printerInfo}
            ${errorInfo}
            ${zplPreview}
          </div>
          <div style="
            padding:12px 24px;
            background:#f5f5f5;
            text-align:right;
            border-top:1px solid #eee;
          ">
            <button id="optibot-print-result-ok" style="
              background:#1a73e8;
              color:#fff;
              border:none;
              padding:8px 24px;
              border-radius:6px;
              font-size:14px;
              cursor:pointer;
            ">确定</button>
          </div>
        </div>
      `;

      document.body.appendChild(overlay);

      const closeDialog = () => overlay.remove();
      document.getElementById('optibot-print-result-close').onclick =
        closeDialog;
      document.getElementById('optibot-print-result-ok').onclick =
        closeDialog;
      overlay.onclick = (e) => {
        if (e.target === overlay) closeDialog();
      };

      // Auto-close success after 3 seconds
      if (success) {
        setTimeout(closeDialog, 3000);
      }
    },

    /**
     * Show a dialog listing discovered printers + all USB devices (for debugging)
     * @param {Array} printers - Matched printers
     * @param {Array} allUsbDevices - All USB devices for diagnostics
     * @private
     */
    _showPrinterDialog(printers, allUsbDevices) {
      // Remove existing dialog if any
      const existing = document.getElementById('optibot-printer-dialog');
      if (existing) existing.remove();

      const overlay = document.createElement('div');
      overlay.id = 'optibot-printer-dialog';
      overlay.style.cssText =
        'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:999999;display:flex;align-items:center;justify-content:center;';

      // Printer section
      let printerHtml;
      if (printers.length === 0) {
        printerHtml =
          '<div style="color:#e74c3c;font-size:15px;padding:16px;text-align:center;">' +
          '❌ 未检测到打印机</div>';
      } else {
        printerHtml =
          '<table style="width:100%;border-collapse:collapse;font-size:13px;">' +
          '<thead><tr style="background:#e8f5e9;">' +
          '<th style="padding:6px 10px;text-align:left;border-bottom:2px solid #4caf50;">名称</th>' +
          '<th style="padding:6px 10px;text-align:left;border-bottom:2px solid #4caf50;">ID</th>' +
          '<th style="padding:6px 10px;text-align:left;border-bottom:2px solid #4caf50;">制造商</th>' +
          '<th style="padding:6px 10px;text-align:left;border-bottom:2px solid #4caf50;">端口</th>' +
          '</tr></thead><tbody>';
        printers.forEach((p, i) => {
          printerHtml +=
            `<tr style="background:${i % 2 === 0 ? '#fff' : '#f9f9f9'};">` +
            `<td style="padding:6px 10px;border-bottom:1px solid #eee;font-weight:bold;">${p.name || '-'}</td>` +
            `<td style="padding:6px 10px;border-bottom:1px solid #eee;font-family:monospace;color:#1a73e8;">${p.id}</td>` +
            `<td style="padding:6px 10px;border-bottom:1px solid #eee;">${p.manufacturer || '-'}</td>` +
            `<td style="padding:6px 10px;border-bottom:1px solid #eee;">${p.port || '-'}</td>` +
            '</tr>';
        });
        printerHtml += '</tbody></table>';
      }

      // All USB devices section (collapsible)
      let usbHtml = '';
      if (allUsbDevices && allUsbDevices.length > 0) {
        usbHtml =
          '<details style="margin-top:12px;">' +
          `<summary style="cursor:pointer;font-weight:bold;font-size:14px;color:#666;padding:8px 0;">` +
          `🔌 所有 USB 设备 (${allUsbDevices.length} 个) — 点击展开</summary>` +
          '<div style="max-height:250px;overflow-y:auto;margin-top:8px;">' +
          '<table style="width:100%;border-collapse:collapse;font-size:12px;">' +
          '<thead><tr style="background:#e3f2fd;">' +
          '<th style="padding:5px 8px;text-align:left;border-bottom:1px solid #90caf9;">VID:PID</th>' +
          '<th style="padding:5px 8px;text-align:left;border-bottom:1px solid #90caf9;">设备类</th>' +
          '<th style="padding:5px 8px;text-align:left;border-bottom:1px solid #90caf9;">接口</th>' +
          '<th style="padding:5px 8px;text-align:left;border-bottom:1px solid #90caf9;">Bus/Addr</th>' +
          '</tr></thead><tbody>';
        allUsbDevices.forEach((d, i) => {
          if (d.error) {
            usbHtml += `<tr><td colspan="4" style="padding:5px 8px;color:#e74c3c;">${d.error}</td></tr>`;
            return;
          }
          const ifaceStr = Array.isArray(d.interfaces)
            ? d.interfaces
                .map((iface) =>
                  Array.isArray(iface)
                    ? iface.map((a) => a.class || a.error || '?').join(',')
                    : iface.class || iface.error || '?'
                )
                .join('; ')
            : '-';
          const isPrinterClass = ifaceStr.includes('0x7');
          usbHtml +=
            `<tr style="background:${isPrinterClass ? '#fff3e0' : i % 2 === 0 ? '#fff' : '#f9f9f9'};">` +
            `<td style="padding:5px 8px;border-bottom:1px solid #eee;font-family:monospace;font-weight:bold;">${d.id}</td>` +
            `<td style="padding:5px 8px;border-bottom:1px solid #eee;font-family:monospace;">${d.deviceClass}</td>` +
            `<td style="padding:5px 8px;border-bottom:1px solid #eee;font-family:monospace;font-size:11px;">${ifaceStr}</td>` +
            `<td style="padding:5px 8px;border-bottom:1px solid #eee;">${d.busNumber}/${d.deviceAddress}</td>` +
            '</tr>';
        });
        usbHtml += '</tbody></table></div></details>';
      } else {
        usbHtml =
          '<div style="color:#999;font-size:13px;padding:8px;">无 USB 设备信息</div>';
      }

      overlay.innerHTML = `
        <div style="
          background:#fff;
          border-radius:12px;
          padding:0;
          min-width:550px;
          max-width:750px;
          box-shadow:0 8px 32px rgba(0,0,0,0.3);
          font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
          overflow:hidden;
        ">
          <div style="
            background:linear-gradient(135deg,#1a73e8,#1557b0);
            color:#fff;
            padding:16px 24px;
            font-size:18px;
            font-weight:bold;
            display:flex;
            justify-content:space-between;
            align-items:center;
          ">
            <span>🖨️ 打印机诊断 (${printers.length} 台打印机 / ${allUsbDevices ? allUsbDevices.length : 0} 个USB设备)</span>
            <button id="optibot-printer-dialog-close" style="
              background:rgba(255,255,255,0.2);
              border:none;
              color:#fff;
              width:32px;
              height:32px;
              border-radius:50%;
              font-size:18px;
              cursor:pointer;
              display:flex;
              align-items:center;
              justify-content:center;
            ">✕</button>
          </div>
          <div style="padding:16px 24px;max-height:500px;overflow-y:auto;">
            <div style="font-weight:bold;font-size:15px;margin-bottom:8px;color:#333;">
              ✅ 识别到的打印机
            </div>
            ${printerHtml}
            ${usbHtml}
          </div>
          <div style="
            padding:12px 24px;
            background:#f5f5f5;
            text-align:right;
            border-top:1px solid #eee;
          ">
            <button id="optibot-printer-dialog-refresh" style="
              background:#1a73e8;
              color:#fff;
              border:none;
              padding:8px 20px;
              border-radius:6px;
              font-size:14px;
              cursor:pointer;
              margin-right:8px;
            ">🔄 刷新</button>
            <button id="optibot-printer-dialog-ok" style="
              background:#e0e0e0;
              color:#333;
              border:none;
              padding:8px 20px;
              border-radius:6px;
              font-size:14px;
              cursor:pointer;
            ">确定</button>
          </div>
        </div>
      `;

      document.body.appendChild(overlay);

      // Close handlers
      const closeDialog = () => overlay.remove();
      document.getElementById('optibot-printer-dialog-close').onclick =
        closeDialog;
      document.getElementById('optibot-printer-dialog-ok').onclick =
        closeDialog;
      overlay.onclick = (e) => {
        if (e.target === overlay) closeDialog();
      };

      // Refresh handler
      document.getElementById('optibot-printer-dialog-refresh').onclick =
        async () => {
          overlay.remove();
          await this.listPrinters();
        };
    },

    /**
     * Make an element draggable
     * @private
     */
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
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        container.style.left = initialX + dx + 'px';
        container.style.top = initialY + dy + 'px';
        container.style.right = 'auto';
        container.style.bottom = 'auto';
      });

      document.addEventListener('mouseup', () => {
        isDragging = false;
      });
    },
  };

  // Auto-initialize
  window.OptiBotBridge.init().catch((err) => {
    console.error('[OptiBot Bridge] Init failed:', err);
  });
})();
