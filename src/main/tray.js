/**
 * System Tray Manager
 *
 * Creates a system tray icon with context menu for the OptiBot ERP desktop app.
 * Single-click tray icon to restore window.
 */

const { Tray, Menu, nativeImage, app } = require('electron');
const path = require('path');
const log = require('electron-log');

class TrayManager {
  constructor(mainWindow) {
    this.mainWindow = mainWindow;
    this.tray = null;
    this._create();
  }

  _create() {
    const iconPath = path.join(__dirname, '../../assets/icon.ico');

    try {
      let icon = nativeImage.createFromPath(iconPath);
      if (icon.isEmpty()) {
        throw new Error('Empty icon');
      }
      icon = icon.resize({ width: 16, height: 16 });

      this.tray = new Tray(icon);
      this.tray.setToolTip('OptiBot ERP');

      this._updateMenu();

      // ★ Single click to toggle window visibility
      this.tray.on('click', () => {
        this._toggleWindow();
      });

      // Double click also works
      this.tray.on('double-click', () => {
        this._toggleWindow();
      });

      log.info('System tray created');
    } catch (err) {
      log.error('Failed to create system tray:', err.message);
    }
  }

  _updateMenu() {
    if (!this.tray) return;

    const contextMenu = Menu.buildFromTemplate([
      {
        label: '显示主窗口',
        click: () => this._showWindow(),
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
        label: '退出',
        click: () => {
          // ★ Must set the global flag so close handler allows quit
          global.isQuitting = true;
          app.quit();
        },
      },
    ]);

    this.tray.setContextMenu(contextMenu);
  }

  /**
   * Toggle window: if hidden → show, if shown → hide
   */
  _toggleWindow() {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;

    if (this.mainWindow.isVisible()) {
      this.mainWindow.hide();
    } else {
      this._showWindow();
    }
  }

  /**
   * Show and restore window to original size
   */
  _showWindow() {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;

    // Restore if minimized
    if (this.mainWindow.isMinimized()) {
      this.mainWindow.restore();
    }

    // Show and focus
    this.mainWindow.show();
    this.mainWindow.focus();

    // Bring to front on Windows
    if (process.platform === 'win32') {
      this.mainWindow.setAlwaysOnTop(true);
      setTimeout(() => {
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
          this.mainWindow.setAlwaysOnTop(false);
        }
      }, 100);
    }
  }

  _hideWindow() {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.hide();
    }
  }

  showBalloon() {
    if (this.tray) {
      this.tray.displayBalloon({
        title: 'OptiBot ERP',
        content: '应用程序正在后台运行，单击托盘图标可重新打开窗口。',
      });
    }
  }

  destroy() {
    if (this.tray) {
      this.tray.destroy();
      this.tray = null;
    }
  }
}

module.exports = TrayManager;
