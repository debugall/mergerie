'use strict';
/* La modale de session : ouvrir, vérificateur, deux cases liées, seuil, sessions reprenables. */
// @expose convDefauts, majVerificateursSession, openTaskForMr, openTaskModal
/* ---- Modale ---- */
let editingTaskId = null;
let launchAfterCreate = false;

/* La case « partager » du formulaire de session : montrée seulement en mode partagé, et jamais
   remplie d'office. `partageActif()` lit `/api/whoami` une fois pour toute la page. */
async function majCasePartageSession() {
  const ligne = $('#taskShareRow');
  if (!ligne) return;
  ligne.hidden = !await partageActif();
}

function applyKindToModal(kind) {
  const isLocal = kind === 'local';
  /* UNE QUESTION LIBRE N'A AUCUNE CIBLE : ni projet, ni dossier, ni ticket, ni vérificateur.
     Tout ce qui suppose du code disparaît — laisser un sélecteur de dépôt sur un écran qui
     ne s'en sert pas ferait croire que la réponse portera dessus. */
  const isAsk = kind === 'ask';
  $('#codeOnlyFields').hidden = kind !== 'code';
  /* « puis converger » : sessions de CODAGE, et seulement à la création — sur une session
     déjà écrite, la convergence se lance depuis sa carte. */
  const cv = $('#taskConvergeRow'); if (cv) cv.hidden = kind !== 'code' || !!editingTaskId;
  /* La review d'une MR n'a de sens que pour une session de CODAGE. Contrairement à la
     convergence, elle reste offerte à l'édition : la merge request n'est souvent pas encore
     créée quand on rouvre la session pour corriger son prompt. */
  const ra = $('#taskReviewAfterRow'); if (ra) ra.hidden = kind !== 'code';
  /* « Prévenir Jira » n'a de sens qu'en codage (il faut une merge request) et que si Jira est
     connecté : proposer d'écrire dans un Jira absent serait une case qui ne fait rien. */
  const nj = $('#taskNotifyJiraRow'); if (nj) nj.hidden = kind !== 'code' || !jiraConfigured;
  majLibelleConverge();
  // Le message de commit ne veut rien dire hors codage : l'exploration ne commit pas.
  const cm = $('#taskCommitRow'); if (cm) cm.hidden = kind !== 'code';
  // Lancer plus tard : les trois saveurs qui travaillent dans des fichiers. Pas la question libre.
  const sr = $('#taskScheduleRow'); if (sr) sr.hidden = isAsk;
  /* L'accordéon « Avancé » ne s'affiche que s'il lui reste quelque chose : une question libre
     n'a ni session d'agent, ni message de commit, ni question à poser. */
  const av = $('#taskAdvanced'); if (av) { av.hidden = isAsk; av.open = false; }   // replié à chaque ouverture
  // La case « l'IA peut poser une question » vit hors de l'accordéon, pour les trois saveurs à cible.
  const aq = $('#taskAskQuestionsRow'); if (aq) aq.hidden = isAsk;
  // Codage hors dépôt : dossiers locaux à la place des projets, Jira & avertissement.
  $('#taskReposWrap').hidden = isLocal || isAsk;
  /* Projets liés en lecture seule : CODAGE seulement. Une exploration voit déjà tous ses
     dépôts côte à côte (§ runExploration) et n'a rien à distinguer lecture/écriture. */
  const ctxRow = $('#taskContextRepos'); if (ctxRow) ctxRow.hidden = kind !== 'code';
  $('#taskLocalWrap').hidden = !isLocal;
  $('#taskLocalWarn').hidden = !isLocal;
  if (isLocal) { $('#taskJiraRow').hidden = true; renderLocalRootPicker(); renderLocalDirRows(); }
  if (isAsk) $('#taskJiraRow').hidden = true;
  /* La case « l'IA peut me poser des questions » et l'identifiant de session supposent une
     cible sur laquelle l'agent hésite ou travaille : sans dépôt ni dossier, elles n'ont rien
     à quoi se rattacher. */
  const gRow = $('#taskAgentFields'); if (gRow) gRow.hidden = isAsk;
  /* « Partager avec l'équipe » vaut pour LES TROIS SAVEURS — une question libre se partage
     comme une session de codage —, mais seulement quand il y a une équipe. */
  majCasePartageSession();
  /* Le combo Agent est MASQUÉ hors dépôt et en question libre — un profil parle de dépôts, et
     il n'y en a pas. Le champ reste dans le formulaire unique : il est simplement ignoré là. */
  const agRow = $('#taskAgentRow'); if (agRow) agRow.hidden = isLocal || isAsk;
  const skRow = $('#taskSkillsRow'); if (skRow) skRow.hidden = isAsk;
  const ta = $('#taskForm').prompt;
  ta.placeholder = isAsk ? tr('ask.prompt-ph')
    : (isLocal ? tr('local.prompt-ph') : (kind === 'code' ? tr('task.ph.prompt-code') : tr('task.ph.prompt-explore')));
  $('#targetsLabel').textContent = kind === 'code' ? tr('task.targets.code') : tr('task.targets.explore');
}

