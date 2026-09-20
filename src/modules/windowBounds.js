'use strict';

// Position and size of windows. A stored position is only used again when it
// still lies on one of the connected displays; otherwise a window would open
// outside the visible area after the monitor setup changed.

const { screen } = require('electron');

const SAVE_DELAY_MS = 600;
const MARGIN = 40; // this much of the window has to stay grabbable

function isOnScreen(x, y, width, height) {
  if (!Number.isInteger(x) || !Number.isInteger(y)) return false;
  return screen.getAllDisplays().some((display) => {
    const area = display.workArea;
    return (
      x + width > area.x + MARGIN &&
      x < area.x + area.width - MARGIN &&
      y + height > area.y &&
      y < area.y + area.height - MARGIN
    );
  });
}

/** {x, y} when the stored position is still usable, otherwise {} (the system centers the window). */
function position(stored, width, height) {
  return isOnScreen(stored.x, stored.y, width, height) ? { x: stored.x, y: stored.y } : {};
}

/**
 * Calls save({x, y, width, height}) once the user stopped moving or resizing,
 * and once more when the window closes. Maximized, minimized and fullscreen
 * states are skipped so the restored size stays the one the user set.
 */
function track(win, save) {
  let timer = null;
  const store = () => {
    clearTimeout(timer);
    timer = null;
    if (win.isDestroyed() || win.isMinimized() || win.isMaximized() || win.isFullScreen()) return;
    const [x, y] = win.getPosition();
    const [width, height] = win.getContentSize();
    try {
      save({ x, y, width, height });
    } catch (_) {
      // outside the allowed range, keep the last valid values
    }
  };
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(store, SAVE_DELAY_MS);
  };
  win.on('move', schedule);
  win.on('resize', schedule);
  win.on('close', store);
}

module.exports = { isOnScreen, position, track };
