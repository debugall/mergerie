'use strict';
/* Onglet Agents, les profils : cartes, ce qu'un agent a fait, le coût, la connaissance. */
// @expose agentDe, agents, chargerAgents, fmtCout, loadAgentList, loadAgents, showAgentsSub
/* ---------- Onglet Agents ---------- */

/* Les deux sous-onglets. Une FONCTION plutôt qu'un objet de premier niveau, pour la même
   raison que `onEl` : le clic peut arriver avant que la ligne d'un `const` ait été évaluée. */
function chargerSousOngletAgents(sub) {
  if (sub === 'skills') return loadSkillsPanel();
  return loadAgentList();
}
function showAgentsSub(sub) {
  if (!sub) { try { sub = localStorage.getItem('mergerie_agents_sub') || 'list'; } catch { sub = 'list'; } }
  if (!['list', 'skills'].includes(sub)) sub = 'list';
  $$('#tab-agents .subnav [data-sub]').forEach((b) => b.classList.toggle('active', b.dataset.sub === sub));
  $$('#tab-agents .subtab').forEach((p) => p.classList.toggle('active', p.id === `sub-agents-${sub}`));
  try { localStorage.setItem('mergerie_agents_sub', sub); } catch { /* ignore */ }
  try { chargerSousOngletAgents(sub); } catch { /* chargement best-effort */ }
}

function loadAgents() { showAgentsSub(); }

$$('#tab-agents .subnav [data-sub]').forEach((b) => b.addEventListener('click', () => showAgentsSub(b.dataset.sub)));
onEl($('#skillFilter'), 'input', () => filtrerLignes($('#skillFilter'), $('#skillList')));
onEl($('#taskSkillFilter'), 'input', () => filtrerLignes($('#taskSkillFilter'), $('#taskSkills')));
onEl($('#taskSubagentFilter'), 'input', () => filtrerLignes($('#taskSubagentFilter'), $('#taskSubagents')));
onEl($('#btnSkillRescan'), 'click', (e) => busy(e.currentTarget, async () => {
  await api('/skills/rescan', { method: 'POST' });
  skillsCache = { cle: null, items: [], uncloned: [] };
  await loadSkillsPanel();
  toast(tr('agents.skills.rescanned'));
}));
document.addEventListener('change', (e) => {
  const c = e.target.closest && e.target.closest('[data-skill]');
  if (!c) return;
  if (c.checked) taskSkillsCoches.add(c.dataset.skill); else taskSkillsCoches.delete(c.dataset.skill);
});


/* ==================== AGENTS — les profils ====================
   Un agent Mergerie est un profil de session. Cet écran fait trois gestes et rien d'autre :
   le lister, le modifier, et le LANCER — « Demander » ouvre la modale de session déjà remplie
   plutôt que de partir tout seul, parce qu'un agent qui se met à travailler sans qu'on ait vu
   sur quels dépôts est exactement ce que la règle « un agent ne devine jamais un dépôt »
   interdit. */

let agents = [];
let agentEditId = null;
let agentFiltreDepot = '';

const agentDe = (id) => agents.find((a) => a.id === Number(id));

async function chargerAgents() {
  try { agents = await api('/agents'); } catch { agents = []; }
  return agents;
}

function agentPerimetre(a) {
  if (a.scope_kind === 'all_repos') return tr('agents.card.scope-all');
  return tr('agents.card.scope-n', { n: a.repos.length, count: a.repos.length });
}

/* CE QU'UN AGENT A FAIT, ET QUAND IL REPASSE. La carte disait « terminée · 4 runs » : ni la
   DATE du dernier — trois minutes ou trois semaines ? —, ni le moyen d'y aller, ni le prochain
   créneau d'un agent planifié. Un documentaliste qui tourne à 7:00 était donc invisible entre
   deux passages : rien ne disait qu'il vivait encore. Les trois données sont servies. */
