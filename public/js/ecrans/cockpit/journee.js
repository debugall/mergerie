'use strict';
/* « LANCER MA JOURNÉE » : des tickets (tapés, ou cochés dans « mes tickets »), PRÉPARÉS d'abord — un appel Jira
   chacun, annoncé avant le clic —, puis un bloc par ticket : ses dépôts et branches (lus dans ses jetons, ou
   saisis ici quand il n'en nomme aucun) et trois gestes — lancer, enregistrer sans lancer, éditer dans la
   fenêtre de session. « Tout lancer » / « Tout enregistrer » font de même pour les blocs restants. La chaîne
   de validation vient de la session modèle. Créer ou lancer ne coûte aucun appel Jira. */
let journeeTickets = [];
let journeePrepares = [];       // les tickets préparés, dans l'ordre ; `fait` = { task_id, lancee } une fois créé
let journeeDepots = null;       // les dépôts actifs, lus une fois par ouverture

const clesTapees = () => String(($('#cockpitKeys') || {}).value || '').toUpperCase().match(/[A-Z][A-Z0-9_]+-\d+/g) || [];
function clesJournee() {
  const cochees = $$('#cockpitTickets .cockpit-ticket-pick:checked').map((c) => c.value);
  return [...new Set([...clesTapees(), ...cochees])];
}
function majCoutJournee() {
  const n = clesJournee().length;
  $('#cockpitCout').textContent = tr('cockpit.journee.cost', { n, count: n });
  $('#cockpitPreparer').disabled = !n;
}
function etapeJournee(preparee) {
  $('#cockpitPreparer').hidden = preparee;
  $('#cockpitLancer').hidden = !preparee;
  $('#cockpitToutEnregistrer').hidden = !preparee;
  $('#cockpitPrepares').hidden = !preparee;
}
function ouvrirJournee() {
  $('#cockpitKeys').value = '';
  $('#cockpitTickets').innerHTML = '';
  $('#cockpitTicketsFiltre').hidden = true;
  $('#cockpitResultat').hidden = true;
  $('#cockpitPrepares').innerHTML = '';
  journeePrepares = []; journeeDepots = null;
  etapeJournee(false);
  const sel = $('#cockpitModele');
  const modeles = (cockpitDonnees && cockpitDonnees.modeles) || [];
  sel.innerHTML = `<option value="">${esc(tr('cockpit.journee.no-model'))}</option>`
    + modeles.map((m) => `<option value="${m.id}">#${m.id} ${esc(m.label)} — ${esc(tr('cockpit.journee.model-n', { n: m.n, count: m.n }))}${m.converge ? ` · ${esc(tr('cockpit.journee.model-converge'))}` : ''}</option>`).join('');
  if (modeles.length) sel.value = String(modeles[0].id);
  majCoutJournee();
  $('#cockpitJourneeModal').hidden = false;
  $('#cockpitKeys').focus();
}
$('#cockpitJournee') && $('#cockpitJournee').addEventListener('click', ouvrirJournee);
$('#cockpitAnnuler') && $('#cockpitAnnuler').addEventListener('click', () => { $('#cockpitJourneeModal').hidden = true; });
fermerAuFond('#cockpitJourneeModal', () => { $('#cockpitJourneeModal').hidden = true; });
$('#cockpitKeys') && $('#cockpitKeys').addEventListener('input', majCoutJournee);
$('#cockpitTickets') && $('#cockpitTickets').addEventListener('change', majCoutJournee);
$('#cockpitTicketsFiltre') && $('#cockpitTicketsFiltre').addEventListener('input', (e) => {
  const q = e.target.value.toLowerCase().trim();
  $$('#cockpitTickets .cockpit-ticket').forEach((r) => { r.hidden = !!q && !r.dataset.texte.includes(q); });
});
$('#cockpitMesTickets') && $('#cockpitMesTickets').addEventListener('click', async (e) => {
  try { journeeTickets = (await busy(e.currentTarget, () => api('/cockpit/mes-tickets'))).tickets || []; }
  catch (err) { toast(explainError(err.message), true); return; }
  $('#cockpitTicketsFiltre').hidden = !journeeTickets.length;
  $('#cockpitTickets').innerHTML = journeeTickets.length
    ? journeeTickets.map((x) => `<label class="cockpit-ticket" data-texte="${esc(`${x.key} ${x.summary || ''}`.toLowerCase())}"><input type="checkbox" class="cockpit-ticket-pick" value="${esc(x.key)}" /> <b>${esc(x.key)}</b> ${esc(x.summary || '')} <span class="muted">${esc(x.status || '')}</span></label>`).join('')
    : `<p class="muted">${esc(tr('cockpit.journee.mine-none'))}</p>`;
  majCoutJournee();
});

