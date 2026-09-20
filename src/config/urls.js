'use strict';

// Game URLs per region and the domain lists the security rules are built on.

const BASE = 'https://naruto.narutowebgame.com';

const REGIONS = {
  de: `${BASE}/de/serverlist`,
  eu: `${BASE}/en/serverlist`,
  na: `${BASE}/en/serverlist`,
  fr: `${BASE}/fr/serverlist`,
  es: `${BASE}/es/serverlist`,
  pl: `${BASE}/pl/serverlist`,
  br: `${BASE}/pt/serverlist`
};

const DEFAULT_REGION = 'de';
// The site switches to its launcher layout with these parameters.
const LAUNCHER_PARAMS = 'logintype=4&leftbar_collapse=Yes&launcher=shinobi';
const SERVER_RE = /^s?\d{1,5}$/i;

// Pages that may open inside a game window (subdomains included).
// passport.oasgames.com (login) belongs to oasgames.com.
const GAME_DOMAINS = ['narutowebgame.com', 'oasgames.com'];

// Third-party sign-in, allowed as popups inside the launcher.
const AUTH_POPUP_DOMAINS = ['accounts.google.com', 'www.facebook.com', 'm.facebook.com', 'facebook.com', 'appleid.apple.com'];

// Never blocked, not even by the tracker blocker.
const NEVER_BLOCK_HOSTS = ['passport.oasgames.com', 'odp3.oasgames.com', 'vipsac.oasgames.com'];

// Hosts the game is known to need. Only used by the strict network mode.
const RESOURCE_DOMAINS = [
  ...GAME_DOMAINS,
  'qq.com', // res.huoying.qq.com serves the game SWFs
  'gtimg.cn',
  'oasispay.org', // payment pages (pay/api/res.oasispay.org)
  'oasimage-bucket.s3.amazonaws.com', // images of the website
  'bootcss.com', // css/js library used by the website
  'cloudflare.com', // challenges.cloudflare.com, bot check in front of the server list
  'facebook.net', // Facebook SDK for Facebook sign-in
  'facebook.com',
  'fbcdn.net',
  'google.com',
  'gstatic.com',
  'googleapis.com',
  'recaptcha.net',
  'apple.com'
];

// Cookie that holds the login token (a JWT) once signed in.
const LOGIN_COOKIE = 'oas_user';
const LOGIN_COOKIE_URL = `${BASE}/`;

function hostMatches(host, domains) {
  const h = String(host || '').toLowerCase();
  return domains.some((d) => h === d || h.endsWith('.' + d));
}

function isValidRegion(region) {
  return Object.prototype.hasOwnProperty.call(REGIONS, region);
}

function isValidServer(server) {
  return server === '' || server === null || server === undefined || SERVER_RE.test(String(server).trim());
}

function getGameUrl(region, server) {
  const base = REGIONS[region] || REGIONS[DEFAULT_REGION];
  let url = base;
  if (server && SERVER_RE.test(String(server).trim())) {
    let s = String(server).toLowerCase().trim();
    if (!s.startsWith('s')) s = 's' + s;
    url = `${base}/${s}`;
  }
  return `${url}?${LAUNCHER_PARAMS}`;
}

module.exports = {
  REGIONS,
  DEFAULT_REGION,
  LAUNCHER_PARAMS,
  GAME_DOMAINS,
  AUTH_POPUP_DOMAINS,
  NEVER_BLOCK_HOSTS,
  RESOURCE_DOMAINS,
  LOGIN_COOKIE,
  LOGIN_COOKIE_URL,
  hostMatches,
  isValidRegion,
  isValidServer,
  getGameUrl
};
