'use strict';

// Preload for pages the game opens itself (top-up, website). Isolated from the
// page and exposes nothing to it.
//
// The launcher identifies as Chrome on Windows (see LAUNCHER_UA in main.js).
// On Linux navigator.platform still said "Linux x86_64", and the website
// answered that mix with its mobile layout. The value is aligned with the user
// agent before any script of the page runs.

(function () {
  if (process.platform === 'win32') return;
  require('electron').webFrame.executeJavaScript(
    "Object.defineProperty(Navigator.prototype, 'platform', { get: function () { return 'Win32'; }, configurable: true });"
  );
})();