/* LE VÉRIFICATEUR D'UNE SESSION. Il ne se propose que s'il COUVRE TOUS LES DÉPÔTS choisis :
   un vérificateur qui n'en couvre que la moitié rendrait un vert qui ne dit rien de l'autre,
   et le proposer serait promettre un verdict qu'on ne peut pas tenir. La liste se refait donc
   à chaque changement de projets. */
async function majVerificateursSession(choisi = null, { autoPick = true } = {}) {
  const sel = $('#taskVerifier');
  if (!sel) return;
  const garde = choisi === null ? sel.value : String(choisi || '');
  const repos = readTargetRows().map((t) => t.repo_id).filter(Boolean);
  let liste = [];
  // La route rend un TABLEAU, pas un objet enveloppe : s'en assurer ici évite un écran vide.
  try { const d = await api('/verifiers'); liste = Array.isArray(d) ? d : (d.verifiers || []); } catch { liste = []; }
  const couvrants = liste.filter((v) => repos.every((id) => (v.repos || []).some((r) => r.repo_id === id)));
  sel.innerHTML = `<option value="">${esc(tr('task.verifier.none'))}</option>`
    + couvrants.map((v) => `<option value="${v.id}">${esc(v.name)}</option>`).join('');
  /* UNE LISTE VIDE DOIT DIRE POURQUOI. « Aucun vérificateur ne couvre ces dépôts » laissait
     deviner lequel manquait : on dit, pour chaque vérificateur qui couvre au moins un des
     dépôts choisis, ce qu'il couvre et ce qui lui manque — et on donne la porte pour le
     compléter. Sans cela, le seul chemin était d'aller lire les vérificateurs un par un. */
  const note = $('#taskVerifierMissing');
  if (note) {
    const nomDe = (id) => (repoOptions.find((r) => r.id === id) || {}).project || `#${id}`;
    const partiels = repos.length && !couvrants.length
      ? liste.map((v) => {
        const couverts = repos.filter((id) => (v.repos || []).some((r) => r.repo_id === id));
        return { v, couverts, manquants: repos.filter((id) => !couverts.includes(id)) };
      }).filter((x) => x.couverts.length)
      : [];
    note.hidden = !(repos.length && !couvrants.length);
    note.innerHTML = !note.hidden
      ? `${partiels.length
        ? partiels.map((x) => esc(tr('task.verifier.partial', {
          name: x.v.name, covers: x.couverts.map(nomDe).join(', '), missing: x.manquants.map(nomDe).join(', '),
        }))).join('<br>')
        : esc(tr('task.verifier.none-at-all'))}
        <button type="button" class="lien-reglage" data-go-verifiers>${esc(tr('task.verifier.go-settings'))}</button>`
      : '';
  }
  if (!couvrants.length && repos.length) {
    sel.innerHTML = `<option value="">${esc(tr('task.verifier.none-covering'))}</option>`;
  }
  sel.value = couvrants.some((v) => String(v.id) === garde) ? garde : '';
  /* UN SEUL VÉRIFICATEUR COUVRE TOUS LES DÉPÔTS : il se choisit tout seul. Sans ça, on lit le
     rapport, on clique « Faire corriger », on lance — et la session finit « poussée » sans
     verdict, parce qu'un sélecteur vide ne se remarque pas. Un clic suffit à le retirer.
     Seulement à l'INITIALISATION (`choisi` non nul) d'une NOUVELLE session (`autoPick`) : sur
     un simple changement de projets (`null`), re-choisir écraserait un retrait délibéré à
     chaque ligne ajoutée — et en ÉDITION, « aucun » peut être le choix enregistré, pas un
     oubli : le réappliquer masquerait ce choix à chaque réouverture. */
  if (!sel.value && choisi !== null && autoPick && couvrants.length === 1) sel.value = String(couvrants[0].id);
  majLienVerifPush();
}

