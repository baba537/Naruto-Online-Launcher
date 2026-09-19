'use strict';

// A game window. Every account is a BrowserView inside it; in tab mode several
// accounts share one window with a tab strip on top, otherwise each window
// holds a single view and no strip.
//
// Inactive tabs are moved out of the visible area instead of being detached,
// so their game keeps running at full speed like a separate window would.

const path = require('path');
const { BrowserWindow, dialog } = require('electron');
const log = require('./logger').create('host');

const STRIP_HEIGHT = 36;

class GameHost {
  /**
   * @param {object} opts
   * @param {boolean} opts.tabbed show the tab strip and accept more tabs
   * @param {{width: number, height: number}} opts.size
   * @param {(key: string, params?: object) => string} opts.t translation
   * @param {(host: GameHost) => void} opts.onClosed
   * @param {() => void} opts.onShowLauncher
   * @param {(width: number, height: number) => void} opts.onResize
   * @param {boolean} opts.isDev
   */
  constructor(opts) {
    this.opts = opts;
    this.tabbed = opts.tabbed;
    this.tabs = []; // GameSession objects, see sessionManager.js
    this.active = null;
    this.closing = false;
    this.stripReady = false; // set once tabs.js has registered its listener

    this.win = new BrowserWindow({
      width: opts.size.width,
      height: opts.size.height + (this.tabbed ? STRIP_HEIGHT : 0),
      useContentSize: true,
      minWidth: 800,
      minHeight: 550,
      title: 'Naruto Online',
      backgroundColor: '#000000',
      autoHideMenuBar: true,
      show: false,
      icon: path.join(__dirname, '..', '..', 'resources', 'icon.png'),
      webPreferences: {
        preload: path.join(__dirname, '..', 'tabsPreload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        enableRemoteModule: false,
        sandbox: true,
        spellcheck: false,
        devTools: opts.isDev
      }
    });
    this.win.setMenu(null);
    this.win.loadFile(path.join(__dirname, '..', 'renderer', 'tabs.html'));
    this.win.webContents.on('will-navigate', (e) => e.preventDefault());
    this.win.webContents.on('new-window', (e) => e.preventDefault());
    this.win.once('ready-to-show', () => {
      if (opts.isMaximized) this.win.maximize();
      this.win.show();
    });
    this.win.on('maximize', () => opts.onMaximizedChange(true));
    this.win.on('unmaximize', () => opts.onMaximizedChange(false));

    this.win.on('resize', () => {
      this.layout();
      if (!this.win.isMaximized() && !this.win.isFullScreen()) {
        const [w, h] = this.win.getContentSize();
        opts.onResize(w, h - this.stripHeight());
      }
    });
    this.win.on('enter-full-screen', () => this.layout());
    this.win.on('leave-full-screen', () => this.layout());
    this.win.on('close', (event) => this._onClose(event));
    this.win.on('closed', () => opts.onClosed(this));
  }

  get stripContents() {
    return this.win.isDestroyed() ? null : this.win.webContents;
  }

  stripHeight() {
    return this.tabbed && !this.win.isFullScreen() ? STRIP_HEIGHT : 0;
  }

  canTakeTabs() {
    return this.tabbed && !this.closing && !this.win.isDestroyed();
  }

  addTab(session) {
    this.tabs.push(session);
    session.host = this;
    this.win.addBrowserView(session.view);
    this.select(session);
  }

  /** Removes a tab without destroying its view (the session does that). */
  removeTab(session) {
    const index = this.tabs.indexOf(session);
    if (index === -1) return;
    this.tabs.splice(index, 1);
    if (!this.win.isDestroyed()) {
      try {
        this.win.removeBrowserView(session.view);
      } catch (_) {
        // already gone
      }
    }
    if (this.active === session) this.active = this.tabs[Math.min(index, this.tabs.length - 1)] || null;
    if (this.tabs.length === 0) {
      if (!this.closing && !this.win.isDestroyed()) {
        this.closing = true;
        this.win.close();
      }
      return;
    }
    this.layout();
    this.pushState();
  }

  select(session) {
    if (!this.tabs.includes(session)) return;
    this.active = session;
    this.layout();
    for (const tab of this.tabs) tab.applyAudio();
    this.pushState();
    if (!session.view.webContents.isDestroyed()) session.view.webContents.focus();
  }

  cycle(step) {
    if (this.tabs.length < 2) return;
    const index = this.tabs.indexOf(this.active);
    this.select(this.tabs[(index + step + this.tabs.length) % this.tabs.length]);
  }

  focus() {
    if (this.win.isDestroyed()) return;
    if (this.win.isMinimized()) this.win.restore();
    this.win.focus();
  }

  toggleFullScreen() {
    this.win.setFullScreen(!this.win.isFullScreen());
  }

  layout() {
    if (this.win.isDestroyed()) return;
    const [width, height] = this.win.getContentSize();
    const top = this.stripHeight();
    const visible = { x: 0, y: top, width, height: Math.max(0, height - top) };
    // keep the size, only move away: Flash does not have to re-layout on tab switches
    const parked = { x: -width - 100, y: top, width, height: visible.height };
    for (const tab of this.tabs) {
      tab.view.setBounds(tab === this.active ? visible : parked);
    }
    if (this.active) this.win.setTitle(this.active.title());
  }

  pushState() {
    const contents = this.stripContents;
    if (!contents || !this.stripReady) return;
    contents.send('strip:state', {
      tabs: this.tabs.map((s) => ({
        id: s.id,
        label: s.label,
        active: s === this.active,
        muted: s.muted,
        login: s.login
      })),
      labels: {
        mute: this.opts.t('tabs.mute'),
        unmute: this.opts.t('tabs.unmute'),
        close: this.opts.t('tabs.close'),
        launcher: this.opts.t('tabs.launcher')
      }
    });
  }

  _onClose(event) {
    if (!this.closing && this.tabs.length > 1) {
      const choice = dialog.showMessageBoxSync(this.win, {
        type: 'question',
        buttons: [this.opts.t('dlg.cancel'), this.opts.t('dlg.closeTabsConfirm')],
        defaultId: 1,
        cancelId: 0,
        title: this.opts.t('dlg.closeTabsTitle'),
        message: this.opts.t('dlg.closeTabsMsg', { n: this.tabs.length })
      });
      if (choice !== 1) {
        event.preventDefault();
        return;
      }
    }
    this.closing = true;
    // Destroying the views skips the page's beforeunload handler, which would
    // otherwise cancel the close without any visible dialog.
    for (const tab of this.tabs.slice()) tab.destroy();
    log.info('window closed');
  }
}

module.exports = { GameHost, STRIP_HEIGHT };