function agentStatutHtml(a) {
  if (!a.last_run) {
    return `<span class="muted">${esc(tr('agents.card.never-run'))}</span>${prochainRunHtml(a)}`;
  }
  /* CE QUE LE DERNIER RUN A BRASSÉ. Un montant en dollars ne vaut que sur le backend qui
     l'annonce et ne se compare pas d'un mois à l'autre ; les tokens sont mesurés partout et
     répondent à la seule question qu'on se pose ici — cet agent lit-il trop à chaque passage ? */
  const cout = a.last_run.tokens ? ` · ${tr('agents.card.tokens', { n: fmtMilliers(a.last_run.tokens) })}` : '';
  const quand = a.last_run.finished_at
    ? `<span class="muted" data-when="${esc(a.last_run.finished_at)}"> · ${esc(depuis(a.last_run.finished_at))}</span>` : '';
  /* Le dernier run MÈNE à sa session : c'est ce qu'on veut lire quand on voit « en erreur ». */
  const lien = `<button type="button" class="badge-statut st-${esc(a.last_run.status)}" data-go-session="${a.last_run.task_id}"
    data-go-kind="${esc(a.kind === 'code' ? 'code' : 'explore')}" title="${esc(tr('agents.card.last-run-title'))}">${esc(tr(`task.status.${a.last_run.status}`))}</button>`;
  return lien
    + `<span class="muted">${esc(tr('agents.card.runs', { n: a.run_count, count: a.run_count }))}${esc(cout)}</span>`
    + quand + prochainRunHtml(a);
}

// Le prochain créneau d'un agent planifié : la date, relative, avec l'exacte au survol.
function prochainRunHtml(a) {
  if (!a || !a.next_run) return '';
  return `<span class="tag" data-when="${esc(a.next_run)}" title="${esc(tr('agents.card.next-run-title', { when: fmtDateTime(a.next_run) }))}">`
    + `${svgIco('clock')} ${esc(tr('agents.card.next-run', { when: depuis(a.next_run) }))}</span>`;
}

/* Le coût : quelques centimes ou quelques euros, jamais douze décimales. Déclarée `function`
   et non `const` : elle sert AUSSI au tableau de bord, écrit douze mille lignes plus haut. */
function fmtCout(v) { return v == null ? '' : `$${Number(v) < 1 ? Number(v).toFixed(3) : Number(v).toFixed(2)}`; }

function agentKnowledgeHtml(a) {
  if (!a.is_domain) return '';
  const k = a.knowledge;
  const bouts = [];
  if (k && k.version) bouts.push(`<span class="badge k-active">v${k.version}</span>`);
  if (k && k.unverified) bouts.push(`<span class="badge k-warn">${esc(tr('agents.card.unverified', { n: k.unverified, count: k.unverified }))}</span>`);
  if (k && k.gaps) bouts.push(`<span class="badge k-warn">${esc(tr('agents.card.gaps', { n: k.gaps, count: k.gaps }))}</span>`);
  if (k && k.pending_version) bouts.push(`<span class="badge k-pending">${esc(tr('agents.card.pending', { version: k.pending_version }))}</span>`);
  /* CE QUE LA CARTE COÛTE À LIRE. Elle est recopiée dans le prompt de CHAQUE run de l'agent :
     sa taille est une dépense qui revient à chaque fois, et le seul chiffre qui dise s'il
     faut l'élaguer. Le détail par version se lit dans la fenêtre « Connaissance ». */
  if (k && k.tokens) {
    bouts.push(`<span class="badge" data-tip="${esc(tr('agents.card.knowledge-tokens-tip'))}">${esc(tr('agents.card.tokens', { n: fmtMilliers(k.tokens) }))}</span>`);
  }
  /* L'ÂGE est chargé à part : il fait un fetch par dépôt, et la liste se recharge à chaque
     passage sur l'onglet. Un point d'attente ici, le chiffre quand il arrive.
     C'est un BOUTON : « 12 commits depuis la carte » ne dit pas lesquels, et on relisait la
     carte sans savoir si douze typos ou une refonte l'avaient périmée. */
  bouts.push(`<button type="button" class="agent-age" data-agent-age="${a.id}" disabled>${esc(tr('agents.card.age-loading'))}</button>`);
  return `<div class="agent-knowledge">${bouts.join(' ')}</div>`;
}

