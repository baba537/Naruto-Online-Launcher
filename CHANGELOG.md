# Changelog

## 1.1.1 (2026-09-23)

- Linux: pages opened from the game (official website, top-up) report the same platform as the user agent, so the website no longer switches to its mobile layout
- Windows: graphics cards that were removed long ago but are still listed in the registry are ignored; a desktop PC was shown as a laptop with two GPUs
- Pages opened from the game no longer load the Flash plugin

## 1.1.0 (2026-09-20)

- Pages the game opens itself (top-up, official website, support) open as a tab in the game window instead of a separate window; can be switched off
- Top-up pages work again: they are no longer cut off by the strict network mode, and payment providers may be reached
- Position and size of the launcher window and of the game window are remembered
- A login is written to disk right away, so it survives closing the launcher or restarting the machine
- A restart is only requested for the setting that needs one (the performance preset); the detailed log now takes effect immediately
- Optional version check on GitHub at startup, with a note in the launcher

## 1.0.0 (2026-09-19)

First public release.

- Game window with tabs, one isolated session per account; optional one window per account
- Automatic sign-in from an encrypted vault (Windows DPAPI, Linux keyring, optional master password)
- Valid logins are kept across restarts; servers picked on the server list open in the same tab
- Zoom per account (sharp in 20 % steps, or smooth upscaling), mute per account, `F9` screenshots
- Flash quality presets, CPU priority, GPU detection with Linux driver settings, longer caching for versioned game files
- Tracker blocker, strict network mode, navigation limited to the game's domains, sandboxed renderers
- Bundled PPAPI Flash plugin, checked against its SHA-256 before loading
- Automatic reload after a Flash crash
- English and German interface
