'use strict';

// Network and navigation rules for the game sessions:
//   - tracker blocker (domains and URL patterns); login and game API are never blocked
//   - optional strict mode that only allows known game hosts
//   - unknown hosts are logged once, which keeps the lists maintainable
//   - permissions: fullscreen only; no downloads
//   - navigation limited to game and sign-in domains, everything else opens in the browser
//
// Pages the game opens itself (top-up, website, support) are marked as browsing
// views: they keep the tracker blocker but not the strict allowlist, because a
// checkout runs over payment providers that cannot be listed in advance.

const net = require('net');
const { shell } = require('electron');
const log = require('./logger').create('security');
const { GAME_DOMAINS, AUTH_POPUP_DOMAINS, NEVER_BLOCK_HOSTS, RESOURCE_DOMAINS, hostMatches } = require('../config/urls');

const TRACKER_DOMAINS = [
  'google-analytics.com',
  'analytics.google.com',
  'googletagmanager.com',
  'doubleclick.net',
  'googlesyndication.com',
  'googleadservices.com',
  'adservice.google.com',
  // Facebook pixel; the SDK on connect.facebook.net stays for Facebook sign-in
  'pixel.facebook.com',
  'cloudflareinsights.com',
  // OAS analytics. odp3, vipsac and passport are game services, see NEVER_BLOCK_HOSTS.
  'analytics.oasgames.com',
  'track.oasgames.com',
  'log.oasgames.com',
  'pin.oasgames.com',
  'dmp.oasgames.com',
  'track.narutowebgame.com',
  'mdata.cool',
  'hotjar.com',
  'clarity.ms',
  'mixpanel.com',
  'mxpnl.com',
  'bat.bing.com',
  'analytics.tiktok.com',
  'sentry.io'
];

// Telemetry on hosts the game needs: block the path, not the host
const TRACKER_URL_PATTERNS = [
  /^https?:\/\/([a-z0-9-]+\.)*facebook\.com\/tr[/?]/i,
  /^https?:\/\/connect\.facebook\.net\/[^/]+\/fbevents\.js/i,
  /\/cdn-cgi\/rum\b/i, // Cloudflare RUM beacon; /cdn-cgi/challenge-platform must stay reachable
  /\/oss_report\.fcgi\b/i // in-game telemetry (server id, role id)
];

function parseUrl(url) {
  try {
    return new URL(url);
  } catch (_) {
    return null;
  }
}

function isTracker(parsed) {
  return hostMatches(parsed.hostname, TRACKER_DOMAINS) || TRACKER_URL_PATTERNS.some((re) => re.test(parsed.href));
}

function isWebProtocol(parsed) {
  return /^(https?|wss?):$/.test(parsed.protocol);
}

function isAllowedInStrictMode(parsed) {
  if (!isWebProtocol(parsed)) return true;
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) return true; // game servers are partly addressed by IP
  return hostMatches(host, RESOURCE_DOMAINS);
}

const hardened = new WeakSet();
const seenUnknownHosts = new Set();
// webContents ids of browsing views, see setBrowsing()
const browsing = new Set();

/** Marks a view as a browsing view (top-up, website): no strict allowlist, free navigation. */
function setBrowsing(contents) {
  const id = contents.id;
  browsing.add(id);
  contents.once('destroyed', () => browsing.delete(id));
}

function isBrowsing(webContentsId) {
  return typeof webContentsId === 'number' && browsing.has(webContentsId);
}

/**
 * @param {Electron.Session} ses
 * @param {() => {blockTrackers: boolean, strictNetwork: boolean}} getOptions read per request
 */
