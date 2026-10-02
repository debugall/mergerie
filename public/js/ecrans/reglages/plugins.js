'use strict';
/* Réglages → Plugins : la liste, activer/désactiver à chaud, rescanner, installer, désinstaller, le formulaire d'un plugin. */

let pluginsListe = [];

const PLUGINS_ETATS = { active: 'done', inactive: '', error: 'stale', incompatible: 'stale' };

function pluginCarteHtml(p) {
  const etat = tr(`plugins.state.${p.state}`);
  const perms = (p.permissions || []).map((x) => `<span class="tag${x === 'exec' && !p.builtin ? ' stale' : ''}" title="${esc(tr(`plugins.perm.${x.replace('.', '-')}`))}">${esc(x)}</span>`).join(' ');
  const ecoutes = (p.events && p.events.listens || []).map((e) => `<code>${esc(e)}</code>`).join(', ');
  const emis = (p.events && p.events.emits || []).map((e) => `<code>${esc(e)}</code>`).join(', ');
  const deps = (p.requires || []).map((r) => `<code class="${(p.missing || []).includes(r) ? 'plugin-dep-missing' : ''}">${esc(r)}</code>`).join(', ');
  const execTiers = !p.builtin && (p.permissions || []).includes('exec');
  const aSonOnglet = p.ui && p.ui.settingsTabs && p.ui.settingsTabs.length;
  return `<div class="card plugin-card" data-plugin="${esc(p.name)}">
    <div class="card-head">
      <div class="card-title">${esc(p.displayName)} <span class="muted">v${esc(p.version)}</span>
        <span class="tag ${PLUGINS_ETATS[p.state] || ''}">${esc(etat)}</span>
        ${p.builtin ? `<span class="tag">${esc(tr('plugins.builtin'))}</span>` : ''}
        ${p.updateAvailable ? `<span class="tag to_review">${esc(tr('plugins.update-available'))}</span>` : ''}
      </div>
      <div class="meta">${esc(p.description)}${p.author ? ` · ${esc(p.author)}` : ''}${p.homepage ? ` · <a href="${esc(safeUrl(p.homepage))}" target="_blank" rel="noopener noreferrer">${esc(tr('plugins.homepage'))}</a>` : ''}${p.license ? ` · ${esc(p.license)}` : ''}</div>
    </div>
    ${p.error ? `<p class="err plugin-error">${esc(p.error)}</p>` : ''}
    ${execTiers ? `<p class="plugin-warn">${svgIco('alert')} ${esc(tr('plugins.exec-warning'))}</p>` : ''}
    <dl class="plugin-details">
      <dt>${esc(tr('plugins.permissions'))}</dt><dd>${perms || '<span class="muted">—</span>'}</dd>
      ${deps ? `<dt>${esc(tr('plugins.requires'))}</dt><dd>${deps}</dd>` : ''}
      ${ecoutes ? `<dt>${esc(tr('plugins.listens'))}</dt><dd>${ecoutes}</dd>` : ''}
      ${emis ? `<dt>${esc(tr('plugins.emits'))}</dt><dd>${emis}</dd>` : ''}
      <dt>${esc(tr('plugins.api'))}</dt><dd>${esc(p.apiVersion)}</dd>
    </dl>
    <div class="card-actions">
      ${p.state === 'incompatible' ? '' : (p.active || p.enabled
    ? `<button type="button" class="btn" data-plugin-disable="${esc(p.name)}">${svgIco('pause')}${esc(tr('plugins.disable'))}</button>`
    : `<button type="button" class="btn btn-primary" data-plugin-enable="${esc(p.name)}">${svgIco('play')}${esc(tr('plugins.enable'))}</button>`)}
      ${aSonOnglet ? `<button type="button" class="btn" data-plugin-settings-tab="${esc(p.ui.settingsTabs[0])}">${svgIco('sliders')}${esc(tr('plugins.open-settings'))}</button>` : ''}
      ${!p.builtin ? `<button type="button" class="btn btn-danger" data-plugin-uninstall="${esc(p.name)}">${svgIco('trash')}${esc(tr('plugins.uninstall'))}</button>` : ''}
    </div>
    ${!aSonOnglet && p.settingsSchema && Object.keys(p.settingsSchema.properties || {}).length ? `<div class="plugin-settings" data-plugin-settings-form="${esc(p.name)}"></div>` : ''}
  </div>`;
}

