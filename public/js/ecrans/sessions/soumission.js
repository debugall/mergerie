'use strict';
/* Dupliquer hors dépôt, éditer une question, reprendre une session, la branche suit le libellé, le `submit` de la modale. */
/* DUPLIQUER une session HORS DÉPÔT. Même geste, mais son propre câblage : les dossiers sont
   stockés en chemins absolus et la modale se pilote en « répertoire + noms de projets » —
   c'est la relecture d'`openLocalTaskEdit`, sans l'identifiant. Aucune branche ici : rien à
   décaler, les dossiers sont ceux qu'on veut retraiter. */
async function dupliquerLocalTask(id) {
  const f = $('#taskForm');
  f.reset(); resetTaskFiles();
  const d = await api(`/local-tasks/${id}`);
  const t = d.task;
  editingTaskId = null; launchAfterCreate = false;
  taskKind = 'local';
  await loadLocalRoots();
  const paths = (t.dirs || []).map((x) => x.path);
  const under = (root, p) => p.startsWith(`${String(root.path).replace(/\/+$/, '')}/`);
  const root = localRoots.find((r) => paths.some((p) => under(r, p))) || localRoots[0];
  localRootId = root ? String(root.id) : '';
  localPicks = paths.map((p) => p.split('/').filter(Boolean).pop() || '');
  if (!localPicks.length) localPicks = [''];
  applyKindToModal('local');
  f.prompt.value = t.prompt || '';
  if (f.label) f.label.value = t.label || '';
  if (f.ask_questions) f.ask_questions.checked = !!t.ask_questions;
  if (f.notify_jira) f.notify_jira.checked = !!t.notify_jira;
  if (f.review_after) f.review_after.checked = !!t.review_after;
  if (f.session_id) f.session_id.value = '';
  $('#taskModalTitle').textContent = tr('task.duplicate.title-local');
  infoDuplication(false, (d.images && d.images.length) || 0);
  boutonsCreation();
  showTaskModal();
  f.prompt.focus();
}

/* Session commune à TOUTES les unités d'une session (projets ou dossiers), s'il y en a une.
   Sert à pré-remplir « reprendre une session existante » en édition : tant que les unités
   s'accordent, le champ montre la vérité. Dès qu'elles divergent — une seule a tourné, par
   exemple — on préfère le vide au mensonge d'afficher l'une des deux. */
function sharedSessionKey(units) {
  const keys = (units || []).map((u) => u.session_key || '');
  return keys.length && keys.every((k) => k && k === keys[0]) ? keys[0] : '';
}

/* Édition d'une session hors dépôt. Les dossiers sont stockés en CHEMINS ABSOLUS ; la
   modale, elle, se pilote en « répertoire local + nom de projet ». On refait donc le chemin
   inverse : le répertoire est déduit du premier dossier, les projets de leur nom de base.
   Une session créée depuis cette modale a forcément tous ses dossiers sous UN répertoire
   (changer de répertoire remet la sélection à zéro), donc le cas normal est couvert ; un
   dossier venu d'ailleurs est signalé à l'enregistrement plutôt que perdu en silence. */
async function openLocalTaskEdit(id) {
  const f = $('#taskForm');
  f.reset(); resetTaskFiles();
  const d = await api(`/local-tasks/${id}`);
  const t = d.task;
  editingTaskId = id; launchAfterCreate = false;
  taskKind = 'local';
  await loadLocalRoots();
  const paths = (t.dirs || []).map((x) => x.path);
  const under = (root, p) => p.startsWith(`${String(root.path).replace(/\/+$/, '')}/`);
  const root = localRoots.find((r) => paths.some((p) => under(r, p))) || localRoots[0];
  localRootId = root ? String(root.id) : '';
  localPicks = paths.map((p) => p.split('/').filter(Boolean).pop() || '');
  if (!localPicks.length) localPicks = [''];
  applyKindToModal('local');
  f.prompt.value = t.prompt || '';
  if (f.label) f.label.value = t.label || '';
  if (f.ask_questions) f.ask_questions.checked = !!t.ask_questions;
  if (f.notify_jira) f.notify_jira.checked = !!t.notify_jira;
  if (f.review_after) f.review_after.checked = !!t.review_after;
  poserDateProgrammee(f, t.scheduled_at);
  if (f.session_id) f.session_id.value = sharedSessionKey(t.dirs);
  deplierAvanceSiRempli(f);
  $('#taskModalTitle').textContent = tr('local.edit-title');
  setTaskPieces('local', d.images);
  $('#taskSubmit').innerHTML = `<svg class="ico"><use href="#i-save"/></svg>${tr('ui.save')}`;
  $('#taskSubmitOnly').hidden = true;   // on modifie une session existante : rien à créer
  showTaskModal();
  f.prompt.focus();
}

