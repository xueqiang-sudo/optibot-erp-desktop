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
// TSC Auto ID Technology Co., Ltd VID: 0x1203
const TSC_USB_IDENTIFIERS = [
  { vid: 0x1203, pid: 0x0272, name: 'TSC TE344' },
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
   * Scans ALL USB devices using multiple detection strategies.
   * @returns {Promise<Array<{id: string, name: string, manufacturer: string, serialNumber: string, port: string, vid: string, pid: string}>>}
   */
  async listPrinters() {
    const printers = [];

    try {
      const devices = usb.getDeviceList();
      log.info(`USB device scan: found ${devices.length} total devices`);

      for (const device of devices) {
        const desc = device.deviceDescriptor;
        if (!desc) continue;

        const vid = desc.idVendor.toString(16).padStart(4, '0');
        const pid = desc.idProduct.toString(16).padStart(4, '0');
        const isPrinter = this._isPrinterDevice(device);

        log.info(
          `  USB ${vid}:${pid} class=0x${desc.bDeviceClass.toString(16)} ` +
          `subclass=0x${desc.bDeviceSubClass?.toString(16) || '00'} ` +
          `protocol=0x${desc.bDeviceProtocol?.toString(16) || '00'} ` +
          `→ ${isPrinter ? '✅ PRINTER' : 'skip'}`
        );

        if (isPrinter) {
          try {
            const info = await this._getDeviceInfo(device);
            printers.push(info);
            log.info(`  → Printer: ${info.name} (${info.id}) [${info.port}]`);
            // Cache known printer
            this.knownPrinters.set(info.id, {
              vid: info.vid,
              pid: info.pid,
              name: info.name,
              device: device,
            });
          } catch (infoErr) {
            log.warn(`  → Failed to read device info for ${vid}:${pid}:`, infoErr.message);
          }
        }
      }

      log.info(`Printer scan complete: ${printers.length} printer(s) found`);
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
      try {
        await this.fontPreloader.preloadFont(printerId);
      } catch (fontErr) {
        log.warn(`Font preload failed for ${printerId}: ${fontErr.message}, continuing with print...`);
      }
    }

    // Send the ZPL data with timeout (8 seconds)
    const timeoutMs = 8000;
    await Promise.race([
      this.sendRaw(printerId, zplData),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`USB写入超时 (${timeoutMs / 1000}秒)`)), timeoutMs)
      ),
    ]);
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
   * Check if a USB device is a printer.
   * Uses multiple detection strategies:
   *  1. Known VID/PID list
   *  2. Device-level bDeviceClass === 0x07
   *  3. Interface-level bInterfaceClass === 0x07
   *  4. Config descriptor interface class check (without open/close)
   * @param {usb.Device} device
   * @returns {boolean}
   * @private
   */
  _isPrinterDevice(device) {
    const desc = device.deviceDescriptor;
    if (!desc) return false;

    // Strategy 1: Check against known TSC identifiers
    for (const known of TSC_USB_IDENTIFIERS) {
      if (desc.idVendor === known.vid && desc.idProduct === known.pid) {
        return true;
      }
    }

    // Strategy 2: Device-level USB printer class (0x07)
    if (desc.bDeviceClass === USB_CLASS_PRINTER) {
      return true;
    }

    // Strategy 3: Check interface-level printer class by opening the device
    try {
      if (this._hasPrinterInterface(device)) {
        return true;
      }
    } catch (err) {
      // Strategy 4: Some devices expose configDescriptor without opening
      try {
        const configDesc = device.configDescriptor;
        if (configDesc && configDesc.interfaces) {
          for (const iface of configDesc.interfaces) {
            for (const alt of iface) {
              if (alt.bInterfaceClass === USB_CLASS_PRINTER) {
                return true;
              }
            }
          }
        }
      } catch (e) {
        // ignore
      }
    }

    return false;
  }

  /**
   * Check if device has a printer interface
   * @param {usb.Device} device
   * @returns {boolean}
   * @private
   */
  _hasPrinterInterface(device) {
    let opened = false;
    try {
      device.open();
      opened = true;
      const configDesc = device.configDescriptor;

      if (configDesc && configDesc.interfaces) {
        for (const iface of configDesc.interfaces) {
          for (const alt of iface) {
            if (alt.bInterfaceClass === USB_CLASS_PRINTER) {
              if (opened) device.close();
              return true;
            }
          }
        }
      }

      if (opened) device.close();
    } catch (err) {
      log.debug(`_hasPrinterInterface: could not open device: ${err.message}`);
      try { if (opened) device.close(); } catch (e) { /* ignore */ }
    }
    return false;
  }

  /**
   * Get device information (reads USB descriptors for real name/port)
   * @param {usb.Device} device
   * @returns {Promise<Object>}
   * @private
   */
  async _getDeviceInfo(device) {
    const desc = device.deviceDescriptor;
    const vid = desc.idVendor.toString(16).padStart(4, '0');
    const pid = desc.idProduct.toString(16).padStart(4, '0');

    let manufacturer = '';
    let product = '';
    let serialNumber = '';

    // Read USB string descriptors for real device info
    try {
      device.open();
      if (desc.iManufacturer) {
        manufacturer = await device.getStringDescriptor(desc.iManufacturer);
      }
      if (desc.iProduct) {
        product = await device.getStringDescriptor(desc.iProduct);
      }
      if (desc.iSerialNumber) {
        serialNumber = await device.getStringDescriptor(desc.iSerialNumber);
      }
      device.close();
    } catch (err) {
      // Device may be busy or permissions issue, use defaults
      try { device.close(); } catch (e) { /* ignore */ }
      log.warn(`Failed to read USB descriptors for ${vid}:${pid}:`, err.message);
    }

    // USB port path: busNumber + deviceAddress
    const port = `USB Bus ${device.busNumber} Device ${device.deviceAddress}`;

    // Build display name: prefer USB product string > known list > fallback
    let name = product || '';
    if (!name) {
      for (const known of TSC_USB_IDENTIFIERS) {
        if (desc.idVendor === known.vid && desc.idProduct === known.pid) {
          name = known.name;
          break;
        }
      }
    }
    if (!name) {
      name = `USB Printer (${vid}:${pid})`;
    }

    return {
      id: `${vid}:${pid}`,
      name: name,
      manufacturer: manufacturer,
      product: product,
      serialNumber: serialNumber,
      port: port,
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
      const desc = device.deviceDescriptor;
      const vid = desc
        ? desc.idVendor.toString(16).padStart(4, '0')
        : '????';
      const pid = desc
        ? desc.idProduct.toString(16).padStart(4, '0')
        : '????';

      log.info(`[USB] Opening device ${vid}:${pid} for write (${data.length} bytes)...`);

      try {
        device.open();
      } catch (openErr) {
        log.error(`[USB] Failed to open device ${vid}:${pid}: ${openErr.message}`);
        reject(
          new Error(
            `无法打开 USB 设备 ${vid}:${pid}: ${openErr.message}。` +
            `可能需要管理员权限或配置 udev 规则。`
          )
        );
        return;
      }

      try {
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
            log.info(`[USB] Detaching kernel driver on interface ${interfaceNum}`);
            iface.detachKernelDriver();
          }
        } catch (e) {
          // Windows doesn't support kernel driver operations, ignore
        }

        log.info(`[USB] Claiming interface ${interfaceNum}...`);
        iface.claim();

        // Get the endpoint
        const endpoint = iface.endpoint(outEndpoint.bEndpointAddress);

        log.info(`[USB] Transferring ${data.length} bytes to endpoint...`);
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
  async _onUSBAttach(device) {
    const desc = device.deviceDescriptor;
    if (!desc) return;

    // Check if this is a known TSC printer or a printer-class device
    const isKnown = TSC_USB_IDENTIFIERS.some(
      (k) => desc.idVendor === k.vid && desc.idProduct === k.pid
    );

    if (isKnown || desc.bDeviceClass === USB_CLASS_PRINTER) {
      const info = await this._getDeviceInfo(device);
      log.info(`USB printer attached: ${info.name} (${info.id}) [${info.port}]`);
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
