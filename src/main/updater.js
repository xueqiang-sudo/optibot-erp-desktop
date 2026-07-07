/**
 * Auto-Updater Service
 *
 * Uses electron-updater to check for and install application updates.
 * Supports NSIS installer updates on Windows.
 *
 * Update server configuration should be set in electron-builder.json
 * or via environment variables.
 */

const { app, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');
const log = require('electron-log');

class UpdaterService {
  /**
   * @param {BrowserWindow} mainWindow - The main application window
   */
  constructor(mainWindow) {
    this.mainWindow = mainWindow;
    this.updateAvailable = false;
    this.updateDownloaded = false;

    this._setupListeners();
  }

  /**
   * Set up auto-updater event listeners
   * @private
   */
  _setupListeners() {
    // Configure auto-updater
    autoUpdater.logger = log;
    autoUpdater.logger.transports.file.level = 'info';
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on('checking-for-update', () => {
      log.info('Checking for updates...');
    });

    autoUpdater.on('update-available', (info) => {
      log.info('Update available:', info.version);
      this.updateAvailable = true;

      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send('menu:action', 'update-available');
      }

      dialog.showMessageBox(this.mainWindow, {
        type: 'info',
        title: '发现新版本',
        message: `发现新版本 ${info.version}，正在后台下载...`,
        buttons: ['确定'],
      });
    });

    autoUpdater.on('update-not-available', () => {
      log.info('No updates available');
      this.updateAvailable = false;
    });

    autoUpdater.on('download-progress', (progress) => {
      log.debug(
        `Download progress: ${progress.percent.toFixed(1)}% (${progress.transferred}/${progress.total} bytes)`
      );
    });

    autoUpdater.on('update-downloaded', (info) => {
      log.info('Update downloaded:', info.version);
      this.updateDownloaded = true;

      dialog
        .showMessageBox(this.mainWindow, {
          type: 'info',
          title: '更新已下载',
          message: `新版本 ${info.version} 已下载完成。是否立即安装并重启？`,
          buttons: ['立即重启', '稍后安装'],
          defaultId: 0,
          cancelId: 1,
        })
        .then((result) => {
          if (result.response === 0) {
            autoUpdater.quitAndInstall();
          }
        });
    });

    autoUpdater.on('error', (err) => {
      log.error('Auto-updater error:', err.message);

      // Don't show error dialog for common network errors
      if (
        err.message.includes('net') ||
        err.message.includes('timeout') ||
        err.message.includes('ENOTFOUND')
      ) {
        log.warn('Network error during update check, will retry later');
        return;
      }

      dialog.showMessageBox(this.mainWindow, {
        type: 'error',
        title: '更新错误',
        message: `更新过程中出现错误：${err.message}`,
        buttons: ['确定'],
      });
    });
  }

  /**
   * Check for updates
   * @returns {Promise<void>}
   */
  async checkForUpdates() {
    if (app.isPackaged) {
      try {
        await autoUpdater.checkForUpdates();
      } catch (err) {
        log.warn('Update check failed:', err.message);
      }
    } else {
      log.info('Skipping update check (development mode)');
    }
  }

  /**
   * Set the update feed URL
   * @param {string} url - URL to the update server
   */
  setFeedURL(url) {
    autoUpdater.setFeedURL({
      provider: 'generic',
      url: url,
    });
  }
}

module.exports = UpdaterService;
