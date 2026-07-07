/**
 * Label Printer Service - TSC TE344 USB Communication
 *
 * Sends ZPL commands to the TSC TE344 label printer via USB.
 * Handles USB device enumeration, hot-plug detection, and raw data transfer.
 *
 * Important:
 * - ZPL strings are sent as UTF-8 encoded buffers to support Chinese text
 * - Font code 'C' must be pre-loaded via FontPreloader before using ^AC in ZPL
 * - USB bulk transfer endpoint is used for data output
 */

const { EventEmitter } = require('events');
const usb = require('usb');
const log = require('electron-log');

// Known TSC printer USB Vendor/Product IDs
// These may need to be updated based on actual device enumeration
// TSC Auto ID Technology Co., Ltd typical VID: 0x1FC9 or similar
const TSC_USB_IDENTIFIERS = [
  // Add known VID/PID pairs here
  // { vid: 0x1FC9, pid: 0x2016, name: 'TSC TE344' },
];

// USB device class for printers
const USB_CLASS_PRINTER = 0x07;

class PrinterService extends EventEmitter {
  constructor() {
    super();

    this.fontPreloader = null;
    this.knownPrinters = new Map(); // deviceId → { vid, pid, name, serialNumber }
    this.usbWatcherActive = false;

    // Bind methods
    this._onUSBAttach = this._onUSBAttach.bind(this);
    this._onUSBDetach = this._onUSBDetach.bind(this);
  }

  /**
   * Set the font preloader instance
   * @param {FontPreloader} fontPreloader
   */
  setFontPreloader(fontPreloader) {
    this.fontPreloader = fontPreloader;
  }

  /**
   * Initialize USB hot-plug watcher
   */
  initUSBWatcher() {
    if (this.usbWatcherActive) return;

    usb.on('attach', this._onUSBAttach);
    usb.on('detach', this._onUSBDetach);
    this.usbWatcherActive = true;
    log.info('USB watcher initialized');
  }

  /**
   * List available USB printers
   * @returns {Promise<Array<{id: string, name: string, vid: string, pid: string}>>}
   */
  async listPrinters() {
    const printers = [];

    try {
      const devices = usb.getDeviceList();

      for (const device of devices) {
        if (this._isPrinterDevice(device)) {
          const info = this._getDeviceInfo(device);
          printers.push(info);
          // Cache known printer
          this.knownPrinters.set(info.id, {
            vid: info.vid,
            pid: info.pid,
            name: info.name,
            device: device,
          });
        }
      }
    } catch (err) {
      log.error('Failed to enumerate USB printers:', err.message);
    }

    return printers;
  }

  /**
   * Send ZPL data to the printer (with automatic font preload check)
   * @param {string} printerId - Printer identifier (vid:pid format)
   * @param {string} zplData - Complete ZPL string
   * @returns {Promise<{success: boolean}>}
   */
  async printZPL(printerId, zplData) {
    // Auto-preload font if not loaded
    if (this.fontPreloader && !this.fontPreloader.isFontLoaded(printerId)) {
      log.info(`Font not loaded for ${printerId}, preloading...`);
      await this.fontPreloader.preloadFont(printerId);
    }

    // Send the ZPL data
    await this.sendRaw(printerId, zplData);
    return { success: true };
  }

  /**
   * Send raw data to the printer via USB
   * @param {string} printerId - Printer identifier (vid:pid format)
   * @param {string} data - Data string to send
   * @returns {Promise<void>}
   */
  async sendRaw(printerId, data) {
    const device = this._findDevice(printerId);
    if (!device) {
      throw new Error(`Printer not found: ${printerId}`);
    }

    // ★ Convert to UTF-8 Buffer (critical for Chinese text)
    const buffer = Buffer.from(data, 'utf-8');

    return this._writeToDevice(device, buffer);
  }

  /**
   * Get printer status
   * @returns {{connected: boolean, printers: Array}}
   */
  getStatus() {
    return {
      connected: this.knownPrinters.size > 0,
      printers: Array.from(this.knownPrinters.keys()),
    };
  }

  /**
   * Clean up resources
   */
  destroy() {
    if (this.usbWatcherActive) {
      usb.removeListener('attach', this._onUSBAttach);
      usb.removeListener('detach', this._onUSBDetach);
      this.usbWatcherActive = false;
    }
    this.knownPrinters.clear();
    this.removeAllListeners();
  }

  // ─── Private Methods ─────────────────────────────────────────

  /**
   * Check if a USB device is a printer
   * @param {usb.Device} device
   * @returns {boolean}
   * @private
   */
  _isPrinterDevice(device) {
    const desc = device.deviceDescriptor;
    if (!desc) return false;

    // Check against known TSC identifiers
    for (const known of TSC_USB_IDENTIFIERS) {
      if (desc.idVendor === known.vid && desc.idProduct === known.pid) {
        return true;
      }
    }

    // Check USB device class for printer class (0x07)
    try {
      if (desc.bDeviceClass === USB_CLASS_PRINTER) {
        return true;
      }

      // Also check interface classes (some printers report class at interface level)
      // We need to open the device to read config descriptors
      // This is done lazily to avoid issues
      return false;
    } catch (err) {
      return false;
    }
  }

  /**
   * Check if device has a printer interface
   * @param {usb.Device} device
   * @returns {boolean}
   * @private
   */
  _hasPrinterInterface(device) {
    try {
      device.open();
      const configDesc = device.configDescriptor;
      device.close();

      if (configDesc && configDesc.interfaces) {
        for (const iface of configDesc.interfaces) {
          for (const alt of iface) {
            if (alt.bInterfaceClass === USB_CLASS_PRINTER) {
              return true;
            }
          }
        }
      }
    } catch (err) {
      // Device may be busy, ignore
    }
    return false;
  }

