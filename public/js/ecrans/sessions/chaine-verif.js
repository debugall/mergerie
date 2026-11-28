'use strict';
/* LA CHAÎNE DE VALIDATION D'UNE SESSION DE CODAGE : le choix dans la fenêtre de session (des
   vérificateurs dans l'ordre où ils tourneront) et son état sur la carte — vérificateur par vérificateur,
   la base puis la branche, l'essai en cours, et « Relancer » quand elle attend l'utilisateur. */

let chaineOrdre = [];          // les vérificateurs cochés, dans l'ordre de passage
let chaineVerifiers = [];
let chaineSkillVoulu = '';     // `<repo_id>:<nom>` du skill de diagnostic, gardé pendant que la liste se recharge
let chaineAttenduSource = null; // d'où vient le scénario attendu : 'jira' (le ticket) ou 'saisi' (tapé ici)

/* À l'ouverture de la fenêtre : la chaîne de la session (édition, duplication) ou vide. Tous les
   vérificateurs sont proposés, couvrants ou non : un vérificateur du dépôt de tests ne couvre pas le
   dépôt de l'application, et c'est justement lui qu'on veut. */
/* `scenario` : `{ actif, attendu, attendu_source }` (l'ancien `{ verifier_id, skill }` vaut « coché, sans
   consigne ») ; `verrouille` : l'étape tests a démarré, le scénario attendu ne se modifie plus. */
async function initChaineVerif(ids, skill = null, scenario = null, { verrouille = false } = {}) {
  let sk = skill;
  if (typeof sk === 'string') { try { sk = JSON.parse(sk); } catch { sk = null; } }
  chaineSkillVoulu = sk && sk.name ? `${sk.repo_id}:${sk.name}` : '';
  let sc = scenario;
  if (typeof sc === 'string') { try { sc = JSON.parse(sc); } catch { sc = null; } }
  const actif = !!(sc && sc.actif !== false && (sc.actif || sc.verifier_id));
  const caseScen = $('#taskChaineScen'); if (caseScen) { caseScen.checked = actif; caseScen.disabled = verrouille; }
  const zone = $('#taskChaineScenAttendu');
  if (zone) { zone.value = (actif && sc.attendu) || ''; zone.readOnly = verrouille; }
  chaineAttenduSource = actif && sc.attendu ? (sc.attendu_source || 'saisi') : null;
  const note = $('#taskChaineScenVerrou'); if (note) note.hidden = !verrouille;
  let brut = ids;
  if (typeof brut === 'string') { try { brut = JSON.parse(brut); } catch { brut = []; } }
  chaineOrdre = Array.isArray(brut) ? brut.map(Number).filter(Boolean) : [];
  const filtre = $('#taskChaineFiltre'); if (filtre) filtre.value = '';
  try { const d = await api('/verifiers'); chaineVerifiers = Array.isArray(d) ? d : (d.verifiers || []); } catch { chaineVerifiers = []; }
  chaineOrdre = chaineOrdre.filter((id) => chaineVerifiers.some((v) => v.id === id));
  rendreChaineVerif();
}
function rendreChaineVerif() {
  const el = $('#taskChaineList');
  if (!el) return;
  if (!chaineVerifiers.length) { el.innerHTML = `<p class="muted">${esc(tr('task.chaine.none'))}</p>`; majChaineVerif(); return; }
  el.innerHTML = chaineVerifiers.map((v) => {
    const rang = chaineOrdre.indexOf(v.id);
    return `<label class="task-chaine-row" data-nom="${esc(String(v.name || '').toLowerCase())}"><input type="checkbox" class="task-chaine-pick" value="${v.id}"${rang >= 0 ? ' checked' : ''} />
      <span class="task-chaine-rang">${rang >= 0 ? `${rang + 1}.` : ''}</span> <span>${esc(v.name)}</span></label>`;
  }).join('');
  filtrerChaineVerif();
  majChaineVerif();
  majSkillChaine();
}
/* Les skills du dépôt de tests : ceux des dépôts que couvrent les vérificateurs cochés. */
async function majSkillChaine() {
  const ligne = $('#taskChaineSkillRow'); const sel = $('#taskChaineSkill');
  if (!ligne || !sel) return;
  ligne.hidden = !chaineOrdre.length;
  const rangeeScen = $('#taskChaineScenRow'); if (rangeeScen) rangeeScen.hidden = !chaineOrdre.length;
  if (!chaineOrdre.length) { const b = $('#taskChaineScenBox'); if (b) b.hidden = true; return; }
  const boite = $('#taskChaineScenBox');
  if (boite) boite.hidden = !$('#taskChaineScen').checked;
  majInfoDepotsTests();
  const repos = [...new Set(chaineVerifiers.filter((v) => chaineOrdre.includes(v.id))
    .flatMap((v) => (v.repos || []).map((r) => r.repo_id)))];
  let skills = [];
  try { const d = await api(`/skills?repos=${repos.join(',')}`); skills = (d.items || []).filter((x) => x.kind === 'skill' && x.source === 'repo'); } catch { skills = []; }
  sel.innerHTML = `<option value="">${esc(tr('task.chaine.skill.none'))}</option>`
    + skills.map((x) => `<option value="${esc(`${x.repo_id}:${x.name}`)}">${esc(x.name)} — ${esc(x.project || '')}</option>`).join('');
  sel.value = skills.some((x) => `${x.repo_id}:${x.name}` === chaineSkillVoulu) ? chaineSkillVoulu : '';
}
/* LA LIGNE D'INFORMATION SOUS LA CASE : les dépôts de tests que la chaîne cochée retiendra, et le chemin de
   leur clone local — ou que les tests iront dans les dépôts de la session. Calculée par le serveur, avec la
   même règle que l'étape (surcharge du vérificateur, sinon le réglage commun ; hors dépôts de la session). */
