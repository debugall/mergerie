'use strict';
/* « LANCER MA JOURNÉE » (cockpit, étape 4) : des tickets Jira cochés le matin, une session de codage chacun —
   lancée tout de suite, ou enregistrée pour être lancée plus tard, ticket par ticket.

   Le ticket écrit sa session, comme « Faire coder l'IA » : ses jetons `&&dépôt:branche<départ` (description,
   commentaire « #tech ») posent les dépôts, ses lignes `&&> …` la demande ; le contexte du ticket ouvre le
   prompt. Un ticket qui ne nomme aucun dépôt n'est pas deviné : la fenêtre les fait saisir. Ce que la fenêtre
   de session ferait choisir — la chaîne de validation, son skill, son scénario, « l'IA peut poser des
   questions » — vient d'une session MODÈLE. La session garde la clé du ticket (`task.jira_key`).

   COÛT JIRA : un appel par ticket, à la préparation ; créer ou lancer n'en fait aucun. La liste « mes
   tickets » : un appel pour l'identité (mémorisée) et une page de recherche. */
const db = require('../../db');
const { getConfig } = require('../../data/config');
const { t } = require('../../core/i18n');
const jira = require('../../integrations/jira');
const demoMode = require('../../demo/mode');
const demoJira = require('../../demo/jira');
const tasks = require('../../agent/tasks');
const jobs = require('../../jobs');
const JETONSRT = require('../../../public/runtime/jetons-runtime.js');
const { champsDeSession } = require('./sessions');
const { exigerProprietaire } = require('./partage');
const { jobEnCoursPour } = require('../../jobs/ordonnanceur');

const MAX_TICKETS = 20;
const CLE = /^[A-Z][A-Z0-9_]+-\d+$/;

const slug = (texte) => String(texte || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean).slice(0, 6).join('-').slice(0, 40);

/* Le ticket, lu UNE fois : ce que la session en tire (demande, contexte) et ce que la fenêtre en montre
   (statut, description, commentaire « #tech », commentaires) pour choisir ses dépôts. */
async function lireTicket(cfg, key) {
  if (demoMode.isDemo()) {
    const d = demoJira.issue(key);
    const marqueur = jira.marqueurTech(cfg);
    const comments = (d.comments || []).map((c) => ({ author: c.author || '', created: c.created || '', bodyMd: c.bodyMd || '' }));
    const tech = jira.commentaireTech(comments.map((c) => c.bodyMd), marqueur);
    return {
      key: d.key, summary: d.summary, status: d.status || '', descriptionMd: d.descriptionMd || '', techMd: tech || '', comments, url: '',
      ...jira.demandeTicket({ summary: d.summary, descriptionMd: d.descriptionMd || '', techMd: tech, techMarker: marqueur }),
    };
  }
  const issue = await jira.fetchIssue(cfg, key);
  return {
    key: issue.key, summary: issue.summary, status: issue.status || '', descriptionMd: issue.descriptionMd || '', techMd: issue.techMd || '',
    comments: issue.comments || [], url: jira.issueUrl(cfg, issue.key), ...jira.demandeTicket(issue),
  };
}

/* Les dépôts que le TEXTE du ticket nomme sans jeton (« paiement », « grp/paiement ») : des suggestions, jamais
   posées d'office. Le nom court compte s'il fait au moins trois lettres et tombe sur une frontière de mot. */
function depotsCites(texte, depots) {
  const bas = String(texte || '').toLowerCase();
  const echapper = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return depots.filter((d) => {
    const complet = String(d.project || '').toLowerCase();
    const court = complet.split('/').pop();
    return [complet, court].some((n) => n.length >= 3 && new RegExp(`(^|[^a-z0-9_-])${echapper(n)}($|[^a-z0-9_-])`).test(bas));
  });
}

/* Un ticket préparé : ses dépôts et leurs branches depuis les jetons (vides s'il n'en nomme aucun — la fenêtre
   les fait saisir), la demande depuis `&&>`, la branche proposée par défaut. Aucune session créée. */