/* ---- Les tickets préparés ---- */
const nomDepot = (id) => ((journeeDepots || []).find((r) => r.id === Number(id)) || {}).project || '';
function cibleJourneeHtml(g) {
  return `<div class="cockpit-cible" data-row>
    ${comboHtml('cockpit-c-repo', { value: g.repo_id || '', label: g.repo_id ? (g.project || nomDepot(g.repo_id)) : '', ph: tr('cockpit.journee.repo-ph') })}
    <input class="cockpit-c-branch" value="${esc(g.branch || '')}" placeholder="${esc(tr('cockpit.journee.branch-ph'))}" aria-label="${esc(tr('cockpit.journee.branch-ph'))}" />
    ${comboHtml('cockpit-c-base', { value: g.base_branch || '', label: g.base_branch || '', ph: tr('cockpit.journee.base-ph') })}
    <button type="button" class="btn btn-sm btn-ghost" data-cockpit-cible-moins title="${esc(tr('cockpit.journee.repo-remove'))}" aria-label="${esc(tr('cockpit.journee.repo-remove'))}">×</button>
  </div>`;
}
/* LE TICKET, dans son bloc : de quoi décider où ranger la session. Replié, sauf quand le ticket ne nomme
   aucun dépôt — c'est alors la première chose à lire. Lu à la préparation : aucun appel Jira de plus. */
