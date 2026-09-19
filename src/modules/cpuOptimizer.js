'use strict';

// Process priority and CPU affinity for the Flash plugin and the game renderers.
//
// Flash runs the game logic in one thread. On hybrid CPUs (Intel 12th gen and
// later) that thread otherwise ends up on efficiency cores now and then.
//   Linux:   affinity to the performance cores (taskset -a) plus priority
//   Windows: priority only; the Windows 11 scheduler handles core types itself

const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const log = require('./logger').create('cpu');

const FLASH_PROCESS_TYPE = 'Pepper Plugin';

function parseCpuList(raw) {
  const out = [];
  for (const part of String(raw || '').split(/[,\s]+/).filter(Boolean)) {
    const range = part.match(/^(\d+)-(\d+)$/);
    if (range) {
      for (let i = Number(range[1]); i <= Number(range[2]); i++) out.push(i);
    } else if (/^\d+$/.test(part)) {
      out.push(Number(part));
    }
  }
  return out;
}

function readTrim(file) {
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch (_) {
    return '';
  }
}

function detectTopology() {
  const cpus = os.cpus();
  let pCores = [];
  let eCores = [];

  if (process.platform === 'linux') {
    // kernel 5.13+: separate PMUs for performance (cpu_core) and efficiency (cpu_atom) cores
    pCores = parseCpuList(readTrim('/sys/devices/cpu_core/cpus'));
    eCores = parseCpuList(readTrim('/sys/devices/cpu_atom/cpus'));

    // fallback: clearly different maximum clocks (> 15 %)
    if (pCores.length === 0 && eCores.length === 0) {
      const freqs = cpus.map((_, i) => Number(readTrim(`/sys/devices/system/cpu/cpu${i}/cpufreq/cpuinfo_max_freq`)) || 0);
      const max = Math.max(...freqs);
      const min = Math.min(...freqs);
      if (max > 0 && min > 0 && (max - min) / max > 0.15) {
        freqs.forEach((f, i) => (f >= max * 0.85 ? pCores : eCores).push(i));
      }
    }
  }

  if (pCores.length === 0) {
    pCores = cpus.map((_, i) => i);
    eCores = [];
  }

  return {
    model: cpus[0] ? cpus[0].model.trim() : 'unknown',
    logicalCores: cpus.length,
    pCores,
    eCores,
    isHybrid: eCores.length > 0
  };
}

function priorityValue(level) {
  const p = os.constants.priority;
  if (level === 'high') return p.PRIORITY_HIGH;
  if (level === 'above-normal') return p.PRIORITY_ABOVE_NORMAL;
  return p.PRIORITY_NORMAL;
}

class CpuOptimizer {
  constructor(cpuPreset, enabled) {
    this.preset = cpuPreset;
    this.enabled = enabled;
    this.topology = detectTopology();
    this.done = new Set();
    const t = this.topology;
    log.info(`${t.model}, ${t.logicalCores} threads${t.isHybrid ? `, hybrid (P ${t.pCores.join(',')} / E ${t.eCores.join(',')})` : ''}`);
  }

  /**
   * Called periodically with app.getAppMetrics(); every process is handled once.
   * @param {Electron.ProcessMetric[]} metrics
   * @param {Set<number>} gamePids renderer PIDs of the game views
   */
  optimize(metrics, gamePids) {
    if (!this.enabled) return;
    const alive = new Set(metrics.map((m) => m.pid));
    for (const pid of this.done) if (!alive.has(pid)) this.done.delete(pid);

    for (const m of metrics) {
      if (this.done.has(m.pid) || (m.type !== FLASH_PROCESS_TYPE && !gamePids.has(m.pid))) continue;
      this.done.add(m.pid);
      try {
        os.setPriority(m.pid, priorityValue(this.preset.priority));
        log.info(`priority ${this.preset.priority} for ${m.type} (pid ${m.pid})`);
      } catch (err) {
        // Linux needs CAP_SYS_NICE to raise the priority; not an error
        log.debug(`priority not set for pid ${m.pid}: ${err.message}`);
      }
      if (process.platform === 'linux' && this.preset.pinToPerformanceCores && this.topology.isHybrid) {
        this._pin(m.pid, this.topology.pCores);
      }
    }
  }

  _pin(pid, cores) {
    execFile('taskset', ['-a', '-cp', cores.join(','), String(pid)], { timeout: 3000 }, (err) => {
      if (err) log.debug(`taskset failed for pid ${pid} (util-linux installed?): ${err.message}`);
      else log.info(`pid ${pid} pinned to cores ${cores.join(',')}`);
    });
  }

  getInfo() {
    return { ...this.topology, enabled: this.enabled, priority: this.preset.priority };
  }
}

module.exports = { CpuOptimizer, detectTopology, parseCpuList, FLASH_PROCESS_TYPE };
