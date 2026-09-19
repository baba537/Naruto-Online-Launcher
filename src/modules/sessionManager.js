'use strict';

// Game sessions: one isolated partition (persist:account_<id>) per account with
// its own cookies, cache and login. Sessions live as views inside GameHost
// windows, either as tabs of one window or one window each.

const fs = require('fs');
const path = require('path');
const { app, BrowserView, BrowserWindow, session } = require('electron');
const log = require('./logger').create('session');
const security = require('./security');
const flashManager = require('./flashManager');
const autoLogin = require('./autoLogin');
const { GameHost } = require('./gameHost');
const { UserError } = require('./errors');
const { resolveFlashQuality } = require('../config/optimization');
const { getGameUrl, hostMatches, GAME_DOMAINS, LAUNCHER_PARAMS } = require('../config/urls');

const LOGIN_WORLD_ID = 1001;
const ZOOM_WORLD_ID = 1002;
const LOGIN_WAIT_MS = 25000;
const CRASH_WINDOW_MS = 10 * 60 * 1000;
const MAX_RECOVERIES = 3;
const ZOOM_MIN = 0.4;
const ZOOM_MAX = 3;
// Server pages of the game. The site opens them with window.open; inside the
// launcher they replace the server list in the same tab instead.
const SERVER_PAGE_RE = /^https:\/\/[a-z0-9.-]*narutowebgame\.com\/[a-z]{2}\/serverlist\/s\d+/i;

function partitionFor(accountId) {
  return `persist:account_${accountId}`;
}

/** Data folder of a persist: partition (Chromium lower-cases it below Partitions/). */
function partitionDir(accountId) {
  return path.join(app.getPath('userData'), 'Partitions', `account_${accountId}`.toLowerCase());
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch (_) {
    return '';
  }
}

class GameSession {
  constructor(manager, account, credentials) {
    this.manager = manager;
    this.id = account.id;
    this.label = account.label;
    this.account = account;
    this.credentials = credentials;
    this.zoom = account.zoom || 1;
    this.muted = Boolean(account.muted); // set by the user, saved per account
    this.login = credentials ? 'pending' : 'none';
    this.loginAttempted = false;
    this.targetUrl = getGameUrl(account.region, account.server);
    this.crashes = [];
    this.destroyed = false;
    this.host = null;

    const partition = partitionFor(this.id);
    this.ses = session.fromPartition(partition);
    this.view = new BrowserView({ webPreferences: manager.gameWebPreferences(partition) });
    this.view.setBackgroundColor('#000000');
    this.contents = this.view.webContents;
    // WebRTC would reveal local network addresses to the page; the game does not use it.
    this.contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
    this._wire();
    this.applyAudio();
  }

  title() {
    const server = this.account.server ? ` (S${String(this.account.server).replace(/^s/i, '')})` : '';
    const zoom = this.zoom !== 1 ? ` · ${Math.round(this.zoom * 100)} %` : '';
    return `Naruto Online – ${this.label}${server}${zoom}`;
  }

  async start() {
    const listUrl = getGameUrl(this.account.region, '');
    let url = this.targetUrl;
    if (this.credentials) {
      if (await autoLogin.hasValidLogin(this.ses)) {
        this._setLogin('ok');
        log.info(`"${this.id}": still signed in`);
      } else {
        // the form on the server list is the reliable one; the server opens afterwards
        url = listUrl;
      }
    }
    log.info(`starting "${this.id}" -> ${url}`);
    try {
      await this.contents.loadURL(url);
    } catch (err) {
      // ERR_ABORTED happens on redirects (e.g. the Cloudflare check) and is harmless
      if (!/ERR_ABORTED/.test(err.message)) {
        log.error(`game page failed to load: ${err.message}`);
        throw new UserError('err.pageUnreachable', { msg: err.message.replace(/ loading '.*'$/, '') });
      }
    }
  }

