/**
 * Font Preloader - Chinese Font Management for TSC TE344 Printer
 *
 * Manages the ^CW ZPL command that maps a Chinese TTF font file stored
 * on the printer's E: drive to a single-character font code (C).
 *
 * Background:
 * - The Chinese font file (CHN.TTF) is uploaded to the printer's E: flash storage
 *   once via Zebra Setup Utilities or the printer's web management interface.
 * - The font file persists in flash memory across power cycles.
 * - However, the ^CW font mapping is stored in DRAM and is lost when the
 *   printer is powered off or restarted.
 * - This module automatically re-sends the ^CW mapping command when needed.
 *
 * Font Code: 'C'
 * - In ZPL, use ^ACN,30,30 to reference the Chinese font
 * - For English text, use ^A0N,25,25 (built-in font)
 *
 * Note: printerId is now the Windows printer name (e.g., "TSC TE344")
 * instead of the old vid:pid USB format.
 */

const log = require('electron-log');

// ZPL command to map E:CHN.TTF to font code C
// ^CW{code},{storage}:{filename}
const FONT_MAP_COMMAND = '^XA^CWC,E:CHN.TTF^XZ';

// Font file name on the printer's E: drive
const FONT_FILENAME = 'E:CHN.TTF';

// Font code used in ZPL ^A commands
const FONT_CODE = 'C';

class FontPreloader {
  /**
   * @param {PrinterService} printerService - Printer service instance for communication
   */
  constructor(printerService) {
    this.printerService = printerService;

    // Track which printers have the font loaded (DRAM mapping active)
    // Map<printerId, boolean>
    this.fontLoaded = new Map();

    // Track preload timestamps for debugging
    this.lastPreloadTime = new Map();
  }

  /**
   * Preload the Chinese font mapping for a specific printer
   *
   * Sends ^CWC,E:CHN.TTF to map the font file to code 'C' in printer DRAM.
   * This must be called:
   * - On Electron app startup (for each connected printer)
   * - When a new printer is connected (detected via polling)
   * - Before printing if font is not loaded
   *
   * @param {string} printerId - Windows printer name
   * @returns {Promise<void>}
   */
  async preloadFont(printerId) {
    log.info(`Preloading Chinese font for printer: "${printerId}"`);

    try {
      // Send the ^CW mapping command via the printer service
      await this.printerService.sendRaw(printerId, FONT_MAP_COMMAND);

      // Mark as loaded
      this.fontLoaded.set(printerId, true);
      this.lastPreloadTime.set(printerId, Date.now());

      log.info(
        `Font code '${FONT_CODE}' mapped to ${FONT_FILENAME} for printer "${printerId}"`
      );
    } catch (err) {
      // Mark as not loaded on failure
      this.fontLoaded.set(printerId, false);
      log.error(`Font preload failed for printer "${printerId}":`, err.message);
      throw err;
    }
  }

  /**
   * Check if the Chinese font is currently loaded for a printer
   * @param {string} printerId - Windows printer name
   * @returns {boolean} True if ^CW mapping is active in printer DRAM
   */
  isFontLoaded(printerId) {
    return this.fontLoaded.get(printerId) === true;
  }

  /**
   * Mark a printer's font as unloaded (e.g., when printer is disconnected)
   * @param {string} printerId - Windows printer name
   */
  markUnloaded(printerId) {
    this.fontLoaded.set(printerId, false);
    this.lastPreloadTime.delete(printerId);
    log.info(`Font marked as unloaded for printer: "${printerId}"`);
  }

  /**
   * Get font preload status for all tracked printers
   * @returns {Object} Map of printerId → { loaded: boolean, lastPreload: string|null }
   */
  getAllStatus() {
    const status = {};
    for (const [printerId, loaded] of this.fontLoaded) {
      const lastTime = this.lastPreloadTime.get(printerId);
      status[printerId] = {
        loaded: loaded,
        lastPreload: lastTime ? new Date(lastTime).toISOString() : null,
      };
    }
    return status;
  }

  /**
   * Get the ZPL font reference string for use in ^A commands
   *
   * Returns the ^A prefix for Chinese text using font code C:
   *   ^ACN,{height},{width}
   *
   * @param {number} height - Font height in dots (default: 30)
   * @param {number} width - Font width in dots (default: 30)
   * @param {string} orientation - N(ormal), R(otated), I(nverted), B(ottom-up)
   * @returns {string} ZPL font reference string
   */
  getFontCommand(height = 30, width = 30, orientation = 'N') {
    return `^A${FONT_CODE}${orientation},${height},${width}`;
  }

  /**
   * Preload fonts for all known printers
   * @returns {Promise<{success: string[], failed: string[]}>}
   */
  async preloadAll() {
    const printers = await this.printerService.listPrinters();
    const success = [];
    const failed = [];

    for (const printer of printers) {
      try {
        await this.preloadFont(printer.id);
        success.push(printer.id);
      } catch (err) {
        failed.push(printer.id);
      }
    }

    return { success, failed };
  }
}

module.exports = FontPreloader;

// Export constants for use in ZPL template generation
module.exports.FONT_CODE = FONT_CODE;
module.exports.FONT_FILENAME = FONT_FILENAME;
module.exports.FONT_MAP_COMMAND = FONT_MAP_COMMAND;