function agentCardHtml(a) {
  const peutCoder = a.kind === 'code' || a.is_domain;
  return `<div class="card agent-card" data-id="${a.id}" data-cherche="${esc(`${a.name} ${a.description} ${a.repos.map((r) => r.project).join(' ')}`.toLowerCase())}">
    <div class="agent-head">
      <strong>${esc(a.name)}</strong>
      ${a.builtin_key ? `<span class="badge">${esc(tr('agents.card.builtin'))}</span>` : ''}
      ${a.is_domain ? `<span class="badge">${esc(tr('agents.card.domain'))}</span>` : ''}
      <span class="muted">${esc(agentPerimetre(a))}</span>
      ${a.schedule ? `<span class="badge">${esc(a.schedule_said || a.schedule)}</span>` : ''}
      <span class="spacer"></span>
      ${agentStatutHtml(a)}
    </div>
    ${a.description ? `<div class="muted agent-desc">${esc(a.description)}</div>` : ''}
    ${a.approval_pending ? blocApprobation({
    texte: tr(a.approved_before ? 'approval.agent.changed' : 'approval.agent.new'),
    avant: a.approved_before ? resumeApprobationAgent(a.approved_before) : null,
    apres: resumeApprobationAgent({
      kind: a.kind, model: a.model, permission_mode: a.permission_mode,
      allowed_tools: a.allowed_tools_json, disallowed_tools: a.disallowed_tools_json,
      max_turns: a.max_turns, schedule: a.schedule, runner: a.runner,
      skills: a.skills_json, subagents: a.subagents_json,
    }),
    bouton: `<button type="button" class="btn btn-primary btn-sm btn-agent-approve" data-id="${a.id}">${esc(tr('approval.btn'))}</button>`,
  }) : ''}
    ${agentKnowledgeHtml(a)}
    ${/* CHAQUE BOUTON DIT CE QU'IL FAIT. « Demander », « Coder », « Mettre à jour » se
          ressemblent assez pour qu'on hésite, et deux d'entre eux lancent une session qui
          coûte : l'explication au survol est moins chère qu'un run lancé pour voir. */''}
    <div class="agent-actions">
      <button class="btn btn-sm btn-primary btn-agent-ask" data-id="${a.id}" data-tip="${esc(tr('agents.tip.ask'))}"><svg class="ico ico-sm"><use href="#i-search"/></svg>${esc(tr('agents.btn.ask'))}</button>
      ${peutCoder ? `<button class="btn btn-sm btn-agent-code" data-id="${a.id}" data-tip="${esc(tr('agents.tip.code'))}"><svg class="ico ico-sm"><use href="#i-bot"/></svg>${esc(tr('agents.btn.code'))}</button>` : ''}
      ${a.is_domain ? `<button class="btn btn-sm btn-agent-knowledge" data-id="${a.id}" data-tip="${esc(tr('agents.tip.knowledge'))}"><svg class="ico ico-sm"><use href="#i-doc"/></svg>${esc(tr('agents.btn.knowledge'))}</button>` : ''}
      ${a.is_domain ? `<button class="btn btn-sm btn-agent-refresh" data-id="${a.id}" data-tip="${esc(tr('agents.tip.refresh'))}"><svg class="ico ico-sm"><use href="#i-refresh"/></svg>${esc(tr('agents.btn.refresh'))}</button>` : ''}
      ${(a.knowledge && a.knowledge.pending_version) ? `<button class="btn btn-sm btn-agent-review" data-id="${a.id}" data-tip="${esc(tr('agents.tip.review'))}"><svg class="ico ico-sm"><use href="#i-check"/></svg>${esc(tr('agents.btn.review'))}</button>` : ''}
      <span class="spacer"></span>
      <button class="btn btn-sm btn-agent-runs" data-id="${a.id}" data-tip="${esc(tr('agents.tip.runs'))}">${esc(tr('agents.btn.runs'))}</button>
      <button class="btn btn-sm btn-agent-edit" data-id="${a.id}" data-tip="${esc(tr('agents.tip.edit'))}"><svg class="ico ico-sm"><use href="#i-edit"/></svg>${esc(tr('ui.edit'))}</button>
      <button class="btn btn-sm btn-agent-dup" data-id="${a.id}" data-tip="${esc(tr('agents.tip.duplicate'))}">${esc(tr('agents.btn.duplicate'))}</button>
      ${a.builtin_key ? `<button class="btn btn-sm btn-agent-restore" data-id="${a.id}" data-tip="${esc(tr('agents.tip.restore'))}">${esc(tr('agents.btn.restore'))}</button>` : ''}
      <button class="btn btn-sm btn-danger btn-agent-del" data-id="${a.id}" aria-label="${esc(tr('ui.delete'))}" data-tip="${esc(tr('agents.tip.delete'))}"><svg class="ico ico-sm"><use href="#i-trash"/></svg></button>
    </div>
  </div>`;
}