let infoTestsSeq = 0;
async function majInfoDepotsTests() {
  const el = $('#taskChaineScenInfo');
  if (!el || !$('#taskChaineScen') || !$('#taskChaineScen').checked || !chaineOrdre.length) { if (el) el.textContent = ''; return; }
  const seq = ++infoTestsSeq;
  const repos = (typeof readTargetRows === 'function' ? readTargetRows() : []).map((x) => x.repo_id);
  let d;
  try { d = await api(`/chaine/depots-tests?verifiers=${chaineOrdre.join(',')}&repos=${repos.join(',')}`); } catch (e) { d = { erreur: e.message, depots: [] }; }
  if (seq !== infoTestsSeq) return;
  if (d.erreur) { el.textContent = d.erreur; return; }
  el.textContent = d.depots.length
    ? tr('task.chaine.scen.repos-info', { list: d.depots.map((x) => tr(x.forge_ok ? 'task.chaine.scen.repo-mr' : 'task.chaine.scen.repo-no-forge', { repo: x.project })).join(' · ') })
    : tr('task.chaine.scen.repos-none');
}
/* Ce qui part au serveur : la case, et le scénario attendu avec sa source — `jira` tant qu'il est tel que le
   ticket l'a donné, `saisi` dès qu'on y touche. */
