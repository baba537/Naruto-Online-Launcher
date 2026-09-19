'use strict';

// Performance presets. They only hold data; main.js applies the Chromium switches,
// gpuDetector.js the driver variables, cpuOptimizer.js priority and affinity, and
// the game preload the Flash embed parameters.
//
// The game already embeds Flash with wmode=direct (GPU presentation) and
// quality=high. What visibly changes the load per frame is the Flash quality;
// the Chromium switches mostly affect loading and the page around the game.

const os = require('os');

const MB = 1024 * 1024;

const FLASH_QUALITIES = ['default', 'low', 'medium', 'high', 'best'];

const BASE_SWITCHES = [['enable-gpu-rasterization'], ['ignore-gpu-blocklist']];

const PRESETS = {
  quality: {
    id: 'quality',
    switches: BASE_SWITCHES,
    diskCacheBytes: 2048 * MB,
    maxOldSpaceMB: 2048,
    gpuEnvProfile: 'balanced',
    cpu: { priority: 'above-normal', pinToPerformanceCores: true },
    flash: { quality: 'best', hardwareAcceleration: true },
    flashMemoryWarnMB: 3000
  },

  balanced: {
    id: 'balanced',
    switches: BASE_SWITCHES,
    diskCacheBytes: 2048 * MB,
    maxOldSpaceMB: 2048,
    gpuEnvProfile: 'balanced',
    cpu: { priority: 'above-normal', pinToPerformanceCores: true },
    flash: { quality: 'default', hardwareAcceleration: true },
    flashMemoryWarnMB: 3000
  },

  performance: {
    id: 'performance',
    switches: [...BASE_SWITCHES, ['enable-zero-copy'], ['disable-gpu-vsync'], ['disable-frame-rate-limit']],
    diskCacheBytes: 2048 * MB,
    maxOldSpaceMB: 3072,
    gpuEnvProfile: 'performance',
    cpu: { priority: 'high', pinToPerformanceCores: true },
    flash: { quality: 'medium', hardwareAcceleration: true },
    flashMemoryWarnMB: 3000
  },

  'low-spec': {
    id: 'low-spec',
    switches: [['ignore-gpu-blocklist'], ['disable-smooth-scrolling'], ['disable-dev-shm-usage', null, 'linux']],
    diskCacheBytes: 1024 * MB,
    maxOldSpaceMB: 1024,
    gpuEnvProfile: 'balanced',
    cpu: { priority: 'above-normal', pinToPerformanceCores: false },
    flash: { quality: 'low', hardwareAcceleration: true },
    flashMemoryWarnMB: 1800
  }
};

const PRESET_IDS = Object.keys(PRESETS);

// Used by every preset: the game must not be throttled in the background
// (disconnects), and Chromium services the launcher does not need stay off.
const COMMON_SWITCHES = [
  ['disable-background-timer-throttling'],
  ['disable-renderer-backgrounding'],
  ['disable-backgrounding-occluded-windows'],
  ['disable-background-networking'],
  ['disable-component-update'],
  ['disable-domain-reliability'],
  ['disable-client-side-phishing-detection'],
  ['disable-plugin-power-saver'],
  ['autoplay-policy', 'no-user-gesture-required']
];

const COMMON_DISABLED_FEATURES = ['CalculateNativeWinOcclusion', 'MediaRouter', 'Translate'];

/** Weak hardware: less than 4 GB RAM or at most 2 logical cores. */
function isLowSpecHardware() {
  return os.totalmem() / (1024 * MB) < 4 || os.cpus().length <= 2;
}

/** Enough headroom for the best quality: 8 GB RAM and 4 threads or more. */
function isStrongHardware() {
  return os.totalmem() / (1024 * MB) >= 7.5 && os.cpus().length >= 4;
}

function resolvePreset(setting) {
  if (setting && setting !== 'auto' && PRESETS[setting]) return PRESETS[setting];
  if (isLowSpecHardware()) return PRESETS['low-spec'];
  return isStrongHardware() ? PRESETS.quality : PRESETS.balanced;
}

/** Effective Flash quality: an explicit setting wins over the preset. */
function resolveFlashQuality(preset, settings) {
  return settings.flashQuality === 'preset' ? preset.flash.quality : settings.flashQuality;
}

module.exports = {
  PRESETS,
  PRESET_IDS,
  FLASH_QUALITIES,
  COMMON_SWITCHES,
  COMMON_DISABLED_FEATURES,
  isLowSpecHardware,
  resolvePreset,
  resolveFlashQuality
};