  _setLogin(state) {
    if (this.login === state) return;
    this.login = state;
    this.manager.changed();
    if (state === 'failed') this.manager.notify('loginFailed', { name: this.label });
  }

  async _tryLogin() {
    if (this.login !== 'pending' || this.loginAttempted || this.destroyed) return;
    if (!hostMatches(hostOf(this.contents.getURL()), GAME_DOMAINS)) return;
    if (!this.manager.settings.get('autoLogin')) return;
    this.loginAttempted = true; // one attempt per start: no lockouts on a wrong password

    let result;
    try {
      result = await this.contents.executeJavaScriptInIsolatedWorld(LOGIN_WORLD_ID, [
        { code: autoLogin.buildLoginScript(this.credentials.username, this.credentials.password) }
      ]);
    } catch (err) {
      log.warn(`"${this.id}": login script failed: ${err.message}`);
      this._setLogin('failed');
      return;
    }
    log.info(`"${this.id}": login form ${result}`);

    const deadline = Date.now() + (result === 'no-form' ? 3000 : LOGIN_WAIT_MS);
    while (Date.now() < deadline && !this.destroyed) {
      if (await autoLogin.hasValidLogin(this.ses)) {
        this._setLogin('ok');
        log.info(`"${this.id}": signed in`);
        // The page keeps showing the form until it is loaded again; give its own
        // redirect a moment first, then open the server or reload the list.
        await new Promise((r) => setTimeout(r, 500));
        if (this.destroyed) return;
        const current = this.contents.getURL();
        if (SERVER_PAGE_RE.test(current)) return;
        if (current === this.targetUrl) this.contents.reload();
        else await this.contents.loadURL(this.targetUrl).catch(() => {});
        return;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    if (!this.destroyed) this._setLogin('failed');
  }

  _wire() {
    const c = this.contents;
    const m = this.manager;

    security.guardNavigation(c);
    m.handlePopups(c, partitionFor(this.id), this);

    // A beforeunload handler of the game would silently block reload and close.
    c.on('will-prevent-unload', (event) => event.preventDefault());

    c.on('dom-ready', () => this._applyZoom());
    c.on('did-finish-load', () => {
      this._applyZoom();
      this._tryLogin();
    });
    c.on('page-title-updated', (event) => event.preventDefault());

    c.on('console-message', (_e, _level, message) => {
      if (typeof message === 'string' && message.startsWith('[nol]')) log.info(`"${this.id}": ${message.slice(6)}`);
    });

    c.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
      if (isMainFrame && code !== -3) log.warn(`"${this.id}": load failed (${code} ${desc}): ${url}`);
    });
    c.on('plugin-crashed', (_e, name, version) => {
      log.error(`"${this.id}": plugin crashed: ${name} ${version}`);
      this._recover('plugin');
    });
    c.on('render-process-gone', (_e, details) => {
      if (this.destroyed) return;
      log.error(`"${this.id}": renderer gone: ${details.reason} (exit code ${details.exitCode})`);
      if (details.reason !== 'clean-exit') this._recover('renderer');
    });

    c.on('enter-html-full-screen', () => this.host && this.host.win.setFullScreen(true));
    c.on('leave-html-full-screen', () => this.host && this.host.win.setFullScreen(false));

    c.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return;
      const ctrl = input.control || input.meta;
      const key = input.key;
      if (key === 'F11') this.host && this.host.toggleFullScreen();
      else if (key === 'F5') c.reload();
      else if (ctrl && (key === '+' || key === '=')) this.setZoom(this.zoom + this._zoomStep());
      else if (ctrl && key === '-') this.setZoom(this.zoom - this._zoomStep());
      else if (ctrl && key === '0') this.setZoom(1);
      else if (ctrl && key === 'Tab') this.host && this.host.cycle(input.shift ? -1 : 1);
      else if (ctrl && key.toLowerCase() === 'm') this.toggleMute();
      else if (key === 'F9') this.screenshot();
      else if (key === 'F12' && m.isDev) c.toggleDevTools();
      else return;
      event.preventDefault();
    });
  }

  _recover(kind) {
    if (this.destroyed || !this.manager.settings.get('autoRecover')) return;
    const now = Date.now();
    this.crashes = this.crashes.filter((t) => now - t < CRASH_WINDOW_MS);
    if (this.crashes.length >= MAX_RECOVERIES) {
      log.warn(`"${this.id}": ${this.crashes.length} crashes in 10 minutes, no further automatic reload`);
      return;
    }
    this.crashes.push(now);
    setTimeout(() => {
      if (this.destroyed || this.contents.isDestroyed()) return;
      log.info(`"${this.id}": reloading after ${kind} crash`);
      this.contents.reload();
      this.manager.notify('crashRecovered', { name: this.label });
    }, 1500);
  }

  /**
   * The game map shows thin seams at some page zoom levels (110 %, 130 %, ...).
   * Sharp zoom therefore moves in 20 % steps; smooth zoom does not have the
   * problem and uses 10 % steps.
   */
  _zoomStep() {
    return this.manager.settings.get('zoomRender') === 'sharp' ? 0.2 : 0.1;
  }

  setZoom(value) {
    const step = this._zoomStep();
    this.zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(Math.round(value / step) * step * 10) / 10));
    this._applyZoom();
    this.manager.vault.setPrefs(this.id, { zoom: this.zoom });
    if (this.host) this.host.layout();
  }

  /**
   * Two ways to enlarge the game:
   *   sharp   Chromium page zoom. Flash renders at the larger size; vector
   *           shapes stay crisp, but bitmaps are enlarged pixel by pixel.
   *   smooth  Flash renders at its normal size and the page is scaled with a
   *           CSS transform, which the GPU filters. Softer, no blocky pixels,
   *           and less work for Flash. Mouse input follows the transform.
   */
  _applyZoom() {
    if (this.contents.isDestroyed()) return;
    const smooth = this.manager.settings.get('zoomRender') === 'smooth';
    const pageZoom = smooth ? 1 : this.zoom;
    if (this.contents.getZoomFactor() !== pageZoom) this.contents.setZoomFactor(pageZoom);
    const scale = smooth ? this.zoom : 1;
    const code = `(function (z) {
      var s = document.documentElement && document.documentElement.style;
      if (!s) return;
      if (z === 1) {
        ['transform', 'transform-origin', 'width', 'height', 'overflow'].forEach(function (p) { s.removeProperty(p); });
        return;
      }
      s.setProperty('overflow', 'hidden', 'important');
      s.setProperty('transform-origin', '0 0', 'important');
      s.setProperty('transform', 'scale(' + z + ')', 'important');
      s.setProperty('width', 'calc(100vw / ' + z + ')', 'important');
      s.setProperty('height', 'calc(100vh / ' + z + ')', 'important');
    })(${scale});`;
    this.contents.executeJavaScriptInIsolatedWorld(ZOOM_WORLD_ID, [{ code }]).catch(() => {});
  }

  async screenshot() {
    try {
      const image = await this.contents.capturePage();
      const dir = path.join(app.getPath('pictures'), 'Naruto Online');
      fs.mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
      const file = path.join(dir, `${this.id}-${stamp}.png`);
      fs.writeFileSync(file, image.toPNG());
      log.info(`screenshot saved: ${file}`);
      this.manager.notify('screenshot', { file });
    } catch (err) {
      log.warn(`screenshot failed: ${err.message}`);
    }
  }

  toggleMute() {
    this.muted = !this.muted;
    this.manager.vault.setPrefs(this.id, { muted: this.muted });
    this.applyAudio();
    if (this.host) this.host.pushState();
  }

  /** Silent when muted by the user, or when it is a background tab and only the active tab should play. */
  applyAudio() {
    if (this.contents.isDestroyed()) return;
    const background =
      this.manager.settings.get('muteInactiveTabs') && this.host && this.host.tabbed && this.host.active !== this;
    this.contents.setAudioMuted(this.muted || Boolean(background));
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.host) this.host.removeTab(this);
    if (!this.contents.isDestroyed()) this.contents.destroy();
    this.manager.sessionClosed(this);
  }
}

