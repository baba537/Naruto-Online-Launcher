'use strict';

// Launcher UI. Runs sandboxed without Node and talks to the main process only
// through window.launcher (preload.js). Data is inserted as text, never as HTML.

(function () {
  const api = window.launcher;
  const I18N = window.NolI18n;
  const $ = (id) => document.getElementById(id);
  let state = null;
  let lastMetrics = null;

  const t = (key, params) => I18N.translate(state ? state.language : 'en', key, params);

  // ---------------------------------------------------------------------------
  // helpers
  // ---------------------------------------------------------------------------
  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (key === 'class') el.className = value;
      else if (key === 'text') el.textContent = value;
      else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
      else el.setAttribute(key, value);
    }
    for (const child of children) if (child) el.append(child);
    return el;
  }

  /** Errors from the main process arrive as "i18n:{key, params}". */
  function errorText(err) {
    const raw = String((err && err.message) || err);
    const m = raw.match(/i18n:(\{.*\})\s*$/);
    if (!m) return raw.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    try {
      const { key, params = {} } = JSON.parse(m[1]);
      if (params.reasonKey) params.reason = t(params.reasonKey);
      return t(key, params);
    } catch (_) {
      return raw;
    }
  }

  let bannerTimer = null;
  function showBanner(text, { error = false, action = null, sticky = false } = {}) {
    $('banner-text').textContent = text;
    $('banner').classList.toggle('error', error);
    $('banner').classList.remove('hidden');
    const btn = $('banner-action');
    btn.classList.toggle('hidden', !action);
    btn.onclick = action ? action.run : null;
    if (action) btn.textContent = action.label;
    clearTimeout(bannerTimer);
    if (!sticky) bannerTimer = setTimeout(hideBanner, error ? 9000 : 5000);
  }

  function hideBanner() {
    $('banner').classList.add('hidden');
  }

  function askRestart(reason) {
    showBanner(t('banner.restart', { reason }), {
      sticky: true,
      action: { label: t('banner.restartNow'), run: () => api.restart() }
    });
  }

  async function run(button, task) {
    if (button) button.disabled = true;
    try {
      return await task();
    } catch (err) {
      showBanner(errorText(err), { error: true });
      return undefined;
    } finally {
      if (button) button.disabled = false;
    }
  }

  function runningInfo(id) {
    return state.running.find((r) => r.id === id) || null;
  }

  // ---------------------------------------------------------------------------
  // static texts
  // ---------------------------------------------------------------------------
  function translateStatic() {
    document.documentElement.lang = state.language;
    for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
    for (const el of document.querySelectorAll('[data-i18n-placeholder]')) el.placeholder = t(el.dataset.i18nPlaceholder);
  }

  // ---------------------------------------------------------------------------
  // tabs
  // ---------------------------------------------------------------------------
  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => {
      for (const other of document.querySelectorAll('.tab')) other.classList.toggle('active', other === tab);
      for (const panel of document.querySelectorAll('.tab-panel')) {
        panel.classList.toggle('hidden', panel.id !== `tab-${tab.dataset.tab}`);
      }
    });
  }

  // ---------------------------------------------------------------------------
  // rendering
  // ---------------------------------------------------------------------------
  function renderChips() {
    const flash = $('chip-flash');
    flash.textContent = t(state.flash.found ? 'chip.flashOk' : 'chip.flashMissing');
    flash.className = `chip ${state.flash.found ? 'ok' : 'bad'}`;

    const vault = $('chip-vault');
    const v = state.vault;
    vault.textContent = t(v.locked ? 'chip.vaultLocked' : v.hasMasterPassword ? 'chip.vaultUnlocked' : 'chip.vaultOk');
    vault.className = `chip ${v.locked ? 'warn' : 'ok'}`;
    $('chip-ram').textContent = lastMetrics ? t('chip.ram', { mb: lastMetrics.totalMB }) : '';
    $('chip-ram').classList.toggle('hidden', !lastMetrics);
  }

  function accountCard(acc) {
    const info = runningInfo(acc.id);
    const running = Boolean(info);
    const badges = h('div', { class: 'badges' },
      h('span', { class: 'badge', text: t(`region.${acc.region}`) }),
      h('span', { class: 'badge', text: acc.server ? t('acc.server', { n: acc.server }) : t('acc.serverList') }),
      acc.hasCredentials ? h('span', { class: 'badge', text: t('acc.autoLogin') }) : null,
      running ? h('span', { class: 'badge ok', text: t('acc.running') }) : null,
      info && info.login !== 'none' ? h('span', { class: `badge login-${info.login}`, text: t(`login.${info.login}`) }) : null
    );

    const play = h('button', { class: 'btn primary', type: 'button', text: t(running ? 'acc.show' : 'acc.play') });
    play.addEventListener('click', () => startGame(acc, play));

    const actions = h('div', { class: 'account-actions' }, play);
    if (running) {
      actions.append(h('button', { class: 'btn', type: 'button', text: t('acc.stop'), onclick: () => run(null, () => api.stopGame(acc.id)) }));
    }
    actions.append(h('button', { class: 'btn', type: 'button', text: t('acc.edit'), onclick: () => openAccountDialog(acc) }));

    const more = h('div', { class: 'account-actions' },
      h('button', {
        class: 'btn small',
        type: 'button',
        text: t('acc.clearCache'),
        onclick: (e) => run(e.currentTarget, async () => {
          await api.clearCache(acc.id);
          showBanner(t('banner.cacheCleared', { name: acc.label }));
        })
      }),
      h('button', {
        class: 'btn small',
        type: 'button',
        text: t('acc.logout'),
        title: t('acc.logoutTitle'),
        onclick: (e) => {
          if (!confirm(t('confirm.logout', { name: acc.label }))) return;
          run(e.currentTarget, async () => {
            await api.clearSession(acc.id);
            showBanner(t('banner.loggedOut', { name: acc.label }));
          });
        }
      }),
      h('button', {
        class: 'btn small danger',
        type: 'button',
        text: t('acc.remove'),
        onclick: (e) => {
          if (!confirm(t('confirm.remove', { name: acc.label }))) return;
          run(e.currentTarget, async () => {
            const res = await api.removeAccount(acc.id);
            state.accounts = res.accounts;
            renderAccounts();
          });
        }
      })
    );

    return h('article', { class: `account${running ? ' running' : ''}` },
      h('div', { class: 'account-head' },
        h('div', { class: 'avatar', text: acc.label.charAt(0).toUpperCase() }),
        h('div', { class: 'account-title' },
          h('div', { class: 'account-name', text: acc.label }),
          h('div', { class: 'account-meta', text: t('acc.id', { id: acc.id }) })
        )
      ),
      badges,
      actions,
      more
    );
  }

  function renderAccounts() {
    $('account-list').replaceChildren(...state.accounts.map(accountCard));
    $('account-empty').classList.toggle('hidden', state.accounts.length > 0);
    $('start-all').classList.toggle('hidden', state.accounts.length < 2);
    $('unlock-box').classList.toggle('hidden', !state.vault.locked);
  }

  function renderSettings() {
    const s = state.settings;
    const presetName = (id) => t(`preset.${id}`);
    const options = [{ id: 'auto', desc: t('preset.auto.desc', { name: presetName(state.preset.autoPick) }) }]
      .concat(state.presets.map((id) => ({ id, desc: t(`preset.${id}.desc`) })));
    $('preset-list').replaceChildren(...options.map((p) => {
      const input = h('input', { type: 'radio', name: 'preset', value: p.id });
      input.checked = s.preset === p.id;
      input.addEventListener('change', () => saveSettings({ preset: p.id }));
      return h('label', { class: `preset${input.checked ? ' selected' : ''}` },
        input,
        h('div', { class: 'preset-title', text: presetName(p.id) }),
        h('div', { class: 'preset-desc', text: p.desc })
      );
    }));
    $('preset-active').textContent = t('settings.presetActive', { name: presetName(state.preset.active) });

    for (const el of document.querySelectorAll('[data-setting-select]')) el.value = s[el.dataset.settingSelect];
    for (const el of document.querySelectorAll('[data-setting]')) el.checked = Boolean(s[el.dataset.setting]);

    const v = state.vault;
    $('vault-description').textContent =
      t(`vault.desc.${v.protection}`) + (v.initialized ? '' : ` ${t('vault.notInitialized')}`);
    $('master-submit').textContent = t(v.hasMasterPassword ? 'master.change' : 'master.set');
    $('master-new').placeholder = t(v.hasMasterPassword ? 'master.newChange' : 'master.new', { n: state.minMasterPasswordLength });
    $('vault-lock').classList.toggle('hidden', !v.hasMasterPassword || v.locked);
    $('master-remove').classList.toggle('hidden', !v.hasMasterPassword);
    $('master-form').classList.toggle('hidden', v.locked);
  }

  function renderSystem() {
    const f = state.flash;
    const status = $('flash-status');
    status.replaceChildren();
    if (f.found) {
      status.append(
        h('span', { class: 'chip ok', text: t('flash.version', { v: f.version }) }), ' ',
        h('span', { class: 'muted', text: `${t(`flash.source.${f.source}`)}: ` }),
        h('span', { class: 'mono small', text: f.path })
      );
    } else {
      status.append(h('span', { class: 'chip bad', text: t('chip.flashMissing') }), ' ', h('span', { text: t('flash.missingText', { file: f.fileName }) }));
    }
    if (f.sha256) status.append(h('div', { class: 'mono small muted', text: `SHA-256 ${f.sha256}` }));
    $('flash-searched').replaceChildren(...f.searched.map((p) => h('li', { text: p })));

    const cpu = state.cpu;
    const gpuName = state.gpu.name + (state.gpu.vramMB ? ` (${t('hw.vram', { gb: Math.round(state.gpu.vramMB / 1024) })})` : '');
    const rows = [
      [t('hw.gpu'), gpuName],
      [t('hw.vendor'), state.gpu.vendor + (state.gpu.isHybrid ? `, ${t('hw.hybrid')}` : '')],
      [t('hw.cpu'), cpu.model],
      [t('hw.threads'), cpu.isHybrid ? `${cpu.logicalCores} (P ${cpu.pCores.length} / E ${cpu.eCores.length})` : String(cpu.logicalCores)],
      [t('hw.cpuOpt'), cpu.enabled ? t('hw.on', { p: cpu.priority }) : t('hw.off')],
      [t('hw.platform'), state.platform]
    ];
    $('hardware').replaceChildren(...rows.flatMap(([k, v]) => [h('dt', { text: k }), h('dd', { text: v })]));
    renderMetrics();
  }

  function renderMetrics() {
    renderChips();
    const m = lastMetrics;
    if (!m) return;
    const rows = [
      [t('res.total'), `${m.totalMB} MB`],
      [t('res.flash'), `${m.flashMB} MB`],
      [t('res.cpu'), `${m.cpuPercent} %`],
      [t('res.processes'), String(m.processes)],
      [t('res.cache'), t('res.cacheValue', { hits: m.cache.hits, misses: m.cache.misses })],
      [t('res.logFile'), state.logFile || '-']
    ];
    $('resources').replaceChildren(...rows.flatMap(([k, v], i) => [
      h('dt', { text: k }),
      h('dd', { class: i === rows.length - 1 ? 'mono small' : '', text: v })
    ]));
  }

  function renderAll() {
    translateStatic();
    $('version').textContent = `v${state.version}${state.isDev ? ` · ${t('app.dev')}` : ''}`;
    renderChips();
    renderAccounts();
    renderSettings();
    renderSystem();
  }

  async function refresh() {
    state = await api.getState();
    renderAll();
    if (!state.flash.found) showBanner(t('banner.flashMissing', { file: state.flash.fileName }), { error: true, sticky: true });
  }

  // ---------------------------------------------------------------------------
  // actions
  // ---------------------------------------------------------------------------
  async function startGame(acc, button) {
    const res = await run(button, () => api.startGame(acc.id));
    if (res && res.warning) showBanner(t(res.warning));
  }

  async function saveSettings(patch) {
    const res = await run(null, () => api.updateSettings(patch));
    if (!res) return refresh();
    state.settings = res.settings;
    const languageChanged = res.language !== state.language;
    state.language = res.language;
    if (languageChanged) renderAll();
    else renderSettings();
    if (res.restartRequired) askRestart(t('banner.settingSaved'));
    return res;
  }

  for (const el of document.querySelectorAll('[data-setting-select]')) {
    el.addEventListener('change', () => saveSettings({ [el.dataset.settingSelect]: el.value }));
  }
  for (const el of document.querySelectorAll('[data-setting]')) {
    el.addEventListener('change', () => saveSettings({ [el.dataset.setting]: el.checked }));
  }

  // ---- account dialog ----
  const dialog = $('account-dialog');

  function openAccountDialog(acc) {
    $('account-dialog-title').textContent = acc ? t('dialog.editTitle', { name: acc.label }) : t('dialog.addTitle');
    $('acc-id').value = acc ? acc.id : '';
    $('acc-label').value = acc ? acc.label : '';
    $('acc-region').replaceChildren(...state.regions.map((id) => h('option', { value: id, text: t(`region.${id}`) })));
    $('acc-region').value = acc && state.regions.includes(acc.region) ? acc.region : state.language === 'de' ? 'de' : 'eu';
    $('acc-server').value = acc ? acc.server : '';
    $('acc-username').value = '';
    $('acc-password').value = '';
    $('acc-clear').checked = false;
    $('acc-clear-wrap').classList.toggle('hidden', !(acc && acc.hasCredentials));
    $('acc-cred-hint').textContent = t(
      acc && acc.hasCredentials ? 'dialog.credStored' : state.vault.locked ? 'dialog.credLocked' : 'dialog.credNew'
    );
    $('account-error').textContent = '';
    dialog.showModal();
    $('acc-label').focus();
  }

  $('add-account').addEventListener('click', () => openAccountDialog(null));

  // Starts every account that is not running yet, one after another, so the
  // sign-in requests do not all hit the site at the same moment.
  $('start-all').addEventListener('click', (e) => run(e.currentTarget, async () => {
    for (const acc of state.accounts) {
      if (runningInfo(acc.id)) continue;
      const res = await api.startGame(acc.id);
      if (res && res.warning) showBanner(t(res.warning));
      await new Promise((r) => setTimeout(r, 2000));
    }
  }));

  $('settings-reset').addEventListener('click', async (e) => {
    if (!confirm(t('confirm.resetSettings'))) return;
    const res = await run(e.currentTarget, () => api.resetSettings());
    if (!res) return;
    state.settings = res.settings;
    state.language = res.language;
    renderAll();
    if (res.restartRequired) askRestart(t('banner.settingsReset'));
    else showBanner(t('banner.settingsReset'));
  });
  $('account-cancel').addEventListener('click', () => dialog.close());

  $('account-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const submit = e.submitter || e.target.querySelector('[type="submit"]');
    submit.disabled = true;
    try {
      const res = await api.saveAccount({
        id: $('acc-id').value || undefined,
        label: $('acc-label').value,
        region: $('acc-region').value,
        server: $('acc-server').value,
        username: $('acc-username').value,
        password: $('acc-password').value,
        clearCredentials: $('acc-clear').checked
      });
      $('acc-password').value = '';
      state.accounts = res.accounts;
      state.vault = res.vault;
      dialog.close();
      renderAll();
    } catch (err) {
      $('account-error').textContent = errorText(err);
    } finally {
      submit.disabled = false;
    }
  });

  // ---- vault ----
  function applyVault(vault, message) {
    if (!vault) return;
    state.vault = vault;
    renderAll();
    if (message) showBanner(message);
  }

  $('unlock-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('unlock-password');
    const vault = await run(e.target.querySelector('button'), () => api.unlockVault(input.value));
    input.value = '';
    applyVault(vault, t('banner.vaultUnlocked'));
  });

  $('master-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const pw = $('master-new').value;
    if (pw !== $('master-confirm').value) {
      showBanner(t('banner.passwordMismatch'), { error: true });
      return;
    }
    const vault = await run($('master-submit'), () => api.setMasterPassword(pw));
    $('master-new').value = '';
    $('master-confirm').value = '';
    applyVault(vault, t('banner.masterSaved'));
  });

  $('vault-lock').addEventListener('click', async (e) => applyVault(await run(e.currentTarget, () => api.lockVault())));
  $('master-remove').addEventListener('click', async (e) => {
    if (!confirm(t('confirm.removeMaster'))) return;
    applyVault(await run(e.currentTarget, () => api.removeMasterPassword()));
  });
  $('vault-reset').addEventListener('click', async (e) => {
    if (await run(e.currentTarget, () => api.resetVault())) await refresh();
  });

  // ---- system ----
  $('flash-import').addEventListener('click', async (e) => {
    const res = await run(e.currentTarget, () => api.importFlash());
    if (res && res.ok) askRestart(t('banner.flashImported'));
  });
  $('flash-folder').addEventListener('click', (e) => run(e.currentTarget, () => api.openFlashFolder()));
  $('open-logs').addEventListener('click', (e) => run(e.currentTarget, () => api.openLogs()));
  $('banner-close').addEventListener('click', hideBanner);

  // ---- events from the main process ----
  api.onEvent('metrics', (m) => {
    lastMetrics = m;
    if (state) renderMetrics();
  });
  api.onEvent('running', (list) => {
    if (!state) return;
    state.running = list;
    renderAccounts();
  });
  api.onEvent('memoryWarning', (m) => state && showBanner(t('banner.memory', { mb: m.mb }), { error: true }));
  api.onEvent('loginFailed', (p) => state && showBanner(t('banner.loginFailed', { name: p.name }), { error: true }));
  api.onEvent('crashRecovered', (p) => state && showBanner(t('banner.crashRecovered', { name: p.name })));
  api.onEvent('screenshot', (p) => state && showBanner(t('banner.screenshot', { file: p.file })));

  refresh().catch((err) => showBanner(errorText(err), { error: true, sticky: true }));
})();
