/**
 * TSPL Converter — Pure JavaScript JSON-to-TSPL command generator
 *
 * Replaces TSCLIB.dll (koffi FFI) with pure JS generation.
 * The output is a complete TSPL program as a Buffer that can be sent
 * directly to a TSC label printer via the Windows Spooler API in RAW mode.
 *
 * TSPL reference: TSC Auto ID Programming Manual
 *
 * Coordinate system:
 * - Input JSON uses millimeters for all positions/sizes
 * - Output TSPL uses dots (printer resolution units)
 * - Conversion: dots = mm \u00d7 (dpi / 25.4)
 *
 * Font handling:
 * - Chinese text uses printer-stored fonts (e.g., "SourceHa.TTF", "SimsunEx")
 * - Font name is referenced directly in TEXT commands
 * - No separate font download/mapping step needed
 *
 * QR code binary mode (M2):
 * - Content fields separated by \t (tab)
 * - QR data body starts with 0x80, fields joined with 0x80 byte separator
 * - Chinese fields auto-encoded to UTF-8 bytes
 * - Command prefix (QRCODE x,y,...) as ASCII bytes
 * - All parts assembled as Buffer and sent to printer
 */

const log = require('electron-log');

/**
 * Generate a complete TSPL command Buffer from a label configuration object.
 *
 * @param {Object} config - Label configuration (same format as TSCLIB wrapper input)
 * @param {number} config.width - Label width in mm
 * @param {number} config.height - Label height in mm
 * @param {number} [config.dpi=203] - Printer DPI (dots per inch)
 * @param {number} [config.copies=1] - Number of copies to print
 * @param {Array} config.elements - Array of label elements
 * @returns {Buffer} Complete TSPL command data as Buffer (supports binary QR)
 */
function generateTSPL(config) {
  const { width, height, dpi = 203, copies = 1, elements } = config;
  const dpm = dpi / 25.4; // dots per millimeter

  const buffers = []; // Array of Buffers (supports binary QR data with 0x80)

  // \u2500\u2500 Label setup \u2500\u2500
  const setupLines = [
    `SIZE ${width} mm, ${height} mm`,
    'GAP 4 mm,8',
    'DIRECTION 1',
    'REFERENCE 0,0',
    'CODEPAGE UTF-8',
    'CLS',
  ];
  for (const line of setupLines) {
    buffers.push(Buffer.from(line + '\r\n', 'utf-8'));
  }

  // \u2500\u2500 Render each element \u2500\u2500
  if (elements && Array.isArray(elements)) {
    for (let i = 0; i < elements.length; i++) {
      const el = elements[i];
      const x = Math.round((el.x || 0) * dpm);
      const y = Math.round((el.y || 0) * dpm);

      try {
        const elCommands = renderElement(el, x, y, dpm);
        for (const cmd of elCommands) {
          if (Buffer.isBuffer(cmd)) {
            buffers.push(cmd);
          } else {
            buffers.push(Buffer.from(cmd + '\r\n', 'utf-8'));
          }
        }
      } catch (err) {
        log.error(`[TSPL-Converter] Element ${i} (${el.type}): ${err.message}`);
      }
    }
  }

  // \u2500\u2500 Print \u2500\u2500
  buffers.push(Buffer.from(`PRINT 1,${copies}\r\n`, 'utf-8'));

  const result = Buffer.concat(buffers);

  log.info(
    `[TSPL-Converter] Generated ${buffers.length} command buffers, ${result.length} bytes`
  );

  return result;
}

/**
 * Render a single label element to an array of TSPL commands.
 * Returns string[] for most elements, but may contain Buffer for binary QR codes.
 *
 * @param {Object} el - Element descriptor
 * @param {number} x - X position in dots
 * @param {number} y - Y position in dots
 * @param {number} dpm - Dots per millimeter
 * @returns {Array<string|Buffer>} Array of TSPL commands (string or Buffer for binary QR)
 */
