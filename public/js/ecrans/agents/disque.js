'use strict';
/* Agents — le disque : skills et sous-agents, le sous-onglet, ce que la modale de session emporte. */
// @expose majSkillsSession, skillsCache, skillsChoisis, taskSkillsCoches
/* ==================== AGENTS — le disque : skills et sous-agents ====================
   Un skill est un DOSSIER (`<nom>/SKILL.md`), un sous-agent de fichier un `.claude/agents/
   <nom>.md`. Aucun des deux n'est en base : la vérité est le disque, et Mergerie ne fait que
   la lire. Deux endroits s'en servent — le sous-onglet « Skills & sous-agents », qui montre
   tout, et la modale de session, qui laisse cocher ce que CETTE session emporte. */

let skillsCache = { cle: null, items: [], uncloned: [] };

async function chargerSkills(repoIds) {
  const cle = (repoIds || []).slice().sort((a, b) => a - b).join(',');
  if (skillsCache.cle === cle) return skillsCache;
  const q = cle ? `?repos=${encodeURIComponent(cle)}` : '';
  try {
    const d = await api(`/skills${q}`);
    skillsCache = { cle, items: d.items || [], uncloned: d.uncloned || [] };
  } catch { skillsCache = { cle, items: [], uncloned: [] }; }
  return skillsCache;
}

const skillCle = (s) => `${s.source}|${s.repo_id || ''}|${s.name}`;
const skillCherche = (s) => `${s.name} ${s.description} ${s.project || ''} ${s.path}`.toLowerCase();

/* ---------- Sous-onglet « Skills & sous-agents » ---------- */

function skillLigneHtml(s) {
  const badges = [
    !s.userInvocable ? `<span class="badge">${esc(tr('agents.skills.not-user'))}</span>` : '',
    !s.modelInvocable ? `<span class="badge">${esc(tr('agents.skills.not-model'))}</span>` : '',
    (s.tools || []).length ? `<span class="muted">${esc(s.tools.join(', '))}</span>` : '',
  ].join(' ');
  return `<div class="skill-row" data-cherche="${esc(skillCherche(s))}">
    <div class="skill-head">
      <svg class="ico ico-sm"><use href="#i-${s.kind === 'agent' ? 'bot' : 'star'}"/></svg>
      <strong>${esc(s.name)}</strong>
      <span class="badge">${esc(tr(s.kind === 'agent' ? 'agents.skills.kind-agent' : 'agents.skills.kind-skill'))}</span>
      ${badges}
    </div>
    ${s.description ? `<div class="muted skill-desc">${esc(s.description)}</div>` : ''}
    <code class="skill-path">${esc(s.path)}</code>
  </div>`;
}

async function loadSkillsPanel() {
  const box = $('#skillList');
  if (!box) return;
  box.innerHTML = `<div class="muted">${esc(tr('ui.combo.loading'))}</div>`;
  skillsCache = { cle: null, items: [], uncloned: [] };  // le panneau montre TOUT : cache neuf
  const d = await chargerSkills([]);
  const parSource = [
    { titre: tr('agents.skills.source-repo'), items: d.items.filter((x) => x.source === 'repo') },
    { titre: tr('agents.skills.source-user'), items: d.items.filter((x) => x.source === 'user') },
  ];
  const groupes = parSource.filter((g) => g.items.length).map((g) => `<div class="skill-group">
      <h3>${esc(g.titre)}</h3>${g.items.map(skillLigneHtml).join('')}</div>`).join('');
  /* UN DÉPÔT NON CLONÉ N'EST PAS UNE ERREUR — mais son silence en serait une : sans cette
     ligne, ses skills manquent à la liste et rien ne dit pourquoi. */
  const nonClones = d.uncloned.length
    ? `<p class="field-note">${esc(tr('agents.skills.uncloned', { list: d.uncloned.join(', ') }))}</p>` : '';
  box.innerHTML = (groupes || emptyState({ icon: 'star', title: esc(tr('agents.skills.empty')), text: esc(tr('agents.skills.empty-hint')) }))
    + `<div class="muted" data-no-match hidden>${esc(tr('agents.skills.no-match'))}</div>` + nonClones;
  filtrerLignes($('#skillFilter'), box);
}

/* ---------- Modale de session : ce que CETTE session emporte ---------- */

// Cochés par l'utilisateur, conservés d'un rechargement de liste à l'autre (changer de
// dépôt ne doit pas décocher un skill du home, qui n'a pas bougé).
let taskSkillsCoches = new Set();

function skillCaseHtml(s) {
  const c = skillCle(s);
  const ou = s.source === 'user' ? tr('agents.skills.source-user') : (s.project || '');
  return `<label class="inline-check" data-cherche="${esc(skillCherche(s))}">
    <input type="checkbox" data-skill="${esc(c)}"${taskSkillsCoches.has(c) ? ' checked' : ''} />
    <span><strong>${esc(s.name)}</strong>${ou ? ` <span class="muted">${esc(ou)}</span>` : ''}${s.description ? `<br><span class="muted">${esc(s.description.slice(0, 120))}</span>` : ''}</span>
  </label>`;
}

async function majSkillsSession() {
  const boxS = $('#taskSkills'); const boxA = $('#taskSubagents');
  if (!boxS || !boxA) return;
  const repos = readTargetRows().map((t) => t.repo_id).filter(Boolean);
  const d = await chargerSkills(repos);
  const skills = d.items.filter((x) => x.kind === 'skill');
  const sousAgents = d.items.filter((x) => x.kind === 'agent');
  boxS.innerHTML = (skills.map(skillCaseHtml).join('') || `<div class="muted">${esc(tr('agents.task.no-skill'))}</div>`)
    + `<div class="muted" data-no-match hidden>${esc(tr('agents.skills.no-match'))}</div>`;
  boxA.innerHTML = (sousAgents.map(skillCaseHtml).join('') || `<div class="muted">${esc(tr('agents.task.no-subagent'))}</div>`)
    + `<div class="muted" data-no-match hidden>${esc(tr('agents.skills.no-match'))}</div>`;
  filtrerLignes($('#taskSkillFilter'), boxS);
  filtrerLignes($('#taskSubagentFilter'), boxA);
}

// Ce qui part dans le corps de POST /api/tasks : le serveur en fait la première ligne du prompt.
function skillsChoisis() {
  const out = [];
  for (const c of taskSkillsCoches) {
    const s = skillsCache.items.find((x) => skillCle(x) === c);
    if (s) out.push({ name: s.name, source: s.source, repo_id: s.repo_id, kind: s.kind });
  }
  return out;
}