/* Ce qui compte pour approuver un agent, en lignes lisibles : c'est CE QUI CHANGE qu'on doit
   voir d'un coup d'œil — une permission élargie, un outil ajouté, un horaire posé. */
function resumeApprobationAgent(x) {
  const o = x || {};
  const outils = (brut) => { try { const l = JSON.parse(brut || '[]'); return Array.isArray(l) ? l.join(', ') : ''; } catch { return String(brut || ''); } };
  /* Les sous-agents portent leurs PROPRES outils et modèle : un sous-agent élargi est un agent
     élargi. Nom, puis ce qu'il peut faire. */
  const sousAgents = (brut) => {
    try {
      const o2 = JSON.parse(brut || '{}');
      if (!o2 || typeof o2 !== 'object') return '';
      return Object.entries(o2).map(([nom, d]) => {
        const t2 = d && d.tools ? (Array.isArray(d.tools) ? d.tools.join(', ') : String(d.tools)) : '';
        return `${nom}${t2 ? ` (${t2})` : ''}${d && d.model ? ` [${d.model}]` : ''}`;
      }).join(' ; ');
    } catch { return String(brut || ''); }
  };
  return [
    `${tr('approval.agent.kind')} : ${o.kind || '—'}`,
    `${tr('approval.agent.permission')} : ${o.permission_mode || '—'}`,
    `${tr('approval.agent.allowed')} : ${outils(o.allowed_tools) || '—'}`,
    `${tr('approval.agent.disallowed')} : ${outils(o.disallowed_tools) || '—'}`,
    `${tr('approval.agent.model')} : ${o.model || '—'}`,
    `${tr('approval.agent.max-turns')} : ${o.max_turns == null ? '—' : o.max_turns}`,
    `${tr('approval.agent.schedule')} : ${o.schedule || '—'}`,
    `${tr('approval.agent.runner')} : ${o.runner || '—'}`,
    `${tr('approval.agent.skills')} : ${outils(o.skills) || '—'}`,
    `${tr('approval.agent.subagents')} : ${sousAgents(o.subagents) || '—'}`,
  ];
}

async function loadAgentList() {
  const box = $('#agentList');
  if (!box) return;
  box.innerHTML = skeleton(3);
  await Promise.all([chargerAgents(), loadRepoOptions()]);
  const warn = $('#agentListCopilotWarn');
  if (warn) warn.hidden = !/copilot/i.test(copilotBinCourant);
  if (!agents.length) {
    box.innerHTML = emptyState({
      icon: 'zap', title: esc(tr('agents.empty')), text: esc(tr('agents.empty-hint')),
      actions: [{ act: 'new-domain', label: esc(tr('agents.btn.new-domain')), primary: true }],
    });
    return;
  }
  box.innerHTML = agents.map(agentCardHtml).join('')
    + `<div class="muted" data-no-match hidden>${esc(tr('agents.no-match'))}</div>`;
  rendreComboDepotAgents();
  filtrerAgents();
  chargerAges();
}

// Le filtre : texte ET dépôt, tous deux en MASQUANT — jamais en retirant du DOM.
function filtrerAgents() {
  const q = (($('#agentFilter') || {}).value || '').trim().toLowerCase();
  let visibles = 0;
  $$('#agentList .agent-card').forEach((el) => {
    const a = agentDe(el.dataset.id) || { repos: [], scope_kind: 'all_repos' };
    const okTexte = !q || el.dataset.cherche.includes(q);
    const okDepot = !agentFiltreDepot || a.scope_kind === 'all_repos'
      || a.repos.some((r) => String(r.repo_id) === String(agentFiltreDepot));
    el.hidden = !(okTexte && okDepot);
    if (!el.hidden) visibles += 1;
  });
  const vide = $('#agentList [data-no-match]');
  if (vide) vide.hidden = visibles > 0;
}