class SessionManager {
  /**
   * @param {object} deps settings, vault, assetCache, preset, userAgent, isDev,
   *                      t (translate), notify(type, payload), showLauncher()
   */
  constructor(deps) {
    Object.assign(this, deps);
    this.sessions = new Map();
    this.hosts = new Set();
    this.lastHost = null;
    this.onChange = () => {};
  }

  gameWebPreferences(partition) {
    const quality = resolveFlashQuality(this.preset, this.settings.getAll());
    return {
      partition,
      preload: path.join(__dirname, '..', 'gamePreload.js'),
      additionalArguments: [
        `--nol-flash-quality=${quality}`,
        `--nol-debug=${require('./logger').isDebug() ? 1 : 0}`
      ],
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: true, // runs the preload (not Node) in the game iframe as well
      enableRemoteModule: false,
      // Flash runs in its own plugin process, so the page renderer can stay sandboxed.
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      plugins: true,
      spellcheck: false,
      backgroundThrottling: false,
      devTools: this.isDev
    };
  }



  changed() {
    for (const host of this.hosts) host.pushState();
    this.onChange();
  }

  async launch(account, credentials) {
    const existing = this.sessions.get(account.id);
    if (existing) {
      existing.host.select(existing);
      existing.host.focus();
      return { ok: true, reused: true };
    }

    const partition = partitionFor(account.id);
    const ses = session.fromPartition(partition);
    security.hardenGameSession(ses, () => ({
      blockTrackers: this.settings.get('blockTrackers'),
      strictNetwork: this.settings.get('strictNetwork')
    }));
    this.assetCache.attach(ses);
    autoLogin.keepLoginCookie(ses);
    ses.setUserAgent(this.userAgent);
    if (this.settings.get('manageMmsCfg')) {
      flashManager.writeMmsCfg(partitionDir(account.id), this.preset.flash.hardwareAcceleration);
    }

    const gameSession = new GameSession(this, account, credentials);
    this.sessions.set(account.id, gameSession);
    this._hostFor().addTab(gameSession);
    this.changed();

    try {
      await gameSession.start();
    } catch (err) {
      gameSession.destroy();
      throw err;
    }
    return { ok: true, reused: false };
  }

