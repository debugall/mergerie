'use strict';
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

// Charge le .env du projet par chemin ABSOLU, AVANT tout require qui lit l'env
// (copilot lit COPILOT_ARGS, gitlab lit GITLAB_*). Robuste quel que soit le
// répertoire de lancement, la façon de lancer (npm/node), ET la version de Node
// (process.loadEnvFile n'existe qu'à partir de Node 20.12 -> parseur de secours).
function loadEnv(file) {
  if (!fs.existsSync(file)) {
    /* On ne l'annonce QUE s'il n'y en a pas non plus dans le dossier courant : celui-là est
       déjà chargé par `--env-file-if-exists` au démarrage du processus. Sous `npx`, la racine
       du paquet est un cache sans `.env` — annoncer « absent » juste après avoir écrit un
       `.env` dans le dossier de l'utilisateur ne serait pas faux, seulement incompréhensible. */
    if (!fs.existsSync(path.resolve('.env'))) {
      console.log(`.env absent (${file}) — variables d'environnement uniquement`);
    }
    return;
  }
  if (typeof process.loadEnvFile === 'function') {
    process.loadEnvFile(file);
    console.log(`.env chargé (natif) depuis ${file}`);
    return;
  }
  // Parseur minimal pour Node < 20.12
  const txt = fs.readFileSync(file, 'utf8');
  let n = 0;
  for (const raw of txt.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) { process.env[key] = val; n += 1; }
  }
  console.log(`.env chargé (fallback, ${n} variables) depuis ${file}`);
}
loadEnv(path.join(__dirname, '..', '.env'));
/* LE `.env` DU DOSSIER COURANT CHOISIT LE BINAIRE DE L'AGENT. Lancé depuis un dépôt cloné (le
   `.env` d'un autre), `COPILOT_BIN` ou `COPILOT_ARGS` y désignent ce qui sera EXÉCUTÉ à chaque
   review. On ne le refuse pas — c'est aussi là que l'utilisateur de `npx` met le sien —, on le
   dit au démarrage, avec la valeur, pour qu'il se voie. */
{
  const ici = path.resolve('.env');
  if (ici !== path.join(__dirname, '..', '.env') && fs.existsSync(ici)) {
    try {
      const lignes = fs.readFileSync(ici, 'utf8').split('\n').map((l) => l.trim())
        .filter((l) => /^(COPILOT_BIN|COPILOT_ARGS)\s*=/.test(l));
      if (lignes.length) {
        console.warn(`⚠ le .env du dossier courant (${ici}) choisit l'agent lancé par Mergerie : ${lignes.join(' ; ')}`);
        console.warn('  Vérifiez que ce .env est bien le vôtre et non celui d’un dépôt cloné.');
      }
    } catch { /* illisible : rien à dire de plus que ce que le chargement dira */ }
  }
}

const { app } = require('./app/app');
const store = require('./data/store');
const datasync = require('./data/datasync');
const proc = require('./core/proc');
const approbation = require('./data/approbation');
const identite = require('./core/identite');
const configModule = require('./data/config');
const { getConfig, updateConfig } = configModule;
const i18n = require('./core/i18n');
const retention = require('./session/retention');
const notes = require('./notes/notes');
const { t } = i18n;
const git = require('./git/git');
const demoDocker = require('./demo/docker');
const veille = require('./integrations/veille');
const verifyrun = require('./verify/verifyrun');
const copilot = require('./agent/copilot');
const agentprofile = require('./agent/profile');
const agentschedule = require('./agent/schedule');
const jobs = require('./jobs');

/* L'ORDRE DE MONTAGE EST LA SÉCURITÉ DU SERVEUR (réorganisation de src/ par couches). Chaque fichier de
   `app/middleware/` s'accroche à l'application quand on le charge : la ligne où il est chargé
   est la place qu'il prend dans la chaîne. Les en-têtes d'abord, pour que même un refus les
   porte ; la garde d'origine avant tout ce qui lit une requête ; le mémo de requête, la langue et
   l'écriture du dépôt avant les routes ; les lecteurs de corps et les fichiers statiques en
   dernier. */
require('./app/middleware/entetes');
const { JETON_ACCES } = require('./app/middleware/origine');
require('./app/middleware/jeton-local');
require('./app/middleware/memo-requete');
require('./app/middleware/langue');
require('./app/middleware/ecriture-depot');
require('./app/middleware/corps');

/* LES ROUTES, un fichier par domaine, chargés dans l'ordre alphabétique. Express fait jouer
   l'ordre de déclaration sur les chemins qui se recouvrent (`/api/x/:id` avalerait
   `/api/x/liste` déclaré après lui) : au découpage, chaque paire « motif / chemin littéral »
   de même méthode a été relue, et aucune n'a changé d'ordre. Une nouvelle route littérale sous
   un préfixe qui porte un motif se déclare dans le fichier du motif, avant lui. */
