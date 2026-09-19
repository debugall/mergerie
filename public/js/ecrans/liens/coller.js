'use strict';
/* Coller une adresse, convertir des liens libres en service. */
/* ---------- Coller une adresse ---------- */

/* AJOUTER, C'EST COLLER. « Ajouter » ouvrait un menu qui demandait de CLASSER avant de coller
   — un lien simple, un service, un environnement — et l'état vide disait littéralement : crée
   un environnement, puis des services. Trois écrans avant la première adresse, pour quelqu'un
   qui a une URL dans le presse-papiers.
   On part donc de l'URL. L'outil PROPOSE le nom, le service et la colonne ; chaque proposition
   est un sélecteur visible, et ce qui n'a pas d'environnement reconnu tombe en lien libre —
   jamais dans une colonne « probable ». Les sélecteurs portent « nouveau service » et
   « nouvel environnement » : créer les colonnes n'est plus un préalable. */
let collageItems = [];
let collageMinuteur = null;

function ouvrirCollage(texte) {
  collageItems = [];
  $('#pasteText').value = String(texte || '').trim();
  $('#pasteRows').innerHTML = '';
  $('#pasteOk').disabled = true;
  $('#pasteEmpty').hidden = false;
  $('#pasteModal').hidden = false;
  setTimeout(() => $('#pasteText').focus(), 0);
  if ($('#pasteText').value) analyserCollageEcran();
}

async function analyserCollageEcran() {
  const texte = $('#pasteText').value;
  if (!texte.trim()) { collageItems = []; renderCollage(); return; }
  try { collageItems = (await api('/links/paste/analyse', { method: 'POST', body: { text: texte } })).items || []; }
  catch (e) { toast(explainError(e.message), true); return; }
  renderCollage();
}
$('#pasteText') && $('#pasteText').addEventListener('input', () => {
  /* On n'analyse pas à chaque frappe : coller trois adresses puis corriger une lettre ferait
     autant d'allers-retours, et chaque réponse REDESSINE les sélecteurs — donc perdrait les
     choix déjà faits. Un court repos suffit à distinguer « je tape » de « j'ai fini ». */
  clearTimeout(collageMinuteur);
  collageMinuteur = setTimeout(analyserCollageEcran, 350);
});

function renderCollage() {
  const box = $('#pasteRows');
  const valides = collageItems.filter((x) => x && x.url && !x.invalid);
  $('#pasteEmpty').hidden = collageItems.length > 0;
  $('#pasteOk').disabled = !valides.length;
  $('span', $('#pasteOk')).textContent = valides.length > 1
    ? tr('links.paste.add-n', { n: valides.length, count: valides.length })
    : tr('ui.add');
  const envs = ((LINKS.grid && LINKS.grid.environments) || []);
  box.innerHTML = collageItems.map((it, i) => {
    if (it.invalid) {
      return `<div class="paste-row invalide" data-i="${i}"><span class="pr-url">${esc(it.url)}</span>
        <span class="pr-bad">${esc(tr('err.links.url-invalid'))}</span></div>`;
    }
    const libre = it.target === 'free';
    return `<div class="paste-row" data-i="${i}" data-target="${libre ? 'free' : 'cell'}">
      <div class="pr-url" title="${esc(it.url)}">${esc(urlCourte(it.url))}</div>
      <div class="pr-fields">
        <label class="pr-f"><span>${esc(tr('links.paste.name'))}</span>
          <input type="text" class="pr-label" maxlength="100" value="${esc(it.label || '')}" /></label>
        <label class="pr-f pr-f-svc"><span>${esc(tr('links.paste.into'))}</span>
          <span class="pr-svc-box"></span></label>
        <label class="pr-f pr-f-new" hidden><span>${esc(tr('links.paste.new-service'))}</span>
          <input type="text" class="pr-svcname" maxlength="100" value="${esc(it.service_name || '')}" /></label>
        <label class="pr-f pr-f-env"><span>${esc(tr('links.paste.env'))}</span>
          <select class="pr-env">${envs.map((e) => `<option value="${e.id}"${e.id === it.environment_id ? ' selected' : ''}>${esc(e.name)}</option>`).join('')}
            <option value="new">${esc(tr('links.paste.new-env'))}</option></select></label>
        <label class="pr-f pr-f-envname" hidden><span>${esc(tr('links.paste.new-env-name'))}</span>
          <input type="text" class="pr-envname" maxlength="100" /></label>
        <label class="pr-f pr-f-tags"><span>${esc(tr('links.service.tags'))}</span>
          <input type="text" class="pr-tags" maxlength="300" value="${esc((it.tags || []).join(', '))}" /></label>
      </div>
    </div>`;
  }).join('');
  /* Le service se choisit dans un sélecteur À RECHERCHE, comme partout où une liste peut être
     longue — un collage arrive souvent sur une grille de trente services. */
  collageItems.forEach((it, i) => {
    if (it.invalid) return;
    const row = $(`#pasteRows .paste-row[data-i="${i}"]`);
    const cls = `js-paste-svc-${i}`;
    const choix = it.target === 'free' ? 'free' : (it.service_id ? String(it.service_id) : 'new');
    const options = () => [
      { value: 'free', label: tr('links.paste.free') },
      { value: 'new', label: tr('links.paste.new-service') },
      ...((LINKS.grid && LINKS.grid.services) || []).map((x) => ({ value: String(x.id), label: x.name, hint: (x.tags || []).join(' · ') })),
    ];
    const etiquette = (options().find((o) => o.value === choix) || {}).label || '';
    $('.pr-svc-box', row).innerHTML = comboHtml(cls, { value: choix, label: etiquette, ph: tr('links.free.pick-service') });
    wireCombo($('.pr-svc-box', row), cls, options);
    majLigneCollage(row);
  });
}

