'use strict';
/* LE PLUGIN JENKINS — l'ancien onglet, extrait du cœur sans rien perdre : voir et lancer des
   jobs, lier un job à un dépôt, suivre la fin des builds lancés d'ici, le badge du jour, la
   notification bureau, la section « CI rouge » du brief, les boutons sur les merge requests,
   les branches et les sessions. Tout passe par le ctx : rien d'ici n'importe `src/`.

   Ce fichier est la table des matières : chaque morceau vit dans `src/` (serveur) ou `ui/`
   (navigateur), et `activate` les relie. */
const dict = require('./ui/i18n');
const { creerClient } = require('./src/client');
const veille = require('./src/veille');
const demo = require('./src/demo');
const { monterRoutes } = require('./src/routes');

const MIGRATIONS = [
  /* B8 : quel job déploie quel dépôt. `param` : le nom du paramètre qui reçoit la branche.
     Même forme que la table `repo_jenkins` du cœur d'avant, que le cœur a renommée une fois. */
  { version: 1, up: `CREATE TABLE IF NOT EXISTS plugin_jenkins_link (
      id INTEGER PRIMARY KEY,
      repo_id INTEGER NOT NULL,
      job_path TEXT NOT NULL,
      param TEXT,
      UNIQUE(repo_id, job_path)
    )` },
];

let desabonner = [];

async function activate(ctx) {
  ctx.i18n.register('fr', dict.fr);
  ctx.i18n.register('en', dict.en);
  ctx.db.migrate(MIGRATIONS);
  ctx.db.classify('plugin_jenkins_link', 'L');

  const client = creerClient(ctx);
  const cfg = () => ({ ...ctx.settings.get(), jenkins_token: ctx.secrets.get('jenkins_token') });
  veille.configurer({ client, ctx, cfg });

  /* L'écran : l'onglet (replié d'office, comme Git, Docker et Liens), son sous-onglet de
     réglages, ses pastilles, ses actions sur les objets du cœur, sa section du brief, le genre
     de lien de todo « build », la palette, la notification de fin de build. */
  ctx.ui.registerTab({
    id: 'jenkins', label: 'Jenkins', title: 'Jenkins : voir l’état des jobs et les lancer', icon: 'i-pipeline',
    position: 'before:links', foldedByDefault: true, searchField: '#jenkinsSearch', list: '#jenkinsBox',
    onboarding: { label: 'Jenkins', i18n: 'jenkins.onboard' },
    badgeLegend: { i18n: 'jenkins.badge.legend' },
    i18n: { label: 'jenkins.nav', title: 'jenkins.tab.title' },
  });
  ctx.ui.registerSettingsTab({ id: 'jenkinscfg', label: 'Jenkins', title: 'Connexion Jenkins : URL, utilisateur et jeton d’API', followsTab: 'jenkins', schemaForm: false, i18n: { label: 'jenkins.settings.sub', title: 'jenkins.settings.title' } });
  ctx.ui.registerAction({ id: 'run-job', target: 'mr', label: 'Lancer le job lié', i18n: 'jenkins.mr.run-title' });
  ctx.ui.registerAction({ id: 'verif-job', target: 'verification', label: 'Lancer le job lié', i18n: 'jenkins.mr.run-title' });
  ctx.ui.registerAction({ id: 'branch-job', target: 'branch', label: 'Ouvrir le job lié', i18n: 'jenkins.branch.title' });
  ctx.ui.registerAction({ id: 'session-ci', target: 'session-target', label: 'Reprendre la console', i18n: 'jenkins.followup.btn' });
  ctx.ui.registerDecorator({ id: 'ci-badge-mr', target: 'mr-badge' });
  ctx.ui.registerDecorator({ id: 'ci-badge-branch', target: 'branch-badge' });
  ctx.ui.registerDecorator({ id: 'ci-badge-session', target: 'session-target-badge' });
  ctx.ui.registerDecorator({ id: 'repo-sheet-jobs', target: 'repo-sheet' });
  ctx.ui.registerBriefSection({ id: 'ci-rouge', label: 'CI rouge sur mes branches', icon: 'alert', i18n: 'jenkins.brief.title' });
  /* Un service de PRÉSENCE : tant que Jenkins est actif, `jenkins.status` existe (le nom du plugin est ajouté par `register`) ; le chargeur le retire
     à la désactivation. Un plugin qui vit des événements jenkins.job.* (jenkins-teams-notify) sait ainsi
     dire « Jenkins est éteint » dans ses réglages, sans dépendre d'autre chose que de ce nom. */
  ctx.services.register('status', () => ({ active: true, configured: ctx.settings.get('jenkins_url') ? true : false }));
  ctx.ui.registerLinkKind({ kind: 'build', label: 'Build Jenkins', icon: 'pipeline' });
  ctx.notify.registerKind({ type: 'jenkins_done', label: 'Un job Jenkins que j’ai lancé s’est terminé', default: true, i18n: 'jenkins.notif.setting' });
  /* La palette : les jobs RATTACHÉS à un dépôt — la seule liste de jobs que le serveur connaisse
     sans appeler Jenkins, et la palette ne doit jamais appeler le CI de l'équipe. */
  ctx.ui.registerPaletteProvider((q, limite) => {
    const motif = `%${String(q || '').trim().replace(/[%_]/g, (c) => `\\${c}`)}%`;
    const lignes = q.trim()
      ? ctx.db.prepare("SELECT DISTINCT job_path FROM plugin_jenkins_link WHERE job_path LIKE ? ESCAPE '\\' ORDER BY job_path LIMIT ?").all(motif, limite)
      : ctx.db.prepare('SELECT DISTINCT job_path FROM plugin_jenkins_link ORDER BY job_path LIMIT ?').all(limite);
    return lignes.map((r) => ({ label: ctx.i18n.t('jenkins.palette.open', { job: r.job_path }), ref: r.job_path, nav: { jenkins_path: r.job_path }, text: `${r.job_path} jenkins build ci` }));
  });

  // Un dépôt retiré emporte ses jobs liés — ce que faisait la clé étrangère `ON DELETE CASCADE`.
  desabonner.push(ctx.repos.onRemoved((r) => { ctx.db.prepare('DELETE FROM plugin_jenkins_link WHERE repo_id = ?').run(r.id); }));

  monterRoutes(ctx, { client, demo, veille, cfg });

  /* La veille de fond : une minute, et rien n'est demandé à Jenkins tant qu'aucun lancement
     n'est attendu. Pas en démo — comme avant. */
  ctx.schedule(60_000, () => veille.tourJenkins(cfg()));

  // La démo : deux jobs rattachés à deux dépôts, pour le bouton des merge requests et la palette.
  ctx.demo.seed((c) => {
    const par = Object.fromEntries(c.repos.list().map((r) => [r.project, r.id]));
    const poser = c.db.prepare('INSERT OR IGNORE INTO plugin_jenkins_link (repo_id, job_path, param) VALUES (?, ?, ?)');
    if (par['groupe/api-core']) poser.run(par['groupe/api-core'], 'boutique/api-build', 'BRANCHE');
    if (par['groupe/webapp-front']) poser.run(par['groupe/webapp-front'], 'boutique/front-build', 'BRANCHE');
  });
}

async function deactivate() {
  for (const off of desabonner) { try { off(); } catch { /* déjà parti */ } }
  desabonner = [];
  veille.oublierTout();
}

module.exports = { activate, deactivate, MIGRATIONS };
