/**
 * Electronic Scale Service - A7 Protocol Parser
 *
 * Communicates with an electronic scale via RS232 serial port (USB adapter).
 * Protocol: A7
 * - Baud rate: 9600, Data bits: 8, Parity: None, Stop bits: 1
 * - Continuous sending (~50 times/second)
 * - Data format: '=' + 6 bytes weight data (LSB first) + 1 byte sign/highest digit
 * - All data is ASCII
 *
 * Example:
 *   Weight = +500.00 kg → Serial output: "= 00.0050"
 *   Weight = -500.00 kg → Serial output: "= 00.005-"
 */

const { EventEmitter } = require('events');
const { SerialPort } = require('serialport');
const log = require('electron-log');

// Default serial port configuration
const DEFAULT_PORT_OPTIONS = {
  baudRate: 9600,
  dataBits: 8,
  parity: 'none',
  stopBits: 1,
  autoOpen: false,
};

// Throttle interval: 200ms = 5Hz (from raw ~50Hz)
const THROTTLE_INTERVAL_MS = 200;

// A7 protocol frame size: '=' (1) + weight data (6) + sign/digit (1) = 8 bytes
const FRAME_SIZE = 8;

class ScaleService extends EventEmitter {
  /**
   * @param {Object} options
   * @param {number} [options.averageWindow=5] - Sliding window size for averaging
   */
  constructor(options = {}) {
    super();

    this.port = null;
    this.portPath = null;
    this.connected = false;

    // Buffer for accumulating serial data
    this.buffer = Buffer.alloc(0);

    // Throttle state
    this.lastEmitTime = 0;
    this.lastWeight = null;

    // Sliding window for averaging
    this.averageWindow = options.averageWindow || 5;
    this.weightHistory = [];

    // Bind methods
    this._onData = this._onData.bind(this);
    this._onError = this._onError.bind(this);
    this._onClose = this._onClose.bind(this);
  }

  /**
   * List available serial ports
   * @returns {Promise<Array<{path: string, manufacturer: string, serialNumber: string, pnpId: string}>>}
   */
  async listPorts() {
    const ports = await SerialPort.list();
    return ports.map((p) => ({
      path: p.path,
      manufacturer: p.manufacturer || 'Unknown',
      serialNumber: p.serialNumber || '',
      pnpId: p.pnpId || '',
      productId: p.productId || '',
      vendorId: p.vendorId || '',
    }));
  }

  /**
   * Connect to electronic scale on the specified serial port
   * @param {string} portPath - Serial port path (e.g., 'COM3')
   * @param {Object} [options] - Serial port options (override defaults)
   * @param {number} [options.baudRate=9600] - Baud rate
   * @param {number} [options.dataBits=8] - Data bits (5, 6, 7, or 8)
   * @param {string} [options.parity='none'] - Parity ('none', 'even', 'odd', 'mark', 'space')
   * @param {number} [options.stopBits=1] - Stop bits (1 or 2)
   * @returns {Promise<void>}
   */
  async connect(portPath, options = {}) {
    // ★ 无论 connected 状态如何，只要有旧端口就清理（修复重连竞态）
    if (this.port) {
      await this.disconnect();
    }

    // Merge user options with defaults
    const portOptions = {
      ...DEFAULT_PORT_OPTIONS,
      path: portPath,
    };
    if (options.baudRate !== undefined) portOptions.baudRate = options.baudRate;
    if (options.dataBits !== undefined) portOptions.dataBits = options.dataBits;
    if (options.parity !== undefined) portOptions.parity = options.parity;
    if (options.stopBits !== undefined) portOptions.stopBits = options.stopBits;

    return new Promise((resolve, reject) => {
      this.portPath = portPath;
      this.port = new SerialPort(
        portOptions,
        (err) => {
          if (err) {
            this._emitError(`Failed to create serial port: ${err.message}`);
            reject(err);
            return;
          }
        }
      );

      this.port.on('data', this._onData);
      this.port.on('error', this._onError);
      this.port.on('close', this._onClose);

      this.port.open((err) => {
        if (err) {
          this._emitError(`Failed to open port ${portPath}: ${err.message}`);
          reject(err);
          return;
        }

        this.connected = true;
        this.buffer = Buffer.alloc(0);
        this.weightHistory = [];
        this.lastWeight = null;
        this.lastEmitTime = 0;       // ★ 重连时重置节流时间戳

        log.info(`Scale connected on port: ${portPath}, baudRate: ${portOptions.baudRate}, dataBits: ${portOptions.dataBits}, parity: ${portOptions.parity}, stopBits: ${portOptions.stopBits}`);
        this.emit('status', { connected: true, port: portPath });
        resolve();
      });
    });
  }