function chaineScenarioValeur() {
  if (!chaineOrdre.length || !$('#taskChaineScen') || !$('#taskChaineScen').checked) return null;
  const attendu = (($('#taskChaineScenAttendu') || {}).value || '').trim();
  return { actif: true, attendu: attendu || null, attendu_source: attendu ? (chaineAttenduSource || 'saisi') : null };
}
/* Le scénario attendu lu dans un ticket (`&&? …`) : posé dans la zone, la case cochée s'il y a une chaîne. */
function poserAttenduJira(texte) {
  const zone = $('#taskChaineScenAttendu');
  if (!zone || !String(texte || '').trim() || zone.readOnly) return;
  zone.value = String(texte).trim();
  chaineAttenduSource = 'jira';
  const c = $('#taskChaineScen'); if (c && chaineOrdre.length) { c.checked = true; majSkillChaine(); }
}
$('#taskChaineScen') && $('#taskChaineScen').addEventListener('change', () => majSkillChaine());
$('#taskChaineScenAttendu') && $('#taskChaineScenAttendu').addEventListener('input', () => { chaineAttenduSource = 'saisi'; });
$('#targetRows') && $('#targetRows').addEventListener('change', () => majInfoDepotsTests());
function chaineSkillValeur() {
  const v = ($('#taskChaineSkill') || {}).value || '';
  const i = v.indexOf(':');
  return chaineOrdre.length && i > 0 ? { repo_id: Number(v.slice(0, i)), name: v.slice(i + 1) } : null;
}
// Le filtre CACHE des lignes sans rien décocher.
function filtrerChaineVerif() {
  const q = (($('#taskChaineFiltre') || {}).value || '').toLowerCase().trim();
  $$('#taskChaineList .task-chaine-row').forEach((r) => { r.hidden = !!q && !r.dataset.nom.includes(q); });
}
/* Une chaîne choisie : l'auto-push se coche (on vérifie du code poussé) et « Vérifier après » s'efface —
   la chaîne le remplace, les deux ensemble vérifieraient deux fois. */
function majChaineVerif() {
  const f = $('#taskForm');
  const actif = chaineOrdre.length > 0;
  const sel = $('#taskVerifier');
  const ligne = sel && sel.closest('label');
  if (ligne) ligne.hidden = actif;
  if (actif && sel && sel.value) sel.value = '';
  if (actif && f && f.auto_push && !f.auto_push.checked) f.auto_push.checked = true;
}
const chaineVerifValeur = () => [...chaineOrdre];
$('#taskChaineSkill') && $('#taskChaineSkill').addEventListener('change', (e) => { chaineSkillVoulu = e.target.value; });

$('#taskChaineFiltre') && $('#taskChaineFiltre').addEventListener('input', filtrerChaineVerif);
$('#taskChaineList') && $('#taskChaineList').addEventListener('change', (e) => {
  const c = e.target.closest && e.target.closest('.task-chaine-pick');
  if (!c) return;
  const id = Number(c.value);
  chaineOrdre = chaineOrdre.filter((x) => x !== id);
  if (c.checked) chaineOrdre.push(id);
  rendreChaineVerif();
});
// Décocher l'auto-push retire la chaîne : elle ne pourrait rien vérifier.
document.addEventListener('change', (e) => {
  if (!e.target.closest || !e.target.matches('#taskForm [name="auto_push"]') || e.target.checked || !chaineOrdre.length) return;
  chaineOrdre = [];
  rendreChaineVerif();
  toast(tr('task.chaine.dropped'));
});

/* ---------- Sur la carte ---------- */

