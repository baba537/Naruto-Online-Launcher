'use strict';

// Preload for game views. Runs in every frame, isolated from the page, and
// exposes nothing to it. Its only job is to set the quality of Flash embeds
// before the plugin starts; a running plugin ignores later changes.

(function () {
  const arg = (name) => {
    const prefix = `--nol-${name}=`;
    const found = process.argv.find((a) => a.startsWith(prefix));
    return found ? found.slice(prefix.length) : 'default';
  };

  const quality = arg('flash-quality');
  const debug = arg('debug') === '1';
  if (quality === 'default' && !debug) return;

  const FLASH_TYPE = 'application/x-shockwave-flash';
  const FLASH_CLASSID = /d27cdb6e-ae6d-11cf-96b8-444553540000/i;
  const tuned = new WeakSet();

  function isFlash(el) {
    if (el.tagName !== 'EMBED' && el.tagName !== 'OBJECT') return false;
    const type = (el.getAttribute('type') || '').toLowerCase();
    const src = el.getAttribute('src') || el.getAttribute('data') || '';
    return type === FLASH_TYPE || /\.swf(\?|$)/i.test(src) || FLASH_CLASSID.test(el.getAttribute('classid') || '');
  }

  function readParam(el, name) {
    if (el.tagName === 'EMBED') return el.getAttribute(name);
    const param = Array.from(el.children).find((c) => c.tagName === 'PARAM' && (c.getAttribute('name') || '').toLowerCase() === name);
    return param ? param.getAttribute('value') : null;
  }

  function writeParam(el, name, value) {
    if (el.tagName === 'EMBED') {
      el.setAttribute(name, value);
      return;
    }
    let param = Array.from(el.children).find((c) => c.tagName === 'PARAM' && (c.getAttribute('name') || '').toLowerCase() === name);
    if (!param) {
      param = document.createElement('param');
      param.setAttribute('name', name);
      el.insertBefore(param, el.firstChild);
    }
    param.setAttribute('value', value);
  }

  function tune(el) {
    if (tuned.has(el)) return;
    tuned.add(el);
    const before = { quality: readParam(el, 'quality'), wmode: readParam(el, 'wmode'), scale: readParam(el, 'scale') };
    if (quality !== 'default') writeParam(el, 'quality', quality);
    const src = el.getAttribute('src') || el.getAttribute('data') || '';
    // picked up by the main process log (console-message)
    console.log(`[nol] flash embed ${el.tagName.toLowerCase()} ${src.split('?')[0].slice(-60)} before=${JSON.stringify(before)} quality=${quality}`);
  }

  function scan(root) {
    if (!root || !root.querySelectorAll) return;
    if (root.nodeType === 1 && isFlash(root)) tune(root);
    root.querySelectorAll('embed, object').forEach((el) => isFlash(el) && tune(el));
  }

  new MutationObserver((mutations) => {
    for (const m of mutations) m.addedNodes.forEach((node) => node.nodeType === 1 && scan(node));
  }).observe(document, { childList: true, subtree: true });

  document.addEventListener('DOMContentLoaded', () => scan(document));
})();
