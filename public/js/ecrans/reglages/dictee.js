'use strict';
/* Réglages → Dictée vocale : « Tester » et « Installer ». */
/* ---------- Réglages → Dictée vocale : « Tester » et « Installer » (whisper.md §6.5) ----------
   Un moteur local, c'est trois choses qui peuvent manquer indépendamment (le binaire, le
   modèle, le micro) et une qui peut mentir (un binaire présent qui ne charge pas le modèle).
   Le panneau ne « pingue » donc pas : il DÉROULE la chaîne et nomme la première marche qui
   casse, avec le geste qui la répare. Deux étapes sont ajoutées ICI, parce que le serveur ne
   peut pas les connaître : l'origine sûre et le micro. */

const DICT_ETAPES = ['provider', 'binary', 'model', 'vad', 'start', 'transcribe', 'vocab', 'remote', 'secure', 'mic'];
let dictationJobId = null;
let dictationTimer = null;

async function loadDictationSettings() {
  loadConfig();
  syncDictationProvider();
  /* Le statut porte la plateforme du serveur : on l'attend avant de dire ce que l'installation
     va faire, plutôt que de le deviner. */
  try { plateformeDuServeur = (await api('/dictation/status')).platform || ''; } catch { /* on gardera le repli */ }
  const box = $('#dictInstallGpuBox');
  // Sur macOS, Metal est actif d'office : il n'y a pas de GPU à choisir.
  if (box) box.hidden = plateformeServeur() === 'darwin';
  const gpuVulkan = $('#dictInstallGpu') && $('#dictInstallGpu').querySelector('option[value="vulkan"]');
  // Sous Windows, seule la variante CUDA est publiée : proposer Vulkan serait un cul-de-sac.
  if (gpuVulkan) gpuVulkan.hidden = plateformeServeur() === 'win32';
  const c = $('#dictInstallConfirm');
  if (c) c.textContent = tr(`settings.dictation.confirm.${plateformeServeur()}`);
}

/* La plateforme DU SERVEUR — c'est la machine qui héberge Mergerie qui installe le moteur,
   pas celle du navigateur. Elle vient donc de l'API (`process.platform`), pas de l'agent
   utilisateur : déduite du navigateur, elle se trompait dès qu'on ouvrait l'outil depuis une
   autre machine, et la confirmation promettait Homebrew à un serveur Linux. */
let plateformeDuServeur = '';
function plateformeServeur() {
  return ['darwin', 'linux', 'win32'].includes(plateformeDuServeur) ? plateformeDuServeur : 'linux';
}

/* Les champs d'un fournisseur qui n'est pas choisi n'ont rien à faire à l'écran : ils
   posent une question qui n'a pas de réponse. L'avertissement du fournisseur « navigateur »,
   lui, ne se déplie que quand on le choisit — c'est là qu'il compte. */
function syncDictationProvider() {
  const f = $('#configForm');
  const v = f && f.dictation_provider ? f.dictation_provider.value : 'off';
  $$('#sub-dictation .dictation-local').forEach((el) => { el.hidden = v !== 'local'; });
  $$('#sub-dictation .dictation-remote').forEach((el) => { el.hidden = v !== 'openai'; });
  const w = $('#dictationBrowserWarn');
  if (w) w.hidden = v !== 'browser';
  const panneau = $('#dictationPanel');
  if (panneau) panneau.classList.toggle('dictation-off', v === 'off');
  const inst = $('#dictationInstall');
  if (inst) inst.hidden = v !== 'local';
}
/* Écouté sur le DOCUMENT, pas sur `#configForm` : les champs de réglages portent l'attribut
   `form="configForm"` mais vivent dans leur sous-onglet — ils ne sont pas des descendants du
   formulaire, et leur `change` n'y remonte donc jamais. Branché sur le formulaire, le select
   de fournisseur ne dépliait rien. */
document.addEventListener('change', (e) => {
  if (e.target && e.target.name === 'dictation_provider') syncDictationProvider();
});

/* Le verdict est REMIS À ZÉRO dès qu'un réglage de dictée change : il parlait d'une autre
   configuration, et un tableau vert sous des champs modifiés est un mensonge. */
