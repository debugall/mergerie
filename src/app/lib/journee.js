'use strict';
/* « LANCER MA JOURNÉE » (cockpit, étape 4) : des tickets Jira cochés le matin, une session de codage chacun,
   lancée tout de suite — sans ouvrir la fenêtre de session ticket par ticket.

   Le ticket écrit sa session, comme « Faire coder l'IA » : ses jetons `&&dépôt:branche<départ` (description,
   commentaire « #tech ») posent les dépôts, ses lignes `&&> …` la demande ; le contexte du ticket ouvre le
   prompt. Ce que la fenêtre ferait choisir — la chaîne de validation, son skill, son scénario, « l'IA peut
   poser des questions » — vient d'une session MODÈLE choisie une fois (la dernière qui avait la bonne
   chaîne). Un ticket qui ne nomme aucun dépôt n'est pas deviné : il est rendu, avec la raison, pour être
   ouvert à la main.

   COÛT JIRA : un appel par ticket (le ticket et sa première page de commentaires viennent ensemble). La liste
   « mes tickets » : un appel pour l'identité (mémorisée) et une page de recherche. */
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

const MAX_TICKETS = 20;
const CLE = /^[A-Z][A-Z0-9_]+-\d+$/;

const slug = (texte) => String(texte || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean).slice(0, 6).join('-').slice(0, 40);

async function lireTicket(cfg, key) {
  if (demoMode.isDemo()) {
    const d = demoJira.issue(key);
    const marqueur = jira.marqueurTech(cfg);
    const tech = jira.commentaireTech((d.comments || []).map((c) => c.bodyMd), marqueur);
    return { key: d.key, summary: d.summary, ...jira.demandeTicket({ summary: d.summary, descriptionMd: d.descriptionMd || '', techMd: tech, techMarker: marqueur }) };
  }
  const issue = await jira.fetchIssue(cfg, key);
  return { key: issue.key, summary: issue.summary, ...jira.demandeTicket(issue) };
}

/* Une session pour un ticket : ses dépôts et leurs branches depuis les jetons, la demande depuis `&&>`. */
function sessionPourTicket(ticket, modele) {
  const depots = db.prepare('SELECT id, project FROM repo WHERE enabled = 1').all();
  const texte = `${ticket.context || ''}\n${ticket.demande || ''}`;
  const r = JETONSRT.resoudreJetonsDepots(texte, depots);
  if (!r.voulus.size) return { erreur: t('cockpit.journee.no-repo') };
  const defaut = `feature/${ticket.key}${slug(ticket.summary) ? `-${slug(ticket.summary)}` : ''}`;
  const targets = [...r.voulus.entries()].map(([repoId, j]) => ({
    repo_id: repoId, branch: j.branche || r.globale || defaut, base_branch: j.depart || r.globaleDepart || '',
  }));
  const demande = String(ticket.demande || '').trim() || t('cockpit.journee.default-request', { key: ticket.key });
  const prompt = JETONSRT.retirerJetonsDepots(`${t('task.jira.context-header', { key: ticket.key })}\n\n${String(ticket.context || '').trim()}\n\n---\n\n${demande}`);
  const avecChaine = !!(modele && modele.verify_chain);
  const champs = champsDeSession({
    kind: 'code', prompt, targets, label: `${ticket.key} ${ticket.summary || ''}`.trim().slice(0, 120),
    commit_message: `${ticket.key} ${ticket.summary || ''}`.trim(), auto_push: avecChaine || !!(modele && modele.auto_push),
    ask_questions: !!(modele && modele.ask_questions),
  });
  return { champs, modele: avecChaine ? modele : null };
}

/* Les tickets cochés, l'un après l'autre : une session créée et lancée chacun — ou la raison du refus. */
async function lancerJournee({ keys, modeleId }) {
  const cles = [...new Set((keys || []).map((k) => String(k || '').trim().toUpperCase()).filter((k) => CLE.test(k)))].slice(0, MAX_TICKETS);
  if (!cles.length) throw new Error(t('cockpit.journee.no-ticket'));
  const cfg = getConfig();
  if (!demoMode.isDemo() && !jira.isConfigured(cfg)) throw new Error(t('err.jira.not-configured'));
  const modele = modeleId ? db.prepare("SELECT * FROM task WHERE id = ? AND kind = 'code'").get(Number(modeleId)) : null;
  const lancees = []; const ignores = [];
  for (const key of cles) {
    try {
      const ticket = await lireTicket(cfg, key);
      const s = sessionPourTicket(ticket, modele);
      if (s.erreur) { ignores.push({ key, raison: s.erreur }); continue; }
      const id = tasks.creerTask(s.champs);
      if (s.modele) {
        db.prepare('UPDATE task SET verify_chain = ?, verify_chain_skill = ?, verify_chain_scenario = ? WHERE id = ?')
          .run(s.modele.verify_chain, s.modele.verify_chain_skill || null, s.modele.verify_chain_scenario || null, id);
      }
      jobs.startTaskJob(id, 'run');
      lancees.push({ key, task_id: Number(id) });
    } catch (e) {
      ignores.push({ key, raison: String(e.message).split('\n')[0] });
    }
  }
  return { lancees, ignores, jira_calls: demoMode.isDemo() ? 0 : cles.length };
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

module.exports = { lancerJournee, mesTickets, sessionPourTicket };