function rendreComboDepotAgents() {
  const box = $('#agentRepoFilterBox');
  if (!box || box.dataset.rendu) return;
  box.dataset.rendu = '1';
  box.innerHTML = comboHtml('agentRepoFilterVal', { ph: tr('agents.filter.repo-ph') });
  wireCombo(box, 'agentRepoFilterVal', async () => [
    { value: '', label: tr('agents.filter.repo-all') },
    ...repoOptions.map((r) => ({ value: String(r.id), label: r.project })),
  ]);
  box.addEventListener('change', (e) => {
    if (!e.target.classList.contains('agentRepoFilterVal')) return;
    agentFiltreDepot = e.target.value;
    filtrerAgents();
  });
}

/* L'ÂGE d'une connaissance : combien de commits ont touché ses chemins depuis qu'elle a été
   écrite. Calculé sans IA — c'est un `git log` — mais il fait un fetch, d'où la route à part. */
/* Le détail par agent, tel qu'il a été chargé : la fenêtre l'ouvre SANS redemander au serveur.
   Un second appel relancerait un `git fetch` par dépôt, et pourrait afficher un compte
   différent de celui du badge qu'on vient de cliquer. */
const agesCharges = new Map();

async function chargerAges() {
  for (const el of $$('#agentList [data-agent-age]')) {
    const id = Number(el.dataset.agentAge);
    try {
      const lignes = await api(`/agents/${id}/age`);
      agesCharges.set(id, lignes);
      const total = lignes.reduce((n, x) => n + (x.commits || 0), 0);
      el.textContent = total
        ? tr('agents.card.age', { n: total, count: total })
        : tr('agents.card.age-fresh');
      el.classList.toggle('agent-age-stale', total > 0);
      // Rien derrière un badge « carte à jour » : le bouton n'est une porte que s'il mène quelque part.
      el.disabled = !total;
      el.dataset.tip = tr(total ? 'agents.card.age-tip' : 'agents.card.age-fresh-tip');
    } catch { el.textContent = ''; el.disabled = true; }
  }
}

/* LES COMMITS QUI ONT VIEILLI LA CARTE, par dépôt : sha, date, auteur, message. La liste est
   plafonnée côté serveur — le COMPTE du badge, lui, reste exact, et la fenêtre le dit quand
   elle n'a pas tout. */
function ouvrirAgeModal(agentId) {
  const a = agentDe(agentId);
  const lignes = agesCharges.get(Number(agentId)) || [];
  $('#ageTitle').textContent = `${(a && a.name) || ''} — ${tr('agents.age.title')}`;
  const blocs = lignes.filter((x) => (x.list || []).length).map((x) => {
    const reste = (x.commits || 0) - x.list.length;
    return `<div class="age-repo">
      <h4>${esc(x.project)} <span class="muted">${esc(tr('agents.card.age', { n: x.commits, count: x.commits }))}</span></h4>
      <div class="md-tablewrap"><table class="md-table">
        <thead><tr><th>${esc(tr('agents.age.col-sha'))}</th><th>${esc(tr('agents.age.col-date'))}</th>
          <th>${esc(tr('agents.age.col-author'))}</th><th>${esc(tr('agents.age.col-subject'))}</th></tr></thead>
        <tbody>${x.list.map((c) => `<tr>
        ${/* Le sha court se lit ; le complet est ce qu'on va coller dans un `git show`. */''}
        <td><code class="age-sha" data-tip="${esc(c.sha || '')}">${esc(String(c.sha || '').slice(0, 8))}</code></td>
        <td data-when="${esc(c.at || '')}">${esc(c.at ? fmtDate(c.at) : '')}</td>
        <td>${esc(c.author || '')}</td>
        <td>${esc(c.subject || '')}</td></tr>`).join('')}</tbody></table></div>
      ${reste > 0 ? `<p class="muted">${esc(tr('agents.age.more', { n: reste, count: reste }))}</p>` : ''}
    </div>`;
  }).join('');
  $('#ageBody').innerHTML = blocs || `<p class="muted">${esc(tr('agents.age.empty'))}</p>`;
  /* La bulle du badge reste ouverte jusqu'au prochain mouvement de souris : sans ça elle
     flotte par-dessus la fenêtre qu'elle vient d'ouvrir, et masque ses deux premières lignes. */
  hideTip();
  $('#ageModal').hidden = false;
}

document.addEventListener('click', (e) => {
  const b = e.target.closest && e.target.closest('#agentList [data-agent-age]');
  if (b && !b.disabled) ouvrirAgeModal(Number(b.dataset.agentAge));
});
onEl($('#ageClose'), 'click', () => { $('#ageModal').hidden = true; });