/* Ce que la ligne montre dépend de ce qu'elle range : un lien libre n'a pas de colonne, un
   nouveau service demande son nom, un service existant n'en demande pas. */
function majLigneCollage(row) {
  const v = ($('.pr-svc-box .combo input[type=hidden]', row) || {}).value || '';
  const libre = v === 'free';
  row.dataset.target = libre ? 'free' : 'cell';
  $('.pr-f-new', row).hidden = libre || v !== 'new';
  $('.pr-f-env', row).hidden = libre;
  $('.pr-f-tags', row).hidden = !libre;
  const env = $('.pr-env', row);
  $('.pr-f-envname', row).hidden = libre || !env || env.value !== 'new';
}
$('#pasteRows') && $('#pasteRows').addEventListener('change', (e) => {
  const row = e.target.closest('.paste-row');
  if (row) majLigneCollage(row);
});

$('#pasteCancel') && $('#pasteCancel').addEventListener('click', () => { $('#pasteModal').hidden = true; });
fermerAuFond('#pasteModal', () => { $('#pasteModal').hidden = true; }, { salissable: true });
$('#pasteOk') && $('#pasteOk').addEventListener('click', async (ev) => {
  const items = $$('#pasteRows .paste-row:not(.invalide)').map((row) => {
    const i = Number(row.dataset.i);
    const it = collageItems[i] || {};
    const v = ($('.pr-svc-box .combo input[type=hidden]', row) || {}).value || '';
    if (v === 'free') {
      return { url: it.url, target: 'free', label: $('.pr-label', row).value.trim(), tags: $('.pr-tags', row).value };
    }
    const env = $('.pr-env', row);
    return {
      url: it.url,
      target: 'cell',
      label: $('.pr-label', row).value.trim(),
      environment_id: env && env.value !== 'new' ? Number(env.value) : null,
      environment_name: env && env.value === 'new' ? $('.pr-envname', row).value.trim() : '',
      service_id: v === 'new' ? null : Number(v),
      service_name: v === 'new' ? $('.pr-svcname', row).value.trim() : '',
    };
  });
  if (!items.length) return;
  try {
    const r = await busy(ev.currentTarget, () => api('/links/paste', { method: 'POST', body: { items } }));
    $('#pasteModal').hidden = true;
    await loadLinks();
    // Le compte est DIT, et de chaque côté : « ajouté » sans chiffre laisse aller vérifier.
    toast(tr('links.paste.done', { cells: r.cells, free: r.free }));
    if (r.service) montrerLigneService(r.service.id);
  } catch (e) { toast(explainError(e.message), true); }
});

/* ---------- Convertir des liens libres en service ---------- */

/* Le geste d'après l'import : deux cents adresses arrivent à plat et il faut les classer.
   On y entre par la ligne d'un lien (le cas courant, un lien à la fois) ou par le mode
   sélection (plusieurs d'un coup, dans le même service). */
