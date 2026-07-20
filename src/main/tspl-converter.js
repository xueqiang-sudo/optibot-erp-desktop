/**
 * TSPL Converter — Pure JavaScript JSON-to-TSPL command string generator
 *
 * Replaces TSCLIB.dll (koffi FFI) with pure JS string generation.
 * The output is a complete TSPL program that can be sent directly to a
 * TSC label printer via the Windows Spooler API in RAW mode.
 *
 * TSPL reference: TSC Auto ID Programming Manual
 *
 * Coordinate system:
 * - Input JSON uses millimeters for all positions/sizes
 * - Output TSPL uses dots (printer resolution units)
 * - Conversion: dots = mm × (dpi / 25.4)
 *
 * Font handling:
 * - Chinese text uses printer-stored fonts (e.g., "CHK", "SimsunEx")
 * - Font name is referenced directly in TEXT commands
 * - No separate font download/mapping step needed
 */

const log = require('electron-log');

/**
 * Generate a complete TSPL command string from a label configuration object.
 *
 * @param {Object} config - Label configuration (same format as TSCLIB wrapper input)
 * @param {number} config.width - Label width in mm
 * @param {number} config.height - Label height in mm
 * @param {number} [config.dpi=203] - Printer DPI (dots per inch)
 * @param {number} [config.copies=1] - Number of copies to print
 * @param {Array} config.elements - Array of label elements
 * @returns {string} Complete TSPL command string (newline-separated)
 */
function generateTSPL(config) {
  const { width, height, dpi = 203, copies = 1, elements } = config;
  const dpm = dpi / 25.4; // dots per millimeter

  const commands = [];

  // ── Label setup ──
  // SIZE: label dimensions in mm
  commands.push(`SIZE ${width} mm, ${height} mm`);
  // GAP: 4mm gap, 8mm offset (standard for TSC label printers)
  commands.push('GAP 4 mm,8');
  // DIRECTION: 0 = normal printing direction
  commands.push('DIRECTION 0');
  // REFERENCE: origin at 0,0
  commands.push('REFERENCE 0,0');
  // CODEPAGE: UTF-8 encoding for Chinese text support
  commands.push('CODEPAGE UTF-8');
  // CLS: clear the image buffer
  commands.push('CLS');

  // ── Render each element ──
  if (elements && Array.isArray(elements)) {
    for (let i = 0; i < elements.length; i++) {
      const el = elements[i];
      const x = Math.round((el.x || 0) * dpm);
      const y = Math.round((el.y || 0) * dpm);

      try {
        const elCommands = renderElement(el, x, y, dpm);
        commands.push(...elCommands);
      } catch (err) {
        log.error(`[TSPL-Converter] Element ${i} (${el.type}): ${err.message}`);
      }
    }
  }

  // ── Print ──
  // PRINT: print 1 label set, N copies
  commands.push(`PRINT 1,${copies}`);

  const tsplString = commands.join('\r\n') + '\r\n';

  log.info(
    `[TSPL-Converter] Generated ${commands.length} commands, ${tsplString.length} chars`
  );
  log.debug(`[TSPL-Converter] Output preview:\n${commands.slice(0, 10).join('\r\n')}`);

  return tsplString;
}

/**
 * Render a single label element to an array of TSPL command strings.
 *
 * @param {Object} el - Element descriptor
 * @param {number} x - X position in dots
 * @param {number} y - Y position in dots
 * @param {number} dpm - Dots per millimeter
 * @returns {string[]} Array of TSPL command strings
 */
function renderElement(el, x, y, dpm) {
  switch (el.type) {
    case 'text':
    case 'date':
      return renderText(el, x, y);

    case 'barcode':
      if (el.barcodeType === 'QR') {
        // Delegate to QR code renderer
        return renderQRCode({ ...el, type: 'qrcode' }, x, y);
      }
      return renderBarcode(el, x, y);

    case 'qrcode':
      return renderQRCode(el, x, y);

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
 * - font: printer-stored font name (e.g., "CHK", "SimsunEx")
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
  const fontName = el.font_name || 'CHK';
  const rotation = el.rotation || 0;
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
 * Render a QR code element.
 *
 * TSPL QRCODE command: QRCODE x,y,EClevel,cellSize,mode,rotation,"content"
 * - EClevel: L/M/Q/H error correction
 * - cellSize: size of each QR module in dots
 * - mode: A=auto
 * - rotation: 0/90/180/270
 *
 * GS1 mode: prepend ">8" to content (GS1 Application Identifier prefix)
 *
 * @param {Object} el - QR code element
 * @param {number} x - X in dots
 * @param {number} y - Y in dots
 * @returns {string[]}
 */
function renderQRCode(el, x, y) {
  let content = el.content || '';
  if (!content) return [];

  if (el.gs1) {
    content = '>8' + content;
  }
  content = content.replace(/"/g, '""');

  const size = el.size || 6;

  return [`QRCODE ${x},${y},L,${size},A,0,"${content}"`];
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
  const fontName = el.font_name || 'CHK';

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
  // Estimates rendered text width in dots based on font size and character encoding.
  // Multi-byte UTF-8 characters (Chinese) are wider than ASCII characters.
  const estimateTextWidth = (text, fontSize) => {
    const charWidth = Math.max(8, fontSize);
    let width = 0;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      // UTF-8 byte length approximation:
      // ASCII (≤0x7F) = 1 byte, 2-byte (≤0x7FF) = 2 bytes, 3-byte (≤0xFFFF) = 3 bytes
      const byteLen = code <= 0x7f ? 1 : code <= 0x7ff ? 2 : 3;
      width += byteLen * charWidth;
    }
    return width;
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

        const cf = Math.max(8, fontSize);
        const textW = estimateTextWidth(rawContent, fontSize);

        // Vertical offset: center text within row height
        const offsetY = Math.max(1, Math.round((rowHeight - cf) / 2) - Math.round(cf * 0.25));

        // Horizontal offset based on alignment
        let offsetX;
        if (textW >= cellW) {
          // Text wider than cell: center it (overflow both sides)
          offsetX = Math.max(0, Math.round((cellW - textW) / 2));
        } else if (alignment === 'center') {
          offsetX = Math.max(2, Math.round((cellW - textW) / 2));
        } else if (alignment === 'right') {
          offsetX = Math.max(2, cellW - textW - 4);
        } else {
          // Left-aligned (default)
          offsetX = 2;
        }

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
