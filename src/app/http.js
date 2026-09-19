'use strict';
/* Ce que toutes les routes partagent : `wrap`, qui transforme une exception en réponse, et les lectures d’un dépôt ou d’une MR par identifiant.
   Extrait de server.js (refacto.md, étape 2) : les corps sont ceux du serveur, au mot près. */
const db = require('../db');
const configModule = require('../data/config');
const { getConfig, updateConfig } = configModule;
const i18n = require('../core/i18n');
const { t } = i18n;
const converge = require('../review/converge');
const configagent = require('../data/configagent');
const git = require('../git/git');
const path = require('path');
const fs = require('fs');

/* Le statut par défaut est 400 : la quasi-totalité des refus sont des saisies invalides.
   Une erreur peut le SURCHARGER en portant `.status` — c'est ainsi qu'un objet absent rend
   un 404 plutôt qu'un 400, distinction dont le front a besoin pour dire « supprimée entre
   temps » au lieu de « saisie invalide ». */
const wrap = (fn) => (req, res) => Promise.resolve().then(() => fn(req, res)).catch((e) => {
  const status = e.code === 'BUSY' ? 409 : (Number.isInteger(e.status) && e.status >= 400 && e.status < 600 ? e.status : 400);
  /* `code` : un refus que l'écran doit pouvoir RECONNAÎTRE pour proposer autre chose qu'un
     toast rouge. Chercher un mot dans le message ne marcherait pas — il est traduit. */
  res.status(status).json({
    error: e.message, ...(e.code ? { code: e.code } : {}),
    // CONFIG_AGENT : ce qu'il faut montrer, et ce qu'il faut renvoyer pour dire « j'ai vu ».
    ...(e.code === 'CONFIG_AGENT' ? { files: e.fichiers || [], empreinte: e.empreinte || null } : {}),
    // Ce que l'écran doit montrer pour décider (la version actuelle d'une page, son auteur…).
    ...(e.extra && typeof e.extra === 'object' ? e.extra : {}),
  });
});
/* LA BRANCHE D'AUTRUI RÉÉCRIT-ELLE LES RÈGLES DE L'AGENT ? (configagent.js) Vérifié AVANT de
   lancer, sur les références déjà là — sans réseau, pour que l'écran puisse demander tout de
   suite. Le job refait la vérification après son fetch : ce qui a été poussé entre-temps n'y
   échappe pas. `accept_agent_config` = l'empreinte que l'utilisateur a vue et acceptée. */
async function gardeConfigAgent(repo, branche, base, body) {
  if (!repo || !branche) return;
  const cwd = git.cloneDirFor(getConfig(), repo);
  if (!fs.existsSync(path.join(cwd, '.git'))) return;
  if (!(await git.refExists(cwd, `origin/${branche}`))) return;
  const b = base || await git.defaultBranch(cwd).catch(() => null);
  if (!b) return;
  const examen = await configagent.examiner(cwd, `origin/${b}`, `origin/${branche}`);
  if (!examen.fichiers.length || configagent.accepte(repo, branche, examen.empreinte)) return;
  if (body && body.accept_agent_config && body.accept_agent_config === examen.empreinte) {
    configagent.accepter(repo, branche, examen.empreinte);
    return;
  }
  const e = configagent.erreur(t('err.agent-config.touched', { branch: branche, files: examen.fichiers.join(', ') }), examen);
  e.status = 409;
  throw e;
}
// Options de convergence depuis un body : réglages globaux par défaut, surcharge
// ponctuelle (seuil /10 et plafond de passes), bornés à [1,10]. Partagé MR + session.
function parseConvergeOpts(body) {
  const def = converge.convergeDefaults();
  const opts = { threshold: def.threshold, maxPasses: def.maxPasses };
  const b = body || {};
  if (b.threshold != null && b.threshold !== '') {
    const th = parseFloat(String(b.threshold).replace(',', '.'));
    if (Number.isFinite(th)) opts.threshold = Math.min(10, Math.max(1, th));
  }
  if (b.maxPasses != null && b.maxPasses !== '') {
    const mp = parseInt(b.maxPasses, 10);
    if (Number.isFinite(mp)) opts.maxPasses = Math.min(10, Math.max(1, mp));
  }
  return opts;
}
function repoById(id) {
  return db.prepare('SELECT * FROM repo WHERE id = ?').get(id);
}
function mrById(id) {
  return db.prepare(`
    SELECT mr.*, repo.project AS project, repo.url AS url, repo.branch_pattern AS branch_pattern, repo.forge AS forge
    FROM mr JOIN repo ON repo.id = mr.repo_id WHERE mr.id = ?`).get(id);
}
function readFileSafe(p) {
  try { return p && fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null; } catch { return null; }
}
function ticketUrl(cfg, key) {
  return (cfg.jira_url && key) ? `${cfg.jira_url}/browse/${key}` : null;
}

module.exports = {
  wrap, gardeConfigAgent, parseConvergeOpts, repoById, mrById, readFileSafe, ticketUrl,
};
