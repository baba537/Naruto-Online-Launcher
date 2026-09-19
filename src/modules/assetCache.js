'use strict';

// Longer caching for versioned game files.
//
// Many game files come with short or "no-cache" headers, so Chromium asks the
// server again after every restart. Files whose URL carries a version (a
// ?v=/?ver= parameter, a date folder or a hash in the name) cannot change
// without the URL changing, so they are marked cacheable for 30 days. Files
// without such a marker are left alone: an update hidden behind a stale copy
// would break the game.
//
// The module also counts cache hits and notices URLs whose query changes on
// every request (cache busting), which no header can fix.

const log = require('./logger').create('cache');

const ASSET_EXT = /\.(swf|png|jpe?g|gif|webp|mp3|ogg|wav|bin|dat|zip|xml)$/i;
const VERSION_PARAMS = ['v', 'ver', 'version', 'build', 'rev', 'hash', 'vs', 'md5'];
const THIRTY_DAYS = 30 * 24 * 3600;

function looksLikeTimestamp(value) {
  if (!/^\d{10,13}$/.test(value)) return false;
  const ms = value.length === 13 ? Number(value) : Number(value) * 1000;
  return Math.abs(Date.now() - ms) < 7 * 24 * 3600 * 1000;
}

function isVersioned(url) {
  if (/\/(v?\d{6,}|[0-9a-f]{8,})\//i.test(url.pathname)) return true;
  if (/[._-][0-9a-f]{8,}\.[a-z0-9]+$/i.test(url.pathname)) return true;
  for (const name of VERSION_PARAMS) {
    const value = url.searchParams.get(name);
    if (value && !looksLikeTimestamp(value)) return true;
  }
  return false;
}

function setHeader(headers, name, value) {
  for (const key of Object.keys(headers)) if (key.toLowerCase() === name) delete headers[key];
  if (value !== null) headers[name] = [value];
}

class AssetCache {
  constructor(isEnabled) {
    this.isEnabled = isEnabled;
    this.stats = { hits: 0, misses: 0, extended: 0 };
    this.queriesByPath = new Map();
    this.bustedPaths = new Set();
    this.attached = new WeakSet();
  }

  attach(ses) {
    if (this.attached.has(ses)) return;
    this.attached.add(ses);

    ses.webRequest.onHeadersReceived({ urls: ['<all_urls>'] }, (details, callback) => {
      const headers = details.responseHeaders || {};
      let url;
      try {
        url = new URL(details.url);
      } catch (_) {
        return callback({ responseHeaders: headers });
      }
      if (
        this.isEnabled() &&
        details.method === 'GET' &&
        details.statusCode === 200 &&
        ASSET_EXT.test(url.pathname) &&
        isVersioned(url)
      ) {
        setHeader(headers, 'cache-control', `public, max-age=${THIRTY_DAYS}, immutable`);
        setHeader(headers, 'pragma', null);
        setHeader(headers, 'expires', null);
        this.stats.extended++;
      }
      callback({ responseHeaders: headers });
    });

    ses.webRequest.onCompleted({ urls: ['<all_urls>'] }, (details) => {
      let url;
      try {
        url = new URL(details.url);
      } catch (_) {
        return;
      }
      if (!ASSET_EXT.test(url.pathname)) return;
      if (details.fromCache) this.stats.hits++;
      else this.stats.misses++;
      this._trackQuery(url);
    });
  }

  _trackQuery(url) {
    if (!url.search) return;
    const key = url.host + url.pathname;
    const seen = this.queriesByPath.get(key) || new Set();
    seen.add(url.search);
    if (seen.size > 5) seen.clear();
    this.queriesByPath.set(key, seen);
    if (seen.size >= 2 && !this.bustedPaths.has(key)) {
      this.bustedPaths.add(key);
      log.debug(`query changes on ${key} (cache busting)`);
    }
  }

  getStats() {
    return { ...this.stats, bustedPaths: this.bustedPaths.size };
  }

  logSummary(reason) {
    const s = this.getStats();
    log.info(
      `${reason}: ${s.hits} from cache, ${s.misses} downloaded, ${s.extended} with extended caching, ` +
        `${s.bustedPaths} path(s) with cache busting`
    );
  }
}

module.exports = { AssetCache, isVersioned };
