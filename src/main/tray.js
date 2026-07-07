/**
 * System Tray Manager
 *
 * Creates a system tray icon with context menu for the OptiBot ERP desktop app.
 * Allows users to show/hide the main window and access common actions.
 */

const { Tray, Menu, nativeImage, app } = require('electron');
const path = require('path');
const log = require('electron-log');

class TrayManager {
  /**
   * @param {BrowserWindow} mainWindow - The main application window
   */
  constructor(mainWindow) {
    this.mainWindow = mainWindow;
    this.tray = null;
    this._create();
  }

  /**
   * Create the system tray icon and menu
   * @private
   */
  _create() {
    const iconPath = path.join(__dirname, '../../assets/tray-icon.png');

    try {
      // Create tray icon (use empty image as fallback if icon file doesn't exist)
      let icon;
      try {
        icon = nativeImage.createFromPath(iconPath);
        if (icon.isEmpty()) {
          throw new Error('Empty icon');
        }
      } catch (e) {
        // Fallback: create a small empty icon
        icon = nativeImage.createEmpty();
        log.warn('Tray icon not found, using empty icon:', iconPath);
      }

      this.tray = new Tray(icon);
      this.tray.setToolTip('OptiBot ERP');

      this._updateMenu();

      // Double-click to show window
      this.tray.on('double-click', () => {
        this._showWindow();
      });

      log.info('System tray created');
    } catch (err) {
      log.error('Failed to create system tray:', err.message);
    }
  }

  /**
   * Update the context menu
   * @private
   */
  _updateMenu() {
    if (!this.tray) return;

    const contextMenu = Menu.buildFromTemplate([
      {
        label: '显示主窗口',
        click: () => this._showWindow(),
      },
      {
        label: '隐藏主窗口',
        click: () => this._hideWindow(),
      },
      { type: 'separator' },
      {
        label: '重新加载页面',
        click: () => {
          if (this.mainWindow && !this.mainWindow.isDestroyed()) {
            this.mainWindow.webContents.reload();
          }
        },
      },
      {
        label: '开发者工具',
        click: () => {
          if (this.mainWindow && !this.mainWindow.isDestroyed()) {
            this.mainWindow.webContents.toggleDevTools();
            this._showWindow();
          }
        },
      },
      { type: 'separator' },
      {
        label: '检查更新',
        click: () => {
          if (this.mainWindow && !this.mainWindow.isDestroyed()) {
            this.mainWindow.webContents.send('menu:action', 'check-update');
          }
        },
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          app.isQuitting = true;
          app.quit();
        },
      },
    ]);

    this.tray.setContextMenu(contextMenu);
  }

  /**
   * Show the main window
   * @private
   */
  _showWindow() {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.show();
      this.mainWindow.focus();
    }
  }

  /**
   * Hide the main window
   * @private
   */
  _hideWindow() {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.hide();
    }
  }

  /**
   * Show a balloon notification (Windows only)
   */
  showBalloon() {
    if (this.tray) {
      this.tray.displayBalloon({
        title: 'OptiBot ERP',
        content: '应用程序正在后台运行，双击托盘图标可重新打开窗口。',
      });
    }
  }

  /**
   * Destroy the tray icon
   */
  destroy() {
    if (this.tray) {
      this.tray.destroy();
      this.tray = null;
    }
  }
}

module.exports = TrayManager;