function hardenGameSession(ses, getOptions) {
  if (hardened.has(ses)) return;
  hardened.add(ses);
  let blocked = 0;

  ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    const parsed = parseUrl(details.url);
    if (!parsed) return callback({ cancel: false });
    const host = parsed.hostname.toLowerCase();
    if (NEVER_BLOCK_HOSTS.includes(host)) return callback({ cancel: false });

    // Pages of the game are always loaded over https, even if a link says http.
    // Plain IP addresses are left alone, they cannot have a certificate.
    if (
      parsed.protocol === 'http:' &&
      !net.isIP(host) &&
      (details.resourceType === 'mainFrame' || details.resourceType === 'subFrame') &&
      hostMatches(host, GAME_DOMAINS)
    ) {
      parsed.protocol = 'https:';
      return callback({ redirectURL: parsed.href });
    }

    const opts = getOptions();
    if (opts.blockTrackers && isTracker(parsed)) {
      blocked++;
      log.debug(`tracker blocked: ${host}${parsed.pathname}`);
      if (blocked % 50 === 1) log.info(`tracker blocker active, ${blocked} request(s) blocked so far`);
      return callback({ cancel: true });
    }
    if (isWebProtocol(parsed) && !hostMatches(host, RESOURCE_DOMAINS) && !seenUnknownHosts.has(host)) {
      seenUnknownHosts.add(host);
      log.info(`unknown host: ${host} (${details.resourceType})`);
    }
    if (opts.strictNetwork && !isAllowedInStrictMode(parsed) && !isBrowsing(details.webContentsId)) {
      log.warn(`strict mode blocked ${host}`);
      return callback({ cancel: true });
    }
    callback({ cancel: false });
  });

  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    const allowed = permission === 'fullscreen';
    if (!allowed) log.info(`permission denied: ${permission}`);
    callback(allowed);
  });
  ses.setPermissionCheckHandler((_wc, permission) => permission === 'fullscreen');

  ses.on('will-download', (event, item) => {
    log.warn(`download blocked: ${item.getURL()}`);
    event.preventDefault();
  });
}

function isGameUrl(url) {
  const parsed = parseUrl(url);
  // http is allowed because some pages still redirect via http
  return Boolean(parsed && /^https?:$/.test(parsed.protocol) && hostMatches(parsed.hostname, GAME_DOMAINS));
}

function isAuthPopupUrl(url) {
  const parsed = parseUrl(url);
  return Boolean(parsed && parsed.protocol === 'https:' && hostMatches(parsed.hostname, AUTH_POPUP_DOMAINS));
}

/** Opens http(s) links in the system browser; anything else is dropped. */
function openExternalSafe(url) {
  const parsed = parseUrl(url);
  if (parsed && /^https?:$/.test(parsed.protocol)) {
    log.info(`opening in browser: ${parsed.origin}${parsed.pathname}`);
    shell.openExternal(parsed.href);
  } else {
    log.warn(`external link dropped: ${String(url).slice(0, 100)}`);
  }
}

/**
 * Keeps a game view or sign-in popup on game and sign-in domains.
 * A browsing view may follow https links anywhere; it only renders web pages,
 * without Node, plugins of its own or downloads.
 */
function guardNavigation(contents, { browse = false } = {}) {
  const onNavigate = (event, url) => {
    if (isGameUrl(url) || isAuthPopupUrl(url)) return;
    if (browse && parseUrl(url) && parseUrl(url).protocol === 'https:') {
      log.info(`browsing view opens ${parseUrl(url).host}`);
      return;
    }
    event.preventDefault();
    log.warn(`navigation blocked: ${String(url).slice(0, 120)}`);
    openExternalSafe(url);
  };
  contents.on('will-navigate', onNavigate);
  contents.on('will-redirect', (event, url, _inPlace, isMainFrame) => {
    if (isMainFrame) onNavigate(event, url);
  });
  contents.on('will-attach-webview', (event) => event.preventDefault());
}

module.exports = {
  TRACKER_DOMAINS,
  hardenGameSession,
  guardNavigation,
  setBrowsing,
  isGameUrl,
  isAuthPopupUrl,
  openExternalSafe,
  isTracker: (url) => {
    const parsed = parseUrl(url);
    return Boolean(parsed && isTracker(parsed));
  }
};
