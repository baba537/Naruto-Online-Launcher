'use strict';

// Looks up the latest release on GitHub. Only the version number is read; the
// download stays a manual step in the browser, the launcher never replaces
// itself. Can be switched off (setting checkUpdates).
//
// The request uses its own in-memory session: the launcher window blocks all
// network traffic, and nothing of this check should end up in a game session.

const log = require('./logger').create('update');

const REPO = 'baba537/Naruto-Online-Launcher';
const API_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const RELEASES_URL = `https://github.com/${REPO}/releases/latest`;
const TIMEOUT_MS = 8000;
const MAX_BYTES = 512 * 1024;

function parts(version) {
  return String(version || '')
    .replace(/^v/i, '')
    .split(/[.+-]/)
    .map((n) => parseInt(n, 10))
    .filter((n) => Number.isInteger(n));
}

/** True if a is a higher version than b (1.2.0 > 1.1.9). */
function isNewer(a, b) {
  const left = parts(a);
  const right = parts(b);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff !== 0) return diff > 0;
  }
  return false;
}

function fetchLatestTag() {
  // required here so the module can be loaded without Electron (checks)
  const { net, session } = require('electron');
  return new Promise((resolve, reject) => {
    const request = net.request({
      method: 'GET',
      url: API_URL,
      session: session.fromPartition('update-check'),
      useSessionCookies: false
    });
    request.setHeader('Accept', 'application/vnd.github+json');
    const timer = setTimeout(() => {
      request.abort();
      reject(new Error('timeout'));
    }, TIMEOUT_MS);

    request.on('response', (response) => {
      if (response.statusCode !== 200) {
        clearTimeout(timer);
        response.resume();
        reject(new Error(`HTTP ${response.statusCode}`));
        return;
      }
      let body = '';
      response.on('data', (chunk) => {
        body += chunk.toString('utf8');
        if (body.length > MAX_BYTES) {
          clearTimeout(timer);
          request.abort();
          reject(new Error('response too large'));
        }
      });
      response.on('end', () => {
        clearTimeout(timer);
        try {
          const tag = JSON.parse(body).tag_name;
          if (typeof tag !== 'string' || !/^v?\d+(\.\d+)*$/.test(tag)) throw new Error('unexpected tag');
          resolve(tag);
        } catch (err) {
          reject(err);
        }
      });
    });
    request.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    request.end();
  });
}

/**
 * @returns {Promise<?{version: string, url: string}>} the newer release, or null
 */
async function check(currentVersion) {
  let tag;
  try {
    tag = await fetchLatestTag();
  } catch (err) {
    log.info(`update check failed: ${err.message}`);
    return null;
  }
  if (!isNewer(tag, currentVersion)) {
    log.info(`up to date (${currentVersion}, latest ${tag})`);
    return null;
  }
  log.info(`update available: ${tag} (installed ${currentVersion})`);
  return { version: tag.replace(/^v/i, ''), url: RELEASES_URL };
}

module.exports = { check, isNewer, RELEASES_URL };
