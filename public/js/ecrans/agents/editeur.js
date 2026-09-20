'use strict';
/* Agents — l'éditeur : l'exécutant, l'équipe, le bandeau des automatismes, l'aperçu. */
// @expose moiCache, partageActif, poserApprobationAuto, poserExecutantAuto
/* ---------- L'éditeur ---------- */

function agentReposHtml(choisis) {
  const parId = new Map((choisis || []).map((r) => [Number(r.repo_id), r]));
  return repoOptions.map((r) => {
    const c = parId.get(r.id);
    return `<label class="inline-check agent-repo-row" data-cherche="${esc(r.project.toLowerCase())}">
      <input type="checkbox" class="ag-repo" value="${r.id}"${c ? ' checked' : ''} />
      <span>${esc(r.project)}</span>
      <select class="ag-role">
        <option value="readonly"${c && c.role === 'readonly' ? ' selected' : ''}>${esc(tr('agents.role.readonly'))}</option>
        <option value="target"${c && c.role === 'target' ? ' selected' : ''}>${esc(tr('agents.role.target'))}</option>
      </select>
    </label>`;
  }).join('');
}

function lireAgentForm() {
  const f = $('#agentForm');
  const liste = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean);
  return {
    name: $('#agentName').value,
    description: $('#agentDesc').value,
    kind: $('#agentKind').value,
    scope_kind: (f.querySelector('input[name="scope_kind"]:checked') || {}).value || 'all_repos',
    system_prompt: $('#agentSystemPrompt').value,
    prompt_template: $('#agentTemplate').value,
    model: $('#agentModel').value,
    permission_mode: (f.querySelector('input[name="permission_mode"]:checked') || {}).value || '',
    allowed_tools_json: liste($('#agentAllowed').value),
    disallowed_tools_json: liste($('#agentDisallowed').value),
    max_turns: $('#agentMaxTurns').value ? Number($('#agentMaxTurns').value) : null,
    skills_json: skillsCochesDe('#agentSkills'),
    subagents_json: lireSubagentsJson(),
    output_kind: $('#agentOutputKind').value,
    output_ref: (($('#agentOutputRefBox') || {}).querySelector ? ($('#agentOutputRefBox').querySelector('.agentOutputRefVal') || {}).value : '') || null,
    schedule: lireHoraireForm(),
    runner: ($('#agentRunner') || {}).value || '',
    repos: $$('#agentRepos .ag-repo:checked').map((c) => ({
      repo_id: Number(c.value), branch: '', role: c.closest('label').querySelector('.ag-role').value,
    })),
  };
}

function skillsCochesDe(sel) {
  return $$(`${sel} [data-skill]:checked`).map((c) => {
    const s = skillsCache.items.find((x) => skillCle(x) === c.dataset.skill);
    return s ? { name: s.name, source: s.source, repo_id: s.repo_id } : null;
  }).filter(Boolean);
}

// Le JSON des sous-agents est validé À LA FRAPPE : une accolade oubliée doit se voir là,
// pas au moment où l'on comptait sur le profil.
function lireSubagentsJson() {
  const txt = $('#agentSubagents').value.trim();
  if (!txt) return {};
  try { const v = JSON.parse(txt); return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {}; }
  catch { return null; }
}

function majErreurSubagents() {
  const el = $('#agentSubagentsErr');
  if (!el) return;
  const v = lireSubagentsJson();
  el.hidden = v !== null;
  el.textContent = v === null ? tr('agents.err.subagents-json') : '';
  majOmbreSousAgents(v);
}

/* `--agents` PRIME sur `.claude/agents/<nom>.md` : un sous-agent du profil qui porte le nom
   d'un sous-agent de fichier le remplace, en silence. On le dit. */
function majOmbreSousAgents(defs) {
  const el = $('#agentSubagentShadow');
  if (!el) return;
  const noms = defs ? Object.keys(defs) : [];
  const fichiers = (skillsCache.items || []).filter((x) => x.kind === 'agent').map((x) => x.name);
  const collision = noms.filter((n) => fichiers.includes(n));
  el.hidden = !collision.length;
  el.textContent = collision.length ? tr('agents.warn.subagent-shadow', { list: collision.join(', ') }) : '';
}

function lireHoraireForm() {
  const k = $('#agentScheduleKind').value;
  if (!k) return '';
  const t = $('#agentScheduleTime').value || '07:00';
  if (k === 'daily') return `daily ${t}`;
  if (k === 'weekly') return `weekly ${$('#agentScheduleDow').value} ${t}`;
  return `monthly ${$('#agentScheduleDom').value} ${t}`;
}

const JOURS_SEM = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

