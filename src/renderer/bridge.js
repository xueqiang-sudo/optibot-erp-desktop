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
        throw new Error('No printer available');
      }

      return await window.electronAPI.printer.printZPL(printerId, zplData);
    },

    /**
     * Create a ZPL label template with Chinese text support
     *
     * @param {Object} options
     * @param {number} options.width - Label width in mm
     * @param {number} options.height - Label height in mm
     * @param {number} [options.dpi=203] - Printer DPI
     * @param {Array} options.elements - Label elements
     * @returns {string} Complete ZPL string
     */
    buildZPL(options) {
      const { width, height, dpi = 203, elements } = options;
      const dotsPerMM = dpi / 25.4;
      const widthDots = Math.round(width * dotsPerMM);
      const heightDots = Math.round(height * dotsPerMM);

      let zpl = '^XA\n';
      zpl += `^PW${widthDots}\n`;
      zpl += `^LL${heightDots}\n`;

      for (const el of elements) {
        const x = Math.round(el.x * dotsPerMM);
        const y = Math.round(el.y * dotsPerMM);

        if (el.type === 'text') {
          const h = el.fontSize || 24;
          const w = el.fontWidth || h;

          if (el.chinese) {
            // Chinese text: use font code C
            zpl += `^FO${x},${y}^ACN,${h},${w}^FD${el.content}^FS\n`;
          } else {
            // English text: use built-in font A0
            zpl += `^FO${x},${y}^A0N,${h},${w}^FD${el.content}^FS\n`;
          }
        } else if (el.type === 'barcode') {
          const h = el.height || 60;
          if (el.barcodeType === 'QR') {
            zpl += `^FO${x},${y}^BQN,2,4^FD${el.content}^FS\n`;
          } else {
            // Default to Code128
            zpl += `^FO${x},${y}^BCN,${h},Y,N,N^FD${el.content}^FS\n`;
          }
        }
      }

      zpl += '^XZ';
      return zpl;
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