function preparerTicket(ticket) {
  const depots = db.prepare('SELECT id, project FROM repo WHERE enabled = 1').all();
  const texte = `${ticket.context || ''}\n${ticket.demande || ''}`;
  const r = JETONSRT.resoudreJetonsDepots(texte, depots);
  const defaut = `feature/${ticket.key}${slug(ticket.summary) ? `-${slug(ticket.summary)}` : ''}`;
  const projet = (id) => (depots.find((d) => d.id === id) || {}).project || '';
  const targets = [...r.voulus.entries()].map(([repoId, j]) => ({
    repo_id: repoId, project: projet(repoId), branch: j.branche || r.globale || defaut, base_branch: j.depart || r.globaleDepart || '',
  }));
  const demande = String(ticket.demande || '').trim() || t('cockpit.journee.default-request', { key: ticket.key });
  const prompt = JETONSRT.retirerJetonsDepots(`${t('task.jira.context-header', { key: ticket.key })}\n\n${String(ticket.context || '').trim()}\n\n---\n\n${demande}`);
  const pris = new Set(targets.map((g) => g.repo_id));
  const texteTicket = [ticket.summary, ticket.descriptionMd, ticket.techMd, ...(ticket.comments || []).map((c) => c.bodyMd)].join('\n');
  return {
    key: ticket.key, summary: ticket.summary || '', prompt, branche_defaut: defaut, targets,
    manque: targets.length ? null : t('cockpit.journee.no-repo'),
    suggestions: depotsCites(texteTicket, depots).filter((d) => !pris.has(d.id)).slice(0, 8).map((d) => ({ repo_id: d.id, project: d.project })),
    ticket: {
      status: ticket.status || '', url: ticket.url || '', description: ticket.descriptionMd || '', tech: ticket.techMd || '',
      comments: (ticket.comments || []).slice(-20),
    },
  };
}

const clesValables = (keys) => [...new Set((keys || []).map((k) => String(k || '').trim().toUpperCase()).filter((k) => CLE.test(k)))].slice(0, MAX_TICKETS);

/* Les tickets lus un par un (un appel Jira chacun) et préparés — rien n'est créé : la fenêtre montre les
   dépôts trouvés, fait saisir ceux qui manquent, puis crée (et lance, ou non) ticket par ticket. */
async function preparerJournee({ keys }) {
  const cles = clesValables(keys);
  if (!cles.length) throw new Error(t('cockpit.journee.no-ticket'));
  const cfg = getConfig();
  if (!demoMode.isDemo() && !jira.isConfigured(cfg)) throw new Error(t('err.jira.not-configured'));
  const tickets = []; const erreurs = [];
  for (const key of cles) {
    try { tickets.push(preparerTicket(await lireTicket(cfg, key))); }
    catch (e) { erreurs.push({ key, raison: String(e.message).split('\n')[0] }); }
  }
  return { tickets, erreurs, jira_calls: demoMode.isDemo() ? 0 : cles.length };
}

/* Une session par ticket préparé — sans appel Jira : le prompt et les dépôts viennent de la fenêtre. La
   chaîne de validation et « …puis converger » sont ceux de la session modèle ; `lancer` faux = enregistrée,
   prête à lancer (son « Lancer » convergera alors aussi). */