require('./app/routes/activite');
require('./app/routes/agent-passes');
require('./app/routes/agents');
require('./app/routes/config');
require('./app/routes/data-sync');
require('./app/routes/docker');
require('./app/routes/git');
require('./app/routes/git-compare');
require('./app/routes/git-merge');
require('./app/routes/jenkins');
require('./app/routes/jira');
require('./app/routes/jobs');
require('./app/routes/links');
require('./app/routes/local-tasks');
require('./app/routes/mrs');
require('./app/routes/mrs-commentaires');
require('./app/routes/mrs-resume');
require('./app/routes/notes');
require('./app/routes/pieces');
require('./app/routes/programmation');
require('./app/routes/questions');
require('./app/routes/repos');
require('./app/routes/rules');
require('./app/routes/statut');
require('./app/routes/tasks');
require('./app/routes/tasks-actions');
require('./app/routes/tasks-iterations');
require('./app/routes/tasks-liste');
require('./app/routes/verifications');
require('./app/routes/verifiers');
require('./app/middleware/erreurs');

const { restartJiraWatch, arreterJiraWatch } = require('./app/lib/jira');
const { nommerBranches } = require('./app/lib/branches');
const planification = require('./app/planification');
const { restartAutoRefresh } = planification;

const PORT = Number(process.env.PORT || 4319);

// Bind sûr par défaut : localhost SEULEMENT. HOST=0.0.0.0 est un opt-in explicite pour exposer
// sur le réseau (voir la section Sécurité du README).
const HOST = process.env.HOST || '127.0.0.1';

// L'avertissement porte sur « ce n'est PAS une boucle locale », pas sur l'égalité à 0.0.0.0 :
// HOST est un nom très répandu (tcsh, PaaS, images CI) et n'importe quelle valeur héritée de
// l'environnement (`::`, une IP de LAN…) expose l'app, qui n'a aucune authentification.
let retentionTimer = null;

let archiveTimer = null;

const LOOPBACK = ['127.0.0.1', 'localhost', '::1'];

const HOST_EXPOSED = !LOOPBACK.includes(HOST);

// IPv6 : l'hôte doit être crocheté dans l'URL (http://[::1]:4319).
const HOST_SHOWN = HOST === '0.0.0.0' ? 'localhost' : (HOST.includes(':') ? `[${HOST}]` : HOST);

/* ARRÊTER LE SERVEUR ARRÊTE CE QU'IL A LANCÉ. Les agents, les commandes de vérificateur et git
   tournent chacun dans leur propre groupe de processus (`proc.options`) : un Ctrl-C ne les
   atteint plus directement. Sans ce relais, arrêter Mergerie laissait un agent continuer
   d'écrire dans un clone, un `npm test` de tourner, sans plus personne pour les regarder. */
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => {
    proc.tuerTout('SIGTERM');
    setTimeout(() => { proc.tuerTout('SIGKILL'); process.exit(0); }, 500);
  });
}

/* EXPOSÉ SANS JETON, ON NE DÉMARRE PAS. Un avertissement dans la console ne protégeait
   personne : l'outil n'a pas de comptes, et quiconque joignait le port pilotait les agents du
   poste avec ses jetons. Le refus dit quoi faire. */
if (HOST_EXPOSED && !JETON_ACCES) {
  console.error(`✗ HOST=${HOST} ouvre Mergerie au réseau, et il n'a pas de comptes : définis MERGERIE_ACCESS_TOKEN (une longue chaîne aléatoire) pour exiger un jeton, ou retire HOST pour rester sur localhost.`);
  process.exit(1);
}