function ticketJourneeHtml(x) {
  const tk = x.ticket || {};
  const coms = (tk.comments || []).filter((c) => c.bodyMd && c.bodyMd !== tk.tech);
  const corps = `${tk.description ? mdToHtml(tk.description) : `<p class="muted">${esc(tr('jira.no-description'))}</p>`}
    ${tk.tech ? `<h4>${esc(tr('cockpit.journee.ticket-tech'))}</h4>${mdToHtml(tk.tech)}` : ''}
    ${coms.length ? `<h4>${esc(tr('cockpit.journee.ticket-comments', { n: coms.length, count: coms.length }))}</h4>`
      + coms.map((c) => `<div class="cockpit-ticket-com"><div class="muted">${esc(c.author || '')}${c.created ? ` · ${esc(fmtDateTime(c.created))}` : ''}</div>${mdToHtml(c.bodyMd)}</div>`).join('') : ''}`;
  return `<details class="cockpit-ticket-voir"${x.manque ? ' open' : ''}>
    <summary>${esc(tr('cockpit.journee.ticket-show'))}${tk.status ? ` <span class="tag">${esc(tk.status)}</span>` : ''}</summary>
    ${tk.url ? `<a class="cockpit-ticket-lien" href="${esc(safeUrl(tk.url))}" target="_blank" rel="noopener">${esc(tr('cockpit.journee.ticket-open'))}</a>` : ''}
    <div class="cockpit-ticket-corps md-body">${corps}</div>
  </details>`;
}
// Les dépôts que le ticket cite sans jeton : un clic remplit la première ligne vide, ou en ajoute une.
function suggestionsJourneeHtml(x) {
  if (!(x.suggestions || []).length) return '';
  return `<div class="cockpit-suggestions"><span class="muted">${esc(tr('cockpit.journee.suggested'))}</span>
    ${x.suggestions.map((g) => `<button type="button" class="chip" data-cockpit-suggere="${g.repo_id}">${esc(g.project)}</button>`).join('')}</div>`;
}
function blocJourneeHtml(x, i) {
  const fait = x.fait
    ? `<span class="tag ${x.fait.lancee ? 'reviewed' : 'to_review'}">${esc(tr(x.fait.lancee ? 'cockpit.journee.done-launched' : 'cockpit.journee.done-saved', { id: x.fait.task_id }))}</span>`
    : '';
  const cibles = x.targets && x.targets.length ? x.targets : [{ branch: x.branche_defaut }];
  return `<div class="cockpit-prep${x.fait ? ' is-fait' : ''}" data-prep="${i}" data-key="${esc(x.key)}">
    <div class="cockpit-prep-head"><b>${esc(x.key)}</b> ${esc(x.summary)} ${fait}</div>
    ${x.fait ? '' : `${ticketJourneeHtml(x)}
    ${x.manque ? `<p class="field-note cockpit-prep-manque">${esc(tr('cockpit.journee.fill-repo'))}</p>` : ''}
    ${suggestionsJourneeHtml(x)}
    <div class="cockpit-cibles">${cibles.map(cibleJourneeHtml).join('')}</div>
    ${/* Le scénario attendu lu dans le ticket (`&&? …`), modifiable — vide, sans avertissement, quand il n'en a
          pas. Il part avec la session si le modèle écrit les tests ; l'agent ne le lit qu'à cette étape. */''}
    <label class="cockpit-attendu"><span>${esc(tr('task.chaine.scen.expected'))}</span>
      <textarea class="cockpit-attendu-texte" rows="2" maxlength="4000"${x.attendu_source === 'saisi' ? ' data-saisi="1"' : ''}>${esc(x.attendu || '')}</textarea></label>
    <div class="cockpit-prep-actions">
      <button type="button" class="btn btn-sm btn-ghost" data-cockpit-cible-plus><svg class="ico"><use href="#i-plus"/></svg>${esc(tr('cockpit.journee.repo-add'))}</button>
      <span class="spacer"></span>
      <button type="button" class="btn btn-sm" data-cockpit-prep="editer"><svg class="ico"><use href="#i-edit"/></svg>${esc(tr('cockpit.journee.edit'))}</button>
      <button type="button" class="btn btn-sm" data-cockpit-prep="enregistrer"><svg class="ico"><use href="#i-save"/></svg>${esc(tr('cockpit.journee.save'))}</button>
      <button type="button" class="btn btn-sm btn-primary" data-cockpit-prep="lancer"><svg class="ico"><use href="#i-play"/></svg>${esc(tr('cockpit.journee.go'))}</button>
    </div>`}
  </div>`;
}
function cablerCiblesJournee(root) {
  wireCombo(root, 'cockpit-c-repo', async () => (journeeDepots || []).map((r) => ({ value: r.id, label: r.project })));
  wireCombo(root, 'cockpit-c-base', async (row) => {
    const id = Number((row.querySelector('.cockpit-c-repo') || {}).value) || 0;
    if (!id) return [];
    const b = await branchesFor(id);
    // Une valeur vide rend la main au dépôt : sans elle, un choix ne pourrait plus être défait.
    return [{ value: '', label: tr('cockpit.journee.base-default'), hint: b.def || '' }]
      .concat(b.branches.map((n) => ({ value: n, label: n, hint: n === b.def ? tr('cockpit.journee.default-branch') : '' })));
  });
}
// Ce qui est saisi dans les blocs pas encore créés survit au rendu qui suit la création d'un autre.
function memoriserBlocs() {
  $$('#cockpitPrepares .cockpit-prep:not(.is-fait)').forEach((bloc) => {
    const x = journeePrepares[Number(bloc.dataset.prep)];
    if (!x) return;
    const zone = bloc.querySelector('.cockpit-attendu-texte');
    if (zone) { x.attendu = zone.value; x.attendu_source = zone.dataset.saisi ? 'saisi' : 'jira'; }
    x.targets = $$('.cockpit-cible', bloc).map((r) => ({
      repo_id: Number(r.querySelector('.cockpit-c-repo').value) || 0,
      project: r.querySelector('.cockpit-c-repo').dataset.label || '',
      branch: r.querySelector('.cockpit-c-branch').value.trim(),
      base_branch: r.querySelector('.cockpit-c-base').value || '',
    }));
  });
}
function renderPrepares() {
  memoriserBlocs();
  const box = $('#cockpitPrepares');
  box.innerHTML = journeePrepares.map(blocJourneeHtml).join('');
  cablerCiblesJournee(box);
  majToutJournee();
}
function majToutJournee() {
  const restants = journeePrepares.filter((x) => !x.fait).length;
  $('#cockpitLancer').disabled = !restants;
  $('#cockpitToutEnregistrer').disabled = !restants;
}
// Ce que le bloc dit MAINTENANT (les dépôts saisis), relu au moment du clic.
function lireBloc(bloc) {
  const x = journeePrepares[Number(bloc.dataset.prep)];
  const targets = $$('.cockpit-cible', bloc).map((r) => ({
    repo_id: Number(r.querySelector('.cockpit-c-repo').value) || 0,
    branch: r.querySelector('.cockpit-c-branch').value.trim(),
    base_branch: r.querySelector('.cockpit-c-base').value || '',
  })).filter((g) => g.repo_id);
  const zone = bloc.querySelector('.cockpit-attendu-texte');
  const attendu = zone ? zone.value.trim() : String(x.attendu || '').trim();
  return { x, session: { key: x.key, summary: x.summary, prompt: x.prompt, targets, attendu, attendu_source: zone && zone.dataset.saisi ? 'saisi' : 'jira' } };
}
$('#cockpitPreparer') && $('#cockpitPreparer').addEventListener('click', async (e) => {
  const keys = clesJournee();
  if (!keys.length) return;
  let r;
  try {
    r = await busy(e.currentTarget, async () => {
      if (!journeeDepots) journeeDepots = (await api('/repos')).filter((d) => d.enabled !== 0).map((d) => ({ id: d.id, project: d.project }));
      return api('/cockpit/journee/preparer', { method: 'POST', body: { keys } });
    });
  } catch (err) { toast(explainError(err.message), true); return; }
  $('#cockpitPrepares').innerHTML = '';
  journeePrepares = r.tickets.map((x) => ({ ...x, fait: null }));
  const res = $('#cockpitResultat');
  res.hidden = !r.erreurs.length;
  res.innerHTML = r.erreurs.map((i) => `<div class="cockpit-ignore"><b>${esc(i.key)}</b> ${esc(i.raison)}</div>`).join('');
  etapeJournee(true);
  renderPrepares();
});
$('#cockpitPrepares') && $('#cockpitPrepares').addEventListener('click', async (e) => {
  const bloc = e.target.closest && e.target.closest('.cockpit-prep');
  if (!bloc) return;
  if (e.target.closest('[data-cockpit-cible-plus]')) {
    const x = journeePrepares[Number(bloc.dataset.prep)];
    bloc.querySelector('.cockpit-cibles').insertAdjacentHTML('beforeend', cibleJourneeHtml({ branch: x.branche_defaut }));
    cablerCiblesJournee(bloc);
    return;
  }
  const sug = e.target.closest('[data-cockpit-suggere]');
  if (sug) { suggererDepot(bloc, Number(sug.dataset.cockpitSuggere), sug.textContent.trim()); return; }
  const moins = e.target.closest('[data-cockpit-cible-moins]');
  if (moins) { moins.closest('.cockpit-cible').remove(); return; }
  const b = e.target.closest('[data-cockpit-prep]');
  if (b) await agirBloc(bloc, b.dataset.cockpitPrep, b);
});
// Le dépôt change : la branche de départ choisie appartenait à l'ancien.
$('#cockpitPrepares') && $('#cockpitPrepares').addEventListener('change', (e) => {
  if (!e.target.classList || !e.target.classList.contains('cockpit-c-repo')) return;
  const base = e.target.closest('.cockpit-cible').querySelector('.cockpit-c-base');
  base.value = ''; base.dataset.label = '';
  const champ = e.target.closest('.cockpit-cible').querySelector('[data-combo="cockpit-c-base"]');
  if (champ) champ.value = '';
});