  /**
   * Disconnect from electronic scale
   * @returns {Promise<void>}
   */
  async disconnect() {
    return new Promise((resolve) => {
      if (!this.port) {
        this.connected = false;
        this.buffer = Buffer.alloc(0);
        this.weightHistory = [];
        this.lastWeight = null;
        this.lastEmitTime = 0;
        resolve();
        return;
      }

      const oldPort = this.port;
      this.port = null;              // ★ 先置空，防止旧 _onClose 误判
      this.connected = false;
      this.buffer = Buffer.alloc(0);
      this.weightHistory = [];
      this.lastWeight = null;
      this.lastEmitTime = 0;

      oldPort.removeAllListeners();

      if (!oldPort.isOpen) {
        log.info('Port already closed, cleanup done');
        this.emit('status', { connected: false, port: null });
        resolve();
        return;
      }

      oldPort.close((err) => {
        if (err) {
          log.warn('Error closing serial port:', err.message);
        }

        log.info('Scale disconnected');
        this.emit('status', { connected: false, port: null });
        resolve();
      });
    });
  }

  /**
   * Get current connection status
   * @returns {{connected: boolean, port: string|null}}
   */
  getStatus() {
    return {
      connected: this.connected,
      port: this.portPath,
    };
  }

  /**
   * Clean up resources
   */
  destroy() {
    if (this.connected) {
      this.disconnect();
    }
    this.removeAllListeners();
  }

  // ─── Private Methods ─────────────────────────────────────────

  /**
   * Handle incoming serial data
   * @param {Buffer} data
   * @private
   */
  _onData(data) {
    // Append to buffer
    this.buffer = Buffer.concat([this.buffer, data]);

    // Process all complete frames in the buffer
    this._processBuffer();
  }

  /**
   * Process the data buffer, extracting complete A7 frames
   * @private
   */
  _processBuffer() {
    while (this.buffer.length >= FRAME_SIZE) {
      // Find the '=' start marker
      const startIdx = this.buffer.indexOf(0x3d); // ASCII '='

      if (startIdx === -1) {
        // No start marker found, discard entire buffer
        this.buffer = Buffer.alloc(0);
        return;
      }

      if (startIdx > 0) {
        // Discard bytes before the start marker
        this.buffer = this.buffer.subarray(startIdx);
      }

      // Check if we have a complete frame
      if (this.buffer.length < FRAME_SIZE) {
        // Not enough data yet, wait for more
        return;
      }

      // Extract the frame (8 bytes starting from '=')
      const frame = this.buffer.subarray(0, FRAME_SIZE);

      // Remove the processed frame from the buffer
      this.buffer = this.buffer.subarray(FRAME_SIZE);

      // Parse the frame
      const weight = this._parseA7Frame(frame);
      if (weight !== null) {
        this._handleWeight(weight);
      }
    }
  }

