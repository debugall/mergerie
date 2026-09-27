'use strict';
/* Agents — lancer, choisir un agent dans la modale, le filtre par agent, l'enquêteur (B9), câblages. */
// @expose agentChoisiDansModale, detecterTrace, enqueterSurTexte, essaiAgent, lancerAgentDepuisPalette, ouvrirSessionsAgent, poserAgentRelu, poserFiltreAgent, rendreComboAgentSession, rendreComboFiltreAgent
/* ---------- Lancer ---------- */

async function agentDemander(a) {
  await openTaskModal('explore');
  appliquerAgent(a);
  $('#taskPrompt').placeholder = tr('agents.ask.placeholder');
  $('#taskPrompt').focus();
}

async function agentCoder(a) {
  const r = await api(`/agents/${a.id}/run`, { method: 'POST', body: { mode: 'code' } });
  const p = r.prefill;
  await openTaskModal('code');
  appliquerAgent(a);
  renderTargetRows(p.targets.map((x) => ({ repo_id: x.repo_id, branch: x.branch || '' })));
  $('#taskPrompt').value = p.prompt;
  await majVerificateursSession('');
  $('#taskPrompt').focus();
}

/* Choisir un agent dans la modale : on POSE ce qu'il implique (type, cibles, cases) et on
   n'efface rien de ce qui a été tapé. Le désélectionner ne défait rien non plus — ce qui est
   écrit appartient à qui l'a écrit. */
function appliquerAgent(a) {
  const box = $('#taskAgentBox');
  const h = box && box.querySelector('.taskAgentVal');
  if (h) { h.value = String(a.id); h.dataset.label = a.name; }
  const champ = box && box.querySelector('[data-combo="taskAgentVal"]');
  if (champ) { champ.value = a.name; champ.title = a.name; }
  if (!a.id) return;
  const d = (() => { try { return JSON.parse(a.defaults_json || '{}'); } catch { return {}; } })();
  const f = $('#taskForm');
  if (f.ask_questions) f.ask_questions.checked = !!d.ask_questions;
  if (f.notify_jira) f.notify_jira.checked = !!d.notify_jira;
  if (taskKind !== 'code') {
    const cibles = ciblesEcranDe(a);
    /* Aucun dépôt à poser : on ne touche pas aux lignes en place. Un agent sans périmètre ne
       doit pas effacer ce que l'écran montrait déjà. */
    if (cibles.length) { renderTargetRows(cibles); majSkillsSession(); }
  }
}

/* LES DÉPÔTS D'UN AGENT, TELS QUE LA MODALE DOIT LES MONTRER. « Tous les dépôts actifs »
   n'était traduit en lignes nulle part : le cartographe s'ouvrait sur une ligne vide, alors
   qu'un run déclenché par l'horloge part, lui, sur tout le périmètre — l'écran démentait ce
   qui allait partir, et il fallait re-choisir à la main ce qui était déjà choisi. Même ordre
   que le serveur (par projet) : la liste qu'on lit est celle qui partira. */
function ciblesEcranDe(a) {
  if (a.scope_kind === 'all_repos') {
    return repoOptions.filter((r) => r.enabled)
      .slice().sort((x, y) => String(x.project).localeCompare(String(y.project)))
      .map((r) => ({ repo_id: r.id, branch: '' }));
  }
  return (a.repos || []).map((r) => ({ repo_id: r.repo_id, branch: r.branch || '' }));
}

function rendreComboAgentSession() {
  const box = $('#taskAgentBox');
  if (!box || box.dataset.rendu) return;
  box.dataset.rendu = '1';
  box.innerHTML = comboHtml('taskAgentVal', { ph: tr('agents.task.agent-ph') });
  wireCombo(box, 'taskAgentVal', async () => {
    if (!agents.length) await chargerAgents();
    return [{ value: '', label: tr('agents.task.agent-none') },
      ...agents.map((a) => ({ value: String(a.id), label: a.name, hint: agentPerimetre(a) }))];
  });
  box.addEventListener('change', (e) => {
    if (!e.target.classList.contains('taskAgentVal')) return;
    const a = agentDe(e.target.value);
    if (a) appliquerAgent(a);
  });
}

function poserAgentRelu(t) {
  const box = $('#taskAgentBox');
  if (!box) return;
  rendreComboAgentSession();
  const h = box.querySelector('.taskAgentVal');
  const champ = box.querySelector('[data-combo="taskAgentVal"]');
  const nom = t.agent_name || '';
  if (h) { h.value = t.agent_id ? String(t.agent_id) : ''; h.dataset.label = nom; }
  if (champ) {
    champ.value = nom;
    champ.title = nom;
    // Agent supprimé : le nom reste lisible, mais on ne peut plus le choisir de nouveau.
    champ.disabled = !!(nom && !t.agent_id);
  }
}