/* Édition d'une question : le prompt et le libellé, rien d'autre. La SESSION D'AGENT n'est
   pas touchée — corriger une formulation ne doit pas faire perdre le fil de l'échange. */
async function openQuestionEdit(id) {
  const f = $('#taskForm');
  f.reset(); resetTaskFiles();
  const d = await api(`/questions/${id}`);
  const q = d.task;
  editingTaskId = id; launchAfterCreate = false;
  taskKind = 'ask';
  applyKindToModal('ask');
  f.prompt.value = q.prompt || '';
  if (f.label) f.label.value = q.label || '';
  $('#taskModalTitle').textContent = tr('ask.edit-title');
  $('#taskExistingImgs').textContent = '';
  setTaskPieces('ask', d.images);       // le codage libre joint des fichiers lui aussi
  $('#taskSubmit').innerHTML = `<svg class="ico"><use href="#i-save"/></svg>${tr('ui.save')}`;
  $('#taskSubmitOnly').hidden = true;   // on modifie une question existante : rien à créer
  showTaskModal();
  f.prompt.focus();
}

function closeTaskModal() {
  // Les deux drapeaux vont de pair : un « Converger » dont le POST a échoué détournerait
  // sinon le submit suivant (session non lancée, modale de convergence à la place).
  editingTaskId = null; launchAfterCreate = false;
  $('#taskModal').hidden = true;
  $('#taskSubmitOnly').hidden = true;
  $('#taskSubmit').innerHTML = `<svg class="ico"><use href="#i-save"/></svg>${tr('ui.save')}`;
}

// Détecte une clé de ticket (PROJ-1234) dans un nom de branche — même logique que côté serveur.
function jiraKeyFromBranch(branch) {
  const m = /([A-Za-z]+-\d+)/.exec(branch || '');
  return m ? m[1].toUpperCase() : '';
}
// Prépare le bloc « enrichir depuis Jira » à l'ouverture de la modale : visible seulement
// si Jira est configuré, avec le numéro pré-rempli depuis la branche de travail.
function setupTaskJira(branch) {
  const row = $('#taskJiraRow');
  if (!row) return;
  row.hidden = !jiraConfigured;
  const st = $('#taskJiraStatus'); if (st) st.textContent = '';
  const key = $('#taskJiraKey'); if (key) key.value = jiraKeyFromBranch(branch);
}
$('#taskJiraFetch') && $('#taskJiraFetch').addEventListener('click', async () => {
  const btn = $('#taskJiraFetch');
  const key = ($('#taskJiraKey').value || '').trim();
  if (!key) { toast(tr('task.jira.key-required'), true); return; }
  try {
    const d = await busy(btn, () => api('/jira/fetch', { method: 'POST', body: { key } }));
    const header = tr('task.jira.context-header', { key: d.key });
    const block = `${header}\n\n${(d.context || '').trim()}\n\n---`;
    const f = $('#taskForm');
    f.prompt.value = block + (f.prompt.value.trim() ? `\n\n${f.prompt.value}` : '\n\n');
    /* LE MÊME GESTE QUE « FAIRE CODER » DEPUIS UN TICKET. Ce bouton ne remplissait que la
       demande : le libellé de la session et le message de commit restaient vides, alors que le
       ticket vient de donner son titre et sa clé. On ne remplace jamais ce qui est déjà écrit —
       un champ rempli à la main appartient à qui l'a rempli. */
    const resume = `${d.key} ${d.summary || ''}`.trim();
    if (f.label && !f.label.value.trim()) f.label.value = resume.slice(0, 120);
    if (f.commit_message && !f.commit_message.value.trim()) f.commit_message.value = resume;
    cleJiraDeLaSession = d.key;
    $('#taskJiraStatus').textContent = tr('task.jira.added', { key: d.key });
    f.prompt.focus();
  } catch (e) { $('#taskJiraStatus').textContent = ''; toast(explainError(e.message), true); }
});
$('#btnNewTask').addEventListener('click', () => openTaskModal(taskKind).catch((e) => toast(tr('toast.ouverture-impossible', { message: e.message }), true)));
/* Le champ « reprendre une session » : la mise en garde s'affiche dès qu'on saisit quelque
   chose. Elle vit sinon dans une info-bulle, qui ne s'ouvre pas toute seule — or c'est
   précisément au moment de coller un identifiant qu'il faut savoir qu'une session est liée à
   son répertoire. Le message pré-rempli depuis une MR (`keep`) a priorité : il est plus précis. */