const CHAINE_ICONE = { pass: '✓', broken: '✗', running: '⟳', queued: '…', todo: '·', waiting: '·' };
function coteChaineHtml(quoi, c) {
  const essai = (c.etat === 'running' || c.etat === 'queued' || c.etat === 'todo') && c.essai > 1 ? ` ${tr('task.chaine.attempt', { n: c.essai })}` : '';
  const titre = tr(`task.chaine.state.${c.etat}`);
  const lien = c.verification_id ? ` data-chaine-verif="${c.verification_id}"` : '';
  return `<span class="task-chaine-cote is-${esc(c.etat)}" title="${esc(titre)}"${lien}>${esc(tr(`task.chaine.${quoi}`))} ${CHAINE_ICONE[c.etat] || '·'}${esc(essai)}</span>`;
}
/* Le diagnostic de la branche : en cours, ou ce qu'il a conclu — la preuve au survol et dessous. */
function diagChaineHtml(d) {
  if (!d) return '';
  if (d.en_cours) return `<span class="tag to_review task-chaine-diag" title="${esc(tr('task.chaine.diag.title'))}">${esc(tr('task.chaine.diag.running', { n: d.rounds, max: d.max }))}</span>`;
  if (!d.cause) return '';
  return `<span class="tag task-chaine-diag is-${esc(d.cause)}" title="${esc(d.preuve || '')}">${esc(tr(`task.chaine.diag.cause.${d.cause}`))}</span>`
    + (d.preuve && d.cause !== 'branche' ? `<span class="task-chaine-preuve">${esc(d.preuve)}</span>` : '');
}
/* L'ÉTAPE TESTS SUR LA CARTE : ce qui a été écrit, où, par quel vérificateur c'est prouvé, et la merge request
   d'un dépôt de tests (brouillon jusqu'au vert, puis prête). Un bloc par dépôt touché ; « Demandé / Écrit » quand l'utilisateur a donné un scénario
   attendu ; ambre pour ce qui demande un regard (un test existant modifié, du code touché à cette étape). Un
   « déjà couvert » dit les tests cités et la raison — jamais « couverture prouvée » : le contrôle prouve que
   le test existe, pas qu'il exerce le changement. */
const comptesFichiers = (d) => [['ajoutes', 'added'], ['modifies', 'modified'], ['supprimes', 'deleted']]
  .filter(([k]) => d[k].length).map(([k, cle]) => tr(`task.chaine.tests.${cle}`, { n: d[k].length, count: d[k].length })).join(', ');