function renderElement(el, x, y, dpm) {
  switch (el.type) {
    case 'text':
    case 'date':
      return renderText(el, x, y);

    case 'barcode':
      if (el.barcodeType === 'QR') {
        // Delegate to QR code renderer (may return Buffer for binary mode)
        const qrBuf = renderQRCode({ ...el, type: 'qrcode' }, x, y, dpm);
        return Buffer.isBuffer(qrBuf) ? [qrBuf] : qrBuf;
      }
      return renderBarcode(el, x, y);

    case 'qrcode':
      const qrResult = renderQRCode(el, x, y, dpm);
      return Buffer.isBuffer(qrResult) ? [qrResult] : qrResult;

    case 'line':
      return renderLine(el, x, y, dpm);

    case 'table':
      return renderTable(el, x, y, dpm);

    default:
      log.warn(`[TSPL-Converter] Unknown element type: ${el.type}`);
      return [];
  }
}

/**
 * Render a text or date element.
 *
 * TSPL TEXT command: TEXT x,y,"font",rotation,xMul,yMul,"content"
 * - x,y: position in dots
 * - font: printer-stored font name (e.g., "SourceHa.TTF", "SimsunEx")
 * - rotation: 0/90/180/270
 * - xMul,yMul: font size multipliers (acts as point size)
 * - content: text content (double quotes escaped as "")
 *
 * @param {Object} el - Text element
 * @param {number} x - X in dots
 * @param {number} y - Y in dots
 * @returns {string[]}
 */
