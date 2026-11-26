'use strict';
/* LA CHAÎNE DE VALIDATION D'UNE SESSION DE CODAGE : le choix dans la fenêtre de session (des
   vérificateurs dans l'ordre où ils tourneront) et son état sur la carte — vérificateur par vérificateur,
   la base puis la branche, l'essai en cours, et « Relancer » quand elle attend l'utilisateur. */
// @expose chaineHtml

let chaineOrdre = [];          // les vérificateurs cochés, dans l'ordre de passage
let chaineVerifiers = [];
let chaineSkillVoulu = '';     // `<repo_id>:<nom>` du skill de diagnostic, gardé pendant que la liste se recharge
let chaineScenVoulu = null;    // le scénario de couverture : { verifier_id, skill: '<repo_id>:<nom>' } ou null

/* À l'ouverture de la fenêtre : la chaîne de la session (édition, duplication) ou vide. Tous les
   vérificateurs sont proposés, couvrants ou non : un vérificateur du dépôt de tests ne couvre pas le
   dépôt de l'application, et c'est justement lui qu'on veut. */
async function initChaineVerif(ids, skill = null, scenario = null) {
  let sk = skill;
  if (typeof sk === 'string') { try { sk = JSON.parse(sk); } catch { sk = null; } }
  chaineSkillVoulu = sk && sk.name ? `${sk.repo_id}:${sk.name}` : '';
  let sc = scenario;
  if (typeof sc === 'string') { try { sc = JSON.parse(sc); } catch { sc = null; } }
  chaineScenVoulu = sc && sc.verifier_id ? { verifier_id: Number(sc.verifier_id), skill: sc.skill ? `${sc.skill.repo_id}:${sc.skill.name}` : '' } : null;
  const caseScen = $('#taskChaineScen'); if (caseScen) caseScen.checked = !!chaineScenVoulu;
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
  const repos = [...new Set(chaineVerifiers.filter((v) => chaineOrdre.includes(v.id))
    .flatMap((v) => (v.repos || []).map((r) => r.repo_id)))];
  let skills = [];
  try { const d = await api(`/skills?repos=${repos.join(',')}`); skills = (d.items || []).filter((x) => x.kind === 'skill' && x.source === 'repo'); } catch { skills = []; }
  sel.innerHTML = `<option value="">${esc(tr('task.chaine.skill.none'))}</option>`
    + skills.map((x) => `<option value="${esc(`${x.repo_id}:${x.name}`)}">${esc(x.name)} — ${esc(x.project || '')}</option>`).join('');
  sel.value = skills.some((x) => `${x.repo_id}:${x.name}` === chaineSkillVoulu) ? chaineSkillVoulu : '';
  // Le scénario de couverture : le vérificateur qui le lance (un des cochés, celui du dépôt de tests) et son skill.
  const rangee = $('#taskChaineScenRow'); const boite = $('#taskChaineScenBox');
  if (rangee) rangee.hidden = false;
  if (boite) boite.hidden = !$('#taskChaineScen').checked;
  const sv = $('#taskChaineScenVerif'); const ss = $('#taskChaineScenSkill');
  if (sv && $('#taskChaineScen').checked) {
    const coches = chaineVerifiers.filter((v) => chaineOrdre.includes(v.id));
    sv.innerHTML = coches.map((v) => `<option value="${v.id}">${esc(v.name)}</option>`).join('');
    const voulu = chaineScenVoulu && coches.some((v) => v.id === chaineScenVoulu.verifier_id) ? chaineScenVoulu.verifier_id : (coches[coches.length - 1] || {}).id;
    if (voulu) sv.value = String(voulu);
    ss.innerHTML = sel.innerHTML;
    ss.value = chaineScenVoulu && skills.some((x) => `${x.repo_id}:${x.name}` === chaineScenVoulu.skill) ? chaineScenVoulu.skill : '';
  }
}
function chaineScenarioValeur() {
  if (!chaineOrdre.length || !$('#taskChaineScen') || !$('#taskChaineScen').checked) return null;
  const vid = Number(($('#taskChaineScenVerif') || {}).value) || 0;
  if (!vid) return null;
  const v = ($('#taskChaineScenSkill') || {}).value || '';
  const i = v.indexOf(':');
  return { verifier_id: vid, skill: i > 0 ? { repo_id: Number(v.slice(0, i)), name: v.slice(i + 1) } : null };
}
$('#taskChaineScen') && $('#taskChaineScen').addEventListener('change', () => majSkillChaine());
// Le choix de l'utilisateur est retenu au changement : la liste se refait sans l'écraser.
$('#taskChaineScenVerif') && $('#taskChaineScenVerif').addEventListener('change', (e) => { chaineScenVoulu = { ...(chaineScenVoulu || {}), verifier_id: Number(e.target.value) }; });
$('#taskChaineScenSkill') && $('#taskChaineScenSkill').addEventListener('change', (e) => { chaineScenVoulu = { ...(chaineScenVoulu || {}), skill: e.target.value }; });
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
/* Le scénario de couverture : en écriture, couvert par un existant, ou ses fichiers et leur lancement. */
function scenarioChaineHtml(sc) {
  if (!sc) return '';
  let corps;
  if (sc.en_cours === 'ecrire') corps = `<span class="tag to_review">${esc(tr('task.chaine.scen.writing'))}</span>`;
  else if (sc.en_cours === 'corriger') corps = `<span class="tag to_review">${esc(tr('task.chaine.scen.fixing', { n: sc.corrections, max: sc.max }))}</span>`;
  else if (sc.couvert) corps = `<span class="tag task-chaine-diag is-branche" title="${esc(sc.couvert.raison || '')}">${esc(tr('task.chaine.scen.covered', { par: sc.couvert.par || '?' }))}</span>`
    + (sc.couvert.raison ? `<span class="task-chaine-preuve">${esc(sc.couvert.raison)}</span>` : '');
  else corps = `<code class="task-chaine-fichiers">${esc((sc.fichiers || []).join(' '))}</code>${sc.run ? ` ${coteChaineHtml('head', sc.run)}` : ''}`;
  return `<div class="task-chaine-etape task-chaine-scenario"><span class="task-chaine-nom">${esc(tr('task.chaine.scen.label'))}</span> ${corps}
    ${sc.erreur ? `<span class="task-chaine-erreur">${esc(sc.erreur)}</span>` : ''}</div>`;
}
function chaineHtml(t) {
  const c = t && t.chaine;
  if (!c || !c.steps || !c.steps.length) return '';
  const etapes = c.steps.map((s) => `<li class="task-chaine-etape">
      <span class="task-chaine-nom">${esc(s.verifier_name || '?')}</span>
      ${coteChaineHtml('base', s.base)} ${coteChaineHtml('head', s.head)}
      ${s.erreur ? `<span class="task-chaine-erreur">${esc(s.erreur)}</span>` : ''}
      ${s.base.etat === 'broken' ? `<span class="tag stale">${esc(tr('task.chaine.base-broken'))}</span>` : ''}
      ${s.head.etat === 'broken' && !(s.diag && (s.diag.en_cours || s.diag.cause === 'branche')) ? `<span class="tag stale">${esc(tr('task.chaine.head-broken'))}</span>` : ''}
      ${diagChaineHtml(s.diag)}
    </li>`).join('');
  const relancer = c.status === 'attention'
    ? `<button type="button" class="btn btn-sm" data-chaine-relancer="${t.id}">${esc(tr('task.chaine.relaunch'))}</button>` : '';
  return `<div class="task-chaine is-${esc(c.status)}" data-chaine-task="${t.id}">
    <span class="task-chaine-titre">${esc(tr(`task.chaine.status.${c.status}`))}</span> ${relancer}
    <ol class="task-chaine-etapes">${etapes}</ol>${scenarioChaineHtml(c.scenario)}</div>`;
}
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