function depotTestsHtml(taskId, d) {
  const touchesTests = [...d.modifies, ...d.supprimes].filter((f) => d.tests.includes(f));
  const ou = d.zone === 'tests'
    ? `<code>${esc(d.branche)}</code>${d.mr_url ? ` · <a href="${esc(safeUrl(d.mr_url))}" target="_blank" rel="noopener">!${esc(String(d.mr_iid))}</a>
      <span class="tag task-tests-mr is-${d.mr_pret ? 'prete' : 'brouillon'}">${esc(tr(d.mr_pret ? 'task.chaine.tests.mr-ready' : 'task.chaine.tests.mr-draft'))}</span>` : ''}${d.mr_erreur
      ? ` <span class="tag stale" title="${esc(d.mr_erreur)}">${esc(tr('task.chaine.tests.mr-error'))}</span>` : ''}`
    : `${d.mr_url ? `<a href="${esc(safeUrl(d.mr_url))}" target="_blank" rel="noopener">!${esc(String(d.mr_iid))}</a>` : ''}${d.relu === false ? ` <span class="tag stale">${esc(tr('task.chaine.tests.unreviewed'))}</span>` : ''}`;
  return `<div class="task-tests-depot" data-tests-depot="${d.repo_id}">
    <span class="task-tests-zone is-${esc(d.zone)}">${esc(tr(`task.chaine.tests.zone.${d.zone}`))}</span>
    <strong>${esc(d.project)}</strong> <span class="muted">${esc(comptesFichiers(d) || tr('task.chaine.tests.nothing'))}</span> ${ou}
    ${d.sha_final ? `<button type="button" class="btn btn-sm" data-tests-diff="${taskId}" data-repo="${d.repo_id}"><svg class="ico ico-sm"><use href="#i-eye"/></svg>${esc(tr('mr.btn.diff'))}</button>` : ''}
    ${touchesTests.map((f) => `<button type="button" class="tag task-tests-alerte" data-tests-diff="${taskId}" data-repo="${d.repo_id}" data-path="${esc(f)}" title="${esc(f)}">${esc(tr('task.chaine.tests.existing-changed'))} · ${esc(f.split('/').pop())}</button>`).join('')}
  </div>`;
}
function scenarioChaineHtml(taskId, sc) {
  if (!sc) return '';
  let statut = '';
  if (sc.en_cours === 'ecrire') statut = `<span class="tag to_review">${esc(tr('task.chaine.tests.writing'))}</span>`;
  else if (sc.en_cours === 'corriger') statut = `<span class="tag to_review">${esc(tr('task.chaine.tests.fixing', { n: sc.corrections, max: sc.max }))}</span>`;
  else if (sc.final === 'couvert') statut = `<span class="tag task-chaine-diag is-branche">${esc(tr('task.chaine.tests.covered'))}</span>`;
  else if (sc.final === 'vert') statut = `<span class="tag task-chaine-diag is-branche">${esc(tr('task.chaine.tests.green'))}</span>`;
  else if (sc.rejeu.some((r) => r.etat === 'running' || r.etat === 'queued')) statut = `<span class="tag to_review">${esc(tr('task.chaine.tests.replaying'))}</span>`;
  const couvert = sc.couvert ? `<div class="task-tests-couvert">${sc.couvert.par.map((p) => `<span class="tag">${esc(tr('task.chaine.tests.covered-by', { repo: p.project, path: p.chemin }))}</span>`).join(' ')}
    ${sc.couvert.raison ? `<span class="task-chaine-preuve">${esc(sc.couvert.raison)}</span>` : ''}</div>` : '';
  const code = sc.code_modifie.map((c) => `<span class="tag task-tests-alerte" title="${esc(c.fichiers.join('\n'))}">${esc(tr('task.chaine.tests.code-changed', { sha: String(c.sha || '').slice(0, 8), repo: c.project || '' }))}</span>`).join(' ');
  const ecrits = sc.depots.flatMap((d) => [...d.ajoutes, ...d.modifies].map((f) => `${d.project}:${f}`));
  const ouvert = demandeEcritOuvert.has(taskId);
  const demande = sc.attendu ? `<details class="task-tests-demande" data-tests-demande="${taskId}"${ouvert ? ' open' : ''}>
      <summary>${esc(tr('task.chaine.tests.asked-written'))}</summary>
      <div class="task-tests-colonnes"><div><h5>${esc(tr('task.chaine.tests.asked'))}</h5><pre>${esc(sc.attendu)}</pre></div>
      <div><h5>${esc(tr('task.chaine.tests.written'))}</h5>${ecrits.length || sc.couvert
        ? `<ul>${(ecrits.length ? ecrits : sc.couvert.par.map((p) => `${p.project}:${p.chemin}`)).map((f) => `<li><code>${esc(f)}</code></li>`).join('')}</ul>`
        : `<p class="muted">${esc(tr('task.chaine.tests.nothing-yet'))}</p>`}</div></div>
    </details>` : '';
  return `<div class="task-chaine-scenario">
    <div class="task-tests-tete"><span class="task-chaine-nom">${esc(tr('task.chaine.tests.label'))}</span> ${statut} ${code}</div>
    ${sc.erreur ? `<span class="task-chaine-erreur">${esc(sc.erreur)}</span>` : ''}
    ${couvert}${sc.depots.map((d) => depotTestsHtml(taskId, d)).join('')}${demande}
  </div>`;
}
/* La cellule « avec les tests » d'un vérificateur : son rejeu après l'écriture, ouvert sur son rapport. */
function rejeuChaineHtml(sc, verifierId) {
  const r = sc && sc.rejeu && sc.rejeu.find((x) => x.verifier_id === verifierId);
  return r ? coteChaineHtml('tests', r) : '';
}
function chaineHtml(t) {
  const c = t && t.chaine;
  if (!c || !c.steps || !c.steps.length) return '';
  const etapes = c.steps.map((s) => `<li class="task-chaine-etape">
      <span class="task-chaine-nom">${esc(s.verifier_name || '?')}</span>
      ${coteChaineHtml('base', s.base)} ${coteChaineHtml('head', s.head)} ${rejeuChaineHtml(c.scenario, s.verifier_id)}
      ${s.erreur ? `<span class="task-chaine-erreur">${esc(s.erreur)}</span>` : ''}
      ${s.base.etat === 'broken' ? `<span class="tag stale">${esc(tr('task.chaine.base-broken'))}</span>` : ''}
      ${s.head.etat === 'broken' && !(s.diag && (s.diag.en_cours || s.diag.cause === 'branche')) ? `<span class="tag stale">${esc(tr('task.chaine.head-broken'))}</span>` : ''}
      ${diagChaineHtml(s.diag)}
    </li>`).join('');
  const relancer = c.status === 'attention'
    ? `<button type="button" class="btn btn-sm" data-chaine-relancer="${t.id}">${esc(tr('task.chaine.relaunch'))}</button>` : '';
  /* La frise de la carte dit déjà où en est chaque vérificateur : le détail (côtés, essais, preuves du
     diagnostic) reste replié, ouvert au clic, et le reste malgré le rafraîchissement. Les tests écrits, eux,
     restent sous les yeux : c'est là que se lit ce qui reste à faire à la main. */
  const ouvert = chaineDepliees.has(t.id);
  return `<div class="task-chaine is-${esc(c.status)}" data-chaine-task="${t.id}">
    <span class="task-chaine-titre">${esc(tr(`task.chaine.status.${c.status}`))}</span> ${relancer}
    <button type="button" class="btn btn-sm btn-ghost task-chaine-bascule" data-chaine-bascule="${t.id}" aria-expanded="${ouvert}">${esc(tr(ouvert ? 'task.chaine.fold' : 'task.chaine.unfold'))}</button>
    <div class="task-chaine-corps"${ouvert ? '' : ' hidden'}><ol class="task-chaine-etapes">${etapes}</ol></div>${scenarioChaineHtml(t.id, c.scenario)}</div>`;
}
// « Demandé / Écrit » ouvert : le choix tient au rafraîchissement de la liste.
const demandeEcritOuvert = new Set();
document.addEventListener('toggle', (e) => {
  const d = e.target && e.target.closest && e.target.closest('[data-tests-demande]');
  if (!d) return;
  const id = Number(d.dataset.testsDemande);
  if (d.open) demandeEcritOuvert.add(id); else demandeEcritOuvert.delete(id);
}, true);
// « Voir le diff » d'un dépôt touché à l'étape tests — ou d'un seul fichier (un test existant modifié).
document.addEventListener('click', async (e) => {
  const b = e.target.closest && e.target.closest('[data-tests-diff]');
  if (!b) return;
  await openSessionDiff(`/tasks/${b.dataset.testsDiff}/chaine/tests/${b.dataset.repo}`);
  if (b.dataset.path && typeof selectFile === 'function') selectFile(b.dataset.path);
});
const chaineDepliees = new Set();
document.addEventListener('click', (e) => {
  const b = e.target.closest && e.target.closest('[data-chaine-bascule]');
  if (!b) return;
  const id = Number(b.dataset.chaineBascule);
  const ouvrir = !chaineDepliees.has(id);
  if (ouvrir) chaineDepliees.add(id); else chaineDepliees.delete(id);
  b.setAttribute('aria-expanded', String(ouvrir));
  b.textContent = tr(ouvrir ? 'task.chaine.fold' : 'task.chaine.unfold');
  b.closest('.task-chaine').querySelector('.task-chaine-corps').hidden = !ouvrir;
});
document.addEventListener('click', async (e) => {
  const v = e.target.closest && e.target.closest('[data-chaine-verif]');
  if (v) { openVerifyReport(Number(v.dataset.chaineVerif)); return; }
  const b = e.target.closest && e.target.closest('[data-chaine-relancer]');
  if (!b) return;
  try {
    await busy(b, () => api(`/tasks/${b.dataset.chaineRelancer}/chaine/relancer`, { method: 'POST' }));
    toast(tr('task.chaine.relaunched'));
  } catch (err) { toast(explainError(err.message), true); }
  loadTasks();
});