function poserHoraireForm(texte) {
  const m = String(texte || '').trim().match(/^(daily|weekly|monthly)\s+(?:(\w+)\s+)?(\d{1,2}:\d{2})$/);
  $('#agentScheduleKind').value = m ? m[1] : '';
  $('#agentScheduleDow').innerHTML = JOURS_SEM.map((j) => `<option value="${j}">${esc(tr(`agents.schedule.dow.${j}`))}</option>`).join('');
  $('#agentScheduleDom').innerHTML = Array.from({ length: 28 }, (_, i) => `<option value="${i + 1}">${i + 1}</option>`).join('');
  if (m && m[1] === 'weekly') $('#agentScheduleDow').value = m[2];
  if (m && m[1] === 'monthly') $('#agentScheduleDom').value = m[2];
  $('#agentScheduleTime').value = m ? m[3] : '07:00';
  majHoraireForm();
}

/* L'EXÉCUTANT D'UN AGENT PLANIFIÉ. À plusieurs, trois instances allumées lanceraient trois fois
   le même agent — chacune persuadée d'être la seule, et l'équipe paierait trois fois. Le champ
   n'apparaît que si un dépôt de données est configuré : en mono-poste la question ne se pose
   pas, et un champ inutile est un champ qu'il faut comprendre pour l'ignorer. */
let moiCache = null;
/* Y A-T-IL UNE ÉQUIPE ? Lu une seule fois, et partagé par tous les écrans qui n'ont de sens
   qu'à plusieurs — l'exécutant d'un agent planifié, la case « partager » d'une page de notes.
   En mono-poste ils ne s'affichent pas du tout : découvrir une fonctionnalité qu'on n'a pas
   demandée coûte plus cher que de ne pas l'avoir. */
async function partageActif() {
  if (!moiCache) { try { moiCache = await api('/whoami'); } catch { moiCache = { partage: false, runners: [] }; } }
  /* Les cartes de session se redessinent toutes les secondes et demie : elles ne peuvent pas
     attendre une requête. On dépose donc ici ce qu'elles ont besoin de savoir — y a-t-il une
     équipe, et qui suis-je — pour que le rendu reste synchrone. */
  partageEtMoi = { partage: Boolean(moiCache.partage), name: moiCache.name || null };
  return Boolean(moiCache.partage);
}
/* L'EXÉCUTANT DES AUTOMATISMES, dans les réglages. Même chose que pour un agent planifié : la
   liste des exécutants connus plutôt qu'une saisie libre, et le champ caché en mono-poste où la
   question ne se pose pas. L'avertissement n'apparaît que si une politique est cochée sans
   personne pour la faire tourner — c'est le seul cas où rien ne se passerait en silence. */
/* La même sentinelle que le serveur (`AUTEUR_AUTO` dans `src/server.js`) : un poste ne peut pas
   porter ce nom, `git config user.name` ne commence pas par une arobase. */
const AUTEUR_AUTO = '@auteur';
/* LE BANDEAU DES RÉGLAGES D'AUTOMATISME EN ATTENTE. Ce qui a changé, valeur par valeur, et le
   bouton qui l'approuve pour CE poste — tant qu'il n'est pas cliqué, aucune review ni
   vérification automatique ne part d'ici. */
function poserApprobationAuto(c) {
  const box = $('#autoApprovalBanner');
  if (!box) return;
  const a = (c && c.auto_approval) || {};
  box.hidden = !a.pending;
  if (!a.pending) { box.innerHTML = ''; return; }
  const avant = a.before || {};
  const libelle = (k, v) => {
    if (k === 'auto_runner') return v === AUTEUR_AUTO ? tr('agents.runner.author') : (v || tr('agents.runner.nobody'));
    if (k === 'verif_auto_authors') return tr(`settings.opt.verif-auto-authors.${v === 'all' ? 'all' : 'mine'}`);
    return v === '1' ? tr('approval.config.on') : tr('approval.config.off');
  };
  /* TOUT ce qui est dans l'empreinte est MONTRÉ : un changement qui la fait basculer sans
     apparaître ici ferait approuver sans voir — « tous les auteurs » en premier. */
  const noms = {
    auto_review_new: tr('approval.config.review-new'), auto_rereview_stale: tr('approval.config.rereview-stale'),
    auto_runner: tr('settings.lbl.auto-runner'), verif_auto_authors: tr('settings.lbl.verif-auto-authors'),
  };
  const lignes = Object.keys(noms).map((k) => {
    const apres = String(c[k] == null ? '' : c[k]);
    const change = a.before && String(avant[k] == null ? '' : avant[k]) !== apres;
    return `${noms[k]} : ${change ? `${libelle(k, String(avant[k] || ''))} → ` : ''}${libelle(k, apres)}`;
  });
  box.innerHTML = blocApprobation({
    texte: tr('approval.config.text'),
    avant: null,
    apres: lignes,
    bouton: `<button type="button" class="btn btn-primary btn-sm" id="btnApproveAuto">${esc(tr('approval.btn'))}</button>`,
  });
  $('#btnApproveAuto').addEventListener('click', async (e) => {
    try {
      await busy(e.currentTarget, () => api('/config/approve-auto', { method: 'POST', body: { signature: a.signature } }));
      toast(tr('approval.done'));
      loadConfig();
    } catch (err) {
      toast(explainError(err.message), true);
      if (err.code === 'APPROBATION_PERIMEE') loadConfig();     // montrer ce qui a changé entre-temps
    }
  });
}