function ouvrirRangement(ids) {
  const choisis = ((LINKS.grid && LINKS.grid.free_links) || []).filter((l) => ids.includes(l.id));
  if (!choisis.length) return;
  const envs = (LINKS.grid.environments || []);
  if (!envs.length) { toast(tr('links.free.need-env'), true); return; }

  /* Le sélecteur À RECHERCHE, comme partout où une liste peut être longue. La première entrée
     crée un service à la volée : ne savoir que créer obligeait à tout ranger du premier coup,
     ne savoir que choisir obligeait à créer le service avant. */
  $('#toServiceBox').innerHTML = comboHtml('js-toservice', { value: 'new', label: tr('links.free.file-new'), ph: tr('links.free.pick-service') });
  wireCombo($('#toServiceBox'), 'js-toservice', () => [
    { value: 'new', label: tr('links.free.file-new') },
    ...((LINKS.grid.services || []).map((x) => ({ value: String(x.id), label: x.name, hint: (x.tags || []).join(' · ') }))),
  ]);
  $('#toServiceName').value = nomCommun(choisis.map((l) => l.label));
  majRangementNom();

  const options = (sel) => `<option value="">${esc(tr('links.free.skip'))}</option>`
    + envs.map((e) => `<option value="${e.id}"${String(sel) === String(e.id) ? ' selected' : ''}>${esc(e.name)}</option>`).join('');
  // Un seul environnement à choisir pour tous : c'est le cas courant, et le refaire ligne à
  // ligne sur douze liens est exactement ce qui fait renoncer.
  $('#toServiceAllEnv').innerHTML = options(envs[0].id);
  /* Une ligne par lien, un environnement à choisir : le mapping est EXPLICITE. Deviner
     « dev » depuis une URL contenant « -dev » marcherait neuf fois sur dix — et la dixième
     poserait une URL de production dans la colonne de développement. */
  $('#toServiceRows').innerHTML = choisis.map((l) => `<div class="link-ctx-row">
      <span class="link-free-url" title="${esc(l.url)}">${esc(l.label)} — ${esc(l.url)}</span>
      <select data-mapfree="${l.id}">${options(envs[0].id)}</select>
    </div>`).join('');
  $('#toServiceModal').hidden = false;
}

// Le nom ne se demande que pour un service qu'on crée : sinon il n'a rien à dire.
function majRangementNom() {
  const v = ($('#toServiceBox .js-toservice') || {}).value;
  $('#toServiceNameRow').hidden = v !== 'new';
}
$('#toServiceBox') && $('#toServiceBox').addEventListener('change', majRangementNom);
$('#toServiceAllEnv') && $('#toServiceAllEnv').addEventListener('change', () => {
  const v = $('#toServiceAllEnv').value;
  $$('#toServiceRows [data-mapfree]').forEach((sel) => { sel.value = v; });
});

$('#linkToService') && $('#linkToService').addEventListener('click', () => {
  ouvrirRangement([...LINKS.selection]);
});
// Le plus long préfixe commun aux libellés : « Kibana dev » + « Kibana prod » → « Kibana ».
function nomCommun(labels) {
  if (!labels.length) return '';
  let p = labels[0];
  for (const l of labels.slice(1)) {
    let i = 0;
    while (i < p.length && i < l.length && p[i].toLowerCase() === l[i].toLowerCase()) i += 1;
    p = p.slice(0, i);
  }
  return p.replace(/[\s\-—·|]+$/, '').trim() || labels[0];
}
$('#toServiceCancel') && $('#toServiceCancel').addEventListener('click', () => { $('#toServiceModal').hidden = true; });
fermerAuFond('#toServiceModal', () => { $('#toServiceModal').hidden = true; }, { salissable: true });
$('#toServiceOk') && $('#toServiceOk').addEventListener('click', async () => {
  const mapping = $$('#toServiceRows [data-mapfree]')
    .filter((s) => s.value)
    .map((s) => ({ free_link_id: Number(s.dataset.mapfree), environment_id: Number(s.value) }));
  const choix = ($('#toServiceBox .js-toservice') || {}).value;
  const corps = choix === 'new'
    ? { name: $('#toServiceName').value, mapping }
    : { service_id: Number(choix), mapping };
  try {
    const r = await api('/free-links/to-service', { method: 'POST', body: corps });
    $('#toServiceModal').hidden = true;
    LINKS.selectMode = false;
    LINKS.selection.clear();
    // Le nom du service est DIT : rangé quelque part, on veut savoir où sans aller vérifier.
    toast(tr('links.free.filed', { n: r.ranges, count: r.ranges, service: (r.service || {}).name || '' }));
    await loadLinks();
    montrerLigneService((r.service || {}).id);
  } catch (e) { toast(explainError(e.message), true); }
});

