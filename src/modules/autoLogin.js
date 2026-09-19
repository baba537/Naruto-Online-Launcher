'use strict';

// Automatic sign-in with the stored login.
//
// The site keeps the login in the cookie `oas_user`, a JWT. While it is valid
// the game opens directly. Otherwise the visible login form is filled and its
// button clicked. Server pages use the fields hd_oasun/hd_oaspd, the server
// list uses oasun/oaspd.
//
// The site sets the cookie without an expiry date, so Chromium drops it on
// exit although the token inside stays valid. keepLoginCookie() stores it with
// the token's own expiry instead, the same effect as "remember me".

const log = require('./logger').create('login');
const urls = require('../config/urls');

const MIN_REMAINING_MS = 5 * 60 * 1000;

function jwtExpiry(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
  } catch (_) {
    return null;
  }
}

async function getLoginCookie(ses) {
  const cookies = await ses.cookies.get({ url: urls.LOGIN_COOKIE_URL, name: urls.LOGIN_COOKIE });
  return cookies[0] || null;
}

/** True if the session holds a login token that is valid for at least five more minutes. */
async function hasValidLogin(ses) {
  const cookie = await getLoginCookie(ses);
  if (!cookie || !cookie.value) return false;
  const expiry = jwtExpiry(cookie.value);
  if (expiry === null) return true; // not a JWT; trust the cookie
  return expiry - Date.now() > MIN_REMAINING_MS;
}

const watched = new WeakSet();
const kept = new WeakMap(); // session -> last token made persistent

function keepLoginCookie(ses) {
  if (watched.has(ses)) return;
  watched.add(ses);
  ses.cookies.on('changed', (_event, cookie, _cause, removed) => {
    if (removed || cookie.name !== urls.LOGIN_COOKIE || !cookie.session) return;
    const expiry = jwtExpiry(cookie.value);
    if (!expiry || expiry < Date.now() || kept.get(ses) === cookie.value) return;
    kept.set(ses, cookie.value);
    const host = String(cookie.domain || '').replace(/^\./, '');
    ses.cookies
      .set({
        url: `https://${host}${cookie.path || '/'}`,
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path,
        secure: cookie.secure,
        httpOnly: cookie.httpOnly,
        sameSite: cookie.sameSite,
        expirationDate: Math.floor(expiry / 1000)
      })
      .then(() => log.info(`login kept until ${new Date(expiry).toISOString()}`))
      .catch((err) => log.warn(`could not keep login cookie: ${err.message}`));
  });
}

/**
 * Script for an isolated world: waits for a visible login form, fills it,
 * ticks "remember me" and clicks the login button. Resolves with
 * 'submitted', 'submitted-enter' or 'no-form'.
 */
function buildLoginScript(username, password, timeoutMs = 15000) {
  return `(function (u, p, timeoutMs) {
  var USER = ['input[name="oasun"]', 'input[name="hd_oasun"]', 'input[name="user_email"]', '#user_email'];
  var PASS = ['input[name="oaspd"]', 'input[name="hd_oaspd"]', 'input[name="user_password"]', '#user_password'];
  var REMEMBER = ['#checkbox', '#hd_checkbox', '#checkbox_pwd', '#checked_pwd'];
  var BUTTON = ['a.hd_login_btn', 'a.login_btn', '.hd_login_btn', '.login_btn', '[class*="login_btn"]', '[id*="login_btn"]'];
  var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;

  function visible(el) { return !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length)); }
  function pick(selectors, scope) {
    for (var i = 0; i < selectors.length; i++) {
      var found = (scope || document).querySelectorAll(selectors[i]);
      for (var j = 0; j < found.length; j++) if (visible(found[j])) return found[j];
    }
    return null;
  }
  function fill(el, value) {
    el.focus();
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'a' }));
  }
  function findButton(field) {
    var node = field;
    for (var i = 0; i < 8 && node; i++) {
      node = node.parentElement;
      var b = node && pick(BUTTON, node);
      if (b) return b;
    }
    if (field.form) {
      var s = field.form.querySelector('[type="submit"], button:not([type]), input[type="image"]');
      if (s) return s;
    }
    return null;
  }

  return new Promise(function (resolve) {
    var started = Date.now();
    (function poll() {
      var user = pick(USER);
      var pass = pick(PASS);
      if (!user || !pass) {
        if (Date.now() - started > timeoutMs) return resolve('no-form');
        return setTimeout(poll, 400);
      }
      fill(user, u);
      fill(pass, p);
      REMEMBER.forEach(function (sel) {
        var box = document.querySelector(sel);
        if (box && box.type === 'checkbox' && !box.checked) box.click();
      });
      var button = findButton(pass);
      setTimeout(function () {
        if (button) {
          button.click();
          return resolve('submitted');
        }
        ['keydown', 'keypress', 'keyup'].forEach(function (type) {
          pass.dispatchEvent(new KeyboardEvent(type, { bubbles: true, key: 'Enter', keyCode: 13, which: 13 }));
        });
        resolve('submitted-enter');
      }, 250);
    })();
  });
})(${JSON.stringify(username)}, ${JSON.stringify(password)}, ${Number(timeoutMs)});`;
}

module.exports = { hasValidLogin, keepLoginCookie, buildLoginScript, jwtExpiry };
