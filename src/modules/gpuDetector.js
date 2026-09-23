'use strict';

// GPU detection (NVIDIA/AMD/Intel) and vendor specific driver variables.
//
// Runs synchronously before app.whenReady(), because environment variables have
// to be set before Chromium starts the GPU process. Only fast sources are used:
//   Windows: the "Display" device class in the registry, one reg.exe call per
//            adapter (~50 ms each). wmic is gone since Windows 11 24H2, and a
//            recursive `reg query /s` takes more than 15 seconds.
//   Linux:   /sys/class/drm/card*/device, lspci as fallback.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const log = require('./logger').create('gpu');

const VENDOR_IDS = { 0x10de: 'nvidia', 0x1002: 'amd', 0x8086: 'intel' };
const VENDOR_RANK = { nvidia: 3, amd: 2, intel: 1, unknown: 0 };
// bumped when the cached entries change shape (2: vendor and device id)
const CACHE_VERSION = 2;
const WIN_DISPLAY_CLASS =
  'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}';
// Adapters that do not render: remote desktop, streaming, fallback drivers
const VIRTUAL_ADAPTER = /basic (display|render)|remote|parsec|virtual|citrix|vmware|hyper-v|idd|spacedesk/i;

let cache = null;

function vendorFromName(name) {
  const n = String(name || '').toLowerCase();
  if (n.includes('nvidia')) return 'nvidia';
  if (n.includes('amd') || n.includes('advanced micro devices') || n.includes('radeon') || n.includes('ati ')) return 'amd';
  if (n.includes('intel')) return 'intel';
  return 'unknown';
}

function readTrim(file) {
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch (_) {
    return '';
  }
}

function regQuery(key) {
  return execFileSync('reg', ['query', key], {
    encoding: 'utf8',
    timeout: 3000,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore']
  });
}

/**
 * Reading every adapter costs most of the detection time and the list rarely
 * changes, so the result is cached while the set of adapter keys stays the same.
 */
function listGpusWindows(cacheFile) {
  let subkeys;
  try {
    subkeys = regQuery(WIN_DISPLAY_CLASS)
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => /\\\d{4}$/.test(l));
  } catch (err) {
    log.warn('registry query failed:', err.message);
    return [];
  }
  const key = subkeys.join('|');
  if (cacheFile) {
    try {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (cached.v === CACHE_VERSION && cached.key === key && Date.now() - cached.time < 7 * 24 * 3600 * 1000) {
        return cached.gpus;
      }
    } catch (_) {
      // no cache yet
    }
  }

  const gpus = [];
  for (const key of subkeys.slice(0, 8)) {
    try {
      const values = {};
      for (const line of regQuery(key).split(/\r?\n/)) {
        const m = line.match(/^\s+(\S+)\s+REG_\w+\s+(.*)$/);
        if (m) values[m[1]] = m[2].trim();
      }
      const desc = values.DriverDesc;
      if (!desc || VIRTUAL_ADAPTER.test(desc)) continue;
      const ids = String(values.MatchingDeviceId || '').match(/ven_([0-9a-f]{4})&dev_([0-9a-f]{4})/i);
      const vendorId = ids ? parseInt(ids[1], 16) : 0;
      const vram = Number(values['HardwareInformation.qwMemorySize']) || 0;
      gpus.push({
        vendorId,
        deviceId: ids ? parseInt(ids[2], 16) : 0,
        vendor: VENDOR_IDS[vendorId] || vendorFromName(values.ProviderName || desc),
        name: desc,
        driver: values.DriverVersion || '',
        vramMB: vram > 0 ? Math.round(vram / 1048576) : 0
      });
    } catch (_) {
      // unreadable adapter entry
    }
  }
  if (cacheFile) {
    try {
      fs.writeFileSync(cacheFile, JSON.stringify({ v: CACHE_VERSION, key, time: Date.now(), gpus }));
    } catch (_) {
      // cache is optional
    }
  }
  return gpus;
}

function listGpusLinuxSysfs() {
  const drm = '/sys/class/drm';
  let cards;
  try {
    cards = fs.readdirSync(drm).filter((n) => /^card\d+$/.test(n));
  } catch (_) {
    return [];
  }
  const gpus = [];
  for (const card of cards) {
    const dev = path.join(drm, card, 'device');
    const vendor = VENDOR_IDS[parseInt(readTrim(path.join(dev, 'vendor')), 16)];
    if (!vendor) continue;
    const driverMatch = readTrim(path.join(dev, 'uevent')).match(/DRIVER=(\S+)/);
    const driver = driverMatch ? driverMatch[1] : '';
    gpus.push({
      vendor,
      name: `${vendor.toUpperCase()} GPU${driver ? ` (${driver})` : ''}`,
      driver,
      vramMB: Math.round((parseInt(readTrim(path.join(dev, 'mem_info_vram_total')), 10) || 0) / 1048576)
    });
  }
  return gpus;
}

function listGpusLinuxLspci() {
  try {
    const out = execFileSync('lspci', ['-mm'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
    return out
      .split('\n')
      .filter((l) => /VGA compatible controller|3D controller|Display controller/i.test(l))
      .map((l) => {
        const parts = (l.match(/"([^"]*)"/g) || []).map((p) => p.replace(/"/g, ''));
        return { vendor: vendorFromName(parts[1]), name: `${parts[1] || ''} ${parts[2] || ''}`.trim(), driver: '', vramMB: 0 };
      })
      .filter((g) => g.vendor !== 'unknown');
  } catch (_) {
    return [];
  }
}