/* La porte : Réglages → Vérificateurs, la modale refermée — on y va pour compléter une
   couverture, pas pour lire. Ce qui a été saisi reste dans le formulaire, qui n'est pas remis
   à zéro : on rouvre, on retrouve son prompt. */
document.addEventListener('click', (e) => {
  if (!(e.target.closest && e.target.closest('[data-go-verifiers]'))) return;
  closeTaskModal();
  navTab('admin');
  showAdminSub('verifiers');
});

/* LES DEUX CASES SONT LIÉES, dans les deux sens. Un vérificateur ne peut pas travailler sur du
   code qui n'est pas poussé : le choisir coche l'auto-push, et retirer l'auto-push retire le
   vérificateur. Le faire dans un seul sens laisserait une combinaison qui ne peut pas
   s'exécuter — et on ne le découvrirait qu'à la fin de la session. */
function majLienVerifPush() {
  const f = $('#taskForm');
  const sel = $('#taskVerifier');
  if (!f || !sel || !f.auto_push) return;
  const actif = !!sel.value;
  if (actif && !f.auto_push.checked) f.auto_push.checked = true;
  const note = $('#taskVerifierNote');
  if (note) note.hidden = !actif;
}
$('#taskVerifier') && $('#taskVerifier').addEventListener('change', majLienVerifPush);
/* Changer les projets change la liste : un vérificateur qui couvrait les deux premiers dépôts
   ne couvre pas forcément le troisième, et le laisser sélectionné promettrait un verdict
   qu'on ne peut pas tenir. */
$('#targetRows') && $('#targetRows').addEventListener('change', () => { majVerificateursSession(); majSkillsSession(); });
document.addEventListener('change', (e) => {
  if (!e.target.closest || !e.target.matches('#taskForm [name="auto_push"]')) return;
  const sel = $('#taskVerifier');
  if (!sel) return;
  if (!e.target.checked && sel.value) { sel.value = ''; toast(tr('task.verifier.dropped')); }
  majLienVerifPush();
});

/* LE SEUIL ET LE PLAFOND DE LA CONVERGENCE, tels que les Réglages les fixent. La case
   « puis converger » les ANNONCE dans son libellé : promettre « jusqu'à 8/10 » quand le
   réglage dit 7 serait pire que de ne rien dire. Lus une fois, rafraîchis à chaque
   `loadConfig` — donc dès qu'on les change dans Réglages → Merge Request. */
let convDefauts = null;
async function defautsConvergence() {
  if (convDefauts) return convDefauts;
  try {
    const c = await api('/config');
    convDefauts = { seuil: c.converge_threshold || '8', passes: c.converge_max_passes || '3' };
  } catch { convDefauts = { seuil: '8', passes: '3' }; }
  return convDefauts;
}
/* A/Réglages 1 — les quatre cases de session partent des défauts réglés dans Réglages →
   Général. Lus une fois par page, comme le seuil de convergence : c'est un réglage, il ne
   change pas entre deux ouvertures de la modale. */
let taskDefauts = null;
async function defautsSession() {
  if (taskDefauts) return taskDefauts;
  try {
    const c = await api('/config');
    /* `String(...)` — ET C'EST TOUT LE BUG. Ces cinq colonnes sont déclarées INTEGER (les
       autres réglages oui/non sont en TEXT) : SQLite rend donc 1 et non '1', et la
       comparaison stricte était toujours fausse. La case partait bien en base et revenait
       décochée — « ça ne s'enregistre pas » vu de l'écran, alors que la valeur était là. */
    const vrai = (v) => String(v) === '1';
    taskDefauts = {
      auto_push: vrai(c.task_default_auto_push),
      ask_questions: vrai(c.task_default_ask_questions),
      notify_jira: vrai(c.task_default_notify_jira),
      converge_after: vrai(c.task_default_converge),
    };
  } catch { taskDefauts = { auto_push: false, ask_questions: false, notify_jira: false, converge_after: false }; }
  return taskDefauts;
}
/* Posés APRÈS `f.reset()` et seulement sur une session NEUVE : rouvrir une session existante
   doit montrer ce qu'elle porte, pas ce qu'on aime cocher d'habitude. */
async function appliquerDefautsSession(f) {
  const d = await defautsSession();
  for (const [k, v] of Object.entries(d)) { if (f[k] && v) f[k].checked = true; }
  majLienVerifPush();
}
async function majLibelleConverge() {
  const l = $('#taskConvergeLbl');
  if (!l) return;
  const d = await defautsConvergence();
  l.textContent = tr('task.lbl.converge-after', { seuil: d.seuil, passes: d.passes });
}