  _hostFor() {
    const tabbed = this.settings.get('tabbedWindows');
    if (tabbed && this.lastHost && this.hosts.has(this.lastHost) && this.lastHost.canTakeTabs()) {
      this.lastHost.focus();
      return this.lastHost;
    }
    const host = new GameHost({
      tabbed,
      isDev: this.isDev,
      size: { width: this.settings.get('gameWidth'), height: this.settings.get('gameHeight') },
      t: this.t,
      onClosed: (h) => {
        this.hosts.delete(h);
        if (this.lastHost === h) this.lastHost = [...this.hosts].pop() || null;
      },
      onShowLauncher: this.showLauncher,
      isMaximized: this.settings.get('gameMaximized'),
      onMaximizedChange: (maximized) => {
        try {
          this.settings.update({ gameMaximized: maximized });
        } catch (_) {
          // ignore
        }
      },
      onResize: (width, height) => {
        try {
          this.settings.update({ gameWidth: width, gameHeight: height });
        } catch (_) {
          // size outside the allowed range
        }
      }
    });
    host.win.on('focus', () => {
      if (host.tabbed) this.lastHost = host;
    });
    this.hosts.add(host);
    this.lastHost = host;
    return host;
  }

  /**
   * window.open from game pages. Server pages replace the current page of the
   * tab; sign-in popups (Google, Facebook) and other game pages (shop, support)
   * get their own window; everything else opens in the system browser.
   */
  handlePopups(contents, partition, owner) {
    contents.on('new-window', (event, url, _frameName, disposition, options) => {
      event.preventDefault();
      if (owner && SERVER_PAGE_RE.test(url)) {
        // keep the launcher parameters, without them the site shows its "download the launcher" bar
        const target = url.includes('launcher=') ? url : `${url}${url.includes('?') ? '&' : '?'}${LAUNCHER_PARAMS}`;
        log.info(`"${owner.id}": opening server in the tab: ${target.slice(0, 160)}`);
        contents.loadURL(target).catch(() => {});
        return;
      }
      const inApp = url === 'about:blank' || security.isGameUrl(url) || security.isAuthPopupUrl(url);
      if (!inApp || disposition === 'save-to-disk') {
        security.openExternalSafe(url);
        return;
      }
      const { preload, additionalArguments, ...popupPreferences } = this.gameWebPreferences(partition);
      const popup = new BrowserWindow({
        width: options.width || 900,
        height: options.height || 700,
        webContents: options.webContents,
        autoHideMenuBar: true,
        show: false,
        webPreferences: popupPreferences
      });
      popup.setMenu(null);
      security.guardNavigation(popup.webContents);
      popup.webContents.on('will-prevent-unload', (e) => e.preventDefault());
      this.handlePopups(popup.webContents, partition);
      popup.once('ready-to-show', () => popup.show());
      // loading it ourselves keeps window.opener, which sign-in flows rely on
      if (!options.webContents) popup.loadURL(url);
      event.newGuest = popup;
      log.info(`popup: ${url.slice(0, 120)}`);
    });
  }