function renderText(el, x, y) {
  const content = el.content || '';
  if (!content) return [];

  const fontSize = Math.max(8, el.font_size || 24);
  const fontName = el.font_name || 'SourceHa.TTF';
  const rotation = el.rotation || 0;
  // Preserve spaces as-is — the printer handles them correctly
  const escaped = content.replace(/"/g, '""');

  return [`TEXT ${x},${y},"${fontName}",${rotation},${fontSize},${fontSize},"${escaped}"`];
}

/**
 * Render a Code 128 barcode element.
 *
 * TSPL BARCODE command: BARCODE x,y,"codeType",height,humanReadable,alignment,narrow,wide,"content"
 * - codeType: "128" for Code 128
 * - height: barcode height in dots
 * - humanReadable: 0=none, 1=above, 2=below
 * - alignment: 0=default
 * - narrow: narrow bar width in dots
 * - wide: wide bar width in dots
 *
 * @param {Object} el - Barcode element
 * @param {number} x - X in dots
 * @param {number} y - Y in dots
 * @returns {string[]}
 */
function renderBarcode(el, x, y) {
  const content = (el.content || '').replace(/"/g, '""');
  if (!content) return [];

  const height = el.height || 60;

  return [`BARCODE ${x},${y},"128",${height},1,0,2,2,"${content}"`];
}

/**
 * Calculate max data bytes for a QR version in M2 (8-bit byte) mode, EC Level L.
 *
 * Based on QR code ISO/IEC 18004 structure:
 * - Total modules = (4V+17)^2
 * - Function pattern modules = 225 (V<=6) or 353 (V>=7)
 * - Alignment patterns = ceil((V-7)/7 + 2)^2 - 3, each 25 modules
 * - Timing modules = 2 * (4V+17 - 16)
 * - Format info = 31 modules
 * - Version info = 36 modules (V >= 7 only)
 *
 * @param {number} version - QR version (1-40)
 * @returns {number} Max data bytes
 */
function calcMaxDataBytes(version) {
  const s = 4 * version + 17;
  const total = s * s;
  const func = version <= 6 ? 225 : 353;
  const nAlign = Math.max(0, Math.ceil((version - 7) / 7 + 2));
  const aligns = (nAlign * nAlign - 3) * 25;
  const timing = 2 * (s - 16);
  const fmt = 31;
  const ver = version >= 7 ? 36 : 0;
  const dataModules = total - func - aligns - timing - fmt - ver;
  const totalCodewords = Math.floor(dataModules / 8);
  // EC Level L: 2 blocks for all versions (1-40)
  const ecPerBlock = Math.floor(Math.ceil(totalCodewords * 0.07) / 2);
  return totalCodewords - 2 * ecPerBlock;
}

/**
 * Render a QR code element.
 *
 * TSPL QRCODE command: QRCODE x,y,EClevel,cellSize,mode,rotation,maxVersion,"data"
 * - EClevel: L/M/Q/H error correction
 * - cellSize: size of each QR module in dots
 * - mode: A=auto, M2=8-bit byte mode (for binary data with 0x80 separators)
 * - rotation: 0/90/180/270
 * - maxVersion: 0=auto, 1-40=specific QR version
 *
 * Binary mode (M2) — triggered when content contains tab (\t) separator:
 *   1. Split content by \t (tab) to get individual fields
 *   2. Convert each field to UTF-8 bytes (Chinese auto-handled)
 *   3. Prepend 0x80 as first byte, then join fields with 0x80 byte separator
 *   4. Build QRCODE command as Buffer (ASCII prefix + binary data + suffix)
 *
 * Plain mode (A) — fallback for content without tab:
 *   Standard text-based QRCODE command string.
 *
 * GS1 mode: prepend ">8" to content (GS1 Application Identifier prefix)
 *
 * @param {Object} el - QR code element
 * @param {number} x - X in dots
 * @param {number} y - Y in dots
 * @returns {string[]|Buffer} String array for plain mode, Buffer for binary mode
 */
function renderQRCode(el, x, y, dpm) {
  let content = el.content || '';
  if (!content) return [];

  let cellSize = el.size || null; // null = auto-calculate
  const ecLevel = el.ecLevel || 'L';
  const targetMM = el.qrSize || null; // target QR size in mm (null = no auto-calc)

  // GS1 mode: prepend ">8" Application Identifier prefix
  if (el.gs1) {
    content = '>8' + content;
  }

  // Check if content has field separators (\t)
  if (content.includes('\t')) {
    // ── Binary mode (M2): build QR data as raw bytes ──

    // Remove leading \t if present (content starts with \t)
    if (content.startsWith('\t')) {
      content = content.substring(1);
    }

    // 1. Split by tab (\t) to get individual fields
    const fields = content.split('\t');

    // 2. Build QR data body: leading 0x80 + fields joined with 0x80 separator
    //    Each field is converted to UTF-8 bytes (Chinese chars auto-handled)
    const fieldBuffers = fields.map(f => Buffer.from(f, 'utf-8'));
    const separator = Buffer.from([0x80]);

    const qrDataParts = [separator]; // first byte is 0x80
    for (let i = 0; i < fieldBuffers.length; i++) {
      qrDataParts.push(fieldBuffers[i]);
      if (i < fieldBuffers.length - 1) {
        qrDataParts.push(separator);
      }
    }
    const qrData = Buffer.concat(qrDataParts);

    // 3. Auto-calculate cellSize if target QR size (qrSize in mm) is specified
    if (targetMM && dpm) {
      const dataBytes = qrData.length;

      // Find minimum QR version that can hold the data (M2 mode, L level)
      let version = 1;
      for (let v = 1; v <= 40; v++) {
        if (calcMaxDataBytes(v) >= dataBytes) {
          version = v;
          break;
        }
        if (v === 40) version = 40;
      }

      // QR modules = 4 * version + 17
      const modules = 4 * version + 17;

      // Calculate cellSize: target dots / modules, rounded to nearest integer
      const targetDots = targetMM * dpm;
      cellSize = Math.max(1, Math.min(10, Math.round(targetDots / modules)));

      const actualMM = (modules * cellSize) / dpm;
      log.info(
        `[TSPL-Converter] QR auto-size: ${dataBytes} bytes → V${version} (${modules}×${modules}), ` +
        `cellSize=${cellSize}, actual=${actualMM.toFixed(1)}mm (target=${targetMM}mm)`
      );
    }

    // Fallback: default cellSize if not set
    if (!cellSize) cellSize = 6;

    // 4. Build complete QRCODE command as Buffer
    //    - Prefix: ASCII text "QRCODE x,y,ECLevel,cellSize,A,0,M2,\""
    //    - Body: binary QR data (0x80 separated fields, UTF-8 Chinese)
    //    - Suffix: closing quote + CRLF
    const prefix = Buffer.from(
      `QRCODE ${x},${y},${ecLevel},${cellSize},A,0,M2,"`,
      'utf-8'
    );
    const suffix = Buffer.from('"\r\n', 'utf-8');

    const cmd = Buffer.concat([prefix, qrData, suffix]);

    log.debug(
      `[TSPL-Converter] QR binary: ${fields.length} fields, ${qrData.length} bytes`
    );
    log.debug(
      `[TSPL-Converter] QR hex: ${cmd.toString('hex').match(/../g).join(' ')}`
    );

    return cmd;
  }

  // ── Plain mode: standard text-based QRCODE command ──
  const escaped = content.replace(/"/g, '""');
  return [`QRCODE ${x},${y},${ecLevel},${size},A,0,"${escaped}"`];
}

/**
 * Render a horizontal line element using the BAR command.
 *
 * TSPL BAR command: BAR x,y,width,thickness
 * - Draws a solid black rectangle (used as a horizontal rule)
 *
 * @param {Object} el - Line element
 * @param {number} x - X in dots
 * @param {number} y - Y in dots
 * @param {number} dpm - Dots per millimeter
 * @returns {string[]}
 */
function renderLine(el, x, y, dpm) {
  const width = Math.round((el.width || 50) * dpm);
  const thickness = el.thickness || 2;

  return [`BAR ${x},${y},${width},${thickness}`];
}
/**
 * Render a table element — the most complex element type.
 *
 * A table consists of:
 * - An outer border (BOX command)
 * - Horizontal grid lines between rows (BAR commands)
 * - Vertical grid lines between columns (BAR commands)
 * - Header row text (TEXT commands, centered)
 * - Data cell text (TEXT commands, with left/center/right alignment)
 *
 * Supports:
 * - Cell overrides: content, font_size, colspan, hidden, alignment
 * - Colspan: merges cells across columns
 * - Hidden cells: skips rendering and grid lines
 * - Variable column widths
 *
 * @param {Object} el - Table element
 * @param {number} tx - Table X origin in dots
 * @param {number} ty - Table Y origin in dots
 * @param {number} dpm - Dots per millimeter
 * @returns {string[]}
 */
function renderTable(el, tx, ty, dpm) {
  const commands = [];

  const cols = el.columns || [];
  const cellOverrides = el.cell_overrides || {};
  const maxRows = el.max_rows || 6;
  const rowHeight = Math.round((el.row_height || 6) * dpm);
  const showBorder = el.border !== false;
  const borderThickness = el.border_thickness || 2;
  const cellFontSize = el.cell_font_size || 16;
  const headerFontSize = el.header_font_size || 20;
  const showHeader = el.show_header !== false;
  const fontName = el.font_name || 'SourceHa.TTF';

  // Compute column widths in dots
  const colWidths = cols.map((c) => Math.round((c.width || 20) * dpm));
  const totalWidth = colWidths.reduce((a, w) => a + w, 0);
  const totalHeight = rowHeight * maxRows;

  // Pre-process hidden cells and colspan info
  const hidden = {};
  const colspanMap = {};
  for (const [key, override] of Object.entries(cellOverrides)) {
    if (override?.hidden) hidden[key] = true;
    if (override?.colspan > 1) colspanMap[key] = override.colspan;
  }

  const isHidden = (r, c) => hidden[`${r},${c}`] === true;
  const getColspan = (r, c) => colspanMap[`${r},${c}`] || 1;

  /**
   * Determine if a vertical grid line at column boundary c should be skipped
   * for row r. Skip if:
   * - A cell to the left spans past this boundary
   * - A cell to the right (or at c) spans past this boundary
   * - Both adjacent cells are hidden
   */
  const shouldSkipVertical = (r, c) => {
    // Check if any cell to the left spans past column c
    for (let l = c - 1; l >= 0; l--) {
      if (l + getColspan(r, l) > c) return true;
    }
    // Check if any cell at or right of c spans past c
    for (let rc = c; rc < cols.length; rc++) {
      const span = getColspan(r, rc);
      if (span > 1 && rc < c) return true;
    }
    // Skip if both adjacent cells are hidden
    return isHidden(r, c - 1) && isHidden(r, c);
  };

  // ── Draw borders and grid lines ──
  if (showBorder) {
    // Outer border (BOX)
    commands.push(
      `BOX ${tx},${ty},${tx + totalWidth - 1},${ty + totalHeight - 1},${borderThickness}`
    );

    // Horizontal grid lines (between rows)
    for (let r = 1; r < maxRows; r++) {
      const lineY = ty + r * rowHeight;
      let hasHiddenInRow = false;
      for (let c = 0; c < cols.length; c++) {
        if (isHidden(r, c)) {
          hasHiddenInRow = true;
          break;
        }
      }

      if (hasHiddenInRow) {
        // Draw full-width line when row has hidden cells
        commands.push(`BAR ${tx},${lineY},${totalWidth},${borderThickness}`);
      } else {
        // Draw per-cell line segments
        let lx = tx;
        for (let c = 0; c < cols.length; c++) {
          commands.push(`BAR ${lx},${lineY},${colWidths[c]},${borderThickness}`);
          lx += colWidths[c];
        }
      }
    }

    // Vertical grid lines (between columns)
    let cx = tx;
    for (let c = 1; c < cols.length; c++) {
      cx += colWidths[c - 1];
      for (let r = 0; r < maxRows; r++) {
        if (!shouldSkipVertical(r, c)) {
          commands.push(`BAR ${cx},${ty + r * rowHeight},${borderThickness},${rowHeight}`);
        }
      }
    }
  }

  // ── Text width estimation for alignment ──
  // Calibrated for SourceHa.TTF on TSPL TrueType:
  //   ASCII advance = fontSize × 4/3 per char  (e.g. 12→16 dots = 2mm)
  //   CJK advance   = fontSize × 8/3 per char  (e.g. 12→32 dots = 4mm)
  const estimateTextWidth = (text, fontSize) => {
    const charWidth = Math.max(8, fontSize);
    let width = 0;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      const factor = code <= 0x7f ? 4 : 8;
      width += charWidth * factor;
    }
    return Math.round(width / 3);
  };

  // ── Render header row ──
  if (showHeader) {
    let hx = tx;
    const hFont = Math.max(8, headerFontSize);

    for (let c = 0; c < cols.length; c++) {
      const headerText = cols[c].header || '';
      if (headerText) {
        const textW = estimateTextWidth(headerText, headerFontSize);
        const offsetX = Math.max(2, Math.round((colWidths[c] - textW) / 2));
        const hEsc = headerText.replace(/"/g, '""');
        commands.push(
          `TEXT ${hx + offsetX},${ty + 2},"${fontName}",0,${hFont},${hFont},"${hEsc}"`
        );
      }
      hx += colWidths[c];
    }
  }

  // ── Render data cells ──
  for (let r = 0; r < maxRows; r++) {
    const cellY = ty + r * rowHeight;
    let cellX = tx;

    for (let c = 0; c < cols.length; c++) {
      const override = cellOverrides[`${r},${c}`];

      if (override?.hidden) {
        cellX += colWidths[c];
        continue;
      }

      const rawContent = override?.content || '';

      if (rawContent) {
        const fontSize = override?.font_size || cellFontSize;
        const alignment = cols[c].align || 'left';

        // Compute effective cell width (accounting for colspan)
        let cellW = colWidths[c];
        const colspan = override?.colspan || 1;
        if (colspan > 1) {
          cellW = 0;
          for (let ci = c; ci < Math.min(c + colspan, cols.length); ci++) {
            cellW += colWidths[ci];
          }
        }

        let cf = Math.max(8, fontSize);
        let textW = estimateTextWidth(rawContent, cf);

        // Auto-shrink font to fit cell width (minimum 8 dots)
        while (textW > cellW && cf > 8) {
          cf -= 1;
          textW = estimateTextWidth(rawContent, cf);
        }

        // Vertical offset: center text within row height
        const offsetY = Math.max(1, Math.round((rowHeight - cf) / 2) - Math.round(cf * 0.25));

        // Horizontal offset based on alignment
        let offsetX;
        if (textW >= cellW) {
          // Text still wider than cell after shrinking: left-align
          offsetX = 2;
        } else if (alignment === 'center') {
          offsetX = Math.max(2, Math.round((cellW - textW) / 2));
        } else if (alignment === 'right') {
          offsetX = Math.max(2, cellW - textW - 4);
        } else {
          // Left-aligned (default)
          offsetX = 2;
        }

        // Preserve spaces as-is — the printer handles them correctly
        const rawEsc = rawContent.replace(/"/g, '""');
        commands.push(
          `TEXT ${cellX + offsetX},${cellY + offsetY},"${fontName}",0,${cf},${cf},"${rawEsc}"`
        );
      }

      cellX += colWidths[c];
    }
  }

  return commands;
}

module.exports = { generateTSPL };
