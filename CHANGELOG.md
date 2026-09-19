# Changelog

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
