'use strict';

// Main process. Environment variables and Chromium switches have to be in place
// before app.whenReady(); they are ignored afterwards.

const fs = require('fs');
const path = require('path');
const { fileURLToPath } = require('url');
const { app, BrowserWindow, Menu, dialog, ipcMain, session, shell } = require('electron');

const logger = require('./modules/logger');
const i18n = require('./shared/i18n');
const { Settings, RESTART_KEYS } = require('./modules/settings');
const optimization = require('./config/optimization');
const gpuDetector = require('./modules/gpuDetector');
const { CpuOptimizer, FLASH_PROCESS_TYPE } = require('./modules/cpuOptimizer');
const flashManager = require('./modules/flashManager');
const { CredentialVault, MIN_MASTER_PASSWORD_LENGTH } = require('./modules/credentialVault');
const { SessionManager } = require('./modules/sessionManager');
const { AssetCache } = require('./modules/assetCache');
const { UserError } = require('./modules/errors');
const security = require('./modules/security');
const { REGIONS, isValidRegion, isValidServer } = require('./config/urls');

const IS_DEV = !app.isPackaged;
const METRICS_INTERVAL_MS = 10000;
const MEMORY_WARN_COOLDOWN_MS = 10 * 60 * 1000;

// The site serves its launcher layout to this client id.
const LAUNCHER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/87.0.4280.141 Safari/537.36 ShinobiLauncher/3.5';