function suggererDepot(bloc, repoId, project) {
  const lignes = $$('.cockpit-cible', bloc);
  if (lignes.some((r) => Number(r.querySelector('.cockpit-c-repo').value) === repoId)) return;
  let ligne = lignes.find((r) => !Number(r.querySelector('.cockpit-c-repo').value));
  if (!ligne) {
    const x = journeePrepares[Number(bloc.dataset.prep)];
    bloc.querySelector('.cockpit-cibles').insertAdjacentHTML('beforeend', cibleJourneeHtml({ branch: x.branche_defaut }));
    cablerCiblesJournee(bloc);
    ligne = $$('.cockpit-cible', bloc).pop();
  }
  const cache = ligne.querySelector('.cockpit-c-repo');
  cache.value = String(repoId); cache.dataset.label = project;
  const champ = ligne.querySelector('[data-combo="cockpit-c-repo"]');
  champ.value = project; champ.title = project;
  cache.dispatchEvent(new Event('change', { bubbles: true }));
}

/* Créer les sessions de blocs, lancées ou non. Rend les créées ; un refus (aucun dépôt…) est dit en toast. */
async function creerJournee(sessions, lancer, bouton) {
  const r = await busy(bouton, () => api('/cockpit/journee/creer', {
    method: 'POST', body: { sessions, modele_id: Number($('#cockpitModele').value) || null, lancer },
  }));
  for (const c of r.creees) {
    const x = journeePrepares.find((p) => p.key === c.key && !p.fait);
    if (x) x.fait = { task_id: c.task_id, lancee: c.lancee };
  }
  if (r.ignores.length) toast(r.ignores.map((i) => `${i.key} : ${i.raison}`).join(' · '), true);
  renderPrepares();
  loadCockpit();
  return r.creees;
}
async function agirBloc(bloc, geste, bouton) {
  const { x, session } = lireBloc(bloc);
  // Éditer sans dépôt saisi : la fenêtre de session, préparée depuis le ticket, les fera choisir.
  if (geste === 'editer' && !session.targets.length) {
    $('#cockpitJourneeModal').hidden = true;
    openTaskForJira(x.key);
    return;
  }
  if (!session.targets.length) { toast(tr('cockpit.journee.fill-repo'), true); return; }
  let creees;
  try { creees = await creerJournee([session], geste === 'lancer', bouton); }
  catch (err) { toast(explainError(err.message), true); return; }
  if (geste === 'editer' && creees.length) {
    $('#cockpitJourneeModal').hidden = true;
    openTaskEdit(creees[0].task_id);
  }
}
async function toutJournee(lancer, bouton) {
  const blocs = $$('#cockpitPrepares .cockpit-prep:not(.is-fait)').map(lireBloc);
  const sessions = blocs.filter((b) => b.session.targets.length).map((b) => b.session);
  const sans = blocs.filter((b) => !b.session.targets.length).map((b) => b.x.key);
  if (sans.length) toast(tr('cockpit.journee.skipped-no-repo', { keys: sans.join(', ') }), true);
  if (!sessions.length) return;
  let creees;
  try { creees = await creerJournee(sessions, lancer, bouton); }
  catch (err) { toast(explainError(err.message), true); return; }
  toast(tr(lancer ? 'cockpit.journee.launched' : 'cockpit.journee.saved', { n: creees.length, count: creees.length }));
  if (!journeePrepares.some((p) => !p.fait)) $('#cockpitJourneeModal').hidden = true;
}
$('#cockpitLancer') && $('#cockpitLancer').addEventListener('click', (e) => toutJournee(true, e.currentTarget));
$('#cockpitToutEnregistrer') && $('#cockpitToutEnregistrer').addEventListener('click', (e) => toutJournee(false, e.currentTarget));
// Le scénario attendu retouché ici n'est plus celui du ticket : sa source devient « saisi ».
$('#cockpitPrepares') && $('#cockpitPrepares').addEventListener('input', (e) => {
  if (e.target && e.target.classList && e.target.classList.contains('cockpit-attendu-texte')) e.target.dataset.saisi = '1';
});