const server = app.listen(PORT, HOST, () => {
  console.log(`Mergerie sur http://${HOST_SHOWN}:${server.address().port}`);
  if (HOST_EXPOSED) console.log(`  ⚠ exposé hors de localhost (HOST=${HOST}) — accès par jeton (MERGERIE_ACCESS_TOKEN), page /acces`);
  console.log(`  copilot : ${copilot.COPILOT_BIN} ${[...copilot.EXTRA_ARGS, '-p', '"<prompt>"'].join(' ')}`);
  console.log(`  dry-run : ${copilot.isDryRun()}  |  COPILOT_ARGS=${JSON.stringify(process.env.COPILOT_ARGS || '')}`);
  restartAutoRefresh();
  restartJiraWatch();
  /* Les agents livrés, semés une fois. Jamais réécrits ensuite : le rôle a pu être affiné au
     fil des runs, et un semis qui écrase serait une perte silencieuse à chaque redémarrage. */
  try { agentprofile.seedBuiltins(); } catch (e) { console.log(`[agents] ${e.message}`); }
  agentschedule.demarrer((m) => console.log(`[agents] ${m}`));
  // Les sessions et suivis programmés à une date : même cadence, même forme.
  jobs.programmation.demarrer((m) => console.log(`[programmation] ${m}`));
  /* LA SYNCHRONISATION DU DÉPÔT DE DONNÉES. Sans URL configurée, `demarrer()` rend `false` et
     rien ne tourne : le mode mono-poste est exactement ce cas, et il ne coûte pas un timer. */
  /* EN DÉMO, LE DÉPÔT DE DONNÉES EXISTE VRAIMENT. Sans lui, la section « Données partagées »
     afficherait « mode mono-poste », le pied de page se tairait et le bouton « Historique »
     d'une page de notes resterait caché : on montrerait la fonctionnalité en la décrivant. */
  if (process.env.MERGERIE_DEMO === '1') {
    try {
      // eslint-disable-next-line global-require
      const origine = require('./demo/shared').preparer((m) => console.log(m));
      if (origine) updateConfig({ data_repo_url: origine, data_repo_branch: 'main' });
    } catch (e) { console.log(`[demo] dépôt de données : ${e.message}`); }
  }
  /* CE QUI RESTAIT À ÉCRIRE. La file a survécu à l'arrêt — elle est dans la base : on la vide
     avant toute chose, pour que le dépôt reparte complet même après une coupure en plein vol. */
  try {
    const retard = store.ecouler();
    if (retard.ecrits || retard.supprimes) {
      console.log(`  données partagées : ${retard.ecrits} fichier(s) réécrit(s), ${retard.supprimes} retiré(s) après l’arrêt`);
    }
  } catch (e) { console.log(`[store] ${e.message}`); }
  /* LES CLONES D'AVANT portaient le jeton de la forge dans `origin` : on le retire de ceux qui
     dorment, sans attendre leur prochain fetch. */
  git.nettoyerOrigines(getConfig())
    .then((n) => { if (n) console.log(`  clones : jeton retiré de ${n} adresse(s) d'origin`); })
    .catch((e) => console.log(`[git] nettoyage des origines : ${e.message}`));
  /* L'EXISTANT EST APPROUVÉ UNE FOIS, avant que la synchro n'apporte quoi que ce soit : sans ça,
     la montée de version bloquerait d'un coup tous les vérificateurs et agents de l'utilisateur. */
  try {
    const repris = approbation.reprendreLExistant(getConfig);
    if (repris) console.log(`  approbations : ${repris} objet(s) existant(s) repris tels quels`);
  } catch (e) { console.log(`[approbation] ${e.message}`); }
  /* CE CODE EN SAIT-IL PLUS QU'HIER ? L'hydratation est incrémentale : un réglage d'équipe ajouté
     par une nouvelle version n'est jamais lu si le fichier qui le porte a déjà été hydraté par
     l'ancienne. On relit donc tout une fois quand la signature du format change — après avoir
     écoulé la file, pour que ce qui attendait localement soit déjà dans les fichiers. */
  try {
    const rattrapage = datasync.rattraperFormat();
    if (rattrapage) {
      console.log(`  données partagées : format relu après montée de version — ${rattrapage.ecrits} ligne(s) reprise(s)`);
    }
  } catch (e) { console.log(`[store] rattrapage de format : ${e.message}`); }
  if (datasync.demarrer()) {
    console.log(`  données partagées : ${getConfig().data_repo_url} (${getConfig().data_sync_seconds}s)`);
    if (!identite.identite().ok) console.log('  ⚠ git n’a pas de `user.name` — rien ne sera commité tant qu’il manque');
    datasync.tour().catch(() => {});
  }
  verifyrun.gcWorktrees((m) => console.log(`[verify] ${m}`));
  // Ménage de l'historique : au démarrage, puis une fois par jour.
  retentionTimer = retention.demarrer(
    () => getConfig().retention_days,
    (m) => console.log(`[retention] ${m}`),
  );
  // Les todos faites depuis plus de sept jours quittent la liste — sans jamais être supprimées.
  archiveTimer = notes.demarrerArchivage((m) => console.log(`[notes] ${m}`));
  /* La veille de fond : conteneurs tombés, builds Jenkins lancés d'ici et terminés depuis.
     Une minute — la cadence de ce qu'on surveille, pas celle d'un tableau de bord —, et rien
     n'est demandé à Jenkins tant qu'aucun lancement n'est attendu. */
  if (!demoDocker.isDemo()) veille.demarrer({ getConfig, periodeMs: 60000 });
  // Santé des liens : opt-in, par environnement, et seulement si un client regarde.
});

/* Exporté pour les tests de bout en bout : ils lancent le serveur EN PROCESSUS
   (PORT=0 → port libre attribué par l'OS) et l'arrêtent proprement à la fin.
   Le démarrage reste identique en usage normal (`node src/server.js`). */
module.exports = {
  app,
  server,
  /* Exportée pour les tests : elle ANNOTE des lignes de branches avec ce que la base sait
     (ticket, verdict, session, job Jenkins). La route complète, elle, parle à la forge et au
     clone — la passer par un faux GitLab pour vérifier trois annotations n'éprouverait que le
     faux GitLab. */
  nommerBranches,
  close() {
    planification.arreterAutoRefresh();
    // Un timer oublié garde le process en vie : la suite de tests ne rendrait jamais la main.
    arreterJiraWatch();
    if (retentionTimer) { clearInterval(retentionTimer); retentionTimer = null; }
    if (archiveTimer) { clearInterval(archiveTimer); archiveTimer = null; }
    veille.arreter();
    // Même raison pour le tic des horaires d'agents.
    agentschedule.arreter();
    jobs.programmation.arreter();
    return new Promise((resolve) => server.close(resolve));
  },
};