function marquerDictationPerime() {
  const v = $('#dictationVerdict');
  if (!v || v.hidden) return;
  v.dataset.stale = '1';
  const info = $('#dictationInfo');
  if (info) info.textContent = tr('settings.dictation.stale');
}
document.addEventListener('input', (e) => {
  if (e.target && e.target.name && /^dictation_/.test(e.target.name)) marquerDictationPerime();
}, true);

function ligneEtape(cle, st) {
  const ico = { ok: '✓', warn: '⚠', fail: '✗', skip: '·' }[st.status] || '·';
  /* LE VOCABULAIRE SE LIT AU SURVOL. « 42 termes envoyés au moteur » ne dit pas POURQUOI le
     nom d'un dépôt s'écrit bien — la liste, si. C'est aussi ce qui montre qu'un terme du
     glossaire est passé, ou qu'il a été évincé par la limite. */
  const titre = st.hover ? ` title="${esc(st.hover)}"` : '';
  return `<div class="dict-step dict-${esc(st.status)}">
    <span class="dict-ico" aria-hidden="true">${ico}</span>
    <span class="dict-name">${esc(tr(`settings.dictation.step.${cle}`))}</span>
    <span class="dict-detail"${titre}>${esc(st.detail || '')}</span>
    ${st.remedy ? `<span class="dict-remedy">${esc(st.remedy)}</span>` : ''}
  </div>`;
}

function rendreDiagnostic(res, extra) {
  const parEtape = new Map((res.steps || []).map((st) => [st.key, st]));
  const voc = parEtape.get('vocab');
  if (voc && (res.vocab || []).length) voc.hover = tr('settings.dictation.vocab-hover', { liste: res.vocab.join(', ') });
  for (const st of extra || []) parEtape.set(st.key, st);
  const html = DICT_ETAPES.filter((k) => parEtape.has(k)).map((k) => ligneEtape(k, parEtape.get(k))).join('');
  $('#dictationSteps').innerHTML = html;
  const casse = [...parEtape.entries()].find(([, st]) => st.status === 'fail');
  const v = $('#dictationVerdict');
  v.hidden = false;
  delete v.dataset.stale;
  v.className = `dictation-verdict ${casse ? 'ko' : 'ok'}`;
  v.textContent = res.verdict === 'off' ? tr('settings.dictation.verdict.off')
    : casse ? tr('settings.dictation.verdict.incomplete', { quoi: tr(`settings.dictation.step.${casse[0]}`) })
      : tr('settings.dictation.verdict.ready');
  // Le libellé du bouton suit l'état : on n'« installe » pas ce qui est déjà là.
  const lab = $('#dictationInstallLabel');
  const manque = ['binary', 'model'].some((k) => parEtape.has(k) && parEtape.get(k).status === 'fail');
  if (lab) lab.textContent = tr(manque ? 'settings.dictation.install' : 'settings.dictation.reinstall');
  /* CE QUI A ÉTÉ ÉCARTÉ se compte, et se lit. Si ce nombre monte, le micro capte du bruit —
     et c'est la seule façon de le savoir sans relire tout ce qu'on a dicté. */
  const dr = $('#dictationDropped');
  if (dr) {
    const n = Number(res.dropped) || 0;
    dr.hidden = n === 0;
    dr.textContent = n ? tr('settings.dictation.dropped', { n, count: n }) : '';
  }
}

/* Les deux étapes que le serveur ne peut pas connaître. Le micro n'est pas seulement
   « accordé » : on écoute deux secondes et on regarde s'il ARRIVE quelque chose — une
   permission accordée sur le mauvais périphérique donne un silence parfait. */
async function etapesNavigateur() {
  const out = [];
  out.push(window.isSecureContext
    ? { key: 'secure', status: 'ok', detail: tr('settings.dictation.secure.ok'), remedy: '' }
    : { key: 'secure', status: 'fail', detail: '', remedy: tr('settings.dictation.secure.ko') });
  if (!window.isSecureContext || !navigator.mediaDevices) {
    out.push({ key: 'mic', status: 'skip', detail: '', remedy: '' });
    return out;
  }
  let flux = null;
  try {
    flux = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true } });
  } catch (e) {
    out.push({ key: 'mic', status: 'fail', detail: '', remedy: tr('settings.dictation.mic.ko', { detail: e.name || e.message }) });
    return out;
  }
  let crete = 0;
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const an = ctx.createAnalyser();
    an.fftSize = 512;
    ctx.createMediaStreamSource(flux).connect(an);
    const buf = new Float32Array(an.fftSize);
    const fin = Date.now() + 2000;
    while (Date.now() < fin) {
      an.getFloatTimeDomainData(buf);
      for (let i = 0; i < buf.length; i += 1) crete = Math.max(crete, Math.abs(buf[i]));
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 60));
    }
    await ctx.close();
  } catch { /* analyse impossible : on ne conclut pas au silence */ }
  flux.getTracks().forEach((tk) => { try { tk.stop(); } catch { /* ok */ } });
  out.push(crete > 0.01
    ? { key: 'mic', status: 'ok', detail: tr('settings.dictation.mic.ok'), remedy: '' }
    : { key: 'mic', status: 'warn', detail: '', remedy: tr('settings.dictation.mic.silent') });
  return out;
}