$('#taskSessionId') && $('#taskSessionId').addEventListener('input', (e) => {
  const hint = $('#taskSessionHint');
  if (!hint || hint.dataset.keep === '1') return;
  hint.hidden = !e.target.value.trim();
  hint.textContent = hint.hidden ? '' : tr('task.session-id.scope');
});

$('#taskCancel').addEventListener('click', closeTaskModal);
$('#taskSubmitOnly').addEventListener('click', () => {
  launchAfterCreate = false; // on crée, on ne lance pas
  $('#taskForm').requestSubmit();            // passe par la validation native du formulaire
});
fermerAuFond('#taskModal', closeTaskModal);

/* La proposition de branche suit le libellé et le prompt tant qu'on n'a pas touché au champ.
   Débouncée : recalculer à chaque touche pendant qu'on écrit un prompt de cinq lignes ferait
   défiler un nom de branche sous les yeux. */
(() => {
  const f = $('#taskForm');
  if (!f) return;
  const maj = debounce(() => proposerBranche(), 250);
  if (f.label) f.label.addEventListener('input', maj);
  if (f.prompt) f.prompt.addEventListener('input', maj);
  /* CTRL/⌘ + ENTRÉE SOUMET DEPUIS LE PROMPT. Entrée y insère une ligne — c'est ce qu'on veut
     dans une zone de texte —, mais il faut alors viser le bouton à la souris pour partir. */
  if (f.prompt) {
    f.prompt.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        if (typeof f.requestSubmit === 'function') f.requestSubmit(); else f.dispatchEvent(new Event('submit', { cancelable: true }));
      }
    });
  }
})();

