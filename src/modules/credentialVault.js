'use strict';

// Encrypted storage for accounts and logins (envelope encryption).
//
//   - A random 256-bit data key encrypts every login with AES-256-GCM. The
//     account id is bound as additional authenticated data, so entries cannot
//     be swapped between accounts unnoticed.
//   - The data key itself is protected by the best available method:
//       password   master password -> PBKDF2-SHA256, 600,000 iterations
//       dpapi      Windows DPAPI, bound to the Windows user account
//       libsecret  Linux keyring (GNOME Keyring / KWallet) via secret-tool
//       machine    fallback: PBKDF2 over machine id + user name. Only stops the
//                  file from being readable on another computer.
//
// Electron 11 has no safeStorage (added in 15), so DPAPI and libsecret are used
// through the operating system tools. Plain passwords never leave the main process.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');
const log = require('./logger').create('vault');
const { UserError } = require('./errors');

const VAULT_VERSION = 2;
const PBKDF2_ITERATIONS_PASSWORD = 600000;
const PBKDF2_ITERATIONS_MACHINE = 100000;
const MIN_MASTER_PASSWORD_LENGTH = 8;
const SECRET_TOOL_ATTRS = ['application', 'naruto-online-launcher', 'purpose', 'vault-key-v2'];
const ACCOUNT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

const b64 = (buf) => Buffer.from(buf).toString('base64');
const unb64 = (str) => Buffer.from(String(str || ''), 'base64');

function encrypt(key, plaintext, aad) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  if (aad) cipher.setAAD(Buffer.from(aad, 'utf8'));
  const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv: b64(iv), tag: b64(cipher.getAuthTag()), data: b64(data) };
}

function decrypt(key, box, aad) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, unb64(box.iv));
  if (aad) decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(unb64(box.tag));
  return Buffer.concat([decipher.update(unb64(box.data)), decipher.final()]);
}