async function loadPlugins() {
  const box = $('#pluginList');
  if (!box) return;
  box.innerHTML = skeleton(2);
  try {
    const d = await api('/plugins');
    pluginsListe = d.plugins || [];
  } catch (e) { box.innerHTML = errorBox(explainError(e.message)); return; }
  box.innerHTML = pluginsListe.length ? pluginsListe.map(pluginCarteHtml).join('') : emptyState({ icon: 'plug', title: esc(tr('plugins.empty.title')), text: esc(tr('plugins.empty.text')) });
  for (const el of $$('#pluginList [data-plugin-settings-form]')) pluginsReglagesForm(el.dataset.pluginSettingsForm, el);
}

/* Activer ou désactiver : le serveur bascule à chaud ; la page se recharge pour que la barre,
   les écrans et les scripts du plugin apparaissent ou disparaissent — sans redémarrer Mergerie. */
document.addEventListener('click', async (e) => {
  const on = e.target.closest && e.target.closest('[data-plugin-enable]');
  if (on) {
    try {
      const r = await busy(on, () => api(`/plugins/${on.dataset.pluginEnable}/enable`, { method: 'POST' }));
      if (r.ok) { toast(tr('plugins.enabled', { name: on.dataset.pluginEnable })); setTimeout(() => window.location.reload(), 300); }
      else { toast(r.error || tr('plugins.enable-failed'), true); loadPlugins(); }
    } catch (err) { toast(explainError(err.message), true); }
    return;
  }
  const off = e.target.closest && e.target.closest('[data-plugin-disable]');
  if (off) {
    try {
      await busy(off, () => api(`/plugins/${off.dataset.pluginDisable}/disable`, { method: 'POST' }));
      toast(tr('plugins.disabled', { name: off.dataset.pluginDisable }));
      setTimeout(() => window.location.reload(), 300);
    } catch (err) { toast(explainError(err.message), true); }
    return;
  }
  const st = e.target.closest && e.target.closest('[data-plugin-settings-tab]');
  if (st) { showAdminSub(st.dataset.pluginSettingsTab); return; }
  const un = e.target.closest && e.target.closest('[data-plugin-uninstall]');
  if (un) {
    const nom = un.dataset.pluginUninstall;
    if (!await confirmDialog({ title: tr('plugins.uninstall.title', { name: nom }), text: tr('plugins.uninstall.text'), confirmLabel: tr('plugins.uninstall'), danger: true })) return;
    const garder = !$('#pluginUninstallDeleteData') || !$('#pluginUninstallDeleteData').checked;
    try {
      await busy(un, () => api(`/plugins/${nom}/uninstall`, { method: 'POST', body: { deleteData: !garder } }));
      toast(tr('plugins.uninstalled', { name: nom }));
      loadPlugins();
    } catch (err) { toast(explainError(err.message), true); }
  }
});
onEl($('#pluginRescan'), 'click', async () => {
  try {
    const d = await busy($('#pluginRescan'), () => api('/plugins/rescan', { method: 'POST' }));
    const maj = (d.plugins || []).filter((p) => p.updateAvailable).map((p) => p.name);
    toast(maj.length ? tr('plugins.rescan.update', { names: maj.join(', ') }) : tr('plugins.rescan.done'));
    loadPlugins();
  } catch (err) { toast(explainError(err.message), true); }
});
onEl($('#pluginInstallForm'), 'submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = f.source.value === 'git' ? { url: f.url.value.trim(), ref: f.ref.value.trim() } : { path: f.path.value.trim() };
  try {
    const d = await busy(f.querySelector('button[type=submit]'), () => api('/plugins/install', { method: 'POST', body }));
    toast(tr('plugins.installed', { name: d.name || '' }));
    f.reset();
    loadPlugins();
  } catch (err) { toast(explainError(err.message), true); }
});
onEl($('#pluginInstallForm'), 'change', (e) => {
  if (!e.target || e.target.name !== 'source') return;
  const git = e.target.value === 'git';
  for (const el of $$('#pluginInstallForm [data-source]')) el.hidden = el.dataset.source !== (git ? 'git' : 'path');
});
