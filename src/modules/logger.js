'use strict';

// Small file logger with rotation: <userData>/logs/launcher.log.
// Never pass passwords or tokens to it.

const fs = require('fs');
const path = require('path');
const util = require('util');

const MAX_LOG_BYTES = 2 * 1024 * 1024;
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

let logFile = null;
let minLevel = LEVELS.info;

function init(userDataDir, { debug = false } = {}) {
  minLevel = debug ? LEVELS.debug : LEVELS.info;
  try {
    const dir = path.join(userDataDir, 'logs');
    fs.mkdirSync(dir, { recursive: true });
    logFile = path.join(dir, 'launcher.log');
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > MAX_LOG_BYTES) {
      fs.renameSync(logFile, path.join(dir, 'launcher.old.log'));
    }
  } catch (err) {
    logFile = null;
    console.error('[logger] log file not available:', err.message);
  }
}

function isDebug() {
  return minLevel <= LEVELS.debug;
}

function write(level, scope, args) {
  if (LEVELS[level] < minLevel) return;
  const msg = args.map((a) => (typeof a === 'string' ? a : util.inspect(a, { depth: 3 }))).join(' ');
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}`;
  (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(line);
  if (!logFile) return;
  try {
    fs.appendFileSync(logFile, line + '\n');
  } catch (_) {
    // logging must never crash the app
  }
}

function create(scope) {
  return {
    debug: (...a) => write('debug', scope, a),
    info: (...a) => write('info', scope, a),
    warn: (...a) => write('warn', scope, a),
    error: (...a) => write('error', scope, a)
  };
}

module.exports = { init, create, isDebug, getLogFile: () => logFile };