$('#taskForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  /* LANCER PLUS TARD : lue une fois pour les trois saveurs. `false` = date passée, déjà signalée
     sous le champ — on s'arrête là plutôt que de créer une session qui ne partirait jamais. */
  const programmeA = lireDateProgrammee(f);
  if (programmeA === false) return;
  // Codage hors dépôt : projets d'un répertoire local + images, endpoint dédié, créé
  // ET lancé. Le serveur continue de recevoir des CHEMINS absolus : c'est la saisie
  // qui a changé, pas le contrat — les sessions déjà enregistrées restent lisibles.
  if (taskKind === 'local') {
    const picks = [...new Set(localPicks.map((p) => String(p || '').trim()).filter(Boolean))];
    let dirs = [];
    try {
      const all = picks.length ? await localProjectsOf(localRootId) : [];
      dirs = picks.map((name) => (all.find((p) => p.name === name) || {}).path).filter(Boolean);
    } catch (err) { toast(explainError(err.message), true); return; }
    if (!dirs.length) { toast(tr('local.dirs-required'), true); return; }
    /* Un projet choisi qui ne se résout pas en chemin dans le répertoire courant serait
       silencieusement retiré de la session. À la création c'est déjà fâcheux ; à l'édition
       ce serait une perte de données. On refuse plutôt que d'enregistrer une liste amputée. */
    if (dirs.length !== picks.length) { toast(tr('local.dirs-unresolved'), true); return; }
    const btn = $('#taskSubmit');
    try {
      if (editingTaskId) {
        await busy(btn, () => api(`/local-tasks/${editingTaskId}`, { method: 'PUT', body: {
          label: f.label ? f.label.value : '',
          prompt: f.prompt.value, dirs, files: taskNewImages,
          session_id: f.session_id ? f.session_id.value : '',
          ask_questions: f.ask_questions ? f.ask_questions.checked : false,
        } }));
        await majProgrammationEdition(f, `/local-tasks/${editingTaskId}/schedule`, programmeA);
        toast(tr('toast.session-mise-a-jour'));
        resetTaskFiles(); closeTaskModal(); loadTasks();
        return;
      }
      const created = await busy(btn, () => api('/local-tasks', { method: 'POST', body: {
        label: f.label ? f.label.value : '',
        prompt: f.prompt.value, dirs, files: taskNewImages, session_id: f.session_id ? f.session_id.value : '',
        ask_questions: f.ask_questions ? f.ask_questions.checked : false,
        /* La modale est commune aux trois saveurs, mais CHAQUE SAVEUR A SON ENVOI : la case
           « partager » doit donc être câblée trois fois, sans quoi elle ne ferait rien ici. */
        shared: f.shared ? f.shared.checked : false,
      } }));
      if (programmeA) {
        await api(`/local-tasks/${created.id}/schedule`, { method: 'PUT', body: { at: programmeA } });
        toast(tr('toast.session-programmee', { when: fmtDateTime(programmeA) }));
      } else if (launchAfterCreate) {
        await api(`/local-tasks/${created.id}/run`, { method: 'POST' });
        toast(tr('local.started')); refreshStatus();
      } else {
        // Créée en statut « new » : la carte affiche « Lancer », le geste reste à un clic.
        toast(tr('toast.local-session-created'));
      }
      resetTaskFiles(); closeTaskModal(); loadTasks();
    } catch (err) { toast(explainError(err.message), true); }
    return;
  }
  /* Question libre : ni cible à lire, ni image, ni session à reprendre — un prompt et un
     libellé. Son propre envoi, comme le hors dépôt : le formulaire est commun, les contrats
     ne le sont pas. */
  if (taskKind === 'ask') {
    const btn = $('#taskSubmit');
    // Une question libre aussi peut s'appuyer sur un document : le devis, la spec, le mail.
    const body = {
      prompt: f.prompt.value, label: f.label ? f.label.value : '', files: taskNewImages,
      shared: f.shared ? f.shared.checked : false,
    };
    try {
      if (editingTaskId) {
        await busy(btn, () => api(`/questions/${editingTaskId}`, { method: 'PUT', body }));
        toast(tr('toast.session-mise-a-jour'));
        closeTaskModal(); loadTasks();
        return;
      }
      const created = await busy(btn, () => api('/questions', { method: 'POST', body }));
      if (launchAfterCreate) {
        await api(`/questions/${created.id}/run`, { method: 'POST' });
        toast(tr('ask.started')); refreshStatus();
      } else toast(tr('ask.created'));
      closeTaskModal(); loadTasks();
    } catch (err) { toast(explainError(err.message), true); }
    return;
  }
  const targets = readTargetRows();
  if (!targets.length) { toast(tr('toast.selectionne-au-moins-un-projet'), true); return; }
  /* LA BRANCHE DE TRAVAIL EST OBLIGATOIRE EN CODAGE, et on le dit SOUS le champ concerné.
     Le serveur la refusait vide, le client envoyait quand même, et un toast rouge annonçait
     « nom de branche requis pour chaque projet » à sept cents pixels de la ligne fautive —
     sans dire laquelle. C'est la première friction du parcours principal de Dev IA. */
  if (taskKind === 'code') {
    viderErreursChamps($('#targetRows'));
    const lignes = $$('#targetRows .target-row');
    for (let i = 0; i < targets.length; i += 1) {
      if (targets[i].branch) continue;
      const ligne = lignes[i];
      const champ = ligne && ligne.querySelector('.t-branch');
      const projet = (repoOptions.find((r) => r.id === targets[i].repo_id) || {}).project || '';
      signalerChamp(champ, tr('err.branche-requise', { project: projet }));
      return;
    }
  }
  const body = {
    kind: taskKind,
    label: f.label ? f.label.value : '',
    prompt: f.prompt.value,
    commit_message: f.commit_message ? f.commit_message.value : '',
    auto_push: f.auto_push ? f.auto_push.checked : false,
    ask_questions: f.ask_questions ? f.ask_questions.checked : false,
    // B5 : prévenir Jira à la création de chaque merge request de cette session.
    notify_jira: f.notify_jira ? f.notify_jira.checked : false,
    review_after: f.review_after ? f.review_after.checked : false,
    verifier_id: f.verifier_id ? Number(f.verifier_id.value) || null : null,
    // Session existante à reprendre. Vide = nouvelle session, le cas courant. Le champ
    // n'est lu qu'à la CRÉATION : la modale d'édition ne réaffecte pas une session déjà
    // en cours, qui a son propre handle par projet.
    session_id: f.session_id ? f.session_id.value : '',
    // Les skills cochés : le serveur les résout contre le disque et en fait la 1re ligne du prompt.
    skills: skillsChoisis(),
    /* L'agent qui porte la session. Dès qu'il est là, le serveur compose la demande selon son
       profil et force `auto_push` à 0 — un agent ne pousse jamais de lui-même. */
    agent_id: agentChoisiDansModale(),
    /* A18 — le profil qu'on ESSAIE, tel qu'il est dans le formulaire : la session part avec son
       modèle, ses outils et ses sous-agents sans qu'un agent soit enregistré. Ignoré si un
       agent existant a été choisi : un run ne porte qu'un profil. */
    agent_draft: essaiAgent && !agentChoisiDansModale() ? essaiAgent : undefined,
    // Partager cette session : décochée par défaut, et ignorée par le serveur à l'édition.
    shared: f.shared ? f.shared.checked : false,
    files: taskNewImages,
    targets,
  };
  // B10 : les captures du ticket cochées viennent s'ajouter aux pièces déjà choisies.
  if (cleJiraDeLaSession) {
    const pieces = await piecesJiraCochees();
    if (pieces.length) body.files = [...(body.files || []), ...pieces];
  }
  if (piecesNoteProposees.length) {
    const pieces = await piecesNoteCochees();
    if (pieces.length) body.files = [...(body.files || []), ...pieces];
  }
  memoriserBaseSession(targets);   // la prochaine session partira de la même branche, par dépôt
  memoriserProjets(taskKind, targets);   // …et sur les mêmes projets, par saveur
  // Session née d'un ticket : le dépôt retenu servira de proposition au prochain de ce projet.
  if (cleJiraDeLaSession && targets[0]) memoriserDepotJira(cleJiraDeLaSession, targets[0].repo_id);
  const btn = $('#taskSubmit');
  /* CONVERGER EST DEVENU UNE CASE, plus un second bouton primaire : c'est donc l'état de la
     case qui décide, et non plus lequel des deux boutons a été cliqué. Elle annonce son seuil
     et son plafond dans son libellé — la convergence part directement avec ces valeurs, sans
     seconde fenêtre pour redemander ce qui vient d'être affiché. */
  const veutConverger = !editingTaskId && taskKind === 'code' && !!(f.converge_after && f.converge_after.checked);
  // Une convergence ne se programme pas : on le dit sous la date plutôt que d'en ignorer une des deux.
  if (veutConverger && programmeA) { signalerChamp(f.scheduled_at_date, tr('err.programmation.converge')); return; }
  let convergeId = null;
  try {
    await busy(btn, async () => {
      if (editingTaskId) {
        await api(`/tasks/${editingTaskId}`, { method: 'PUT', body });
        await majProgrammationEdition(f, `/tasks/${editingTaskId}/schedule`, programmeA);
        toast(tr('toast.session-mise-a-jour'));
        return;
      }
      const created = await api('/tasks', { method: 'POST', body });
      if (programmeA) {
        await api(`/tasks/${created.id}/schedule`, { method: 'PUT', body: { at: programmeA } });
        toast(tr('toast.session-programmee', { when: fmtDateTime(programmeA) }));
      } else if (veutConverger) {
        convergeId = created.id; // on ne lance PAS le run : la convergence pilote tout
      } else if (launchAfterCreate) {
        await api(`/tasks/${created.id}/run`, { method: 'POST' });
        toast(tr('toast.session-lancee')); refreshStatus();
      } else {
        toast(taskKind === 'code'
          ? tr('toast.code-session-created')
          : tr('toast.exploration-created'));
      }
    });
    resetTaskFiles();
    closeTaskModal();
    loadTasks();
    if (convergeId) {
      const d = await defautsConvergence();
      await api(`/tasks/${convergeId}/converge`, { method: 'POST', body: { threshold: d.seuil, maxPasses: d.passes } });
      toast(tr('toast.converge-lancee')); refreshStatus();
    }
  } catch (err) { toast(explainError(err.message), true); }
});