async function poserExecutantAuto(choisi) {
  const ligne = $('#autoRunnerRow');
  if (!ligne) return;
  ligne.hidden = !await partageActif();
  const avert = $('#autoRunnerNone');
  if (ligne.hidden) { if (avert) avert.hidden = true; return; }
  const sel = $('#autoRunnerSelect');
  /* « L'AUTEUR » N'EST PAS UNE MACHINE : la sentinelle ne doit pas se retrouver dans la liste
     des postes connus, où elle s'afficherait comme un nom de collègue. */
  const liste = [...new Set([...(moiCache.runners || []), choisi]
    .filter(Boolean).filter((n) => n !== AUTEUR_AUTO))].sort();
  sel.innerHTML = `<option value="">${esc(tr('agents.runner.nobody'))}</option>`
    /* CHACUN POUR SES MERGE REQUESTS. L'autre réponse raisonnable à « qui paie les appels ? » :
       l'abonnement de chacun sert son propre travail, et personne n'attend qu'un poste désigné
       soit allumé. */
    + `<option value="${esc(AUTEUR_AUTO)}"${choisi === AUTEUR_AUTO ? ' selected' : ''}>${esc(tr('agents.runner.author'))}</option>`
    + liste.map((n) => `<option value="${esc(n)}"${n === choisi ? ' selected' : ''}>`
      + `${esc(n === moiCache.name ? tr('agents.runner.me', { name: n }) : n)}</option>`).join('');
  sel.value = choisi || '';
  majAvertissementAuto();
}
function majAvertissementAuto() {
  const avert = $('#autoRunnerNone');
  const sel = $('#autoRunnerSelect');
  const f = $('#configForm');
  if (!avert || !sel || !f) return;
  const coche = ['auto_review_new', 'auto_rereview_stale'].some((n) => f[n] && f[n].checked);
  avert.hidden = !!sel.value || !coche || $('#autoRunnerRow').hidden;
}
document.addEventListener('change', (e) => {
  if (!e.target.closest) return;
  if (e.target.matches('#autoRunnerSelect, #configForm [name="auto_review_new"], #configForm [name="auto_rereview_stale"]')) {
    majAvertissementAuto();
  }
});

async function poserExecutantForm(choisi) {
  const ligne = $('#agentRunnerRow');
  if (!ligne) return;
  ligne.hidden = !await partageActif();
  $('#agentRunnerNone').hidden = true;
  if (!moiCache.partage) return;
  const liste = [...new Set([...(moiCache.runners || []), choisi].filter(Boolean))].sort();
  const sel = $('#agentRunner');
  sel.innerHTML = `<option value="">${esc(tr('agents.runner.nobody'))}</option>`
    + liste.map((n) => `<option value="${esc(n)}"${n === choisi ? ' selected' : ''}>`
      + `${esc(n === moiCache.name ? tr('agents.runner.me', { name: n }) : n)}</option>`).join('');
  sel.value = choisi || '';
  majExecutantForm();
}

function majExecutantForm() {
  const ligne = $('#agentRunnerRow');
  const note = $('#agentRunnerNone');
  if (!ligne || !note) return;
  /* Un agent PLANIFIÉ sans exécutant ne tournera nulle part : on le dit sous le champ, pas
     après coup. Sans horaire, la remarque n'a aucun sens — on se tait. */
  note.hidden = ligne.hidden || !$('#agentScheduleKind').value || Boolean($('#agentRunner').value);
}

function majHoraireForm() {
  const k = $('#agentScheduleKind').value;
  $('#agentScheduleDow').hidden = k !== 'weekly';
  $('#agentScheduleDom').hidden = k !== 'monthly';
  $('#agentScheduleTime').hidden = !k;
  const said = $('#agentScheduleSaid');
  if (said) said.textContent = k ? tr('agents.schedule.said', { spec: lireHoraireForm() }) : '';
  /* Un horaire sans borne de tours est refusé à la sauvegarde : on le dit AVANT, sous le
     champ, plutôt qu'en toast rouge après le clic. */
  const manque = $('#agentScheduleNeeds');
  if (manque) manque.hidden = !k || !!$('#agentMaxTurns').value;
  majExecutantForm();
}

