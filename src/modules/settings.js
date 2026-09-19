'use strict';

// Persistent settings in <userData>/settings.json. Every key has a validator, so
// neither a damaged file nor the renderer can inject unexpected values.

const fs = require('fs');
const path = require('path');
const { PRESET_IDS, FLASH_QUALITIES } = require('../config/optimization');

const UI_SCALES = ['0.8', '0.9', '1', '1.1', '1.25', '1.5'];
const LANGUAGES = ['auto', 'en', 'de'];

const bool = (v) => typeof v === 'boolean';

const SCHEMA = {
  language: { default: 'auto', valid: (v) => LANGUAGES.includes(v) },
  uiScale: { default: '1', valid: (v) => UI_SCALES.includes(v) },
  tabbedWindows: { default: true, valid: bool },
  // renamed from zoomMode in 1.5.0 so that everyone starts with the sharp zoom again
  zoomRender: { default: 'sharp', valid: (v) => v === 'smooth' || v === 'sharp' },
  muteInactiveTabs: { default: false, valid: bool },
  preset: { default: 'auto', valid: (v) => v === 'auto' || PRESET_IDS.includes(v) },
  flashQuality: { default: 'preset', valid: (v) => v === 'preset' || FLASH_QUALITIES.includes(v) },
  cpuOptimization: { default: true, valid: bool },
  manageMmsCfg: { default: true, valid: bool },
  assetCache: { default: true, valid: bool },
  autoRecover: { default: true, valid: bool },
  blockTrackers: { default: true, valid: bool },
  strictNetwork: { default: true, valid: bool },
  autoLogin: { default: true, valid: bool },
  debugLog: { default: false, valid: bool },
  gameWidth: { default: 1280, valid: (v) => Number.isInteger(v) && v >= 800 && v <= 7680 },
  gameHeight: { default: 800, valid: (v) => Number.isInteger(v) && v >= 550 && v <= 4320 },
  gameMaximized: { default: false, valid: bool },
  minimizeOnStart: { default: false, valid: bool }
};

// Keys renamed since earlier versions: old name -> new name
const RENAMED = { autoFill: 'autoLogin' };

// Chromium switches are only read at startup.
const RESTART_KEYS = ['preset', 'debugLog'];

class Settings {
  constructor(userDataDir) {
    this.file = path.join(userDataDir, 'settings.json');
    this.values = {};
    for (const [key, def] of Object.entries(SCHEMA)) this.values[key] = def.default;
    this._load();
  }

  _load() {
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (_) {
      return;
    }
    if (!raw || typeof raw !== 'object') return;
    for (const [oldKey, newKey] of Object.entries(RENAMED)) {
      if (raw[oldKey] !== undefined && raw[newKey] === undefined) raw[newKey] = raw[oldKey];
    }
    for (const key of Object.keys(SCHEMA)) {
      if (Object.prototype.hasOwnProperty.call(raw, key) && SCHEMA[key].valid(raw[key])) {
        this.values[key] = raw[key];
      }
    }
  }

  get(key) {
    return this.values[key];
  }

  getAll() {
    return { ...this.values };
  }

  /** Restores the defaults, except language and window size. Returns the changed keys. */
  reset() {
    const keep = ['language', 'gameWidth', 'gameHeight', 'gameMaximized'];
    const patch = {};
    for (const [key, def] of Object.entries(SCHEMA)) if (!keep.includes(key)) patch[key] = def.default;
    return this.update(patch);
  }

  /** Applies known, valid keys only. Returns the list of changed keys. */
  update(patch) {
    if (!patch || typeof patch !== 'object') throw new Error('invalid settings patch');
    const next = {};
    for (const [key, value] of Object.entries(patch)) {
      if (!SCHEMA[key]) throw new Error(`unknown setting: ${key}`);
      if (!SCHEMA[key].valid(value)) throw new Error(`invalid value for ${key}`);
      next[key] = value;
    }
    const changed = Object.keys(next).filter((key) => this.values[key] !== next[key]);
    if (changed.length) {
      Object.assign(this.values, next);
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.values, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    }
    return changed;
  }
}

module.exports = { Settings, RESTART_KEYS, UI_SCALES };
