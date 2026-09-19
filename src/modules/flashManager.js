'use strict';

// Finds the PPAPI Flash plugin, imports a user-selected copy and writes a
// per-session mms.cfg.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const log = require('./logger').create('flash');
const { UserError } = require('./errors');

const FILE_NAME = process.platform === 'win32' ? 'pepflashplayer.dll' : 'libpepflashplayer.so';
const FALLBACK_VERSION = '34.0.0.376';
const MIN_SIZE_BYTES = 1024 * 1024;
const MMS_MARKER = '# managed-by: naruto-online-launcher';
// SHA-256 of the plugin files shipped with the release builds. A bundled file
// that does not match was modified after installation and is not loaded.
const BUNDLED_SHA256 = {
  'pepflashplayer.dll': 'cb91e4589f0a854dd0f23a21d6feee623a857a1dee112b8cb5e5a7c9be0af6f2',
  'libpepflashplayer.so': 'e66c93332824bce66cb862a0b7d5b175f9d5d78b296c1524dfa393ee516b0a7d'
};
const VERSION_RE = /(?<![\d.,])(\d{2})[.,](\d)[.,](\d)[.,](\d{1,4})(?![\d.,])/g;

/** Search locations in priority order. An imported copy overrides the bundled one. */
function candidatePaths(app) {
  const list = [];
  const add = (source, file) => file && list.push({ source, path: file });

  add('env', process.env.NARUTO_FLASH_PATH);
  add('userData', path.join(app.getPath('userData'), 'flash', FILE_NAME));
  if (app.isPackaged) {
    add('bundled', path.join(process.resourcesPath, 'flash', FILE_NAME));
    if (process.env.PORTABLE_EXECUTABLE_DIR) {
      add('portable', path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'flash', FILE_NAME));
    }
    if (process.env.APPIMAGE) {
      add('appimage', path.join(path.dirname(process.env.APPIMAGE), 'flash', FILE_NAME));
    }
    add('install', path.join(path.dirname(process.execPath), 'flash', FILE_NAME));
  } else {
    add('dev', path.join(__dirname, '..', '..', 'resources', 'flash', FILE_NAME));
  }
  return list;
}

/** Rough check that the file is a PE (Windows) or ELF (Linux) binary. Returns a reason key or null. */
function validateBinary(file) {
  let fd;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return 'notFile';
    if (stat.size < MIN_SIZE_BYTES) return 'tooSmall';
    fd = fs.openSync(file, 'r');
    const header = Buffer.alloc(4);
    fs.readSync(fd, header, 0, 4, 0);
    if (process.platform === 'win32' && header.toString('latin1', 0, 2) !== 'MZ') return 'notDll';
    if (process.platform === 'linux' && header.toString('latin1') !== '\x7fELF') return 'notSo';
    return null;
  } catch (err) {
    return err.code === 'ENOENT' ? 'notFound' : 'notFile';
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Reads the version by scanning the binary for "34,0,0,376"-like strings (the
 * Windows version resource and the Linux build string both contain it). The
 * result is cached by path, size and mtime because the scan takes ~150 ms.
 */
function detectVersion(app, pluginPath) {
  const cacheFile = path.join(app.getPath('userData'), 'flash-version.json');
  let stat;
  try {
    stat = fs.statSync(pluginPath);
  } catch (_) {
    return FALLBACK_VERSION;
  }
  const key = `${pluginPath}|${stat.size}|${stat.mtimeMs}`;
  try {
    const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    if (cached.key === key && cached.version) return cached.version;
  } catch (_) {
    // no cache yet
  }

  let version = FALLBACK_VERSION;
  try {
    const text = fs.readFileSync(pluginPath).toString('latin1').replace(/\0/g, '');
    const counts = {};
    for (const m of text.matchAll(VERSION_RE)) {
      const major = Number(m[1]);
      if (major < 10 || major > 40) continue;
      const v = m.slice(1, 5).join('.');
      counts[v] = (counts[v] || 0) + 1;
    }
    const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    if (best) version = best[0];
    fs.writeFileSync(cacheFile, JSON.stringify({ key, version }));
  } catch (err) {
    log.warn(`version scan failed: ${err.message}`);
  }
  return version;
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function locate(app) {
  const searched = [];
  for (const candidate of candidatePaths(app)) {
    let problem = validateBinary(candidate.path);
    let hash = null;
    if (!problem) {
      hash = sha256(candidate.path);
      const expected = candidate.source === 'bundled' || candidate.source === 'dev' ? BUNDLED_SHA256[FILE_NAME] : null;
      if (expected && hash !== expected) {
        problem = 'hashMismatch';
        log.error(`bundled plugin was modified (sha256 ${hash}), not loading it: ${candidate.path}`);
      }
    }
    searched.push({ ...candidate, problem });
    if (!problem) {
      const version = detectVersion(app, candidate.path);
      log.info(`plugin found (${candidate.source}): ${candidate.path}, version ${version}, sha256 ${hash}`);
      return { found: true, path: candidate.path, source: candidate.source, version, sha256: hash, searched };
    }
  }
  log.warn(`no Flash plugin (${FILE_NAME}) found, searched:`, searched.map((s) => s.path));
  return { found: false, searched };
}

function importPlugin(app, sourceFile) {
  const problem = validateBinary(sourceFile);
  if (problem) throw new UserError('err.flashInvalid', { reasonKey: `flash.invalid.${problem}` });
  const targetDir = path.join(app.getPath('userData'), 'flash');
  fs.mkdirSync(targetDir, { recursive: true });
  const target = path.join(targetDir, FILE_NAME);
  fs.copyFileSync(sourceFile, target + '.tmp');
  fs.renameSync(target + '.tmp', target);
  log.info(`plugin imported: ${sourceFile} -> ${target}`);
  return target;
}

/**
 * Writes mms.cfg into the session's "Pepper Data" folder, where Chromium's PPAPI
 * Flash looks for it. It only affects this launcher, never the system-wide Flash
 * configuration, and a file not created by the launcher is left alone.
 */
function writeMmsCfg(sessionDataDir, hardwareAcceleration) {
  const dir = path.join(sessionDataDir, 'Pepper Data', 'Shockwave Flash', 'System');
  const file = path.join(dir, 'mms.cfg');
  try {
    if (fs.existsSync(file) && !fs.readFileSync(file, 'utf8').includes(MMS_MARKER)) {
      log.info(`keeping user mms.cfg: ${file}`);
      return false;
    }
    const content = [
      MMS_MARKER,
      'AutoUpdateDisable=1',
      'SilentAutoUpdateEnable=0',
      'DisableProductDownload=1',
      'OverrideGPUValidation=1',
      `EnableHardwareAcceleration=${hardwareAcceleration ? 1 : 0}`,
      ''
    ].join('\n');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, content, 'utf8');
    return true;
  } catch (err) {
    log.warn(`could not write mms.cfg (${file}): ${err.message}`);
    return false;
  }
}

module.exports = { FILE_NAME, locate, importPlugin, writeMmsCfg, validateBinary };
