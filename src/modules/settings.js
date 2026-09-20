'use strict';

// Persistent settings in <userData>/settings.json. Every key has a validator, so
// neither a damaged file nor the renderer can inject unexpected values.

const fs = require('fs');
const path = require('path');
const { PRESET_IDS, FLASH_QUALITIES } = require('../config/optimization');

const UI_SCALES = ['0.8', '0.9', '1', '1.1', '1.25', '1.5'];
const LANGUAGES = ['auto', 'en', 'de'];

const bool = (v) => typeof v === 'boolean';
// window position: null means "not stored yet"
const coord = (v) => v === null || (Number.isInteger(v) && v >= -32000 && v <= 32000);
const size = (min, max) => (v) => Number.isInteger(v) && v >= min && v <= max;

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
  popupsInTabs: { default: true, valid: bool },
  checkUpdates: { default: true, valid: bool },
  debugLog: { default: false, valid: bool },
  gameWidth: { default: 1280, valid: size(800, 7680) },
  gameHeight: { default: 800, valid: size(550, 4320) },
  gameX: { default: null, valid: coord },
  gameY: { default: null, valid: coord },
  gameMaximized: { default: false, valid: bool },
  winWidth: { default: 1100, valid: size(760, 7680) },
  winHeight: { default: 780, valid: size(560, 4320) },
  winX: { default: null, valid: coord },
  winY: { default: null, valid: coord },
  minimizeOnStart: { default: false, valid: bool }
};

// Keys that only hold window geometry; they survive a settings reset.
const GEOMETRY_KEYS = ['gameWidth', 'gameHeight', 'gameX', 'gameY', 'gameMaximized', 'winWidth', 'winHeight', 'winX', 'winY'];

// Keys renamed since earlier versions: old name -> new name
const RENAMED = { autoFill: 'autoLogin' };

// Chromium switches are only read at startup. Everything else takes effect
// right away or when the next game is started.
const RESTART_KEYS = ['preset'];

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

  /** Restores the defaults, except language and window geometry. Returns the changed keys. */
  reset() {
    const keep = ['language', ...GEOMETRY_KEYS];
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

module.exports = { Settings, RESTART_KEYS, GEOMETRY_KEYS, UI_SCALES };
