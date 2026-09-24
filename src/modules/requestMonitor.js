'use strict';

// Network diagnostics for the game sessions. A loading screen that stops at a
// fixed percentage usually waits for one request, so these go to the log:
//   - requests that fail (except cancelled and blocked ones)
//   - answers with an HTTP error status
//   - requests without an answer after 20 seconds
//   - requests to plain IP addresses, with their path and result: the game uses
//     them for fallbacks (an HTTP DNS lookup, for example) that only run when
//     its normal connection did not work
// Query strings are left out, they may carry session tokens. For requests to
// IP addresses the parameter names stay, and the values of host name
// parameters (dn, host, domain), which tell what the game tried to resolve.

const net = require('net');
const log = require('./logger').create('net');

const STALL_MS = 20000;
const CHECK_MS = 5000;
const MAX_REPORTS = 300; // per run, keeps the log readable
const IGNORED_ERRORS = new Set(['net::ERR_ABORTED', 'net::ERR_BLOCKED_BY_CLIENT']);

function isIpHost(host) {
  return net.isIP(String(host).replace(/^\[|\]$/g, '')) !== 0;
}

const HOST_PARAMS = new Set(['dn', 'host', 'domain']);

function describeQuery(url) {
  const parts = [];
  for (const [key, value] of url.searchParams) parts.push(HOST_PARAMS.has(key.toLowerCase()) ? `${key}=${value}` : key);
  return parts.length ? `?${parts.join('&')}` : '';
}

/** host + path; for IP addresses also the query, see above. At most 160 characters. */
function describe(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const text = `${url.host}${url.pathname}${isIpHost(url.hostname) ? describeQuery(url) : ''}`;
    return text.length > 160 ? `${text.slice(0, 159)}…` : text;
  } catch (_) {
    return String(rawUrl).slice(0, 80);
  }
}

function seconds(ms) {
  return `${(ms / 1000).toFixed(1)} s`;
}

class RequestMonitor {
  constructor() {
    this.sessions = new Map(); // session -> Map(request id -> {url, type, start, stalled, ip})
    this.reports = 0;
    this.timer = null;
  }

  _report(level, message) {
    if (this.reports >= MAX_REPORTS) return;
    this.reports++;
    log[level](message);
    if (this.reports === MAX_REPORTS) log.info('further network notes are left out in this run');
  }

  /**
   * Starts watching a game session. Returns the handler for onCompleted, which
   * belongs to the asset cache and has to be forwarded from there.
   */
  attach(ses) {
    if (this.sessions.has(ses)) return this.sessions.get(ses).onCompleted;
    const pending = new Map();
    const done = (id) => {
      const entry = pending.get(id);
      pending.delete(id);
      return entry;
    };

    ses.webRequest.onSendHeaders({ urls: ['http://*/*', 'https://*/*'] }, (details) => {
      let ip = false;
      try {
        ip = isIpHost(new URL(details.url).hostname);
      } catch (_) {
        return;
      }
      pending.set(details.id, { url: details.url, type: details.resourceType, start: Date.now(), stalled: false, ip });
      if (ip) this._report('info', `request to an IP address: ${describe(details.url)} [${details.resourceType}]`);
    });

    ses.webRequest.onResponseStarted({ urls: ['http://*/*', 'https://*/*'] }, (details) => {
      const entry = pending.get(details.id);
      if (entry) entry.answered = Date.now();
      if (details.statusCode >= 400) {
        this._report('warn', `HTTP ${details.statusCode}: ${describe(details.url)} [${details.resourceType}]`);
      }
    });

    ses.webRequest.onErrorOccurred({ urls: ['http://*/*', 'https://*/*'] }, (details) => {
      const entry = done(details.id);
      if (IGNORED_ERRORS.has(details.error)) return;
      const after = entry ? ` after ${seconds(Date.now() - entry.start)}` : '';
      this._report('warn', `failed (${details.error})${after}: ${describe(details.url)} [${details.resourceType}]`);
    });

    const onCompleted = (details) => {
      const entry = done(details.id);
      if (entry && (entry.ip || entry.stalled)) {
        this._report(
          'info',
          `answer ${details.statusCode} after ${seconds(Date.now() - entry.start)}: ${describe(details.url)} [${details.resourceType}]`
        );
      }
    };

    this.sessions.set(ses, { pending, onCompleted });
    this._startTimer();
    return onCompleted;
  }

  _startTimer() {
    if (this.timer) return;
    this.timer = setInterval(() => this._checkStalls(), CHECK_MS);
    if (this.timer.unref) this.timer.unref();
  }

  _checkStalls() {
    const now = Date.now();
    for (const { pending } of this.sessions.values()) {
      for (const entry of pending.values()) {
        if (entry.stalled || now - entry.start < STALL_MS) continue;
        entry.stalled = true;
        const state = entry.answered ? 'still loading' : 'no answer';
        this._report('warn', `${state} after ${seconds(now - entry.start)}: ${describe(entry.url)} [${entry.type}]`);
      }
    }
  }
}

module.exports = { RequestMonitor, describe };
