'use strict';

// Checks that run without Electron: syntax of every source file and tests for
// the plain Node modules.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL  ${name}\n        ${err.stack || err}`);
  }
}

function jsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return jsFiles(p);
    return e.name.endsWith('.js') ? [p] : [];
  });
}

(async () => {
  console.log('syntax');
  for (const file of [...jsFiles(path.join(root, 'src')), __filename]) {
    await test(path.relative(root, file), () => execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' }));
  }

  console.log('modules');
  const urls = require('../src/config/urls');
  await test('game url without server', () => {
    assert.strictEqual(
      urls.getGameUrl('de'),
      'https://naruto.narutowebgame.com/de/serverlist?logintype=4&leftbar_collapse=Yes&launcher=shinobi'
    );
  });
  await test('game url with server, unknown region falls back to de', () => {
    assert.ok(urls.getGameUrl('xx', '799').startsWith('https://naruto.narutowebgame.com/de/serverlist/s799?'));
    assert.ok(urls.getGameUrl('pl', 'S12').includes('/pl/serverlist/s12?'));
  });
  await test('server validation', () => {
    assert.ok(urls.isValidServer('799') && urls.isValidServer('s799') && urls.isValidServer(''));
    assert.ok(!urls.isValidServer('../x') && !urls.isValidServer('799?a=1'));
  });
  await test('host matching accepts subdomains only', () => {
    assert.ok(urls.hostMatches('passport.oasgames.com', urls.GAME_DOMAINS));
    assert.ok(!urls.hostMatches('evil-oasgames.com', urls.GAME_DOMAINS));
    assert.ok(!urls.hostMatches('oasgames.com.evil.net', urls.GAME_DOMAINS));
  });
  await test('login server is never blocked', () => {
    assert.ok(urls.NEVER_BLOCK_HOSTS.includes('passport.oasgames.com'));
  });
  await test('hong kong region removed', () => assert.ok(!urls.isValidRegion('hk')));
  await test('server page pattern', () => {
    const src = fs.readFileSync(path.join(root, 'src/modules/sessionManager.js'), 'utf8');
    const re = new RegExp(src.match(/SERVER_PAGE_RE = \/(.*)\/i;/)[1], 'i');
    assert.ok(re.test('https://naruto.narutowebgame.com/de/serverlist/s336'));
    assert.ok(!re.test('https://naruto.narutowebgame.com/de/serverlist'));
    assert.ok(!re.test('https://evil.com/?x=https://naruto.narutowebgame.com/de/serverlist/s1'));
  });

  const optimization = require('../src/config/optimization');
  await test('presets resolve', () => {
    assert.strictEqual(optimization.resolvePreset('performance').id, 'performance');
    assert.ok(['quality', 'balanced', 'low-spec'].includes(optimization.resolvePreset('auto').id));
    assert.ok(['quality', 'balanced', 'low-spec'].includes(optimization.resolvePreset('nonsense').id));
  });
  await test('explicit flash quality wins over the preset', () => {
    const preset = optimization.PRESETS['low-spec'];
    assert.strictEqual(optimization.resolveFlashQuality(preset, { flashQuality: 'preset' }), 'low');
    assert.strictEqual(optimization.resolveFlashQuality(preset, { flashQuality: 'best' }), 'best');
  });
  await test('settings reset keeps language and window size', () => {
    const { Settings } = require('../src/modules/settings');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nol-settings-'));
    const s = new Settings(dir);
    s.update({ language: 'de', gameWidth: 1600, preset: 'low-spec', strictNetwork: false });
    s.reset();
    const again = new Settings(dir);
    assert.strictEqual(again.get('language'), 'de');
    assert.strictEqual(again.get('gameWidth'), 1600);
    assert.strictEqual(again.get('preset'), 'auto');
    assert.strictEqual(again.get('strictNetwork'), true);
    fs.rmdirSync(dir, { recursive: true });
  });

  const { parseCpuList } = require('../src/modules/cpuOptimizer');
  await test('cpu lists', () => {
    assert.deepStrictEqual(parseCpuList('0-3,8,10-11'), [0, 1, 2, 3, 8, 10, 11]);
    assert.deepStrictEqual(parseCpuList(''), []);
  });

  const { isVersioned } = require('../src/modules/assetCache');
  await test('asset cache only touches versioned urls', () => {
    assert.ok(isVersioned(new URL('https://res.example.com/ui/main.swf?v=20260901')));
    assert.ok(isVersioned(new URL('https://res.example.com/20260901/ui/main.swf')));
    assert.ok(isVersioned(new URL('https://res.example.com/ui/main.3fa9c0d1e2.swf')));
    assert.ok(!isVersioned(new URL('https://res.example.com/ui/main.swf')));
    assert.ok(!isVersioned(new URL(`https://res.example.com/ui/main.swf?v=${Date.now()}`)), 'timestamp is a cache buster');
  });

  const autoLogin = require('../src/modules/autoLogin');
  await test('jwt expiry', () => {
    const payload = Buffer.from(JSON.stringify({ exp: 2000000000 })).toString('base64').replace(/=+$/, '');
    assert.strictEqual(autoLogin.jwtExpiry(`x.${payload}.y`), 2000000000 * 1000);
    assert.strictEqual(autoLogin.jwtExpiry('not-a-jwt'), null);
  });
  await test('login script compiles and escapes the password', () => {
    const code = autoLogin.buildLoginScript('user', `pa"ss'\n</script>`);
    new vm.Script(code); // throws on a syntax error
    assert.ok(code.includes(JSON.stringify(`pa"ss'\n</script>`)));
  });

  const i18n = require('../src/shared/i18n');
  await test('german texts only use keys that exist in english', () => {
    const extra = Object.keys(i18n.dictionaries.de).filter((k) => !(k in i18n.dictionaries.en));
    assert.deepStrictEqual(extra, []);
  });
  await test('every data-i18n key of the UI exists', () => {
    const html = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8');
    const keys = [...html.matchAll(/data-i18n(?:-placeholder)?="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(keys.length > 20);
    assert.deepStrictEqual(keys.filter((k) => !(k in i18n.dictionaries.en)), []);
  });
  await test('every t(...) key used in the renderer exists', () => {
    const src = fs.readFileSync(path.join(root, 'src/renderer/renderer.js'), 'utf8');
    const keys = [...src.matchAll(/\bt\('([a-zA-Z.-]+)'/g)].map((m) => m[1]);
    assert.deepStrictEqual(keys.filter((k) => !(k in i18n.dictionaries.en)), []);
  });

  const { CredentialVault } = require('../src/modules/credentialVault');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nol-vault-'));
  await test('vault stores and reads a login', async () => {
    const v = new CredentialVault(tmp);
    await v.init();
    await v.saveAccount({ id: 'main', label: 'Main', region: 'de', server: '799', username: 'ninja', password: 'secret!' });
    const raw = fs.readFileSync(path.join(tmp, 'vault.json'), 'utf8');
    assert.ok(!raw.includes('secret!') && !raw.includes('ninja'), 'plain text in vault.json');
    const v2 = new CredentialVault(tmp);
    await v2.init();
    assert.deepStrictEqual(await v2.getCredentials('main'), { username: 'ninja', password: 'secret!' });
  });
  await test('vault keeps zoom and mute per account', async () => {
    const v = new CredentialVault(tmp);
    await v.init();
    v.setPrefs('main', { zoom: 1.3, muted: true });
    const acc = new CredentialVault(tmp).getAccount('main');
    assert.strictEqual(acc.zoom, 1.3);
    assert.strictEqual(acc.muted, true);
  });
  await test('master password locks and unlocks', async () => {
    const v = new CredentialVault(tmp);
    await v.init();
    await v.setMasterPassword('a-long-password');
    const v2 = new CredentialVault(tmp);
    await v2.init();
    assert.ok(v2.status().locked);
    await assert.rejects(() => v2.getCredentials('main'));
    await assert.rejects(() => v2.unlock('wrong-password'));
    await v2.unlock('a-long-password');
    assert.strictEqual((await v2.getCredentials('main')).password, 'secret!');
    await v2.removeMasterPassword();
    const v3 = new CredentialVault(tmp);
    await v3.init();
    assert.ok(!v3.status().locked);
  });
  await test('entries copied to another account id do not decrypt', async () => {
    const file = path.join(tmp, 'vault.json');
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    data.accounts.copy = { ...data.accounts.main, label: 'Copy' };
    fs.writeFileSync(file, JSON.stringify(data));
    const v = new CredentialVault(tmp);
    await v.init();
    await assert.rejects(() => v.getCredentials('copy'));
  });
  fs.rmdirSync(tmp, { recursive: true });

  console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
  process.exit(failed ? 1 : 0);
})();