// A debugging port would allow remote control of game views including filled-in
// login forms, so it is refused in release builds.
const DEBUG_SWITCHES = ['remote-debugging-port', 'remote-debugging-pipe', 'inspect', 'inspect-brk'];
if (!IS_DEV && DEBUG_SWITCHES.some((s) => app.commandLine.hasSwitch(s))) {
  console.error('Debugging options are disabled in release builds.');
  app.exit(1);
  process.exit(1);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Before "ready"
// ---------------------------------------------------------------------------
const userData = app.getPath('userData');
fs.mkdirSync(userData, { recursive: true });

const settings = new Settings(userData);
logger.init(userData, { debug: IS_DEV || settings.get('debugLog') });
const log = logger.create('main');
log.info(`start v${app.getVersion()} (${process.platform}/${process.arch}, Electron ${process.versions.electron}${IS_DEV ? ', dev' : ''})`);

const preset = optimization.resolvePreset(settings.get('preset'));
log.info(`preset ${preset.id} (setting: ${settings.get('preset')})`);

const gpu = gpuDetector.detect(path.join(userData, 'gpu-cache.json'));
gpuDetector.applyEnvVars(preset.gpuEnvProfile);
const cpuOptimizer = new CpuOptimizer(preset.cpu, settings.get('cpuOptimization'));
const flash = flashManager.locate(app);
applyChromiumSwitches();

function language() {
  return i18n.resolveLanguage(settings.get('language'), app.isReady() ? app.getLocale() : '');
}
const t = (key, params) => i18n.translate(language(), key, params);

const vault = new CredentialVault(userData);
const assetCache = new AssetCache(() => settings.get('assetCache'));
let mainWindow = null;

const sessionManager = new SessionManager({
  settings,
  vault,
  assetCache,
  preset,
  userAgent: LAUNCHER_UA,
  isDev: IS_DEV,
  t,
  notify: (type, payload) => sendToUI(type, payload),
  showLauncher: () => showMainWindow()
});

function applyChromiumSwitches() {
  const applied = [];
  const add = (name, value) => {
    if (value === undefined || value === null) app.commandLine.appendSwitch(name);
    else app.commandLine.appendSwitch(name, String(value));
    applied.push(value === undefined || value === null ? name : `${name}=${value}`);
  };
  for (const [name, value, platform] of [...optimization.COMMON_SWITCHES, ...preset.switches]) {
    if (!platform || platform === process.platform) add(name, value);
  }
  add('disable-features', optimization.COMMON_DISABLED_FEATURES.join(','));
  add('disk-cache-size', preset.diskCacheBytes);
  add('js-flags', `--max-old-space-size=${preset.maxOldSpaceMB}`);
  // laptops with two GPUs: prefer the dedicated one
  if (gpu.isHybrid && preset.id !== 'low-spec') add('force_high_performance_gpu');
  if (process.platform === 'linux' && needsNoSandboxOnLinux()) add('no-sandbox');
  if (flash.found) {
    add('ppapi-flash-path', flash.path);
    add('ppapi-flash-version', flash.version);
  }
  log.info('switches:', applied.join(' '));
}

/**
 * Electron 11 on Linux needs either user namespaces or a setuid-root
 * chrome-sandbox. Without both (AppImage on Ubuntu 24.04 with the AppArmor
 * restriction, for example) Chromium aborts at startup, so only then the
 * sandbox is turned off.
 */
function needsNoSandboxOnLinux() {
  if (process.argv.includes('--no-sandbox')) return false;
  const read = (file) => {
    try {
      return fs.readFileSync(file, 'utf8').trim();
    } catch (_) {
      return null;
    }
  };
  try {
    const st = fs.statSync(path.join(path.dirname(process.execPath), 'chrome-sandbox'));
    if (st.uid === 0 && (st.mode & 0o4000) !== 0) return false; // setuid helper in place (.deb)
  } catch (_) {
    // no helper
  }
  const usernsBlocked =
    read('/proc/sys/kernel/unprivileged_userns_clone') === '0' ||
    read('/proc/sys/kernel/apparmor_restrict_unprivileged_userns') === '1';
  if (usernsBlocked || process.env.APPIMAGE) {
    log.warn('Chromium sandbox not available (user namespaces blocked or AppImage), using --no-sandbox');
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Launcher window
// ---------------------------------------------------------------------------
const RENDERER_INDEX = path.join(__dirname, 'renderer', 'index.html');

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 780,
    minWidth: 760,
    minHeight: 560,
    title: 'Naruto Online Launcher',
    backgroundColor: '#0e0e12',
    autoHideMenuBar: true,
    show: false,
    icon: path.join(__dirname, '..', 'resources', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      enableRemoteModule: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      plugins: false,
      devTools: IS_DEV
    }
  });
  mainWindow.loadFile(RENDERER_INDEX);
  mainWindow.once('ready-to-show', () => mainWindow.show());

  const contents = mainWindow.webContents;
  contents.on('did-finish-load', applyUiScale);
  contents.on('new-window', (event, url) => {
    event.preventDefault();
    security.openExternalSafe(url);
  });
  contents.on('will-navigate', (event, url) => {
    event.preventDefault();
    log.warn(`navigation in launcher window blocked: ${url.slice(0, 120)}`);
  });
  if (IS_DEV) contents.on('before-input-event', (_e, input) => input.key === 'F12' && contents.toggleDevTools());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function showMainWindow() {
  if (!mainWindow) return createMainWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function applyUiScale() {
  if (mainWindow) mainWindow.webContents.setZoomFactor(Number(settings.get('uiScale')));
}

/** The launcher UI loads local files only; every network request of the default session is refused. */
function hardenDefaultSession() {
  const ses = session.defaultSession;
  ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    const allowed = /^(file|devtools|chrome-extension):/.test(details.url);
    if (!allowed) log.warn(`launcher UI request blocked: ${details.url.slice(0, 120)}`);
    callback({ cancel: !allowed });
  });
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  ses.setPermissionCheckHandler(() => false);
}

function sendToUI(type, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('launcher:event', { type, payload });
}

// ---------------------------------------------------------------------------
// IPC: fixed channels, launcher window only, validated input
// ---------------------------------------------------------------------------
function isRendererIndex(url) {
  try {
    const norm = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
    return norm(fileURLToPath(url)) === norm(RENDERER_INDEX);
  } catch (_) {
    return false;
  }
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    const trusted = mainWindow && event.sender === mainWindow.webContents && isRendererIndex(event.sender.getURL());
    if (!trusted) {
      log.error(`IPC from untrusted sender refused: ${event.sender.getURL()}`);
      throw new Error(`i18n:${JSON.stringify({ key: 'err.notAllowed' })}`);
    }
    try {
      return await fn(...args);
    } catch (err) {
      if (err instanceof UserError) {
        throw new Error(`i18n:${JSON.stringify({ key: err.key, params: err.params })}`);
      }
      log.warn(`IPC ${channel} failed: ${err.message}`);
      throw new Error(`i18n:${JSON.stringify({ key: 'err.generic', params: { msg: err.message } })}`);
    }
  });
}

function requireString(value, field, maxLength) {
  if (typeof value !== 'string' || value.length > maxLength) throw new UserError('err.invalidInput', { field });
  return value;
}