  /**
   * Parse a single A7 protocol frame
   *
   * Frame format (8 bytes):
   *   Byte 0: '=' (0x3D) - start marker
   *   Bytes 1-6: Weight data (6 chars, LSB first, includes decimal point)
   *   Byte 7: Sign ('-' for negative) or highest digit
   *
   * @param {Buffer} frame - 8-byte frame buffer
   * @returns {Object|null} Parsed weight data or null on error
   * @private
   */
  _parseA7Frame(frame) {
    // Verify start marker
    if (frame[0] !== 0x3d) {
      log.debug('Invalid frame start marker:', frame[0].toString(16));
      return null;
    }

    try {
      // Extract weight data bytes (bytes 1-6)
      const weightBytes = frame.subarray(1, 7);
      const weightStr = weightBytes.toString('ascii');

      // Extract sign/highest digit (byte 7)
      const signByte = String.fromCharCode(frame[7]);

      // Reverse the weight data (LSB first → MSB first)
      const reversedWeight = weightStr.split('').reverse().join('');

      // Determine sign and construct the full number
      let fullWeightStr;
      let isNegative = false;

      if (signByte === '-') {
        // Negative weight
        isNegative = true;
        fullWeightStr = '-' + reversedWeight;
      } else if (signByte >= '0' && signByte <= '9') {
        // Positive weight with highest digit in sign byte
        fullWeightStr = signByte + reversedWeight;
      } else if (signByte === ' ' || signByte === '\0') {
        // Space or null - just use reversed weight
        fullWeightStr = reversedWeight;
      } else {
        // Unknown sign byte, log and use reversed weight
        log.debug('Unknown sign byte:', signByte, 'charCode:', frame[7]);
        fullWeightStr = reversedWeight;
      }

      // Remove leading zeros (but keep the number valid)
      fullWeightStr = fullWeightStr.replace(/^(-?)0+(?=\d)/, '$1');

      // Parse as float
      const value = parseFloat(fullWeightStr);
      if (isNaN(value)) {
        log.debug('Failed to parse weight:', fullWeightStr, 'from frame:', frame.toString('ascii'));
        return null;
      }

      return {
        value: value,
        isNegative: isNegative,
        raw: frame.toString('ascii'),
        parsed: fullWeightStr,
      };
    } catch (err) {
      log.debug('Frame parse error:', err.message);
      return null;
    }
  }

  /**
   * Handle a parsed weight value: averaging + throttling
   * @param {Object} weight - Parsed weight data
   * @private
   */
  _handleWeight(weight) {
    // Add to sliding window for averaging
    this.weightHistory.push(weight.value);
    if (this.weightHistory.length > this.averageWindow) {
      this.weightHistory.shift();
    }

    // Calculate average
    const avg =
      this.weightHistory.reduce((sum, v) => sum + v, 0) /
      this.weightHistory.length;

    // Round to 2 decimal places
    const avgRounded = Math.round(avg * 100) / 100;

    // Check stability (all recent values are the same)
    const stable =
      this.weightHistory.length >= 3 &&
      this.weightHistory.every(
        (v) => Math.round(v * 100) / 100 === avgRounded
      );

    // Throttle: only emit every THROTTLE_INTERVAL_MS
    const now = Date.now();
    if (now - this.lastEmitTime < THROTTLE_INTERVAL_MS) {
      return;
    }

    // Only emit if value has changed
    if (this.lastWeight !== null && Math.abs(avgRounded - this.lastWeight) < 0.001) {
      return;
    }

    this.lastEmitTime = now;
    this.lastWeight = avgRounded;

    this.emit('weight', {
      value: avgRounded,
      unit: 'kg',
      raw: weight.raw,
      stable: stable,
    });
  }

  /**
   * Handle serial port error
   * @param {Error} err
   * @private
   */
  _onError(err) {
    this._emitError(`Serial port error: ${err.message}`);
  }

  /**
   * Handle serial port close
   * ★ 只有当前活跃端口的 close 事件才更新状态，
   *   防止旧端口的延迟 close 事件覆盖新连接。
   * @private
   */
  _onClose() {
    // 如果 this.port 已被置空（disconnect 主动断开）或已换成新端口，忽略
    if (!this.port) {
      log.info('Serial port closed (already cleaned up by disconnect)');
      return;
    }

    log.info(`Serial port closed: ${this.portPath}`);
    this.connected = false;
    const closedPortPath = this.portPath;
    this.port = null;
    this.buffer = Buffer.alloc(0);
    this.weightHistory = [];
    this.lastWeight = null;
    this.lastEmitTime = 0;
    this.emit('status', { connected: false, port: closedPortPath });
  }

  /**
   * Emit an error event
   * @param {string} message
   * @private
   */
  _emitError(message) {
    log.error('ScaleService:', message);
    this.emit('error', new Error(message));
  }
}

module.exports = ScaleService;