function isMusl() {
  try {
    return fs.readdirSync('/lib').some((f) => /^ld-musl-/.test(f));
  } catch (_) {
    return false;
  }
}

function summarize(gpus) {
  const vendors = new Set(gpus.map((g) => g.vendor));
  // integrated Intel GPU next to a dedicated one, typical for laptops
  const isHybrid = vendors.has('intel') && (vendors.has('nvidia') || vendors.has('amd'));
  const primary = gpus.slice().sort((a, b) => VENDOR_RANK[b.vendor] - VENDOR_RANK[a.vendor])[0] || null;
  return {
    vendor: primary ? primary.vendor : 'unknown',
    name: primary ? primary.name : 'unknown',
    vramMB: primary ? primary.vramMB : 0,
    isHybrid,
    nvidiaProprietary: process.platform === 'win32' || fs.existsSync('/proc/driver/nvidia'),
    gpus
  };
}

/** @param {string} [cacheFile] where Windows results may be cached */
function detect(cacheFile) {
  if (cache) return cache;
  const started = Date.now();
  let gpus = [];
  try {
    if (process.platform === 'win32') gpus = listGpusWindows(cacheFile);
    else if (process.platform === 'linux') {
      gpus = listGpusLinuxSysfs();
      if (gpus.length === 0) gpus = listGpusLinuxLspci();
    }
  } catch (err) {
    log.error('detection failed:', err.message);
  }

  cache = summarize(gpus);
  log.info(`${cache.vendor} "${cache.name}"${cache.isHybrid ? ' [hybrid]' : ''}, ${gpus.length} adapter(s), ${Date.now() - started} ms`);
  return cache;
}

/**
 * The Windows registry keeps entries of graphics cards that were removed long
 * ago, which made a desktop with one card look like a hybrid laptop. Once
 * Chromium is up, its list of present adapters (app.getGPUInfo('basic')) is
 * the reference: entries it does not know are dropped, in memory and in the
 * cache file. The object returned by detect() is updated in place.
 */
function reconcile(gpuInfo, cacheFile) {
  if (process.platform !== 'win32' || !cache) return cache;
  const devices = (gpuInfo && gpuInfo.gpuDevice) || [];
  if (devices.length === 0) return cache;
  const present = new Set(devices.map((d) => `${d.vendorId}:${d.deviceId}`));
  const kept = cache.gpus.filter((g) => !g.vendorId || !g.deviceId || present.has(`${g.vendorId}:${g.deviceId}`));
  if (kept.length === cache.gpus.length || kept.length === 0) return cache;
  const dropped = cache.gpus.filter((g) => !kept.includes(g)).map((g) => g.name);
  Object.assign(cache, summarize(kept));
  log.info(`not present, ignored: ${dropped.join(', ')}; now ${cache.vendor} "${cache.name}"${cache.isHybrid ? ' [hybrid]' : ''}`);
  if (cacheFile) {
    try {
      const stored = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      stored.gpus = kept;
      fs.writeFileSync(cacheFile, JSON.stringify(stored));
    } catch (_) {
      // cache is optional
    }
  }
  return cache;
}

/**
 * Driver variables for Linux. The Windows drivers ignore them, so the result
 * is empty there.
 * @param {'performance'|'balanced'} profile
 */
function getEnvVars(profile) {
  const env = {};
  if (process.platform !== 'linux') return env;
  const gpu = detect();

  // glibc: fewer malloc arenas, less fragmentation in the Flash process
  if (!isMusl()) env.MALLOC_ARENA_MAX = '2';

  if (gpu.vendor === 'nvidia' && gpu.nvidiaProprietary) {
    // only the proprietary driver reads __GL_*, nouveau ignores them
    env.__GL_THREADED_OPTIMIZATIONS = '1';
    env.__GL_SHADER_DISK_CACHE = '1';
    if (profile === 'performance') env.__GL_SYNC_TO_VBLANK = '0';
    if (gpu.isHybrid && process.env.__NV_PRIME_RENDER_OFFLOAD === undefined) {
      env.__NV_PRIME_RENDER_OFFLOAD = '1';
      env.__GLX_VENDOR_LIBRARY_NAME = 'nvidia';
    }
  }

  if (gpu.vendor === 'amd') {
    env.RADEONSI_ZERO_VRAM = '1';
    if (gpu.isHybrid && process.env.DRI_PRIME === undefined) env.DRI_PRIME = '1';
  }

  if (gpu.vendor === 'amd' || gpu.vendor === 'intel') {
    env.mesa_glthread = 'true';
    if (profile === 'performance') env.vblank_mode = '0';
  }

  if (gpu.vendor === 'intel' && profile === 'performance') {
    // disables render buffer compression, which causes artefacts in Flash on some drivers
    env.INTEL_DEBUG = 'norbc';
  }
  return env;
}

/** Sets the variables on the main process so GPU and plugin processes inherit them. */
function applyEnvVars(profile) {
  const applied = {};
  for (const [key, value] of Object.entries(getEnvVars(profile))) {
    if (process.env[key] !== undefined) continue; // values set by the user win
    process.env[key] = value;
    applied[key] = value;
  }
  if (Object.keys(applied).length) log.info('environment:', applied);
  return applied;
}

module.exports = { detect, reconcile, getEnvVars, applyEnvVars };
