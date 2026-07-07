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

    /**
     * Initialize the bridge: connect scale, discover printers
     */
    async init() {
      // Load saved config
      const config = await window.electronAPI.app.getConfig();

      // Auto-connect scale if configured
      if (config.autoConnectScale && config.lastScalePort) {
        try {
          await this.connectScale(config.lastScalePort);
        } catch (err) {
          console.warn('[OptiBot Bridge] Auto-connect scale failed:', err);
        }
      }

      // Discover printers
      try {
        this.printers = await window.electronAPI.printer.listPrinters();
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
     */
    async connectScale(port) {
      await window.electronAPI.scale.connect(port);
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

    /**
     * Print a label with Chinese text support
     *
     * @param {string} zplData - ZPL string (use ^ACN for Chinese, ^A0N for English)
     * @param {string} [printerId] - Printer ID (defaults to first available)
     * @returns {Promise<{success: boolean}>}
     */
    async printLabel(zplData, printerId) {
      if (!printerId && this.printers.length > 0) {
        printerId = this.printers[0].id;
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