/* A/Dev IA 2 — « LES MÊMES PROJETS QUE LA DERNIÈRE FOIS ». Avec quarante dépôts, la ligne
   proposée d'office était le premier de la liste : faux trente-neuf fois sur quarante. Trois
   sessions sur quatre dépôts font douze sélections par jour, toujours les mêmes. On retient
   donc le dernier jeu PAR SAVEUR (coder et explorer n'ont pas les mêmes habitudes), retenu à
   la CRÉATION et pas à la saisie : un formulaire abandonné ne fait pas une habitude.
   Les branches ne sont pas reprises — elles, elles changent à chaque fois. */
const PROJETS_MEMO = 'aidevtools_task_projets';
const projetsMemo = () => { try { return JSON.parse(localStorage.getItem(PROJETS_MEMO) || '{}'); } catch { return {}; } };
function memoriserProjets(kind, cibles) {
  const ids = [...new Set((cibles || []).map((t) => Number(t.repo_id)).filter(Boolean))];
  if (!ids.length) return;
  try { localStorage.setItem(PROJETS_MEMO, JSON.stringify({ ...projetsMemo(), [kind]: ids })); } catch { /* ignore */ }
}
/* Un dépôt retiré depuis (désactivé, supprimé) est écarté en silence : proposer une ligne
   qui ne peut pas être choisie serait pire que ne rien proposer. */
function lignesProposees(kind) {
  const ids = (projetsMemo()[kind] || []).filter((id) => repoOptions.some((r) => r.id === Number(id)));
  return ids.length ? ids.map((id) => ({ repo_id: Number(id) })) : [{}];
}

/* LES SESSIONS D'AGENT REPRENABLES, proposées. Le champ attendait un identifiant qu'on allait
   chercher dans un terminal ; l'outil les connaît toutes. Chargées UNE fois par page et
   seulement quand le bloc « Avancé » sert — c'est une liste de confort, pas un écran. */
let sessionsAgent = null;
async function remplirSessionsAgent() {
  const box = $('#taskSessionPick');
  if (!box) return;
  if (!sessionsAgent) {
    try { sessionsAgent = await api('/agent-sessions'); } catch { sessionsAgent = []; }
  }
  box.hidden = !sessionsAgent.length;
  if (!sessionsAgent.length) { box.innerHTML = ''; return; }
  box.innerHTML = `<span class="muted">${esc(tr('task.session-pick.intro'))}</span> `
    + sessionsAgent.slice(0, 6).map((x) => `<button type="button" class="btn btn-sm" data-sesskey="${esc(x.key)}"
        title="${esc(tr('task.session-pick.title', { where: x.where || '', when: x.when ? depuis(x.when) : '' }))}">${esc(String(x.label || x.key).slice(0, 40))}</button>`).join('');
}
document.addEventListener('click', (e) => {
  const b = e.target.closest && e.target.closest('[data-sesskey]');
  if (!b) return;
  const champ = $('#taskSessionId');
  if (champ) { champ.value = b.dataset.sesskey; champ.focus(); }
});

async function openTaskModal(kind = taskKind) {
  editingTaskId = null; launchAfterCreate = false; cleJiraDeLaSession = null;
  /* A18 — un essai n'est valable que pour LA session qu'on ouvre : sans cet oubli, la suivante
     repartirait avec un profil que personne n'a redemandé (le piège des skills cochés, §5.6). */
  essaiAgent = null;
  const bandeauEssai = $('#taskAgentEssai');
  if (bandeauEssai) bandeauEssai.hidden = true;
  const f = $('#taskForm');
  f.reset(); resetTaskFiles();
  taskKind = kind;
  if (kind !== 'local' && kind !== 'ask') await loadRepoOptions();
  if (kind === 'local') { localPicks = ['']; await loadLocalRoots(); }
  applyKindToModal(kind);
  if (kind !== 'local' && kind !== 'ask') { renderTargetRows(lignesProposees(kind)); setupTaskJira(''); }
  if (kind === 'code') renderCtxRepoRows([]);
  if (kind !== 'ask') await majVerificateursSession('');
  await appliquerDefautsSession(f);
  remplirSessionsAgent();
  $('#taskModalTitle').textContent = KIND_LABEL[kind].title;
  $('#taskExistingImgs').textContent = '';
  boutonsCreation();
  showTaskModal();
  f.prompt.focus();
}

// Depuis une MR : session de codage sur la branche de la MR, créée ET lancée.
/* Affiche la modale de session. Passe obligé de TOUS les points d'entrée (nouvelle session,
   depuis une MR, depuis un ticket, édition) : la mention sous le champ « identifiant de session »
   ne vaut que pour l'ouverture qui l'a posée, et cinq appelants qui pensent à l'effacer, c'est
   un sixième qui oubliera. */