/* Le filtre par agent de la liste Dev IA. Rendu une fois : la liste, elle, se redessine
   toutes les secondes et demie, et recréer le combo à chaque fois emporterait la saisie. */
function rendreComboFiltreAgent() {
  const box = $('#taskAgentFilterBox');
  if (!box || box.dataset.rendu) return;
  box.dataset.rendu = '1';
  box.innerHTML = comboHtml('taskAgentFilterVal', { ph: tr('agents.filter.agent-ph') });
  wireCombo(box, 'taskAgentFilterVal', async () => {
    if (!agents.length) await chargerAgents();
    return [{ value: '', label: tr('agents.filter.agent-all') },
      ...agents.map((a) => ({ value: String(a.id), label: a.name }))];
  });
  box.addEventListener('change', (e) => {
    if (!e.target.classList.contains('taskAgentFilterVal')) return;
    agentFiltreSessions = Number(e.target.value) || 0;
    renderTasks();
  });
}

/* POSER LE FILTRE, ET LE MONTRER. « Ses sessions » ne posait que la variable : la liste
   arrivait filtrée sans que rien, à l'écran, ne dise pourquoi — on cherchait les sessions
   manquantes avant de comprendre. Le combo porte donc la valeur, ce qui la rend aussi
   ENLEVABLE : c'est par lui qu'on revient à toutes les sessions. */
function poserFiltreAgent(id) {
  agentFiltreSessions = Number(id) || 0;
  const box = $('#taskAgentFilterBox');
  if (!box) return;
  rendreComboFiltreAgent();
  const h = box.querySelector('.taskAgentFilterVal');
  const champ = box.querySelector('[data-combo="taskAgentFilterVal"]');
  const nom = (agents.find((a) => Number(a.id) === agentFiltreSessions) || {}).name || '';
  if (h) { h.value = agentFiltreSessions ? String(agentFiltreSessions) : ''; h.dataset.label = nom; }
  if (champ) { champ.value = nom; champ.title = nom; }
}

/* UNE TRACE D'ERREUR, reconnue au motif. Ce n'est pas une analyse : c'est le signal qu'un
   texte NOMME du code — une pile Java ou Python, un nom d'exception, un « Error: », un code
   HTTP 4xx/5xx suivi d'une route. Faux positif : un bouton de plus, sans conséquence. Faux
   négatif : la palette et l'onglet Agents restent des chemins. */