$('#dictationTest') && $('#dictationTest').addEventListener('click', (e) => busy(e.currentTarget, async () => {
  const info = $('#dictationInfo');
  info.textContent = tr('settings.dictation.testing');
  let res;
  try { res = await api('/dictation/test', { method: 'POST' }); }
  catch (err) { info.textContent = ''; toast(err.message, true); return; }
  // Le compte des passages écartés vit dans le statut, pas dans le diagnostic : il court
  // depuis le démarrage du serveur, alors que le diagnostic ne parle que de maintenant.
  try { res.dropped = (await api('/dictation/status')).dropped; } catch { /* informatif */ }
  rendreDiagnostic(res, []);
  info.textContent = tr('settings.dictation.mic.speak');
  const extra = await etapesNavigateur();
  rendreDiagnostic(res, extra);
  info.textContent = '';
  if (window.mergerieDictation) window.mergerieDictation.relireStatut();
}));

/* ---------- Installer ---------- */
$('#dictationInstall') && $('#dictationInstall').addEventListener('click', () => {
  if (dictationJobId) { $('#dictationLog').hidden = false; return; }
  const c = $('#dictInstallConfirm');
  if (c) c.textContent = tr(`settings.dictation.confirm.${plateformeServeur()}`);
  $('#dictInstallModal').hidden = false;
});
$('#dictInstallCancel') && $('#dictInstallCancel').addEventListener('click', () => { $('#dictInstallModal').hidden = true; });
fermerAuFond('#dictInstallModal');

$('#dictInstallGo') && $('#dictInstallGo').addEventListener('click', (e) => busy(e.currentTarget, async () => {
  const body = {
    model: $('#dictInstallModel').value,
    vad: $('#dictInstallVad').checked,
    gpu: $('#dictInstallGpuBox').hidden ? '' : $('#dictInstallGpu').value,
  };
  let job;
  try { job = await api('/dictation/install', { method: 'POST', body }); }
  catch (err) { toast(explainError(err.message), true); return; }
  $('#dictInstallModal').hidden = true;
  dictationJobId = job.id;
  $('#dictationLog').hidden = false;
  $('#dictationLog').textContent = '';
  $('#dictationInfo').textContent = tr('settings.dictation.installing');
  suivreInstallation(0);
}));

/* Le journal en direct sous le bouton, comme les logs Docker. À la fin, on RELIT les réglages
   (le script vient de les remplir) et on relance le test de lui-même : l'utilisateur voit le
   tableau passer au vert sans un clic de plus. */
function suivreInstallation(after) {
  clearTimeout(dictationTimer);
  dictationTimer = setTimeout(async () => {
    let d;
    try { d = await api(`/jobs/${dictationJobId}/log?after=${after}`); }
    catch { dictationJobId = null; return; }
    const pre = $('#dictationLog');
    if (pre && d.lines && d.lines.length) {
      pre.textContent += `${d.lines.map((l) => l.text).join('\n')}\n`;
      pre.scrollTop = pre.scrollHeight;
    }
    const suivant = d.lines && d.lines.length ? d.lines[d.lines.length - 1].id : after;
    if (['running', 'queued'].includes(d.status)) { suivreInstallation(suivant); return; }
    dictationJobId = null;
    $('#dictationInfo').textContent = '';
    if (d.status === 'error') { toast(d.message || tr('err.dictation.resultat'), true); return; }
    if (d.status === 'stopped') return;
    await loadConfig();
    if (window.mergerieDictation) window.mergerieDictation.relireStatut();
    const btn = $('#dictationTest');
    if (btn) btn.click();
  }, 700);
}