function creerSessions({ sessions, modeleId, lancer }) {
  const modele = modeleId ? db.prepare("SELECT * FROM task WHERE id = ? AND kind = 'code'").get(Number(modeleId)) : null;
  const avecChaine = !!(modele && modele.verify_chain);
  const creees = []; const ignores = [];
  for (const x of (sessions || []).slice(0, MAX_TICKETS)) {
    const key = String((x && x.key) || '').trim().toUpperCase();
    try {
      if (!CLE.test(key)) throw new Error(t('cockpit.journee.no-ticket'));
      const targets = (x.targets || []).filter((g) => g && Number(g.repo_id));
      if (!targets.length) throw new Error(t('cockpit.journee.no-repo'));
      const titre = `${key} ${x.summary || ''}`.trim();
      const champs = champsDeSession({
        kind: 'code', prompt: x.prompt, label: titre.slice(0, 120), commit_message: titre,
        targets: targets.map((g) => ({ repo_id: Number(g.repo_id), branch: String(g.branch || '').trim(), base_branch: String(g.base_branch || '').trim() })),
        auto_push: avecChaine || !!(modele && modele.auto_push), ask_questions: !!(modele && modele.ask_questions),
      });
      const id = tasks.creerTask(champs);
      db.prepare('UPDATE task SET jira_key = ?, verify_chain = ?, verify_chain_skill = ?, verify_chain_scenario = ? WHERE id = ?')
        .run(key, avecChaine ? modele.verify_chain : null, avecChaine ? modele.verify_chain_skill || null : null, avecChaine ? modele.verify_chain_scenario || null : null, id);
      const converger = !!(modele && modele.converge_after);
      db.prepare('UPDATE task SET converge_after = ? WHERE id = ?').run(converger ? 1 : 0, id);
      if (lancer && converger) jobs.startConvergeSessionJob(id, {});
      else if (lancer) jobs.startTaskJob(id, 'run');
      creees.push({ key, task_id: Number(id), lancee: !!lancer });
    } catch (e) {
      ignores.push({ key, raison: String(e.message).split('\n')[0] });
    }
  }
  return { creees, ignores };
}

/* Tout d'un coup, depuis des clés (l'API, les scripts) : préparer puis lancer ce qui nomme ses dépôts. */
async function lancerJournee({ keys, modeleId }) {
  const p = await preparerJournee({ keys });
  const prets = p.tickets.filter((x) => x.targets.length);
  const r = creerSessions({ sessions: prets, modeleId, lancer: true });
  return {
    lancees: r.creees.map((c) => ({ key: c.key, task_id: c.task_id })),
    ignores: [...p.tickets.filter((x) => !x.targets.length).map((x) => ({ key: x.key, raison: x.manque })), ...p.erreurs, ...r.ignores],
    jira_calls: p.jira_calls,
  };
}

/* « Supprimer » un élément du cockpit : la session et celles du même ticket. Une session en cours bloque
   tout (rien n'est supprimé) ; celle d'un collègue aussi. */
function supprimerElement(taskId) {
  const t0 = db.prepare('SELECT * FROM task WHERE id = ?').get(Number(taskId));
  if (!t0) throw new Error(t('err.session-introuvable'));
  const lignes = t0.jira_key ? db.prepare("SELECT * FROM task WHERE jira_key = ? AND kind = 'code'").all(t0.jira_key) : [t0];
  for (const l of lignes) {
    exigerProprietaire('task', l);
    if (jobEnCoursPour(l.id)) throw new Error(t('cockpit.delete.running', { id: l.id }));
  }
  for (const l of lignes) tasks.supprimerTask(l.id);
  return { supprimees: lignes.map((l) => l.id) };
}

/* « Mes tickets » non terminés : une page de recherche sur l'identité Jira du compte. */
let moi = null;
async function mesTickets() {
  if (demoMode.isDemo()) return demoJira.tickets([], false, [], [], []).issues.map((i) => ({ key: i.key, summary: i.summary, status: i.status }));
  const cfg = getConfig();
  if (!jira.isConfigured(cfg)) throw new Error(t('err.jira.not-configured'));
  if (!moi || moi.url !== cfg.jira_url) moi = { url: cfg.jira_url, id: (await jira.myself(cfg)).accountId };
  const r = await jira.searchByAssignees(cfg, { accountIds: [moi.id], includeDone: false, max: 1 });
  return (r.issues || []).map((i) => ({ key: i.key, summary: i.summary, status: i.status }));
}

module.exports = { creerSessions, depotsCites, lancerJournee, mesTickets, preparerJournee, preparerTicket, supprimerElement };