function detecterTrace(texte) {
  return /\bat .+\(.+:\d+\)|Traceback \(most recent|Exception\b|Error:|\b[45]\d\d\b .*\//.test(String(texte || ''));
}

/* « Enquêter » depuis un ticket : la modale de session s'ouvre en exploration, portée par
   l'enquêteur, avec le TEXTE DU TICKET en demande. */
/* B9 — L'ENQUÊTEUR, DEPUIS N'IMPORTE QUELLE TRACE. Il n'était atteignable que depuis un
   ticket Jira, alors que les deux endroits où l'on LIT une trace dans cet outil sont la
   console Jenkins et le rapport d'une vérification rouge. Le geste est le même partout : la
   modale de session s'ouvre en exploration, portée par l'enquêteur, le texte en demande. */
async function enqueterSurTexte(texte) {
  const enq = agents.find((a) => a.builtin_key === 'investigator') || (await chargerAgents()).find((a) => a.builtin_key === 'investigator');
  if (!enq) { toast(tr('agents.err.no-investigator'), true); return false; }
  await agentDemander(enq);
  $('#taskPrompt').value = texte;
  $('#taskPrompt').dispatchEvent(new Event('input', { bubbles: true }));
  return true;
}

async function enqueterSurTicket(cle) {
  const enq = agents.find((a) => a.builtin_key === 'investigator') || (await chargerAgents()).find((a) => a.builtin_key === 'investigator');
  if (!enq) { toast(tr('agents.err.no-investigator'), true); return; }
  let texte = '';
  try {
    // La route enveloppe le ticket : `{ issue }`. Le lire à plat donnait « undefined — » en
    // guise de demande, et l'enquête partait sans la trace.
    const d = await api(`/jira/issue/${encodeURIComponent(cle)}`);
    const it = d.issue || d;
    texte = `${it.key} — ${it.summary || ''}\n\n${it.descriptionMd || ''}`.trim();
  } catch { texte = cle; }
  await agentDemander(enq);
  $('#taskPrompt').value = texte;
}

document.addEventListener('click', (e) => {
  const b = e.target.closest && e.target.closest('.btn-jira-investigate');
  if (b) enqueterSurTicket(b.dataset.jirakey);
});

async function lancerAgentDepuisPalette(r) {
  navTab('agents');
  showAgentsSub('list');
  await loadAgentList();
  const carte = $(`#agentList .agent-card[data-id="${Number(r.id || r.ref)}"]`);
  const b = carte && carte.querySelector('.btn-agent-ask');
  if (b) b.click();
}

const agentChoisiDansModale = () => {
  const h = $('#taskAgentBox') && $('#taskAgentBox').querySelector('.taskAgentVal');
  return h && h.value ? Number(h.value) : null;
};

/* ---------- Câblages ---------- */

onEl($('#agentFilter'), 'input', filtrerAgents);
onEl($('#agentSkillFilter'), 'input', () => filtrerLignes($('#agentSkillFilter'), $('#agentSkills')));
onEl($('#agentRepoFilter'), 'input', () => filtrerLignes($('#agentRepoFilter'), $('#agentRepos')));
onEl($('#domainRepoFilter'), 'input', () => filtrerLignes($('#domainRepoFilter'), $('#domainRepos')));
onEl($('#btnNewAgent'), 'click', () => ouvrirAgentModal(null));
onEl($('#agentCancel'), 'click', () => { $('#agentModal').hidden = true; });
onEl($('#agentKind'), 'change', majApercuArgv);
onEl($('#agentOutputKind'), 'change', () => { majSortieVisible(null); majApercuArgv(); });
onEl($('#agentScheduleKind'), 'change', majHoraireForm);
onEl($('#agentRunner'), 'change', majExecutantForm);
onEl($('#agentScheduleDow'), 'change', majHoraireForm);
onEl($('#agentScheduleDom'), 'change', majHoraireForm);
onEl($('#agentScheduleTime'), 'change', majHoraireForm);
onEl($('#agentMaxTurns'), 'input', () => { majHoraireForm(); majApercuArgv(); });
onEl($('#agentSubagents'), 'input', () => { majErreurSubagents(); majApercuArgv(); });
/* UN EXEMPLE VALIDE PLUTÔT QU'UNE PAGE BLANCHE. Le champ est du JSON écrit à la main : on
   commençait par retrouver la forme exacte — accolades, guillemets, nom de la clé `tools` —
   avant d'écrire quoi que ce soit d'utile. Le bouton ajoute une entrée au JSON DÉJÀ ÉCRIT
   quand il est valide (on n'efface jamais le travail en cours), et un squelette sinon. Le nom
   est numéroté pour ne pas écraser un sous-agent existant. */
onEl($('#agentSubagentAdd'), 'click', () => {
  const champ = $('#agentSubagents');
  if (!champ) return;
  const courant = lireSubagentsJson();
  const base = courant && typeof courant === 'object' ? courant : {};
  let nom = tr('agents.f.subagent-name');
  let i = 2;
  while (base[nom]) { nom = `${tr('agents.f.subagent-name')}-${i}`; i += 1; }
  base[nom] = { description: tr('agents.f.subagent-desc'), prompt: tr('agents.f.subagent-prompt'), tools: ['Read', 'Grep'] };
  champ.value = JSON.stringify(base, null, 2);
  majErreurSubagents(); majApercuArgv();
  champ.focus();
});
onEl($('#agentForm'), 'input', (e) => {
  if (e.target.matches('#agentModel, #agentAllowed, #agentDisallowed, #agentSystemPrompt')) majApercuArgv();
});
onEl($('#agentForm'), 'change', (e) => {
  if (e.target.name === 'scope_kind') majPerimetreVisible();
  if (e.target.name === 'permission_mode') majApercuArgv();
});

onEl($('#agentForm'), 'submit', async (e) => {
  e.preventDefault();
  const corps = lireAgentForm();
  if (corps.subagents_json === null) { toast(tr('agents.err.subagents-json'), true); return; }
  try {
    await busy($('#agentSave'), async () => {
      if (agentEditId) await api(`/agents/${agentEditId}`, { method: 'PUT', body: corps });
      else await api('/agents', { method: 'POST', body: corps });
    });
    $('#agentModal').hidden = true;
    toast(tr('agents.saved'));
    await loadAgentList();
  } catch (err) { toast(explainError(err.message), true); }
});

/* « Essai » : la modale de session pré-remplie avec ce profil, SANS enregistrer. On règle un
   rôle en le voyant tourner, pas en le relisant. */
/* A18 — « ESSAI » PART AVEC LE PROFIL, pas seulement avec son gabarit. Il ouvrait une session
   pré-remplie de la demande : le modèle, les outils, les sous-agents et le prompt système
   restaient à quai, puisque la session n'avait pas de profil — on essayait donc tout sauf ce
   qu'on venait de régler. Le brouillon voyage avec la session ; aucun agent n'est créé, et il
   est oublié dès que la modale se referme sans être envoyée. */
let essaiAgent = null;
onEl($('#agentTry'), 'click', async () => {
  const corps = lireAgentForm();
  $('#agentModal').hidden = true;
  await openTaskModal(corps.kind === 'code' ? 'code' : 'explore');
  essaiAgent = corps;
  const banniere = $('#taskAgentEssai');
  if (banniere) { banniere.hidden = false; banniere.textContent = tr('agents.try.banner', { name: corps.name || '' }); }
  $('#taskPrompt').value = corps.prompt_template.replace('{question}', '').trim();
  $('#taskPrompt').focus();
});

/* LES SESSIONS D'UN AGENT : LA SAVEUR D'ABORD, LE FILTRE ENSUITE. Les runs d'un explorateur
   vivent dans « Exploration » : filtrer « Codage » ne montrait rien. Et l'ordre compte —
   changer de saveur remet le filtre à zéro. */
function ouvrirSessionsAgent(a) {
  navTab('task');
  const saveur = a.kind === 'code' ? 'code' : 'explore';
  const onglet = $(`#tab-task .subnav [data-kind="${saveur}"]`);
  if (onglet && taskKind !== saveur) onglet.click();
  poserFiltreAgent(a.id);
  return loadTasks();
}

/* UN REFUS DU SERVEUR SE DIT, il ne remonte pas en « erreur inattendue ». « Dupliquer » et
   « Coder » sur un agent pas encore approuvé reçoivent un 409 légitime : sans ce filet, la
   promesse partait rejetée et le message n'arrivait que par le filet global, préfixé. */
document.addEventListener('click', async (e) => {
  const b = e.target.closest && e.target.closest('[class*="btn-agent-"]');
  if (!b) return;
  const a = agentDe(b.dataset.id);
  if (!a) return;
  try { await actionAgent(b, a); } catch (err) { toast(explainError(err.message), true); }
});

async function actionAgent(b, a) {
  if (b.classList.contains('btn-agent-ask')) return agentDemander(a);
  if (b.classList.contains('btn-agent-code')) return agentCoder(a);
  if (b.classList.contains('btn-agent-edit')) return ouvrirAgentModal(a);
  if (b.classList.contains('btn-agent-knowledge')) return ouvrirConnaissance(a);
  if (b.classList.contains('btn-agent-review')) return ouvrirConnaissance(a, { pending: true });
  if (b.classList.contains('btn-agent-runs')) return ouvrirSessionsAgent(a);
  if (b.classList.contains('btn-agent-refresh')) {
    return busy(b, async () => {
      try { await api(`/agents/${a.id}/knowledge/refresh`, { method: 'POST' }); toast(tr('agents.refresh.started')); refreshStatus(); }
      catch (err) { toast(explainError(err.message), true); }
    });
  }
  if (b.classList.contains('btn-agent-approve')) {
    try {
      await busy(b, () => api(`/agents/${a.id}/approve`, { method: 'POST', body: { signature: a.approval_signature } }));
      toast(tr('approval.done'));
      return loadAgentList();
    } catch (err) {
      toast(explainError(err.message), true);
      return err.code === 'APPROBATION_PERIMEE' ? loadAgentList() : undefined;
    }
  }
  if (b.classList.contains('btn-agent-dup')) {
    await api(`/agents/${a.id}/duplicate`, { method: 'POST' });
    toast(tr('agents.duplicated')); return loadAgentList();
  }
  if (b.classList.contains('btn-agent-restore')) {
    const ok = await confirmDialog({
      title: tr('agents.restore.title'), text: tr('agents.restore.text', { name: a.name }),
      confirmLabel: tr('agents.btn.restore'), danger: false,
    });
    if (!ok) return;
    await api(`/agents/${a.id}/restore`, { method: 'POST' });
    toast(tr('agents.restored')); return loadAgentList();
  }
  if (b.classList.contains('btn-agent-del')) {
    const ok = await confirmDialog({
      title: tr('agents.delete.title'), text: tr('agents.delete.text', { name: a.name }),
      detail: tr('agents.delete.detail'), confirmLabel: tr('ui.delete'),
    });
    if (!ok) return;
    await api(`/agents/${a.id}`, { method: 'DELETE' });
    toast(tr('agents.deleted')); return loadAgentList();
  }
  return undefined;
}

// L'état vide propose le geste principal.
document.addEventListener('click', (e) => {
  const b = e.target.closest && e.target.closest('[data-empty-act="new-domain"]');
  if (b) ouvrirDomainModal();
});