  handleStrip(sender, action, id) {
    const host = [...this.hosts].find((h) => h.stripContents === sender);
    if (!host) return;
    if (action === 'launcher') {
      this.showLauncher();
      return;
    }
    if (action === 'ready') {
      host.stripReady = true;
      host.pushState();
      return;
    }
    const target = host.tabs.find((s) => s.id === id);
    if (!target) return;
    if (action === 'select') host.select(target);
    else if (action === 'close') target.destroy();
    else if (action === 'mute') target.toggleMute();
  }

  sessionClosed(gameSession) {
    if (this.sessions.get(gameSession.id) === gameSession) this.sessions.delete(gameSession.id);
    log.info(`closed "${gameSession.id}"`);
    this.assetCache.logSummary('game files');
    this.changed();
  }

  close(accountId) {
    const s = this.sessions.get(accountId);
    if (s) s.destroy();
    return { ok: true };
  }

  closeAll() {
    for (const s of [...this.sessions.values()]) s.destroy();
  }

  getRendererPids() {
    const pids = new Set();
    for (const s of this.sessions.values()) {
      try {
        pids.add(s.contents.getOSProcessId());
      } catch (_) {
        // not started yet
      }
    }
    return pids;
  }

  listRunning() {
    return [...this.sessions.values()].map((s) => ({ id: s.id, login: s.login }));
  }

  async clearCache(accountId) {
    await session.fromPartition(partitionFor(accountId)).clearCache();
    log.info(`cache cleared: ${accountId}`);
  }

  /** Deletes cookies and storage of an account (sign out). The game must be closed. */
  async clearSessionData(accountId) {
    if (this.sessions.has(accountId)) throw new UserError('err.closeFirst');
    const ses = session.fromPartition(partitionFor(accountId));
    await ses.clearStorageData();
    await ses.clearCache();
    log.info(`session data deleted: ${accountId}`);
  }

  /** Re-sends translated labels to all tab strips after a language change. */
  refreshLabels() {
    for (const host of this.hosts) host.pushState();
  }

  /** Applies changed zoom or audio settings to running games. */
  refreshViews() {
    for (const s of this.sessions.values()) {
      s.setZoom(s.zoom);
      s.applyAudio();
    }
  }
}

module.exports = { SessionManager, partitionFor };