function showTaskModal() {
  // Ce que le disque offre dépend des dépôts choisis : on le relit à chaque ouverture.
  majSkillsSession();
  rendreComboAgentSession();
  const hint = $('#taskSessionHint');
  if (hint && !hint.dataset.keep) { hint.textContent = ''; hint.hidden = true; }
  if (hint) delete hint.dataset.keep;
  $('#taskModal').hidden = false;
}

async function openTaskForMr(m, opts = {}) {
  const f = $('#taskForm');
  f.reset(); resetTaskFiles();
  editingTaskId = null; taskKind = 'code';
  await loadRepoOptions();
  applyKindToModal('code');
  // branche de travail = la branche de la MR ; départ = sa branche cible
  renderTargetRows([{ repo_id: m.repo_id, branch: m.source_branch, base_branch: m.target_branch }]);
  renderCtxRepoRows([]);
  setupTaskJira(m.source_branch);
  if (opts.prompt) f.prompt.value = opts.prompt;
  if (opts.commitMessage && f.commit_message) f.commit_message.value = opts.commitMessage;
  /* Reprendre la session de codage d'origine évite à l'IA de redécouvrir un code qu'elle vient
     d'écrire. Le champ est PRÉ-REMPLI, pas verrouillé : le lien est déduit de (dépôt, branche),
     ce qui n'est pas une preuve — la branche a pu être reprise à la main. On voit donc ce qui
     sera repris, et il suffit de vider le champ pour repartir d'une session neuve. */
  if (f.session_id) f.session_id.value = opts.sessionId || '';
  const hint = $('#taskSessionHint');
  if (hint && opts.sessionId) { hint.textContent = tr('task.session-id.from-mr'); hint.hidden = false; hint.dataset.keep = '1'; }
  /* §0 — LES DEUX ENTRÉES LES PLUS FRÉQUENTES DE LA MODALE ne rafraîchissaient jamais
     « Vérifier après » : le sélecteur restait vide, ou gardait la liste de l'ouverture
     précédente — celle d'autres dépôts. On le remplit ici, comme le fait une ouverture neuve. */
  await majVerificateursSession('');
  /* A20 — LES DÉFAUTS DE SESSION S'APPLIQUENT AUSSI ICI. Les cases réglées une fois pour toutes
     (pousser, poser des questions, prévenir Jira, reviewer après) n'étaient posées que par
     « Nouvelle session » et « depuis une note » : depuis une merge request ou un ticket — les
     deux entrées les plus fréquentes — on repartait de zéro et on recochait à la main. */
  await appliquerDefautsSession(f);
  $('#taskModalTitle').textContent = opts.title || `Faire coder l'IA sur ${m.source_branch}`;
  $('#taskExistingImgs').textContent = tr('task.from-mr', { branch: m.source_branch, iid: m.iid });
  boutonsCreation();
  showTaskModal();
  f.prompt.focus();
}

/* Depuis un ticket Jira : ouvre la modale de codage déjà remplie du contexte du ticket.
   Même mécanique que `openTaskForMr`, mais la source est le ticket : on récupère son
   contenu (summary + description convertie en Markdown) et on le met en tête du prompt,
   comme le fait le bouton « Récupérer » de la modale — un seul format de contexte à
   maintenir. La branche est proposée d'après la clé du ticket, jamais imposée. */
/* Le dernier dépôt choisi POUR UN PROJET JIRA. Confort pur, mémorisé dans ce navigateur : le
   perdre ne fait perdre que la proposition. Retenu à la création, pas à l'ouverture — un
   formulaire abandonné ne fait pas une habitude. */
const DEPOT_JIRA_MEMO = 'aidevtools_jira_depot';
const memoDepotJira = () => { try { return JSON.parse(localStorage.getItem(DEPOT_JIRA_MEMO) || '{}'); } catch { return {}; } };
function memoriserDepotJira(cle, repoId) {
  const projet = String(cle || '').split('-')[0].toUpperCase();
  if (!projet || !repoId) return;
  try {
    const m = memoDepotJira(); m[projet] = repoId;
    localStorage.setItem(DEPOT_JIRA_MEMO, JSON.stringify(m));
  } catch { /* stockage indisponible : on perd le confort, pas la fonction */ }
}
// La clé du ticket dont la modale de session est issue, le temps de la création.
let cleJiraDeLaSession = null;