async function ouvrirAgentModal(a) {
  agentEditId = a ? a.id : null;
  await loadRepoOptions();
  $('#agentModalTitle').textContent = a ? a.name : tr('agents.modal.new');
  $('#agentName').value = a ? a.name : '';
  $('#agentDesc').value = a ? a.description : '';
  $('#agentKind').value = a ? a.kind : 'explore';
  const scope = a ? a.scope_kind : 'all_repos';
  $$('#agentForm input[name="scope_kind"]').forEach((r) => { r.checked = r.value === scope; });
  $('#agentSystemPrompt').value = a ? a.system_prompt : '';
  $('#agentTemplate').value = a ? a.prompt_template : '{question}';
  $('#agentModel').value = a ? a.model : '';
  const perm = a ? a.permission_mode : '';
  $$('#agentPermission input[name="permission_mode"]').forEach((r) => { r.checked = r.value === perm; });
  $('#agentAllowed').value = a ? (jsonListe(a.allowed_tools_json) || []).join(', ') : '';
  $('#agentDisallowed').value = a ? (jsonListe(a.disallowed_tools_json) || []).join(', ') : '';
  $('#agentMaxTurns').value = a && a.max_turns ? a.max_turns : '';
  $('#agentSubagents').value = a && a.subagents_json && a.subagents_json !== '{}'
    ? JSON.stringify(JSON.parse(a.subagents_json), null, 2) : '';
  $('#agentOutputKind').value = a ? a.output_kind : 'report';
  $('#agentRepos').innerHTML = agentReposHtml(a ? a.repos : []);
  poserHoraireForm(a ? a.schedule : '');
  poserExecutantForm(a ? a.runner : '');
  majPerimetreVisible();
  majSortieVisible(a ? a.output_ref : null);
  await majSkillsAgent(a);
  majErreurSubagents();
  const warn = $('#agentCopilotWarn');
  if (warn) warn.hidden = !/copilot/i.test(copilotBinCourant);
  $('#agentFormErr').hidden = true;
  $('#agentModal').hidden = false;
  majApercuArgv();
  $('#agentName').focus();
}

const jsonListe = (txt) => { try { return JSON.parse(txt); } catch { return []; } };

function majPerimetreVisible() {
  const liste = ($('#agentForm').querySelector('input[name="scope_kind"]:checked') || {}).value === 'repos';
  const box = $('#agentReposBox');
  if (box) box.hidden = !liste;
}

function majSortieVisible(refCourant) {
  const est = $('#agentOutputKind').value === 'note_page';
  const row = $('#agentOutputRefRow');
  if (row) row.hidden = !est;
  const box = $('#agentOutputRefBox');
  if (est && box && !box.dataset.rendu) {
    box.dataset.rendu = '1';
    box.innerHTML = comboHtml('agentOutputRefVal', { ph: tr('agents.f.output-ref-ph') });
    wireCombo(box, 'agentOutputRefVal', async () => {
      // La route enveloppe la liste : `{ pages }`.
      const d = await api('/notes').catch(() => ({}));
      const pages = (d && d.pages) || [];
      return [{ value: '', label: tr('agents.f.output-ref-new') },
        ...pages.map((p) => ({ value: String(p.id), label: p.title }))];
    });
  }
  if (est && box && refCourant) {
    const h = box.querySelector('.agentOutputRefVal');
    if (h) h.value = String(refCourant);
  }
}

async function majSkillsAgent(a) {
  const box = $('#agentSkills');
  if (!box) return;
  const d = await chargerSkills([]);
  const choisis = new Set((a ? jsonListe(a.skills_json) : []).map((s) => `${s.source}|${s.repo_id || ''}|${s.name}`));
  const sauve = taskSkillsCoches;
  taskSkillsCoches = choisis;
  box.innerHTML = (d.items.filter((x) => x.kind === 'skill').map(skillCaseHtml).join('')
    || `<div class="muted">${esc(tr('agents.task.no-skill'))}</div>`)
    + `<div class="muted" data-no-match hidden>${esc(tr('agents.skills.no-match'))}</div>`;
  taskSkillsCoches = sauve;
  filtrerLignes($('#agentSkillFilter'), box);
}

/* L'aperçu vient TOUJOURS du serveur : c'est lui qui fabrique l'argv, et un aperçu calculé
   côté client finirait par mentir le jour où les deux divergent. */
const majApercuArgv = debounce(async () => {
  const el = $('#agentArgvPreview');
  if (!el || $('#agentModal').hidden) return;
  try {
    const corps = { ...lireAgentForm(), id: agentEditId };
    const r = await api('/agents/preview', { method: 'POST', body: corps });
    el.textContent = r.argv || tr('agents.preview.none');
    const err = $('#agentFormErr');
    err.hidden = !r.errors.length;
    err.textContent = r.errors.map((k) => tr(k)).join(' ');
  } catch { el.textContent = ''; }
}, 300);