  /**
   * Get device information
   * @param {usb.Device} device
   * @returns {Object}
   * @private
   */
  _getDeviceInfo(device) {
    const desc = device.deviceDescriptor;
    const vid = desc.idVendor.toString(16).padStart(4, '0');
    const pid = desc.idProduct.toString(16).padStart(4, '0');

    // Find printer name from known identifiers
    let name = `USB Printer (${vid}:${pid})`;
    for (const known of TSC_USB_IDENTIFIERS) {
      if (desc.idVendor === known.vid && desc.idProduct === known.pid) {
        name = known.name;
        break;
      }
    }

    return {
      id: `${vid}:${pid}`,
      name: name,
      vid: `0x${vid}`,
      pid: `0x${pid}`,
    };
  }

  /**
   * Find a USB device by printer ID (vid:pid)
   * @param {string} printerId
   * @returns {usb.Device|null}
   * @private
   */
  _findDevice(printerId) {
    const [vidStr, pidStr] = printerId.split(':');
    const vid = parseInt(vidStr, 16);
    const pid = parseInt(pidStr, 16);

    const devices = usb.getDeviceList();
    for (const device of devices) {
      const desc = device.deviceDescriptor;
      if (desc && desc.idVendor === vid && desc.idProduct === pid) {
        return device;
      }
    }

    return null;
  }

  /**
   * Write data to a USB printer device
   * @param {usb.Device} device
   * @param {Buffer} data
   * @returns {Promise<void>}
   * @private
   */
  _writeToDevice(device, data) {
    return new Promise((resolve, reject) => {
      try {
        device.open();

        const configDesc = device.configDescriptor;
        if (!configDesc) {
          device.close();
          reject(new Error('No USB configuration descriptor'));
          return;
        }

        // Find the printer interface and OUT endpoint
        let interfaceNum = -1;
        let outEndpoint = null;

        for (let i = 0; i < configDesc.interfaces.length; i++) {
          const iface = configDesc.interfaces[i];
          for (const alt of iface) {
            if (alt.bInterfaceClass === USB_CLASS_PRINTER) {
              interfaceNum = i;
              // Find the OUT endpoint (direction: out, type: bulk)
              for (const ep of alt.endpoints) {
                if (ep.direction === 'out' && ep.transferType === 2) {
                  outEndpoint = ep;
                  break;
                }
              }
              break;
            }
          }
          if (interfaceNum >= 0) break;
        }

        if (interfaceNum < 0) {
          device.close();
          reject(new Error('No printer interface found'));
          return;
        }

        if (!outEndpoint) {
          device.close();
          reject(new Error('No OUT endpoint found'));
          return;
        }

        // Claim the interface
        const iface = device.interface(interfaceNum);

        // Detach kernel driver if needed (Linux)
        try {
          if (iface.isKernelDriverActive()) {
            iface.detachKernelDriver();
          }
        } catch (e) {
          // Windows doesn't support kernel driver operations, ignore
        }

        iface.claim();

        // Get the endpoint
        const endpoint = iface.endpoint(outEndpoint.bEndpointAddress);

        // Transfer data
        endpoint.transfer(data, (err) => {
          try {
            iface.release(() => {
              device.close();
              if (err) {
                reject(new Error(`USB transfer failed: ${err.message}`));
              } else {
                log.info(`ZPL data sent successfully (${data.length} bytes)`);
                resolve();
              }
            });
          } catch (releaseErr) {
            device.close();
            if (err) {
              reject(new Error(`USB transfer failed: ${err.message}`));
            } else {
              resolve();
            }
          }
        });
      } catch (err) {
        try {
          device.close();
        } catch (e) {
          // ignore close error
        }
        reject(new Error(`USB write error: ${err.message}`));
      }
    });
  }

  /**
   * Handle USB device attach
   * @param {usb.Device} device
   * @private
   */
  _onUSBAttach(device) {
    const desc = device.deviceDescriptor;
    if (!desc) return;

    // Check if this is a known TSC printer or a printer-class device
    const isKnown = TSC_USB_IDENTIFIERS.some(
      (k) => desc.idVendor === k.vid && desc.idProduct === k.pid
    );

    if (isKnown || desc.bDeviceClass === USB_CLASS_PRINTER) {
      const info = this._getDeviceInfo(device);
      log.info(`USB printer attached: ${info.name} (${info.id})`);
      this.knownPrinters.set(info.id, {
        vid: info.vid,
        pid: info.pid,
        name: info.name,
        device: device,
      });

      this.emit('printer-attached', info.id);
      this.emit('status', { connected: true, printers: Array.from(this.knownPrinters.keys()) });
    }
  }

  /**
   * Handle USB device detach
   * @param {usb.Device} device
   * @private
   */
  _onUSBDetach(device) {
    const desc = device.deviceDescriptor;
    if (!desc) return;

    const vid = desc.idVendor.toString(16).padStart(4, '0');
    const pid = desc.idProduct.toString(16).padStart(4, '0');
    const printerId = `${vid}:${pid}`;

    if (this.knownPrinters.has(printerId)) {
      log.info(`USB printer detached: ${printerId}`);
      this.knownPrinters.delete(printerId);

      this.emit('printer-detached', printerId);
      this.emit('status', { connected: this.knownPrinters.size > 0, printers: Array.from(this.knownPrinters.keys()) });
    }
  }
}

module.exports = PrinterService;