function pbkdf2(secret, salt, iterations) {
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(secret, salt, iterations, 32, 'sha256', (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/** Runs a program, writes `input` to stdin and resolves with stdout. */
function run(cmd, args, input, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${cmd}: timeout`));
    }, timeoutMs);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`${cmd} exited with ${code}: ${stderr.trim().slice(0, 200)}`));
    });
    child.stdin.end(input || '');
  });
}

// ---------------------------------------------------------------------------
// Protectors for the data key
// ---------------------------------------------------------------------------
const DPAPI_SCRIPT = (method) =>
  'Add-Type -AssemblyName System.Security;' +
  '$in=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim());' +
  `$out=[Security.Cryptography.ProtectedData]::${method}($in,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);` +
  '[Convert]::ToBase64String($out)';

const dpapi = {
  available: () => process.platform === 'win32',
  async protect(key) {
    const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', DPAPI_SCRIPT('Protect')], b64(key));
    return { blob: out.trim() };
  },
  async unprotect(wrapped) {
    const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', DPAPI_SCRIPT('Unprotect')], wrapped.blob);
    return unb64(out.trim());
  }
};

const libsecret = {
  available() {
    if (process.platform !== 'linux') return false;
    try {
      execFileSync('secret-tool', ['--version'], { stdio: 'ignore', timeout: 3000 });
      return true;
    } catch (_) {
      return false;
    }
  },
  async protect(key) {
    await run('secret-tool', ['store', '--label=Naruto Online Launcher', ...SECRET_TOOL_ATTRS], b64(key));
    // Without a running keyring daemon some setups "store" without error.
    const check = await run('secret-tool', ['lookup', ...SECRET_TOOL_ATTRS], '');
    if (check.trim() !== b64(key)) throw new Error('keyring does not return the stored key');
    return {};
  },
  async unprotect() {
    const key = unb64((await run('secret-tool', ['lookup', ...SECRET_TOOL_ATTRS], '')).trim());
    if (key.length !== 32) throw new Error('no vault key in the keyring');
    return key;
  },
  async clear() {
    try {
      await run('secret-tool', ['clear', ...SECRET_TOOL_ATTRS], '');
    } catch (_) {
      // nothing stored
    }
  }
};

function machineId() {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 3000
      });
      const m = out.match(/MachineGuid\s+REG_SZ\s+(\S+)/);
      if (m) return m[1];
    } else {
      for (const f of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
        if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
      }
    }
  } catch (_) {
    // fall through
  }
  return os.hostname();
}

const machine = {
  available: () => true,
  kek(salt) {
    const seed = `naruto-online-launcher|${machineId()}|${os.userInfo().username}|${process.platform}`;
    return pbkdf2(seed, salt, PBKDF2_ITERATIONS_MACHINE);
  },
  async protect(key) {
    const salt = crypto.randomBytes(16);
    return { salt: b64(salt), iterations: PBKDF2_ITERATIONS_MACHINE, box: encrypt(await this.kek(salt), key) };
  },
  async unprotect(wrapped) {
    return decrypt(await this.kek(unb64(wrapped.salt)), wrapped.box);
  }
};

const PROTECTORS = { dpapi, libsecret, machine };

// ---------------------------------------------------------------------------
// Vault
// ---------------------------------------------------------------------------
class CredentialVault {
  constructor(userDataDir) {
    this.file = path.join(userDataDir, 'vault.json');
    this.dataKey = null; // Buffer while unlocked
    this.data = this._load();
  }

  static isValidId(id) {
    return typeof id === 'string' && ACCOUNT_ID_RE.test(id);
  }

  _empty() {
    return { version: VAULT_VERSION, protection: null, wrappedKey: null, accounts: {} };
  }

  _load() {
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') log.error('vault.json unreadable, starting empty:', err.message);
      return this._empty();
    }
    if (!raw || raw.version !== VAULT_VERSION) {
      const backup = `${this.file}.old`;
      try {
        fs.renameSync(this.file, backup);
        log.warn(`unknown vault format moved to ${backup}`);
      } catch (_) {
        // ignore
      }
      return this._empty();
    }
    raw.accounts = raw.accounts && typeof raw.accounts === 'object' ? raw.accounts : {};
    return raw;
  }

  _persist() {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    try {
      fs.chmodSync(this.file, 0o600);
    } catch (_) {
      // no POSIX permissions on Windows
    }
  }

  _bestOsProtection() {
    if (dpapi.available()) return 'dpapi';
    if (libsecret.available()) return 'libsecret';
    return 'machine';
  }

  /** Unlocks a vault without master password at startup. */
  async init() {
    if (this.data.protection && this.data.protection !== 'password') {
      try {
        this.dataKey = await PROTECTORS[this.data.protection].unprotect(this.data.wrappedKey);
        log.info(`unlocked (${this.data.protection}), ${Object.keys(this.data.accounts).length} account(s)`);
      } catch (err) {
        log.error(`could not unlock (${this.data.protection}):`, err.message);
      }
    }
    return this.status();
  }

  status() {
    return {
      protection: this.data.protection || this._bestOsProtection(),
      initialized: Boolean(this.data.protection),
      hasMasterPassword: this.data.protection === 'password',
      locked: Boolean(this.data.protection) && !this.dataKey,
      accountCount: Object.keys(this.data.accounts).length
    };
  }

  async _ensureKey() {
    if (this.dataKey) return this.dataKey;
    if (this.data.protection) throw new UserError('err.vaultLocked');
    const key = crypto.randomBytes(32);
    await this._wrapWithOs(key);
    this.dataKey = key;
    this._persist();
    return key;
  }

  async _wrapWithOs(key) {
    for (const name of [this._bestOsProtection(), 'machine']) {
      try {
        this.data.wrappedKey = await PROTECTORS[name].protect(key);
        this.data.protection = name;
        log.info(`data key protected with ${name}`);
        return;
      } catch (err) {
        log.warn(`protection "${name}" not usable:`, err.message);
      }
    }
    throw new Error('no protection method available');
  }

  async unlock(password) {
    if (this.data.protection !== 'password') return this.status();
    const w = this.data.wrappedKey;
    const kek = await pbkdf2(String(password), unb64(w.salt), w.iterations);
    try {
      this.dataKey = decrypt(kek, w.box);
    } catch (_) {
      log.warn('unlock failed: wrong master password');
      throw new UserError('err.wrongPassword');
    }
    log.info('unlocked with master password');
    return this.status();
  }

  lock() {
    if (this.dataKey && this.data.protection === 'password') {
      this.dataKey.fill(0);
      this.dataKey = null;
      log.info('locked');
    }
    return this.status();
  }

  async setMasterPassword(newPassword) {
    if (typeof newPassword !== 'string' || newPassword.length < MIN_MASTER_PASSWORD_LENGTH) {
      throw new UserError('err.masterTooShort', { n: MIN_MASTER_PASSWORD_LENGTH });
    }
    const key = await this._ensureKey();
    const previous = this.data.protection;
    const salt = crypto.randomBytes(16);
    const kek = await pbkdf2(newPassword, salt, PBKDF2_ITERATIONS_PASSWORD);
    this.data.wrappedKey = { salt: b64(salt), iterations: PBKDF2_ITERATIONS_PASSWORD, box: encrypt(kek, key) };
    this.data.protection = 'password';
    this._persist();
    if (previous === 'libsecret') await libsecret.clear();
    log.info('master password set');
    return this.status();
  }

  async removeMasterPassword() {
    if (this.data.protection !== 'password') return this.status();
    if (!this.dataKey) throw new UserError('err.vaultLocked');
    await this._wrapWithOs(this.dataKey);
    this._persist();
    log.info('master password removed');
    return this.status();
  }

  async reset() {
    if (this.data.protection === 'libsecret') await libsecret.clear();
    if (this.dataKey) this.dataKey.fill(0);
    this.dataKey = null;
    this.data = this._empty();
    this._persist();
    log.warn('vault reset');
    return this.status();
  }

  // ---- accounts --------------------------------------------------------------
  _publicAccount(id, a) {
    return {
      id,
      label: a.label,
      region: a.region,
      server: a.server || '',
      zoom: typeof a.zoom === 'number' ? a.zoom : 1,
      muted: a.muted === true,
      hasCredentials: Boolean(a.secret),
      createdAt: a.createdAt
    };
  }

  listAccounts() {
    return Object.entries(this.data.accounts)
      .map(([id, a]) => this._publicAccount(id, a))
      .sort((a, b) => a.label.localeCompare(b.label));
  }

  getAccount(id) {
    const a = this.data.accounts[id];
    return a ? this._publicAccount(id, a) : null;
  }

  /**
   * Creates or updates an account. Empty username and password keep the stored
   * login, `clearCredentials` deletes it.
   */
  async saveAccount({ id, label, region, server, username, password, clearCredentials }) {
    if (!CredentialVault.isValidId(id)) throw new UserError('err.invalidInput', { field: 'id' });
    const existing = this.data.accounts[id] || {};
    const entry = {
      label,
      region,
      server: server || '',
      zoom: existing.zoom,
      muted: existing.muted,
      createdAt: existing.createdAt || new Date().toISOString(),
      secret: clearCredentials ? undefined : existing.secret
    };
    if (username || password) {
      if (!username || !password) throw new UserError('err.credsTogether');
      const key = await this._ensureKey();
      entry.secret = encrypt(key, Buffer.from(JSON.stringify({ username, password }), 'utf8'), `account:${id}`);
    }
    this.data.accounts[id] = entry;
    this._persist();
    log.info(`account saved: ${id}${entry.secret ? ' (with login)' : ''}`);
    return this.getAccount(id);
  }

  /** Per-account view preferences that are not secret: zoom and mute. */
  setPrefs(id, { zoom, muted }) {
    const entry = this.data.accounts[id];
    if (!entry) return;
    if (typeof zoom === 'number' && zoom >= 0.25 && zoom <= 5) entry.zoom = Math.round(zoom * 100) / 100;
    if (typeof muted === 'boolean') entry.muted = muted;
    this._persist();
  }

  /** Main process only (auto login). Returns null when no login is stored. */
  async getCredentials(id) {
    const entry = this.data.accounts[id];
    if (!entry || !entry.secret) return null;
    if (!this.dataKey) throw new UserError('err.vaultLocked');
    try {
      return JSON.parse(decrypt(this.dataKey, entry.secret, `account:${id}`).toString('utf8'));
    } catch (err) {
      log.error(`login of ${id} cannot be decrypted:`, err.message);
      throw new UserError('err.credsBroken');
    }
  }

  async removeAccount(id) {
    if (!this.data.accounts[id]) return false;
    delete this.data.accounts[id];
    this._persist();
    log.info(`account removed: ${id}`);
    return true;
  }
}

module.exports = { CredentialVault, MIN_MASTER_PASSWORD_LENGTH };