function requireAccount(id) {
  if (!CredentialVault.isValidId(id) || !vault.getAccount(id)) throw new UserError('err.accountNotFound');
  return vault.getAccount(id);
}

function slugify(label) {
  const base =
    label
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/ß/g, 'ss')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24) || 'account';
  let id = base;
  for (let i = 2; vault.getAccount(id); i++) id = `${base}-${i}`;
  return id;
}

function getState() {
  return {
    version: app.getVersion(),
    platform: process.platform,
    isDev: IS_DEV,
    language: language(),
    flash: {
      found: flash.found,
      path: flash.path || null,
      source: flash.source || null,
      version: flash.version || null,
      sha256: flash.sha256 || null,
      fileName: flashManager.FILE_NAME,
      searched: flash.searched.map((s) => s.path)
    },
    gpu: { vendor: gpu.vendor, name: gpu.name, vramMB: gpu.vramMB, isHybrid: gpu.isHybrid },
    cpu: cpuOptimizer.getInfo(),
    preset: { active: preset.id, autoPick: optimization.resolvePreset('auto').id },
    presets: optimization.PRESET_IDS,
    regions: Object.keys(REGIONS),
    settings: settings.getAll(),
    vault: vault.status(),
    minMasterPasswordLength: MIN_MASTER_PASSWORD_LENGTH,
    accounts: vault.listAccounts(),
    running: sessionManager.listRunning(),
    logFile: logger.getLogFile()
  };
}

function registerIpcHandlers() {
  handle('app:getState', async () => getState());

  handle('app:restart', async () => {
    log.info('restart requested');
    app.relaunch();
    app.exit(0);
  });

  handle('app:openLogs', async () => {
    const file = logger.getLogFile();
    if (file) shell.showItemInFolder(file);
    return { ok: Boolean(file) };
  });

  const settingsResult = (changed) => {
    if (changed.length) log.info('settings changed:', changed.join(', '));
    if (changed.includes('uiScale')) applyUiScale();
    if (changed.includes('language')) sessionManager.refreshLabels();
    if (changed.includes('zoomRender') || changed.includes('muteInactiveTabs')) sessionManager.refreshViews();
    return {
      settings: settings.getAll(),
      language: language(),
      restartRequired: changed.some((k) => RESTART_KEYS.includes(k))
    };
  };

  handle('settings:update', async (patch) => {
    try {
      return settingsResult(settings.update(patch));
    } catch (err) {
      throw new UserError('err.invalidInput', { field: err.message });
    }
  });

  handle('settings:reset', async () => settingsResult(settings.reset()));

  handle('flash:import', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: t('dlg.flashPick', { file: flashManager.FILE_NAME }),
      properties: ['openFile'],
      filters: [{ name: 'PPAPI Flash', extensions: [process.platform === 'win32' ? 'dll' : 'so'] }]
    });
    if (result.canceled || !result.filePaths[0]) return { ok: false, canceled: true };
    return { ok: true, path: flashManager.importPlugin(app, result.filePaths[0]), restartRequired: true };
  });

  handle('flash:openFolder', async () => {
    const dir = path.join(userData, 'flash');
    fs.mkdirSync(dir, { recursive: true });
    await shell.openPath(dir);
    return { ok: true };
  });

  handle('vault:unlock', async (password) => vault.unlock(requireString(password, 'password', 1024)));
  handle('vault:lock', async () => vault.lock());
  handle('vault:setMasterPassword', async (password) => vault.setMasterPassword(requireString(password, 'password', 1024)));
  handle('vault:removeMasterPassword', async () => vault.removeMasterPassword());
  handle('vault:reset', async () => {
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      buttons: [t('dlg.cancel'), t('dlg.resetConfirm')],
      defaultId: 0,
      cancelId: 0,
      title: t('dlg.resetTitle'),
      message: t('dlg.resetMsg'),
      detail: t('dlg.resetDetail')
    });
    return response === 1 ? vault.reset() : vault.status();
  });

  handle('accounts:save', async (input) => {
    if (!input || typeof input !== 'object') throw new UserError('err.invalidInput', { field: 'account' });
    const label = requireString(input.label, 'name', 40).trim();
    if (!label) throw new UserError('err.nameRequired');
    const region = requireString(input.region, 'region', 8);
    if (!isValidRegion(region)) throw new UserError('err.unknownRegion');
    const server = requireString(input.server || '', 'server', 8).trim();
    if (!isValidServer(server)) throw new UserError('err.serverFormat');
    const username = requireString(input.username || '', 'username', 254).trim();
    const password = requireString(input.password || '', 'password', 1024);
    const id = input.id ? requireAccount(input.id).id : slugify(label);
    await vault.saveAccount({ id, label, region, server, username, password, clearCredentials: input.clearCredentials === true });
    return { accounts: vault.listAccounts(), vault: vault.status(), id };
  });

  handle('accounts:remove', async (id) => {
    requireAccount(id);
    sessionManager.close(id);
    await vault.removeAccount(id);
    return { accounts: vault.listAccounts() };
  });

  handle('accounts:clearSession', async (id) => {
    await sessionManager.clearSessionData(requireAccount(id).id);
    return { ok: true };
  });

  handle('game:start', async (id) => {
    const account = requireAccount(id);
    if (!flash.found) throw new UserError('err.flashMissing', { file: flashManager.FILE_NAME });
    let credentials = null;
    let warning = null;
    if (account.hasCredentials && settings.get('autoLogin')) {
      if (vault.status().locked) warning = 'warn.vaultLockedNoLogin';
      else credentials = await vault.getCredentials(id);
    }
    const result = await sessionManager.launch(account, credentials);
    if (!result.reused && settings.get('minimizeOnStart') && mainWindow) mainWindow.minimize();
    return { ...result, warning };
  });

  handle('game:stop', async (id) => sessionManager.close(requireAccount(id).id));
  handle('game:clearCache', async (id) => {
    await sessionManager.clearCache(requireAccount(id).id);
    return { ok: true };
  });

  ipcMain.on('strip:action', (event, action, id) => {
    if (!['select', 'close', 'mute', 'launcher', 'ready'].includes(action) || typeof id !== 'string') return;
    sessionManager.handleStrip(event.sender, action, id);
  });
}

// ---------------------------------------------------------------------------
// Resource monitor: CPU priority for new processes, memory warnings, UI metrics
// ---------------------------------------------------------------------------
function startMetricsLoop() {
  const warnedAt = new Map();
  const tick = () => {
    let metrics;
    try {
      metrics = app.getAppMetrics();
    } catch (err) {
      log.warn('getAppMetrics failed:', err.message);
      return;
    }
    cpuOptimizer.optimize(metrics, sessionManager.getRendererPids());

    const mb = (m) => Math.round((m.memory ? m.memory.workingSetSize : 0) / 1024);
    const flashProcesses = metrics.filter((m) => m.type === FLASH_PROCESS_TYPE);
    for (const m of flashProcesses) {
      if (mb(m) > preset.flashMemoryWarnMB && Date.now() - (warnedAt.get(m.pid) || 0) > MEMORY_WARN_COOLDOWN_MS) {
        warnedAt.set(m.pid, Date.now());
        log.warn(`Flash plugin pid ${m.pid} uses ${mb(m)} MB`);
        sendToUI('memoryWarning', { mb: mb(m) });
      }
    }
    sendToUI('metrics', {
      totalMB: metrics.reduce((sum, m) => sum + mb(m), 0),
      flashMB: flashProcesses.reduce((sum, m) => sum + mb(m), 0),
      cpuPercent: Math.round(metrics.reduce((sum, m) => sum + (m.cpu ? m.cpu.percentCPUUsage : 0), 0)),
      processes: metrics.length,
      cache: assetCache.getStats()
    });
  };
  setInterval(tick, METRICS_INTERVAL_MS);
  tick();
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
app.on('second-instance', () => showMainWindow());
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-attach-webview', (e) => e.preventDefault());
});

app
  .whenReady()
  .then(async () => {
    if (!IS_DEV) Menu.setApplicationMenu(null);
    hardenDefaultSession();
    await vault.init();
    sessionManager.onChange = () => sendToUI('running', sessionManager.listRunning());
    registerIpcHandlers();
    createMainWindow();
    startMetricsLoop();
  })
  .catch((err) => {
    log.error('startup failed:', err);
    dialog.showErrorBox('Naruto Online Launcher', `${err.message}\n\n${logger.getLogFile() || ''}`);
    app.exit(1);
  });

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => assetCache.logSummary('game files'));

process.on('uncaughtException', (err) => log.error('uncaught exception:', err));
process.on('unhandledRejection', (reason) => log.error('unhandled rejection:', reason));
