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

const express = require('express');
const db = require('./db');
const { REVIEWS_DIR, TICKETS_DIR, TASKS_DIR, NOTES_DIR, TMP_DIR, ensureDir } = require('./paths');
const { extractNote } = require('./note');
const { etat: etatLocal, pref: prefLocale } = require('./localstate');
const localdirs = require('./localdirs');
const localsession = require('./localsession');
const store = require('./store');
const datasync = require('./datasync');
const garde = require('./garde');
const { nonFiable } = require('./nonfiable');
const proc = require('./proc');
const approbation = require('./approbation');
const identite = require('./identite');
const verifierenv = require('./verifierenv');
const registre = require('./store-registry');
const configModule = require('./config');
const { getConfig, updateConfig } = configModule;
const i18n = require('../public/i18n-runtime.js');
const gitops = require('./gitops');
const jira = require('./jira');
const glob = require('./glob');
const notify = require('./notify');
const gitgraph = require('./gitgraph');
const docx = require('./docx');
const { pMap } = require('./pmap');
const backup = require('./backup');
const retention = require('./retention');
const notes = require('./notes');
const brief = require('./brief');
const links = require('./links');
const { t } = i18n;
const { discoverAll } = require('./discover');
const jobs = require('./jobs');
const reviewer = require('./reviewer');
const prompts = require('./prompts');
const gitmerge = require('./gitmerge');
const converge = require('./converge');
const configagent = require('./configagent');
const forge = require('./forge');
const git = require('./git');
const demoGit = require('./demo-git');
const docker = require('./docker');
const demoDocker = require('./demo-docker');
const demoJenkins = require('./demo-jenkins');
const jenkins = require('./jenkins');
const veille = require('./veille');
const diffnum = require('./diffnum');   // A7 : sur quelles lignes un commentaire peut s'accrocher
const demoDiff = require('./demo-diff');
const verifyLib = require('./verify');
const verifyrun = require('./verifyrun');
const demoJira = require('./demo-jira');
const demoComments = require('./demo-comments');
const { StringDecoder } = require('node:string_decoder');
const aisession = require('./aisession');
const agentsession = require('./agentsession');
const agentpass = require('./agentpass');
const localsnapshot = require('./localsnapshot');
const localcoder = require('./localcoder');
const pieces = require('./pieces');
const localrepos = require('./localrepos');
const copilot = require('./copilot');
const dictation = require('./dictation');
const skillscan = require('./skillscan');
const tasks = require('./tasks');
const agentprofile = require('./agentprofile');
const agentknowledge = require('./agentknowledge');
const agentschedule = require('./agentschedule');
const protocol = require('./protocol');
const demoAgents = require('./demo-agents');

const app = express();

/* ============ D'OÙ VIENT CETTE REQUÊTE ? ============
   Mergerie n'écoute que sur la boucle locale, mais ça ne protège de rien ici : c'est TON
   navigateur qui émet, et n'importe quelle page ouverte dans un autre onglet peut lui faire
   poster chez nous. Un simple `<form method="POST" action="http://127.0.0.1:4319/api/…">`
   part sans préflight (formulaire = requête « simple ») et, sur les 130 routes mutantes, les
   45 qui ne lisent pas leur corps s'exécutent telles quelles : effacer tous les rapports,
   publier tes commentaires en attente sur une vraie merge request avec ton jeton, lancer un
   agent sur tes dossiers. Le code étant publié, la liste des routes n'est un secret pour
   personne.

   La règle : une requête qui ÉCRIT et qui annonce une origine étrangère est refusée. Les
   requêtes de l'application portent l'origine de l'application ; un formulaire tiers porte la
   sienne, et se fait renvoyer. On n'exige PAS que l'en-tête soit présent : `curl`, un script
   maison ou l'onglet « Commandes » n'en envoient pas, et refuser les requêtes sans origine
   casserait des usages légitimes sans rien empêcher — un navigateur, lui, en envoie toujours
   un sur une requête cross-site.

   Les lectures passent : elles ne changent rien, et la réponse n'est de toute façon pas
   lisible par la page tierce (pas de CORS ici). */
/* LA PORTE, AVANT TOUT LE RESTE (voir `src/garde.js`).
 *
 * 1. `Host` : sans elle, une page qui re-résout son nom vers 127.0.0.1 devient « même origine »
 *    et lit toute l'API. 421 et non 403 : c'est le code de « tu t'adresses au mauvais serveur »,
 *    et le message nomme la variable qui corrige un reverse-proxy légitime.
 * 2. `Sec-Fetch-Site` sur `/api/` : une page d'un autre site n'a rien à y lire.
 * 3. Le jeton d'accès, quand le poste est ouvert au réseau. */
const EXPOSE = !garde.estBoucle(process.env.HOST || '127.0.0.1');
const JETON_ACCES = String(process.env.MERGERIE_ACCESS_TOKEN || '');
app.disable('x-powered-by');

/* LES EN-TÊTES DE TOUTE RÉPONSE — posés EN PREMIER, pour que même un refus et la page d'accès
   les portent.
 *
 * Une POLITIQUE DE CONTENU d'abord : seuls les scripts servis par l'application s'exécutent. Un
 * rendu qui laisserait passer une balise — un titre de merge request, un rapport venu du dépôt
 * partagé — ne pourrait plus rien lancer : il n'y a pas de script en ligne à autoriser, et il n'y
 * en a aucun dans la page (le thème est un fichier). Les styles en ligne restent admis : l'écran
 * en porte partout, et un style ne lance rien. `frame-ancestors 'none'` : personne ne met
 * Mergerie dans un cadre pour faire cliquer à travers.
 * `nosniff` : un fichier servi n'est lu que selon son type déclaré. `no-referrer` : l'adresse
 * d'un écran de Mergerie ne part pas vers les liens qu'on y suit. */
const POLITIQUE = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'",
  /* `https:` pour les images SEULEMENT : l'icône d'un type de ticket vient du serveur Jira, et une
     image ne s'exécute pas. Les scripts, eux, ne viennent que d'ici. */
  "img-src 'self' data: blob: https:", "object-src 'none'", "base-uri 'none'",
  "frame-ancestors 'none'", "form-action 'self'",
].join('; ');
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', POLITIQUE);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

app.use((req, res, next) => {
  if (garde.hoteAutorise(req.headers.host)) return next();
  res.status(421).json({ error: i18n.t('err.hote-inconnu', { host: garde.nomHote(req.headers.host) }) });
});
app.use((req, res, next) => {
  if (!req.path.startsWith('/api/') || !garde.siteEtranger(req)) return next();
  res.status(403).json({ error: i18n.t('err.origine-etrangere') });
});
if (EXPOSE) {
  /* La page d'accès et son envoi sont les SEULES choses servies sans jeton. Le formulaire arrive
     en urlencoded : on le lit à la main plutôt que d'ouvrir un analyseur de plus à tout le
     serveur. */
  app.get('/acces', (req, res) => res.type('html').send(garde.pageAcces()));
  app.post('/acces', express.urlencoded({ extended: false, limit: '2kb' }), (req, res) => {
    if (!garde.memeJeton((req.body || {}).jeton, JETON_ACCES)) {
      return res.status(401).type('html').send(garde.pageAcces({ erreur: 'Jeton incorrect.' }));
    }
    /* HttpOnly : aucun script ne le lit. SameSite=Strict : aucun autre site ne le fait voyager. */
    res.setHeader('Set-Cookie', `${garde.COOKIE}=${encodeURIComponent(JETON_ACCES)}; HttpOnly; SameSite=Strict; Path=/`);
    return res.redirect(303, '/');
  });
  app.use((req, res, next) => {
    if (garde.memeJeton(garde.jetonPresente(req), JETON_ACCES)) return next();
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: i18n.t('err.acces-requis') });
    return res.redirect(303, '/acces');
  });
}

const MUTANTES = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
function memeOrigine(req) {
  const brut = req.headers.origin;
  if (!brut) return true;                       // pas de navigateur derrière : rien à trancher
  let hote;
  try { hote = new URL(brut).host; } catch { return false; }   // origine illisible = refus
  return hote === req.headers.host;
}
app.use((req, res, next) => {
  if (!MUTANTES.has(req.method) || memeOrigine(req)) return next();
  res.status(403).json({ error: i18n.t('err.origine-etrangere') });
});

/* Mémo d'UNE requête : la table des dernières vérifications par merge request, qui balaie
   trois cents lignes. Déclaré ICI, au-dessus du middleware qui le vide, plutôt qu'à côté de la
   fonction qui le remplit huit cents lignes plus bas : un état de module doit se lire là où on
   le remet à zéro. */
let cacheVerifs = null;

/* Les mémos qui ne valent que le temps d'une requête sont vidés ICI, en entrée. Les garder
   plus longtemps ferait servir un instantané périmé — une vérification qui vient de finir
   resterait invisible —, les recalculer à chaque appel referait N fois le même balayage sur
   une liste de sessions. */
app.use((req, res, next) => { cacheVerifs = null; next(); });

/* LA LANGUE DE L'ÉCRAN, POUR LA DURÉE DE LA REQUÊTE. Elle vit dans le navigateur, pas en base :
   ce qui se règle dans l'interface doit valoir tout de suite, y compris pour les libellés que
   le serveur fabrique (messages d'erreur, jeu de démo). Sans cet en-tête, passer l'écran en
   anglais laissait « Mes dépôts (démo) » en français au milieu d'un onglet traduit.
   Un état de module suffit : Mergerie est mono-utilisateur, une requête à la fois côté écran.
   L'absence d'en-tête (appel direct à l'API, script) retombe sur la langue enregistrée. */
app.use((req, res, next) => {
  const l = String(req.headers['x-mergerie-lang'] || '').trim();
  i18n.setLang(l === 'en' || l === 'fr' ? l : getConfig().language);
  next();
});

/* ÉCRIRE LES FICHIERS DU DÉPÔT APRÈS CHAQUE REQUÊTE QUI A ÉCRIT.
 *
 * Les déclencheurs de `db.js` notent toute ligne partagée touchée, d'où que vienne l'écriture.
 * On écoule cette file quand la réponse est PARTIE : l'utilisateur n'attend pas l'écriture de
 * ses fichiers, et une erreur de disque ne transforme pas une sauvegarde réussie en erreur 500.
 *
 * La file vivant dans la base, dans la même transaction que l'écriture, rien ne se perd si le
 * processus meurt entre les deux : le démarrage suivant écrit ce qui manque.
 *
 * `res.on('finish')` et non un `await` : une requête de lecture — et il y en a des dizaines par
 * seconde — trouve une file vide et ne coûte qu'un `SELECT COUNT(*)`. */
app.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  res.on('finish', () => {
    try { if (store.enRetard()) store.ecouler(); } catch (e) { console.log(`[store] ${e.message}`); }
  });
  return next();
});

app.use(express.json({ limit: '20mb' })); // marge pour les captures de ticket (base64)
/* L'AUDIO DE LA DICTÉE arrive en corps BRUT, pas en multipart : Express 4 ne sait pas lire un
   multipart sans dépendance, et les métadonnées d'un segment (numéro, contexte, langue)
   tiennent très bien dans la query. Dix mégaoctets, soit un peu plus de cinq minutes de PCM
   16 kHz mono — au-delà, ce n'est plus de la dictée dans un champ. Le corps n'est JAMAIS
   écrit sur disque ni journalisé : il est relayé au moteur et libéré à la réponse. */
app.use(express.raw({ type: 'audio/wav', limit: '10mb' }));
/* Fichiers statiques. `no-cache` = le navigateur peut mettre en cache mais DOIT
   revalider avant chaque usage (requête conditionnelle → 304 si inchangé, contenu
   frais sinon). Évite le piège « je ne vois pas mes changements » sans forcer un
   rechargement complet à chaque fois : un simple refresh récupère la dernière version. */
app.use(express.static(path.join(__dirname, '..', 'public'), {
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
}));

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

/* ---------- Statut / config ---------- */
// Flux d'événements notifiables : le client passe le dernier id vu (?after=), on
// renvoie les nouveaux + le dernier id (pour ne rejouer aucun événement).
app.get('/api/notifications', wrap((req, res) => {
  res.json({ events: notify.since(req.query.after), latest: notify.latestId() });
}));

app.get('/api/status', wrap((req, res) => {
  res.json({
    demo: process.env.MERGERIE_DEMO === '1', // mode démo : données fictives, bannière affichée
    dryRun: copilot.isDryRun(),
    copilotAvailable: copilot.binaryAvailable(),
    copilotBin: copilot.COPILOT_BIN,
    copilotArgs: copilot.EXTRA_ARGS,
    copilotCmdPreview: `${copilot.COPILOT_BIN} ${[...copilot.EXTRA_ARGS, '-p', '"<prompt>"'].join(' ')}`,
    job: jobs.currentJob(),
    running: jobs.isRunning(),
    // Objets en cours de traitement : le front marque la carte concernée (cf. P9).
    targets: jobs.runningTargets(),
    queued: jobs.queueCount(),
    autoRefreshMinutes: Number(getConfig().auto_refresh_minutes) || 0,
    jenkinsRefreshMinutes: Number(getConfig().jenkins_refresh_minutes) || 0,
    jiraConfigured: jira.isConfigured(getConfig()), // pilote l'UI « enrichir depuis Jira »
    githubConfigured: forge.isConfigured(getConfig(), 'github'), // pilote l'UI « ajout en masse depuis GitHub »
    /* CE QUI ATTEND UNE DÉCISION CHEZ LES AGENTS : les versions de connaissance produites par
       un rafraîchissement et jamais validées. Le badge de l'onglet existait dans le HTML et
       n'était jamais rempli — un compteur mort, invisible pour toujours. Une version en
       attente est exactement ce qu'on doit voir sans ouvrir l'onglet : l'agent continue de
       travailler sur l'ANCIENNE carte tant que personne ne relit la nouvelle. */
    agentsPending: (db.prepare("SELECT COUNT(*) c FROM agent_knowledge WHERE status = 'pending'").get() || {}).c || 0,
  });
}));

/* A37 — LE DÉLAI DE CYCLE : ouverture → première review → merge.
 *
 * C'est la métrique PRODUIT qui manquait à un outil qui s'annonce « from prompt to merge » :
 * toutes les autres disent ce que l'IA a fait, aucune ne dit si les merge requests avancent
 * plus vite. Les trois dates sont en base — `gitlab_created_at` (ouverture),
 * `review_version.created_at` (première review), `feed.mr_merged` (merge) — et personne ne les
 * rapprochait.
 *
 * MÉDIANE et non moyenne : une merge request oubliée trois mois fausse une moyenne et ne dit
 * rien du quotidien. Et on ne compte que ce qui est ALLÉ AU BOUT : une MR encore ouverte n'a
 * pas de délai, elle a un âge — les mélanger ferait baisser le chiffre à chaque nouvelle MR. */
function delaiDeCycle(projet, depuis) {
  /* LA DATE DE MERGE VIENT DE LA FORGE quand on l'a : c'est l'instant réel, le même pour toute
     l'équipe. Le journal d'activité reste en secours pour l'existant — il ne dit que « quand CE
     poste s'en est aperçu », ce qui ne vaut rien chez le voisin et n'existe pas du tout sur un
     poste qui vient de rejoindre. */
  const lignes = db.prepare(`SELECT mr.id, repo.project, mr.iid, mr.gitlab_created_at,
      (SELECT MIN(rv.created_at) FROM review_version rv WHERE rv.mr_id = mr.id) AS first_review,
      COALESCE(mr.merged_at,
        (SELECT MAX(f.at) FROM feed f WHERE f.type = 'mr_merged' AND f.mr_iid = mr.iid AND f.project = repo.project)) AS merged_at
    FROM mr JOIN repo ON repo.id = mr.repo_id
    WHERE (? = '' OR repo.project = ?)`).all(projet, projet)
    .filter((r) => r.gitlab_created_at && r.merged_at && (!depuis || r.merged_at >= depuis));
  if (!lignes.length) return null;

  const heures = (a, b) => (Date.parse(b) - Date.parse(a)) / 3600000;
  const mediane = (xs) => {
    const v = xs.filter((x) => Number.isFinite(x) && x >= 0).sort((a, b) => a - b);
    if (!v.length) return null;
    const m = Math.floor(v.length / 2);
    return Math.round((v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2) * 10) / 10;
  };
  const parProjet = {};
  for (const r of lignes) {
    const p = parProjet[r.project] || (parProjet[r.project] = { project: r.project, total: [], review: [], apres: [] });
    p.total.push(heures(r.gitlab_created_at, r.merged_at));
    if (r.first_review) {
      p.review.push(heures(r.gitlab_created_at, r.first_review));
      p.apres.push(heures(r.first_review, r.merged_at));
    }
  }
  const projets = Object.values(parProjet).map((p) => ({
    project: p.project, n: p.total.length,
    total_h: mediane(p.total), to_review_h: mediane(p.review), to_merge_h: mediane(p.apres),
  })).sort((a, b) => (b.total_h || 0) - (a.total_h || 0));
  return {
    n: lignes.length,
    total_h: mediane(lignes.map((r) => heures(r.gitlab_created_at, r.merged_at))),
    to_review_h: mediane(lignes.filter((r) => r.first_review).map((r) => heures(r.gitlab_created_at, r.first_review))),
    to_merge_h: mediane(lignes.filter((r) => r.first_review).map((r) => heures(r.first_review, r.merged_at))),
    projets,
  };
}

// Statistiques pour le dashboard (agrégées localement).
/* A36 — UNE PÉRIODE, ET UN DÉPÔT. La route ne lisait AUCUN paramètre : chaque bloc avait sa
 * propre fenêtre, figée et différente des autres — huit semaines ici, vingt-huit jours là,
 * toute l'histoire ailleurs. On ne pouvait donc ni comparer deux blocs entre eux, ni répondre
 * à « et le mois dernier ? », ni isoler un dépôt.
 *
 * `days` (0 = tout l'historique) et `project` s'appliquent à ce qui se DATE et à ce qui se
 * rattache à un dépôt. Les compteurs d'état (le funnel) restent globaux : « à traiter » n'a pas
 * d'âge, c'est un état courant, et le borner dans le temps ne voudrait rien dire. */
app.get('/api/stats', wrap((req, res) => {
  const jours = Math.max(0, Number(req.query.days) || 0);
  const projet = String(req.query.project || '').trim();
  const depuis = jours ? new Date(Date.now() - jours * 86400000).toISOString() : null;
  const dansPeriode = (iso) => !depuis || (iso && String(iso) >= depuis);
  const duProjet = (p) => !projet || p === projet;

  // Funnel des statuts de MR
  const funnel = { to_review: 0, reviewed: 0, done: 0 };
  db.prepare(`SELECT mr.status, COUNT(*) c FROM mr
    JOIN repo ON repo.id = mr.repo_id
    WHERE (? = '' OR repo.project = ?) GROUP BY mr.status`).all(projet, projet)
    .forEach((r) => { if (r.status in funnel) funnel[r.status] = r.c; });

  // Reviews + projet + note (note_value, sinon extraite du .md pour les anciennes)
  const reviews = db.prepare(`
    SELECT review.md_path, review.note_value, review.created_at, repo.project AS project
    FROM review JOIN mr ON mr.id = review.mr_id JOIN repo ON repo.id = mr.repo_id`).all()
    .filter((r) => duProjet(r.project) && dansPeriode(r.created_at));
  const rows = reviews.map((r) => {
    let v = (r.note_value != null) ? r.note_value : null;
    if (v == null) { const n = extractNote(readFileSafe(r.md_path)); v = n ? n.value : null; }
    return { project: r.project, created_at: r.created_at, note10: v == null ? null : Math.round(v * 1000) / 100 };
  });

  // Distribution des notes (échelle /10)
  const buckets = [
    { label: '0–2', min: 0, max: 2, count: 0 },
    { label: '2–4', min: 2, max: 4, count: 0 },
    { label: '4–6', min: 4, max: 6, count: 0 },
    { label: '6–8', min: 6, max: 8, count: 0 },
    { label: '8–10', min: 8, max: 10.01, count: 0 },
  ];
  let noNote = 0; let sum = 0; let nb = 0;
  for (const r of rows) {
    if (r.note10 == null) { noNote += 1; continue; }
    sum += r.note10; nb += 1;
    (buckets.find((x) => r.note10 >= x.min && r.note10 < x.max) || buckets[buckets.length - 1]).count += 1;
  }
  const notes = {
    buckets: buckets.map(({ label, count }) => ({ label, count })),
    noNote, total: rows.length, avg: nb ? Math.round((sum / nb) * 10) / 10 : null,
  };

  // Par projet
  const pending = {};
  db.prepare(`SELECT repo.project p, COUNT(*) c FROM mr JOIN repo ON repo.id=mr.repo_id
    WHERE mr.status='to_review' AND (? = '' OR repo.project = ?) GROUP BY repo.project`).all(projet, projet)
    .forEach((r) => { pending[r.p] = r.c; });
  const byProj = {};
  for (const r of rows) {
    const p = byProj[r.project] || (byProj[r.project] = { project: r.project, reviewed: 0, sum: 0, n: 0, worst: null });
    p.reviewed += 1;
    if (r.note10 != null) { p.sum += r.note10; p.n += 1; p.worst = p.worst == null ? r.note10 : Math.min(p.worst, r.note10); }
  }
  for (const p of Object.keys(pending)) if (!byProj[p]) byProj[p] = { project: p, reviewed: 0, sum: 0, n: 0, worst: null };
  const projects = Object.values(byProj).map((x) => ({
    project: x.project, reviewed: x.reviewed, pending: pending[x.project] || 0,
    avg: x.n ? Math.round((x.sum / x.n) * 10) / 10 : null, worst: x.worst,
  })).sort((a, b) => (a.avg == null) - (b.avg == null) || (a.avg - b.avg));

  /* Taux de résolution : sur tous les constats d'une passe qui, à la passe
     suivante, ont eu une chance d'être corrigés, la part git-vérifiée « résolu ».
     Dénominateur = résolus + persistants + disparus (tous les constats antérieurs) ;
     les « disparus » (non vérifiés) comptent au dénominateur mais jamais au
     numérateur — c'est tout l'intérêt du garde-fou. */
  const resRows = db.prepare(`SELECT repo.project project,
      SUM(COALESCE(rv.n_resolved,0)) resolved,
      SUM(COALESCE(rv.n_persistent,0)) persistent,
      SUM(COALESCE(rv.n_disappeared,0)) disappeared
    FROM review_version rv JOIN mr ON mr.id = rv.mr_id JOIN repo ON repo.id = mr.repo_id
    WHERE rv.n_resolved IS NOT NULL GROUP BY repo.project`).all();
  const resByProject = {};
  let gRes = 0, gPrior = 0;
  for (const r of resRows) {
    const prior = r.resolved + r.persistent + r.disappeared;
    resByProject[r.project] = prior ? { resolved: r.resolved, prior, rate: Math.round((r.resolved / prior) * 100) } : null;
    gRes += r.resolved; gPrior += prior;
  }
  for (const p of projects) p.resolution = resByProject[p.project] || null;

  /* Tendance de note par projet : moyenne des 28 derniers jours vs les 28 d'avant.
     ▲ / ▼ / → répond « la qualité de CE projet progresse-t-elle ? ». null si trop
     peu de données de part et d'autre (on ne montre pas une tendance sur 1 review). */
  const D28 = 28 * 86400000;
  const nowMs = Date.now();
  const trendAcc = {};
  for (const r of db.prepare(`SELECT rv.note_value nv, rv.created_at ca, repo.project pr
      FROM review_version rv JOIN mr ON mr.id = rv.mr_id JOIN repo ON repo.id = mr.repo_id
      WHERE rv.note_value IS NOT NULL`).all()) {
    if (!r.ca) continue;
    const age = nowMs - Date.parse(r.ca);
    const bucket = age <= D28 ? 'recent' : age <= 2 * D28 ? 'prev' : null;
    if (!bucket) continue;
    const a = trendAcc[r.pr] || (trendAcc[r.pr] = { recent: { s: 0, n: 0 }, prev: { s: 0, n: 0 } });
    a[bucket].s += r.nv * 10; a[bucket].n += 1;
  }
  for (const p of projects) {
    const a = trendAcc[p.project];
    if (!a || !a.recent.n || !a.prev.n) { p.trend = null; continue; }
    const delta = Math.round((a.recent.s / a.recent.n - a.prev.s / a.prev.n) * 10) / 10;
    p.trend = { delta, dir: delta > 0.2 ? 'up' : delta < -0.2 ? 'down' : 'flat' };
  }
  const resolution = gPrior ? { resolved: gRes, prior: gPrior, rate: Math.round((gRes / gPrior) * 100) } : null;

  /* Activité hebdo (8 dernières semaines), LUE SUR LES MÊMES LIGNES QUE LA TENDANCE DE LA NOTE.
     Elle comptait la table `review`, qui garde UNE ligne par merge request, écrasée à chaque
     passe et datée de la première : trois re-reviews d'une même MR n'y faisaient qu'un point,
     posé la semaine où tout avait commencé. Deux graphes côte à côte racontaient donc deux
     histoires — l'un disait « semaine calme », l'autre affichait quatre notes cette
     semaine-là. `review_version` porte une ligne par passe, datée de la passe : c'est le
     travail réellement fait, et c'est la source de son voisin. */
  const weekStart = (d) => { const dt = new Date(d); const day = (dt.getDay() + 6) % 7; dt.setHours(0, 0, 0, 0); dt.setDate(dt.getDate() - day); return dt; };
  const wc = {};
  for (const r of db.prepare(`SELECT rv.created_at FROM review_version rv
    JOIN mr ON mr.id = rv.mr_id JOIN repo ON repo.id = mr.repo_id
    WHERE (? = '' OR repo.project = ?)`).all(projet, projet)) {
    if (!r.created_at || !dansPeriode(r.created_at)) continue;
    const k = weekStart(r.created_at).toISOString().slice(0, 10);
    wc[k] = (wc[k] || 0) + 1;
  }
  const weekly = [];
  const cur = weekStart(new Date());
  for (let i = 7; i >= 0; i -= 1) { const d = new Date(cur); d.setDate(d.getDate() - i * 7); const k = d.toISOString().slice(0, 10); weekly.push({ week: k, count: wc[k] || 0 }); }

  /* Tendance de la note : moyenne par semaine (8 dernières). C'est l'évolution qui
     répond à « la qualité progresse-t-elle ? », plus parlante que la distribution
     statique. On garde le compte par semaine pour ne pas surinterpréter un point
     issu d'une seule review. Source : review_version (une note datée par passe). */
  const rvNotes = db.prepare(`SELECT rv.note_value, rv.created_at FROM review_version rv
    JOIN mr ON mr.id = rv.mr_id JOIN repo ON repo.id = mr.repo_id
    WHERE rv.note_value IS NOT NULL AND (? = '' OR repo.project = ?)`).all(projet, projet)
    .filter((r) => dansPeriode(r.created_at));
  const wsum = {};
  for (const r of rvNotes) {
    if (!r.created_at) continue;
    const k = weekStart(r.created_at).toISOString().slice(0, 10);
    (wsum[k] || (wsum[k] = { sum: 0, n: 0 })).sum += r.note_value * 10; wsum[k].n += 1;
  }
  const scoreTrend = [];
  for (let i = 7; i >= 0; i -= 1) {
    const d = new Date(cur); d.setDate(d.getDate() - i * 7); const k = d.toISOString().slice(0, 10);
    const w = wsum[k];
    scoreTrend.push({ week: k, avg: w ? Math.round((w.sum / w.n) * 10) / 10 : null, count: w ? w.n : 0 });
  }

  /* Coût en tokens (table usage). Le total est un MINORANT — le travail interne de
     l'agent reste invisible — mais la RÉPARTITION par type et l'évolution disent
     déjà où part le quota. Regroupement des kinds en libellés lisibles côté front. */
  // La période vaut ici comme ailleurs : le total d'une semaine ne compte pas la session d'il y a cent jours.
  const byKind = db.prepare(`SELECT kind, SUM(tokens_est) tokens, COUNT(*) calls FROM usage
    WHERE (? IS NULL OR created_at >= ?) GROUP BY kind`).all(depuis, depuis)
    .filter((r) => r.tokens > 0)
    .map((r) => ({ kind: r.kind, tokens: r.tokens, calls: r.calls }));
  const tokTotal = byKind.reduce((s, r) => s + r.tokens, 0);
  const twc = {};
  for (const r of db.prepare(`SELECT tokens_est, created_at FROM usage WHERE tokens_est > 0
    AND (? IS NULL OR created_at >= ?)`).all(depuis, depuis)) {
    if (!r.created_at) continue;
    const k = weekStart(r.created_at).toISOString().slice(0, 10);
    twc[k] = (twc[k] || 0) + r.tokens_est;
  }
  const tokWeekly = [];
  for (let i = 7; i >= 0; i -= 1) { const d = new Date(cur); d.setDate(d.getDate() - i * 7); const k = d.toISOString().slice(0, 10); tokWeekly.push({ week: k, tokens: twc[k] || 0 }); }
  // Coût moyen par MR reviewée : tokens des reviews ÷ nb de MR distinctes reviewées.
  const reviewTokens = (byKind.find((r) => r.kind === 'review') || {}).tokens || 0;
  const reviewedCount = db.prepare("SELECT COUNT(DISTINCT mr_id) c FROM review_version WHERE kind = 'review'").get().c
    || db.prepare("SELECT COUNT(*) c FROM mr WHERE reviewed_sha IS NOT NULL").get().c;
  const tokens = {
    total: tokTotal,
    byKind,
    weekly: tokWeekly,
    avgPerReviewedMr: reviewedCount ? Math.round(reviewTokens / reviewedCount) : null,
    isFloor: true, // le total est un minorant (travail interne de l'agent invisible)
  };

  // Dev sessions
  const taskByStatus = {};
  db.prepare('SELECT status, COUNT(*) c FROM task GROUP BY status').all().forEach((r) => { taskByStatus[r.status] = r.c; });
  const tasks = {
    byStatus: taskByStatus,
    total: db.prepare('SELECT COUNT(*) c FROM task').get().c,
    mrCreated: db.prepare('SELECT COUNT(*) c FROM task_target WHERE mr_iid IS NOT NULL').get().c,
    mrMerged: db.prepare('SELECT COUNT(*) c FROM task_target WHERE mr_merged = 1').get().c,
  };

  /* Rapports FAIBLES encore à traiter — ce que le badge orange du menu Reviews annonce.
     Restreint au stade « reviewées » : les badges de Mergerie comptent du travail en attente,
     pas des totaux. Une merge request déjà classée traitée ne demande plus rien, même si sa
     note était mauvaise ; la compter ferait un chiffre qui ne redescend jamais.
     `note_value` est normalisée sur [0,1] — 0,7 vaut donc 7/10. */
  const faibles = db.prepare(`SELECT COUNT(*) c
    FROM review JOIN mr ON mr.id = review.mr_id
    WHERE mr.status = 'reviewed' AND review.note_value IS NOT NULL AND review.note_value < 0.7`).get().c;

  /* LES SESSIONS LES PLUS COÛTEUSES. « Le coût par famille » disait combien coûtent les
     sessions ; il ne disait pas LESQUELLES. Depuis que chaque dépense porte son propriétaire,
     le classement est une requête — et un prompt qui fait relire trois dépôts pour rien se
     voit avant de se voir sur la facture. */
  /* `cost_usd` : le coût ANNONCÉ par le backend quand il en annonce un, à côté de l'estimation
     en tokens qui, elle, existe toujours. `SUM` d'une colonne nulle vaut NULL : le classement
     reste ordonné sur les tokens, seul chiffre disponible partout. */
  const topTasks = db.prepare(`SELECT u.owner_kind AS kind, u.owner_id AS id, SUM(u.tokens_est) AS tokens,
      SUM(u.cost_usd) AS cost_usd
    FROM usage u WHERE u.owner_kind IN ('task','local','ask') AND u.owner_id IS NOT NULL
      AND (? IS NULL OR u.created_at >= ?)
    GROUP BY u.owner_kind, u.owner_id ORDER BY tokens DESC LIMIT 5`).all(depuis, depuis)
    .map((r) => {
      const table = r.kind === 'ask' ? 'question' : (r.kind === 'local' ? 'local_task' : 'task');
      // Une exploration se compte comme une session `task` : sa saveur dit dans quelle liste l'ouvrir.
      const row = db.prepare(`SELECT label, prompt${table === 'task' ? ', kind AS saveur' : ''} FROM ${table} WHERE id = ?`).get(r.id) || {};
      return {
        ...r, saveur: row.saveur || null, label: row.label || '', prompt: String(row.prompt || '').slice(0, 120),
      };
    })
    .filter((r) => r.prompt || r.label);

  /* A/Stats 1 — LES REVIEWS LES PLUS CHÈRES. Les sessions portaient leur coût depuis 1.4.0,
     les reviews non : une review coûtait « la moyenne », et on ne pouvait pas dire laquelle
     avait mangé le budget. Elles portent maintenant leur propriétaire, comme les sessions —
     même requête, autre famille. */
  /* LE COÛT PAR AGENT. Un agent tourne plusieurs fois — à la main, puis sur horaire — et
     c'est la SOMME qui compte : « le documentaliste coûte trois euros par mois » est une
     phrase qu'aucune ligne de session ne donne. Vide tant qu'aucun agent n'a tourné : une
     section à zéro n'apprend rien. */
  const parAgent = db.prepare(`SELECT t.agent_name AS name, SUM(u.tokens_est) AS tokens,
      SUM(u.cost_usd) AS cost_usd, COUNT(DISTINCT t.id) AS runs
    FROM usage u JOIN task t ON t.id = u.owner_id
    WHERE u.owner_kind = 'task' AND t.agent_name IS NOT NULL
      AND (@depuis IS NULL OR u.created_at >= @depuis)
    GROUP BY t.agent_name ORDER BY tokens DESC LIMIT 10`).all({ depuis });

  const topReviews = db.prepare(`SELECT u.owner_id AS id, SUM(u.tokens_est) AS tokens
    FROM usage u WHERE u.owner_kind = 'mr' AND u.owner_id IS NOT NULL
      AND (? IS NULL OR u.created_at >= ?)
    GROUP BY u.owner_id ORDER BY tokens DESC LIMIT 5`).all(depuis, depuis)
    .map((r) => {
      const m = db.prepare(`SELECT mr.iid, mr.title, repo.project FROM mr
        JOIN repo ON repo.id = mr.repo_id WHERE mr.id = ?`).get(r.id) || {};
      return { ...r, iid: m.iid || null, title: String(m.title || '').slice(0, 120), project: m.project || '' };
    })
    .filter((r) => r.iid);

  /* A/Stats 2 — CE QU'ON ENVOIE CONTRE CE QU'ON REÇOIT. `prompt_chars` et `output_chars` sont
     écrits depuis toujours et n'étaient lus par personne. Le rapport entrée/sortie dit ce
     qu'aucun total ne dit : un gabarit obèse, ou un dépôt lié qui triple chaque prompt, se
     voient à un ratio qui s'envole — la facture, elle, ne dit que « c'est cher ». */
  const ratio = db.prepare(`SELECT kind,
      SUM(prompt_chars) AS entree, SUM(output_chars) AS sortie, COUNT(*) AS n
    FROM usage WHERE (? IS NULL OR created_at >= ?)
    GROUP BY kind HAVING SUM(output_chars) > 0 ORDER BY entree DESC`).all(depuis, depuis)
    .map((r) => ({ ...r, ratio: r.sortie ? Math.round((r.entree / r.sortie) * 10) / 10 : null }));

  /* A/Stats 3 — LES VÉRIFICATIONS, PAR DÉPÔT. Un verdict rouge se lit une MR à la fois ; la
     question « quel dépôt casse le plus ? » n'avait pas de réponse. Cousin des constats
     récurrents, et lui aussi une simple lecture de ce qui est déjà écrit. */
  const verifsParDepot = (() => {
    /* Les cibles d'une vérification vivent en JSON (`targets_json`), pas en colonnes : une
       jointure SQL n'existe pas ici. On agrège donc en JS, comme le brief le fait pour la
       péremption — et on compte UNE FOIS par dépôt et par vérification, sinon un lot de cinq
       merge requests d'un même dépôt pèserait cinq fois. */
    const parProjet = new Map();
    const nomDe = new Map();
    for (const r of db.prepare('SELECT project, id FROM repo').all()) nomDe.set(r.id, r.project);
    for (const v of db.prepare('SELECT verdict, targets_json FROM verification WHERE verdict IS NOT NULL').all()) {
      let cibles = [];
      try { cibles = JSON.parse(v.targets_json || '[]'); } catch { cibles = []; }
      const depots = [...new Set(cibles.map((c) => c.repo_id).filter(Boolean))];
      for (const id of depots) {
        const nom = nomDe.get(id);
        if (!nom || !duProjet(nom)) continue;
        const acc = parProjet.get(nom) || { project: nom, total: 0, verts: 0 };
        acc.total += 1;
        if (v.verdict === 'verified_pass') acc.verts += 1;
        parProjet.set(nom, acc);
      }
    }
    return [...parProjet.values()]
      .filter((r) => r.total >= 2)
      .map((r) => ({ ...r, taux: Math.round((r.verts / r.total) * 100) }))
      .sort((a, b) => (a.taux - b.taux) || (b.total - a.total))
      .slice(0, 8);
  })();

  /* LES CONSTATS QUI REVIENNENT. Le même constat relevé sur au moins trois merge requests d'un
     même dépôt : c'est la matière première d'une règle de review, qu'on retapait jusque-là
     dans le contexte manuel de chaque merge request. Le titre est normalisé (minuscules,
     ponctuation de fin retirée) pour que « Le numéro de carte est loggé » et « le numéro de
     carte est loggé. » comptent pour un. */
  const recurrents = db.prepare(`SELECT repo.project AS project,
      LOWER(TRIM(RTRIM(f.title, '. '))) AS titre,
      COUNT(DISTINCT f.mr_id) AS n,
      GROUP_CONCAT(DISTINCT f.file) AS fichiers,
      MAX(f.title) AS exemple
    FROM finding f JOIN mr ON mr.id = f.mr_id JOIN repo ON repo.id = mr.repo_id
    WHERE f.title IS NOT NULL AND f.title != '' AND (? = '' OR repo.project = ?)
    GROUP BY repo.id, titre HAVING n >= 3
    ORDER BY n DESC, project LIMIT 10`).all(projet, projet)
    .map((r) => ({
      project: r.project, title: r.exemple, count: r.n,
      files: String(r.fichiers || '').split(',').filter(Boolean).slice(0, 6),
    }));

  /* B14 — CE QUE GIT A FAIT, agrégé. `git_op` était la seule table de trace que Statistiques
     ignorait : « combien de branches ai-je supprimées ce mois-ci, et combien ont échoué ? »
     n'avait pas de réponse, alors que chaque ligne est écrite depuis toujours. Le taux d'échec
     est le chiffre qui sert : une suppression sur trois qui échoue dit qu'on s'attaque à des
     branches protégées, et c'est un réglage, pas une fatalité. */
  const gitOps = (() => {
    const par = new Map();
    for (const r of db.prepare(`SELECT action, status, COUNT(*) n FROM git_op
      WHERE (? IS NULL OR created_at >= ?) AND (? = '' OR project = ?)
      GROUP BY action, status`).all(depuis, depuis, projet, projet)) {
      const a = par.get(r.action) || { action: r.action, n: 0, errors: 0 };
      a.n += r.n;
      if (r.status === 'error') a.errors += r.n;
      par.set(r.action, a);
    }
    const lignes = [...par.values()].sort((a, b) => b.n - a.n);
    return {
      total: lignes.reduce((x, r) => x + r.n, 0),
      errors: lignes.reduce((x, r) => x + r.errors, 0),
      byAction: lignes.slice(0, 8),
    };
  })();

  res.json({
    funnel, notes, projects, weekly, scoreTrend, tokens, tasks, resolution,
    topTasks, topReviews, ratio, verifsParDepot, recurrents, gitOps,
    cycle: delaiDeCycle(projet, depuis),
    agentCosts: parAgent,
    lowScores: faibles,
    commentsPosted: db.prepare('SELECT COUNT(*) c FROM comment_log').get().c,
  });
}));

/* Dernier commit de chaque dépôt SUIVI, toutes branches confondues. Live et best-effort :
   un dépôt injoignable est simplement omis. Endpoint SÉPARÉ de /stats (qui reste local et
   instantané) — le dashboard le charge en asynchrone.

   « Suivi » exclut les dépôts désactivés, mais aussi ceux dont la récupération des MR est
   coupée : on ne les regarde plus, ils n'ont donc rien à faire en tête de l'activité
   récente — et l'appel à la forge qu'ils coûtaient est justement ce qu'on voulait éviter
   en les décochant. */
app.get('/api/dashboard/commits', wrap(async (req, res) => {
  const cfg = getConfig();
  if (!forge.isConfigured(cfg, 'gitlab') && !forge.isConfigured(cfg, 'github')) { res.json({ configured: false, commits: [] }); return; }
  // IFNULL : les dépôts créés avant la colonne `fetch_mrs` la portent à NULL, et sont suivis.
  const repos = db.prepare('SELECT project, forge FROM repo WHERE enabled = 1 AND IFNULL(fetch_mrs, 1) = 1').all();
  const commits = await Promise.all(repos.map(async (r) => {
    try {
      const c = await forge.clientFor(r).latestCommit(cfg, r.project);
      if (!c) return null;
      return {
        project: r.project,
        sha: c.short_id || String(c.id || '').slice(0, 8),
        title: c.title || '',
        author: c.author_name || '',
        date: c.committed_date || c.created_at || null,
        url: c.web_url || '',
      };
    } catch { return null; } // dépôt injoignable / sans droits : omis
  }));
  res.json({ configured: true, commits: commits.filter(Boolean) });
}));

/* ---------- Activité par projet sur 6 mois (onglet Statistiques) ----------

   Question posée : « quels dépôts sont vivants, lesquels dorment ? ». Le nombre de commits
   n'y répond qu'imparfaitement — un projet qui squash en fait un par merge request, un autre
   quarante pour le même travail —, donc l'écran compare les FORMES dans le temps, projet par
   projet, et non les hauteurs entre projets. Les contributeurs distincts complètent : cinquante
   commits d'une seule personne ne disent pas la même chose que cinquante de six.

   Le coût est réel (pagination de la forge), d'où le cache par mois : un mois clos ne change
   plus, seul le mois courant est rafraîchi. */
const TTL_MOIS_COURANT_MS = 30 * 60 * 1000;

/* Un dépôt tenu par un robot n'est pas un dépôt vivant. Dependabot ou Renovate y poussent
   chaque semaine : sans ce filtre, un projet abandonné garderait quatre jours d'activité par
   mois et ne serait JAMAIS signalé endormi — exactement le faux positif que le graphe existe
   pour éviter. On écarte donc leurs commits du compte, jours comme contributeurs.
   `noreply@github.com` n'est PAS un motif : les commits faits depuis l'interface web de
   GitHub par de vrais humains le portent aussi. */
const MOTIFS_BOT = [/\[bot\]/i, /\bdependabot\b/i, /\brenovate\b/i, /\bgithub-actions\b/i, /\bmergify\b/i];
const estBot = (auteur) => MOTIFS_BOT.some((re) => re.test(String(auteur || '')));

// Les 6 derniers mois, du plus ancien au plus récent, en 'YYYY-MM'.
function derniersMois(n = 6, maintenant = new Date()) {
  const out = [];
  const d = new Date(Date.UTC(maintenant.getUTCFullYear(), maintenant.getUTCMonth(), 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1));
    out.push(`${m.getUTCFullYear()}-${String(m.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}
const debutDuMois = (mois) => `${mois}-01T00:00:00.000Z`;
const finDuMois = (mois) => {
  const [a, m] = mois.split('-').map(Number);
  return new Date(Date.UTC(m === 12 ? a + 1 : a, m === 12 ? 0 : m, 1)).toISOString();
};

/* Remplit le cache d'un dépôt pour les mois manquants ou périmés. Un seul appel forge pour
   toute la plage manquante : demander mois par mois multiplierait les requêtes par six. */
/* Deux vues peuvent demander le même dépôt en même temps — la vue d'ensemble et la fenêtre
   de détail, ou simplement deux onglets. Sans garde, les deux paginent la forge en parallèle
   pour écrire la même chose. La promesse en cours est donc partagée. */
const activiteEnVol = new Map();
function majActiviteDepot(cfg, repo, mois) {
  const cle = `${repo.id}:${mois[0]}:${mois[mois.length - 1]}`;
  const enVol = activiteEnVol.get(cle);
  if (enVol) return enVol;
  const p = majActiviteDepotVrai(cfg, repo, mois).finally(() => activiteEnVol.delete(cle));
  activiteEnVol.set(cle, p);
  return p;
}

async function majActiviteDepotVrai(cfg, repo, mois) {
  const enCache = new Map(db.prepare('SELECT * FROM commit_activity WHERE repo_id = ?').all(repo.id).map((r) => [r.month, r]));
  const courant = mois[mois.length - 1];
  const now = Date.now();
  const aRefaire = mois.filter((m) => {
    const l = enCache.get(m);
    if (!l) return true;
    // Seul le mois en cours peut encore bouger : les autres sont définitifs.
    return m === courant && (now - Date.parse(l.fetched_at || 0)) > TTL_MOIS_COURANT_MS;
  });
  if (!aRefaire.length) return;

  const depuis = debutDuMois(aRefaire[0]);
  const jusqua = finDuMois(aRefaire[aRefaire.length - 1]);
  const { commits, partiel } = await forge.clientFor(repo).commitsBetween(cfg, repo.project, depuis, jusqua);

  const parMois = new Map(aRefaire.map((m) => [m, { n: 0, auteurs: new Set(), jours: new Set() }]));
  for (const c of commits) {
    if (!c.date) continue;
    if (estBot(c.author)) continue;           // cf. MOTIFS_BOT : un robot ne rend pas un dépôt vivant
    /* Les dates de la forge portent un DÉCALAGE local (`…T01:00:00+02:00`), alors que les
       bornes `since`/`until` sont en UTC. Découper la chaîne rangeait donc un commit du 1er
       à 1 h du matin dans le mois suivant celui où l'API l'avait renvoyé : il ne trouvait
       aucun seau et disparaissait sans un mot. On normalise en UTC, à la même échelle que
       les bornes. Conséquence assumée : une « journée » est une journée UTC. */
    const d = new Date(c.date);
    if (Number.isNaN(d.getTime())) continue;
    const iso = d.toISOString();
    const agg = parMois.get(iso.slice(0, 7));
    if (!agg) continue;                       // hors plage demandée : les bornes de l'API sont inclusives
    agg.n += 1;
    agg.jours.add(iso.slice(0, 10));          // une journée de travail, pas un commit de plus
    if (c.author) agg.auteurs.add(String(c.author).toLowerCase());
  }
  const ins = db.prepare(`INSERT INTO commit_activity (repo_id, month, commits, authors, active_days, partiel, fetched_at)
    VALUES (?,?,?,?,?,?,?) ON CONFLICT(repo_id, month) DO UPDATE SET
      commits = excluded.commits, authors = excluded.authors, active_days = excluded.active_days,
      partiel = excluded.partiel, fetched_at = excluded.fetched_at`);
  const at = new Date().toISOString();
  for (const [m, agg] of parMois) ins.run(repo.id, m, agg.n, agg.auteurs.size, agg.jours.size, partiel ? 1 : 0, at);
}

app.get('/api/dashboard/activity', wrap(async (req, res) => {
  const cfg = getConfig();
  const mois = derniersMois(6);
  /* En démo, l'activité est SEMÉE en base : on la lit telle quelle sans appeler de forge —
     il n'y en a pas, et l'écran doit montrer quelque chose de parlant. */
  const demo = demoDocker.isDemo();
  if (!demo && !forge.isConfigured(cfg, 'gitlab') && !forge.isConfigured(cfg, 'github')) {
    return res.json({ configured: false, months: mois, projects: [] });
  }
  // Mêmes dépôts que le classement d'activité récente : actifs ET dont on suit les MR.
  const repos = db.prepare('SELECT * FROM repo WHERE enabled = 1 AND IFNULL(fetch_mrs, 1) = 1 ORDER BY project').all();
  /* Les dépôts sont traités EN PARALLÈLE, quatre à la fois. En série, vingt dépôts de quelques
     pages chacun additionnent leurs allers-retours réseau : l'écran reste sur son squelette
     pendant des dizaines de secondes au premier chargement. Quatre, et pas davantage, parce
     qu'une forge répond aux rafales par un 429. */
  const projets = await pMap(repos, 4, async (repo) => {
    let erreur = null;
    // Best-effort, dépôt par dépôt : une forge injoignable ne doit pas vider tout l'écran.
    if (!demo) {
      try { await majActiviteDepot(cfg, repo, mois); }
      catch (e) { erreur = String(e.message).slice(0, 200); }
    }
    const lignes = new Map(db.prepare('SELECT * FROM commit_activity WHERE repo_id = ?').all(repo.id).map((r) => [r.month, r]));
    const counts = mois.map((m) => (lignes.get(m) || {}).commits || 0);
    const authors = mois.map((m) => (lignes.get(m) || {}).authors || 0);
    const days = mois.map((m) => (lignes.get(m) || {}).active_days || 0);
    return {
      repo_id: repo.id,
      project: repo.project,
      forge: repo.forge,
      counts,
      authors,
      days,
      total: counts.reduce((a, b) => a + b, 0),
      // Ce que la barre mesure : des journées travaillées, pas des commits.
      totalDays: days.reduce((a, b) => a + b, 0),
      // Contributeurs du mois le plus fourni : un maximum est plus parlant qu'une somme,
      // qui compterait la même personne six fois.
      contributeurs: Math.max(0, ...authors),
      partiel: mois.some((m) => (lignes.get(m) || {}).partiel),
      erreur,
    };
  });
  // Le plus actif d'abord : l'écran répond à « qui bouge ? », pas à l'ordre alphabétique.
  projets.sort((a, b) => b.totalDays - a.totalDays || b.total - a.total || a.project.localeCompare(b.project));
  res.json({ configured: true, months: mois, projects: projets });
}));

/* Détail d'UN dépôt sur douze mois. Le graphe d'ensemble en montre six — assez pour dire qui
   bouge —, mais juger d'une tendance demande de voir l'année : un projet calme depuis deux
   mois après dix mois soutenus ne raconte pas la même histoire qu'un projet éteint depuis un an.
   Même cache que la vue d'ensemble : les six premiers mois sont souvent déjà chargés. */
app.get('/api/dashboard/activity/:repoId', wrap(async (req, res) => {
  const repo = repoById(Number(req.params.repoId));
  if (!repo) throw new Error(t('err.projet-inconnu'));
  const cfg = getConfig();
  const mois = derniersMois(12);
  const demo = demoDocker.isDemo();
  let erreur = null;
  if (!demo) {
    try { await majActiviteDepot(cfg, repo, mois); }
    catch (e) { erreur = String(e.message).slice(0, 200); }
  }
  const lignes = new Map(db.prepare('SELECT * FROM commit_activity WHERE repo_id = ?').all(repo.id).map((r) => [r.month, r]));
  const counts = mois.map((m) => (lignes.get(m) || {}).commits || 0);
  const days = mois.map((m) => (lignes.get(m) || {}).active_days || 0);
  const authors = mois.map((m) => (lignes.get(m) || {}).authors || 0);
  res.json({
    project: repo.project,
    forge: repo.forge,
    months: mois,
    counts,
    days,
    authors,
    total: counts.reduce((a, b) => a + b, 0),
    totalDays: days.reduce((a, b) => a + b, 0),
    contributeurs: Math.max(0, ...authors),
    /* Le mois le plus fourni et le dernier mois actif : deux repères qu'on cherche à l'œil
       sur un graphe et qu'il vaut mieux nommer. `null` quand il n'y a RIEN : sans ce test,
       `indexOf(0)` désignait le premier mois, et un dépôt sans une ligne de l'année affichait
       fièrement son « mois le plus actif ». */
    meilleurMois: Math.max(0, ...days) > 0 ? mois[days.indexOf(Math.max(...days))] : null,
    dernierActif: [...mois].reverse().find((m, i) => days[days.length - 1 - i] > 0) || null,
    partiel: mois.some((m) => (lignes.get(m) || {}).partiel),
    erreur,
  });
}));

// Télémétrie du footer : tokens, activité perso, paliers, et activité de l'équipe
// (MR entrantes) — de la matière fraîche même quand l'utilisateur ne fait rien.
app.get('/api/footer', wrap((req, res) => {
  const now = new Date();
  const midnight = new Date(now); midnight.setHours(0, 0, 0, 0);
  const todayStart = midnight.toISOString();
  const dayKey = (d) => { const jour = new Date(d); return `${jour.getFullYear()}-${String(jour.getMonth() + 1).padStart(2, '0')}-${String(jour.getDate()).padStart(2, '0')}`; };
  const daysBetween = (iso) => (iso ? Math.floor((now - new Date(iso)) / 86400000) : null);
  const one = (sql, ...p) => db.prepare(sql).get(...p);

  // Tokens (cumul + aujourd'hui)
  const tokens = {
    total: one('SELECT COALESCE(SUM(tokens_est),0) v FROM usage').v,
    today: one('SELECT COALESCE(SUM(tokens_est),0) v FROM usage WHERE created_at >= ?', todayStart).v,
    calls: one('SELECT COUNT(*) v FROM usage').v,
  };

  // Reviews perso
  const reviews = {
    total: one('SELECT COUNT(*) v FROM review').v,
    today: one('SELECT COUNT(*) v FROM review WHERE created_at >= ?', todayStart).v,
    avgNote: (() => { const r = one('SELECT AVG(note_value) a FROM review WHERE note_value IS NOT NULL'); return r.a == null ? null : Math.round(r.a * 100) / 10; })(),
    bestNoteToday: (() => { const r = one('SELECT MAX(note_value) m FROM review WHERE note_value IS NOT NULL AND created_at >= ?', todayStart); return r.m == null ? null : Math.round(r.m * 100) / 10; })(),
    bestNoteAllTime: (() => { const r = one('SELECT MAX(note_value) m FROM review WHERE note_value IS NOT NULL'); return r.m == null ? null : Math.round(r.m * 100) / 10; })(),
  };

  // Dev sessions
  const commits = one("SELECT COUNT(*) v FROM task_target WHERE commit_sha IS NOT NULL").v;
  const mrMerged = one('SELECT COUNT(*) v FROM task_target WHERE mr_merged = 1').v;

  // Streak : jours consécutifs (finissant aujourd'hui ou hier) avec ≥1 review
  const reviewDays = new Set(db.prepare('SELECT created_at FROM review WHERE created_at IS NOT NULL').all().map((r) => dayKey(r.created_at)));
  let streak = 0; const cur = new Date(midnight);
  if (!reviewDays.has(dayKey(cur))) cur.setDate(cur.getDate() - 1); // tolère : dernière review = hier
  while (reviewDays.has(dayKey(cur))) { streak += 1; cur.setDate(cur.getDate() - 1); }

  // Activité de l'équipe (MR entrantes)
  const toReview = one("SELECT COUNT(*) v FROM mr WHERE status = 'to_review'").v;
  const team = {
    toReview,
    newToday: one('SELECT COUNT(*) v FROM mr WHERE gitlab_created_at >= ?', todayStart).v,
    oldestWaitingDays: daysBetween(one("SELECT MIN(gitlab_created_at) m FROM mr WHERE status = 'to_review' AND gitlab_created_at IS NOT NULL").m),
    recent: db.prepare(`SELECT mr.iid, mr.title, mr.author, mr.gitlab_created_at, repo.project
        FROM mr JOIN repo ON repo.id = mr.repo_id
        WHERE mr.status = 'to_review' AND mr.gitlab_created_at IS NOT NULL
        ORDER BY mr.gitlab_created_at DESC LIMIT 5`).all()
      .map((m) => ({ iid: m.iid, title: m.title, author: m.author, project: m.project, ageDays: daysBetween(m.gitlab_created_at) })),
    topAuthorToday: one(`SELECT author, COUNT(*) c FROM mr
        WHERE gitlab_created_at >= ? AND author IS NOT NULL
        GROUP BY author ORDER BY c DESC LIMIT 1`, todayStart) || null,
  };

  // Événements récents (pour le ticker)
  const recentReviews = db.prepare(`SELECT mr.id, mr.iid, repo.project, review.note_value, review.created_at
      FROM review JOIN mr ON mr.id = review.mr_id JOIN repo ON repo.id = mr.repo_id
      ORDER BY review.created_at DESC LIMIT 40`).all()
    .map((r) => ({ id: r.id, iid: r.iid, project: r.project, note10: r.note_value == null ? null : Math.round(r.note_value * 100) / 10, at: r.created_at }));
  const recentTasks = db.prepare("SELECT branch, status, updated_at FROM task_target WHERE status IN ('committed','pushed') ORDER BY updated_at DESC LIMIT 30").all();

  // Journal d'événements « frais » (MR arrivée / mergée, par auteur)
  const feed = db.prepare(`SELECT feed.type, feed.mr_iid, feed.project, feed.author, feed.title, feed.at, mr.id AS mr_id
      FROM feed
      LEFT JOIN repo ON repo.project = feed.project
      LEFT JOIN mr ON mr.repo_id = repo.id AND mr.iid = feed.mr_iid
      ORDER BY feed.at DESC LIMIT 40`).all();

  // --- Matière détaillée : 1 frame par entité côté footer (variété sur 15+ min) ---

  // Toutes les MR en attente (pas seulement les 5 dernières)
  const toReviewList = db.prepare(`SELECT mr.id, mr.iid, mr.title, mr.author, mr.gitlab_created_at, repo.project
      FROM mr JOIN repo ON repo.id = mr.repo_id
      WHERE mr.status = 'to_review' ORDER BY mr.gitlab_created_at DESC LIMIT 60`).all()
    .map((m) => ({ id: m.id, iid: m.iid, title: m.title, author: m.author, project: m.project, ageDays: daysBetween(m.gitlab_created_at) }));

  // Par projet : reviewées, note moyenne, en attente
  const projects = db.prepare(`SELECT repo.project project,
        SUM(CASE WHEN mr.status = 'to_review' THEN 1 ELSE 0 END) pending,
        COUNT(review.id) reviewed,
        AVG(review.note_value) avgNote,
        MAX(review.note_value) bestNote,
        MIN(review.note_value) worstNote
      FROM repo LEFT JOIN mr ON mr.repo_id = repo.id LEFT JOIN review ON review.mr_id = mr.id
      GROUP BY repo.project`).all()
    .map((p) => ({ project: p.project, pending: p.pending || 0, reviewed: p.reviewed || 0, avgNote: p.avgNote == null ? null : Math.round(p.avgNote * 100) / 10, bestNote: p.bestNote == null ? null : Math.round(p.bestNote * 100) / 10, worstNote: p.worstNote == null ? null : Math.round(p.worstNote * 100) / 10 }));

  // Par auteur : nombre de MR ouvertes suivies
  const authors = db.prepare(`SELECT author, COUNT(*) c FROM mr
      WHERE author IS NOT NULL AND author <> '' AND status = 'to_review'
      GROUP BY author ORDER BY c DESC LIMIT 40`).all();

  // Activité des 14 derniers jours (reviews + tokens par jour)
  const revByDay = {};
  db.prepare('SELECT created_at FROM review WHERE created_at IS NOT NULL').all()
    .forEach((r) => { const k = dayKey(r.created_at); revByDay[k] = (revByDay[k] || 0) + 1; });
  const tokByDay = {};
  db.prepare('SELECT created_at, tokens_est FROM usage WHERE created_at IS NOT NULL').all()
    .forEach((u) => { const k = dayKey(u.created_at); tokByDay[k] = (tokByDay[k] || 0) + (u.tokens_est || 0); });
  const daily = [];
  for (let i = 0; i < 14; i += 1) {
    const d = new Date(midnight); d.setDate(d.getDate() - i);
    const k = dayKey(d);
    if (revByDay[k] || tokByDay[k]) daily.push({ day: k, reviews: revByDay[k] || 0, tokens: tokByDay[k] || 0, daysAgo: i });
  }

  // Activité par semaine (8 dernières semaines)
  const weekKey = (d) => { const jour = new Date(d); const off = (jour.getDay() + 6) % 7; jour.setHours(0, 0, 0, 0); jour.setDate(jour.getDate() - off); return dayKey(jour); };
  const revByWeek = {}; const tokByWeek = {};
  db.prepare('SELECT created_at FROM review WHERE created_at IS NOT NULL').all()
    .forEach((r) => { const k = weekKey(r.created_at); revByWeek[k] = (revByWeek[k] || 0) + 1; });
  db.prepare('SELECT created_at, tokens_est FROM usage WHERE created_at IS NOT NULL').all()
    .forEach((u) => { const k = weekKey(u.created_at); tokByWeek[k] = (tokByWeek[k] || 0) + (u.tokens_est || 0); });
  const weekly = [];
  for (let i = 0; i < 8; i += 1) {
    const d = new Date(midnight); d.setDate(d.getDate() - i * 7);
    const k = weekKey(d);
    if (revByWeek[k] || tokByWeek[k]) weekly.push({ week: k, reviews: revByWeek[k] || 0, tokens: tokByWeek[k] || 0, weeksAgo: i });
  }

  // Distribution des notes (matière + parlant)
  const noteVals = db.prepare('SELECT note_value v FROM review WHERE note_value IS NOT NULL').all().map((r) => r.v * 10);
  const noteBuckets = [
    { label: '0–2', min: 0, max: 2 }, { label: '2–4', min: 2, max: 4 }, { label: '4–6', min: 4, max: 6 },
    { label: '6–8', min: 6, max: 8 }, { label: '8–10', min: 8, max: 10.01 },
  ].map((b) => ({ label: b.label, count: noteVals.filter((v) => v >= b.min && v < b.max).length }));

  // Note moyenne des MR par auteur (qui reçoit quelles notes)
  const authorNotes = db.prepare(`SELECT mr.author author, COUNT(review.id) reviewed, AVG(review.note_value) avgNote
      FROM mr JOIN review ON review.mr_id = mr.id
      WHERE mr.author IS NOT NULL AND mr.author <> ''
      GROUP BY mr.author ORDER BY reviewed DESC LIMIT 40`).all()
    .map((a) => ({ author: a.author, reviewed: a.reviewed, avgNote: a.avgNote == null ? null : Math.round(a.avgNote * 100) / 10 }));

  // Tokens : répartition par type d'appel + quelques repères
  const tokensByKind = db.prepare('SELECT kind, SUM(tokens_est) v, COUNT(*) c FROM usage GROUP BY kind').all()
    .map((r) => ({ kind: r.kind || 'autre', tokens: r.v || 0, calls: r.c || 0 }));
  const tokenStats = {
    avgPerCall: tokens.calls ? Math.round(tokens.total / tokens.calls) : 0,
    maxCall: one('SELECT COALESCE(MAX(tokens_est),0) v FROM usage').v,
  };

  res.json({
    now: now.toISOString(), tokens, reviews, commits, mrMerged, streak, team,
    recentReviews, recentTasks, feed, toReviewList, projects, authors, daily, tokensByKind, tokenStats,
    weekly, noteBuckets, authorNotes,
  });
}));

/* Aucun jeton ne redescend au front : '***' dit « il y en a un », '' dit « il n'y en a
   pas », et le front renvoie le masque tel quel quand il n'y a pas touché. La clé de dictée
   suit la même règle que les jetons de forge et de Jira — c'en est un. */
function sansSecrets(c) {
  return {
    ...c,
    access_token: c.access_token ? '***' : '',
    jira_token: c.jira_token ? '***' : '',
    github_token: c.github_token ? '***' : '',
    jenkins_token: c.jenkins_token ? '***' : '',
    dictation_api_key: c.dictation_api_key ? '***' : '',
  };
}

app.get('/api/config', wrap((req, res) => {
  const c = getConfig();
  /* `scopes` dit, champ par champ, ce qu'un changement ENGAGE : « equipe » (le réglage vit dans
     `config` et partira dans le dépôt de données partagé) ou « poste » (il reste sur cette
     machine — les jetons, le chemin des clones, la langue, le moteur de dictée). L'écran en fait
     un badge à côté de chaque champ. La liste vient du registre, pas d'une copie côté client :
     dupliquée, elle mentirait au premier réglage déplacé, et un badge qui ment sur un jeton est
     pire que pas de badge du tout. */
  const scopes = {};
  for (const champ of Object.keys(c)) scopes[champ] = configModule.destinationDe(champ);
  /* LES RÉGLAGES D'AUTOMATISME QUI ATTENDENT : changés par la synchro, pas encore vus ici. */
  const autoApproval = {
    pending: !approbation.configApprouvee(c),
    before: approbation.configApprouveeAvant(),
    signature: approbation.signature(approbation.empreinteConfig(c)),
  };
  res.json({ ...sansSecrets(c), scopes, auto_approval: autoApproval });
}));

/* ---------- Jenkins : voir et lancer des jobs -------------------------------
   Aucune requête n'est émise sans un geste : pas de sondage, pas de rafraîchissement de
   fond. L'écran demande, on demande à Jenkins. `configured: false` plutôt qu'une erreur —
   un onglet non configuré doit expliquer comment le configurer, pas afficher un échec. */
const jenkinsCfg = () => getConfig();

app.get('/api/jenkins/jobs', wrap(async (req, res) => {
  if (demoJenkins.isDemo()) return res.json({ configured: true, jobs: demoJenkins.lister() });
  const cfg = jenkinsCfg();
  if (!jenkins.isConfigured(cfg)) return res.json({ configured: false, jobs: [] });
  res.json({ configured: true, jobs: await jenkins.lister(cfg) });
}));

app.get('/api/jenkins/job', wrap(async (req, res) => {
  const chemin = String(req.query.path || '').trim();
  if (!chemin) throw new Error(t('err.jenkins-chemin-requis'));
  if (demoJenkins.isDemo()) return res.json(demoJenkins.detail(chemin, req.query.builds));
  // `builds` : profondeur d'historique demandée par l'écran (bornée côté client Jenkins).
  res.json(await jenkins.detail(jenkinsCfg(), chemin, req.query.builds));
}));

/* Lancer : le seul geste qui ÉCRIT chez Jenkins, donc un POST explicite. Les paramètres
   arrivent tels que l'écran les a lus du job — on ne les invente pas, et un job sans
   paramètre part sans corps. */
app.post('/api/jenkins/build', wrap(async (req, res) => {
  const chemin = String((req.body && req.body.path) || '').trim();
  if (!chemin) throw new Error(t('err.jenkins-chemin-requis'));
  const params = (req.body && req.body.parameters) || {};
  if (demoJenkins.isDemo()) return res.json(demoJenkins.lancer(chemin, params));
  const r = await jenkins.lancer(jenkinsCfg(), chemin, params);
  /* B15 — ET ON NOTE QU'ON L'ATTEND. La fin de build était guettée par le NAVIGATEUR, donc
     seulement tant que l'onglet Jenkins restait ouvert — alors qu'on lance un build justement
     pour aller faire autre chose. `since` est le numéro du dernier build connu de l'écran au
     moment du clic ; sans lui (appel direct à l'API), on le demande à Jenkins, parce qu'une
     attente qui part de zéro prendrait le build PRÉCÉDENT pour le nôtre. */
  let since = Number(req.body && req.body.since);
  if (!Number.isFinite(since)) {
    try { since = ((await jenkins.detail(jenkinsCfg(), chemin, 1)).builds[0] || {}).number || 0; }
    catch { since = 0; }
  }
  veille.attendreJenkins(chemin, since);
  res.json(r);
}));

app.get('/api/jenkins/console', wrap(async (req, res) => {
  const chemin = String(req.query.path || '').trim();
  if (!chemin) throw new Error(t('err.jenkins-chemin-requis'));
  if (demoJenkins.isDemo()) return res.json(demoJenkins.console());
  res.json(await jenkins.console(jenkinsCfg(), chemin, req.query.build));
}));

// Test de connexion — même contrat que « Tester Jira » : le masque signifie « garde le jeton ».
/* A38 — LE SOUVENIR D'UN TEST DE CONNEXION. Le bouton répondait à l'écran et n'en gardait
   rien : au retour dans les réglages, les quatre connexions étaient muettes, et « est-ce que
   GitLab marche encore ? » se rejouait à chaque fois. On note donc le RÉSULTAT et sa date —
   un souvenir de geste, jamais une surveillance : rien n'est sondé en fond. Un échec est noté
   comme un succès, c'est même le plus utile des deux. */
function noterTest(service, ok, detail) {
  try {
    db.prepare(`INSERT INTO conn_test (service, ok, detail, tested_at) VALUES (?,?,?,?)
      ON CONFLICT(service) DO UPDATE SET ok = excluded.ok, detail = excluded.detail, tested_at = excluded.tested_at`)
      .run(service, ok ? 1 : 0, String(detail || '').slice(0, 200), new Date().toISOString());
  } catch { /* trace best-effort : un test réussi ne doit pas échouer sur son journal */ }
}

/* Ce que l'écran des réglages relit à l'ouverture. */
app.get('/api/conn-tests', wrap((req, res) => {
  const out = {};
  for (const r of db.prepare('SELECT service, ok, detail, tested_at FROM conn_test').all()) {
    out[r.service] = { ok: !!r.ok, detail: r.detail || '', tested_at: r.tested_at };
  }
  res.json(out);
}));

/* LE JETON ENREGISTRÉ NE PART PAS VERS UNE AUTRE ADRESSE. « Tester » accepte l'URL du
   formulaire et le masque `***` (« jeton non modifié ») : une requête qui changeait l'URL en
   gardant le masque faisait envoyer le jeton en base à l'hôte de son choix. Adresse changée
   (autre origine) ⇒ le jeton doit être retapé dans la même requête. */
function exigerJetonFrais(urlCorps, urlBase, jetonCorps, jetonBase, defaut = '') {
  if (!garde.jetonFraisRequis(urlCorps, urlBase, jetonCorps, jetonBase, defaut)) return;
  const e = new Error(t('err.test.fresh-token'));
  e.status = 400;
  throw e;
}

app.post('/api/jenkins/test', wrap(async (req, res) => {
  if (demoJenkins.isDemo()) return res.json(demoJenkins.tester());
  const test = { ...jenkinsCfg() };
  const b = req.body || {};
  if (b.jenkins_url) exigerJetonFrais(b.jenkins_url, test.jenkins_url, b.jenkins_token, test.jenkins_token);
  if (b.jenkins_url) test.jenkins_url = b.jenkins_url;
  if (b.jenkins_user) test.jenkins_user = b.jenkins_user;
  if (b.jenkins_token && b.jenkins_token !== '***') test.jenkins_token = b.jenkins_token;
  if (!jenkins.isConfigured(test)) throw new Error(t('err.jenkins-non-configure'));
  try {
    const r = await jenkins.tester(test);
    noterTest('jenkins', true, `${r.user || ''} · ${r.jobs || 0}`);
    res.json(r);
  } catch (e) { noterTest('jenkins', false, e.message); throw e; }
}));

// Test de la connexion Jira : récupère un ticket témoin pour valider URL/email/token.
app.post('/api/jira/test', wrap(async (req, res) => {
  const cfg = getConfig();
  // Le front peut renvoyer le masque : on teste alors avec le token déjà en base.
  const test = { ...cfg };
  if (req.body && req.body.jira_url) exigerJetonFrais(req.body.jira_url, cfg.jira_url, req.body.jira_token, cfg.jira_token);
  if (req.body && req.body.jira_url) test.jira_url = req.body.jira_url;
  if (req.body && req.body.jira_email) test.jira_email = req.body.jira_email;
  if (req.body && req.body.jira_token && req.body.jira_token !== '***') test.jira_token = req.body.jira_token;
  if (!jira.isConfigured(test)) throw new Error(t('err.jira.not-configured'));
  const key = String((req.body && req.body.key) || '').trim();
  if (!key) throw new Error(t('err.jira.test-key-required'));
  try {
    const issue = await jira.fetchIssue(test, key);
    noterTest('jira', true, issue.key);
    res.json({ ok: true, key: issue.key, summary: issue.summary });
  } catch (e) { noterTest('jira', false, e.message); throw e; }
}));

// Onglet Jira → filtre par assigné : « moi » + les personnes ayant des tickets assignés récents
// (pour cocher qui afficher). `not-configured` renvoie { configured:false } (pas une 400).
app.get('/api/jira/assignees', wrap(async (req, res) => {
  if (demoDocker.isDemo()) return res.json({ configured: true, ...demoJira.assignees() });
  const cfg = getConfig();
  if (!jira.isConfigured(cfg)) return res.json({ configured: false, me: null, people: [] });
  res.json({ configured: true, ...(await jira.listAssignees(cfg)) });
}));

// Tickets assignés aux personnes cochées (`assignees` = accountIds séparés par des virgules ;
// vide = mes tickets). Filtre statut fait côté client.
/* Statuts par projet, mémorisés : un workflow ne change pas d'une minute à l'autre, et le
   filtre les redemanderait à chaque chargement de l'onglet. Vidé à l'enregistrement de la
   configuration, l'instance visée pouvant changer. */
const statutsParProjet = new Map();
app.get('/api/jira/statuses', wrap(async (req, res) => {
  const cles = [...new Set(String(req.query.projects || '').split(',').map((x) => x.trim()).filter(Boolean))].slice(0, 20);
  if (demoDocker.isDemo()) return res.json({ configured: true, statuses: demoJira.projectStatuses(cles) });
  const cfg = getConfig();
  if (!jira.isConfigured(cfg)) return res.json({ configured: false, statuses: [] });
  const par = new Map();
  for (const cle of cles) {
    if (!statutsParProjet.has(cle)) {
      /* Un projet inaccessible ne doit pas priver le filtre des statuts des autres. L'échec
         n'est PAS mémorisé : une panne passagère aurait vidé ce filtre jusqu'au redémarrage. */
      try { statutsParProjet.set(cle, await jira.projectStatuses(cfg, cle)); }
      catch { /* on retentera au prochain chargement */ }
    }
    for (const st of statutsParProjet.get(cle) || []) if (!par.has(st.name)) par.set(st.name, st);
  }
  res.json({ configured: true, statuses: [...par.values()] });
}));

/* Identifiant du champ « sprint », résolu une fois puis mémorisé : il ne change pas en cours
   de route, et le redemander à chaque chargement coûterait un appel Jira pour rien. Remis à
   zéro à l'enregistrement de la configuration (l'instance visée peut changer). */
let champSprint = null;   // null = pas encore cherché ; '' = cherché, absent
async function sprintFieldId(cfg) {
  if (champSprint !== null) return champSprint;
  try {
    const trouve = jira.detectSprintField(await jira.allFields(cfg));
    champSprint = trouve ? trouve.id : '';
  } catch {
    /* Droits manquants ou panne : on s'en passe cette fois, sans casser l'onglet — mais sans le
       mémoriser, sinon une coupure de quelques secondes cachait le filtre Sprints jusqu'au
       prochain enregistrement des réglages. */
    return '';
  }
  return champSprint;
}

app.get('/api/jira/tickets', wrap(async (req, res) => {
  const accountIds = String(req.query.assignees || '').split(',').map((s) => s.trim()).filter(Boolean);
  // Statuts décochés : exclus par Jira, pour ne pas trier un extrait déjà plafonné.
  const hideStatuses = String(req.query.hideStatuses || '').split('\u001f').map((x) => x.trim()).filter(Boolean);
  // Sprints choisis : mêmes règles que les projets — la contrainte part dans la requête.
  const sprints = String(req.query.sprints || '').split(',').map((x) => x.trim()).filter(Boolean);
  // Projets choisis dans le filtre : appliqués par Jira, pas après coup (cf. searchByAssignees).
  const projects = String(req.query.projects || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (demoDocker.isDemo()) return res.json({ configured: true, ...demoJira.tickets(accountIds, req.query.includeDone === '1', projects, sprints, hideStatuses) });
  const cfg = getConfig();
  if (!jira.isConfigured(cfg)) return res.json({ configured: false, issues: [], total: 0 });
  res.json({ configured: true, ...(await jira.searchByAssignees(cfg, {
    accountIds, includeDone: req.query.includeDone === '1', projects, sprints, hideStatuses,
    sprintField: await sprintFieldId(cfg),
  })) });
}));

// Détail d'un ticket Jira : métadonnées + description + commentaires + pièces jointes.
app.get('/api/jira/issue/:key', wrap(async (req, res) => {
  const key = String(req.params.key || '').trim();
  /* Les merge requests qui portent ce ticket : la zone de commentaire propose d'en insérer le
     lien. L'écran les lisait ici sans que la route les ait jamais servies. */
  const mergerie = {
    mrs: engagementsSurTicket(key).mrs.filter((m) => !m.closed && m.web_url)
      .map((m) => ({ iid: m.iid, url: m.web_url })),
  };
  if (demoDocker.isDemo()) return res.json({ issue: { ...demoJira.issue(key), mergerie } });
  const cfg = getConfig();
  if (!jira.isConfigured(cfg)) throw new Error(t('err.jira.not-configured'));
  res.json({ issue: { ...(await jira.issueDetail(cfg, key)), mergerie } });
}));

// Poster un commentaire sur un ticket Jira.
app.post('/api/jira/issue/:key/comment', wrap(async (req, res) => {
  const text = String((req.body && req.body.text) || '').trim();
  if (!text) throw new Error(t('err.jira.comment-empty'));
  if (demoDocker.isDemo()) return res.json({ comment: { author: 'Toi (démo)', created: new Date().toISOString(), bodyMd: text } });
  const cfg = getConfig();
  if (!jira.isConfigured(cfg)) throw new Error(t('err.jira.not-configured'));
  res.json({ comment: await jira.addComment(cfg, String(req.params.key || '').trim(), text) });
}));

// Changer l'ÉTAT d'un ticket : applique une transition Jira (les transitions possibles sont
// dans le détail du ticket).
app.post('/api/jira/issue/:key/transition', wrap(async (req, res) => {
  if (demoDocker.isDemo()) {
    return res.json({ ...demoJira.applyTransition(String(req.params.key || '').trim(), (req.body && req.body.transitionId) || ''), demo: true });
  }
  const cfg = getConfig();
  if (!jira.isConfigured(cfg)) throw new Error(t('err.jira.not-configured'));
  const id = String((req.body && req.body.transitionId) || '');
  const r = await jira.transitionIssue(cfg, String(req.params.key || '').trim(), id);
  /* Le compteur du menu vient d'un cache rafraîchi par le timer : après un changement d'état
     fait DEPUIS l'outil, on sait qu'il est périmé. On le recalcule avant de répondre, pour que
     la relecture qui suit côté client tombe déjà sur la bonne valeur. Best-effort : une
     transition réussie ne doit pas être signalée en échec parce que le recomptage a raté. */
  try { await refreshJiraBadge(); } catch { /* compteur : jamais bloquant */ }
  res.json(r);
}));

/* SERVIR UN FICHIER QUE QUELQU'UN D'AUTRE A FOURNI — pièce jointe Jira ou de session, capture
   d'une note, image de ticket. Une seule porte, parce que les quatre avaient divergé : la pièce
   jointe Jira était déjà prudente, les trois autres servaient `inline` ce qu'on leur donnait. Un
   `.html` ou un `.svg` ouvert en navigation directe sur NOTRE origine exécutait son script avec
   accès à l'API locale.
     — `inline` pour les images matricielles (non scriptables) et le PDF (lu par le lecteur du
       navigateur, hors de notre origine), `attachment` pour tout le reste ;
     — `nosniff` partout, et une CSP `sandbox` qui retire l'origine à ce qui serait rendu malgré
       tout (le PDF en est dispensé : le lecteur de Chrome refuse de s'ouvrir sous `sandbox`).
   Ni `html` ni `xml` ne sont refusés à l'envoi — l'agent sait les lire —, ils ne s'exécutent plus. */
const TYPES_PAR_EXTENSION = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  bmp: 'image/bmp', avif: 'image/avif', svg: 'image/svg+xml', pdf: 'application/pdf',
};
const INLINE_SUR = /^image\/(png|jpe?g|gif|webp|bmp|avif)$/i;
function servirFichierNonFiable(res, { chemin = null, buffer = null, nom = '', mime = '' }) {
  const ext = path.extname(String(nom || chemin || '')).slice(1).toLowerCase();
  const type = String(mime || TYPES_PAR_EXTENSION[ext] || 'application/octet-stream');
  const pdf = /^application\/pdf$/i.test(type);
  const inline = INLINE_SUR.test(type) || pdf;
  const nomAffiche = String(nom || (chemin ? path.basename(chemin) : 'fichier'));
  const ascii = nomAffiche.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (!pdf) res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox");
  res.setHeader('Content-Type', type);
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(nomAffiche)}`);
  if (buffer) return res.send(buffer);
  return res.sendFile(path.resolve(chemin));
}

// Téléchargement PROXY d'une pièce jointe Jira (le lien direct exigerait l'auth Basic dans le
// navigateur) : le serveur récupère le fichier avec le token et le renvoie tel quel.
app.get('/api/jira/attachment/:id', wrap(async (req, res) => {
  let file;
  if (demoDocker.isDemo()) file = demoJira.attachmentFile(req.params.id);
  else {
    const cfg = getConfig();
    if (!jira.isConfigured(cfg)) throw new Error(t('err.jira.not-configured'));
    file = await jira.downloadAttachment(cfg, req.params.id);
  }
  // Une image `image/svg+xml` peut porter du <script> : elle part en `attachment` (servirFichierNonFiable).
  servirFichierNonFiable(res, { buffer: file.buffer, nom: file.filename, mime: file.mimeType });
}));

// Récupère un ticket Jira par son numéro et renvoie son contexte prêt à injecter
// (titre + description en Markdown). Utilisé pour enrichir une session de dev.
app.post('/api/jira/fetch', wrap(async (req, res) => {
  const key = String((req.body && req.body.key) || '').trim().toUpperCase();
  if (!key) throw new Error(t('err.jira.test-key-required'));
  // En démo, comme les autres routes Jira : le contexte vient du jeu fictif, sinon
  // « Faire coder l'IA » et « Récupérer » seraient les seuls boutons Jira inertes.
  /* B10 : les PIÈCES JOINTES viennent avec le contexte. La modale de session les propose en
     cases à cocher ; elles ne sont téléchargées qu'à la création, et seulement si on coche. */
  const pieces = (liste) => (liste || []).map((a) => ({ id: a.id, filename: a.filename, mimeType: a.mimeType }));
  if (demoDocker.isDemo()) {
    const d = demoJira.issue(key);
    const body = [`# ${d.summary}`, '', d.descriptionMd || ''].join('\n');
    return res.json({ key: d.key, summary: d.summary, context: body, attachments: pieces(d.attachments) });
  }
  const cfg = getConfig();
  if (!jira.isConfigured(cfg)) throw new Error(t('err.jira.not-configured'));
  const issue = await jira.fetchIssue(cfg, key);
  res.json({
    key: issue.key, summary: issue.summary, context: jira.issueToContext(issue),
    attachments: pieces(issue.attachments),
  });
}));

/* ---------- Tickets Jira surveillés ----------------------------------------
   Surveiller un ticket = mémoriser son état, et être prévenu quand il change. On stocke le
   DERNIER état connu au moment de l'ajout : sans ça, la première vérification comparerait
   à du vide et notifierait un changement qui n'a pas eu lieu.

   Une erreur (ticket supprimé, droits perdus, Jira injoignable) est rangée sur la ligne
   concernée et affichée ; elle n'interrompt jamais la vérification des autres. */

/* `checked_at` et `error` ont quitté la table : QUAND CE POSTE a regardé, et l'erreur réseau
   qu'il a rencontrée, ne disent rien à un collègue — chez lui, la réponse de Jira sera
   différente et son horloge aussi. Ce qu'on surveille est d'équipe ; le fait de l'avoir
   regardé est de poste. On les recolle donc à la lecture, en DEUX requêtes et non une par
   ligne : cette liste se redessine souvent. */
function watchRows() {
  const vus = etatLocal.carte('jira_watch', 'checked_at');
  const erreurs = etatLocal.carte('jira_watch', 'error');
  return db.prepare('SELECT * FROM jira_watch ORDER BY key').all().map((r) => ({
    ...r, checked_at: vus.get(r.key) || null, error: erreurs.get(r.key) || null,
  }));
}
const marquerVu = (key, erreur = null) => {
  etatLocal.ecrire('jira_watch', key, 'checked_at', new Date().toISOString());
  etatLocal.ecrire('jira_watch', key, 'error', erreur);
};

// Compteur du menu, en cache : le client l'interroge souvent, Jira ne doit pas l'être autant.
let jiraBadge = { inProgress: 0, at: null, error: null };

app.get('/api/jira/watch', wrap((req, res) => {
  const cfg = getConfig();
  const demo = demoDocker.isDemo();
  // L'URL est construite ici, où la configuration Jira est connue — comme pour les tickets.
  const lien = (key) => (demo ? demoJira.issueUrl(key) : (jira.isConfigured(cfg) ? jira.issueUrl(cfg, key) : null));
  res.json({
    configured: demo || jira.isConfigured(cfg),
    watched: watchRows().map((r) => ({ ...r, url: lien(r.key) })),
  });
}));

/* La note tient sur une ligne ou deux : c'est un rappel, pas un journal. On la borne plutôt
   que de laisser une colonne libre s'étaler dans une liste où chaque ticket doit rester lisible. */
const MAX_NOTE_WATCH = 500;
const lireNote = (v) => String(v == null ? '' : v).trim().slice(0, MAX_NOTE_WATCH);

app.post('/api/jira/watch', wrap(async (req, res) => {
  const key = String((req.body && req.body.key) || '').trim().toUpperCase();
  if (!jira.cleValide(key)) throw new Error(t('err.jira.watch-key-invalid'));
  if (db.prepare('SELECT 1 FROM jira_watch WHERE key = ?').get(key)) throw new Error(t('err.jira.watch-exists'));
  const now = new Date().toISOString();
  // État de départ : celui du ticket maintenant. C'est ce qui évite la fausse notification.
  let meta = null;
  if (demoDocker.isDemo()) { const d = demoJira.issue(key); meta = d && { summary: d.summary, status: d.status, statusCategory: d.statusCategory }; }
  else {
    const cfg = getConfig();
    if (!jira.isConfigured(cfg)) throw new Error(t('err.jira.not-configured'));
    meta = (await jira.statusOfKeys(cfg, [key]))[0] || null;
    if (!meta) throw new Error(t('err.jira.watch-not-found', { key }));
  }
  db.prepare(`INSERT INTO jira_watch (key, summary, status, status_category, added_at, note)
              VALUES (?,?,?,?,?,?)`)
    .run(key, meta.summary || '', meta.status || '', meta.statusCategory || '', now,
      lireNote(req.body && req.body.note));
  marquerVu(key);
  res.json(watchRows().find((r) => r.key === key));
}));

/* La raison de surveiller change avec le temps — le ticket avance, on suit autre chose. Elle
   se corrige donc sans retirer puis ré-ajouter le ticket, ce qui perdrait sa date d'ajout et
   son dernier état connu (et déclencherait une fausse notification au passage suivant). */
app.patch('/api/jira/watch/:key', wrap((req, res) => {
  const key = String(req.params.key || '').trim().toUpperCase();
  const ligne = db.prepare('SELECT 1 FROM jira_watch WHERE key = ?').get(key);
  if (!ligne) throw new Error(t('err.jira.watch-unknown', { key }));
  /* Deux champs indépendants : on peut changer le motif sans toucher à la case, et
     inversement. `undefined` = « ne touche pas », comme partout ailleurs dans les PATCH. */
  if ((req.body || {}).note !== undefined) {
    db.prepare('UPDATE jira_watch SET note = ? WHERE key = ?').run(lireNote(req.body.note), key);
  }
  if ((req.body || {}).todo_on_change !== undefined) {
    db.prepare('UPDATE jira_watch SET todo_on_change = ? WHERE key = ?').run(req.body.todo_on_change ? 1 : 0, key);
  }
  res.json(watchRows().find((r) => r.key === key));
}));

app.delete('/api/jira/watch/:key', wrap((req, res) => {
  const cle = String(req.params.key || '').trim().toUpperCase();
  db.prepare('DELETE FROM jira_watch WHERE key = ?').run(cle);
  /* Ménage EXPLICITE : `local_state` n'a pas de clé étrangère (quatre parents possibles), donc
     rien ne cascade. Une ligne orpheline reviendrait hanter le ticket s'il était re-surveillé. */
  etatLocal.oublier('jira_watch', cle);
  res.json({ ok: true });
}));

/* Vérifie tous les tickets surveillés et notifie les changements d'état.
   Appelée par le timer ET par le bouton « Vérifier maintenant » — même code, donc ce que
   le bouton montre est exactement ce que le timer fait. */
/* Une seule vérification à la fois, TOUS APPELANTS CONFONDUS (timer, bouton « Vérifier
   maintenant », double clic). Deux passages simultanés liraient le même ancien état et
   notifieraient deux fois le même changement — exactement ce qu'on ne veut pas. Les appels
   concurrents partagent donc le résultat de celle qui tourne déjà. */
let checkEnCours = null;
function checkJiraWatch() {
  if (!checkEnCours) checkEnCours = faireCheckJiraWatch().finally(() => { checkEnCours = null; });
  return checkEnCours;
}

async function faireCheckJiraWatch() {
  const rows = watchRows();
  const now = new Date().toISOString();
  const resultat = { checked: rows.length, changed: 0, errors: 0 };
  if (!rows.length) return resultat;

  let etats = [];
  try {
    etats = demoDocker.isDemo()
      ? rows.map((r) => { const d = demoJira.issue(r.key); return d && { key: r.key, summary: d.summary, status: d.status, statusCategory: d.statusCategory }; }).filter(Boolean)
      : await jira.statusOfKeys(getConfig(), rows.map((r) => r.key));
  } catch (e) {
    // Jira injoignable : on marque toutes les lignes, sans rien perdre de l'état connu.
    for (const r of rows) marquerVu(r.key, String(e.message).slice(0, 300));
    resultat.errors = rows.length;
    return resultat;
  }

  const parCle = new Map(etats.map((i) => [i.key, i]));
  const majSql = db.prepare(`UPDATE jira_watch SET summary = ?, status = ?, status_category = ?,
                             changed_at = ? WHERE key = ?`);
  const inchangeSql = db.prepare('UPDATE jira_watch SET summary = ? WHERE key = ?');
  const maj = (summary, statut, categorie, quand, cle) => { majSql.run(summary, statut, categorie, quand, cle); marquerVu(cle); };
  const inchange = (summary, cle) => { inchangeSql.run(summary, cle); marquerVu(cle); };
  const absent = (cle, erreur) => marquerVu(cle, erreur);
  for (const r of rows) {
    const cur = parCle.get(r.key);
    if (!cur) { absent(r.key, t('err.jira.watch-unreachable')); resultat.errors += 1; continue; }
    if ((cur.status || '') !== (r.status || '')) {
      maj(cur.summary || '', cur.status || '', cur.statusCategory || '', now, r.key);
      resultat.changed += 1;
      /* On ne notifie QUE si un état précédent était connu. Sans état de référence il n'y a pas
         de changement à annoncer, seulement une première observation — la signaler ferait sonner
         l'outil pour rien. Le nouvel état devient la référence : tant qu'il ne rebouge pas, plus
         aucune notification, quel que soit le nombre de vérifications. */
      if (r.status) {
        notify.push('jira_status', { key: r.key, summary: cur.summary || '', from: r.status, to: cur.status || '' });
        /* B5 — LA TODO QUI SURVIT À LA NOTIFICATION. Une notification bureau se ferme avec
           l'onglet ; une todo reste sous les yeux, dans Notes et dans le brief — c'est
           exactement ce que fait déjà une session arrêtée sur une question. Le MOTIF de
           surveillance devient la note : c'est lui qui dit quoi faire, trois semaines après
           l'avoir écrit. Opt-in, ticket par ticket. */
        if (r.todo_on_change) {
          try {
            notes.todoAuto('jira_watch', r.key,
              t('todo.jira-watch.title', { key: r.key, from: r.status, to: cur.status || '' }),
              [r.note || '', cur.summary || ''].filter(Boolean).join('\n'));
          } catch { /* best-effort : la surveillance ne doit pas casser pour une todo */ }
        }
      }
    } else {
      inchange(cur.summary || r.summary || '', r.key);
    }
  }
  return resultat;
}

/* ---------- « Dans Mergerie » : ce qui est déjà engagé sur un ticket ----------
   « Où en est PROJ-1408 ? » se répondait en ouvrant le ticket (rien), puis Reviews, puis en
   cherchant « 1408 », puis en revenant à Jira. Tout est en base : les merge requests portent
   la clé (relevée à la découverte, `ticket_jira_key`) ou l'ont dans leur branche ou leur
   titre, et les sessions de codage la portent dans le nom de branche qu'on leur a donné. */
function engagementsSurTicket(cle) {
  const k = String(cle || '').toUpperCase();
  if (!/^[A-Z][A-Z0-9]+-\d+$/.test(k)) return { mrs: [], tasks: [] };
  const motif = `%${k}%`;
  const mrs = db.prepare(`SELECT mr.id, mr.iid, mr.title, mr.status, mr.closed_seen, mr.web_url, repo.project
    FROM mr JOIN repo ON repo.id = mr.repo_id
    WHERE UPPER(COALESCE(mr.ticket_jira_key, '')) = ?
       OR UPPER(mr.source_branch) LIKE ? OR UPPER(COALESCE(mr.title, '')) LIKE ?
    ORDER BY mr.id DESC LIMIT 20`).all(k, motif, motif);
  const notes = {};
  if (mrs.length) {
    const trous = mrs.map(() => '?').join(',');
    const ids = mrs.map((m) => m.id);
    for (const v of db.prepare(`SELECT mr_id, note_value FROM review_version rv WHERE mr_id IN (${trous})
      AND version = (SELECT MAX(v2.version) FROM review_version v2 WHERE v2.mr_id = rv.mr_id)`).all(...ids)) {
      notes[v.mr_id] = v.note_value;
    }
  }
  const verifs = dernieresVerificationsParMr();
  const tasks = db.prepare(`SELECT DISTINCT task.id, task.prompt, task.label, task.status, task.kind
    FROM task JOIN task_target tt ON tt.task_id = task.id
    WHERE UPPER(COALESCE(tt.branch, '')) LIKE ? OR UPPER(COALESCE(task.prompt, '')) LIKE ?
       OR UPPER(COALESCE(task.label, '')) LIKE ?
    ORDER BY task.id DESC LIMIT 10`).all(motif, motif, motif);
  return {
    mrs: mrs.map((m) => ({
      ...m, closed: !!m.closed_seen,
      note: notes[m.id] != null ? notes[m.id] : null,
      verdict: (verifs.get(m.id) || {}).verdict || null,
    })),
    tasks,
  };
}

app.get('/api/jira/issues/:key/mergerie', wrap((req, res) => {
  /* B4 — et les notes qui citent la clé. Même mécanique que sur le rapport de review : le
     lien existait de la note vers le ticket, jamais du ticket vers la note. */
  res.json({ ...engagementsSurTicket(req.params.key), citations: notes.citations({ ticket: req.params.key }) });
}));

/* Le même relevé, en RACCOURCI, pour toute une liste de tickets : « !218 · 7,9 » ou « session
   en cours » en pied de carte, pour voir en parcourant ses tickets lesquels ont déjà avancé
   côté code. Un appel pour la liste entière, jamais un par carte. */
app.get('/api/jira/engagements', wrap((req, res) => {
  const cles = String(req.query.keys || '').split(',').map((x) => x.trim()).filter(Boolean).slice(0, 60);
  const out = {};
  for (const cle of cles) {
    const d = engagementsSurTicket(cle);
    const enCours = d.tasks.filter((x) => ['running', 'needs_input'].includes(x.status)).length;
    if (!d.mrs.length && !d.tasks.length) continue;
    out[cle.toUpperCase()] = {
      mr: d.mrs[0] ? { iid: d.mrs[0].iid, note: d.mrs[0].note, closed: d.mrs[0].closed } : null,
      mrs: d.mrs.length, tasks: d.tasks.length, running: enCours,
    };
  }
  res.json({ engagements: out });
}));

app.post('/api/jira/watch/check', wrap(async (req, res) => { res.json(await checkJiraWatch()); }));

// Compteur « en cours qui me sont affectés » : valeur en cache, jamais un appel Jira ici.
app.get('/api/jira/badge', wrap((req, res) => {
  if (demoDocker.isDemo()) return res.json({ configured: true, inProgress: demoJira.inProgressMine(), error: null });
  res.json({ configured: jira.isConfigured(getConfig()), ...jiraBadge });
}));

async function refreshJiraBadge() {
  const cfg = getConfig();
  if (!jira.isConfigured(cfg)) { jiraBadge = { inProgress: 0, at: null, error: null }; return; }
  try { jiraBadge = { inProgress: await jira.countMineInProgress(cfg), at: new Date().toISOString(), error: null }; }
  catch (e) { jiraBadge = { ...jiraBadge, error: String(e.message).slice(0, 200) }; }
}

/* Timer de surveillance : même forme que le rafraîchissement auto des MR (0 = désactivé,
   pas de chevauchement). Il porte les deux besoins — l'état des tickets surveillés et le
   compteur du menu — parce qu'ils interrogent la même API et ont la même cadence utile. */
let jiraWatchTimer = null;
let jiraWatchBusy = false;
function restartJiraWatch() {
  if (jiraWatchTimer) { clearInterval(jiraWatchTimer); jiraWatchTimer = null; }
  const min = Number(getConfig().jira_watch_minutes) || 0;
  if (min <= 0) { console.log('[jira-watch] désactivé'); return; }
  const tour = async () => {
    if (jiraWatchBusy) return;
    jiraWatchBusy = true;
    try {
      await refreshJiraBadge();
      const r = await checkJiraWatch();
      if (r.changed) console.log(`[jira-watch] ${r.changed} changement(s) d'état sur ${r.checked} ticket(s)`);
    } catch (e) { console.error(`[jira-watch] échec : ${e.message}`); }
    finally { jiraWatchBusy = false; }
  };
  jiraWatchTimer = setInterval(tour, min * 60 * 1000);
  tour();
  console.log(`[jira-watch] activé : toutes les ${min} min`);
}

// Rafraîchir le contexte Jira d'une MR à la demande (bonus des champs séparés :
// ne touche jamais au contexte manuel).
// Projets liés d'une MR : remplace l'ensemble des liens (comme le save du contexte).
// Liens PAR DÉFAUT d'un dépôt : remplace l'ensemble. Utilisés pour pré-remplir
// automatiquement les projets liés des futures MR de ce dépôt.
app.post('/api/repos/:id/links', wrap((req, res) => {
  const repo = db.prepare('SELECT * FROM repo WHERE id = ?').get(Number(req.params.id));
  if (!repo) throw new Error(t('err.depot-introuvable'));
  const links = Array.isArray(req.body && req.body.links) ? req.body.links : [];
  const del = db.prepare('DELETE FROM repo_link WHERE repo_id = ?');
  const ins = db.prepare('INSERT INTO repo_link (repo_id, linked_repo_id, branch) VALUES (?, ?, ?)');
  const tx = db.transaction(() => {
    del.run(repo.id);
    for (const l of links) {
      const lid = Number(l.repo_id);
      if (!lid || lid === repo.id) continue; // ignore vide + auto-lien
      if (!db.prepare('SELECT 1 FROM repo WHERE id = ?').get(lid)) continue;
      ins.run(repo.id, lid, String(l.branch || '').trim() || null);
    }
  });
  tx();
  res.json({ ok: true, count: db.prepare('SELECT COUNT(*) c FROM repo_link WHERE repo_id = ?').get(repo.id).c });
}));

app.post('/api/mrs/:id/links', wrap((req, res) => {
  const mr = mrById(Number(req.params.id));
  if (!mr) throw new Error(t('err.mr-introuvable'));
  const links = Array.isArray(req.body && req.body.links) ? req.body.links : [];
  const del = db.prepare('DELETE FROM mr_link WHERE mr_id = ?');
  const ins = db.prepare('INSERT INTO mr_link (mr_id, repo_id, branch) VALUES (?, ?, ?)');
  const tx = db.transaction(() => {
    del.run(mr.id);
    for (const l of links) {
      const repoId = Number(l.repo_id);
      if (!repoId || repoId === mr.repo_id) continue; // ignore vide + auto-lien
      if (!db.prepare('SELECT 1 FROM repo WHERE id = ?').get(repoId)) continue;
      ins.run(mr.id, repoId, String(l.branch || '').trim() || null);
    }
  });
  tx();
  res.json({ ok: true, count: db.prepare('SELECT COUNT(*) c FROM mr_link WHERE mr_id = ?').get(mr.id).c });
}));

app.post('/api/mrs/:id/jira-refresh', wrap(async (req, res) => {
  const mr = mrById(Number(req.params.id));
  if (!mr) throw new Error(t('err.mr-introuvable'));
  const cfg = getConfig();
  if (!jira.isConfigured(cfg)) throw new Error(t('err.jira.not-configured'));
  const key = jira.ticketKey(mr.title, mr.source_branch);
  if (!key) throw new Error(t('err.jira.no-key'));
  const now = new Date().toISOString();
  try {
    const issue = await jira.fetchIssue(cfg, key);
    const text = jira.issueToContext(issue);
    db.prepare('UPDATE mr SET ticket_jira_text = ?, ticket_jira_key = ?, ticket_jira_at = ?, ticket_jira_error = NULL WHERE id = ?')
      .run(text || null, issue.key, now, mr.id);
    res.json({ ok: true, key: issue.key, text });
  } catch (e) {
    db.prepare('UPDATE mr SET ticket_jira_key = ?, ticket_jira_at = ?, ticket_jira_error = ? WHERE id = ?')
      .run(key, now, String(e.message).slice(0, 300), mr.id);
    throw e;   // remonte l'erreur au front pour l'afficher
  }
}));

app.put('/api/config', wrap((req, res) => {
  const patch = { ...req.body };
  // ne pas écraser un secret si le front renvoie le masque
  if (patch.access_token === '***') delete patch.access_token;
  if (patch.jira_token === '***') delete patch.jira_token;
  if (patch.github_token === '***') delete patch.github_token;
  if (patch.jenkins_token === '***') delete patch.jenkins_token;
  if (patch.dictation_api_key === '***') delete patch.dictation_api_key;
  const c = updateConfig(patch);
  i18n.setLang(c.language);   // les messages d'erreur suivent la nouvelle langue
  restartAutoRefresh(); // prend en compte le nouvel intervalle
  restartJiraWatch(); // idem pour la surveillance Jira (et le compteur du menu)
  champSprint = null; // l'instance Jira visée a pu changer : on re-cherchera le champ sprint
  statutsParProjet.clear();
  res.json(sansSecrets(c));
}));

/* ---------- Dictée vocale (whisper.md) -------------------------------------
   Quatre routes, aucune n'écrit l'audio sur disque. Le fournisseur « navigateur » ne passe
   jamais par ici : il transcrit dans la page et n'envoie rien. */

/* Un segment (ou, avec `final=1`, l'audio complet de la session pour la seconde passe).
   Corps BRUT `audio/wav` ; le numéro de segment, le contexte glissant et la langue voyagent
   en query — c'est ce qui évite d'écrire un parseur multipart ou d'ajouter une dépendance.
   `seq` revient tel quel dans la réponse : deux segments peuvent se chevaucher en vol, et
   c'est le front qui les remet en ordre avant d'insérer. */
app.post('/api/dictation/transcribe', wrap(async (req, res) => {
  const wav = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  const r = await dictation.transcrire({
    wav,
    language: req.query.lang,
    ctx: req.query.ctx,
    final: req.query.final === '1',
  });
  res.json({ ...r, seq: Number(req.query.seq) || 0 });
}));

app.get('/api/dictation/status', wrap((req, res) => { res.json(dictation.statut()); }));

/* Chauffe : appelée au survol du micro et à l'ouverture d'une modale de session quand la
   dictée est active. Charger le modèle prend une à trois secondes ; les payer AVANT le
   premier segment, c'est la différence entre « ça répond » et « ça rame ». */
app.post('/api/dictation/warmup', wrap(async (req, res) => { res.json(await dictation.warmup()); }));

/* Le diagnostic complet : binaire, modèle, VAD, démarrage, TRANSCRIPTION d'un échantillon
   embarqué, vocabulaire, fournisseur distant. C'est l'étape « transcription » qui compte —
   c'est elle qui transforme « installé » en « fonctionne ». */
app.post('/api/dictation/test', wrap(async (req, res) => { res.json(await dictation.diagnostic()); }));

/* Installation du moteur : un job, exactement comme une action Docker — donc un journal en
   direct et un « Stop » qui tue proprement. Le corps ne choisit QUE le modèle (liste
   fermée), le VAD (booléen) et le GPU (énumération) : le chemin du script est fixe. */
app.post('/api/dictation/install', wrap((req, res) => {
  const b = req.body || {};
  // Validé ICI, avant de mettre quoi que ce soit en file : un corps hors liste doit répondre
  // 400 tout de suite, pas créer un job qui échouera trois secondes plus tard.
  dictation.commandeInstallation({ model: b.model, vad: b.vad !== false, gpu: b.gpu || '' });
  res.json(jobs.startInstallJob({ model: b.model || 'large-v3-turbo', vad: b.vad !== false, gpu: b.gpu || '' }));
}));

/* ---------- Repos (admin) ---------- */
app.get('/api/repos', wrap((req, res) => {
  /* L'ÉTAT DE CHAQUE DÉPÔT, sur sa propre ligne. « Pourquoi cette review échoue ? » commence
     presque toujours par « le clone est-il là, et à jour ? » : le nombre de merge requests
     ouvertes, la date de la dernière découverte, et l'état du clone (présent, absent,
     modifié) répondent avant d'ouvrir un terminal. Tout est LOCAL — un `statSync` et une
     requête —, jamais un appel à la forge : cette liste s'ouvre à chaque visite. */
  const cfg = getConfig();
  const ouvertes = {};
  for (const r of db.prepare(`SELECT repo_id AS id, COUNT(*) n, MAX(updated_at) AS at FROM mr
    WHERE (closed_seen IS NULL OR closed_seen = 0) GROUP BY repo_id`).all()) {
    ouvertes[r.id] = r;
  }
  res.json(db.prepare('SELECT * FROM repo ORDER BY id').all().map((repo) => {
    const dir = git.cloneDirFor(cfg, repo);
    let clone = 'absent';
    try {
      if (fs.statSync(path.join(dir, '.git')).isDirectory() || fs.statSync(path.join(dir, '.git')).isFile()) clone = 'present';
    } catch { clone = 'absent'; }
    const o = ouvertes[repo.id] || {};
    return { ...repo, open_mrs: o.n || 0, last_seen_at: o.at || null, clone_state: clone, clone_dir: dir };
  }));
}));

/* B17 — LA FICHE D'UN DÉPÔT. La ligne des réglages dit son URL, ses merge requests ouvertes
   et l'état de son clone — c'est-à-dire ce qui le concerne LUI, jamais ce qui est ACCROCHÉ à
   lui. Or c'est là qu'on se pose la question : « qu'est-ce qui casse si je retire ce dépôt ? »,
   « quel vérificateur le teste, déjà ? », « pourquoi ses reviews reçoivent-elles cette
   règle ? ». Six réponses, six jointures qui existaient toutes, et aucune page pour les lire
   ensemble.

   Une seule requête HTTP, à la DEMANDE (le panneau se déplie) : la liste des dépôts s'ouvre à
   chaque visite des réglages, elle n'a pas à payer six requêtes par ligne pour un panneau que
   personne n'a ouvert. */
app.get('/api/repos/:id/sheet', wrap((req, res) => {
  const id = Number(req.params.id);
  const repo = db.prepare('SELECT * FROM repo WHERE id = ?').get(id);
  if (!repo) throw new Error(t('err.depot-introuvable'));
  res.json({
    verifiers: db.prepare(`SELECT v.id, v.name, vr.mode FROM verifier_repo vr
      JOIN verifier v ON v.id = vr.verifier_id WHERE vr.repo_id = ? ORDER BY v.name`).all(id),
    jenkins: db.prepare('SELECT id, job_path, param FROM repo_jenkins WHERE repo_id = ? ORDER BY job_path').all(id),
    /* Les règles LIMITÉES à ce dépôt. Celles qui valent partout ne sont pas « rattachées » :
       les lister ici ferait croire qu'elles disparaîtraient avec lui. */
    rules: db.prepare(`SELECT id, label, branch_match, path_match, enabled FROM review_rule
      WHERE repo_id = ? ORDER BY id`).all(id),
    services: db.prepare('SELECT id, name FROM service WHERE repo_id = ? ORDER BY name').all(id),
    // Les projets liés PAR DÉFAUT : ce qui sera joint au contexte des futures merge requests.
    links: db.prepare(`SELECT l.linked_repo_id AS id, l.branch, r.project FROM repo_link l
      JOIN repo r ON r.id = l.linked_repo_id WHERE l.repo_id = ? ORDER BY r.project`).all(id),
    agents: db.prepare(`SELECT a.id, a.name, ar.role FROM agent_repo ar
      JOIN agent a ON a.id = ar.agent_id WHERE ar.repo_id = ? ORDER BY a.name`).all(id),
  });
}));

/* RE-CLONER. Le premier réflexe quand une review échoue sur un clone abîmé : on le supprimait
   à la main dans un terminal. Le geste est DESTRUCTEUR pour ce qui n'a pas été poussé — d'où
   la confirmation côté écran, et le fait qu'on ne touche qu'au répertoire de clonage calculé,
   jamais à un chemin fourni par l'appelant. */
app.post('/api/repos/:id/reclone', wrap(async (req, res) => {
  const repo = db.prepare('SELECT * FROM repo WHERE id = ?').get(Number(req.params.id));
  if (!repo) throw new Error(t('err.depot-introuvable'));
  const cfg = getConfig();
  const dir = git.cloneDirFor(cfg, repo);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* déjà absent */ }
  await git.ensureRepo(cfg, repo, () => {});
  res.json({ ok: true, dir });
}));

/* CE QUI RESSEMBLE À UNE URL DE DÉPÔT. Le serveur acceptait n'importe quelle chaîne : « toto »
   devenait un dépôt suivi, et l'erreur ne se voyait qu'au premier clonage — après une découverte
   qui ne rapportait rien. Le front valide déjà ; le serveur ne s'y fie pas (l'API est appelable
   directement, et un `POST` malformé ne doit pas polluer la liste). */
/* Un chemin ABSOLU est une source de clonage parfaitement valide — `git clone /srv/depots/x.git`
   marche, c'est ce que fait le décor de démo, et c'est ce que font les tests. La première
   version de cette garde ne connaissait que http(s) et ssh : elle refusait un dépôt local. */
const RE_URL_DEPOT = /^(https?:\/\/\S+|file:\/\/\S+|\/\S+|(ssh:\/\/)?[\w.-]+@[\w.-]+[:/]\S+)$/i;

app.post('/api/repos', wrap((req, res) => {
  const { url, branch_pattern } = req.body || {};
  if (!url) throw new Error(t('err.l-url-du-depot-est'));
  if (!RE_URL_DEPOT.test(String(url).trim())) throw new Error(t('err.repo-url-invalide'));
  // Forge du dépôt : explicite, sinon déduite de l'URL (github.com → github).
  const forgeName = req.body.forge ? forge.normalizeForge(req.body.forge)
    : (/github/i.test(String(url)) ? 'github' : 'gitlab');
  // project optionnel : déduit de l'URL si non fourni, avec le normalizer de la forge
  const project = (req.body.project || '').trim() || forge.clientFor({ forge: forgeName }).normalizeProject(url);
  if (!project) throw new Error(t('err.impossible-de-deduire-le-chemin'));
  // pattern vide autorisé = toutes les MR (on ne force plus 'PROJ-')
  const pattern = (branch_pattern ?? '').trim();
  const dup = db.prepare('SELECT id FROM repo WHERE project = ? AND COALESCE(forge, ?) = ?').get(project, 'gitlab', forgeName);
  if (dup) throw new Error(t('err.repo-already-added', { project, forge: forge.label(forgeName) }));
  const info = db.prepare(`INSERT INTO repo (project, url, branch_pattern, enabled, created_at, forge)
    VALUES (?, ?, ?, 1, ?, ?)`).run(project, url.trim(), pattern, new Date().toISOString(), forgeName);
  res.json(repoById(info.lastInsertRowid));
}));

app.put('/api/repos/:id', wrap((req, res) => {
  const cur = repoById(Number(req.params.id));
  if (!cur) throw new Error(t('err.repo-introuvable'));
  const { url, branch_pattern, enabled, fetch_mrs } = req.body || {};
  const nextUrl = url != null ? String(url).trim() : cur.url;
  // project : fourni explicitement, sinon déduit de l'URL, sinon inchangé
  let project = (req.body.project || '').trim();
  if (!project) project = url != null ? forge.clientFor(cur).normalizeProject(nextUrl) : cur.project;
  // pattern : vide autorisé (= toutes les MR)
  const pattern = branch_pattern != null ? String(branch_pattern).trim() : cur.branch_pattern;
  db.prepare(`UPDATE repo SET project = ?, url = ?, branch_pattern = ?, enabled = ?, fetch_mrs = ? WHERE id = ?`)
    .run(project || cur.project, nextUrl, pattern,
         enabled == null ? cur.enabled : (enabled ? 1 : 0),
         // absent du corps = inchangé ; NULL d'avant migration = activé, la valeur par défaut
         fetch_mrs == null ? (cur.fetch_mrs == null ? 1 : cur.fetch_mrs) : (fetch_mrs ? 1 : 0),
         cur.id);
  res.json(repoById(cur.id));
}));

app.delete('/api/repos/:id', wrap((req, res) => {
  db.prepare('DELETE FROM repo WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
}));

/* ---------- Répertoires locaux (Réglages → Dépôts) ----------
   Un répertoire local = une racine contenant un sous-dossier par projet git. La
   liste des projets n'est jamais mise en base : elle se relit du disque, sinon un
   dépôt cloné entre deux visites resterait invisible et un dépôt supprimé
   continuerait d'être proposé. */
app.get('/api/local-roots', wrap((req, res) => {
  // Le nombre de projets accompagne chaque racine : c'est ce qui dit d'un coup d'œil
  // que le chemin saisi désigne bien le dossier attendu (et non son parent).
  res.json(localrepos.roots().map((r) => {
    try {
      const list = localrepos.projects(r.id);
      // On renvoie AUSSI la liste (nom, git, branche courante) : l'écran des réglages
      // affiche les projets trouvés sous chaque répertoire, pas seulement leur nombre.
      return {
        ...r,
        count: list.length,
        git_count: list.filter((p) => p.git).length,
        projects: list.map((p) => ({ name: p.name, git: p.git, branch: p.branch })),
        error: null,
      };
    } catch (e) { return { ...r, count: 0, git_count: 0, projects: [], error: e.message }; }
  }));
}));

app.post('/api/local-roots', wrap((req, res) => {
  const { path: p, label } = req.body || {};
  res.json(localrepos.addRoot(p, label));
}));

app.delete('/api/local-roots/:id', wrap((req, res) => {
  res.json(localrepos.removeRoot(Number(req.params.id)));
}));

// Projets d'un répertoire : sous-dossiers directs, avec leur branche courante.
app.get('/api/local-roots/:id/projects', wrap((req, res) => {
  res.json({ root_id: Number(req.params.id), projects: localrepos.projects(Number(req.params.id)) });
}));

// Branches DISTANTES d'un projet local (fetch préalable) + branche courante.
app.get('/api/local-projects/branches', wrap(async (req, res) => {
  res.json(await localrepos.branches(Number(req.query.root_id), req.query.name, { fetch: req.query.fetch !== '0' }));
}));

/* Positionne chaque projet sur sa branche. Appel SYNCHRONE (hors file de jobs) :
   le résultat est un bilan par projet — quel dépôt est passé, lequel a échoué, quels
   fichiers étaient déjà modifiés — et c'est ce bilan que l'écran affiche. Le faire
   passer par un job obligerait à le reconstituer depuis un journal de texte. */
app.post('/api/navigate/checkout', wrap(async (req, res) => {
  const targets = Array.isArray(req.body && req.body.targets) ? req.body.targets : [];
  res.json(await localrepos.checkout(targets));
}));

/* ---------- Commandes Git (palette + exécution multi-projets) ---------- */
const DEMO_GIT_COMMANDS = [
  { id: 1, label: 'Récupérer tout (fetch)', command: 'fetch --all --prune', sort_order: 0 },
  { id: 2, label: 'Statut court', command: 'status --short --branch', sort_order: 1 },
  { id: 3, label: 'Tirer (fast-forward only)', command: 'pull --ff-only', sort_order: 2 },
  { id: 4, label: '10 derniers commits', command: 'log --oneline -10', sort_order: 3 },
];

// Palette (Réglages → Git) : CRUD. Le `command` = arguments git figés (sans le mot « git »).
app.get('/api/git-commands', wrap((req, res) => {
  if (demoDocker.isDemo()) return res.json(DEMO_GIT_COMMANDS);
  res.json(db.prepare('SELECT id, label, command, sort_order FROM git_command ORDER BY sort_order, id').all());
}));
app.post('/api/git-commands', wrap((req, res) => {
  if (demoDocker.isDemo()) return res.json({ demo: true });
  const label = String((req.body && req.body.label) || '').trim();
  const command = String((req.body && req.body.command) || '').trim();
  if (!label || !command) throw new Error(t('err.gitcmd.label-command-required'));
  // Le même filtre qu'à l'exécution : une entrée de palette refusée ne s'enregistre pas.
  localrepos.assertSafeGitArgs(localrepos.parseGitArgs(command));
  const max = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM git_command').get().m;
  const info = db.prepare('INSERT INTO git_command (label, command, sort_order, created_at) VALUES (?, ?, ?, ?)')
    .run(label, command, max + 1, new Date().toISOString());
  res.json(db.prepare('SELECT id, label, command, sort_order FROM git_command WHERE id = ?').get(info.lastInsertRowid));
}));
app.put('/api/git-commands/:id', wrap((req, res) => {
  if (demoDocker.isDemo()) return res.json({ demo: true });
  const cur = db.prepare('SELECT * FROM git_command WHERE id = ?').get(Number(req.params.id));
  if (!cur) throw new Error(t('err.gitcmd.unknown'));
  const label = String((req.body && req.body.label) != null ? req.body.label : cur.label).trim();
  const command = String((req.body && req.body.command) != null ? req.body.command : cur.command).trim();
  if (!label || !command) throw new Error(t('err.gitcmd.label-command-required'));
  localrepos.assertSafeGitArgs(localrepos.parseGitArgs(command));
  db.prepare('UPDATE git_command SET label = ?, command = ? WHERE id = ?').run(label, command, cur.id);
  res.json(db.prepare('SELECT id, label, command, sort_order FROM git_command WHERE id = ?').get(cur.id));
}));
app.delete('/api/git-commands/:id', wrap((req, res) => {
  if (demoDocker.isDemo()) return res.json({ demo: true });
  db.prepare('DELETE FROM git_command WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
}));

// Exécute la commande git à la racine de chaque projet local sélectionné → bilan par projet.
app.post('/api/git-run', wrap(async (req, res) => {
  const targets = Array.isArray(req.body && req.body.targets) ? req.body.targets : [];
  const command = String((req.body && req.body.command) || '');
  res.json(await localrepos.runCommand(targets, command));
}));

/* ---------- Docker (onglet Docker) ----------
   Deux sources : projets COMPOSE (scan des répertoires locaux) et containers HORS-COMPOSE.
   Cœur : le drift .env, comparé sur l'effectif (docker inspect) vs l'attendu (docker compose
   config). Les actions passent par la file de jobs (log streamé). En démo : données statiques. */
app.get('/api/docker/status', wrap(async (req, res) => {
  res.json(demoDocker.isDemo() ? demoDocker.status() : await docker.status());
}));

app.get('/api/docker/compose', wrap(async (req, res) => {
  if (demoDocker.isDemo()) return res.json({ projects: demoDocker.composeProjects() });
  const st = await docker.status();
  if (!st.ok) return res.json({ error: st.error, projects: [] });
  res.json({ projects: await docker.composeProjects(localrepos.roots()) });
}));

// Affichage PROGRESSIF : d'abord la liste légère des fichiers compose (rapide), puis le détail
// de chacun à la demande (/compose/one) → les cartes s'affichent au fur et à mesure.
app.get('/api/docker/compose/list', wrap(async (req, res) => {
  if (demoDocker.isDemo()) return res.json({ files: demoDocker.composeList() });
  const st = await docker.status();
  if (!st.ok) return res.json({ error: st.error, files: [] });
  res.json({ files: await docker.composeFileList(localrepos.roots()) });
}));
app.get('/api/docker/compose/one', wrap(async (req, res) => {
  const dir = String(req.query.dir || '');
  const file = String(req.query.file || '');
  if (demoDocker.isDemo()) return res.json({ project: demoDocker.composeProjects().find((p) => p.dir === dir) || null });
  const st = await docker.status();
  if (!st.ok) return res.json({ error: st.error, project: null });
  res.json({ project: await docker.composeOne(localrepos.roots(), dir, file) });
}));

app.get('/api/docker/orphans', wrap(async (req, res) => {
  if (demoDocker.isDemo()) return res.json({ orphans: demoDocker.orphans() });
  const st = await docker.status();
  if (!st.ok) return res.json({ error: st.error, orphans: [] });
  res.json({ orphans: await docker.orphans() });
}));

// Aperçu d'un `down` (rien n'est exécuté ; les volumes ne sont JAMAIS touchés).
app.post('/api/docker/compose/preview-down', wrap(async (req, res) => {
  const dir = String(req.body && req.body.dir || '');
  if (demoDocker.isDemo()) return res.json(demoDocker.previewDown(req.body && req.body.project));
  if (!dir) throw new Error(t('err.docker.dir-required'));
  jobs.exigerDossierCompose(dir);         // même garde que les actions : pas un dossier quelconque
  res.json(await docker.previewDown(dir));
}));

// Actions compose (up / restart / pull / recreate / down) → file de jobs, log streamé.
app.post('/api/docker/compose/action', wrap((req, res) => {
  const { dir, action, services } = req.body || {};
  if (demoDocker.isDemo()) return res.json({ demo: true });
  if (!dir) throw new Error(t('err.docker.dir-required'));
  if (!['up', 'restart', 'stop', 'pull', 'recreate', 'build', 'down'].includes(action)) throw new Error(t('err.docker.unknown-action'));
  res.json(jobs.startDockerJob({ op: 'compose', dir, action, services: Array.isArray(services) ? services : [] }));
}));

/* ---------- B6 : l'état des services compose d'un répertoire ----------
   On lance la vérification « in place », elle meurt en trois secondes sur `ECONNREFUSED 5432`,
   on va dans Docker, on fait Up, on revient, on relance : quatre écrans pour un oubli. La
   fenêtre de confirmation dit donc l'état des services du projet compose que porte CE
   répertoire, au moment du clic. Un `docker ps` à la demande, jamais un sondage — et rien du
   tout si le répertoire ne porte pas de compose. */
app.get('/api/docker/dir-state', wrap(async (req, res) => {
  const dir = String(req.query.dir || '');
  if (!dir) { res.json({ found: false, services: [] }); return; }
  if (demoDocker.isDemo()) { res.json(demoDocker.dirState(dir)); return; }
  try {
    const roots = db.prepare('SELECT * FROM local_root').all();
    const projets = await docker.composeProjects(roots);
    const p = projets.find((x) => x.dir === dir);
    if (!p) { res.json({ found: false, services: [] }); return; }
    res.json({
      found: true, dir, project: p.name,
      services: (p.services || []).map((sv) => ({
        name: sv.name,
        state: sv.container ? (sv.container.state || 'unknown') : 'none',
      })),
    });
  } catch { res.json({ found: false, services: [] }); }
}));

/* ---------- B8 : les jobs Jenkins liés à un dépôt ----------
   Déclaré une fois dans Réglages → Jenkins, comme service ↔ dépôt dans Liens. Rien n'est
   lancé ici : ces routes ne font que tenir la liste. */
/* B10 — LES LIENS D'UN BUILD. Un job lié à un dépôt vient de déployer avec `ENV=préprod` :
   la question suivante est « est-ce bien parti ? », et elle demandait d'aller dans Liens,
   chercher le dépôt, cliquer la case. On rend ici, pour un dépôt donné, les adresses de son
   service par environnement — la même résolution que sur une merge request, sans `{branch}`
   à substituer puisqu'un build n'en porte pas forcément. */
app.get('/api/jenkins/build-links', wrap((req, res) => {
  const chemin = String(req.query.path || '').trim();
  if (!chemin) return res.json({ envs: [] });
  const lien = db.prepare('SELECT repo_id FROM repo_jenkins WHERE job_path = ? LIMIT 1').get(chemin);
  if (!lien) return res.json({ envs: [] });
  const d = links.liensDeMr({ repo_id: lien.repo_id });
  res.json({ envs: d.envs || [] });
}));

app.get('/api/jenkins/links', wrap((req, res) => {
  res.json({
    links: db.prepare(`SELECT rj.*, repo.project FROM repo_jenkins rj
      JOIN repo ON repo.id = rj.repo_id ORDER BY repo.project, rj.job_path`).all(),
  });
}));
app.post('/api/jenkins/links', wrap((req, res) => {
  const repoId = Number((req.body && req.body.repo_id) || 0);
  const job = String((req.body && req.body.job_path) || '').trim();
  if (!repoId || !db.prepare('SELECT 1 FROM repo WHERE id = ?').get(repoId)) throw new Error(t('err.depot-introuvable'));
  if (!job) throw new Error(t('err.jenkins.job-required'));
  db.prepare('INSERT OR REPLACE INTO repo_jenkins (repo_id, job_path, param) VALUES (?,?,?)')
    .run(repoId, job, String((req.body && req.body.param) || '').trim() || null);
  res.json({ ok: true });
}));
app.delete('/api/jenkins/links/:id', wrap((req, res) => {
  db.prepare('DELETE FROM repo_jenkins WHERE id = ?').run(Number(req.params.id) || 0);
  res.json({ ok: true });
}));

/* La dernière exécution de chaque cible d'un répertoire : « migrate · il y a 40 min · ✓ ».
   Purement local, une ligne par cible, écrasée à chaque lancement. */
app.get('/api/docker/make/runs', wrap((req, res) => {
  const dir = String(req.query.dir || '');
  if (!dir) throw new Error(t('err.docker.dir-required'));
  const out = {};
  for (const r of db.prepare('SELECT * FROM make_run WHERE dir = ?').all(dir)) {
    out[r.target] = { started_at: r.started_at, finished_at: r.finished_at, ok: r.ok };
  }
  res.json({ runs: out });
}));

// Exécute une commande (cible) du Makefile situé à côté du compose → file de jobs, log streamé.
app.post('/api/docker/make/run', wrap((req, res) => {
  const { dir, target } = req.body || {};
  if (demoDocker.isDemo()) return res.json({ demo: true });
  if (!dir) throw new Error(t('err.docker.dir-required'));
  if (!target) throw new Error(t('err.docker.target-required'));
  res.json(jobs.startDockerJob({ op: 'make', dir, target }));
}));

// Action groupée : UNE action (up/restart/stop/pull/recreate) appliquée aux services compose
// COCHÉS, groupés par répertoire de projet → un `docker compose` par projet, dans un seul job.
app.post('/api/docker/bulk-action', wrap((req, res) => {
  const { action, targets } = req.body || {};
  if (demoDocker.isDemo()) return res.json({ demo: true });
  if (!['up', 'restart', 'stop', 'pull', 'recreate', 'build'].includes(action)) throw new Error(t('err.docker.unknown-action'));
  const list = Array.isArray(targets) ? targets.filter((x) => x && x.dir && x.service) : [];
  if (!list.length) throw new Error(t('err.docker.no-target'));
  const byDir = new Map();
  for (const x of list) { if (!byDir.has(x.dir)) byDir.set(x.dir, []); byDir.get(x.dir).push(String(x.service)); }
  const groups = [...byDir.entries()].map(([dir, services]) => ({ dir, services }));
  res.json(jobs.startDockerJob({ op: 'compose-bulk', action, groups }));
}));

// Commande `docker run` reconstituée depuis l'inspect d'un container hors-compose.
app.get('/api/docker/orphan/:id/reconstitute', wrap(async (req, res) => {
  const id = String(req.params.id);
  if (demoDocker.isDemo()) return res.json(demoDocker.reconstituteDemo(id));
  if (!docker.validRef(id)) throw new Error(t('err.docker.invalid-id'));
  const det = await docker.inspect(id);
  det.__imageEnv = await docker.imageEnv(det && det.Config && det.Config.Image);
  res.json({ command: docker.reconstructRunCommand(det) });
}));

// Arrêt d'un container hors-compose (sans le supprimer).
app.post('/api/docker/orphan/:id/stop', wrap((req, res) => {
  const id = String(req.params.id);
  if (demoDocker.isDemo()) return res.json({ demo: true });
  if (!docker.validRef(id)) throw new Error(t('err.docker.invalid-id'));
  res.json(jobs.startDockerJob({ op: 'orphan-stop', id }));
}));

// Suppression d'un container hors-compose : on SAUVEGARDE d'abord son inspect (restauration),
// puis on supprime via la file de jobs.
app.post('/api/docker/orphan/:id/remove', wrap(async (req, res) => {
  const id = String(req.params.id);
  if (demoDocker.isDemo()) return res.json({ demo: true });
  if (!docker.validRef(id)) throw new Error(t('err.docker.invalid-id'));
  const det = await docker.inspect(id);
  det.__imageEnv = await docker.imageEnv(det && det.Config && det.Config.Image);
  db.prepare('INSERT INTO docker_backup (container_id, name, image, inspect_json, run_command, created_at) VALUES (?,?,?,?,?,?)')
    .run(id, String(det.Name || '').replace(/^\//, ''), det.Config && det.Config.Image, JSON.stringify(det), docker.reconstructRunCommand(det), new Date().toISOString());
  res.json(jobs.startDockerJob({ op: 'orphan-remove', id }));
}));

// Sauvegardes d'inspect (restauration des orphelins supprimés).
/* B8 — LA CASE « LOCAL » QUE LE COMPOSE CONNAÎT DÉJÀ. On ajoute `webapp-front` à la grille et
   on tape `localhost:3000` — que le projet compose affiché juste à côté sait déjà, puisqu'il
   publie ce port. On relie le dossier à son dépôt par le remote lu dans `.git/config`, le
   dépôt à son service dans la grille, et on rend l'adresse à poser. Rien n'est écrit sans
   clic : on PROPOSE, la grille reste la vérité. */
app.get('/api/docker/local-links', wrap((req, res) => {
  const dir = String(req.query.dir || '').trim();
  if (!dir) return res.json({ service: null, ports: [] });
  const g = docker.gitDuRepertoire(dir);
  if (!g || !g.remote) return res.json({ service: null, ports: [] });
  const depots = db.prepare('SELECT id, project, url FROM repo').all();
  const cible = depots.find((r) => verifyLib.memeDepot(r.url, g.remote));
  if (!cible) return res.json({ service: null, ports: [] });
  const service = db.prepare('SELECT id, name FROM service WHERE repo_id = ? ORDER BY id LIMIT 1').get(cible.id);
  if (!service) return res.json({ service: null, ports: [] });
  /* L'environnement « local » de la grille, s'il existe : c'est celui que le compose
     renseigne. Sans lui, il n'y a pas de case à remplir — et en créer un d'office
     réarrangerait la grille de quelqu'un sans qu'il l'ait demandé. */
  const env = db.prepare("SELECT id, name FROM environment WHERE LOWER(name) IN ('local','localhost') ORDER BY id LIMIT 1").get();
  const dejaLa = env ? db.prepare('SELECT COUNT(*) c FROM service_url WHERE service_id = ? AND environment_id = ?')
    .get(service.id, env.id).c : 0;
  res.json({
    service: { id: service.id, name: service.name, project: cible.project },
    environment: env || null,
    filled: !!dejaLa,
  });
}));

app.get('/api/docker/backups', wrap((req, res) => {
  res.json(db.prepare('SELECT id, container_id, name, image, run_command, created_at FROM docker_backup ORDER BY id DESC LIMIT 100').all());
}));

/* A/Docker 1 — RESTAURER. La sauvegarde était écrite avant chaque suppression et relue par
   personne. On rejoue l'inspect COMPLET (celui qui porte les vraies variables, pas la ligne
   affichée qui masque les secrets), via la file de jobs comme toute opération Docker. */
app.post('/api/docker/backups/:id/restore', wrap((req, res) => {
  const row = db.prepare('SELECT * FROM docker_backup WHERE id = ?').get(Number(req.params.id));
  if (!row) throw new Error(t('err.docker.backup-not-found'));
  if (demoDocker.isDemo()) return res.json({ demo: true });
  let inspect = null;
  try { inspect = JSON.parse(row.inspect_json || 'null'); } catch { inspect = null; }
  if (!inspect) throw new Error(t('err.docker.backup-unreadable'));
  res.json(jobs.startDockerJob({ op: 'orphan-restore', inspect }));
}));

/* La sauvegarde d'un container qu'on ne compte plus refaire : elle porte des variables
   d'environnement, elle ne doit pas s'accumuler sans qu'on puisse la retirer. */
app.delete('/api/docker/backups/:id', wrap((req, res) => {
  const n = db.prepare('DELETE FROM docker_backup WHERE id = ?').run(Number(req.params.id)).changes;
  if (!n) throw new Error(t('err.docker.backup-not-found'));
  res.json({ ok: true });
}));

// Résumé santé (badge de menu) : nb en erreur (restarting/dead) + nb unhealthy.
app.get('/api/docker/summary', wrap(async (req, res) => {
  if (demoDocker.isDemo()) return res.json(demoDocker.summary());
  const st = await docker.status();
  if (!st.ok) return res.json({ error: 0, unhealthy: 0, total: 0, running: 0, down: true });
  res.json(await docker.summary());
}));

// Liste plate des containers (pour choisir lesquels tailer dans l'onglet Logs).
app.get('/api/docker/containers', wrap(async (req, res) => {
  if (demoDocker.isDemo()) return res.json({ containers: demoDocker.containers() });
  const st = await docker.status();
  if (!st.ok) return res.json({ error: st.error, containers: [] }); // démon absent → liste vide, pas un 400
  res.json({ containers: await docker.listContainers() });
}));

// Tail LIVE (SSE) des logs de plusieurs containers. Le filtrage inclure/exclure est fait
// CÔTÉ CLIENT (dynamique, sans relancer le flux). On spawn un `docker logs -f` par container
// et on les TUE dès que le client se déconnecte (fermeture d'onglet, Stop, changement de vue).
/* UN PLAFOND GLOBAL DE FLUX. Chaque flux lance jusqu'à douze `docker logs -f` ; sans plafond,
   des onglets oubliés — ou une page qui les ouvrirait en boucle — empilaient des processus
   jusqu'à épuiser la machine. Quatre flux, c'est deux fois l'usage réel. */
const FLUX_DOCKER_MAX = 4;
let fluxDockerOuverts = 0;
app.get('/api/docker/logs/stream', (req, res) => {
  const ids = String(req.query.ids || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 12);
  const tail = req.query.tail;
  if (!ids.length) { res.status(400).end('no containers'); return; }
  if (fluxDockerOuverts >= FLUX_DOCKER_MAX) {
    res.status(429).json({ error: t('err.docker.too-many-streams', { n: FLUX_DOCKER_MAX }) });
    return;
  }
  fluxDockerOuverts += 1;
  let compte = true;
  req.on('close', () => { if (compte) { compte = false; fluxDockerOuverts -= 1; } });
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // pas de buffering proxy : les lignes arrivent en direct
  });
  res.write(': ok\n\n');

  if (demoDocker.isDemo()) { demoDocker.streamLogs(ids, res); return; }

  const children = [];
  let closed = false;
  let hb = null;
  const send = (obj) => { if (!closed) { try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch { /* socket fermé */ } } };
  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (hb) clearInterval(hb);
    for (const c of children) { try { c.kill('SIGKILL'); } catch { /* déjà mort */ } }
  };
  req.on('close', cleanup);
  hb = setInterval(() => { if (closed) return; try { res.write(': hb\n\n'); } catch { cleanup(); } }, 20000);

  ids.forEach(async (id) => {
    try {
      const child = await docker.spawnLogs(id, tail);
      if (closed) { try { child.kill('SIGKILL'); } catch { /* course : client déjà parti */ } return; }
      children.push(child);
      /* Un StringDecoder par flux, et non `String(chunk)` : un caractère UTF-8 multi-octets
         à cheval sur deux chunks serait sinon décodé en deux moitiés invalides, et chaque
         accent tombant sur une frontière deviendrait un « ￰ ». Le decoder garde l'octet
         orphelin pour le chunk suivant. */
      const dec = { o: new StringDecoder('utf8'), e: new StringDecoder('utf8') };
      const buf = { o: '', e: '' };
      const pump = (chunk, which) => {
        const parts = (buf[which] + dec[which].write(chunk)).split('\n');
        buf[which] = parts.pop();
        /* La ligne part BRUTE, séquences de couleur comprises : c'est le client qui décide
           d'afficher du texte nu (par défaut) ou des couleurs, sans relancer le flux.
           Nettoyer ici interdirait la case à cocher. */
        for (const line of parts) send({ c: id, m: line });
      };
      child.stdout.on('data', (d) => pump(d, 'o'));
      child.stderr.on('data', (d) => pump(d, 'e'));
      child.on('error', (e) => send({ c: id, sys: 'error', m: e.message }));
      child.on('close', () => send({ c: id, sys: 'closed' }));
    } catch (e) {
      send({ c: id, sys: 'error', m: docker.explainDockerError ? docker.explainDockerError(e.message) : e.message });
    }
  });
});

// Liste les projets GitLab accessibles, en marquant ceux déjà ajoutés.
app.get('/api/gitlab/projects', wrap(async (req, res) => {
  const cfg = getConfig();
  const projects = await forge.gitlab.listAccessibleProjects(cfg);
  const existing = new Set(db.prepare('SELECT project FROM repo').all().map((r) => r.project));
  res.json(projects.map((p) => ({ ...p, already: existing.has(p.project) })));
}));

/* TEST DE LA CONNEXION GITLAB, SUR LES VALEURS DU FORMULAIRE — comme le fait déjà
   `/github/test`. La version précédente lisait la configuration ENREGISTRÉE : au premier
   lancement, on saisissait l'URL et le jeton, on cliquait « Tester la connexion », et on se
   faisait répondre « Token GitLab non configuré » par une application qui avait la valeur sous
   les yeux. Deux boutons jumeaux ne peuvent pas avoir deux comportements.
   Le masque `***` signifie « champ non touché » : on teste alors avec le jeton en base. */
app.post('/api/gitlab/test', wrap(async (req, res) => {
  const cfg = getConfig();
  const test = { ...cfg };
  if (req.body && req.body.gitlab_url != null) exigerJetonFrais(req.body.gitlab_url, cfg.gitlab_url, req.body.access_token, cfg.access_token);
  if (req.body && req.body.gitlab_url != null) test.gitlab_url = req.body.gitlab_url;
  if (req.body && req.body.access_token && req.body.access_token !== '***') test.access_token = req.body.access_token;
  if (!forge.isConfigured(test, 'gitlab')) throw new Error(t('err.gitlab-test-incomplet'));
  try {
    const projects = await forge.gitlab.listAccessibleProjects(test);
    noterTest('gitlab', true, String(projects.length));
    res.json({ ok: true, count: projects.length });
  } catch (e) { noterTest('gitlab', false, e.message); throw e; }
}));

// Liste les branches d'un dépôt (pour choisir la branche de base d'une tâche).
app.get('/api/gitlab/branches', wrap(async (req, res) => {
  const repo = repoById(Number(req.query.repo_id));
  if (!repo) throw new Error(t('err.depot-introuvable'));
  const r = await forge.clientFor(repo).listBranches(getConfig(), repo.project);
  res.json(r);
}));

// Liste les dépôts GitHub accessibles, en marquant ceux déjà ajoutés.
app.get('/api/github/projects', wrap(async (req, res) => {
  const cfg = getConfig();
  const projects = await forge.github.listAccessibleProjects(cfg);
  const existing = new Set(db.prepare("SELECT project FROM repo WHERE forge = 'github'").all().map((r) => r.project));
  res.json(projects.map((p) => ({ ...p, already: existing.has(p.project) })));
}));

// Test de la connexion GitHub : renvoie le compte associé au token.
// Le front peut renvoyer le masque : on teste alors avec le token déjà en base.
app.post('/api/github/test', wrap(async (req, res) => {
  const cfg = getConfig();
  const test = { ...cfg };
  if (req.body && req.body.github_url != null) exigerJetonFrais(req.body.github_url, cfg.github_url, req.body.github_token, cfg.github_token, 'https://github.com');   // l'hôte WEB, défaut de `github.webBase`
  if (req.body && req.body.github_url != null) test.github_url = req.body.github_url;
  if (req.body && req.body.github_token && req.body.github_token !== '***') test.github_token = req.body.github_token;
  if (!forge.github.isConfigured(test)) throw new Error(t('err.token-github-non-configure'));
  try {
    const r = await forge.github.testConnection(test);
    noterTest('github', true, r.login || '');
    res.json({ ok: true, ...r });
  } catch (e) { noterTest('github', false, e.message); throw e; }
}));

// Ajout en masse de dépôts sélectionnés (ignore les doublons).
app.post('/api/repos/bulk', wrap((req, res) => {
  const { projects, branch_pattern } = req.body || {};
  if (!Array.isArray(projects) || !projects.length) throw new Error(t('err.aucun-projet-selectionne'));
  // `forge` absent = gitlab : le contrat de l'API ne change pas pour l'existant.
  const forgeName = forge.normalizeForge(req.body && req.body.forge);
  const api = forge.clientFor({ forge: forgeName });
  const pattern = (branch_pattern ?? '').trim();
  const now = new Date().toISOString();
  // Unicité par COUPLE (forge, projet) : « acme/web » peut exister sur les deux forges.
  const key = (f, p) => `${f}:${p}`;
  const existing = new Set(db.prepare('SELECT project, forge FROM repo').all()
    .map((r) => key(forge.forgeOf(r), r.project)));
  const ins = db.prepare('INSERT INTO repo (project, url, branch_pattern, enabled, created_at, forge) VALUES (?,?,?,1,?,?)');
  let added = 0; let skipped = 0;
  const tx = db.transaction((list) => {
    for (const p of list) {
      const proj = api.normalizeProject(p.project || p.url);
      if (!proj || existing.has(key(forgeName, proj))) { skipped += 1; continue; }
      ins.run(proj, String(p.url || '').trim(), pattern, now, forgeName);
      existing.add(key(forgeName, proj)); added += 1;
    }
  });
  tx(projects);
  res.json({ added, skipped });
}));

/* NOMMER ET ÉPINGLER UNE ITÉRATION. Une seule route pour les quatre saveurs : une passe se
   désigne par l'identifiant de sa ligne, qui est déjà unique. Quatre routes parallèles auraient
   dérivé, et c'est exactement le genre d'endroit où une saveur se fait oublier. */
app.put('/api/agent-passes/:id', wrap((req, res) => {
  const body = req.body || {};
  const maj = agentpass.marquer(req.params.id, {
    favori: body.favori === undefined ? undefined : !!body.favori,
    titre: body.titre === undefined ? undefined : body.titre,
  });
  if (!maj) throw Object.assign(new Error(t('err.pass-introuvable')), { status: 404 });
  res.json(maj);
}));

/* Liste des passes d'une unité + la passe demandée (la dernière par défaut). Commun aux
   sessions sur dépôt et au codage hors dépôt : une seule forme de réponse à afficher. */
/* « CETTE ITÉRATION N'A RIEN CHANGÉ » — et la façon de le savoir SANS le diff local.
 *
 * On le déduisait de « on a mesuré (`head_sha`) mais aucun patch n'a été rangé ». Le patch est un
 * fichier de CE poste : il ne voyage pas, et sur une session reçue du dépôt d'équipe la règle
 * disait donc « rien changé » à chaque itération — un mensonge, et le genre qui fait douter de
 * tout l'écran. Les deux SHA, eux, voyagent : égaux, l'agent n'a rien commité ; différents sans
 * patch sous la main, on ne sait pas — et l'écran se tait, ce qu'il sait déjà faire. */
const sansChangement = (p) => !!(p && p.base_sha && p.head_sha && p.base_sha === p.head_sha);
/** Le patch n'est pas là, mais ses deux bornes le sont : git peut le refaire à l'identique. */
const recalculable = (p) => !!(p && p.base_sha && p.head_sha && p.base_sha !== p.head_sha);

/* Y A-T-IL UN RETOUR D'AGENT À MONTRER, pour chaque unité d'une session ? La question se posait
   à `output_path` — un chemin de CE poste. Sur une session reçue du dépôt d'équipe, ce pointeur
   est vide tant qu'aucune passe n'a été hydratée, et le bouton « Retour de l'IA » disparaissait
   alors que le texte de chaque itération était là. La vraie réponse est dans `agent_pass`, qui
   voyage. Une requête pour toute la liste : l'écran des sessions se redessine toutes les
   secondes et demie. */
function unitesAvecRetour(scope, taskId) {
  const vus = new Set();
  for (const r of db.prepare(
    'SELECT DISTINCT unit_id FROM agent_pass WHERE scope = ? AND task_id = ?',
  ).all(scope, Number(taskId))) vus.add(r.unit_id);
  return vus;
}

function passesPayload(scope, unitId, taskId, wantedN, title, legacyOutputPath) {
  /* Le PROMPT part avec la liste : la colonne de gauche montre chaque itération par la demande
     qui l'a produite, et son champ de recherche cherche dans ce que l'utilisateur a écrit. Le
     tronquer ici ferait mentir la recherche — une correspondance au-delà de la coupe ne
     remonterait jamais. Une session compte quelques itérations, pas des milliers. */
  const passes = agentpass.list(scope, taskId, unitId)
    .map((p) => ({
      id: p.id, n: p.n, kind: p.kind, created_at: p.created_at, has_output: !!p.output_path,
      prompt: p.prompt || '', favori: p.favori ? 1 : 0, titre: p.titre || '',
      /* CE QUE CETTE ITÉRATION A CHANGÉ, ou le fait qu'elle n'ait rien changé : deux états
         distincts, et un troisième — on ne sait pas — pour tout ce qui n'a pas de git (le
         hors-dépôt, une question libre) ou date d'avant la mesure. L'écran ne doit proposer
         « voir le diff » que pour le premier. */
      /* LE DIFF EST PROMIS S'IL EST RECALCULABLE : les deux bornes suffisent, et elles
         voyagent. Sur le poste du collègue, le patch n'est pas là mais git sait le refaire. */
      has_diff: !!p.diff_path || recalculable(p), no_change: sansChangement(p),
      /* Le coût de CETTE itération. Il était lu en base et jamais servi : on voyait le total
         de la session, jamais laquelle des six passes avait coûté la moitié. */
      cost_usd: p.cost_usd == null ? null : p.cost_usd,
    }));

  /* Sessions antérieures à l'historique des passes : elles n'ont aucune ligne
     `agent_pass`, mais leur `output_path` pointe toujours un retour valide. On le
     présente comme une passe unique — sans lui, « Retour de l'IA » deviendrait vide
     sur tout l'existant. Le prompt de l'époque, lui, n'a pas été conservé. */
  /* Les blocs de protocole (`<<<REPO>>>`, `<<<STALE>>>`, `<<<AGENT>>>`) sont un canal de
     service entre l'agent et le code : ils ne s'affichent pas plus ici que dans `/md`. */
  if (!passes.length) {
    const brut = legacyOutputPath ? readFileSafe(legacyOutputPath) : null;
    const output = brut ? protocol.nettoyer(brut) : null;
    if (!output) return { title, passes: [], current: null };
    return {
      title,
      /* Passe ANTÉRIEURE à l'historique : aucune ligne en base, donc pas d'identifiant — elle
         ne peut être ni nommée ni mise en favori, et l'écran n'en propose pas le geste. */
      passes: [{ n: 1, kind: 'legacy', created_at: null, has_output: true, prompt: '', id: null, favori: 0, titre: '' }],
      current: { n: 1, kind: 'legacy', created_at: null, prompt: '', output },
    };
  }

  const n = Number(wantedN) || passes[passes.length - 1].n;
  const current = agentpass.get(scope, taskId, unitId, n);
  return {
    title,
    passes,
    current: current ? {
      id: current.id, n: current.n, kind: current.kind, created_at: current.created_at,
      prompt: current.prompt, output: current.output ? protocol.nettoyer(current.output) : current.output, favori: current.favori ? 1 : 0, titre: current.titre || '',
      has_diff: !!current.diff_path || recalculable(current), no_change: sansChangement(current),
      cost_usd: current.cost_usd == null ? null : current.cost_usd,
    } : null,
  };
}

/* « PAR <NOM> » — sans colonne `author`, et c'est le point.
 *
 * Le fichier d'un objet partagé a été commité par quelqu'un : git le sait, et le redemander ne
 * coûte rien puisque `datasync` garde le nom en cache. Tenir une colonne à côté, ce serait une
 * seconde vérité à aligner — et elle mentirait le jour où quelqu'un corrige le fichier à la main.
 *
 * `null` quand le partage n'est pas configuré : en mono-poste, « par moi » sur chaque carte
 * n'apprendrait rien à personne. */
function auteurs(table, rows) {
  if (!datasync.estConfigure() || !rows.length) return new Map();
  const chemins = new Map();
  for (const r of rows) {
    const c = store.cheminSur(table, r);
    if (c) chemins.set(r.id, c);
  }
  const parFichier = datasync.auteursDe([...new Set(chemins.values())]);
  return new Map([...chemins].map(([id, c]) => [id, parFichier.get(c) || null]));
}

/* SEUL L'AUTEUR BASCULE OU SUPPRIME CE QUI EST PARTAGÉ.
 *
 * L'auteur n'est pas une colonne : c'est celui qui a commité le fichier, et git le sait
 * (`auteurs`). Une session sans auteur n'est jamais partie — elle est donc à nous. Un collègue
 * qui reçoit la session d'un autre peut la RANGER chez lui (`hidden`, une préférence de poste)
 * mais pas la retirer du dépôt : ce serait effacer le travail de quelqu'un d'autre chez tout le
 * monde. Un « retrait local » sans rangement n'existe pas dans ce modèle — le fichier fait foi,
 * la ligne reviendrait au `pull` suivant. */
function auteurDeLigne(table, row) {
  return auteurs(table, [row]).get(row.id) || null;
}
function exigerProprietaire(table, row) {
  const auteur = auteurDeLigne(table, row);
  const moi = identite.nom() || null;
  if (!auteur || !moi || auteur === moi) return;
  const e = new Error(t('session.err.not-owner', { who: auteur }));
  e.status = 403;
  throw e;
}

/* La bascule « partager / ne plus partager » d'une session, pour les trois saveurs.
   LES ENFANTS SUIVENT : passes et pièces jointes n'ont pas de case à elles, mais leurs fichiers
   doivent apparaître (ou disparaître) avec la session. Rien ne les a touchés, donc rien ne les a
   mis dans la file : on les y met nous-mêmes. */
function basculerPartage(table, scope, row, shared) {
  exigerProprietaire(table, row);
  const v = shared ? 1 : 0;
  store.ecrire(table, () => {
    db.prepare(`UPDATE ${table} SET shared = ?, updated_at = ? WHERE id = ?`)
      .run(v, new Date().toISOString(), row.id);
    return row.id;
  });
  db.prepare("INSERT INTO store_sale (tbl, rid) SELECT 'agent_pass', rowid FROM agent_pass WHERE scope = ? AND task_id = ?")
    .run(scope, row.id);
  db.prepare("INSERT INTO store_sale (tbl, rid) SELECT 'piece_jointe', rowid FROM piece_jointe WHERE scope = ? AND owner_id = ?")
    .run(scope, row.id);
  store.ecouler();
  return v;
}

/* RANGER UNE SESSION EST UN GESTE DE POSTE. `hidden` a quitté les tables `task`, `local_task` et
   `question` : la supprimer la supprime pour tout le monde, mais la RANGER ne doit la retirer
   que de sa propre vue — le collègue qui la regarde n'a pas demandé qu'elle disparaisse. La
   préférence vit dans `local_pref`, rangée sous l'`uid` de la session, et l'API continue
   d'exposer le même champ : l'écran ne voit pas la différence.

   `carte()` en une requête plutôt qu'une par ligne : ces listes se redessinent toutes les
   secondes et demie. */
const rangement = (kind) => prefLocale.carte(kind, 'hidden');
const avecRangement = (kind, row, carte = null) => (row
  ? { ...row, hidden: ((carte || rangement(kind)).get(row.uid) === '1') ? 1 : 0 }
  : row);

/* ---------- Tasks (tâches de dev pilotées par l'IA) ---------- */
function taskById(id) {
  return avecRangement('task', db.prepare(`SELECT task.*, repo.project AS project, repo.forge AS forge FROM task JOIN repo ON repo.id = task.repo_id WHERE task.id = ?`).get(id));
}
// Les projets d'une session, avec leur état d'exécution propre (commit, diff, MR…).
function taskTargets(taskId) {
  /* Les options du profil, s'il y en a un : la commande « Reprendre au terminal » doit
     reprendre LA MÊME session — sans son modèle ni son allowlist, ce serait une autre. */
  const optionsAgent = agentprofile.optionsFor(db.prepare('SELECT * FROM task WHERE id = ?').get(taskId));
  const poignees = localsession.carte('task_target');   // une requête, pas une par projet
  /* `has_review` : la merge request de ce projet porte-t-elle un rapport ? C'est ce qui décide
     de l'apparition du bouton « Reprendre le rapport de review » sur le formulaire de suivi.
     Un booléen, pas le rapport lui-même — la liste des sessions n'a pas à charrier le Markdown
     de chaque rapport à chaque rafraîchissement, c'est-à-dire toutes les secondes et demie.
     On accepte les DEUX rattachements, comme `effectiveMr` : la MR ouverte par l'application
     (`tt.mr_iid`) ou celle déjà connue sur la même branche. */
  const rows = db.prepare(`SELECT tt.*, repo.project AS project, repo.forge AS forge,
      mr.iid AS existing_mr_iid, mr.web_url AS existing_mr_url,
      mr.ticket_jira_key AS mr_ticket_key, mr.ticket_jira_status AS mr_ticket_status,
      mr.ticket_jira_category AS mr_ticket_category,
      (SELECT 1 FROM review r2 JOIN mr m2 ON m2.id = r2.mr_id
        WHERE m2.repo_id = tt.repo_id AND (m2.iid = tt.mr_iid OR m2.source_branch = tt.branch)
        LIMIT 1) AS has_review,
      (SELECT m3.id FROM mr m3
        WHERE m3.repo_id = tt.repo_id AND (m3.iid = tt.mr_iid OR m3.source_branch = tt.branch)
        LIMIT 1) AS mr_row_id
    FROM task_target tt
    JOIN repo ON repo.id = tt.repo_id
    LEFT JOIN mr ON mr.repo_id = tt.repo_id AND mr.source_branch = tt.branch
      AND (mr.closed_seen IS NULL OR mr.closed_seen = 0)
    WHERE tt.task_id = ? ORDER BY tt.id`).all(taskId);
  // `questions_json` (bloc <<<QUESTIONS>>>) exposé parsé pour le formulaire de réponses.
  // `resume_cmd` : commande à copier pour reprendre la session d'agent dans un terminal.
  /* `has_verify_fail` : la vérification la plus récente de la merge request de ce projet
     a-t-elle CASSÉ quelque chose, et par la faute de cette branche ? C'est ce qui décide de
     l'apparition du bouton « Reprendre le rapport de vérif » sur le formulaire de suivi.
     La table des dernières vérifications balaie trois cents lignes : la RECALCULER pour chaque
     session ferait N fois ce travail sur l'écran qui en liste vingt, et cet écran se redessine
     toutes les secondes et demie pendant un job. On la mémorise donc le temps d'une requête —
     `cacheVerifs` est vidé à chaque entrée de route. */
  const parMr = rows.some((r) => r.mr_row_id) ? verifsParMrDuTour() : new Map();
  /* CE QUE LA MERGE REQUEST DE CE PROJET EST DEVENUE. Il fallait retourner dans Reviews pour
     savoir où en était ce que la session avait produit : la note, le verdict, et s'il y a des
     commentaires en attente d'envoi. Tout est déjà en base — une requête pour toute la liste,
     pas une par ligne, sur un écran qui se redessine toutes les secondes et demie. */
  const avecRetour = unitesAvecRetour('task', taskId);
  const notesParMr = {};
  const cmtParMr = {};
  if (rows.some((r) => r.mr_row_id)) {
    const ids = [...new Set(rows.map((r) => r.mr_row_id).filter(Boolean))];
    const trous = ids.map(() => '?').join(',');
    for (const rv of db.prepare(`SELECT mr_id, note_value FROM review_version rv
      WHERE mr_id IN (${trous}) AND version = (SELECT MAX(v2.version) FROM review_version v2 WHERE v2.mr_id = rv.mr_id)`).all(...ids)) {
      notesParMr[rv.mr_id] = rv.note_value;
    }
    for (const c of db.prepare(`SELECT mr_id, COUNT(*) n FROM mr_comment_draft
      WHERE mr_id IN (${trous}) GROUP BY mr_id`).all(...ids)) cmtParMr[c.mr_id] = c.n;
  }
  return rows.map((r) => {
    let questions = null;
    try { questions = r.questions_json ? JSON.parse(r.questions_json) : null; } catch { questions = null; }
    const v = r.mr_row_id ? parMr.get(r.mr_row_id) : null;
    /* MÊME condition que la route qui rend le prompt : verdict rouge ET des tests imputables à
       ces branches. Un bouton qui répondrait « rien à reprendre » une fois cliqué ferait perdre
       un geste — et une base déjà rouge n'est pas de notre fait. */
    let imputables = [];
    try { imputables = v && v.imputable_json ? JSON.parse(v.imputable_json) : []; } catch { imputables = []; }
    const echec = !!(v && v.verdict === 'verified_fail' && imputables.length);
    /* LE HANDLE DE SESSION NE VIENT PLUS DE LA LIGNE : il ne vaut que dans le `~/.claude` de la
       machine qui l'a créée, donc il vit dans `local_session`. Recollé ICI, en tête, pour que
       tout ce qui suit — `resume_cmd` compris — lise la valeur recollée et non le vide laissé
       dans la table. */
    const ligne = localsession.resoudre('task_target', r, poignees);
    return {
      ...ligne, questions, has_verify_fail: echec ? 1 : 0,
      // Le bouton « Retour de l'IA » se décide sur les PASSES, qui voyagent — pas sur un chemin local.
      has_output: (avecRetour.has(r.id) || !!r.output_path) ? 1 : 0,
      /* MÊME HISTOIRE POUR LE DIFF DE LA BRANCHE. Le patch est rangé dans un fichier de CE
         poste ; la route, elle, sait déjà le refaire depuis le clone quand il manque. Ce qui
         dit qu'il y a quelque chose à montrer, c'est le COMMIT — et lui voyage. */
      has_diff: (!!r.diff_path || !!r.commit_sha) ? 1 : 0,
      mr_note: r.mr_row_id != null ? (notesParMr[r.mr_row_id] != null ? notesParMr[r.mr_row_id] : null) : null,
      mr_verdict: v ? v.verdict : null,
      mr_drafts: r.mr_row_id ? (cmtParMr[r.mr_row_id] || 0) : 0,
      /* B5 — L'ÉTAT DU TICKET, sur la ligne de projet. La ligne dit la note, le verdict et les
         brouillons ; elle taisait le ticket, alors que `taskTargets` joint déjà la merge
         request et que `mr.ticket_jira_*` est rempli à la découverte. « Le ticket est repassé
         en cours » change ce qu'on fait de la branche autant qu'un test rouge. */
      ticket_key: r.mr_ticket_key || null,
      ticket_status: r.mr_ticket_status || null,
      ticket_category: r.mr_ticket_category || null,
      resume_cmd: agentsession.resumeCommand(ligne.session_backend, ligne.session_key, ligne.session_cwd, optionsAgent),
    };
  });
}
// MR effectivement rattachée à un projet de session : celle créée par l'app, sinon
// une MR ouverte déjà connue sur la même branche.
function effectiveMr(tg) {
  if (!tg) return null;
  if (tg.mr_iid) return { iid: tg.mr_iid, fromApp: true };
  const found = db.prepare(`SELECT iid FROM mr
    WHERE repo_id = ? AND source_branch = ? AND (closed_seen IS NULL OR closed_seen = 0)
    LIMIT 1`).get(tg.repo_id, tg.branch);
  return found ? { iid: found.iid, fromApp: false } : null;
}
function targetById(taskId, targetId) {
  return localsession.resoudre('task_target', db.prepare(`SELECT tt.*, repo.project AS project, repo.forge AS forge
    FROM task_target tt JOIN repo ON repo.id = tt.repo_id
    WHERE tt.id = ? AND tt.task_id = ?`).get(targetId, taskId));
}
// Valide la liste des projets. En codage la branche de travail est obligatoire ;
// en exploration elle est facultative (défaut : branche par défaut du dépôt).
// Vérification et normalisation des projets d'une session — partagée avec les runs d'agent.
const normalizeTargets = tasks.normalizeTargets;

const insertTargets = tasks.insertTargets;

/* Un identifiant de session est passé TEL QUEL à l'agent : `--resume <id>` pour claude,
   `COPILOT_HOME=<chemin>` pour copilot. Il ne doit donc jamais pouvoir passer pour un flag,
   et pour claude il a une forme connue — autant refuser tout de suite plutôt que d'échouer
   au milieu d'un job, une fois les dépôts clonés. */
/* Applique une session fournie aux unités d'une session (projets ou dossiers). N'écrit QUE
   si la valeur change vraiment : rouvrir la modale pour corriger un prompt ne doit pas
   réécrire des handles corrects, ni effacer le `session_cwd` qui protège la reprise.
   Un champ VIDE ne signifie jamais « efface » — on ne perd pas une session d'un formulaire
   simplement soumis ; pour repartir à neuf, on change les unités, ce qui les recrée. */
function applySessionId(scope, key, taskId, sessionId, units) {
  if (!sessionId) return;
  const commun = units.length && units.every((u) => u.session_key && u.session_key === units[0].session_key)
    ? units[0].session_key : null;
  if (sessionId === commun) return;
  /* `session_cwd` reste NUL : on ignore d'où vient la session fournie, et le garde-fou « même
     dossier » ne doit pas refuser ce que l'utilisateur a explicitement demandé. */
  for (const u of units) {
    localsession.ecrire(scope, u.uid, { session_key: sessionId, session_backend: agentsession.backendName(), session_cwd: null });
  }
}

function normalizeSessionId(raw) {
  const id = String(raw || '').trim();
  if (!id) return null;
  if (id.startsWith('-')) throw new Error(t('err.session-id-invalide'));
  if (agentsession.backendName() === 'claude'
    && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw new Error(t('err.session-id-uuid-attendu'));
  }
  return id;
}
// Nom de branche sûr : pas de flag (pas de `-` en tête), pas de `..`, caractères limités.
// Empêche l'injection d'arguments dans les commandes git.
const assertValidBranch = tasks.assertValidBranch;
/* ---------- PIÈCES JOINTES D'UNE SESSION ----------
   Captures ET documents, un seul mécanisme : pour l'agent, une capture d'écran et un PDF de
   spécification sont la même chose — un fichier à ouvrir. La distinction ne vaut qu'à
   l'affichage (vignette ou nom de fichier), pas ici.

   Le nom donné par le navigateur ne sert QU'À L'AFFICHAGE et au prompt : le fichier écrit sur
   disque porte un nom fabriqué. Un nom venu de l'extérieur n'a rien à faire dans un chemin —
   `../../.ssh/config` est un nom de fichier valide pour un formulaire. */
const PJ_MAX_OCTETS = 10 * 1024 * 1024;
/* Ce qu'on accepte, par EXTENSION. Une liste fermée dit clairement non plutôt que d'accepter
   n'importe quoi et de laisser l'agent découvrir un binaire qu'il ne sait pas ouvrir. */
const PJ_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'webp', 'gif',
  'pdf', 'txt', 'md', 'csv', 'tsv', 'json', 'yml', 'yaml', 'xml', 'html', 'log',
  'docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp', 'rtf',
]);
const PJ_SCOPES = { task: (id) => path.join(TASKS_DIR, String(id)), local: (id) => path.join(TASKS_DIR, 'local', String(id)), ask: (id) => path.join(TASKS_DIR, 'ask', String(id)) };

function decodeDataUrlImage(dataUrl) {
  const m = /^data:image\/(png|jpe?g|webp|gif);base64,(.+)$/i.exec(dataUrl || '');
  if (!m) throw new Error(t('err.image-invalide-data-url-image'));
  const ext = m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase();
  return { ext, buf: Buffer.from(m[2], 'base64') };
}

/* Une pièce arrive en `{ name, data }` (data URL). L'extension est lue sur le NOM — le type
   MIME annoncé par le navigateur varie d'un poste à l'autre pour un même .docx, et se refuser
   à ouvrir un fichier parce que Windows l'a déclaré `application/octet-stream` serait absurde. */
function decodePiece(piece) {
  const nom = String((piece && piece.name) || '').trim();
  const data = String((piece && piece.data) || '');
  const m = /^data:([^;,]*);base64,(.+)$/i.exec(data);
  if (!m) throw new Error(t('err.piece.invalide', { name: nom || '?' }));
  const ext = (nom.split('.').pop() || '').toLowerCase();
  if (!nom || !PJ_EXTENSIONS.has(ext)) throw new Error(t('err.piece.type', { name: nom || '?' }));
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > PJ_MAX_OCTETS) throw new Error(t('err.piece.trop-grosse', { name: nom, mo: Math.round(PJ_MAX_OCTETS / 1024 / 1024) }));
  return { ext, buf, nom, mime: m[1] || null };
}

/* `followup` : la pièce illustre une demande de SUIVI, pas la consigne initiale. Les ids rendus
   permettent de n'attacher QUE celles-là au prompt de ce suivi — les pièces d'un suivi passé
   parleraient d'autre chose. */
function savePieces(scope, ownerId, pieces, { followup = 0 } = {}) {
  if (!Array.isArray(pieces) || !pieces.length) return [];
  const dossier = PJ_SCOPES[scope];
  if (!dossier) throw new Error(`scope de pièce jointe inconnu : ${scope}`);
  const dir = ensureDir(dossier(ownerId));
  const ins = db.prepare(`INSERT INTO piece_jointe (scope, owner_id, path, name, mime, followup, created_at)
    VALUES (?,?,?,?,?,?,?)`);
  const ids = [];
  for (const piece of pieces) {
    const { ext, buf, nom, mime } = decodePiece(piece);
    const n = db.prepare('SELECT COUNT(*) c FROM piece_jointe WHERE scope = ? AND owner_id = ?').get(scope, ownerId).c + 1;
    const file = path.join(dir, `pj_${n}.${ext}`);
    fs.writeFileSync(file, buf);
    ids.push(ins.run(scope, ownerId, file, nom, mime, followup ? 1 : 0, new Date().toISOString()).lastInsertRowid);
  }
  return ids;
}

/* Les captures collées gardent leur chemin d'entrée (`images: [dataUrl]`) : le formulaire les
   envoie sans nom, puisqu'elles viennent du presse-papiers. On leur en fabrique un — il faut
   bien nommer ce qu'on donne à l'agent. */
function saveImagesAsPieces(scope, ownerId, images, opts) {
  if (!Array.isArray(images) || !images.length) return [];
  const n0 = db.prepare('SELECT COUNT(*) c FROM piece_jointe WHERE scope = ? AND owner_id = ?').get(scope, ownerId).c;
  return savePieces(scope, ownerId, images.map((dataUrl, i) => {
    const { ext } = decodeDataUrlImage(dataUrl);
    return { name: `capture-${n0 + i + 1}.${ext}`, data: dataUrl };
  }), opts);
}

// Tout ce qu'un formulaire peut envoyer : des captures collées et des fichiers choisis.
const savePiecesEtImages = (scope, ownerId, body, opts) => [
  ...saveImagesAsPieces(scope, ownerId, (body && body.images) || [], opts),
  ...savePieces(scope, ownerId, (body && body.files) || [], opts),
];

const piecesDe = (scope, ownerId) => db
  .prepare('SELECT id, path, name, mime, followup FROM piece_jointe WHERE scope = ? AND owner_id = ? ORDER BY id')
  .all(scope, Number(ownerId) || 0);

/* CE QUE L'ÉCRAN A LE DROIT DE VOIR d'une pièce jointe : de quoi l'afficher (un nom, un type),
   de quoi la demander (son id), et à quelle passe elle appartient — la consigne initiale (0) ou
   un suivi. Jamais le `path` : c'est un chemin sur le disque de la machine, il ne sert à rien
   au navigateur et il n'a rien à faire dans une réponse HTTP. */
const piecesExposees = (scope, ownerId) => piecesDe(scope, ownerId)
  .map((pj) => ({ id: pj.id, name: pj.name, mime: pj.mime, followup: pj.followup || 0 }));

/* SERVIR ET RETIRER une pièce jointe, quelle que soit la saveur de session. Une seule paire de
   routes pour les quatre : c'est la même table, le même disque et le même geste à l'écran — trois
   variantes finiraient par diverger, et l'une des trois par ne pas supprimer le fichier. */
const PJ_SCOPES_LUS = new Set(['task', 'local', 'ask']);
const pieceDemandee = (req) => (PJ_SCOPES_LUS.has(req.params.scope)
  ? db.prepare('SELECT * FROM piece_jointe WHERE id = ? AND scope = ?').get(Number(req.params.id), req.params.scope)
  : null);

app.get('/api/pieces/:scope/:id', (req, res) => {
  const pj = pieceDemandee(req);
  if (!pj || !fs.existsSync(pj.path)) return res.status(404).end();
  // Le nom d'origine suit le fichier : `pj_2.pdf` ne dit rien à qui l'enregistre.
  return servirFichierNonFiable(res, { chemin: pj.path, nom: pj.name || path.basename(pj.path), mime: pj.mime });
});

/* Le fichier part avec la ligne : une pièce détachée resterait sur le disque pour toujours,
   invisible et impossible à retrouver depuis l'écran. */
app.delete('/api/pieces/:scope/:id', wrap((req, res) => {
  const pj = pieceDemandee(req);
  if (pj) {
    try { fs.rmSync(pj.path, { force: true }); } catch { /* déjà parti */ }
    db.prepare('DELETE FROM piece_jointe WHERE id = ?').run(pj.id);
  }
  res.json({ ok: true });
}));

/* ---------- Les deux premières lignes de la réponse, et ce qu'elle a coûté ----------
   Une exploration, une question libre, un codage hors dépôt : on retrouvait sa réponse en
   ouvrant « Voir la réponse », carte par carte. Les deux premières lignes utiles suffisent à
   reconnaître laquelle on cherche. On lit le fichier déjà écrit sur le disque — aucun calcul,
   et on s'arrête aux premiers milliers de caractères : la liste n'a pas à charrier des
   rapports entiers à chaque rafraîchissement, c'est-à-dire toutes les secondes et demie. */
/* LE MARQUAGE NE SE LIT PAS SUR UNE CARTE. Le chapeau est du texte nu, posé dans une ligne de
   liste : les titres et les traits étaient déjà sautés, mais `**mutex**`, `` `verrou` `` et
   `[voir ici](url)` arrivaient tels quels — on lisait les étoiles avant le mot. On retire donc
   le marquage INLINE, sans rendre le Markdown : ce qui reste est la phrase, pas sa mise en
   forme. Volontairement conservateur — un astérisque isolé dans du texte reste un astérisque. */
function sansMarquage(l) {
  return String(l)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')                 // image : rien à lire sur une carte
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')               // lien : on garde le libellé
    .replace(/(\*\*|__)(.+?)\1/g, '$2')                    // gras
    .replace(/(^|\W)([*_])(?!\s)(.+?)(?<!\s)\2(?=\W|$)/g, '$1$3') // italique
    .replace(/`{1,3}([^`]+)`{1,3}/g, '$1')                  // code
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')                // puce ou numéro de liste
    .replace(/^\s*>\s?/, '')                                // citation
    .trim();
}

function chapeauReponse(mdPath) {
  const texte = mdPath ? readFileSafe(mdPath) : null;
  if (!texte) return '';
  const lignes = String(texte).slice(0, 4000).split('\n')
    // On saute les titres, les traits et le vide : ce qu'on veut, c'est la première PHRASE.
    .map((l) => sansMarquage(l))
    .filter((l) => l && !/^#{1,6}\s/.test(l) && !/^[-=*_]{3,}$/.test(l));
  return lignes.slice(0, 2).join(' ').slice(0, 220);
}

/* Ce que la dernière passe a coûté : sa durée et ses tokens estimés. La durée vient du job qui
   l'a portée, les tokens de la ligne d'usage rattachée à la session. Deux `LEFT JOIN` pour
   toute la liste, pas une requête par carte. */
function coutParSession(kind) {
  const out = {};
  for (const r of db.prepare(`SELECT owner_id AS id, SUM(tokens_est) AS tokens, SUM(cost_usd) AS cost_usd,
    MAX(created_at) AS at FROM usage WHERE owner_kind = ? AND owner_id IS NOT NULL GROUP BY owner_id`).all(kind)) {
    out[r.id] = { tokens: r.tokens || 0, cost_usd: r.cost_usd, at: r.at };
  }
  return out;
}
function dureeParSession(kind) {
  const out = {};
  const cible = kind === 'ask' ? 'ask' : (kind === 'local' ? 'local' : 'task');
  for (const j of db.prepare(`SELECT target_id AS id, started_at, finished_at FROM job
    WHERE target_kind = ? AND finished_at IS NOT NULL AND target_id IS NOT NULL
    ORDER BY id DESC`).all(cible)) {
    if (out[j.id]) continue;                                  // on garde la PLUS RÉCENTE
    const d = Date.parse(j.finished_at) - Date.parse(j.started_at);
    out[j.id] = Number.isFinite(d) && d >= 0 ? d : null;
  }
  return out;
}

/* LES SESSIONS D'AGENT REPRENABLES. Le champ « reprendre une session » attendait un UUID
   qu'on allait extraire à la main de la commande de reprise : on ouvrait un terminal pour
   copier un identifiant depuis un écran qui l'avait déjà. On rend ici ce que l'outil connaît,
   nommé par ce qui l'a produit — un identifiant nu ne dit rien trois jours plus tard. */
app.get('/api/agent-sessions', wrap((req, res) => {
  const out = [];
  /* LES HANDLES VIENNENT DE `local_session` — ils n'appartiennent qu'à cette machine. La
     jointure se fait sur l'`uid` de l'unité, jamais sur son id entier : celui-ci change d'un
     poste à l'autre, et une session partagée par un collègue proposerait le handle d'une autre. */
  for (const r of db.prepare(`SELECT ls.session_key AS cle, ls.updated_at AS at, repo.project AS quoi,
      task.label AS libelle, task.prompt AS prompt
    FROM local_session ls JOIN task_target tt ON tt.uid = ls.ref
    JOIN task ON task.id = tt.task_id JOIN repo ON repo.id = tt.repo_id
    WHERE ls.scope = 'task_target' AND ls.session_key IS NOT NULL AND ls.session_key <> ''
    ORDER BY ls.updated_at DESC LIMIT 40`).all()) {
    out.push({ key: r.cle, when: r.at, label: r.libelle || String(r.prompt || '').slice(0, 70), where: r.quoi });
  }
  for (const r of db.prepare(`SELECT ls.session_key AS cle, ls.updated_at AS at, d.dir_label AS quoi,
      lt.label AS libelle, lt.prompt AS prompt
    FROM local_session ls JOIN local_task_dir d ON d.uid = ls.ref
    JOIN local_task lt ON lt.id = d.task_id
    WHERE ls.scope = 'local_task_dir' AND ls.session_key IS NOT NULL AND ls.session_key <> ''
    ORDER BY ls.updated_at DESC LIMIT 20`).all()) {
    out.push({ key: r.cle, when: r.at, label: r.libelle || String(r.prompt || '').slice(0, 70), where: r.quoi });
  }
  // Une même session d'agent peut servir plusieurs projets : on ne la propose qu'une fois.
  const vues = new Set();
  res.json(out.filter((x) => (vues.has(x.key) ? false : vues.add(x.key)))
    .sort((a, b) => String(b.when || '').localeCompare(String(a.when || ''))).slice(0, 40));
}));

app.get('/api/tasks', wrap((req, res) => {
  /* En tête, ce qui vient de se passer : les sessions qui TOURNENT, puis les plus récemment
     exécutées. `finished_at` plutôt qu'`updated_at`, qui bouge aussi quand on corrige un
     prompt ou qu'on pousse une branche — une session simplement relue remonterait alors en
     tête. Jamais exécutée : sa date de création fait foi, sinon une session qu'on vient de
     créer tomberait tout en bas. */
  /* `agent_id` : les runs d'UN agent. Le filtre vit au serveur et non au client parce que la
     carte d'un agent le demande directement, sans charger toute la liste des sessions. */
  const idAgent = Number(req.query.agent_id) || 0;
  const rows = idAgent
    ? db.prepare(`SELECT * FROM task WHERE agent_id = ?
        ORDER BY (status = 'running') DESC, COALESCE(finished_at, created_at) DESC, id DESC`).all(idAgent)
    : db.prepare(`SELECT * FROM task
        ORDER BY (status = 'running') DESC, COALESCE(finished_at, created_at) DESC, id DESC`).all();
  const couts = coutParSession('task');
  const durees = dureeParSession('task');
  const range = rangement('task');
  const parQui = auteurs('task', rows);
  res.json(rows.map((tache) => ({
    author: parQui.get(tache.id) || null,
    ...avecRangement('task', tache, range),
    image_count: db.prepare('SELECT COUNT(*) c FROM piece_jointe WHERE scope = ? AND owner_id = ?').get('task', tache.id).c,
    // Le chapeau ne sert qu'aux explorations : une session de codage se lit à ses projets.
    answer_head: tache.kind === 'explore' ? chapeauReponse(tache.md_path) : '',
    tokens_est: (couts[tache.id] || {}).tokens || null,
    cost_usd: (couts[tache.id] || {}).cost_usd ?? null,
    duration_ms: durees[tache.id] != null ? durees[tache.id] : null,
    /* UNE TODO T'ATTEND. L'outil en pose une quand l'agent s'arrête sur une question — elle
       vit dans Notes, et la carte de session, elle, ne disait rien. On la signale là où on
       regarde la session ; `auto_kind` était écrit et fermé depuis toujours, jamais rendu. */
    todo_waiting: !!db.prepare(`SELECT 1 FROM todo
      WHERE auto_kind = 'session_question' AND auto_ref = ? AND status = 'open' AND archived_at IS NULL`)
      .get(String(tache.id)),
    targets: taskTargets(tache.id),
  })));
}));

app.get('/api/tasks/:id', wrap((req, res) => {
  const tache = taskById(Number(req.params.id));
  if (!tache) throw new Error(t('err.session-introuvable'));
  res.json({
    task: { ...tache, targets: taskTargets(tache.id) },
    images: piecesExposees('task', tache.id),
  });
}));

// Crée une session : `kind` = 'code' (l'IA modifie le code) ou 'explore' (lecture seule).
// `targets` = [{ repo_id, branch }] — une session peut porter sur plusieurs projets.
/* UN VÉRIFICATEUR NE SE LANCE PAS SANS CODE POUSSÉ : il travaille sur ce que la forge expose.
   Choisir un vérificateur implique donc l'auto-push, et retirer l'auto-push retire le
   vérificateur. L'écran le dit et coche la case ; le serveur le REFAIT — un client n'est pas
   un garde-fou, et l'API est appelable sans lui. */
/* Un libellé vide et un libellé absent sont la MÊME chose : NULL. Sans ça, une chaîne vide
   s'afficherait comme un titre — un titre invisible qui pousse le prompt d'un cran. */
const lireLibelle = (v) => (v == null ? null : (String(v).trim().slice(0, 120) || null));

/* Un suivi vide n'est pas un suivi : l'écran afficherait un bloc « suivi prêt » sans texte,
   avec un bouton « Envoyer » qui échouerait. Effacer le texte EST la façon de le supprimer. */
const lireSuivi = (v) => (v == null ? null : (String(v).trim() || null));

/* Enregistre le suivi en attente d'une session (codage / hors dépôt / exploration).
   Une seule table près : la colonne s'appelle pareil des deux côtés. */
/* `auto` : le suivi part-il de lui-même à la fin de la session ? Sans texte, la question ne se
   pose pas — un envoi automatique de rien n'existe pas, et laisser la case armée sur un suivi
   supprimé ferait partir le suivant sans qu'on l'ait demandé. */
function poserSuivi(table, id, valeur, auto) {
  const texte = lireSuivi(valeur);
  db.prepare(`UPDATE ${table} SET followup_draft = ?, followup_auto = ?, updated_at = ? WHERE id = ?`)
    .run(texte, (texte && auto) ? 1 : 0, new Date().toISOString(), id);
}

function lireVerifierSession(kind, autoPush, verifierId) {
  if (kind !== 'code' || !autoPush) return null;
  const id = Number(verifierId) || 0;
  if (!id) return null;
  return db.prepare('SELECT 1 FROM verifier WHERE id = ?').get(id) ? id : null;
}

/* ---------- AGENTS : les profils de session ----------
   Toutes les routes rendent la MÊME forme (`agentprofile.lire`) : la liste et le détail ne
   divergent pas, et l'écran n'a qu'un rendu à écrire. `age()` n'est PAS dedans — il fait un
   fetch par dépôt, et la liste se recharge à chaque passage sur l'onglet. */
function agentOu404(id) {
  const a = agentprofile.lire(Number(id));
  if (!a) { const e = new Error(t('agents.err.not-found')); e.status = 404; throw e; }
  return a;
}

app.get('/api/agents', wrap((req, res) => { res.json(agentprofile.lister()); }));
app.get('/api/agents/:id', wrap((req, res) => { res.json(agentOu404(req.params.id)); }));

app.post('/api/agents', wrap((req, res) => {
  const errs = agentprofile.valider(req.body || {});
  if (errs.length) return res.status(400).json({ error: t(errs[0]), errors: errs });
  res.status(201).json(agentprofile.creer(req.body || {}));
}));

app.put('/api/agents/:id', wrap((req, res) => {
  const a = agentOu404(req.params.id);
  const errs = agentprofile.valider({ ...a, ...(req.body || {}) }, a.id);
  if (errs.length) return res.status(400).json({ error: t(errs[0]), errors: errs });
  res.json(agentprofile.modifier(a.id, req.body || {}));
}));

app.delete('/api/agents/:id', wrap((req, res) => {
  agentOu404(req.params.id);
  agentprofile.supprimer(Number(req.params.id));
  res.json({ ok: true });
}));

/* L'état APPROUVÉ est celui que l'écran a montré : sa signature revient avec le clic, et un objet
   changé entre-temps par la synchro est refusé (409) — l'écran recharge et le montre. */
function exigerMemeEtat(vue, courante) {
  if (vue !== courante) throw Object.assign(new Error(t('err.approval.stale')), { status: 409, code: 'APPROBATION_PERIMEE' });
}

app.post('/api/agents/:id/approve', wrap((req, res) => {
  const a = agentOu404(req.params.id);
  exigerMemeEtat((req.body || {}).signature, approbation.signature(approbation.empreinteAgent(a.id)));
  approbation.approuverAgent(a.id);
  res.json(agentprofile.lire(a.id));
}));

app.post('/api/agents/:id/duplicate', wrap((req, res) => {
  const source = agentOu404(req.params.id);
  /* LA COPIE D'UN AGENT EN ATTENTE SERAIT APPROUVÉE à sa création — une copie est un agent créé
     ici. Ce serait approuver les permissions de l'original sans les avoir regardées. */
  if (!approbation.agentApprouve(source.id)) {
    const e = new Error(t('agents.err.not-approved', { name: source.name }));
    e.code = 'APPROBATION'; e.status = 409;
    throw e;
  }
  res.status(201).json(agentprofile.dupliquer(Number(req.params.id)));
}));

app.post('/api/agents/:id/restore', wrap((req, res) => {
  const a = agentOu404(req.params.id);
  if (!a.builtin_key) throw new Error(t('agents.err.not-builtin'));
  res.json(agentprofile.restaurer(a.id));
}));

/* Lancer. `ask` PART ; `code` ne part pas — il rend de quoi PRÉ-REMPLIR la modale de session,
   parce qu'un agent qui se met à écrire dans des dépôts sans qu'on ait vu lesquels serait
   exactement ce que la règle « un agent ne devine jamais un dépôt » interdit. */
app.post('/api/agents/:id/run', wrap((req, res) => {
  const a = agentOu404(req.params.id);
  const mode = (req.body && req.body.mode) === 'code' ? 'code' : 'ask';
  if (mode === 'code' && a.kind !== 'code' && !a.is_domain) throw new Error(t('agents.err.no-code-mode'));
  const question = String((req.body && req.body.question) || '');
  const repoIds = (req.body && req.body.repo_ids) || null;
  if (mode === 'code') {
    /* Le mode « code » ne lance rien ici, il préremplit une session — qui tournera avec les
       permissions de l'agent. Même porte que le lancement direct. */
    if (!approbation.agentApprouve(a.id)) {
      const e = new Error(t('agents.err.not-approved', { name: a.name }));
      e.code = 'APPROBATION'; e.status = 409;
      throw e;
    }
    const m = agentprofile.materialize(a, { mode, question, repoIds });
    return res.json({ prefill: { kind: m.kind, targets: m.targets, prompt: m.prompt, agent_id: a.id, label: m.label } });
  }
  res.json(agentprofile.lancer(a, { mode, question, repoIds, triggeredBy: 'manual' }));
}));

/* ---------- La connaissance d'un agent de domaine ----------
   Trois gestes : relire, corriger à la main, faire refaire. Le troisième est le seul qui coûte
   un appel IA, et le seul dont le résultat ATTEND une validation. */
app.get('/api/agents/:id/knowledge', wrap((req, res) => {
  const a = agentOu404(req.params.id);
  res.json(agentknowledge.versions(a.id));
}));

app.get('/api/agents/:id/knowledge/:version', wrap((req, res) => {
  const a = agentOu404(req.params.id);
  const v = agentknowledge.versionDe(a.id, req.params.version);
  if (!v) throw new Error(t('agents.err.version-not-found'));
  res.json(v);
}));

app.put('/api/agents/:id/knowledge', wrap((req, res) => {
  const a = agentOu404(req.params.id);
  const r = agentknowledge.editer(a, (req.body || {}).content);
  agentknowledge.viderCacheAge(a.id);
  res.json(r);
}));

app.post('/api/agents/:id/knowledge/refresh', wrap(async (req, res) => {
  const a = agentOu404(req.params.id);
  if (!a.is_domain) throw new Error(t('agents.err.not-domain'));
  res.json(await agentknowledge.refresh(a, 'manual'));
}));

app.post('/api/agents/:id/knowledge/:version/activate', wrap((req, res) => {
  const a = agentOu404(req.params.id);
  const r = agentknowledge.activer(a, req.params.version);
  if (r.error) throw new Error(t(r.error));
  agentknowledge.viderCacheAge(a.id);
  res.json(r);
}));

app.post('/api/agents/:id/knowledge/publish', wrap((req, res) => {
  const a = agentOu404(req.params.id);
  res.json(agentknowledge.publierDansNotes(a));
}));

/* L'ÂGE fait un fetch par dépôt : jamais dans la liste, qui se recharge à chaque passage sur
   l'onglet. Route à part, appelée par la carte APRÈS son rendu, et mise en cache une heure. */
app.get('/api/agents/:id/age', wrap(async (req, res) => {
  const a = agentOu404(req.params.id);
  if (!a.is_domain) return res.json([]);
  if (demoAgents.isDemo()) return res.json(demoAgents.age(a));
  res.json(await agentknowledge.age(a));
}));

/* Créer un agent de domaine : on donne un SUJET, le cartographe fait le reste. La route ne
   crée aucun agent — elle lance une exploration dont la SORTIE en créera un. */
app.post('/api/agents/domain', wrap((req, res) => {
  const carto = agentprofile.parCle('cartographer');
  if (!carto) throw new Error(t('agents.err.no-cartographer'));
  const subject = String((req.body || {}).subject || '').trim();
  if (!subject) throw new Error(t('agents.err.subject-required'));
  /* Un sous-ensemble de dépôts restreint le RUN, jamais le profil : le cartographe est
     `all_repos` et le reste — on ne modifie pas un profil livré pour un lancement. C'est
     `ciblesDe` qui applique la restriction, une fois, pour tous les appelants : la
     cartographie comme les mises à jour de connaissance qui la relanceront. */
  res.json(agentprofile.lancer(carto, {
    mode: 'ask', question: subject, repoIds: (req.body || {}).repo_ids, triggeredBy: 'manual',
  }));
}));

/* Déclencher un tick d'horaire à la main. Attendre la minute dans un test serait un pari sur
   l'horloge d'une machine chargée ; et sur une installation réelle, c'est le bouton qui répond
   à « est-ce que mon horaire part vraiment ? » sans attendre demain matin. */
app.post('/api/agents/tick', wrap((req, res) => {
  const journal = [];
  const lances = agentschedule.tick(new Date(), (m) => journal.push(m));
  res.json({ started: lances.length, log: journal });
}));

app.get('/api/agents/:id/preview', wrap((req, res) => {
  const a = agentOu404(req.params.id);
  res.json({ argv: agentprofile.previewFor(a, agentsession.backendName()) });
}));

// L'aperçu d'un formulaire NON ENREGISTRÉ : l'éditeur montre ce que produirait la sauvegarde.
app.post('/api/agents/preview', wrap((req, res) => {
  const corps = req.body || {};
  res.json({
    argv: agentprofile.previewFor({
      kind: corps.kind, model: corps.model, permission_mode: corps.permission_mode,
      system_prompt: corps.system_prompt,
      allowed_tools_json: JSON.stringify(corps.allowed_tools_json || []),
      disallowed_tools_json: JSON.stringify(corps.disallowed_tools_json || []),
      max_turns: corps.max_turns,
      subagents_json: JSON.stringify(corps.subagents_json || {}),
    }, agentsession.backendName()),
    errors: agentprofile.valider(corps, corps.id || null),
  });
}));

/* ---------- Skills et sous-agents de fichier (lecture seule) ----------
   Le disque est la vérité : `.claude/skills/<nom>/SKILL.md` d'un dépôt cloné, et ceux du home.
   Rien n'est écrit, jamais — ni ici, ni ailleurs (spec agents §18). `repos` restreint le scan
   aux dépôts qui nous intéressent (les cibles d'une session) ; absent, tous les dépôts actifs. */
function reposPourScan(param) {
  const ids = String(param || '').split(',').map((x) => Number(x)).filter((n) => Number.isInteger(n) && n > 0);
  if (ids.length) {
    return db.prepare(`SELECT * FROM repo WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids);
  }
  return db.prepare('SELECT * FROM repo WHERE enabled = 1 ORDER BY project').all();
}

app.get('/api/skills', wrap((req, res) => {
  // En démo, aucun dépôt n'est cloné : le scan ne trouverait rien, et l'écran serait vide.
  if (demoAgents.isDemo()) return res.json(demoAgents.scan());
  const r = skillscan.scan({ repos: reposPourScan(req.query.repos), cfg: getConfig() });
  res.json(r);
}));

app.post('/api/skills/rescan', wrap((req, res) => {
  skillscan.invalidate();
  res.json({ ok: true });
}));

app.post('/api/tasks', wrap((req, res) => {
  const { kind, prompt, commit_message, auto_push, images, targets, ask_questions, session_id, verifier_id, label } = req.body || {};
  const k = kind === 'explore' ? 'explore' : 'code';
  if (!(prompt || '').trim()) throw new Error(t('err.prompt-requis'));
  const sessionId = normalizeSessionId(session_id);
  const list = normalizeTargets(targets, k);
  const now = new Date().toISOString();
  /* « L'IA peut poser des questions » : opt-in, en codage COMME en exploration. Une exploration
     hésite de la même façon — « de quel des trois services parles-tu ? » vaut mieux qu'une
     synthèse à côté du sujet. Le codage hors dépôt a sa propre table, et sa propre route. */
  const ask = ask_questions ? 1 : 0;
  /* LES SKILLS COCHÉS OUVRENT LA DEMANDE. `/mon-skill` est ce que le CLI attend pour en
     invoquer un ; le nom seul, pour ceux qui refusent le `/`. La ligne est écrite DANS le
     prompt (et non gardée à part) : c'est elle que l'agent lit, et c'est elle qu'on relit
     en rouvrant la session pour comprendre ce qui a été demandé. */
  const enTeteSkills = skillscan.ligneSkills(req.body && req.body.skills, {
    repos: reposPourScan(list.map((x) => x.repo_id).join(',')), cfg: getConfig(),
  });
  const promptFinal = (enTeteSkills ? `${enTeteSkills}\n\n` : '') + prompt.trim();
  /* UN RUN D'AGENT EST UNE SESSION : la route accepte `agent_id`, recopie le nom du profil et
     compose sa demande. `auto_push` est alors forcé à 0 — un agent ne pousse jamais de
     lui-même (spec agents, règle 1), quoi qu'ait coché le formulaire. */
  const profil = req.body && req.body.agent_id ? agentprofile.lire(Number(req.body.agent_id)) : null;
  /* A18 — LE BROUILLON D'UN PROFIL QU'ON ESSAIE. « Essai » n'ouvrait qu'une session pré-remplie
     du gabarit : modèle, outils, sous-agents et prompt système restaient à quai, donc on
     essayait tout sauf ce qu'on venait de régler. Le brouillon voyage avec la session et sert
     d'options ; aucun agent n'est créé — essayer ne doit rien laisser derrière. On VALIDE ici
     ce qui échouerait au lancement, comme à la sauvegarde d'un vrai profil. */
  const brouillon = (!profil && req.body && req.body.agent_draft) ? agentprofile.brouillonValide(req.body.agent_draft) : null;
  const compose = profil ? agentprofile.composer(profil, { question: promptFinal, targets: list, kind: k }) : null;
  const taskId = tasks.creerTask({
    kind: k,
    prompt: compose ? compose.prompt : promptFinal,
    // `task.branch` est un héritage mono-projet (la vérité est dans task_target) et
    // la colonne est NOT NULL : en exploration la branche est facultative, on y range
    // donc '' plutôt que NULL — sinon la création échoue sur une erreur SQL brute.
    branch: list[0].branch || '',
    commitMessage: (commit_message || '').trim() || null,
    autoPush: profil ? 0 : (auto_push ? 1 : 0),
    askQuestions: ask,
    verifierId: lireVerifierSession(k, profil ? 0 : auto_push, verifier_id),
    label: lireLibelle(label) || (profil ? profil.name : null),
    // B5 : décoché par défaut — écrire chez les autres se décide, session par session.
    notifyJira: req.body && req.body.notify_jira ? 1 : 0,
    // B9 : idem — une review coûte un appel IA, elle se demande.
    reviewAfter: req.body && req.body.review_after ? 1 : 0,
    targets: list,
    sessionId,
    agentId: profil ? profil.id : null,
    agentName: profil ? profil.name : (brouillon ? brouillon.name : null),
    triggeredBy: 'manual',
    agentQuestion: profil ? promptFinal : null,
    agentDraft: brouillon,
    // Partager cette session-là : décoché par défaut, et la case n'apparaît qu'en mode partagé.
    shared: req.body && req.body.shared ? 1 : 0,
  });
  savePiecesEtImages('task', taskId, req.body || {});
  res.json({ ...taskById(taskId), targets: taskTargets(taskId) });
}));

app.put('/api/tasks/:id', wrap((req, res) => {
  const tache = taskById(Number(req.params.id));
  if (!tache) throw new Error(t('err.session-introuvable'));
  const { prompt, commit_message, auto_push, images, targets, ask_questions, session_id, verifier_id, label } = req.body || {};
  const sessionId = normalizeSessionId(session_id);
  if (Array.isArray(targets) && targets.length) {
    const list = normalizeTargets(targets, tache.kind);
    /* On ne recrée les cibles que si la COMPOSITION change : sinon on perdrait leur état
       d'exécution (commit, diff, MR, handle de session).

       La comparaison ne porte donc que sur ce que l'utilisateur a CHOISI. Pour une
       exploration, `base_branch` n'est pas un choix : c'est la branche que le run a
       RÉSOLUE et réécrite sur chaque cible. Elle la faisait donc différer du formulaire —
       qui n'en envoie aucune — et rouvrir une exploration terminée pour l'enregistrer sans
       rien changer remettait tous ses dépôts « à exécuter », sous une session « terminée ».
       `|| ''` sur la branche pour la même raison : `null` et `''` désignent ici la même
       absence de choix, mais ne s'écrivent pas pareil dans une clé. */
    const key = (x) => [x.repo_id, x.branch || '', tache.kind === 'explore' ? '' : (x.base_branch || '')].join(':');
    const cur = taskTargets(tache.id).map(key).join('|');
    if (cur !== list.map(key).join('|')) {
      db.prepare('DELETE FROM task_target WHERE task_id = ?').run(tache.id);
      insertTargets(tache.id, list);
    }
  }
  db.prepare('UPDATE task SET prompt = ?, commit_message = ?, auto_push = ?, ask_questions = ?, verifier_id = ?, label = ?, notify_jira = ?, review_after = ?, updated_at = ? WHERE id = ?').run(
    prompt != null ? String(prompt).trim() : tache.prompt,
    commit_message != null ? (String(commit_message).trim() || null) : tache.commit_message,
    auto_push == null ? tache.auto_push : (auto_push ? 1 : 0),
    // Absent du body → on garde la valeur actuelle (codage et exploration l'acceptent).
    ask_questions == null ? tache.ask_questions : (ask_questions ? 1 : 0),
    /* La règle s'applique à la valeur EXISTANTE autant qu'à celle qu'on envoie : décocher
       l'auto-push sans renvoyer le champ laissait sinon un vérificateur qui ne pourrait plus
       tourner, et on ne s'en apercevrait qu'à la fin de la session. */
    lireVerifierSession(tache.kind, auto_push == null ? tache.auto_push : auto_push,
      verifier_id === undefined ? tache.verifier_id : verifier_id),
    label === undefined ? tache.label : lireLibelle(label),
    // Absent du body → on garde la valeur actuelle, comme les autres cases de la modale.
    (req.body && req.body.notify_jira) === undefined ? tache.notify_jira : (req.body.notify_jira ? 1 : 0),
    (req.body && req.body.review_after) === undefined ? tache.review_after : (req.body.review_after ? 1 : 0),
    new Date().toISOString(), tache.id,
  );
  savePiecesEtImages('task', tache.id, req.body || {});
  // Après une éventuelle recréation des cibles : celles-ci repartent sans handle.
  applySessionId('task_target', 'task_id', tache.id, sessionId, taskTargets(tache.id));
  res.json({ ...taskById(tache.id), targets: taskTargets(tache.id) });
}));

app.delete('/api/tasks/:id', wrap((req, res) => {
  /* LA SESSION D'UN COLLÈGUE NE SE SUPPRIME PAS : la supprimer ici retirerait son fichier du
     dépôt, et la ligne disparaîtrait chez son auteur au `pull` suivant. On la range. */
  const aSupprimer = taskById(Number(req.params.id));
  if (aSupprimer) exigerProprietaire('task', aSupprimer);
  db.prepare('DELETE FROM task_target WHERE task_id = ?').run(Number(req.params.id));
  agentpass.removeTask('task', Number(req.params.id));   // pas de FK : nettoyage explicite
  pieces.removeOwner('task', Number(req.params.id));     // idem pour les pièces jointes
  db.prepare('DELETE FROM task WHERE id = ?').run(Number(req.params.id));
  try { fs.rmSync(path.join(TASKS_DIR, String(Number(req.params.id))), { recursive: true, force: true }); } catch { /* rien */ }
  res.json({ ok: true });
}));

/* Ranger / ressortir une session. Volontairement séparé de PUT /tasks/:id : c'est un geste
   de rangement, qui doit rester possible sur une session en cours d'exécution — le PUT, lui,
   refuse d'éditer une session lancée. */
/* Partager CETTE session-là, ou cesser de la partager. Volontairement à côté de `/hidden` : ce
   sont les deux gestes qu'on fait sur une session sans y toucher — l'un est pour soi, l'autre
   pour l'équipe. */
app.post('/api/tasks/:id/share', wrap((req, res) => {
  const t2 = taskById(Number(req.params.id));
  if (!t2) throw new Error(t('err.session-introuvable'));
  const shared = basculerPartage('task', 'task', t2, req.body && req.body.shared);
  res.json({ ok: true, shared, task: taskById(t2.id) });
}));

app.post('/api/tasks/:id/hidden', wrap((req, res) => {
  const t2 = taskById(Number(req.params.id));
  if (!t2) throw new Error(t('err.session-introuvable'));
  const hidden = (req.body && req.body.hidden) ? 1 : 0;
  prefLocale.ecrire('task', t2.uid, 'hidden', hidden ? '1' : null);
  db.prepare('UPDATE task SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), t2.id);
  res.json({ ok: true, hidden });
}));

/* MÊME HISTOIRE QUE POUR UNE REVIEW, ET MÊME REMÈDE (cf. `diffDeLaMr`). `target.diff_path` est
 * un fichier de la machine qui a fait tourner l'agent : le poste qui REÇOIT la session ne l'a
 * pas, et il ouvrait « Voir le diff » sur du vide.
 *
 * Un repli existait pourtant — `branchDiff` — mais il comparait `origin/<base>...HEAD`, et HEAD
 * c'est la branche sur laquelle le clone se trouve, pas celle de la session. Sur le poste
 * d'origine il ne servait jamais (le fichier est là) ; ailleurs, il répondait le diff d'un
 * travail sans rapport, ou rien. On vise donc le COMMIT de la session — celui-là même que
 * l'arbre affiche à côté, pour que les deux parlent de la même version.
 */
async function diffDeLaCible(tg, cwdConnu = null) {
  const garde = tg.diff_path ? readFileSafe(tg.diff_path) : null;
  if (garde) return garde;
  const repo = db.prepare('SELECT * FROM repo WHERE id = ?').get(tg.repo_id);
  if (!repo && !cwdConnu) return null;
  try {
    let cwd = cwdConnu || git.cloneDirFor(getConfig(), repo);
    const base = `origin/${tg.base_branch || 'main'}`;
    const vise = async () => (tg.commit_sha && await git.refExists(cwd, tg.commit_sha)
      ? tg.commit_sha
      : (tg.branch && await git.refExists(cwd, `origin/${tg.branch}`) ? `origin/${tg.branch}` : null));
    let ref = await vise();
    /* LE CLONE PEUT ÊTRE EN RETARD : la branche de la session a été poussée après le dernier
       fetch de ce poste. On ne va chercher qu'à ce moment-là. */
    if (repo && (!ref || !await git.refExists(cwd, base))) {
      cwd = await git.ensureRepo(getConfig(), repo, () => {});
      ref = await vise();
    }
    if (!ref || !await git.refExists(cwd, base)) return null;
    return await git.diffTroisPoints(cwd, base, ref);
  } catch { return null; }
}

// Diff d'UN projet de la session.
app.get('/api/tasks/:id/targets/:tid/diff', wrap(async (req, res) => {
  const tg = targetById(Number(req.params.id), Number(req.params.tid));
  if (!tg) throw new Error(t('err.projet-introuvable-pour-cette-session'));
  res.json({ diff: await diffDeLaCible(tg), project: tg.project, branch: tg.branch });
}));

/* Un projet de session n'a pas de numéro de MR : on le présente au dépôt fictif de démo
   sous la même forme qu'une merge request, pour réutiliser le même viewer. */
const demoMrDe = (tg) => ({
  iid: 0, project: tg.project, source_branch: tg.branch, target_branch: tg.base_branch || 'main',
});

/* Viewer plein écran d'un projet de session : MÊMES trois routes que pour une MR
   (`viewerPayload` / `viewerFile` / `viewerFileDiff`), donc le front réutilise le
   même composant en changeant seulement la base d'URL. */
app.get('/api/tasks/:id/targets/:tid/diffview', wrap(async (req, res) => {
  const tg = targetById(Number(req.params.id), Number(req.params.tid));
  if (!tg) throw new Error(t('err.projet-introuvable-pour-cette-session'));
  if (demoDiff.isDemo()) {
    res.json({ ...demoDiff.viewFor(demoMrDe(tg)), project: tg.project, branch: tg.branch });
    return;
  }
  const ctx = targetCloneCtx(tg);
  /* Le diff produit par la session est stocké ; s'il manque — session ancienne, ou session
     REÇUE de l'équipe —, on le recalcule entre la branche de départ et le commit de la
     session, qui est justement la référence que `ctx` affiche. */
  const diff = await diffDeLaCible(tg, ctx.cwd);
  res.json({
    ...(await viewerPayload(ctx, { diff: diff || '', source: tg.branch })),
    project: tg.project, branch: tg.branch,
  });
}));
app.get('/api/tasks/:id/targets/:tid/file', wrap(async (req, res) => {
  const tg = targetById(Number(req.params.id), Number(req.params.tid));
  if (!tg) throw new Error(t('err.projet-introuvable-pour-cette-session'));
  if (demoDiff.isDemo()) { res.json(demoDiff.fileFor(demoMrDe(tg), String(req.query.path || ''))); return; }
  res.json(await viewerFile(targetCloneCtx(tg), String(req.query.path || '')));
}));
app.get('/api/tasks/:id/targets/:tid/filediff', wrap(async (req, res) => {
  const tg = targetById(Number(req.params.id), Number(req.params.tid));
  if (!tg) throw new Error(t('err.projet-introuvable-pour-cette-session'));
  if (demoDiff.isDemo()) { res.json(demoDiff.fileDiffFor(demoMrDe(tg), String(req.query.path || ''))); return; }
  res.json(await viewerFileDiff(targetCloneCtx(tg), String(req.query.path || '')));
}));

/* Historique des ITÉRATIONS d'un projet de session : une entrée par passe, avec le
   prompt réellement envoyé et le retour de l'agent. `?n=` renvoie une passe précise. */
app.get('/api/tasks/:id/targets/:tid/passes', wrap((req, res) => {
  const tg = targetById(Number(req.params.id), Number(req.params.tid));
  if (!tg) throw new Error(t('err.projet-introuvable-pour-cette-session'));
  res.json(passesPayload('task', tg.id, Number(req.params.id), req.query.n, `${tg.project} — ${tg.branch}`, tg.output_path));
}));

/* ---------- LE DIFF D'UNE SEULE ITÉRATION ----------
 *
 * Une session de codage s'itère : un run, puis des suivis. Le diff de la branche, lui, ne
 * distingue rien — au troisième suivi, la correction de trois lignes qu'on vient de demander
 * se cherche au milieu de deux cents. Chaque passe garde donc ses deux bornes (le HEAD avant,
 * celui d'après) et le patch entre les deux, et ces trois routes sont EXACTEMENT celles d'une
 * merge request ou d'un projet de session : le front ne change que la base d'URL, et retrouve
 * le même viewer (arbre, fichier entier, changements en place).
 *
 * Les bornes sont des COMMITS : d'où `shaRange`, qui dit aux routes de fichier de ne pas
 * préfixer la base par `origin/`.
 */
function passeCodageDe(taskId, tg, n) {
  const p = agentpass.get('task', taskId, tg.id, Number(n));
  if (!p) throw new Error(t('err.task.pass-not-found'));
  return p;
}
/* Le patch de la passe, ou la raison de ne rien montrer. Une itération qui n'a rien changé au
   code (l'agent a posé des questions, ou a constaté que tout était déjà fait) n'ouvre pas une
   vue vide : elle le dit.
 *
 * LE PATCH NE VOYAGE PAS — ET N'A PAS BESOIN DE VOYAGER. C'est un fichier de la machine qui a
 * fait tourner l'agent, et l'envoyer dans le dépôt d'équipe y mettrait des centaines de
 * kilo-octets entièrement recalculables. Ce qui voyage, ce sont les deux BORNES : le commit
 * d'avant et celui d'après. Sur le poste du collègue, on redemande donc simplement le diff à
 * git — c'est le même travail que celui d'origine, sur le même clone, et le résultat est le
 * même à l'octet près. Il faut seulement que ces deux commits soient là : si la branche n'a
 * jamais été récupérée, on le DIT, avec le geste qui répare. */
async function diffDePasse(p, cwd = null) {
  const diff = agentpass.diffDe(p);
  if (diff) return diff;
  if (p.base_sha && p.head_sha && p.base_sha !== p.head_sha && cwd) {
    try {
      const recalcule = await git.diffRange(cwd, p.base_sha, p.head_sha);
      if (recalcule && recalcule.trim()) return recalcule;
    } catch { throw new Error(t('err.task.pass-diff-absent-du-clone')); }
  }
  throw new Error(t(p.head_sha && p.base_sha === p.head_sha ? 'err.task.pass-no-change' : 'err.task.pass-no-diff'));
}
function ctxDePasse(tg, p) {
  return { ...targetCloneCtx(tg), ref: p.head_sha, target: p.base_sha, shaRange: true };
}

app.get('/api/tasks/:id/targets/:tid/passes/:n/diffview', wrap(async (req, res) => {
  const tg = targetById(Number(req.params.id), Number(req.params.tid));
  if (!tg) throw new Error(t('err.projet-introuvable-pour-cette-session'));
  const p = passeCodageDe(Number(req.params.id), tg, req.params.n);
  const diff = await diffDePasse(p, targetCloneCtx(tg).cwd);
  const entete = { project: tg.project, branch: tg.branch, pass: { n: p.n, kind: p.kind, titre: p.titre || '', prompt: p.prompt || '' } };
  if (demoDiff.isDemo()) { res.json({ ...demoDiff.viewFor(demoMrDe(tg), diff), ...entete }); return; }
  res.json({ ...(await viewerPayload(ctxDePasse(tg, p), { diff, source: tg.branch })), ...entete });
}));
app.get('/api/tasks/:id/targets/:tid/passes/:n/file', wrap(async (req, res) => {
  const tg = targetById(Number(req.params.id), Number(req.params.tid));
  if (!tg) throw new Error(t('err.projet-introuvable-pour-cette-session'));
  const p = passeCodageDe(Number(req.params.id), tg, req.params.n);
  if (demoDiff.isDemo()) { res.json(demoDiff.fileFor(demoMrDe(tg), String(req.query.path || ''))); return; }
  res.json(await viewerFile(ctxDePasse(tg, p), String(req.query.path || '')));
}));
app.get('/api/tasks/:id/targets/:tid/passes/:n/filediff', wrap(async (req, res) => {
  const tg = targetById(Number(req.params.id), Number(req.params.tid));
  if (!tg) throw new Error(t('err.projet-introuvable-pour-cette-session'));
  const p = passeCodageDe(Number(req.params.id), tg, req.params.n);
  if (demoDiff.isDemo()) {
    res.json(demoDiff.fileDiffFor(demoMrDe(tg), String(req.query.path || ''), await diffDePasse(p)));
    return;
  }
  res.json(await viewerFileDiff(ctxDePasse(tg, p), String(req.query.path || '')));
}));

// Retour de l'agent pour un projet (ce qu'il dit avoir fait) — consultable en fin de session.
app.get('/api/tasks/:id/targets/:tid/output', wrap((req, res) => {
  const tg = targetById(Number(req.params.id), Number(req.params.tid));
  if (!tg) throw new Error(t('err.projet-introuvable-pour-cette-session'));
  res.json({ output: tg.output_path ? readFileSafe(tg.output_path) : null, project: tg.project, branch: tg.branch });
}));

/* Historique des questions d'une exploration (niveau session, unité 0) : chaque
   question de suivi a écrasé la réponse précédente, mais la passe est archivée. */
app.get('/api/tasks/:id/passes', wrap((req, res) => {
  const tk = taskById(Number(req.params.id));
  if (!tk) throw new Error(t('err.session-introuvable'));
  res.json(passesPayload('task', 0, tk.id, req.query.n, tk.prompt || '', tk.md_path));
}));

/* LE PROMPT « TRAITE LE RAPPORT DE REVIEW », prêt à coller dans un suivi.
 *
 * Le même texte que le bouton « Faire corriger le code par l'IA » du rapport (`prompt.apply-review`),
 * mais rendu ICI, côté serveur : le rapport est un fichier sur le disque, et la liste des sessions
 * ne doit pas charrier le Markdown de chaque rapport à chaque rafraîchissement — elle se redessine
 * toutes les secondes et demie pendant un job.
 *
 * Une session multi-projets envoie son suivi à TOUS ses projets : le prompt reprend donc le rapport
 * de chacun, nommé, plutôt que d'en choisir un au hasard. `?target_id=` restreint à un projet —
 * c'est ce dont se sert le formulaire de suivi par projet.
 */
app.get('/api/tasks/:id/review-prompt', wrap((req, res) => {
  const tache = taskById(Number(req.params.id));
  if (!tache) throw new Error(t('err.session-introuvable'));
  const cibleId = req.query.target_id ? Number(req.query.target_id) : null;
  const projets = [];
  for (const tg of taskTargets(tache.id)) {
    if (cibleId && tg.id !== cibleId) continue;
    const iid = tg.mr_iid || tg.existing_mr_iid;
    if (!iid) continue;
    const rev = db.prepare(`SELECT review.md_path FROM review
      JOIN mr ON mr.id = review.mr_id
      WHERE mr.repo_id = ? AND mr.iid = ?`).get(tg.repo_id, iid);
    const md = rev && readFileSafe(rev.md_path);
    if (md && md.trim()) projets.push({ project: tg.project, iid, branch: tg.branch, md: md.trim() });
  }
  if (!projets.length) throw new Error(t('err.task.no-review-report'));
  /* Un seul projet : le prompt est exactement celui du bouton du rapport. Plusieurs : on empile
     les rapports sous un titre par projet, sinon l'agent ne sait pas quel constat va où. */
  const prompt = projets.length === 1
    ? t('prompt.apply-review', { branch: projets[0].branch, md: projets[0].md })
    : t('prompt.apply-review-multi', {
      blocs: projets.map((p) => t('prompt.apply-review-bloc', { project: p.project, iid: p.iid, md: p.md })).join('\n\n'),
    });
  res.json({ prompt, projets: projets.map((p) => ({ project: p.project, iid: p.iid })) });
}));

/* LE PROMPT « CORRIGE CE QUE LA VÉRIFICATION A CASSÉ », prêt à coller dans un suivi.
 *
 * Exactement celui de « Corriger (session IA) » — même fonction —, mais destiné au champ de
 * suivi : depuis la session qui a produit la branche, on veut que l'agent reprenne SON fil au
 * lieu d'ouvrir une session neuve qui redécouvre le code.
 *
 * On ne retient que les vérifications ÉCHOUÉES et IMPUTABLES à ces branches : une base déjà
 * rouge n'est pas de notre fait, et demander à l'agent de corriger ce qu'il n'a pas cassé lui
 * ferait toucher du code qui n'a rien à voir. */
app.get('/api/tasks/:id/verify-prompt', wrap((req, res) => {
  const tache = taskById(Number(req.params.id));
  if (!tache) throw new Error(t('err.session-introuvable'));
  const cibleId = req.query.target_id ? Number(req.query.target_id) : null;
  const parMr = dernieresVerificationsParMr();
  const vues = new Set();
  const blocs = [];
  for (const tg of taskTargets(tache.id)) {
    if (cibleId && tg.id !== cibleId) continue;
    const iid = tg.mr_iid || tg.existing_mr_iid;
    if (!iid) continue;
    const mr = db.prepare('SELECT id FROM mr WHERE repo_id = ? AND iid = ?').get(tg.repo_id, iid);
    const v = mr && parMr.get(mr.id);
    if (!v || vues.has(v.id)) continue;          // une vérification de lot couvre plusieurs projets
    const d = detailVerification(v);
    if (d.verdict !== 'verified_fail' || !(d.imputable || []).length) continue;
    vues.add(v.id);
    blocs.push({ prompt: promptCorrectionVerif(d, v), verifier: d.verifier_name });
  }
  if (!blocs.length) throw new Error(t('err.task.no-failed-verification'));
  res.json({
    prompt: blocs.map((b) => b.prompt).join('\n\n'),
    verificateurs: blocs.map((b) => b.verifier),
  });
}));

// Réponse .md d'une exploration.
app.get('/api/tasks/:id/md', wrap((req, res) => {
  const tache = taskById(Number(req.params.id));
  if (!tache) throw new Error(t('err.session-introuvable'));
  const brut = tache.md_path ? readFileSafe(tache.md_path) : null;
  /* Les blocs de protocole sont un canal de SERVICE : ils nomment le dépôt trouvé, décrivent
     l'agent à créer, signalent un écart. Ils n'ont rien à faire à l'écran — `?raw=1` les garde,
     pour qui veut relire ce que l'agent a réellement émis. */
  const md = (brut && !req.query.raw) ? protocol.nettoyer(brut) : brut;
  res.json({ md, prompt: tache.prompt, created_at: tache.created_at, agent_name: tache.agent_name });
}));

/* « Corriger sur <dépôt> » : le bloc `<<<REPO>>>` de l'enquêteur, lu à la demande. Rien n'est
   stocké — le rapport EST la source, et un dépôt recopié en base se périmerait tout seul. */
app.get('/api/tasks/:id/repo-hint', wrap((req, res) => {
  const tache = taskById(Number(req.params.id));
  if (!tache) throw new Error(t('err.session-introuvable'));
  const brut = tache.md_path ? readFileSafe(tache.md_path) : '';
  const { block } = protocol.extraire(brut || '', 'REPO');
  if (!block) return res.json(null);
  for (const champs of protocol.lignes(block)) {
    const projet = champs[0];
    if (!projet) continue;
    const repo = db.prepare('SELECT id, project FROM repo WHERE project = ?').get(projet);
    if (!repo) continue;                  // un dépôt inventé n'ouvre aucun bouton
    return res.json({ repo_id: repo.id, project: repo.project, path: champs[1] || '', line: champs[2] || '' });
  }
  res.json(null);
}));

/* Réconcilier : relire l'état réel des branches d'une session et réparer les projets dont le
   travail existe déjà (commit passé, échec survenu après). Aucun appel IA — contrairement à une
   relance, qui en coûterait un par dépôt pour refaire un travail déjà fait. */
/* Valide une liste d'ids de projets contre la session : un id étranger doit être refusé, pas
   ignoré en silence — sinon une faute de frappe fait tourner la session entière sans le dire. */
function normalizeTargetIds(taskId, raw) {
  if (!Array.isArray(raw) || !raw.length) return null;
  const voulus = [...new Set(raw.map(Number).filter(Number.isInteger))];
  if (!voulus.length) return null;
  const connus = new Set(db.prepare('SELECT id FROM task_target WHERE task_id = ?').all(taskId).map((r) => r.id));
  const inconnus = voulus.filter((id) => !connus.has(id));
  if (inconnus.length) throw new Error(t('err.projet-introuvable-pour-cette-session-2'));
  return voulus;
}

app.post('/api/tasks/:id/reconcile', wrap((req, res) => {
  const t2 = taskById(Number(req.params.id));
  if (!t2) throw new Error(t('err.session-introuvable'));
  if (t2.kind !== 'code') throw new Error(t('err.reconcile-code-only'));
  res.json(jobs.startReconcileJob(t2.id));
}));

/* `targets` (facultatif) restreint la passe à certains projets de la session. Sans lui, toute
   la session part — comportement d'origine. Sert au bouton « Lancer » de chaque projet et à
   « relancer les projets en échec ». */
app.post('/api/tasks/:id/run', wrap(async (req, res) => {
  const tache = taskById(Number(req.params.id));
  if (!tache) throw new Error(t('err.session-introuvable'));
  const targetIds = normalizeTargetIds(tache.id, req.body && req.body.targets);
  if (tache.kind === 'code') {
    for (const tg of db.prepare('SELECT * FROM task_target WHERE task_id = ?').all(tache.id)) {
      if (targetIds && !targetIds.includes(tg.id)) continue;
      await gardeConfigAgent(db.prepare('SELECT * FROM repo WHERE id = ?').get(tg.repo_id), tg.branch, tg.base_branch, req.body);
    }
  }
  res.json(jobs.startTaskJob(tache.id, 'run', targetIds ? { targetIds } : {}));
}));

// « Converger » une session de dev : du prompt à la/les MR convergée(s). L'IA code,
// pousse, crée la MR, puis lance la boucle de convergence (par projet, en série).
app.post('/api/tasks/:id/converge', wrap((req, res) => {
  const task = taskById(Number(req.params.id));
  if (!task) throw new Error(t('err.session-introuvable'));
  if (task.kind !== 'code') throw new Error(t('err.converge-session-code-only'));
  res.json(jobs.startConvergeSessionJob(task.id, parseConvergeOpts(req.body)));
}));

/* ---- « Codage hors dépôt » : l'IA code dans des dossiers locaux, en place, sans git ---- */
// Dossiers d'une session hors dépôt + la commande de reprise de leur session d'agent.
function localDirsFor(taskId) {
  /* LE CHEMIN NE VIENT PLUS DE LA LIGNE. Il vivait ici en absolu — `/Users/amady/lin/monprojet`,
     qui ne désigne rien sur le Linux du collègue alors que la SESSION, elle, se partage. La
     ligne ne porte donc que l'empreinte, le libellé et le propriétaire ; le chemin est résolu
     ICI, dans la carte de ce poste. Absent, `path` vaut `null` : le dossier appartient à
     quelqu'un d'autre, la session se relit mais ne se relance pas. */
  const carteDirs = localdirs.carte();
  const poignees = localsession.carte('local_task_dir');
  const avecRetour = unitesAvecRetour('local', taskId);
  return db.prepare('SELECT * FROM local_task_dir WHERE task_id = ? ORDER BY id').all(taskId)
    .map((brute) => localsession.resoudre('local_task_dir', brute, poignees))
    .map((d) => ({
      ...d,
      has_output: (avecRetour.has(d.id) || !!d.output_path) ? 1 : 0,
      path: carteDirs.get(d.dir_hash) || null,
      // Sur la ligne RECOLLÉE à `local_session` : la ligne brute n'a plus la poignée.
      resume_cmd: agentsession.resumeCommand(d.session_backend, d.session_key, d.session_cwd),
      // Les questions posées par l'agent, prêtes à afficher. Illisibles → aucune, plutôt qu'un plantage.
      questions: d.questions_json ? (() => { try { return JSON.parse(d.questions_json); } catch { return null; } })() : null,
    }));
}
function localTaskById(id) {
  const lt = avecRangement('local_task', db.prepare('SELECT * FROM local_task WHERE id = ?').get(id));
  if (!lt) return null;
  lt.dirs = localDirsFor(id);
  return lt;
}
app.get('/api/local-tasks', wrap((req, res) => {
  // Même tri que les sessions de codage : d'abord ce qui tourne, puis ce qui vient de finir.
  const list = db.prepare(`SELECT * FROM local_task
    ORDER BY (status = 'running') DESC, COALESCE(finished_at, created_at) DESC, id DESC`).all();
  const couts = coutParSession('local');
  const durees = dureeParSession('local');
  const range = rangement('local_task');
  /* « PAR QUI » — lu de git, sans colonne. C'est ce qui décide si la carte propose « supprimer »
     ou seulement « ranger » : la session d'un collègue ne se retire pas du dépôt. */
  const parQui = auteurs('local_task', list);
  for (const lt of list) {
    lt.author = parQui.get(lt.id) || null;
    lt.hidden = range.get(lt.uid) === '1' ? 1 : 0;
    lt.dirs = localDirsFor(lt.id);
    /* Hors dépôt, la réponse vit PAR DOSSIER : on prend celle du premier qui en a une — la
       carte porte un chapeau, pas un rapport, et l'ouvrir donne toujours le détail complet. */
    const avecReponse = (lt.dirs || []).find((d) => d.output_path);
    lt.answer_head = avecReponse ? chapeauReponse(avecReponse.output_path) : '';
    lt.tokens_est = (couts[lt.id] || {}).tokens || null;
    lt.cost_usd = (couts[lt.id] || {}).cost_usd ?? null;
    lt.duration_ms = durees[lt.id] != null ? durees[lt.id] : null;
    lt.todo_waiting = !!db.prepare(`SELECT 1 FROM todo
      WHERE auto_kind = 'local_question' AND auto_ref = ? AND status = 'open' AND archived_at IS NULL`)
      .get(String(lt.id));
  }
  res.json(list);
}));
app.post('/api/local-tasks', wrap((req, res) => {
  const { prompt, dirs, images, session_id, label, ask_questions } = req.body || {};
  if (!(prompt || '').trim()) throw new Error(t('err.prompt-requis'));
  const sessionId = normalizeSessionId(session_id);
  const list = (Array.isArray(dirs) ? dirs : []).map((d) => String(d || '').trim()).filter(Boolean);
  if (!list.length) throw new Error(t('err.local-dirs-required'));
  const now = new Date().toISOString();
  const id = db.prepare(`INSERT INTO local_task (prompt, label, ask_questions, shared, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'new', ?, ?)`)
    .run(prompt.trim(), lireLibelle(label), ask_questions ? 1 : 0,
      req.body && req.body.shared ? 1 : 0, now, now).lastInsertRowid;
  // Même principe que pour les sessions sur dépôt : la session fournie est rangée comme
  // si la première passe l'avait créée, `localcoder` la reprend alors sans rien savoir.
  /* `path` reste à la chaîne vide : la colonne est `NOT NULL` depuis l'origine, et elle est
     GELÉE — le chemin vit désormais dans `local_dir_map`, sur le poste qui le connaît. */
  const ins = db.prepare(`INSERT INTO local_task_dir (task_id, path, dir_hash, dir_label, owner, status, updated_at)
    VALUES (?, '', ?, ?, ?, 'new', ?)`);
  const moi = identite.nom() || null;
  for (const p of [...new Set(list)]) {
    const { dir_hash: h, dir_label: lbl } = localdirs.declarer(p);
    const rowid = ins.run(id, h, lbl, moi, now).lastInsertRowid;
    /* Le handle fourni à la création est rangé comme si la première passe l'avait produit :
       `localcoder` le reprend alors sans rien savoir. Il vit dans `local_session` — il ne vaut
       que sur cette machine. */
    if (sessionId) {
      const uid = db.prepare('SELECT uid FROM local_task_dir WHERE id = ?').get(rowid).uid;
      localsession.ecrire('local_task_dir', uid, { session_key: sessionId, session_backend: agentsession.backendName() });
    }
  }
  savePiecesEtImages('local', id, req.body || {}); // captures et documents (facultatif)
  res.json(localTaskById(id));
}));
// Détail d'une session hors dépôt (édition) — pendant de GET /api/tasks/:id.
app.get('/api/local-tasks/:id', wrap((req, res) => {
  const lt = localTaskById(Number(req.params.id));
  if (!lt) throw new Error(t('err.session-introuvable'));
  res.json({ task: lt, images: piecesExposees('local', lt.id) });
}));

/* Édition d'une session hors dépôt — même contrat que PUT /api/tasks/:id.
   Les dossiers ne sont RECRÉÉS que si leur composition change : sinon on perdrait avec eux
   le statut de chaque dossier, le retour de l'agent et surtout le handle de session — une
   correction de faute de frappe dans le prompt repartirait de zéro. */
app.put('/api/local-tasks/:id', wrap((req, res) => {
  const lt = localTaskById(Number(req.params.id));
  if (!lt) throw new Error(t('err.session-introuvable'));
  const { prompt, dirs, images, session_id, label, ask_questions } = req.body || {};
  const sessionId = normalizeSessionId(session_id);
  if (Array.isArray(dirs) && dirs.length) {
    const list = [...new Set(dirs.map((d) => String(d || '').trim()).filter(Boolean))];
    if (!list.length) throw new Error(t('err.local-dirs-required'));
    if (list.join('|') !== lt.dirs.map((d) => d.path).join('|')) {
      const now = new Date().toISOString();
      db.prepare('DELETE FROM local_task_dir WHERE task_id = ?').run(lt.id);
      const ins = db.prepare(`INSERT INTO local_task_dir (task_id, path, dir_hash, dir_label, owner, status, updated_at)
        VALUES (?, '', ?, ?, ?, 'new', ?)`);
      const moi = identite.nom() || null;
      for (const p of list) {
        const { dir_hash: h, dir_label: lbl } = localdirs.declarer(p);
        ins.run(lt.id, h, lbl, moi, now);
      }
    }
  }
  if (prompt != null && !String(prompt).trim()) throw new Error(t('err.prompt-requis'));
  db.prepare('UPDATE local_task SET prompt = ?, label = ?, ask_questions = ?, updated_at = ? WHERE id = ?')
    .run(prompt != null ? String(prompt).trim() : lt.prompt,
      label === undefined ? lt.label : lireLibelle(label),
      // Absent du body → on garde la valeur actuelle, comme pour les sessions sur dépôt.
      ask_questions == null ? lt.ask_questions : (ask_questions ? 1 : 0),
      new Date().toISOString(), lt.id);
  savePiecesEtImages('local', lt.id, req.body || {});
  applySessionId('local_task_dir', 'task_id', lt.id, sessionId, localDirsFor(lt.id));
  res.json(localTaskById(lt.id));
}));

app.post('/api/local-tasks/:id/run', wrap((req, res) => {
  const lt = localTaskById(Number(req.params.id));
  if (!lt) throw new Error(t('err.session-introuvable'));
  const dirIds = normalizeDirIds(lt.id, req.body && req.body.dirs);
  res.json(jobs.startLocalJob(lt.id, dirIds ? { dirIds } : {}));
}));
// Demande de correction : nouvelle passe de l'IA sur les mêmes dossiers, en REPRENANT
// la session de chacun (l'IA garde le contexte du travail qu'elle vient de produire).
/* Réponses aux questions de l'agent, hors dépôt. Même contrat que la route des sessions sur
   dépôt — mais les questions vivent sur le DOSSIER, qui a sa propre session d'agent : on ne
   reprend que celui-là, les autres dossiers n'ont rien demandé. */
app.post('/api/local-tasks/:id/dirs/:did/answer', wrap((req, res) => {
  const lt = localTaskById(Number(req.params.id));
  if (!lt) throw new Error(t('err.session-introuvable'));
  const d = (lt.dirs || []).find((x) => x.id === Number(req.params.did));
  if (!d) throw new Error(t('err.local-dir-not-found'));
  if (d.status !== 'needs_input') throw new Error(t('err.session-pas-en-attente'));

  /* RÉPONDU AILLEURS — voir la route jumelle des sessions de dépôt. Ici, rien à inspecter :
     l'agent travaille EN PLACE, il n'y a ni branche ni commit à interroger. Le dossier est donc
     rendu à l'état « fait », et ce qu'il contient est ce que le terminal en a fait. */
  if (req.body && req.body.elsewhere) {
    db.prepare("UPDATE local_task_dir SET questions_json = NULL, status = 'done', last_error = NULL, updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), d.id);
    const attendent = db.prepare("SELECT COUNT(*) c FROM local_task_dir WHERE task_id = ? AND status = 'needs_input'")
      .get(lt.id).c;
    if (!attendent) notes.fermerTodoAuto('local_question', lt.id);
    localcoder.syncStatus(lt.id);   // le statut de la session suit celui de ses dossiers
    return res.json({ ok: true, task: localTaskById(lt.id) });
  }

  let qs = [];
  try { qs = d.questions_json ? JSON.parse(d.questions_json) : []; } catch { qs = []; }
  const answers = (req.body && req.body.answers) || {};
  let filled = 0;
  qs = qs.map((q) => {
    const a = answers[q.id];
    if (a != null && String(a).trim()) { filled += 1; return { ...q, answer: String(a).trim(), answeredAt: new Date().toISOString() }; }
    return q;
  });
  if (!filled) throw new Error(t('err.reponses-manquantes'));
  // On quitte `needs_input` DÈS l'envoi : sinon un rechargement ré-affiche un formulaire déjà rempli.
  db.prepare("UPDATE local_task_dir SET questions_json = ?, status = 'running', last_error = NULL, updated_at = ? WHERE id = ?")
    .run(JSON.stringify(qs), new Date().toISOString(), d.id);
  /* La todo ne se referme que si plus AUCUN dossier n'attend : sur une session à cinq
     dossiers, répondre au premier ne solde pas le travail. */
  const encore = db.prepare("SELECT COUNT(*) c FROM local_task_dir WHERE task_id = ? AND status = 'needs_input'")
    .get(lt.id).c;
  if (!encore) notes.fermerTodoAuto('local_question', lt.id);
  res.json(jobs.startLocalJob(lt.id, { answersDirId: d.id }));
}));

app.post('/api/local-tasks/:id/followup', wrap((req, res) => {
  const lt = localTaskById(Number(req.params.id));
  if (!lt) throw new Error(t('err.session-introuvable'));
  const instruction = (req.body && req.body.instruction || '').trim() || lt.followup_draft || '';
  if (!instruction) throw new Error(t('err.demande-de-suivi-requise'));
  // Même geste que sur une session de dépôt : une capture peut accompagner la demande.
  const imageIds = savePiecesEtImages('local', lt.id, req.body || {}, { followup: 1 });
  res.json(envoyerSuivi('local_task', lt, () => jobs.startLocalJob(lt.id,
    { instruction, ...(imageIds.length ? { imageIds } : {}) })));
}));

// Suivi en attente d'une session hors dépôt — même contrat que POST /tasks/:id/followup-draft.
app.put('/api/local-tasks/:id/followup-draft', wrap((req, res) => {
  const lt = localTaskById(Number(req.params.id));
  if (!lt) throw new Error(t('err.session-introuvable'));
  poserSuivi('local_task', lt.id, req.body && req.body.instruction, req.body && req.body.auto);
  const apres = localTaskById(lt.id);
  res.json({ ok: true, followup_draft: apres.followup_draft, followup_auto: apres.followup_auto });
}));

// Historique des itérations d'un dossier hors dépôt (même forme que côté session).
app.get('/api/local-tasks/:id/dirs/:did/passes', wrap((req, res) => {
  const d = localdirs.resoudre(db.prepare('SELECT * FROM local_task_dir WHERE id = ? AND task_id = ?')
    .get(Number(req.params.did), Number(req.params.id)));
  if (!d) throw new Error(t('err.local-dir-introuvable'));
  res.json(passesPayload('local', d.id, Number(req.params.id), req.query.n, d.path, d.output_path));
}));

/* LE DIFF D'UNE ITÉRATION HORS DÉPÔT. Mêmes trois routes, même viewer, même forme que côté
   dépôt : seule la provenance du patch change. Ici il n'y a ni branche ni commit dans le
   dossier de l'utilisateur — les deux bornes sont des commits du dépôt de SUIVI, qui vit dans
   le dossier de travail de Mergerie (`localsnapshot`), et c'est lui qu'on interroge. */
function dossierLocalOu404(taskId, dirId) {
  const d = localdirs.resoudre(db.prepare('SELECT * FROM local_task_dir WHERE id = ? AND task_id = ?').get(Number(dirId), Number(taskId)));
  if (!d) throw new Error(t('err.local-dir-introuvable'));
  return d;
}
function ctxPasseLocale(taskId, d, p) {
  const gitdir = localsnapshot.dossierSuivi(Number(taskId), d.id);
  if (!fs.existsSync(gitdir)) throw new Error(t('err.task.pass-no-diff'));
  return { cwd: gitdir, ref: p.head_sha, target: p.base_sha, shaRange: true };
}
function passeLocaleDe(taskId, d, n) {
  const p = agentpass.get('local', Number(taskId), d.id, Number(n));
  if (!p) throw new Error(t('err.task.pass-not-found'));
  return p;
}

app.get('/api/local-tasks/:id/dirs/:did/passes/:n/diffview', wrap(async (req, res) => {
  const d = dossierLocalOu404(req.params.id, req.params.did);
  const p = passeLocaleDe(req.params.id, d, req.params.n);
  /* Hors dépôt : le dossier EST le dépôt quand il en est un. `ctxPasseLocale` sait où il vit. */
  const diff = await diffDePasse(p, ctxPasseLocale(req.params.id, d, p).cwd);
  res.json({
    ...(await viewerPayload(ctxPasseLocale(req.params.id, d, p), { diff, source: d.path })),
    project: d.path, branch: '',
    pass: { n: p.n, kind: p.kind, titre: p.titre || '', prompt: p.prompt || '' },
  });
}));
app.get('/api/local-tasks/:id/dirs/:did/passes/:n/file', wrap(async (req, res) => {
  const d = dossierLocalOu404(req.params.id, req.params.did);
  const p = passeLocaleDe(req.params.id, d, req.params.n);
  res.json(await viewerFile(ctxPasseLocale(req.params.id, d, p), String(req.query.path || '')));
}));
app.get('/api/local-tasks/:id/dirs/:did/passes/:n/filediff', wrap(async (req, res) => {
  const d = dossierLocalOu404(req.params.id, req.params.did);
  const p = passeLocaleDe(req.params.id, d, req.params.n);
  res.json(await viewerFileDiff(ctxPasseLocale(req.params.id, d, p), String(req.query.path || '')));
}));

// Retour de l'agent pour UN dossier (ce qu'il dit avoir fait).
app.get('/api/local-tasks/:id/dirs/:did/output', wrap((req, res) => {
  const d = localdirs.resoudre(db.prepare('SELECT * FROM local_task_dir WHERE id = ? AND task_id = ?')
    .get(Number(req.params.did), Number(req.params.id)));
  if (!d) throw new Error(t('err.local-dir-introuvable'));
  res.json({ output: d.output_path ? readFileSafe(d.output_path) : null, path: d.path });
}));

app.delete('/api/local-tasks/:id', wrap((req, res) => {
  const id = Number(req.params.id);
  const aSupprimer = localTaskById(id);
  if (aSupprimer) exigerProprietaire('local_task', aSupprimer);
  agentpass.removeTask('local', id);                     // pas de FK : nettoyage explicite
  pieces.removeOwner('local', id);
  db.prepare('DELETE FROM local_task WHERE id = ?').run(id); // cascade sur dirs + images
  try { fs.rmSync(path.join(TASKS_DIR, 'local', String(id)), { recursive: true, force: true }); } catch { /* rien */ }
  res.json({ ok: true });
}));

// Ranger / ressortir une session hors dépôt — pendant de POST /tasks/:id/hidden.
app.post('/api/local-tasks/:id/share', wrap((req, res) => {
  const lt = localTaskById(Number(req.params.id));
  if (!lt) throw new Error(t('err.session-introuvable'));
  const shared = basculerPartage('local_task', 'local', lt, req.body && req.body.shared);
  res.json({ ok: true, shared, task: localTaskById(lt.id) });
}));

app.post('/api/local-tasks/:id/hidden', wrap((req, res) => {
  const lt = localTaskById(Number(req.params.id));
  if (!lt) throw new Error(t('err.session-introuvable'));
  const hidden = (req.body && req.body.hidden) ? 1 : 0;
  prefLocale.ecrire('local_task', lt.uid, 'hidden', hidden ? '1' : null);
  db.prepare('UPDATE local_task SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), lt.id);
  res.json({ ok: true, hidden });
}));

/* ---------- Question libre ----------
   Une question posée à l'IA sans dépôt ni dossier, et sa réponse gardée. Mêmes gestes que les
   trois autres saveurs (lancer, suivre, ranger, supprimer), mais aucune cible : pas de route
   par projet ni par dossier, et rien à restreindre au lancement. */
/* `resume_cmd` : la commande à copier pour reprendre l'échange dans un terminal, comme pour
   les trois autres saveurs. Calculée à la lecture — elle dépend du binaire configuré, pas
   d'un état stocké. */
const questionById = (id) => {
  const q = localsession.resoudre('question',
    avecRangement('question', db.prepare('SELECT * FROM question WHERE id = ?').get(Number(id))));
  return q ? { ...q, resume_cmd: agentsession.resumeCommand(q.session_backend, q.session_key, q.session_cwd) } : q;
};
const exigerQuestion = (id) => {
  const q = questionById(id);
  if (!q) throw new Error(t('err.question-introuvable'));
  return q;
};

app.get('/api/questions', wrap((req, res) => {
  // Même tri que les autres listes de sessions : ce qui tourne, puis ce qui vient de finir.
  const rows = db.prepare(`SELECT * FROM question
    ORDER BY (status = 'running') DESC, COALESCE(finished_at, created_at) DESC, id DESC`).all();
  const couts = coutParSession('ask');
  const durees = dureeParSession('ask');
  const range = rangement('question');
  const poignees = localsession.carte('question');
  const parQui = auteurs('question', rows);
  res.json(rows.map((brute) => {
    /* La poignée de session vit dans `local_session` : la commande de reprise se calcule sur
       la ligne RECOLLÉE, jamais sur la ligne brute — où elle n'est plus, et où elle rendait
       toujours null. */
    const q = localsession.resoudre('question', avecRangement('question', brute, range), poignees);
    return {
      author: parQui.get(q.id) || null,
      ...q,
      answer_head: chapeauReponse(q.md_path),
      tokens_est: (couts[q.id] || {}).tokens || null,
      cost_usd: (couts[q.id] || {}).cost_usd ?? null,
      duration_ms: durees[q.id] != null ? durees[q.id] : null,
      resume_cmd: agentsession.resumeCommand(q.session_backend, q.session_key, q.session_cwd),
    };
  }));
}));

app.post('/api/questions', wrap((req, res) => {
  const { prompt, label } = req.body || {};
  if (!(prompt || '').trim()) throw new Error(t('err.prompt-requis'));
  const now = new Date().toISOString();
  const id = db.prepare(`INSERT INTO question (prompt, label, shared, status, created_at, updated_at)
    VALUES (?, ?, ?, 'new', ?, ?)`)
    .run(String(prompt).trim(), lireLibelle(label), req.body && req.body.shared ? 1 : 0, now, now).lastInsertRowid;
  savePiecesEtImages('ask', id, req.body || {});
  res.json(questionById(id));
}));

app.get('/api/questions/:id', wrap((req, res) => {
  const q = exigerQuestion(req.params.id);
  res.json({ task: q, images: piecesExposees('ask', q.id) });
}));

/* Édition : le prompt et le libellé. La SESSION D'AGENT est volontairement conservée —
   corriger une faute de frappe dans sa question ne doit pas faire perdre le fil de l'échange
   déjà engagé avec l'agent. */
app.put('/api/questions/:id', wrap((req, res) => {
  const q = exigerQuestion(req.params.id);
  const { prompt, label } = req.body || {};
  if (prompt != null && !String(prompt).trim()) throw new Error(t('err.prompt-requis'));
  db.prepare('UPDATE question SET prompt = ?, label = ?, updated_at = ? WHERE id = ?')
    .run(prompt != null ? String(prompt).trim() : q.prompt,
      label === undefined ? q.label : lireLibelle(label),
      new Date().toISOString(), q.id);
  savePiecesEtImages('ask', q.id, req.body || {});
  res.json(questionById(q.id));
}));

app.post('/api/questions/:id/run', wrap((req, res) => {
  res.json(jobs.startAskJob(exigerQuestion(req.params.id).id));
}));

// Question de suivi : elle REPREND la session de l'agent, qui garde le fil de l'échange.
app.post('/api/questions/:id/followup', wrap((req, res) => {
  const q = exigerQuestion(req.params.id);
  const instruction = (req.body && req.body.instruction || '').trim() || q.followup_draft || '';
  if (!instruction) throw new Error(t('err.demande-de-suivi-requise'));
  // Comme les autres saveurs : une pièce peut accompagner la demande de suivi.
  const imageIds = savePiecesEtImages('ask', q.id, req.body || {}, { followup: 1 });
  res.json(envoyerSuivi('question', q, () => jobs.startAskJob(q.id,
    { instruction, ...(imageIds.length ? { imageIds } : {}) })));
}));

// Suivi en attente — même contrat que pour les autres saveurs.
app.put('/api/questions/:id/followup-draft', wrap((req, res) => {
  const q = exigerQuestion(req.params.id);
  poserSuivi('question', q.id, req.body && req.body.instruction, req.body && req.body.auto);
  const apres = questionById(q.id);
  res.json({ ok: true, followup_draft: apres.followup_draft, followup_auto: apres.followup_auto });
}));

// La réponse, en Markdown — même forme que celle d'une exploration (visualiseur commun).
app.get('/api/questions/:id/md', wrap((req, res) => {
  const q = exigerQuestion(req.params.id);
  res.json({ md: q.md_path ? readFileSafe(q.md_path) : null, prompt: q.prompt, created_at: q.created_at });
}));

// L'historique des passes : une étude menée en cinq questions garde ses cinq réponses.
app.get('/api/questions/:id/passes', wrap((req, res) => {
  const q = exigerQuestion(req.params.id);
  res.json(passesPayload('ask', 0, q.id, req.query.n, null, q.md_path));
}));

app.post('/api/questions/:id/share', wrap((req, res) => {
  const q = exigerQuestion(req.params.id);
  const shared = basculerPartage('question', 'ask', q, req.body && req.body.shared);
  res.json({ ok: true, shared, question: exigerQuestion(q.id) });
}));

app.post('/api/questions/:id/hidden', wrap((req, res) => {
  const q = exigerQuestion(req.params.id);
  const hidden = (req.body && req.body.hidden) ? 1 : 0;
  prefLocale.ecrire('question', q.uid, 'hidden', hidden ? '1' : null);
  db.prepare('UPDATE question SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), q.id);
  res.json({ ok: true, hidden });
}));

app.post('/api/questions/:id/clear-error', wrap((req, res) => {
  const q = exigerQuestion(req.params.id);
  db.prepare("UPDATE question SET last_error = NULL, status = CASE WHEN status = 'error' THEN 'new' ELSE status END, updated_at = ? WHERE id = ?")
    .run(new Date().toISOString(), q.id);
  res.json({ ok: true });
}));

app.delete('/api/questions/:id', wrap((req, res) => {
  const id = Number(req.params.id);
  exigerProprietaire('question', exigerQuestion(id));
  agentpass.removeTask('ask', id);                       // pas de FK : nettoyage explicite
  pieces.removeOwner('ask', id);
  db.prepare('DELETE FROM question WHERE id = ?').run(id);
  try { fs.rmSync(path.join(TASKS_DIR, 'ask', String(id)), { recursive: true, force: true }); } catch { /* rien */ }
  res.json({ ok: true });
}));

/* Itération : nouvelle passe de l'IA (codage) ou question de suivi (exploration).

   `targets` restreint la correction à certains projets, comme pour « Lancer ». Sur une
   session multi-dépôts, la remarque à faire est presque toujours propre à UN projet : la
   passer à tous coûtait un appel IA par dépôt et faisait repasser l'agent sur du code qu'on
   ne voulait plus voir toucher. Une exploration produit UNE synthèse commune : la restreindre
   n'aurait pas de sens, on refuse plutôt que d'ignorer en silence. */
app.post('/api/tasks/:id/followup', wrap((req, res) => {
  const tache = taskById(Number(req.params.id));
  if (!tache) throw new Error(t('err.session-introuvable'));
  const instruction = (req.body && req.body.instruction || '').trim() || tache.followup_draft || '';
  if (!instruction) throw new Error(t('err.demande-de-suivi-requise'));
  const targetIds = normalizeTargetIds(tache.id, req.body && req.body.targets);
  if (targetIds && tache.kind !== 'code') throw new Error(t('err.followup-cible-code-only'));
  /* Une capture collée dans le suivi. Elle est enregistrée AVANT le lancement : si le job est
     refusé (un autre tourne déjà), elle reste jointe à la session plutôt que d'être perdue —
     le texte du suivi, lui, est déjà remis en brouillon par `envoyerSuivi`. */
  const imageIds = savePiecesEtImages('task', tache.id, req.body || {}, { followup: 1 });
  res.json(envoyerSuivi('task', tache, () => jobs.startTaskJob(tache.id, 'followup',
    { instruction, ...(targetIds ? { targetIds } : {}), ...(imageIds.length ? { imageIds } : {}) })));
}));

/* LE SUIVI EN ATTENTE. Écrit pendant que la session tourne, relisible et modifiable tant
   qu'il n'est pas parti, envoyé quand on le décide — jamais par la machine. Une seule route
   pour poser, corriger et effacer : un texte vide EST la suppression. */
app.put('/api/tasks/:id/followup-draft', wrap((req, res) => {
  const tache = taskById(Number(req.params.id));
  if (!tache) throw new Error(t('err.session-introuvable'));
  poserSuivi('task', tache.id, req.body && req.body.instruction, req.body && req.body.auto);
  const apres = taskById(tache.id);
  res.json({ ok: true, followup_draft: apres.followup_draft, followup_auto: apres.followup_auto });
}));

/* Un suivi ne part qu'une fois. On le retire AVANT de lancer — sinon deux clics rapides
   partent deux fois — et on le remet si le lancement échoue, pour ne pas perdre le texte
   sur une session qui tournait déjà. */
function envoyerSuivi(table, session, lancer) {
  const garde = session.followup_draft;
  if (garde) poserSuivi(table, session.id, null, 0);
  try { return lancer(); } catch (e) {
    if (garde) poserSuivi(table, session.id, garde, session.followup_auto);   // texte ET case
    throw e;
  }
}

// Réponses aux questions de l'agent (ask → stop → resume) : on enregistre les réponses sur
// la cible, puis on relance l'agent DANS LA MÊME session pour qu'il poursuive.
app.post('/api/tasks/:id/targets/:tid/answer', wrap((req, res) => {
  const tg = targetById(Number(req.params.id), Number(req.params.tid));
  if (!tg) throw new Error(t('err.projet-introuvable-pour-cette-session'));
  if (tg.status !== 'needs_input') throw new Error(t('err.session-pas-en-attente'));
  const tache = taskById(Number(req.params.id));

  /* UNE EXPLORATION N'A QU'UNE SESSION POUR TOUS SES DÉPÔTS. La question est donc posée sur
     CHAQUE cible — c'est ce qui la fait apparaître où qu'on regarde — mais y répondre répond
     pour la session ENTIÈRE : la reprise débloque d'elle-même les autres cibles avant de
     relancer l'agent. Le décompte plus bas les voyait encore en attente et laissait la todo
     posée par l'outil ouverte pour toujours dès qu'il y avait deux dépôts — c'est-à-dire pour
     les trois agents livrés, tous en périmètre « tous les dépôts ». On solde donc l'attente
     ici, APRÈS validation (une demande refusée ne doit rien changer) et avant de compter.
     En CODAGE la condition reste entière : chaque dépôt y a sa propre session et ses propres
     questions, et répondre au premier ne solde pas les quatre autres. */
  const solderExploration = () => {
    if (!tache || tache.kind !== 'explore') return;
    db.prepare(`UPDATE task_target SET status = 'running', last_error = NULL, updated_at = ?
      WHERE task_id = ? AND status = 'needs_input'`).run(new Date().toISOString(), Number(req.params.id));
  };

  /* RÉPONDU AILLEURS. « Reprendre au terminal » copie la session d'agent : on peut donc
     répondre aux questions dans son propre terminal, et l'agent y poursuit le travail — dans le
     clone de Mergerie, qui n'en sait rien. Le projet restait alors « en attente » pour toujours,
     et le formulaire proposait de répondre une seconde fois, ce qui aurait relancé l'agent sur
     un travail déjà fait.
     On ne DEVINE pas ce qui s'est passé dehors : on regarde la branche, avec la mécanique qui
     sert déjà à « Vérifier l'état des branches ». Elle rend des commits, ou rien — et dans les
     deux cas, c'est la vérité du dépôt, pas une supposition. */
  if (req.body && req.body.elsewhere) {
    db.prepare("UPDATE task_target SET questions_json = NULL, status = 'running', last_error = NULL, updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), tg.id);
    solderExploration();
    const attendent = db.prepare("SELECT COUNT(*) c FROM task_target WHERE task_id = ? AND status = 'needs_input'")
      .get(Number(req.params.id)).c;
    if (!attendent) notes.fermerTodoAuto('session_question', Number(req.params.id));
    return res.json(jobs.startReconcileJob(Number(req.params.id), {
      statuts: ['running'], targetIds: [tg.id], siRien: 'new',
    }));
  }

  let qs = [];
  try { qs = tg.questions_json ? JSON.parse(tg.questions_json) : []; } catch { qs = []; }
  const answers = (req.body && req.body.answers) || {};
  let filled = 0;
  qs = qs.map((q) => {
    const a = answers[q.id];
    if (a != null && String(a).trim()) { filled += 1; return { ...q, answer: String(a).trim(), answeredAt: new Date().toISOString() }; }
    return q;
  });
  if (!filled) throw new Error(t('err.reponses-manquantes'));
  // On quitte `needs_input` DÈS l'envoi des réponses : sinon, tant que la reprise tourne,
  // le moindre rechargement ré-affiche le formulaire (déjà répondu). Passage direct en running.
  db.prepare("UPDATE task_target SET questions_json = ?, status = 'running', last_error = NULL, updated_at = ? WHERE id = ?")
    .run(JSON.stringify(qs), new Date().toISOString(), tg.id);
  /* La todo posée par l'outil se referme ici — mais SEULEMENT si plus aucun projet de la
     session n'attend : sur une session multi-dépôts, répondre au premier ne solde pas le
     travail, et une todo cochée trop tôt fait oublier les quatre autres. */
  solderExploration();
  const encore = db.prepare("SELECT COUNT(*) c FROM task_target WHERE task_id = ? AND status = 'needs_input'")
    .get(Number(req.params.id)).c;
  if (!encore) notes.fermerTodoAuto('session_question', Number(req.params.id));
  res.json(jobs.startTaskJob(Number(req.params.id), 'answer', { targetId: tg.id }));
}));

// Push d'UN projet de la session.
app.post('/api/tasks/:id/targets/:tid/push', wrap((req, res) => {
  const tg = targetById(Number(req.params.id), Number(req.params.tid));
  if (!tg) throw new Error(t('err.projet-introuvable-pour-cette-session'));
  if (tg.status !== 'committed') throw new Error(t('err.ce-projet-doit-etre-execute'));
  /* `force` vient de la CASE de la confirmation : c'est celui qui pousse qui décide, pas un
     drapeau posé plus tôt. Absent = push normal, y compris sur une branche rattrapée — le
     refus de la forge est alors la bonne réponse, et il se lit sur la ligne du projet. */
  const force = !!(req.body && (req.body.force === true || req.body.force === '1'));
  res.json(jobs.startTaskJob(Number(req.params.id), 'push', { targetId: tg.id, force }));
}));

/* Rattraper la branche de départ sur UN projet de la session.
 *
 * Ouvert dès que le travail est commité ou poussé — c'est-à-dire dès qu'il y a une branche à
 * rattraper. On ne restreint pas aux MR « en conflit » : les conflits se découvrent sur la
 * forge, souvent avant que l'application les connaisse, et un bouton qui n'apparaît qu'après
 * coup arrive toujours trop tard. Si la branche est déjà à jour, le job le dit et s'arrête. */
/* A21 — REPARTIR D'UNE SESSION D'AGENT NEUVE. Une session `claude` appartient au répertoire
   où elle a été créée : un identifiant venu d'ailleurs (le dépôt de l'utilisateur, une session
   ouverte à la main) n'existe pas dans le clone de Mergerie, et chaque passe échouait sur la
   même reprise impossible. Le repli automatique existe déjà côté runner ; ce bouton est pour
   le cas où l'on veut TRANCHER — on oublie le handle, la prochaine passe en crée un. */
app.post('/api/tasks/:id/targets/:tid/forget-session', wrap((req, res) => {
  const tg = targetById(Number(req.params.id), Number(req.params.tid));
  if (!tg) throw new Error(t('err.projet-introuvable-pour-cette-session'));
  localsession.oublier('task_target', db.prepare('SELECT uid FROM task_target WHERE id = ?').get(tg.id).uid);
  db.prepare('UPDATE task_target SET session_note = NULL WHERE id = ?')
    .run(tg.id);
  res.json({ ok: true });
}));

app.post('/api/tasks/:id/targets/:tid/update-base', wrap((req, res) => {
  const tg = targetById(Number(req.params.id), Number(req.params.tid));
  if (!tg) throw new Error(t('err.projet-introuvable-pour-cette-session'));
  if (!['committed', 'pushed', 'error'].includes(tg.status)) {
    throw new Error(t('err.ce-projet-doit-etre-execute'));
  }
  res.json(jobs.startTaskJob(Number(req.params.id), 'update-base', { targetId: tg.id }));
}));

// Crée la MR d'UN projet de la session.
/* Pousser toutes les branches d'une session qui ne le sont pas encore, en UN job. Sur une
   session de dix dépôts, pousser à la main dix fois est un travail de scribe — et on en oublie. */
app.post('/api/tasks/:id/push-all', wrap((req, res) => {
  const t2 = taskById(Number(req.params.id));
  if (!t2) throw new Error(t('err.session-introuvable'));
  const cibles = db.prepare("SELECT id FROM task_target WHERE task_id = ? AND status = 'committed' ORDER BY id").all(t2.id);
  if (!cibles.length) throw new Error(t('err.rien-a-pousser'));
  res.json(jobs.startTaskJob(t2.id, 'push-all', { targetIds: cibles.map((c) => c.id) }));
}));

/* Créer la MR de tous les projets poussés qui n'en ont pas encore. Le titre n'est pas demandé
   projet par projet : chacun reprend la règle du cas unitaire (message de commit, sinon nom de
   branche). Un échec sur un projet n'empêche pas les autres — le bilan dit lesquels. */
app.post('/api/tasks/:id/mrs', wrap(async (req, res) => {
  const t2 = taskById(Number(req.params.id));
  if (!t2) throw new Error(t('err.session-introuvable'));
  const cfg = getConfig();
  const squash = !!(req.body && req.body.squash);
  const removeSourceBranch = !!(req.body && req.body.removeSourceBranch);
  const cibles = taskTargets(t2.id).filter((tg) => tg.status === 'pushed' && !effectiveMr(tg));
  if (!cibles.length) throw new Error(t('err.aucune-mr-a-creer'));
  const created = []; const failed = [];
  for (const tg of cibles) {
    try {
      const title = t2.commit_message || tg.branch;
      let target = tg.base_branch;
      if (!target) { const b = await forge.clientFor(tg).listBranches(cfg, tg.project); target = b.default || 'main'; }
      const mr = await forge.clientFor(tg).createMergeRequest(cfg, tg.project, {
        source_branch: tg.branch, target_branch: target, title, squash, removeSourceBranch,
      });
      db.prepare('UPDATE task_target SET mr_iid = ?, mr_url = ?, mr_target = ?, mr_merged = 0, updated_at = ? WHERE id = ?')
        .run(mr.iid, mr.web_url, target, new Date().toISOString(), tg.id);
      rememberMergeOpts(tg.repo_id, mr.iid, squash, removeSourceBranch);
      created.push({ project: tg.project, iid: mr.iid, url: mr.web_url });
    } catch (e) {
      failed.push({ project: tg.project, error: e.message });
    }
  }
  res.json({ created, failed });
}));

app.post('/api/tasks/:id/targets/:tid/mr', wrap(async (req, res) => {
  const tache = taskById(Number(req.params.id));
  const tg = targetById(Number(req.params.id), Number(req.params.tid));
  if (!tache || !tg) throw new Error(t('err.projet-introuvable-pour-cette-session'));
  if (tg.status !== 'pushed') throw new Error(t('err.la-branche-doit-etre-poussee'));
  const already = effectiveMr(tg);
  if (already) throw new Error(t('err.mr-already-open', { iid: already.iid }));
  const cfg = getConfig();
  const title = (req.body && req.body.title || '').trim() || tache.commit_message || tg.branch;
  let target = tg.base_branch;
  if (!target) { const b = await forge.clientFor(tg).listBranches(cfg, tg.project); target = b.default || 'main'; }
  const squash = !!(req.body && req.body.squash);
  const removeSourceBranch = !!(req.body && req.body.removeSourceBranch);
  const mr = await forge.clientFor(tg).createMergeRequest(cfg, tg.project, {
    source_branch: tg.branch, target_branch: target, title, squash, removeSourceBranch,
  });
  db.prepare('UPDATE task_target SET mr_iid = ?, mr_url = ?, mr_target = ?, mr_merged = 0, updated_at = ? WHERE id = ?')
    .run(mr.iid, mr.web_url, target, new Date().toISOString(), tg.id);
  rememberMergeOpts(tg.repo_id, mr.iid, squash, removeSourceBranch);
  /* B5 — PRÉVENIR JIRA, si la session le demande. Best-effort et jamais bloquant : la merge
     request EST créée, et un Jira injoignable ne doit pas faire croire le contraire. Le
     résultat est rendu avec la réponse, pour que l'écran puisse le dire. */
  let jiraNotifie = null;
  if (tache.notify_jira) jiraNotifie = await prevenirJira(tg).catch(() => null);
  /* B9 — REVIEWER DÈS LA CRÉATION, si la session l'a demandé. La merge request vient d'être
     ouverte sur la forge : la table locale ne la connaît pas encore (c'est la découverte qui
     l'y range). On fait donc l'upsert CIBLÉ — le même que la convergence — puis on enfile la
     review. Best-effort : la merge request EST créée, et une review qui ne part pas ne doit
     pas faire croire le contraire. */
  let reviewLancee = null;
  if (tache.review_after) {
    try {
      const apiMr = await forge.clientFor(tg).getMergeRequest(cfg, tg.project, mr.iid);
      const mrId = discover.upsertMrFromApi(tg.repo_id, apiMr);
      if (mrId) reviewLancee = jobs.startJob('review', [mrId], {});
    } catch { reviewLancee = null; }
  }
  res.json({ iid: mr.iid, url: mr.web_url, jira: jiraNotifie, review: reviewLancee });
}));

// Merge la MR d'UN projet de la session.
app.post('/api/tasks/:id/targets/:tid/merge', wrap(async (req, res) => {
  const tg = targetById(Number(req.params.id), Number(req.params.tid));
  if (!tg) throw new Error(t('err.projet-introuvable-pour-cette-session'));
  const eff = effectiveMr(tg);
  if (!eff) throw new Error(t('err.aucune-mr-a-merger-pour'));
  const known = db.prepare('SELECT * FROM mr WHERE repo_id = ? AND iid = ?').get(tg.repo_id, eff.iid);
  const merged = await forge.clientFor(tg).mergeMergeRequest(getConfig(), tg.project, eff.iid, mergeOptsFor(known, req.body));
  // GitLab peut répondre 200 sans merge immédiat : on ne marque que si l'état est 'merged'.
  const isMerged = merged && merged.state === 'merged';
  if (isMerged) {
    const now = new Date().toISOString();
    db.prepare('UPDATE task_target SET mr_iid = COALESCE(mr_iid, ?), mr_merged = 1, updated_at = ? WHERE id = ?')
      .run(eff.iid, now, tg.id);
    const linked = db.prepare('SELECT * FROM mr WHERE repo_id = ? AND iid = ?').get(tg.repo_id, eff.iid);
    if (linked) {
      db.prepare('UPDATE mr SET closed_seen = 1 WHERE id = ?').run(linked.id);
      db.prepare('INSERT INTO feed (type, mr_iid, project, author, title, at) VALUES (?,?,?,?,?,?)')
        .run('mr_merged', linked.iid, tg.project, linked.author || '', linked.title || '', now);
      notify.push('mr_merged', { mr_id: linked.id, iid: linked.iid, project: tg.project, title: linked.title || '', mine: true });
    }
  }
  res.json({ ok: true, merged: isMerged, state: merged && merged.state });
}));

/* ---------- Règles de review spécifiques ---------- */
app.get('/api/rules', wrap((req, res) => {
  /* COMBIEN DE MERGE REQUESTS OUVERTES CETTE RÈGLE TOUCHE-T-ELLE ? Une règle qui ne matche
     plus rien reste dans la liste sans qu'on le sache. Le calcul est LOCAL et sans IA : les
     chemins modifiés sont en base, le nom de branche aussi — exactement ce que la règle
     regarde. Sur quelques centaines de merge requests, c'est instantané. */
  const ouvertes = db.prepare(`SELECT id, source_branch, changed_paths FROM mr
    WHERE status IN ('to_review','reviewed') AND (closed_seen IS NULL OR closed_seen = 0)`).all();
  const regles = db.prepare('SELECT * FROM review_rule ORDER BY id').all().map((r) => {
    let n = 0;
    for (const m of ouvertes) {
      /* Le nom de branche se compare comme `reviewer.js` le fait : par INCLUSION, pas par
         glob — c'est une sous-chaîne (« hotfix », « PROJ- »), et deux règles de comparaison
         pour un même champ donneraient deux comptes différents du même fait. */
      if (r.branch_match && !String(m.source_branch || '').includes(r.branch_match)) continue;
      if (r.path_match) {
        const chemins = String(m.changed_paths || '').split('\n').filter(Boolean);
        if (!chemins.length || !glob.matchingPaths(r.path_match, chemins).length) continue;
      }
      if (!r.branch_match && !r.path_match) continue;   // une règle sans critère ne « touche » rien
      n += 1;
    }
    return { ...r, open_mrs: n };
  });
  /* QUI A ÉCRIT CETTE RÈGLE, lu dans git. Une règle alimente chaque review : elle peut changer
     légitimement, et on ne la soumet à aucune porte — mais on DIT qui l'a posée, pour qu'une
     consigne inattendue ait un nom à côté d'elle. De l'information, pas une barrière. */
  const parQui = auteurs('review_rule', regles);
  res.json(regles.map((r) => ({ ...r, author: parQui.get(r.id) || null })));
}));

/* ---------- Vérificateurs (plan_add_verify.md §3) --------------------------
   Un vérificateur = un script de l'utilisateur + la liste des dépôts qu'il sait tester.
   Déclarer la couverture ici plutôt que de la deviner évite deux échecs opaques : lancer une
   vérification sur un dépôt que le script ignore, et écrire dans un répertoire de travail
   sans que personne l'ait autorisé. */

const verifierRepos = (id) => db.prepare(`SELECT vr.*, r.project
  FROM verifier_repo vr JOIN repo r ON r.id = vr.repo_id
  WHERE vr.verifier_id = ? ORDER BY r.project`).all(id);
const verifierCommandes = (id) => db.prepare('SELECT command FROM verifier_command WHERE verifier_id = ? ORDER BY position')
  .all(id).map((c) => c.command);
// « CLE=valeur », une par ligne : les noms d'équipe, les valeurs de ce poste.
const envTexte = (v) => {
  const valeurs = verifierenv.valeurs(v);
  return verifierenv.noms(v).map((n) => `${n}=${valeurs[n] || ''}`).join('\n');
};
const verifierAvecRepos = (id) => {
  const v = db.prepare('SELECT * FROM verifier WHERE id = ?').get(id);
  if (!v) return null;
  /* LES VALEURS VIENNENT DU POSTE, PAS DE LA LIGNE. `env` est ce que le formulaire édite —
     « CLE=valeur », une par ligne — recomposé à partir des noms d'équipe et des valeurs locales.
     `env_missing` dit ce que ce poste n'a pas encore renseigné : un vérificateur reçu d'un
     collègue arrive avec ses noms et sans ses valeurs, et l'écran doit le dire. */
  return {
    ...v,
    repos: verifierRepos(id),
    commands: verifierCommandes(id),
    env: envTexte(v),
    env_missing: verifierenv.manquantes(v),
  };
};

/* Valide le corps d'un vérificateur. On refuse tôt et avec un message précis : ces réglages
   pilotent l'exécution d'un programme et des checkouts chez l'utilisateur. */
function lireVerifier(body, courant) {
  const b = body || {};
  const name = (b.name != null ? String(b.name) : (courant && courant.name) || '').trim();
  if (!name) throw new Error(t('err.verifier.name-required'));

  /* UN SEUL GENRE DEPUIS LA 2.0 : la liste de commandes. La famille « script » — un exécutable
     s'engageant sur un contrat JSON — a été retirée : elle demandait d'écrire et de maintenir un
     programme pour obtenir ce que trois lignes de commandes donnent, et son contrat était la
     partie de l'outil que personne ne lisait avant d'en avoir besoin.
     Un `kind: 'script'` envoyé par un vieux client est REFUSÉ, pas corrigé en silence : accepter
     la demande en changeant sa nature ferait croire que le contrat JSON est toujours honoré. */
  if (b.kind != null && String(b.kind) !== 'commands') throw new Error(t('err.verifier.kind-removed'));
  const kind = 'commands';

  const command = '';
  const brut = b.commands != null
    ? (Array.isArray(b.commands) ? b.commands : [])
    : (courant ? verifierCommandes(courant.id) : []);
  const commands = brut.map((x) => String(x || '').trim()).filter(Boolean);
  if (!commands.length) throw new Error(t('err.verifier.commands-required'));
  /* Chaque ligne est validée MAINTENANT, pas au premier run : découvrir un « && » au bout
     de dix minutes de préparation serait un run perdu et une erreur loin de sa cause. */
  for (const c of commands) {
    const d = verifyLib.decouperCommande(c);
    if (!d.ok) throw new Error(t('err.verifier.command-invalid', { command: c, reason: d.erreur }));
  }

  /* Variables ajoutées à l'environnement minimal : « CLE=valeur », une par ligne. Les VALEURS
     ne vont pas en base : elles restent sur ce poste (`local_state`), et seuls les NOMS partent
     avec le vérificateur. `null` = le formulaire n'en parle pas, on ne touche à rien. */
  let envPaires = null;
  if (b.env != null) {
    envPaires = {};
    for (const ligne of String(b.env).split('\n')) {
      const l = ligne.trim();
      if (!l || l.startsWith('#')) continue;
      const i = l.indexOf('=');
      if (i <= 0) throw new Error(t('err.verifier.env-line', { line: l }));
      envPaires[l.slice(0, i).trim()] = l.slice(i + 1).trim();
    }
  }

  /* Rapport JUnit : chemin RELATIF au dépôt testé — le répertoire change à chaque run
     (worktree éphémère), un chemin absolu n'aurait donc aucun sens. */
  let report_path = courant ? courant.report_path : null;
  if (b.report_path != null) {
    const rp = String(b.report_path).trim();
    if (rp && (path.isAbsolute(rp) || rp.split(/[\\/]/).includes('..'))) {
      throw new Error(t('err.verifier.report-relative'));
    }
    report_path = rp || null;
  }

  const brutTimeout = b.timeout_s != null ? parseInt(b.timeout_s, 10) : (courant ? courant.timeout_s : 900);
  const timeout_s = Number.isFinite(brutTimeout) ? Math.min(7200, Math.max(10, brutTimeout)) : 900;

  const bool = (v, def) => (v == null ? def : (v ? 1 : 0));
  const repos = b.repos == null
    ? null
    : (Array.isArray(b.repos) ? b.repos : []).map((l) => {
      const repo_id = Number(l && l.repo_id);
      if (!repo_id || !repoById(repo_id)) throw new Error(t('err.projet-inconnu'));
      const mode = l.mode === 'in_place' ? 'in_place' : 'worktree';
      const workdir = (l.workdir || '').trim();
      if (mode === 'in_place') {
        // Le répertoire est celui de l'utilisateur : sans chemin absolu on ne saurait pas où.
        if (!workdir || !path.isAbsolute(workdir)) throw new Error(t('err.verifier.workdir-absolute'));
        // Le consentement est explicite parce que la conséquence l'est : on y fera un checkout.
        if (!l.checkout_allowed) throw new Error(t('err.verifier.checkout-consent'));
      }
      return { repo_id, mode, workdir: mode === 'in_place' ? workdir : null,
        checkout_allowed: mode === 'in_place' ? 1 : 0 };
    });
  const vus = new Set();
  for (const l of (repos || [])) {
    if (vus.has(l.repo_id)) throw new Error(t('err.verifier.repo-twice'));
    vus.add(l.repo_id);
  }
  return {
    name, kind, command, commands, timeout_s, envPaires, report_path,
    parse_tap: bool(b.parse_tap, courant ? courant.parse_tap : 1),
    run_base: bool(b.run_base, courant ? courant.run_base : 1),
    comment_on_forge: bool(b.comment_on_forge, courant ? courant.comment_on_forge : 0),
    auto_on_mr: bool(b.auto_on_mr, courant ? courant.auto_on_mr : 0),
    auto_on_stale: bool(b.auto_on_stale, courant ? courant.auto_on_stale : 0),
    /* Gabarit VIDE = le défaut, qui vit dans `verify.js`. On ne recopie pas le défaut en base :
       recopié, il se fige, et l'améliorer n'atteindrait plus personne. */
    comment_template: b.comment_template != null
      ? String(b.comment_template).slice(0, 5000)
      : (courant ? courant.comment_template : ''),
    /* Repris TEL QUEL dans le commentaire : c'est la forge qui résout les mentions. On borne,
       on ne valide pas — un handle valide ici dépend de la forge, du groupe, des droits, et
       refuser à tort empêcherait de prévenir quelqu'un pour une règle qu'on aurait inventée. */
    mentions: b.mentions != null ? String(b.mentions).slice(0, 500).trim() : (courant ? courant.mentions : ''),
    repos,
  };
}

function ecrireCommandes(verifierId, commands) {
  if (commands == null) return;   // absent du corps = liste inchangée
  db.prepare('DELETE FROM verifier_command WHERE verifier_id = ?').run(verifierId);
  const ins = db.prepare('INSERT INTO verifier_command (verifier_id, position, command) VALUES (?,?,?)');
  commands.forEach((c, i) => ins.run(verifierId, i, c));
}

function ecrireRepos(verifierId, repos) {
  if (repos == null) return;   // absent du corps = couverture inchangée
  db.prepare('DELETE FROM verifier_repo WHERE verifier_id = ?').run(verifierId);
  const ins = db.prepare(`INSERT INTO verifier_repo (verifier_id, repo_id, mode, workdir, checkout_allowed)
    VALUES (?, ?, ?, ?, ?)`);
  for (const l of repos) ins.run(verifierId, l.repo_id, l.mode, l.workdir, l.checkout_allowed);
}

app.get('/api/verifiers', wrap((req, res) => {
  /* CE QUE CHAQUE VÉRIFICATEUR A DONNÉ, et ce qui l'attend. Une liste de vérificateurs sans
     verdict ne dit pas lesquels servent : le dernier verdict avec sa date, et le nombre de
     merge requests à traiter que sa couverture concerne. Deux requêtes pour toute la liste. */
  const dernieres = {};
  for (const v of db.prepare(`SELECT verifier_id, verdict, finished_at FROM verification v
    WHERE verifier_id IS NOT NULL AND status IN ('done','error')
      AND id = (SELECT MAX(v2.id) FROM verification v2 WHERE v2.verifier_id = v.verifier_id)`).all()) {
    dernieres[v.verifier_id] = { verdict: v.verdict, at: v.finished_at };
  }
  const enAttente = {};
  for (const r of db.prepare(`SELECT vr.verifier_id AS id, COUNT(DISTINCT mr.id) AS n
    FROM verifier_repo vr JOIN mr ON mr.repo_id = vr.repo_id
    WHERE mr.status = 'to_review' AND (mr.closed_seen IS NULL OR mr.closed_seen = 0)
    GROUP BY vr.verifier_id`).all()) {
    enAttente[r.id] = r.n;
  }
  /* A/Réglages 3 — COMBIEN DE SESSIONS S'APPUIENT DESSUS. Renommer ou supprimer un
     vérificateur se faisait à l'aveugle : rien ne disait que douze sessions le portaient et
     le relanceraient en finissant. Une requête pour toute la liste. */
  const parSession = {};
  for (const r of db.prepare('SELECT verifier_id AS id, COUNT(*) AS n FROM task WHERE verifier_id IS NOT NULL GROUP BY verifier_id').all()) {
    parSession[r.id] = r.n;
  }
  res.json(db.prepare('SELECT * FROM verifier ORDER BY name').all()
    .map((v) => ({
      ...v, repos: verifierRepos(v.id), commands: verifierCommandes(v.id),
      last: dernieres[v.id] || null, pending_mrs: enAttente[v.id] || 0,
      used_by_tasks: parSession[v.id] || 0,
      /* Le formulaire « Modifier » se remplit de cette liste : sans `env`, il s'ouvrait vide, et
         ré-enregistrer effaçait les valeurs de ce poste. */
      env: envTexte(v),
      /* CE QUI MANQUE SUR CE POSTE. Un vérificateur reçu d'un collègue arrive avec les NOMS de
         ses variables et sans leurs valeurs — les valeurs ne voyagent pas. Le dire sur la carte
         évite un échec au lancement dont la cause serait à chercher. */
      env_missing: verifierenv.manquantes(v),
      /* À APPROUVER SUR CE POSTE : les commandes ont changé depuis la dernière fois qu'on les a
         vues ici — arrivées par la synchro. `approved_before` permet de montrer CE qui a changé,
         pas seulement QUE quelque chose a changé. */
      approval_pending: !approbation.verificateurApprouve(v.id),
      approved_before: approbation.verificateurApprouveAvant(v.id),
      approval_signature: approbation.signature(approbation.empreinteVerificateur(v.id)),
    })));
}));

app.post('/api/config/approve-auto', wrap((req, res) => {
  exigerMemeEtat((req.body || {}).signature, approbation.signature(approbation.empreinteConfig(getConfig())));
  approbation.approuverConfig(getConfig());
  res.json({ ok: true });
}));

app.post('/api/verifiers/:id/approve', wrap((req, res) => {
  const v = db.prepare('SELECT id FROM verifier WHERE id = ?').get(Number(req.params.id));
  if (!v) throw new Error(t('err.verifier.not-found'));
  exigerMemeEtat((req.body || {}).signature, approbation.signature(approbation.empreinteVerificateur(v.id)));
  approbation.approuverVerificateur(v.id);
  res.json({ ok: true });
}));

app.post('/api/verifiers', wrap((req, res) => {
  const v = lireVerifier(req.body, null);
  if (db.prepare('SELECT 1 FROM verifier WHERE name = ?').get(v.name)) {
    throw new Error(t('err.verifier.name-taken', { name: v.name }));
  }
  /* Les listes filles sont écrites AVANT que le store ne compose le fichier : elles vivent
     DANS le fichier du vérificateur, et un fichier écrit sans ses commandes décrirait un
     vérificateur qui ne fait rien. */
  const cree = store.ecrire('verifier', () => {
    const id = db.prepare(`INSERT INTO verifier
      (name, kind, command, timeout_s, run_base, comment_on_forge, auto_on_mr, auto_on_stale,
       comment_template, mentions, env_keys, report_path, parse_tap, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(v.name, v.kind, v.command, v.timeout_s, v.run_base,
      v.comment_on_forge, v.auto_on_mr, v.auto_on_stale, v.comment_template, v.mentions,
      '[]', v.report_path, v.parse_tap, new Date().toISOString()).lastInsertRowid;
    /* Les VALEURS restent ici ; seuls les noms partent avec le vérificateur. L'uid est posé par
       le déclencheur à l'insertion : on le relit. */
    if (v.envPaires) {
      const uid = db.prepare('SELECT uid FROM verifier WHERE id = ?').get(id).uid;
      db.prepare('UPDATE verifier SET env_keys = ? WHERE id = ?').run(verifierenv.poser(uid, v.envPaires), id);
    }
    ecrireRepos(id, v.repos || []);
    ecrireCommandes(id, v.commands || []);
    return id;
  });
  approbation.approuverVerificateur(cree.id);      // l'utilisateur vient de l'écrire
  res.json(verifierAvecRepos(cree.id));
}));

app.put('/api/verifiers/:id', wrap((req, res) => {
  const cur = db.prepare('SELECT * FROM verifier WHERE id = ?').get(Number(req.params.id));
  if (!cur) throw new Error(t('err.verifier.not-found'));
  const v = lireVerifier(req.body, cur);
  const homonyme = db.prepare('SELECT 1 FROM verifier WHERE name = ? AND id <> ?').get(v.name, cur.id);
  if (homonyme) throw new Error(t('err.verifier.name-taken', { name: v.name }));
  store.ecrire('verifier', () => {
    const cles = v.envPaires ? verifierenv.poser(cur.uid, v.envPaires) : (cur.env_keys || '[]');
    db.prepare(`UPDATE verifier SET name = ?, kind = ?, command = ?, timeout_s = ?, run_base = ?,
      comment_on_forge = ?, auto_on_mr = ?, auto_on_stale = ?, comment_template = ?, mentions = ?,
      env_keys = ?, report_path = ?, parse_tap = ? WHERE id = ?`)
      .run(v.name, v.kind, v.command, v.timeout_s, v.run_base, v.comment_on_forge, v.auto_on_mr,
        v.auto_on_stale, v.comment_template, v.mentions, cles, v.report_path, v.parse_tap, cur.id);
    ecrireRepos(cur.id, v.repos);
    ecrireCommandes(cur.id, v.commands);
    return cur.id;
  });
  /* Modifié ICI, dans le formulaire qui montre les commandes : c'est une approbation. */
  approbation.approuverVerificateur(cur.id);
  res.json(verifierAvecRepos(cur.id));
}));

/* Le gabarit par défaut, servi au lieu d'être recopié dans l'écran : une seconde copie
   divergerait, et l'utilisateur croirait modifier ce qui part réellement. */
app.get('/api/verifiers/comment-template-default', wrap((req, res) => {
  res.json({ template: verifyLib.GABARIT_COMMENTAIRE_DEFAUT, champs: verifyLib.CHAMPS_COMMENTAIRE });
}));

/* L'APERÇU DU GABARIT, composé par le MÊME moteur que le vrai commentaire, à partir de blocs
   d'exemple. Un aperçu rendu autrement finirait par mentir sur ce qui part réellement — et
   c'est justement pour ne pas se tromper qu'on regarde un aperçu. */
app.post('/api/verifiers/comment-preview', wrap((req, res) => {
  const gabarit = (req.body && req.body.template != null) ? String(req.body.template).slice(0, 5000) : '';
  /* Les MENTIONS de l'aperçu sont celles du formulaire, pas celles de l'exemple : c'est le seul
     champ dont l'utilisateur a la vraie valeur sous les yeux au moment où il regarde l'aperçu,
     et lui en montrer une autre serait exactement le genre de petit mensonge qu'on évite.
     L'aperçu représente un verdict ROUGE — sur un vert, les mentions ne partent pas. */
  const blocs = { ...verifyLib.EXEMPLE_COMMENTAIRE };
  if (req.body && req.body.mentions != null) blocs.mentions = String(req.body.mentions).slice(0, 500).trim();
  res.json({ body: verifyLib.composerCommentaire(blocs, gabarit) });
}));

app.delete('/api/verifiers/:id', wrap((req, res) => {
  store.supprimer('verifier', Number(req.params.id));
  res.json({ ok: true });
}));

/* Quel vérificateur peut traiter CE jeu de dépôts. Sert au bouton « Vérifier » : sans
   réponse, il est grisé avec l'explication, plutôt que de lancer un run voué à l'échec. */
/* « Tester le répertoire » (§3) : on répond AVANT d'enregistrer, pendant que l'utilisateur
   a encore le formulaire sous les yeux. Un mauvais chemin découvert au premier run, c'est un
   run perdu et une erreur loin de sa cause. */
app.post('/api/verifiers/test-workdir', wrap(async (req, res) => {
  const repo = repoById(Number(req.body && req.body.repo_id));
  if (!repo) throw new Error(t('err.projet-inconnu'));
  const workdir = String((req.body && req.body.workdir) || '').trim();
  if (!workdir || !path.isAbsolute(workdir)) throw new Error(t('err.verifier.workdir-absolute'));
  res.json(await verifyrun.inspecterWorkdir(repo, workdir));
}));

app.get('/api/verifiers/for', wrap((req, res) => {
  const ids = [...new Set(String(req.query.repos || '').split(',')
    .map((x) => Number(x.trim())).filter(Boolean))];
  if (!ids.length) return res.json({ verifiers: [] });
  const couvrants = db.prepare('SELECT * FROM verifier ORDER BY name').all().filter((v) => {
    const couverts = new Set(verifierRepos(v.id).map((r) => r.repo_id));
    return ids.every((id) => couverts.has(id));
  });
  res.json({ verifiers: couvrants.map((v) => ({ ...v, repos: verifierRepos(v.id), commands: verifierCommandes(v.id) })) });
}));

/* ---------- Lancer / consulter une vérification (§5, §8) ------------------ */

/* Cibles d'une vérification à partir de MR. On refuse tôt tout ce qui rendrait le verdict
   ininterprétable : deux MR du même dépôt (quel code testerait-on ?), une MR sans SHA. */
function ciblesDepuisMrs(mrIds) {
  const cibles = [];
  const vus = new Set();
  for (const id of mrIds) {
    const mr = mrById(Number(id));
    if (!mr) throw new Error(t('err.mr-introuvable'));
    if (vus.has(mr.repo_id)) throw new Error(t('err.verify.repo-twice'));
    vus.add(mr.repo_id);
    if (!mr.current_sha) throw new Error(t('err.verify.no-sha', { iid: mr.iid }));
    cibles.push({
      repo_id: mr.repo_id, mr_id: mr.id, head_sha: mr.current_sha,
      base_sha: `origin/${mr.target_branch || 'main'}`,
      branch: mr.source_branch, mode: 'worktree',
    });
  }
  return cibles;
}

/* Le vérificateur doit couvrir TOUS les dépôts visés. Un run partiel donnerait un vert qui
   ne dit rien de la moitié du lot — pire qu'une absence de verdict. */
function verifierPour(cibles, verifierId) {
  const ids = cibles.map((c) => c.repo_id);
  const candidats = db.prepare('SELECT * FROM verifier ORDER BY name').all().filter((v) => {
    const couverts = new Set(db.prepare('SELECT repo_id FROM verifier_repo WHERE verifier_id = ?')
      .all(v.id).map((r) => r.repo_id));
    return ids.every((id) => couverts.has(id));
  });
  if (!candidats.length) throw new Error(t('err.verify.no-verifier'));
  if (!verifierId) return candidats[0];
  const choisi = candidats.find((v) => v.id === Number(verifierId));
  if (!choisi) throw new Error(t('err.verify.verifier-not-covering'));
  return choisi;
}

/* Mode de chaque cible : déclaré par le vérificateur, dépôt par dépôt. Le mode voyage avec la
   cible pour que le rapport puisse dire « (in place) » longtemps après le run. */
function appliquerModes(verifier, cibles) {
  const par = new Map(db.prepare('SELECT * FROM verifier_repo WHERE verifier_id = ?')
    .all(verifier.id).map((r) => [r.repo_id, r]));
  return cibles.map((c) => {
    const l = par.get(c.repo_id);
    return { ...c, mode: (l && l.mode) || 'worktree', workdir: (l && l.workdir) || null };
  });
}

/* `enFile` : accepter la mise en attente au lieu de refuser. Réservé au déclenchement
   AUTOMATIQUE — et c'est la différence de nature entre les deux appelants :

   Un humain qui clique « Vérifier » sur un dépôt déjà en cours de vérification s'est trompé de
   bouton : lui répondre tout de suite vaut mieux que d'empiler un travail qu'il n'attend pas.
   La découverte, elle, ne se trompe pas — elle vient de trouver douze merge requests, et les
   refuser reviendrait à n'en vérifier qu'une : les onze autres ne seront plus jamais
   « nouvelles », donc plus jamais vérifiées automatiquement.

   Les mettre en file est SÛR : la file de jobs sérialise déjà par dépôt (`keysClash` sur
   `repo:<id>`), donc deux vérifications d'un même dépôt ne tourneront jamais ensemble — le
   refus ci-dessous n'est qu'un garde-fou d'ergonomie, pas la protection du clone. */
function creerVerification({ verifier, cibles, lotId = null, enFile = false, automatique = false }) {
  /* UN VÉRIFICATEUR HÉRITÉ DE LA FAMILLE « SCRIPT » NE TOURNE PLUS. Sa ligne est conservée
     — on ne supprime pas la configuration de quelqu'un sans le lui demander — mais le lancer
     n'aurait aucun sens : plus rien ne sait exécuter son contrat. On refuse ici, une fois pour
     toutes les portes d'entrée (MR, lot, branche, session, déclenchement automatique), avec le
     geste à faire. Le laisser partir pour échouer dix minutes plus tard serait pire. */
  if (verifier && verifier.kind !== 'commands') throw new Error(t('err.verify.script-removed', { name: verifier.name }));
  /* DES COMMANDES VENUES D'AILLEURS NE S'EXÉCUTENT PAS AVANT D'AVOIR ÉTÉ VUES ICI. Une porte
     pour toutes les entrées — MR, lot, branche, session, déclenchement automatique. Le code
     `APPROBATION` permet à l'écran d'offrir l'approbation plutôt qu'un toast rouge. */
  if (verifier && !approbation.verificateurApprouve(verifier.id)) {
    const e = new Error(t('err.verify.not-approved', { name: verifier.name }));
    e.code = 'APPROBATION';
    e.status = 409;
    throw e;
  }
  /* §10 : une vérification MULTI-DÉPÔTS monte un environnement complet et ne se partage pas ;
     une MONO-DÉPÔT n'a qu'à ne pas viser le même dépôt qu'une autre. Le message dit laquelle
     des deux raisons s'applique — elles ne se corrigent pas de la même façon. */
  const bloque = enFile ? null : jobs.verifyBloquePar(cibles.map((c) => c.repo_id));
  if (bloque) {
    throw new Error(t(bloque === 'integration' ? 'err.verify.integration-running' : 'err.verify.already-running'));
  }
  const lot = lotId ? db.prepare('SELECT name FROM lot WHERE id = ?').get(lotId) : null;
  /* On recopie les noms : le rapport doit rester lisible après suppression du vérificateur
     ou du lot, et sa suppression ne doit jamais être bloquée par un vieux verdict. */
  const info = db.prepare(`INSERT INTO verification
    (verifier_id, verifier_name, lot_id, lot_name, status, targets_json, created_at, automatic)
    VALUES (?, ?, ?, ?, 'queued', ?, ?, ?)`).run(verifier.id, verifier.name, lotId,
    lot ? lot.name : null, JSON.stringify(cibles), new Date().toISOString(), automatique ? 1 : 0);
  const id = info.lastInsertRowid;
  const job = jobs.startVerifyJob(id);
  return { verification: db.prepare('SELECT * FROM verification WHERE id = ?').get(id), job };
}

app.post('/api/mrs/:id/verify', wrap((req, res) => {
  const cibles = ciblesDepuisMrs([req.params.id]);
  const verifier = verifierPour(cibles, req.body && req.body.verifier_id);
  res.json(creerVerification({ verifier, cibles: appliquerModes(verifier, cibles) }));
}));

/* TOUTES les vérifications d'une merge request — une par vérificateur, la plus récente.
   Depuis que des vérificateurs partent automatiquement, une MR peut en avoir plusieurs : le
   badge n'en montre qu'un (le dernier verdict rendu), ce qui suffit pour « ça passe ou non »
   mais pas pour « qu'est-ce qui a tourné exactement ». La borne à 300 couvre largement les MR
   ouvertes sans relire tout l'historique — même règle qu'ailleurs. */
app.get('/api/mrs/:id/verifications', wrap((req, res) => {
  const mr = mrById(Number(req.params.id));
  if (!mr) throw new Error(t('err.mr-introuvable'));
  const vues = new Set();
  const out = [];
  for (const v of db.prepare(`SELECT * FROM verification
    WHERE status IN ('done','error') ORDER BY id DESC LIMIT 300`).all()) {
    let cibles = [];
    try { cibles = JSON.parse(v.targets_json || '[]'); } catch { continue; }
    if (!cibles.some((c) => c.mr_id === mr.id)) continue;
    // Une seule ligne par vérificateur : les passages précédents sont dans l'historique.
    const cle = v.verifier_id || `nom:${v.verifier_name}`;
    if (vues.has(cle)) continue;
    vues.add(cle);
    out.push(detailVerification(v));
  }
  res.json(out);
}));

/* A24 — L'HISTORIQUE DES VÉRIFICATIONS D'UNE MERGE REQUEST. Toutes les lignes sont conservées
   (aucun `DELETE` nulle part), mais chaque lecture dédoublonnait au dernier run par
   vérificateur : « c'était déjà rouge au run d'avant ? », « les mêmes tests ? », « depuis
   quand ça passe ? » n'avaient aucune réponse à l'écran.
 *
 * On rend donc la SUITE, du plus récent au plus ancien, avec pour chacun ce qui se compare :
 * le verdict, le SHA testé, et surtout les tests IMPUTABLES — c'est en les comparant qu'on voit
 * si l'on tourne en rond sur les mêmes deux tests ou si la correction a bougé quelque chose.
 * Charge utile volontairement maigre : pas de logs, pas de commandes — le rapport complet est
 * à un clic, et cette liste-là se lit d'un coup d'œil. */
app.get('/api/mrs/:id/verifications/history', wrap((req, res) => {
  const mr = mrById(Number(req.params.id));
  if (!mr) throw new Error(t('err.mr-introuvable'));
  const out = [];
  for (const v of db.prepare(`SELECT * FROM verification
    WHERE status IN ('done','error') ORDER BY id DESC LIMIT 300`).all()) {
    let cibles = [];
    try { cibles = JSON.parse(v.targets_json || '[]'); } catch { continue; }
    const mienne = cibles.find((c) => c.mr_id === mr.id);
    if (!mienne) continue;
    let imputable = [];
    try { imputable = JSON.parse(v.imputable_json || '[]'); } catch { imputable = []; }
    let tete = null;
    try { tete = v.head_run_json ? JSON.parse(v.head_run_json) : null; } catch { tete = null; }
    out.push({
      id: v.id,
      verifier_id: v.verifier_id,
      verifier_name: v.verifier_name || '',
      verdict: v.verdict,
      finished_at: v.finished_at,
      head_sha: mienne.head_sha || null,
      total: tete && tete.total != null ? tete.total : null,
      failed: imputable.map((f) => f.test).filter(Boolean),
    });
    if (out.length >= 20) break;   // vingt passages suffisent à voir une tendance
  }
  /* CE QUI A CHANGÉ D'UN RUN À L'AUTRE, calculé ici : deux écrans qui compareraient chacun de
     leur côté finiraient par ne pas appeler « nouveau » la même chose. Un test est NOUVEAU
     s'il casse maintenant et ne cassait pas au run précédent DU MÊME vérificateur. */
  const parVerif = {};
  for (let i = out.length - 1; i >= 0; i -= 1) {
    const v = out[i];
    const cle = v.verifier_id || `nom:${v.verifier_name}`;
    const avant = parVerif[cle];
    v.nouveaux = avant ? v.failed.filter((f) => !avant.includes(f)) : [];
    v.corriges = avant ? avant.filter((f) => !v.failed.includes(f)) : [];
    parVerif[cle] = v.failed;
  }
  res.json(out);
}));

app.get('/api/verifications/:id', wrap((req, res) => {
  const v = db.prepare('SELECT * FROM verification WHERE id = ?').get(Number(req.params.id));
  if (!v) throw new Error(t('err.verify.not-found'));
  res.json(detailVerification(v));
}));

/* LE CORPS PRÉ-REMPLI, tel qu'il partirait. Pas de composition côté écran : ce qui s'affiche
   dans la modale doit être exactement ce que la publication automatique enverrait, sinon relire
   avant de publier ne prouve rien. */
app.get('/api/verifications/:id/comment', wrap((req, res) => {
  const v = db.prepare('SELECT * FROM verification WHERE id = ?').get(Number(req.params.id));
  if (!v) throw new Error(t('err.verify.not-found'));
  let cibles = [];
  try { cibles = JSON.parse(v.targets_json || '[]'); } catch { cibles = []; }
  const mrs = cibles.filter((c) => c.mr_id).map((c) => {
    const mr = db.prepare(`SELECT mr.iid AS iid, repo.project AS project
      FROM mr JOIN repo ON repo.id = mr.repo_id WHERE mr.id = ?`).get(c.mr_id);
    return mr ? `${mr.project} !${mr.iid}` : null;
  }).filter(Boolean);
  let dejaPubliees = null;
  try { dejaPubliees = v.comment_targets ? JSON.parse(v.comment_targets) : null; } catch { dejaPubliees = null; }
  res.json({
    body: verifyrun.corpsCommentaire(v.id) || '',
    mrs,                                   // ce que la confirmation doit nommer
    posted_at: v.comment_posted_at || null, // déjà publié ? l'écran ne doit pas le taire
    posted_targets: dejaPubliees,
  });
}));

/* Publie le texte RELU. Le corps vient du client parce que c'est tout l'intérêt : le
   pré-rempli est une proposition, pas un contrat. Il est borné et publié tel quel. */
app.post('/api/verifications/:id/comment', wrap(async (req, res) => {
  const v = db.prepare('SELECT * FROM verification WHERE id = ?').get(Number(req.params.id));
  if (!v) throw new Error(t('err.verify.not-found'));
  const body = (req.body && req.body.body != null) ? String(req.body.body) : null;
  if (body != null && !body.trim()) throw new Error(t('err.verify.comment-empty'));
  const postees = await verifyrun.publierCommentaire(v.id, getConfig(), {
    body: body == null ? null : body.slice(0, 50000),
  });
  if (!postees || !postees.length) throw new Error(t('err.verify.comment-no-mr'));
  const apres = db.prepare('SELECT comment_posted_at, comment_targets FROM verification WHERE id = ?').get(v.id);
  res.json({ ok: true, posted: postees, posted_at: apres.comment_posted_at });
}));

/* Dernière vérification par MR : ce qui alimente les badges de la liste. On la calcule ici
   plutôt qu'en base pour que la PÉREMPTION suive le SHA courant sans écriture. */
function detailVerification(v) {
  const brut = JSON.parse(v.targets_json || '[]');
  const shaParMr = {};
  /* Le nom du dépôt et le numéro de MR voyagent AVEC le rapport : un identifiant nu ne dit
     rien à l'écran, et l'affichage n'a pas à disposer d'une liste de dépôts pour lire un
     verdict rendu il y a trois semaines. */
  /* `workdir` : EN MODE IN PLACE, LE RAPPORT DOIT DIRE OÙ ÇA A TOURNÉ. Le tag « in place »
     prévenait qu'on avait travaillé dans un répertoire de l'utilisateur, sans dire LEQUEL —
     or c'est précisément ce qu'on veut savoir quand un verdict surprend, ou quand la
     restauration a échoué. Lu sur la couverture du vérificateur, qui le porte. */
  const workdirs = {};
  if (v.verifier_id) {
    for (const r of db.prepare("SELECT repo_id, workdir FROM verifier_repo WHERE verifier_id = ? AND mode = 'in_place'").all(v.verifier_id)) {
      workdirs[r.repo_id] = r.workdir || '';
    }
  }
  const cibles = brut.map((c) => {
    const mr = mrById(c.mr_id);
    if (mr) shaParMr[c.mr_id] = mr.current_sha;
    const repo = db.prepare('SELECT project FROM repo WHERE id = ?').get(c.repo_id);
    return {
      ...c,
      project: (repo && repo.project) || null,
      iid: mr ? mr.iid : null,
      workdir: c.mode === 'in_place' ? (workdirs[c.repo_id] || '') : '',
    };
  });
  const lire = (j) => { try { return j ? JSON.parse(j) : null; } catch { return null; } };
  return {
    ...v,
    targets: cibles,
    base_run: lire(v.base_run_json),
    head_run: lire(v.head_run_json),
    imputable: lire(v.imputable_json) || [],
    context: lire(v.context_json) || [],
    /* A26 — LES TESTS QUI ONT DÉJÀ CLIGNOTÉ sur ce même code. Un test rouge ici et vert à un
       autre run, sans que rien n'ait bougé, n'accuse pas la branche : il s'accuse lui-même. Le
       dire sur le rapport évite la demi-heure passée à chercher ce qu'on a cassé. */
    flaky: (() => { try { return verifyrun.testsInstables(v.id); } catch { return []; } })(),
    stale: verifyLib.estPerime(cibles, shaParMr),
    in_place: cibles.some((c) => c.mode === 'in_place'),
    // Le nom courant si le vérificateur existe encore (il a pu être renommé), sinon l'archive.
    verifier_name: (db.prepare('SELECT name FROM verifier WHERE id = ?').get(v.verifier_id) || {}).name
      || v.verifier_name || '',
  };
}

/* Ce qu'un BADGE a besoin de savoir, et rien de plus : le rapport complet se demande au clic.
   Envoyer les `failed[]` de chaque MR dans la liste chargerait des kilo-octets de logs pour
   afficher « ✗ 2 tests cassés ». */
function resumeVerification(d) {
  return {
    id: d.id, verdict: d.verdict, status: d.status, stale: d.stale, in_place: d.in_place,
    failed_count: (d.imputable || []).length, verifier_name: d.verifier_name,
    /* De QUOI vient le détail, et le nom du premier échec. Sans nom de test — cas d'un
       vérificateur « commandes » dont la sortie ne dit rien — le badge nomme la commande au
       lieu d'annoncer un nombre de tests qu'on ne connaît pas. */
    detail_source: (d.head_run && d.head_run.detail_source) || null,
    failed_label: ((d.imputable || [])[0] || {}).test || null,
    lot_id: d.lot_id, lot_name: d.lot_name, finished_at: d.finished_at,
  };
}

/* Dernier verdict par MR. Une vérification porte sur PLUSIEURS merge requests quand c'est un
   lot : le lien vit dans `targets_json`, pas dans une colonne — d'où le parcours. La borne à
   300 suffit largement pour couvrir les MR ouvertes, et évite de relire tout l'historique. */
function verifsParMrDuTour() {
  if (!cacheVerifs) cacheVerifs = dernieresVerificationsParMr();
  return cacheVerifs;
}

function dernieresVerificationsParMr() {
  const par = new Map();
  const lignes = db.prepare(`SELECT * FROM verification WHERE status IN ('done','error')
    ORDER BY id DESC LIMIT 300`).all();
  for (const v of lignes) {
    let cibles = [];
    try { cibles = JSON.parse(v.targets_json || '[]'); } catch { /* ligne illisible : ignorée */ }
    for (const c of cibles) if (c.mr_id && !par.has(c.mr_id)) par.set(c.mr_id, v);
  }
  return par;
}

/* ---------- Ce qu'un dépôt sait déjà lancer ----------
   Un vérificateur, c'est une liste de commandes ; on les recopiait depuis un terminal, en se
   trompant d'un tiret. Or le dépôt les DÉCLARE : `package.json` a ses scripts, `composer.json`
   les siens, et le Makefile ses cibles. On lit ce qui est SUR LE DISQUE (le clone déjà fait),
   sans réseau et sans rien exécuter — ce sont des suggestions à cliquer, rien de plus.
   Un dépôt jamais cloné n'a rien à proposer : ce n'est pas une erreur, c'est un silence. */
function suggestionsDeDepot(cfg, repo) {
  const dir = git.cloneDirFor(cfg, repo);
  const out = [];
  const lireJson = (nom) => {
    try { return JSON.parse(fs.readFileSync(path.join(dir, nom), 'utf8')); } catch { return null; }
  };
  const pkg = lireJson('package.json');
  for (const nom of Object.keys((pkg && pkg.scripts) || {})) out.push({ command: `npm run ${nom}`, source: 'package.json' });
  if (pkg) out.unshift({ command: 'npm ci', source: 'package.json' });
  const comp = lireJson('composer.json');
  for (const nom of Object.keys((comp && comp.scripts) || {})) out.push({ command: `composer run ${nom}`, source: 'composer.json' });
  if (comp) out.unshift({ command: 'composer install --no-interaction', source: 'composer.json' });
  const mk = docker.makefileFor(dir);
  for (const cible of (mk && mk.targets) || []) out.push({ command: `make ${cible.name}`, source: 'Makefile', desc: cible.desc || '' });
  return out;
}

app.get('/api/verifiers/command-suggestions', wrap((req, res) => {
  const ids = String(req.query.repo_ids || '').split(',').map((x) => Number(x)).filter(Boolean);
  const cfg = getConfig();
  const vus = new Map();
  for (const id of ids) {
    const repo = db.prepare('SELECT * FROM repo WHERE id = ?').get(id);
    if (!repo) continue;
    for (const sug of suggestionsDeDepot(cfg, repo)) {
      /* La même commande proposée par deux dépôts n'est qu'une suggestion : on garde la
         première et on cite les dépôts qui la portent, pour qu'on sache si elle est commune. */
      const cle = sug.command;
      if (!vus.has(cle)) vus.set(cle, { ...sug, repos: [] });
      vus.get(cle).repos.push(repo.project);
    }
  }
  res.json({ suggestions: [...vus.values()] });
}));

app.get('/api/verifications', wrap((req, res) => {
  const mrId = Number(req.query.mr_id) || null;
  const brut = db.prepare('SELECT * FROM verification ORDER BY id DESC LIMIT 200').all();
  const parQui = auteurs('verification', brut);
  const lignes = brut
    .map((v) => ({ ...detailVerification(v), author: parQui.get(v.id) || null }))
    .filter((v) => !mrId || v.targets.some((c) => c.mr_id === mrId));
  res.json({ verifications: mrId ? lignes.slice(0, 1) : lignes });
}));

/* ---------- Lots (§8) ------------------------------------------------------
   Un lot = des merge requests qui ne valent qu'ensemble. Le regrouper explicitement plutôt
   que de le redécouvrir à chaque fois donne un objet nommé, vérifiable d'un bouton. */

function lotAvecMembres(id) {
  const l = db.prepare('SELECT * FROM lot WHERE id = ?').get(id);
  if (!l) return null;
  const membres = db.prepare('SELECT * FROM lot_member WHERE lot_id = ? ORDER BY ref_id').all(id)
    .map((m) => {
      if (m.kind !== 'mr') return { ...m };
      const mr = mrById(m.ref_id);
      return { ...m, iid: mr && mr.iid, title: mr && mr.title, project: mr && mr.project, repo_id: mr && mr.repo_id };
    });
  const derniere = db.prepare('SELECT * FROM verification WHERE lot_id = ? ORDER BY id DESC LIMIT 1').get(id);
  return { ...l, members: membres, last_verification: derniere ? detailVerification(derniere) : null };
}

/* Un même dépôt deux fois dans un lot rendrait le verdict ininterprétable : on ne saurait pas
   quel code a été testé. Refusé à la création ET revalidé au lancement (§8). */
function refuserDepotEnDouble(mrIds) {
  const vus = new Set();
  for (const id of mrIds) {
    const mr = mrById(Number(id));
    if (!mr) throw new Error(t('err.mr-introuvable'));
    if (vus.has(mr.repo_id)) throw new Error(t('err.verify.repo-twice'));
    vus.add(mr.repo_id);
  }
}

app.get('/api/lots', wrap((req, res) => {
  res.json(db.prepare('SELECT id FROM lot ORDER BY id DESC').all().map((l) => lotAvecMembres(l.id)));
}));

app.post('/api/lots', wrap((req, res) => {
  const name = String((req.body && req.body.name) || '').trim();
  if (!name) throw new Error(t('err.lot.name-required'));
  /* A/Réglages 3 — LE DEMI-ÉTAT DES LOTS DE SESSION, tranché. L'API acceptait `kind:'session'`,
     l'écran ne l'envoyait jamais, et la vérification le refusait : un lot ainsi créé n'aurait
     rien pu faire. Accepter une valeur dont rien ne sait quoi faire n'est pas de la souplesse,
     c'est une promesse fausse. On refuse donc à l'entrée, en le disant. */
  if ((req.body && req.body.kind) === 'session') throw new Error(t('err.lot.session-kind'));
  const kind = 'mr';
  const refs = [...new Set(((req.body && req.body.members) || []).map(Number).filter(Boolean))];
  if (!refs.length) throw new Error(t('err.lot.empty'));
  if (kind === 'mr') refuserDepotEnDouble(refs);
  const info = db.prepare('INSERT INTO lot (name, kind, created_at) VALUES (?,?,?)')
    .run(name, kind, new Date().toISOString());
  const ins = db.prepare('INSERT OR IGNORE INTO lot_member (lot_id, kind, ref_id) VALUES (?,?,?)');
  for (const r of refs) ins.run(info.lastInsertRowid, 'mr', r);   // un lot ne groupe que des MR
  res.json(lotAvecMembres(info.lastInsertRowid));
}));

app.delete('/api/lots/:id', wrap((req, res) => {
  db.prepare('DELETE FROM lot WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
}));

// Vérifier plusieurs MR d'un coup, sans passer par un lot enregistré.
app.post('/api/verify/mrs', wrap((req, res) => {
  const ids = ((req.body && req.body.mr_ids) || []).map(Number).filter(Boolean);
  if (!ids.length) throw new Error(t('err.lot.empty'));
  const cibles = ciblesDepuisMrs(ids);
  const verifier = verifierPour(cibles, req.body && req.body.verifier_id);
  res.json(creerVerification({ verifier, cibles: appliquerModes(verifier, cibles) }));
}));

/* ---------- Vérifier une BRANCHE, sans merge request ----------
   Au retour de congés, plusieurs MR ont été mergées : la question n'est plus « qu'est-ce que
   cette branche casse ? » mais « est-ce que `develop` est encore vert ? ». C'est le MÊME objet
   avec une cible différente — une cible porte déjà `repo_id`, `branch`, `head_sha` et un
   `mr_id` qui peut être nul. Aucun changement de schéma.

   DEUX CHOSES CHANGENT DE SENS, et elles se décident ici :
   · le double run causal s'éteint (`run_base` forcé à 0) : sur une branche d'intégration, la
     branche EST la base — le laisser actif ferait tourner la batterie deux fois pour comparer
     `develop` à `develop` ;
   · l'imputabilité disparaît : rien n'est « cassé par cette branche », ce qui est rouge est
     rouge. L'affichage et le commentaire le disent autrement (voir `blocsCommentaire`). */
async function ciblesDepuisBranches(entrees) {
  const cfg = getConfig();
  const cibles = [];
  const vus = new Set();
  for (const e of entrees) {
    const repo = db.prepare('SELECT * FROM repo WHERE id = ?').get(Number(e.repo_id));
    if (!repo) throw new Error(t('err.depot-introuvable'));
    if (vus.has(repo.id)) throw new Error(t('err.verify.repo-twice'));
    vus.add(repo.id);
    const branche = String(e.branch || '').trim();
    if (!branche) throw new Error(t('err.verify.branch-required', { project: repo.project }));
    /* Le SHA est résolu MAINTENANT, dans le clone : un verdict est attaché à des commits, pas
       à un nom de branche qui bougera. C'est aussi ce qui rend la péremption possible. */
    const cwd = await git.ensureRepo(cfg, repo, () => {});
    if (!await git.refExists(cwd, `origin/${branche}`)) {
      throw new Error(t('err.verify.branch-unknown', { branch: branche, project: repo.project }));
    }
    const { stdout } = await git.run('git', ['rev-parse', `origin/${branche}`], { cwd });
    cibles.push({
      repo_id: repo.id, mr_id: null, head_sha: stdout.trim(),
      base_sha: null, branch: branche, mode: 'worktree',
    });
  }
  return cibles;
}

app.post('/api/verify/branches', wrap(async (req, res) => {
  const entrees = (req.body && req.body.targets) || [];
  if (!entrees.length) throw new Error(t('err.verify.branch-required', { project: '' }));
  const cibles = await ciblesDepuisBranches(entrees);
  const verifier = verifierPour(cibles, req.body && req.body.verifier_id);
  /* Le run base s'éteint tout seul à l'exécution : `executerVerification` le déduit de
     l'absence de merge request dans les cibles. Rien à forcer ici, donc rien à désynchroniser. */
  res.json(creerVerification({ verifier, cibles: appliquerModes(verifier, cibles) }));
}));

app.post('/api/lots/:id/verify', wrap((req, res) => {
  const lot = lotAvecMembres(Number(req.params.id));
  if (!lot) throw new Error(t('err.lot.not-found'));
  const ids = lot.members.filter((m) => m.kind === 'mr').map((m) => m.ref_id);
  if (!ids.length) throw new Error(t('err.lot.empty'));
  const cibles = ciblesDepuisMrs(ids);
  const verifier = verifierPour(cibles, req.body && req.body.verifier_id);
  res.json(creerVerification({ verifier, cibles: appliquerModes(verifier, cibles), lotId: lot.id }));
}));

/* ---------- « Corriger (session IA) » (§9) ---------------------------------
   UNE session multi-dépôts couvrant TOUS les dépôts du lot — pas seulement les « fautifs ».
   L'imputabilité d'un échec d'intégration est indécidable a priori : le test qui casse est
   souvent dans un dépôt, la cause dans un autre. L'agent voit tout le lot et décide. */
/* LE PROMPT DE CORRECTION D'UNE VÉRIFICATION ÉCHOUÉE.
 *
 * Il porte les FAITS : quels tests, quels messages, quels commits. Sans eux l'agent repart de
 * zéro et redécouvre au prix d'un aller-retour ce que la vérification sait déjà.
 *
 * Extrait en fonction parce que deux boutons l'emploient : « Corriger (session IA) », qui ouvre
 * une session neuve, et « Reprendre le rapport de vérif », qui remplit un champ de suivi pour
 * que l'agent reprenne SON fil. Deux copies auraient fini par diverger, et c'est celle qu'on
 * oublie qui donnerait un prompt appauvri. */
function promptCorrectionVerif(d, v) {
  const lignes = (d.imputable || []).map((f) => {
    const bouts = [`- ${f.test}`];
    if (f.message) bouts.push(`  ${f.message}`);
    if (f.log_excerpt) bouts.push(`  ${String(f.log_excerpt).split('\n').slice(0, 12).join('\n  ')}`);
    return bouts.join('\n');
  });
  const shas = d.targets.map((c) => `- ${c.branch} @ ${String(c.head_sha).slice(0, 8)}`);
  return [
    `La vérification « ${d.verifier_name} » a échoué${v && v.lot_id ? ' sur le lot' : ''}.`,
    '',
    'Tests cassés par ces branches (et par elles seules — la base passait ou les échouait déjà) :',
    lignes.length ? lignes.join('\n') : '- (le vérificateur n’a pas détaillé les échecs)',
    '',
    'Commits testés :',
    shas.join('\n'),
    '',
    'Corrige la cause dans le ou les dépôts concernés. Ne touche que ce qui est nécessaire.',
    'Commit et push sur les branches existantes : les merge requests seront mises à jour en place.',
  ].join('\n');
}

/* LE MESSAGE DE COMMIT NOMME CE QUI ÉTAIT CASSÉ. Il disait « fix: <vérificateur> — tests
   cassés » : relu six mois plus tard dans `git log`, il ne dit ni ce qui échouait, ni pourquoi
   ce commit existe — et le nom du vérificateur (« Batterie fonctionnelle ») n'apprend rien à
   qui n'est pas devant Mergerie. Les tests imputables sont là, on les nomme : un pour un, deux
   avec « et 1 autre », au-delà on compte. Le message reste court — c'est un sujet de commit. */
function messageCorrectionVerif(d) {
  const noms = (d.imputable || []).map((f) => String(f.test || '').trim()).filter(Boolean);
  if (!noms.length) return `fix: ${d.verifier_name} — tests cassés`;
  const premier = noms[0].length > 60 ? `${noms[0].slice(0, 57)}…` : noms[0];
  if (noms.length === 1) return `fix: ${premier}`;
  if (noms.length === 2) return `fix: ${premier} (+1 autre test)`;
  return `fix: ${premier} (+${noms.length - 1} autres tests)`;
}

app.post('/api/verifications/:id/fix', wrap((req, res) => {
  const v = db.prepare('SELECT * FROM verification WHERE id = ?').get(Number(req.params.id));
  if (!v) throw new Error(t('err.verify.not-found'));
  const d = detailVerification(v);
  if (d.verdict !== 'verified_fail') throw new Error(t('err.verify.fix-only-on-fail'));

  const cibles = d.targets.map((c) => ({ repo_id: c.repo_id, branch: c.branch, base_branch: null }));
  const list = normalizeTargets(cibles, 'code');

  const prompt = promptCorrectionVerif(d, v);

  const now = new Date().toISOString();
  const info = db.prepare(`INSERT INTO task (repo_id, kind, prompt, branch, base_branch, commit_message,
    auto_push, ask_questions, status, created_at, updated_at)
    VALUES (?, 'code', ?, ?, NULL, ?, 1, 0, 'new', ?, ?)`).run(
    list[0].repo_id, prompt, list[0].branch || '',
    messageCorrectionVerif(d), now, now);
  const taskId = info.lastInsertRowid;
  insertTargets(taskId, list, null);
  res.json({ ...taskById(taskId), targets: taskTargets(taskId) });
}));

app.post('/api/rules', wrap((req, res) => {
  const branch_match = (req.body && req.body.branch_match || '').trim();
  const path_match = (req.body && req.body.path_match || '').trim();
  const label = (req.body && req.body.label || '').trim();
  const content = (req.body && req.body.content || '').trim();
  // Une règle doit avoir au moins un déclencheur (branche OU chemin) et un contenu.
  if ((!branch_match && !path_match) || !content) throw new Error(t('err.rule-needs-trigger'));
  // A/Réglages 2 : 0 ou absent = « tous les dépôts », c'est-à-dire le comportement d'avant.
  const repoId = Number((req.body && req.body.repo_id) || 0) || null;
  res.json(store.ecrire('review_rule', () => db.prepare(
    `INSERT INTO review_rule (branch_match, path_match, label, content, repo_id, enabled, created_at)
     VALUES (?, ?, ?, ?, ?, 1, ?)`,
  ).run(branch_match, path_match, label, content, repoId, new Date().toISOString()).lastInsertRowid));
}));

app.put('/api/rules/:id', wrap((req, res) => {
  const cur = db.prepare('SELECT * FROM review_rule WHERE id = ?').get(Number(req.params.id));
  if (!cur) throw new Error(t('err.regle-introuvable'));
  const { branch_match, path_match, label, content, enabled } = req.body || {};
  res.json(store.ecrire('review_rule', () => {
    db.prepare('UPDATE review_rule SET branch_match = ?, path_match = ?, label = ?, content = ?, repo_id = ?, enabled = ? WHERE id = ?').run(
      branch_match != null ? String(branch_match).trim() : cur.branch_match,
      path_match != null ? String(path_match).trim() : (cur.path_match || ''),
      label != null ? String(label).trim() : (cur.label || ''),
      content != null ? String(content).trim() : cur.content,
      (req.body || {}).repo_id === undefined ? cur.repo_id : (Number(req.body.repo_id) || null),
      enabled == null ? cur.enabled : (enabled ? 1 : 0),
      cur.id,
    );
    return cur.id;
  }));
}));

app.delete('/api/rules/:id', wrap((req, res) => {
  store.supprimer('review_rule', Number(req.params.id));
  res.json({ ok: true });
}));

/* QUI SUIS-JE ? L'identité git de ce poste — pas de compte Mergerie, pas de mot de passe : le
   jour où une équipe partage un dépôt, l'auteur d'une review est celui qui a commité le fichier,
   et git le sait déjà. Inventer une identité à côté, ce serait deux vérités à tenir alignées
   pour ne rien gagner. `runners` liste les exécutants déjà désignés, pour que le formulaire
   d'agent propose une liste plutôt qu'une saisie libre. */
/* `/api/whoami`, ET NON `/api/me` : une route de ce nom existait déjà — l'identité sur les
   forges, qui sert au filtre « mes merge requests / les autres ». Express sert la PREMIÈRE
   déclarée ; celle-ci masquait donc l'autre, et le filtre avait disparu sans que rien ne casse.
   Deux routes d'un même nom, c'est une panne muette qui attend son écran. */
app.get('/api/whoami', wrap((req, res) => {
  const moi = identite.identite();
  const connus = db.prepare("SELECT DISTINCT runner FROM agent WHERE runner IS NOT NULL AND runner <> ''")
    .all().map((r) => r.runner);
  res.json({
    ...moi,
    runners: [...new Set([...(moi.ok ? [moi.name] : []), ...connus])].sort(),
    partage: Boolean(String(getConfig().data_repo_url || '').trim()),
  });
}));

/* ---------- Données partagées : le dépôt git qui fait foi ----------
   Quatre routes, et rien de plus : dire où l'on en est, rattacher ce poste, forcer un tour,
   et trancher un conflit. L'utilisateur ne tape jamais une commande git pour ses données. */

app.get('/api/data-sync', wrap((req, res) => {
  res.json({ ...datasync.statut(), conflits: datasync.conflitsGardes() });
}));

/* Cloner, ou INITIALISER depuis ce qu'on a déjà : c'est le même geste côté utilisateur, et
   c'est voulu — la bascule d'une équipe consiste, pour le poste qui a l'historique, à le
   pousser. `datasync` regarde si le distant a du contenu et choisit. */
/* CE QUI VA PARTIR, ET CE QUI VA RESTER — avant de cliquer, pas après.
 *
 * « Cloner / rattacher » est le geste qui ouvre son travail à d'autres : il mérite qu'on dise ce
 * qu'il emporte. On compte donc, table par table, ce que l'export écrirait — sans rien écrire —
 * et on dit aussi ce qui RESTE ici, parce que c'est là que se trouvent les surprises : les
 * sessions et les todos sont privées par défaut, et quelqu'un qui croit tout partager doit
 * l'apprendre maintenant plutôt qu'en cherchant sa session chez un collègue.
 * Le sens du geste (initialiser un dépôt vide / rejoindre un dépôt pourvu) vient d'un
 * `ls-remote` : pas de clone, pas d'écriture, rien d'irréversible avant le « oui ». */
const GROUPES_APERCU = {
  repo: 'repos', mr: 'mrs', review: 'reviews', review_version: 'reviews', finding: 'reviews',
  convergence_run: 'reviews', review_rule: 'rules', verifier: 'verifiers', verification: 'verifiers',
  agent: 'agents', agent_knowledge: 'agents', task: 'sessions', local_task: 'sessions',
  question: 'sessions', agent_pass: 'sessions', piece_jointe: 'sessions',
  note_page: 'notes', todo: 'todos', lot: 'lots', config: 'settings',
};

/* UN POST, ET NON UN GET : l'aperçu lance `git ls-remote` et `git fetch` vers une adresse
   REÇUE. En GET, n'importe quelle page ouverte dans le navigateur pouvait faire joindre à ce
   poste l'adresse de son choix ; en POST, la requête doit venir de l'application. Et l'adresse
   est de toute façon filtrée par schéma (`datasync.adresseAdmise`). */
app.post('/api/data-sync/preview', wrap(async (req, res) => {
  const recue = String((req.body || {}).url || '').trim();
  if (recue && !datasync.adresseAdmise(recue)) throw new Error(t('err.datasync.url-scheme'));
  const url = recue || getConfig().data_repo_url;
  const partants = {};
  const retenus = {};
  for (const table of store.tablesFichier()) {
    const groupe = GROUPES_APERCU[table] || table;
    const rows = db.prepare(`SELECT * FROM ${table}`).all();
    const ctx = store.contexte();
    let part = 0;
    for (const r of rows) if (store.partageable(table, r, ctx)) part += 1;
    partants[groupe] = (partants[groupe] || 0) + part;
    /* Ce qui reste n'a de sens que là où l'on CHOISIT : ailleurs, tout part, et annoncer
       « 0 retenu » ajouterait du bruit à un écran qui doit se lire d'un coup d'œil. */
    if (registre.pour(table) && registre.pour(table).partageable) {
      retenus[groupe] = (retenus[groupe] || 0) + (rows.length - part);
    }
  }
  const pourvu = await datasync.distantPourvu(url);
  /* CE QUE L'ENVOI FERAIT, fichier par fichier : ajoutés, modifiés, inchangés — et ce qu'il
     ne touche pas. `supprimes` vaut zéro et ce n'est pas une estimation : l'export écrit, il
     ne supprime jamais.
     `apercuExport()` compare au RÉPERTOIRE DE TRAVAIL, qui porte déjà les fichiers que ce poste
     a écrits sans destinataire. Devant un dépôt VIDE, ces fichiers-là sont « inchangés » ici et
     pourtant ils partiront tous : annoncer « 0 ajouté, 12 inchangés » avant d'initialiser un
     dépôt nu reviendrait à dire que rien ne part. Face à un dépôt vide, tout est nouveau. */
  const ecrit = store.apercuExport();
  const ecriture = pourvu === false
    ? { nouveaux: ecrit.nouveaux + ecrit.modifies + ecrit.identiques, modifies: 0, identiques: 0, intacts: 0, supprimes: 0 }
    : ecrit;
  res.json({
    url,
    pourvu,   // true = on rejoint, false = on initialise, null = injoignable
    /* CE QUE LE DÉPÔT PORTE DÉJÀ : la réponse à « est-ce que je vais écraser le travail des
       autres ? ». Non — on lit d'abord, on n'écrit qu'ensuite, et on ne supprime jamais — mais
       le dire avec un nombre vaut mieux que le promettre. */
    distants: await datasync.compterDistant(url),
    ecriture,
    partants: Object.entries(partants).filter(([, n]) => n).map(([cle, n]) => ({ cle, n })),
    retenus: Object.entries(retenus).filter(([, n]) => n).map(([cle, n]) => ({ cle, n })),
  });
}));

app.post('/api/data-sync/attach', wrap(async (req, res) => {
  const url = String((req.body && req.body.url) || '').trim();
  if (url) updateConfig({ data_repo_url: url });
  const r = await datasync.rattacher({ url: url || undefined });
  datasync.demarrer();
  res.json({ ok: true, ...r, statut: datasync.statut() });
}));

/* TOUT RÉ-ENVOYER — le geste qu'il manquait.
 *
 * « Synchroniser » n'envoie que CE QUI A CHANGÉ : c'est la file des écritures qui décide, et
 * elle est vide quand rien n'a bougé. Après un dépôt vidé à la main, le bouton ne remettait donc
 * rien, et le seul chemin était « Cloner / rattacher » — dont le nom ne dit pas qu'il ré-exporte.
 * On nomme donc le geste : réécrire TOUS les fichiers de ce qui se partage, puis commiter et
 * pousser. Idempotent : sur un dépôt intact, les fichiers réécrits sont identiques à l'octet
 * près, git ne voit rien, et il ne se passe rien. */
app.post('/api/data-sync/reexport', wrap(async (req, res) => {
  if (!datasync.estConfigure()) throw new Error(t('err.data-sync.not-configured'));
  /* ON PASSE PAR LE RATTACHEMENT, et ce n'est pas un détour : un dépôt vidé à la main l'a
     souvent été par une branche orpheline poussée en force. L'historique local et le distant
     n'ont alors plus d'ancêtre commun — un simple commit suivi d'un push serait refusé, et
     `rebase` aussi. Le rattachement, lui, repose le local SUR le distant, lit ce qu'il porte,
     puis réécrit tout. C'est exactement ce qu'on veut dire par « tout ré-envoyer », et le
     nommer évite d'avoir à deviner que « Cloner / rattacher » le faisait déjà. */
  const r = await datasync.rattacher({});
  const bilan = await datasync.tour();
  res.json({ ok: true, compte: r.compte || {}, mode: r.mode, bilan, statut: datasync.statut() });
}));

app.post('/api/data-sync/now', wrap(async (req, res) => {
  await datasync.commiter();
  const bilan = await datasync.tour();
  res.json({ ok: true, bilan, statut: datasync.statut(), conflits: datasync.conflitsGardes() });
}));

/* Trancher un conflit. `keep: 'mine'` réécrit sa version et la repousse ; `keep: 'theirs'`
   oublie simplement la version gardée. Dans les deux cas rien n'est perdu tant qu'on n'a pas
   choisi — c'est tout l'intérêt de garder la version écrasée plutôt que de la jeter. */
app.post('/api/data-sync/conflicts/resolve', wrap((req, res) => {
  const fichier = String((req.body && req.body.file) || '').trim();
  const garder = (req.body && req.body.keep) === 'mine' ? 'mine' : 'theirs';
  if (!fichier) throw new Error(t('err.data-sync.file-required'));
  const ok = garder === 'mine' ? datasync.reprendreVersion(fichier) : datasync.oublierConflit(fichier);
  if (!ok) throw new Error(t('err.data-sync.conflict-unknown'));
  res.json({ ok: true, conflits: datasync.conflitsGardes() });
}));

/* ---------- Découverte + jobs ---------- */

/* PLAFOND PAR TOUR DE DÉCOUVERTE. Un lundi matin, la découverte peut ramener quinze merge
   requests ; quinze batteries fonctionnelles saturent la machine pour une heure et bloquent la
   file partagée avec les reviews. Les MR non vérifiées gardent leur bouton « Vérifier ».

   Le bon chiffre dépend de la machine et de la durée des suites : il se RÈGLE (Réglages →
   Merge Request), et `0` veut dire « sans limite » — un choix qui doit pouvoir s'assumer. */
const plafondVerifAuto = () => {
  const v = Number(getConfig().verif_auto_max);
  return Number.isFinite(v) && v >= 0 ? v : 5;
};

/* Les vérifications automatiques d'une liste de MR NOUVELLES. Un seul chemin : la route de
   découverte, le rafraîchissement automatique et l'ajout unitaire passent tous par ici — deux
   copies dériveraient, et c'est celle qu'on oublie qui ne vérifierait rien.

   Best-effort de bout en bout : un vérificateur qui refuse (dépôt déjà en cours de
   vérification, MR sans SHA) ne doit pas faire échouer la découverte, dont le travail — trouver
   les MR — est déjà fait. */
/* A28 — LE PRÉ-VOL DOCKER VAUT AUSSI POUR LES VÉRIFICATIONS AUTOMATIQUES.
 *
 * Il n'existait que dans la modale manuelle : on voyait « la base est arrêtée » avant de
 * cliquer. Une vérification AUTOMATIQUE, elle, partait quand même — et mourait en trois
 * secondes sur un `ECONNREFUSED`, verdict `verified_fail` imputé à la branche. On accusait donc
 * une merge request d'avoir cassé des tests que personne n'avait fait tourner.
 *
 * On regarde donc, avant de lancer, l'état des services compose du répertoire « in place ».
 * Best-effort et SILENCIEUX EN CAS DE DOUTE : Docker absent, projet non trouvé, appel en
 * erreur → on lance, comme avant. On ne renonce que sur une certitude : des services déclarés
 * et arrêtés. Le journal le dit, sinon la vérification manquerait sans explication. */
async function servicesPretsPour(verifier, onLog = () => {}) {
  const dirs = db.prepare(`SELECT DISTINCT workdir FROM verifier_repo
    WHERE verifier_id = ? AND mode = 'in_place' AND workdir IS NOT NULL AND workdir <> ''`).all(verifier.id);
  if (!dirs.length) return true;
  for (const { workdir } of dirs) {
    try {
      const roots = db.prepare('SELECT * FROM local_root').all();
      const projets = await docker.composeProjects(roots);
      const p = projets.find((x) => x.dir === workdir);
      if (!p || !(p.services || []).length) continue;      // pas de compose ici : rien à dire
      const arretes = p.services.filter((sv) => !sv.container || sv.container.state !== 'running');
      if (!arretes.length) continue;
      onLog(t('log.verify.services-down', {
        verifier: verifier.name, project: p.name,
        list: arretes.map((sv) => sv.name).join(', '),
      }));
      return false;
    } catch { /* Docker injoignable : on ne bloque pas sur une incertitude */ }
  }
  return true;
}

async function lancerVerificationsAuto(mrIds, { colonne = 'auto_on_mr' } = {}) {
  const bilan = { lancees: 0, ignorees: 0, plafonnees: 0, services_arretes: 0 };
  if (!Array.isArray(mrIds) || !mrIds.length) return bilan;
  const candidates = await mrsAMoi('vérification automatique', mrIds);
  if (!candidates.length) return bilan;
  /* CE QUI N'EST PAS EXÉCUTÉ SANS UN CLIC. Une vérification lance les commandes du projet sur le
     code de la branche : c'est le code de son auteur qui tourne ici.
       — un BROUILLON n'est pas prêt (même règle que la review automatique) ;
       — un FORK porte le code de quelqu'un qui n'a pas accès au projet ;
       — et, sauf choix explicite (`verif_auto_authors = 'all'`), seules MES merge requests —
         reconnues par l'identifiant de forge, pas par le nom affiché.
     Tout ce qui est écarté garde son bouton « Vérifier » : exécuter reste possible, en le voulant. */
  const tousAuteurs = getConfig().verif_auto_authors === 'all';
  const miennes = [];
  for (const id of candidates) {
    const m = db.prepare(`SELECT mr.author, mr.author_username, mr.is_draft, mr.is_fork, repo.forge
      FROM mr JOIN repo ON repo.id = mr.repo_id WHERE mr.id = ?`).get(Number(id));
    if (!m) continue;
    if (m.is_draft) { bilan.ignorees += 1; continue; }
    if (m.is_fork) { bilan.ignorees += 1; console.log(`[verif-auto] MR ${id} : vient d'un fork, pas de vérification automatique`); continue; }
    // eslint-disable-next-line no-await-in-loop
    if (!tousAuteurs && await mrDeMoi(m) !== true) { bilan.ignorees += 1; continue; }
    miennes.push(id);
  }
  if (!miennes.length) return bilan;
  const plafond = plafondVerifAuto();
  /* Un vérificateur hérité de la famille « script » ne part pas tout seul : `creerVerification`
     le refuserait, et une exception par merge request découverte transformerait la découverte en
     échec. On l'écarte ici, en le disant une fois dans le journal. */
  const tous = db.prepare(`SELECT * FROM verifier WHERE ${colonne === 'auto_on_stale' ? 'auto_on_stale' : 'auto_on_mr'} = 1`).all();
  const autos = tous.filter((v) => v.kind === 'commands');
  const herites = tous.length - autos.length;
  if (herites) console.log(`[verif-auto] ${herites} vérificateur(s) « script » ignoré(s) : famille retirée, à réécrire en liste de commandes`);
  if (!autos.length) return bilan;

  for (const mrId of miennes) {
    const mr = mrById(Number(mrId));
    if (!mr) continue;
    // Ceux qui couvrent CE dépôt. Plusieurs peuvent le couvrir : ils partent tous.
    const couvrants = autos.filter((v) => db.prepare('SELECT 1 FROM verifier_repo WHERE verifier_id = ? AND repo_id = ?')
      .get(v.id, mr.repo_id));
    for (const verifier of couvrants) {
      if (plafond && bilan.lancees >= plafond) { bilan.plafonnees += 1; continue; }
      /* PRÉ-VOL : des services arrêtés produiraient un rouge imputé à cette branche. */
      // eslint-disable-next-line no-await-in-loop
      if (!await servicesPretsPour(verifier, (m) => console.log(`[verif-auto] ${m}`))) {
        bilan.services_arretes += 1;
        continue;
      }
      try {
        const cibles = appliquerModes(verifier, ciblesDepuisMrs([mr.id]));
        creerVerification({ verifier, cibles, enFile: true, automatique: true });
        bilan.lancees += 1;
      } catch (e) {
        // La raison est dans le journal du serveur : une découverte ne doit pas échouer ici.
        bilan.ignorees += 1;
        console.log(`[verif-auto] MR !${mr.iid} · ${verifier.name} : ${e.message}`);
      }
    }
  }
  /* UN PLAFOND SILENCIEUX SE LIT COMME « TOUT A ÉTÉ VÉRIFIÉ ». On dit donc ce qui n'est pas
     parti, dans le journal du serveur comme dans la réponse de la découverte. */
  if (bilan.plafonnees) {
    console.log(`[verif-auto] plafond atteint (${plafond}) : ${bilan.plafonnees} vérification(s) non lancée(s) — bouton « Vérifier » sur les MR concernées`);
    /* B12 — ET AILLEURS QUE DANS LE JOURNAL DU SERVEUR. Un plafond silencieux se lit comme
       « tout a été vérifié » : la console n'est pas un écran que quelqu'un regarde, et les
       merge requests laissées de côté attendent un clic que personne ne sait devoir donner. */
    notify.push('cap_reached', { what: 'verify', n: bilan.plafonnees, cap: plafond });
  }
  return bilan;
}

/* LA REVIEW LANCÉE TOUTE SEULE À L'ARRIVÉE D'UNE MERGE REQUEST.
 *
 * Décochée par défaut, et PLAFONNÉE même une fois cochée — contrairement au bouton « Reviewer
 * les N MR », que l'on presse en connaissance de cause. Ici personne ne regarde : la découverte
 * tourne toute seule, et la PREMIÈRE d'une installation neuve ramène d'un coup toutes les MR
 * ouvertes du parc. Sans plafond, cocher la case reviendrait à signer un chèque en blanc en
 * appels IA. Les MR au-delà du plafond gardent leur bouton « Reviewer ».
 *
 * Un SEUL job pour le lot, comme le bouton « Reviewer les N MR » : N jobs pour N merge requests
 * satureraient la file et rendraient le journal illisible. */
const plafondReviewAuto = () => {
  const v = Number(getConfig().review_auto_max);
  return Number.isFinite(v) && v >= 0 ? v : 5;
};

/* Le lot, borné et journalisé. Les deux automatismes — à l'arrivée, et quand le rapport se
   périme — passent par ici : deux copies auraient fini par ne plus plafonner pareil, et c'est
   celle qu'on oublie qui dépense. Chacun garde en revanche son PROPRE budget : une poussée
   massive sur des merge requests connues ne doit pas manger celui des nouvelles, qui est le
   cas d'usage principal (même parti pris que les vérifications automatiques). */
function lancerLotReview(mrIds, { kind, opts = {}, etiquette }) {
  const bilan = { lancees: 0, plafonnees: 0 };
  if (!Array.isArray(mrIds) || !mrIds.length) return bilan;
  const plafond = plafondReviewAuto();
  const retenues = plafond ? mrIds.slice(0, plafond) : mrIds;
  bilan.plafonnees = mrIds.length - retenues.length;
  try {
    jobs.startJob(kind, retenues, opts);
    bilan.lancees = retenues.length;
  } catch (e) {
    /* Best-effort, comme pour les vérifications : la découverte a fait son travail — trouver
       les MR —, elle ne doit pas échouer parce que la file a refusé le lot. */
    bilan.lancees = 0;
    console.log(`[${etiquette}] lot refusé : ${e.message}`);
  }
  /* UN PLAFOND SILENCIEUX SE LIT COMME « TOUT A ÉTÉ REVIEWÉ ». */
  if (bilan.plafonnees) {
    console.log(`[${etiquette}] plafond atteint (${plafond}) : ${bilan.plafonnees} merge request(s) laissée(s) de côté — bouton « Reviewer » sur les MR concernées`);
    notify.push('cap_reached', { what: 'review', n: bilan.plafonnees, cap: plafond });
  }
  return bilan;
}

/* UNE POLITIQUE AUTOMATIQUE A UN EXÉCUTANT — comme un agent planifié.
 *
 * `auto_review_new`, `auto_rereview_stale` et les cases `auto_on_*` d'un vérificateur sont des
 * réglages d'ÉQUIPE : ils voyagent, et chaque instance a sa propre file de jobs et sa propre
 * découverte. Deux postes allumés, et chaque merge request nouvelle recevait DEUX reviews — deux
 * versions, deux facturations — et, si la publication automatique est cochée, deux commentaires
 * sur la forge. Le spec avait vu le problème pour les agents planifiés et pas pour les
 * politiques, qui sont pourtant le même cas.
 * En mono-poste, rien ne change : sans dépôt de données, la question ne se pose pas. */
/* « L'AUTEUR » N'EST PAS UNE MACHINE. Désigner un poste répond à « qui paie les appels d'IA
   de toute l'équipe ? » par un nom ; y répondre par CHACUN POUR SES MERGE REQUESTS est l'autre
   réponse raisonnable, et souvent la plus juste — l'abonnement de chacun sert son propre
   travail, et personne n'attend que l'exécutant désigné soit allumé. La valeur est une sentinelle,
   pas un nom : un poste ne peut pas s'appeler comme ça (`identite.nom()` vient de `git config
   user.name`, qui ne contient pas d'arobase en tête par convention). */
const AUTEUR_AUTO = '@auteur';

function executantAuto() {
  if (!datasync.estConfigure()) return { mode: 'tous', qui: null };   // mono-poste : rien à répartir
  const qui = String(getConfig().auto_runner || '').trim();
  if (!qui) return { mode: 'personne', qui: null };                   // personne désigné : personne n'agit
  if (qui === AUTEUR_AUTO) return { mode: 'auteur', qui: AUTEUR_AUTO };
  return { mode: qui === (identite.nom() || '') ? 'tous' : 'personne', qui };
}
let dernierRefusAuto = 0;
/* On le DIT, mais pas cent fois : une ligne par minute suffit à comprendre pourquoi rien ne
   part, sans noyer le journal à chaque découverte. */
function direRefusAuto(message) {
  if (Date.now() - dernierRefusAuto <= 60000) return;
  dernierRefusAuto = Date.now();
  console.log(`[auto] ${message}`);
}

/* EST-ELLE DE MOI ? La forge stocke tantôt le pseudo, tantôt le nom affiché — GitLab pose
   `author.name`, GitHub le `login` — et une installation peut suivre les deux forges. On
   reconnaît donc les deux formes, comme le filtre « mes merge requests » de l'écran. Le compte
   vient du JETON de la forge de cette merge request : c'est la seule définition de « moi » qui
   ne dépende d'aucune convention de nommage. */
async function mrDeMoi(mr) {
  const auteur = String(mr.author || '').trim().toLowerCase();
  const pseudo = String(mr.author_username || '').trim().toLowerCase();
  if (!auteur && !pseudo) return false;
  const moi = await forgeIdentite(forge.forgeOf(mr));
  /* L'IDENTIFIANT D'ABORD : le nom affiché se change en deux clics, et « Alice Martin » chez un
     inconnu suffisait à passer pour Alice. Le nom ne sert que de repli, pour une MR découverte
     avant que l'identifiant ne soit relevé. */
  if (pseudo && moi.username) return pseudo === String(moi.username).trim().toLowerCase();
  const noms = [moi.username, moi.name].filter(Boolean).map((v) => String(v).trim().toLowerCase());
  if (!noms.length) return null;      // compte inconnu : on ne peut pas trancher (≠ « pas de moi »)
  return noms.includes(auteur);
}

/* LES MERGE REQUESTS SUR LESQUELLES CE POSTE DOIT AGIR. Remplace le « oui/non » global : en mode
   « l'auteur », la question n'a de réponse que merge request par merge request. */
async function mrsAMoi(quoi, mrIds) {
  const liste = (Array.isArray(mrIds) ? mrIds : []).filter((id) => id != null);
  /* LES RÉGLAGES QUI FONT TOURNER LES AUTOMATISMES ONT CHANGÉ PAR LA SYNCHRO, SANS ÊTRE VUS ICI :
     rien ne part tant qu'ils ne sont pas approuvés sur ce poste (Réglages → Merge Request). */
  if (liste.length && !approbation.configApprouvee(getConfig())) {
    direRefusAuto(`${quoi} : les réglages d'automatisme ont changé par la synchro — à approuver dans Réglages → Merge Request`);
    return [];
  }
  const e = executantAuto();
  if (e.mode === 'tous') return liste;
  if (e.mode === 'personne') {
    direRefusAuto(e.qui
      ? `${quoi} : exécutant = ${e.qui}, ce poste n'agit pas`
      : `${quoi} : aucun exécutant désigné (Réglages → Merge Request), personne n'agit`);
    return [];
  }
  const gardees = [];
  let inconnu = false;
  for (const id of liste) {
    const mr = db.prepare(`SELECT mr.author AS author, mr.author_username AS author_username, repo.forge AS forge
      FROM mr JOIN repo ON repo.id = mr.repo_id WHERE mr.id = ?`).get(Number(id));
    if (!mr) continue;
    const mien = await mrDeMoi(mr);
    if (mien === null) { inconnu = true; continue; }
    if (mien) gardees.push(id);
  }
  /* POURQUOI RIEN NE PART. Un compte de forge injoignable, et « chacun ses MR » ne peut plus
     rien trancher : mieux vaut ne rien lancer et le dire que lancer tout chez tout le monde. */
  if (inconnu) direRefusAuto(`${quoi} : compte de la forge inconnu (jeton absent ou forge injoignable) — ce poste ne sait pas quelles merge requests sont les siennes`);
  else if (gardees.length < liste.length) {
    direRefusAuto(`${quoi} : ${liste.length - gardees.length} merge request(s) d'un autre auteur — leur auteur s'en occupe`);
  }
  return gardees;
}

async function lancerReviewsAuto(mrIds) {
  if (getConfig().auto_review_new !== '1') return { lancees: 0, plafonnees: 0 };
  const miennes = await mrsAMoi('review automatique', mrIds);
  if (!miennes.length) return { lancees: 0, plafonnees: 0 };
  /* UN BROUILLON N'EST PAS PRÊT À ÊTRE RELU. « Draft » / « WIP » veut dire « je n'ai pas fini » :
     la review automatique y dépensait un appel IA, produisait un rapport sur du travail en
     cours, et ce rapport se périmait au commit suivant. Le bouton « Reviewer », lui, reste
     disponible — un brouillon qu'on veut relire quand même est une décision, pas un défaut. */
  const prets = miennes.filter((id) => !(db.prepare('SELECT is_draft FROM mr WHERE id = ?').get(Number(id)) || {}).is_draft);
  const sautes = miennes.length - prets.length;
  const bilan = lancerLotReview(prets, { kind: 'review', etiquette: 'review-auto' });
  return sautes ? { ...bilan, brouillons: sautes } : bilan;
}

/* LA RE-REVIEW QUAND LE RAPPORT SE PÉRIME.
 *
 * « Périmé » a un sens précis : la merge request a DÉJÀ un rapport, et la branche a avancé
 * depuis (`reviewed_sha !== current_sha`) — c'est le badge « périmé » de l'écran. `stale_mr_ids`
 * est plus large : il contient toute MR connue dont le SHA a bougé, reviewée ou non. On filtre
 * donc, sinon la case « rapport périmé » lancerait des PREMIÈRES reviews, ce qu'elle ne promet
 * pas et ce que l'autre case est là pour faire.
 *
 * En INCRÉMENTAL, comme le bouton « Relancer (incrémental) » qu'elle remplace : l'IA ne voit
 * que le delta depuis le dernier SHA reviewé et reçoit le rapport précédent en contexte. Sur
 * une branche qui bouge dix fois par jour, la différence de coût n'est pas un détail. */
async function lancerRereviewsAuto(mrIds) {
  if (getConfig().auto_rereview_stale !== '1') return { lancees: 0, plafonnees: 0 };
  const miennes = await mrsAMoi('re-review automatique', mrIds);
  if (!miennes.length) return { lancees: 0, plafonnees: 0 };
  const perimees = miennes.filter((id) => db.prepare(`SELECT 1 FROM mr
    JOIN review ON review.mr_id = mr.id
    WHERE mr.id = ? AND mr.status != 'done'
      AND mr.reviewed_sha IS NOT NULL AND mr.reviewed_sha != mr.current_sha`).get(Number(id)));
  return lancerLotReview(perimees, {
    kind: 'rereview', opts: { incremental: true }, etiquette: 'rereview-auto',
  });
}

/* Le SEUL chemin de découverte côté serveur : la route et le rafraîchissement automatique
   passent par lui, donc les vérifications automatiques ne peuvent pas être oubliées d'un côté. */
async function decouvrir() {
  const result = await discoverAll();
  result.auto_verify = await lancerVerificationsAuto(result.new_mr_ids);
  result.auto_review = await lancerReviewsAuto(result.new_mr_ids);
  result.auto_rereview = await lancerRereviewsAuto(result.stale_mr_ids);
  /* Les MR dont le SHA vient de bouger : leur verdict est périmé. Deux appels séparés et deux
     plafonds distincts — une poussée massive sur des MR connues ne doit pas manger le budget
     des MR nouvelles, qui est le cas d'usage principal. */
  result.auto_verify_stale = await lancerVerificationsAuto(result.stale_mr_ids, { colonne: 'auto_on_stale' });
  return result;
}

app.post('/api/discover', wrap(async (req, res) => {
  res.json(await decouvrir());
}));

app.post('/api/jobs/review', wrap((req, res) => {
  /* A14 — UN SOUS-ENSEMBLE, quand l'écran en désigne un. Sans corps, c'est toute la file (le
     comportement d'origine) ; avec `mr_ids`, ce que l'écran affichait ou avait coché — une
     recherche et un filtre d'auteur ne se rejouent pas en SQL, c'est donc le client qui les
     nomme. Borné, et filtré sur ce qui est RÉELLEMENT à reviewer : une liste envoyée par un
     client ne décide pas de l'état des merge requests. */
  const bruts = Array.isArray(req.body && req.body.mr_ids) ? req.body.mr_ids.slice(0, 200) : null;
  let ids = null;
  if (bruts) {
    const aTraiter = new Set(db.prepare("SELECT id FROM mr WHERE status = 'to_review'").all().map((r) => r.id));
    ids = bruts.map(Number).filter((id) => aTraiter.has(id));
    if (!ids.length) throw new Error(t('err.review.none-selected'));
  }
  const job = jobs.startJob('review', ids);
  res.json(job);
}));

app.get('/api/jobs/current', wrap((req, res) => {
  res.json({ job: jobs.currentJob(), running: jobs.isRunning(), queued: jobs.queueCount() });
}));

// Sans id : tout arrêter (bouton du panneau). Avec un id : n'arrêter que ce job-là.
app.post('/api/jobs/stop', wrap((req, res) => {
  res.json(jobs.stopJob(req.body && req.body.job_id));
}));
app.post('/api/jobs/:id/stop', wrap((req, res) => {
  res.json(jobs.stopJob(Number(req.params.id)));
}));

/* Ce qui tourne et ce qui attend. Les jobs en attente portent leurs `keys` (dépôts et
   dossiers touchés) et les `conflicts` avec ce qui tourne : l'écran peut ainsi dire
   POURQUOI un job ne peut pas démarrer tout de suite, au lieu de griser un bouton. */
/* Journal d'activité : ce qu'on a lancé, et ce qui s'est terminé pendant qu'on regardait
   ailleurs. Les notifications ne répondent pas à cette question — elles ne vivent qu'en mémoire
   et le front saute délibérément l'historique au chargement, donc tout ce qui s'est produit
   onglet fermé est perdu. La table `job`, elle, persiste.
   `after` = dernier job vu par ce navigateur : ce qui est plus récent est « nouveau ». */
app.get('/api/jobs/history', wrap((req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 200);
  const after = Number(req.query.after) || 0;
  /* Trié sur l'activité la PLUS RÉCENTE, pas sur l'identifiant. Un id croît à la mise en file :
     un job queué tôt mais terminé tard passerait au-dessus d'un job queué après et fini avant,
     ce qui se lit comme un désordre puisque la colonne affichée est l'heure de FIN. Depuis que
     plusieurs jobs tournent de front, le cas est courant. Un job non terminé est classé sur son
     démarrage — c'est bien l'activité en cours, donc en tête. */
  const rows = db.prepare(`SELECT id, kind, status, total, done_count, message, started_at, finished_at,
    target_kind, target_id, current_mr_id FROM job
    ORDER BY COALESCE(finished_at, started_at) DESC, id DESC LIMIT ?`).all(limit);

  /* Le libellé de l'objet est résolu ICI : le front n'a en mémoire que les listes qu'il affiche,
     et un job peut porter sur une session masquée ou une MR d'un autre stade. */
  const labelMr = db.prepare('SELECT mr.iid, mr.title, repo.project FROM mr JOIN repo ON repo.id = mr.repo_id WHERE mr.id = ?');
  const labelTask = db.prepare('SELECT prompt, kind FROM task WHERE id = ?');
  const labelLocal = db.prepare('SELECT prompt FROM local_task WHERE id = ?');
  const labelVerif = db.prepare('SELECT verifier_name, targets_json FROM verification WHERE id = ?');
  const court = (v) => String(v || '').split('\n')[0].slice(0, 70);

  const out = rows.map((j) => {
    let label = null; let href = null;
    const mrId = j.target_kind === 'mr' ? j.target_id : (j.target_kind ? null : j.current_mr_id);
    if (mrId) {
      const m = labelMr.get(mrId);
      if (m) { label = `!${m.iid} — ${court(m.title)}`; href = { kind: 'mr', id: mrId }; }
    } else if (j.target_kind === 'task') {
      const t2 = labelTask.get(j.target_id);
      if (t2) { label = court(t2.prompt); href = { kind: t2.kind === 'explore' ? 'explore' : 'task', id: j.target_id }; }
    } else if (j.target_kind === 'local') {
      const l = labelLocal.get(j.target_id);
      if (l) { label = court(l.prompt); href = { kind: 'local', id: j.target_id }; }
    } else if (j.target_kind === 'verification') {
      /* Une vérification porte sur une ou plusieurs MR : le libellé les nomme, et le lien
         mène à la première — c'est la destination utile, et elle existe déjà côté front. */
      const v = labelVerif.get(j.target_id);
      if (v) {
        let cibles = [];
        try { cibles = JSON.parse(v.targets_json || '[]'); } catch { cibles = []; }
        const mrs = cibles.map((c) => labelMr.get(c.mr_id)).filter(Boolean);
        label = court(`${v.verifier_name} — ${mrs.map((m) => `${m.project} !${m.iid}`).join(', ')}`);
        const premier = cibles.find((c) => c.mr_id);
        if (premier) href = { kind: 'mr', id: premier.mr_id };
      }
    }
    /* A40 — LA RAISON D'UN ÉCHEC, et s'il se rejoue. `message` était renvoyé et jamais rendu :
       l'historique disait « erreur » sans dire laquelle, et il fallait ouvrir le journal
       ligne à ligne. `can_retry` évite d'afficher un bouton qui répondrait 400. */
    return { ...j, label, href, can_retry: jobs.canRetry(j) };
  });
  // `latest` = plus grand id vu, pas le premier de la liste : l'ordre d'affichage n'est plus
  // celui des ids, et un curseur pris sur la tête raterait un job plus récent classé plus bas.
  const latest = rows.reduce((m, r) => Math.max(m, r.id), 0);
  res.json({ jobs: out, latest });
}));

app.get('/api/jobs/queue', wrap((req, res) => {
  res.json({
    running: jobs.runningJobs(), queued: jobs.queuedJobs(),
    parallelBusy: jobs.parallelBusy(), maxRunning: jobs.MAX_RUNNING,
  });
}));

// Rejoue un job qui s'est arrêté ou a échoué, sur le même objet.
app.post('/api/jobs/:id/retry', wrap((req, res) => {
  res.json({ ok: true, job: jobs.retryJob(Number(req.params.id)) });
}));

// Sort un job de la file et le lance EN PARALLÈLE de celui en cours (refus si conflit).
app.post('/api/jobs/:id/start-now', wrap((req, res) => {
  res.json({ ok: true, job: jobs.startNow(Number(req.params.id)) });
}));

// Charge utile commune aux deux routes de log : le job, ses compteurs, ses lignes.
function jobLogPayload(job, after) {
  const lines = db.prepare(
    'SELECT id, mr_id, text, ts FROM job_log WHERE job_id = ? AND id > ? ORDER BY id LIMIT 3000',
  ).all(job.id, after);
  return {
    job_id: job.id,
    kind: job.kind,
    status: job.status,
    running: jobs.isRunning(),
    // Les autres jobs EN COURS : le panneau en tire ses onglets sans requête de plus.
    running_ids: jobs.runningJobs().map((j) => j.id),
    queued: jobs.queueCount(),
    message: job.message,
    total: job.total,
    done_count: job.done_count,
    // Horodatages du job : le front en tire le temps écoulé. Il les calcule à partir de la
    // date SERVEUR plutôt que de compter les secondes depuis l'ouverture de la page — sinon
    // un onglet ouvert en cours de route afficherait un temps faux.
    started_at: job.started_at,
    finished_at: job.finished_at,
    // Le serveur décide de ce qui est rejouable — le front n'a pas à connaître la liste.
    can_retry: jobs.canRetry(job),
    /* POURQUOI CE JOB-LÀ NE SE REJOUE PAS. Les opérations git sont volontairement exclues du
       « Relancer » : rejouer « supprimer ces douze branches » depuis un bandeau, sans repasser
       par l'aperçu, est exactement ce qu'il ne faut pas permettre. Le choix était assumé dans
       le code et muet à l'écran — le bouton disparaissait, sans un mot. */
    no_retry_reason: (job && !jobs.canRetry(job) && ['stopped', 'error', 'interrupted'].includes(job.status)
      && ['gitops', 'docker', 'verify', 'install'].includes(job.kind))
      ? t(`job.no-retry.${job.kind}`) : null,
    /* CE QUE LE JOB A PRODUIT, pour que le bandeau puisse y mener. Un job qui se terminait
       s'effaçait tout seul six secondes plus tard sans laisser de lien vers son résultat : il
       ne restait qu'une pastille de onze pixels dans le pied de page. */
    target_kind: job.target_kind || null,
    target_id: job.target_id || null,
    lines,
  };
}

// Log incrémental du job courant (poll temps réel côté UI).
/* `expect` = le job que le client CROIT courant. Le job courant peut changer sous ses pieds
   (le principal se termine, un job parallèle devient le plus récent en cours) : si l'id ne
   correspond plus, son curseur ne vaut rien et on renvoie depuis le début, sinon il
   manquerait toutes les lignes déjà produites par ce job-là. */
app.get('/api/jobs/current/log', wrap((req, res) => {
  const job = jobs.currentJob();
  if (!job) return res.json({ job_id: null, lines: [], running: false });
  const expect = Number(req.query.expect || 0);
  const after = expect && expect === job.id ? Number(req.query.after || 0) : 0;
  res.json(jobLogPayload(job, after));
}));

// Log d'un job PRÉCIS — l'onglet du job lancé en parallèle s'en sert.
app.get('/api/jobs/:id/log', wrap((req, res) => {
  const job = db.prepare('SELECT * FROM job WHERE id = ?').get(Number(req.params.id));
  if (!job) throw new Error(t('err.job-introuvable'));
  res.json(jobLogPayload(job, Number(req.query.after || 0)));
}));

// Réinitialise : supprime tous les rapports (fichiers + lignes review),
// remet toutes les MR en 'to_review', vide le journal des jobs. Conserve repos/config.
app.post('/api/reports/reset', wrap((req, res) => {
  if (jobs.isRunning()) throw new Error(t('err.un-job-est-en-cours'));
  try {
    fs.rmSync(REVIEWS_DIR, { recursive: true, force: true });
    fs.mkdirSync(REVIEWS_DIR, { recursive: true });
  } catch { /* dossier absent : rien à faire */ }
  const del = db.prepare('DELETE FROM review').run();
  db.prepare("UPDATE mr SET status = 'to_review', reviewed_sha = NULL, last_error = NULL, updated_at = ?")
    .run(new Date().toISOString());
  db.prepare('DELETE FROM job_log').run();
  db.prepare('DELETE FROM job').run();
  res.json({ ok: true, deleted: del.changes });
}));

/* ---------- Export d'une réponse d'agent ----------
   Le HTML et le PDF se fabriquent dans le navigateur : il a déjà le contenu rendu, et le PDF
   passe par sa propre boîte d'impression. Le .docx, lui, est un ZIP — Node sait le faire avec
   `zlib`, alors qu'au front il faudrait embarquer une bibliothèque de compression pour un
   bouton. D'où cette seule route. */
/* Nom de fichier lisible tiré du titre : on garde les accents (les systèmes modernes les
   acceptent) et on écarte ce qui casse un chemin — séparateurs, deux-points, guillemets. */
const nomDeFichier = (t2) => String(t2 || '').trim()
  .replace(/[/\\?%*:|"<>\u0000-\u001f]/g, '-')
  .replace(/\s+/g, ' ')
  .slice(0, 80)
  .trim()
  .replace(/^[.\s]+|[.\s]+$/g, '');

app.post('/api/export/docx', wrap((req, res) => {
  const markdown = String((req.body && req.body.markdown) || '');
  if (!markdown.trim()) throw new Error(t('err.export.vide'));
  const titre = String((req.body && req.body.title) || '').slice(0, 200);
  const fichier = `${nomDeFichier(titre) || 'mergerie'}.docx`;
  const buf = docx.markdownToDocx(titre, markdown);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  /* `filename*` en UTF-8 : les titres portent des accents, et le paramètre `filename` seul
     les rendrait illisibles (ou ferait tomber le navigateur sur un nom générique). */
  res.setHeader('Content-Disposition', `attachment; filename="export.docx"; filename*=UTF-8''${encodeURIComponent(fichier)}`);
  res.send(buf);
}));

/* ---------- Sauvegarde des données ----------
   Tout le travail accumulé — rapports, verdicts, sessions, suivi de résolution — vit dans un
   seul dossier qu'aucune commande n'exportait. Une suppression accidentelle ou un disque qui
   lâche effaçait des mois de contexte sans recours.
   UN POST, ET NON UN GET, bien que rien ne change côté serveur : l'archive porte la base
   ENTIÈRE, jetons compris. Un GET échappe au filtre d'origine — une page tierce pouvait donc
   déclencher le téléchargement ; un POST doit venir de l'application. */
app.post('/api/backup', wrap(async (req, res) => {
  const { buffer, contenu } = await backup.construire(db);
  const nom = backup.nomArchive();
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${nom}"`);
  // Ce que l'archive contient, lisible sans l'ouvrir : le front l'affiche après coup.
  res.setHeader('X-Mergerie-Backup', Buffer.from(JSON.stringify(contenu), 'utf8').toString('base64'));
  res.send(buffer);
}));

/* ---------- Notes, todos, rappels et brief (plan_add_notes.md) --------------
   Tout est local : rien ne part vers l'agent ni vers une forge. Les messages d'erreur
   traversent `t()` comme partout ailleurs — ils s'affichent tels quels dans l'interface. */

// Les libellés d'erreur passés à src/notes.js. Regroupés parce que les mêmes servent à la
// création et à l'édition : les dupliquer aux deux endroits les ferait diverger.
const msgNotes = () => ({
  titreVide: t('err.notes.title-required'),
  inconnue: t('err.notes.unknown'),
  prioriteInvalide: t('err.notes.priority-invalid'),
  statutInvalide: t('err.notes.status-invalid'),
  dateInvalide: t('err.notes.due-invalid'),
  lienInvalide: t('err.notes.link-invalid'),
  tropProfond: t('err.notes.parent-too-deep'),
  soiMeme: t('err.notes.parent-self'),
});

app.get('/api/notes', wrap((req, res) => {
  res.json({ pages: notes.listerPages(req.query.q) });
}));

app.post('/api/notes', wrap((req, res) => {
  res.json(notes.creerPage(req.body || {}, msgNotes()));
}));

/* B4 — LE SENS INVERSE DE L'AUTOLIEN : qui, dans les notes, parle de cet objet. Une note
   mène à la merge request depuis toujours ; la merge request ignorait qu'on avait écrit trois
   paragraphes sur elle. La règle de « citer » est celle du rendu, pas un second `LIKE` qui
   dériverait (cf. `notes.citations`). */
/* L'HISTOIRE D'UNE PAGE — ce que git rend gratuitement.
 *
 * Une page de notes est un fichier du dépôt de données : son historique existe déjà, avec son
 * auteur et sa date, sans qu'on ait eu à tenir une table de versions. On le montre, et c'est
 * tout ce que cette route fait. Sans dépôt de données, elle rend une liste vide plutôt qu'une
 * erreur : l'écran affiche alors « pas d'historique ici », ce qui est la vérité.
 *
 * Déclarée AVANT `/api/notes/:id` — Express prendrait sinon « citations » ou « history » pour
 * un identifiant, comme le rappelle la route voisine. */
app.get('/api/notes/:id/history', wrap(async (req, res) => {
  const page = notes.lirePage(req.params.id);
  if (!page) throw Object.assign(new Error(t('err.notes.unknown')), { status: 404 });
  const fichier = `notes/${page.slug}.md`;
  const sha = String(req.query.sha || '').trim();
  if (sha) return res.json({ sha, diff: await datasync.diffDe(fichier, sha) });
  res.json({ file: fichier, commits: await datasync.historique(fichier) });
}));

app.get('/api/notes/citations', wrap((req, res) => {
  const mr = req.query.mr ? Number(req.query.mr) : null;
  const ticket = String(req.query.ticket || '').trim();
  if (!mr && !ticket) throw new Error(t('err.citations-sans-cible'));
  res.json({ pages: notes.citations({ mr, ticket }) });
}));
/* Déclarée AVANT `/api/notes/:id` : Express prendrait sinon « citations » pour un identifiant
   de page, et la route ne répondrait jamais. */

app.get('/api/notes/:id', wrap((req, res) => {
  const page = notes.lirePage(req.params.id);
  if (!page) throw Object.assign(new Error(t('err.notes.unknown')), { status: 404 });
  /* Ses sous-pages, et le titre de son parent si c'en est une : l'écran a besoin des deux
     pour se situer, et un second aller-retour par page ouverte se verrait à la frappe. */
  const parent = page.parent_id ? notes.lirePage(page.parent_id) : null;
  res.json({ ...page, children: notes.sousPages(page.id), parent_title: parent ? parent.title : null });
}));

app.put('/api/notes/:id', wrap((req, res) => {
  res.json(notes.majPage(req.params.id, req.body || {}, msgNotes()));
}));

app.delete('/api/notes/:id', wrap((req, res) => {
  // Les lignes partent en cascade ; les FICHIERS, eux, resteraient sur le disque.
  const dossier = path.join(NOTES_DIR, String(Number(req.params.id) || 0));
  const out = notes.supprimerPage(req.params.id, msgNotes());
  try { fs.rmSync(dossier, { recursive: true, force: true }); } catch { /* déjà parti */ }
  res.json(out);
}));

/* CAPTURES D'UNE PAGE DE NOTES. Le fichier sur disque, un lien Markdown dans la page : coller
   une image en base64 dans le contenu gonflerait la ligne de plusieurs mégaoctets, renvoyés en
   entier à chaque sauvegarde automatique — donc à peu près toutes les secondes pendant qu'on
   écrit. Le rendu n'accepte d'ailleurs QUE cette forme d'URL, comme pour les pièces jointes
   Jira : une image dont l'adresse vient du texte de l'utilisateur ne s'affiche pas. */
app.post('/api/notes/:id/images', wrap((req, res) => {
  const page = notes.lirePage(req.params.id);
  if (!page) throw Object.assign(new Error(t('err.notes.unknown')), { status: 404 });
  const { ext, buf } = decodeDataUrlImage((req.body && req.body.image) || '');
  const dir = ensureDir(path.join(NOTES_DIR, String(page.id)));
  const n = db.prepare('SELECT COUNT(*) c FROM note_image WHERE page_id = ?').get(page.id).c + 1;
  const file = path.join(dir, `img_${n}.${ext}`);
  fs.writeFileSync(file, buf);
  const id = db.prepare('INSERT INTO note_image (page_id, path, created_at) VALUES (?,?,?)')
    .run(page.id, file, new Date().toISOString()).lastInsertRowid;
  /* Une capture vit dans le fichier de SA PAGE — elle ne change qu'avec elle, et un conflit sur
     une image est un conflit sur la page. On réécrit donc la page, ce qui recopie aussi le
     binaire dans le dépôt de données. */
  store.rafraichir('note_page', page.id);
  res.json({ id, url: `/api/notes/${page.id}/images/${id}` });
}));

const TYPE_IMAGE = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
/* B6 — LA LISTE DES CAPTURES D'UNE PAGE. Elles étaient servies une par une (l'aperçu les
   demande par identifiant), mais rien ne disait CE QU'UNE PAGE PORTE : impossible, donc, de
   proposer de les joindre à une session. Une requête, pas d'appel externe. */
app.get('/api/notes/:id/images', wrap((req, res) => {
  const page = notes.lirePage(req.params.id);
  if (!page) throw Object.assign(new Error(t('err.notes.unknown')), { status: 404 });
  res.json(db.prepare('SELECT id, path, created_at FROM note_image WHERE page_id = ? ORDER BY id').all(page.id)
    .map((im) => ({ id: im.id, name: path.basename(im.path), created_at: im.created_at })));
}));

app.get('/api/notes/:id/images/:imgId', wrap((req, res) => {
  const im = db.prepare('SELECT * FROM note_image WHERE id = ? AND page_id = ?')
    .get(Number(req.params.imgId), Number(req.params.id));
  if (!im || !fs.existsSync(im.path)) throw Object.assign(new Error(t('err.notes.image-unknown')), { status: 404 });
  res.setHeader('Cache-Control', 'private, max-age=86400');   // le contenu d'une capture ne change pas
  servirFichierNonFiable(res, { chemin: im.path, mime: TYPE_IMAGE[path.extname(im.path).slice(1).toLowerCase()] });
}));

/* Export d'une page en Markdown. Le nom du fichier est SLUGIFIÉ depuis le titre : un titre
   porte des espaces, des accents et parfois un `/` — `Content-Disposition` n'est pas
   l'endroit où découvrir qu'un nom de page contenait une traversée de chemin. */
app.get('/api/notes/:id/export', wrap((req, res) => {
  const page = notes.lirePage(req.params.id);
  if (!page) throw Object.assign(new Error(t('err.notes.unknown')), { status: 404 });
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${notes.slugifier(page.title)}.md"`);
  res.send(`# ${page.title}\n\n${page.content || ''}\n`);
}));

/* CE QUE LA MERGE REQUEST LIÉE EST DEVENUE. « Suivre !201 » restait dans la liste des mois
   après le merge : on ouvrait Reviews pour vérifier, puis on revenait cocher. La todo porte
   donc l'état de sa merge request — note, verdict, âge, et si elle est fermée. Une requête
   pour toute la liste : ces lignes se redessinent à chaque ouverture de l'onglet. */
function etatMrDesTodos(todos) {
  const ids = [...new Set(todos.filter((x) => x.link_kind === 'mr').map((x) => Number(x.link_ref)).filter(Boolean))];
  if (!ids.length) return {};
  const trous = ids.map(() => '?').join(',');
  const out = {};
  for (const m of db.prepare(`SELECT mr.id, mr.iid, mr.title, mr.status, mr.closed_seen, mr.gitlab_created_at,
      repo.project FROM mr JOIN repo ON repo.id = mr.repo_id WHERE mr.id IN (${trous})`).all(...ids)) {
    out[m.id] = { iid: m.iid, title: m.title, status: m.status, closed: !!m.closed_seen, project: m.project, created_at: m.gitlab_created_at };
  }
  for (const rv of db.prepare(`SELECT mr_id, note_value FROM review_version rv WHERE mr_id IN (${trous})
    AND version = (SELECT MAX(v2.version) FROM review_version v2 WHERE v2.mr_id = rv.mr_id)`).all(...ids)) {
    if (out[rv.mr_id]) out[rv.mr_id].note = rv.note_value;
  }
  const verifs = dernieresVerificationsParMr();
  for (const id of ids) { const v = verifs.get(id); if (out[id] && v) out[id].verdict = v.verdict; }
  return out;
}

/* A/Notes 1 — CE QUE LE TICKET LIÉ EST DEVENU. Une todo « Suivre PROJ-720 » était muette là
   où sa sœur liée à une merge request dit tout : on rouvrait Jira pour savoir si elle avait
   encore une raison d'exister. Deux sources, aucune requête réseau — l'état des tickets
   surveillés, et celui rangé à la découverte sur les merge requests qui portent la clé. */
function etatTicketDesTodos(todos) {
  const cles = [...new Set(todos.filter((x) => x.link_kind === 'ticket')
    .map((x) => String(x.link_ref || '').toUpperCase()).filter(Boolean))];
  if (!cles.length) return {};
  const out = {};
  const trous = cles.map(() => '?').join(',');
  for (const w of db.prepare(`SELECT key, status, status_category FROM jira_watch WHERE UPPER(key) IN (${trous})`).all(...cles)) {
    out[String(w.key).toUpperCase()] = { status: w.status, category: w.status_category, watched: true };
  }
  for (const m of db.prepare(`SELECT mr.iid, mr.status, mr.closed_seen, mr.ticket_jira_key,
      mr.ticket_jira_status, mr.ticket_jira_category, repo.project
    FROM mr JOIN repo ON repo.id = mr.repo_id
    WHERE UPPER(COALESCE(mr.ticket_jira_key, '')) IN (${trous})
    ORDER BY mr.id DESC`).all(...cles)) {
    const k = String(m.ticket_jira_key).toUpperCase();
    const acc = out[k] || (out[k] = { status: null, category: null, watched: false });
    // Le statut du ticket surveillé PRIME : il est rafraîchi, celui de la découverte non.
    if (!acc.status) { acc.status = m.ticket_jira_status; acc.category = m.ticket_jira_category; }
    acc.mrs = acc.mrs || [];
    if (acc.mrs.length < 3) acc.mrs.push({ iid: m.iid, project: m.project, closed: !!m.closed_seen });
  }
  return out;
}

app.get('/api/todos', wrap((req, res) => {
  const todos = notes.listerTodos(req.query.status);
  const etats = etatMrDesTodos(todos);
  const tickets = etatTicketDesTodos(todos);
  res.json({
    todos: todos.map((x) => ({
      ...x,
      mr: x.link_kind === 'mr' ? (etats[Number(x.link_ref)] || null) : null,
      ticket: x.link_kind === 'ticket' ? (tickets[String(x.link_ref || '').toUpperCase()] || null) : null,
    })),
  });
}));

app.post('/api/todos', wrap((req, res) => {
  res.json(notes.creerTodo(req.body || {}, msgNotes()));
}));

/* Réordonner la liste « à faire » : l'écran envoie l'ordre complet de ce qu'il affiche. */
app.post('/api/todos/reorder', wrap((req, res) => {
  const ids = (req.body && req.body.ids) || [];
  if (!Array.isArray(ids) || !ids.length) throw new Error(t('err.ordre-vide'));
  res.json({ ok: true, n: notes.reordonnerTodos(ids) });
}));

/* Édition, cocher/décocher ET snooze passent par la même route : ce sont les mêmes colonnes.
   `snooze` est traduit ici en `due_at` plutôt que côté client — « demain 9 h » doit vouloir
   dire la même chose que le rappel l'ait posé le navigateur ou le serveur. */
app.put('/api/todos/:id', wrap((req, res) => {
  const body = { ...(req.body || {}) };
  if (body.snooze) {
    const quand = notes.calculerSnooze(body.snooze);
    if (!quand) throw new Error(t('err.notes.snooze-invalid'));
    body.due_at = quand;
    delete body.snooze;
  }
  res.json(notes.majTodo(req.params.id, body, msgNotes()));
}));

app.delete('/api/todos/:id', wrap((req, res) => {
  res.json(notes.supprimerTodo(req.params.id, msgNotes()));
}));

// Ce qui est dû et pas encore annoncé. Le client notifie puis confirme (route ci-dessous).
app.get('/api/todos/reminders/due', wrap((req, res) => {
  res.json({ due: notes.rappelsDus() });
}));

/* Confirmation d'AFFICHAGE, envoyée par le client après la notification. Marquer à la
   lecture aurait été plus simple, mais aurait consommé l'unique occasion de prévenir quand
   la notification échoue (permission refusée, onglet fermé entre-temps). */
app.post('/api/todos/:id/reminded', wrap((req, res) => {
  res.json(notes.marquerNotifie(req.params.id, msgNotes()));
}));

/* Ce dont le RENDU a besoin pour transformer `!214` en lien : une table de résolution
   iid → dépôts, pas la liste des MR. Un même numéro pouvant exister sur plusieurs dépôts,
   on rend tous les candidats et le front décide (lien direct ou recherche pré-remplie). */
app.get('/api/notes-index', wrap((req, res) => {
  res.json({ mrs: notes.indexAutolink(), jira: demoDocker.isDemo() || jira.isConfigured(getConfig()) });
}));

app.get('/api/brief', wrap((req, res) => {
  const cfgB = getConfig();
  const d = brief.construire({
    staleDays: cfgB.stale_mr_days,
    seuilPret: cfgB.converge_threshold,
    // Ce que la veille a vu au dernier tour : le brief n'appelle jamais Docker lui-même.
    dockerDown: demoDocker.isDemo() ? demoDocker.briefTombes() : veille.dockerTombes(),
  });
  /* Les lignes de todo du brief sont les MÊMES que celles de la liste : elles portent donc le
     même état de merge request. Enrichi ici et pas dans `brief.js`, qui compose le brief et
     n'a pas à connaître les rapports de review. */
  const etats = etatMrDesTodos([...(d.reminders || []), ...(d.todos || [])]);
  const poser = (x) => ({ ...x, mr: x.link_kind === 'mr' ? (etats[Number(x.link_ref)] || null) : null });
  res.json({ ...d, reminders: (d.reminders || []).map(poser), todos: (d.todos || []).map(poser) });
}));

/* Écarter une ligne du brief. On garde l'objet ÉCARTÉ, pas le sujet : cette vérification-ci,
   cette MR-là. Le `kind` est validé contre la liste du brief — une clé inventée resterait
   sinon dans la table sans rien masquer, et personne ne saurait pourquoi. */
app.post('/api/brief/hidden', wrap((req, res) => {
  const kind = String((req.body && req.body.kind) || '');
  const ref = String((req.body && req.body.ref) || '').trim();
  if (!brief.ECARTABLES.includes(kind) || !ref) throw new Error(t('err.brief-ecart-invalide'));
  db.prepare('INSERT OR IGNORE INTO brief_hidden (kind, ref, at) VALUES (?, ?, ?)')
    .run(kind, ref, new Date().toISOString());
  res.json({ ok: true });
}));

// Tout réafficher : le geste inverse, en un bouton. Rien n'a été supprimé, il n'y a rien à
// reconstruire — c'est pour ça qu'écarter peut rester sans confirmation.
app.delete('/api/brief/hidden', wrap((req, res) => {
  const n = db.prepare('DELETE FROM brief_hidden').run().changes;
  res.json({ ok: true, restored: n });
}));

/* ---------- Liens (plan_add_links.md) --------------------------------------
   Une grille services × environnements, des liens libres tagués et une palette globale.
   Toutes les URLs sont validées `http(s)` par src/links.js : elles sont ouvertes d'un clic
   depuis l'application, et l'outil ne s'y connecte JAMAIS de lui-même — surveiller des
   services n'est pas son travail. */

const msgLinks = () => ({
  nomVide: t('err.links.name-required'),
  nomPris: t('err.links.name-taken'),
  labelVide: t('err.links.label-required'),
  urlInvalide: t('err.links.url-invalid'),
  templateVide: t('err.links.template-invalid'),
  variableInconnue: (nom, valides) => t('err.links.template-variable', { name: nom, list: valides.map((v) => `{${v}}`).join(', ') }),
  tropDeTags: t('err.links.too-many-tags'),
  inconnu: t('err.links.unknown'),
  envInconnu: t('err.links.env-unknown'),
  tropGros: t('err.links.import-too-big'),
});

app.get('/api/links/grid', wrap((req, res) => { res.json(links.grille()); }));

app.get('/api/environments', wrap((req, res) => { res.json({ environments: links.listerEnvironnements() }); }));
app.post('/api/environments', wrap((req, res) => { res.json(links.creerEnvironnement(req.body || {}, msgLinks())); }));
app.put('/api/environments/:id', wrap((req, res) => { res.json(links.majEnvironnement(req.params.id, req.body || {}, msgLinks())); }));
app.delete('/api/environments/:id', wrap((req, res) => { res.json(links.supprimerEnvironnement(req.params.id, msgLinks())); }));
/* Déplacer une colonne d'un cran. Un POST et non un PUT de `position` : le client n'a pas à
   savoir quelles positions portent les voisines, il dit seulement de quel côté aller. */
app.post('/api/environments/:id/move', wrap((req, res) => {
  res.json(links.deplacerEnvironnement(req.params.id, (req.body || {}).dir, msgLinks()));
}));
/* L'ORDRE ENTIER, en un appel : c'est ce que produit un glisser-déposer. Les flèches restent
   pour le clavier, et parlent au même stockage. */
app.post('/api/environments/reorder', wrap((req, res) => {
  res.json(links.reordonnerEnvironnements((req.body || {}).ids));
}));
app.post('/api/services/reorder', wrap((req, res) => {
  res.json(links.reordonnerServices((req.body || {}).ids));
}));

app.post('/api/services', wrap((req, res) => { res.json(links.creerService(req.body || {}, msgLinks())); }));
app.put('/api/services/:id', wrap((req, res) => { res.json(links.majService(req.params.id, req.body || {}, msgLinks())); }));
app.delete('/api/services/:id', wrap((req, res) => { res.json(links.supprimerService(req.params.id, msgLinks())); }));
// Poser (ou vider) la case d'un environnement pour ce service.
app.put('/api/services/:id/urls', wrap((req, res) => { res.json(links.poserUrl(req.params.id, req.body || {}, msgLinks())); }));

app.get('/api/services/:id/context-links', wrap((req, res) => { res.json({ links: links.listerContextLinks(req.params.id) }); }));
app.post('/api/services/:id/context-links', wrap((req, res) => { res.json(links.creerContextLink(req.params.id, req.body || {}, msgLinks())); }));
app.delete('/api/context-links/:id', wrap((req, res) => { res.json(links.supprimerContextLink(req.params.id, msgLinks())); }));

app.get('/api/free-links', wrap((req, res) => { res.json({ links: links.listerFreeLinks(req.query) }); }));
app.post('/api/free-links', wrap((req, res) => { res.json(links.creerFreeLink(req.body || {}, msgLinks())); }));
app.put('/api/free-links/:id', wrap((req, res) => { res.json(links.majFreeLink(req.params.id, req.body || {}, msgLinks())); }));
app.delete('/api/free-links/:id', wrap((req, res) => { res.json(links.supprimerFreeLink(req.params.id, msgLinks())); }));
/* Déclarée APRÈS `/:id` — sans quoi Express ferait correspondre « /api/free-links » à la route
   paramétrée sur certaines formes d'URL, et « tout supprimer » deviendrait un cas particulier
   de « supprimer celui-là ». */
app.delete('/api/free-links', wrap((req, res) => { res.json(links.supprimerTousFreeLinks()); }));
// Des liens libres deviennent un service : le geste d'APRÈS l'import, explicite.
app.post('/api/free-links/to-service', wrap((req, res) => { res.json(links.rangerDansService(req.body || {}, msgLinks())); }));

/* La palette. Les actions de navigation viennent du CLIENT : lui seul sait ce qu'il sait
   faire, et les lister côté serveur aurait fait deux endroits à tenir d'accord. */
app.post('/api/launcher', wrap((req, res) => {
  const body = req.body || {};
  res.json({
    results: links.launcher(body.q, {
      jiraConfigure: demoDocker.isDemo() || jira.isConfigured(getConfig()),
      actions: Array.isArray(body.actions) ? body.actions.slice(0, 60) : [],
      // Les libellés d'agent sont traduits ICI : `links.js` ne charge pas le dictionnaire.
      agentsMsgs: { ask: t('agents.palette.ask', { name: '{name}' }), investigate: t('agents.palette.investigate') },
      /* B13 — les projets compose DÉJÀ VUS. La palette ne déclenche aucun `docker ps` : elle
         lit ce que le badge de santé et la veille de fond ont relevé. */
      dockerProjets: demoDocker.isDemo() ? ['boutique', 'monitoring'] : docker.nomsConnus(),
      msgs: {
        verify: t('palette.act.verify', { name: '{name}' }),
        jenkins: t('palette.act.jenkins', { job: '{job}' }),
        compose: t('palette.act.compose', { name: '{name}' }),
        gitcmd: t('palette.act.gitcmd', { label: '{label}' }),
      },
    }),
  });
}));
app.post('/api/launcher/used', wrap((req, res) => {
  const b = req.body || {};
  res.json(links.noterUsage(b.kind, b.ref));
}));

/* Import de marque-pages : APERÇU d'abord (on ne crée rien), application ensuite. Même
   esprit que l'aperçu obligatoire des opérations git — on voit avant d'exécuter. */
/* L'aperçu rend AUSSI ce que l'arbre laisse deviner : un dossier dont plusieurs enfants portent
   des noms d'environnement décrit une grille. Rien n'est créé — c'est une proposition, montrée
   avant de l'appliquer et refusable d'un clic. */
app.post('/api/links/import', wrap((req, res) => {
  const l = links.parserBookmarks((req.body || {}).html, msgLinks());
  res.json({ links: l, proposal: links.analyserArbre(l) });
}));
app.post('/api/links/import/apply', wrap((req, res) => {
  res.json(links.appliquerImport(req.body || {}, msgLinks()));
}));

/* COLLER DES ADRESSES : analyse d'abord (on ne crée rien, on propose), application ensuite —
   exactement comme l'import de marque-pages. La proposition est faite pour être corrigée à
   l'écran : c'est le client qui renvoie ce qu'il a confirmé, pas le serveur qui décide. */
app.post('/api/links/paste/analyse', wrap((req, res) => {
  res.json({ items: links.analyserCollage((req.body || {}).text) });
}));
app.post('/api/links/paste', wrap((req, res) => {
  res.json(links.appliquerCollage(req.body || {}, msgLinks()));
}));

// Les boutons contextuels d'une merge request : URLs de grille du service + gabarits résolus.
app.get('/api/mrs/:id/links', wrap((req, res) => {
  const mr = mrById(Number(req.params.id));
  if (!mr) throw Object.assign(new Error(t('err.links.unknown')), { status: 404 });
  res.json(links.liensDeMr(mr));
}));

/* LES MÊMES BOUTONS, SUR UNE LIGNE DE PROJET DE SESSION. Elle a un dépôt et une branche : les
   deux valeurs dont `{env}` et `{branch}` ont besoin. `{mr_iid}` n'est résolu que si la
   session a déjà ouvert sa merge request — sinon le gabarit qui la cite reste « incomplet »,
   ce que l'écran dit déjà. */
/* ---------- B5 : prévenir Jira quand la session ouvre sa merge request ----------
   La session multi-dépôts ouvre cinq merge requests ; on passait dix minutes dans Jira à
   coller cinq liens et à bouger cinq tickets. Un commentaire, et la transition vers l'état
   « en revue » si elle existe — en un appel, DERRIÈRE CONFIRMATION côté écran.

   La transition n'est pas devinée : on lit celles que Jira propose pour CE ticket et on prend
   la première dont l'état d'arrivée est de catégorie « en cours » (`indeterminate`). Aucune ne
   correspond ? On commente quand même et on le dit — écrire chez les autres est déjà le
   principal, et inventer un état serait pire que de n'en changer aucun. */
async function prevenirJira(cible) {
  const cle = jira.ticketKey(cible.branch || '', cible.branch || '');
  if (!cle) throw new Error(t('err.jira.no-key-in-branch'));
  const iid = cible.mr_iid || cible.existing_mr_iid;
  if (!iid) throw new Error(t('err.jira.no-mr-yet'));
  const cfg = getConfig();
  const texte = t('jira.notify.body', { iid, project: cible.project, url: cible.mr_url || '' });
  if (demoDocker.isDemo()) return { demo: true, key: cle, commented: true, transitioned: true };
  if (!jira.isConfigured(cfg)) throw new Error(t('err.jira.not-configured'));
  await jira.addComment(cfg, cle, texte);
  let transitioned = false;
  try {
    const dispo = await jira.transitions(cfg, cle);
    const vers = dispo.find((x) => x.to && x.to.statusCategory === 'indeterminate');
    if (vers) { await jira.transitionIssue(cfg, cle, vers.id); transitioned = true; }
  } catch { transitioned = false; }   // commenter a réussi : c'est l'essentiel, on le dit
  return { key: cle, commented: true, transitioned };
}

/* B2 — MERGER FERME LA BOUCLE JIRA. « Prévenir Jira » n'existait qu'à la CRÉATION de la merge
   request : une fois mergée, on ouvrait Jira, on cherchait le ticket, on le passait à l'état
   suivant, on collait le lien. Trois fois par jour. Le geste est le même que pour une session
   — même commentaire, même transition lue chez Jira et jamais devinée — mais la source est une
   merge request, pas un projet de session. */
app.post('/api/mrs/:id/notify-jira', wrap(async (req, res) => {
  const mr = mrById(Number(req.params.id));
  if (!mr) throw new Error(t('err.mr-introuvable'));
  const repo = db.prepare('SELECT project FROM repo WHERE id = ?').get(mr.repo_id) || {};
  res.json(await prevenirJira({
    branch: mr.ticket_jira_key || mr.source_branch || '',
    project: repo.project || '',
    mr_iid: mr.iid,
    mr_url: mr.web_url || '',
  }));
}));

app.post('/api/tasks/:id/targets/:tid/notify-jira', wrap(async (req, res) => {
  const cible = targetById(Number(req.params.id), Number(req.params.tid));
  if (!cible) throw new Error(t('err.session-introuvable'));
  res.json(await prevenirJira(cible));
}));

app.get('/api/tasks/:id/targets/:tid/links', wrap((req, res) => {
  const tg = targetById(Number(req.params.id), Number(req.params.tid));
  if (!tg) throw Object.assign(new Error(t('err.links.unknown')), { status: 404 });
  res.json(links.liensDeMr({ repo_id: tg.repo_id, source_branch: tg.branch, iid: tg.mr_iid || null }));
}));

/* ET SUR UN TICKET JIRA. Le dépôt n'y est pas écrit : on le déduit de ce qui est déjà
   engagé — la merge request qui porte la clé, sinon la session de codage. Rien de deviné :
   sans engagement, il n'y a pas de boutons, et c'est exact. */
app.get('/api/jira/issues/:key/links', wrap((req, res) => {
  const d = engagementsSurTicket(req.params.key);
  const mr = d.mrs[0] ? mrById(d.mrs[0].id) : null;
  if (mr) { res.json(links.liensDeMr(mr)); return; }
  const tache = d.tasks[0]
    ? db.prepare(`SELECT tt.repo_id, tt.branch, tt.mr_iid FROM task_target tt
      WHERE tt.task_id = ? ORDER BY tt.id LIMIT 1`).get(d.tasks[0].id)
    : null;
  if (!tache) { res.json({ service: null, envs: [], context: [] }); return; }
  res.json(links.liensDeMr({ repo_id: tache.repo_id, source_branch: tache.branch, iid: tache.mr_iid || null }));
}));

// Vérifier maintenant : le même code que le minuteur, donc ce que le bouton montre est
// exactement ce que fait la surveillance.

/* ---------- MRs ---------- */
app.get('/api/mrs', wrap((req, res) => {
  const { status } = req.query;
  let rows;
  // tri par date de création de la MR (GitLab), décroissante ; NULL en dernier
  const order = 'ORDER BY mr.gitlab_created_at IS NULL, mr.gitlab_created_at DESC, mr.iid DESC';
  if (status) {
    rows = db.prepare(`
      SELECT mr.*, repo.project AS project, repo.forge AS forge FROM mr JOIN repo ON repo.id = mr.repo_id
      WHERE mr.status = ? ${order}`).all(status);
  } else {
    rows = db.prepare(`
      SELECT mr.*, repo.project AS project, repo.forge AS forge FROM mr JOIN repo ON repo.id = mr.repo_id
      ${order}`).all();
  }
  /* CE QUE LE BADGE DE NOTE DIRA AU SURVOL. Le sélecteur de version porte déjà ces chiffres,
     mais il faut ouvrir le rapport pour les lire : « v3 · 07/08 · 1 résolu · 1 persistant » se
     décide avant d'ouvrir. Une seule requête pour toute la liste — la dernière version de
     chaque merge request —, pas une par carte. */
  const derniereVersion = {};
  const versions = db.prepare(`SELECT rv.* FROM review_version rv
    WHERE rv.version = (SELECT MAX(v2.version) FROM review_version v2 WHERE v2.mr_id = rv.mr_id)`).all();
  /* « PAR QUI » sur la carte d'une merge request : c'est l'auteur de sa DERNIÈRE passe de review
     qu'on veut, pas celui de la merge request — la question est « qui l'a reviewée ? ». Lu du
     cache alimenté par git, sans aucune colonne à tenir. */
  const parQui = auteurs('review_version', versions);
  for (const v of versions) {
    derniereVersion[v.mr_id] = {
      version: v.version, at: v.created_at, author: parQui.get(v.id) || null,
      n_new: v.n_new, n_persistent: v.n_persistent, n_resolved: v.n_resolved, n_disappeared: v.n_disappeared,
    };
  }
  /* COMBIEN DE BLOQUANTS, ET DE MAJEURS. Le détail disait « 1 résolu · 1 persistant » — le
     nombre, jamais la GRAVITÉ, alors que la sévérité est stockée par constat et déjà comptée
     pour décider de la publication automatique. Une note de 7,2 avec un bloquant et une note de
     7,2 sans aucun ne se traitent pas pareil, et c'est ce qui doit décider par quoi commencer.
     Une requête pour toute la liste, sur la dernière version de chaque merge request. */
  /* TOP 1 — LES BROUILLONS DE COMMENTAIRES, PARTOUT OÙ LA MERGE REQUEST APPARAÎT.
     C'est la perte de travail la plus silencieuse de l'outil : on écrit trois remarques inline
     dans le viewer, on referme pour aller voir autre chose, et elles restent là — personne ne
     les envoie, personne ne les voit, et la merge request se merge sans elles. Le compte
     existait déjà pour la ligne de projet d'une session ; il manquait sur la carte, dans
     l'en-tête du rapport et dans le brief du matin. Une requête pour toute la liste. */
  const brouillons = {};
  for (const c of db.prepare('SELECT mr_id, COUNT(*) n, MIN(created_at) AS depuis FROM mr_comment_draft GROUP BY mr_id').all()) {
    brouillons[c.mr_id] = { n: c.n, depuis: c.depuis };
  }

  const severites = {};
  for (const f of db.prepare(`SELECT f.mr_id, f.severity, COUNT(*) n FROM finding f
    WHERE f.version = (SELECT MAX(v2.version) FROM review_version v2 WHERE v2.mr_id = f.mr_id)
      AND f.status != 'resolved'
    GROUP BY f.mr_id, f.severity`).all()) {
    const e = severites[f.mr_id] || (severites[f.mr_id] = { blocker: 0, major: 0, minor: 0, info: 0 });
    if (e[f.severity] != null) e[f.severity] = f.n;
  }
  // marque celles qui ont un rapport + extrait la note globale du rapport
  const reviews = db.prepare('SELECT mr_id, md_path FROM review').all();
  const hasReview = new Set();
  const noteByMr = {};
  for (const rv of reviews) {
    hasReview.add(rv.mr_id);
    noteByMr[rv.mr_id] = extractNote(readFileSafe(rv.md_path));
  }
  const cfg = getConfig();
  // Badge « risque » : sans IA, juste sur les chemins du diff × les règles par chemin.
  // Chargées une fois pour toute la liste.
  const pathRules = db.prepare("SELECT id, path_match, label FROM review_rule WHERE enabled = 1 AND path_match IS NOT NULL AND path_match != ''").all();
  /* B7 — LES CARTES DE DOMAINE TOUCHÉES. Même mécanique que le badge « risque » : le produit
     des chemins du diff par ceux que les cartes citent, calculé sans IA et sans réseau. L'index
     est construit UNE fois pour toute la liste. */
  const indexCartes = agentknowledge.indexCartes();
  const riskOf = (changed) => {
    if (!changed || !pathRules.length) return [];
    const paths = String(changed).split('\n').filter(Boolean);
    return pathRules
      .filter((rule) => glob.matchingPaths(rule.path_match, paths).length > 0)
      .map((rule) => ({ label: rule.label || rule.path_match, path_match: rule.path_match }));
  };
  /* Les tickets SURVEILLÉS, avec leur état : la seule information Jira que le serveur possède
     hors ligne. Une requête pour toute la liste. */
  /* Les lots de chaque merge request, en une requête : la liste en affiche onze, et une
     requête par carte ferait onze allers-retours pour une information de contexte. */
  const lotsParMr = {};
  for (const l of db.prepare(`SELECT lm.ref_id AS mr_id, lot.id, lot.name FROM lot_member lm
    JOIN lot ON lot.id = lm.lot_id WHERE lm.kind = 'mr'`).all()) {
    (lotsParMr[l.mr_id] = lotsParMr[l.mr_id] || []).push({ id: l.id, name: l.name });
  }
  const etatsTickets = {};
  for (const w of db.prepare('SELECT key, status, status_category FROM jira_watch').all()) {
    etatsTickets[String(w.key).toUpperCase()] = { status: w.status, cat: w.status_category };
  }
  /* B8 — les jobs Jenkins déclarés pour chaque dépôt. Une requête pour toute la liste ; le
     bouton n'apparaît que sur une merge request VÉRIFIÉE VERTE, ce que l'écran décide. */
  const jobsParDepot = {};
  for (const l of db.prepare('SELECT repo_id, job_path, param FROM repo_jenkins').all()) {
    (jobsParDepot[l.repo_id] = jobsParDepot[l.repo_id] || []).push({ path: l.job_path, param: l.param });
  }
  const verifs = dernieresVerificationsParMr();
  /* Un dépôt qu'aucun vérificateur ne couvre : le bouton « Vérifier » sera GRISÉ, avec la raison
     en info-bulle. Proposer un bouton qui répond « impossible » une fois cliqué fait perdre un
     geste et n'apprend rien de plus. */
  const couverts = new Set(db.prepare('SELECT DISTINCT repo_id FROM verifier_repo').all().map((r) => r.repo_id));
  res.json(rows.map((r) => {
    const key = jira.ticketKey(r.title, r.source_branch);
    return {
      ...r,
      verification: verifs.has(r.id) ? resumeVerification(detailVerification(verifs.get(r.id))) : null,
      verifiable: couverts.has(r.repo_id),
      has_review: hasReview.has(r.id),
      note: noteByMr[r.id] || null,
      note_detail: derniereVersion[r.id] || null,
      // Les constats NON RÉSOLUS de la dernière version, par gravité. `null` = pas de rapport.
      severites: severites[r.id] || null,
      // Les remarques écrites et jamais envoyées : le travail le plus facile à perdre.
      drafts: brouillons[r.id] || null,
      /* B3 — L'ÉTAT DU TICKET, quand on le connaît. Vendredi la QA passe PROJ-1408 en « En
         revue » ; la merge request attend depuis trois jours au milieu de onze cartes et
         personne ne fait le lien. On ne SONDE pas Jira pour autant : on lit ce que la
         surveillance des tickets a déjà relevé — c'est la seule liste connue hors ligne. */
      jenkins_jobs: jobsParDepot[r.repo_id] || [],
      /* EN CONFLIT : la forge l'a dit, on l'a écrit — et personne ne le relisait entre deux
         ouvertures de la modale de merge. Une MR en conflit ne se merge pas : le savoir en
         lisant la file évite de l'ouvrir pour l'apprendre. */
      has_conflicts: r.has_conflicts == null ? null : !!r.has_conflicts,
      /* A/Réglages 3 — À QUELS LOTS CETTE MERGE REQUEST APPARTIENT. On la vérifie « ensemble »
         avec quatre autres, puis trois jours plus tard on ouvre sa carte et rien ne dit
         qu'elle ne tient pas seule. Une requête pour toute la liste, pas une par carte. */
      lots: lotsParMr[r.id] || [],
      /* DEUX SOURCES, DANS CET ORDRE. La surveillance d'un ticket est RAFRAÎCHIE (elle
         interroge Jira à intervalle) : elle prime. Le statut rangé à la découverte, lui,
         couvre TOUTES les MR à ticket — la grande majorité, qu'on ne surveille pas — au prix
         d'être plus ancien. Sans lui, « ticket en revue » n'existait que pour les watchés,
         c'est-à-dire presque jamais là où on choisit quoi reviewer. */
      /* LA CLÉ DU TICKET, CALCULÉE ICI ET NULLE PART AILLEURS. L'écran la redéduisait avec sa
         propre expression régulière — qui ne suivait pas la même règle que `jira.ticketKey`
         (crochets du titre d'abord, branche ensuite) : un titre citant deux clés donnait une
         réponse côté serveur et une autre à l'écran. Une règle, un endroit. */
      ticket_key: r.ticket_jira_key || jira.ticketKey(r.title, r.source_branch) || '',
      ticket_status: (etatsTickets[String(r.ticket_jira_key || jira.ticketKey(r.title, r.source_branch) || '').toUpperCase()] || {}).status
        || r.ticket_jira_status || null,
      ticket_category: (etatsTickets[String(r.ticket_jira_key || jira.ticketKey(r.title, r.source_branch) || '').toUpperCase()] || {}).cat
        || r.ticket_jira_category || null,
      /* TAILLE ET FRAÎCHEUR : de quoi choisir par quoi commencer sans ouvrir la carte. Le
         nombre de fichiers se déduit des chemins quand le relevé date d'avant la mesure. */
      size: {
        files: r.changed_files != null ? r.changed_files
          : (r.changed_paths ? String(r.changed_paths).split('\n').filter(Boolean).length : null),
        additions: r.changed_additions != null ? r.changed_additions : null,
        deletions: r.changed_deletions != null ? r.changed_deletions : null,
      },
      has_ticket: !!(r.ticket_text || r.ticket_image || r.ticket_jira_text),
      ticket_key: key,
      ticket_url: ticketUrl(cfg, key),
      risk: riskOf(r.changed_paths),
      cards: agentknowledge.cartesTouchees(indexCartes, r.repo_id, r.changed_paths),
      stale: r.reviewed_sha && r.reviewed_sha !== r.current_sha,
    };
  }));
}));

/* Retrouve la session de codage qui a produit une branche. Le lien n'est pas stocké en dur :
   il se reconstitue par (dépôt, branche). En cas d'ambiguïté — plusieurs sessions sur la même
   branche — on prend la PLUS RÉCENTE, et seulement si elle a bien une session d'agent. */
function originSessionKey(mr) {
  const row = db.prepare(`SELECT ls.session_key FROM task_target tt
    JOIN task t ON t.id = tt.task_id
    JOIN local_session ls ON ls.scope = 'task_target' AND ls.ref = tt.uid
    WHERE tt.repo_id = ? AND tt.branch = ? AND ls.session_key IS NOT NULL AND t.kind = 'code'
    ORDER BY tt.id DESC LIMIT 1`).get(mr.repo_id, mr.source_branch);
  return (row && row.session_key) || null;
}

/* B2 — LA SESSION QUI A PRODUIT CETTE BRANCHE. Le sens session → merge request existait
   partout (note, verdict, brouillons sur la ligne de projet) ; l'inverse n'était calculé que
   pour pré-remplir un champ caché. Après « Faire corriger », on ne voyait donc pas, depuis le
   rapport, que la correction tournait — on découvrait la MR « périmée » un quart d'heure plus
   tard. La jointure (dépôt, branche) est celle qu'utilise déjà l'explorateur de branches. */
function originTask(mr) {
  const row = db.prepare(`SELECT t.id, t.label, t.prompt, t.status, t.kind FROM task_target tt
    JOIN task t ON t.id = tt.task_id
    WHERE tt.repo_id = ? AND tt.branch = ? ORDER BY tt.id DESC LIMIT 1`).get(mr.repo_id, mr.source_branch);
  if (!row) return null;
  return {
    id: row.id, status: row.status, kind: row.kind || 'code',
    label: row.label || String(row.prompt || '').slice(0, 60),
  };
}

app.get('/api/mrs/:id', wrap((req, res) => {
  const mr = mrById(Number(req.params.id));
  if (!mr) throw new Error(t('err.mr-introuvable'));
  const rev = db.prepare('SELECT * FROM review WHERE mr_id = ?').get(mr.id);
  const comments = db.prepare('SELECT * FROM comment_log WHERE mr_id = ? ORDER BY id DESC').all(mr.id);
  const tkey = jira.ticketKey(mr.title, mr.source_branch);
  res.json({
    mr,
    /* B3 — LES TODOS OUVERTES DE CETTE MERGE REQUEST. Le rapport proposait d'en AJOUTER une
       sans montrer celles qui existent : on en recréait une deuxième, identique, deux jours
       plus tard. La jointure inverse est déjà écrite pour l'onglet Notes. */
    todos: db.prepare(`SELECT id, title, priority, due_at FROM todo
      WHERE link_kind = 'mr' AND link_ref = ? AND status = 'open'
      ORDER BY COALESCE(due_at, '9999'), id`).all(String(mr.id)),
    /* TOP 1 — les remarques écrites et jamais envoyées, dans l'en-tête du rapport aussi : c'est
       là qu'on décide de merger, et c'est le dernier moment où l'oubli est rattrapable. */
    drafts: (() => {
      const c = db.prepare('SELECT COUNT(*) n, MIN(created_at) AS depuis FROM mr_comment_draft WHERE mr_id = ?').get(mr.id);
      return c && c.n ? { n: c.n, depuis: c.depuis } : null;
    })(),
    /* B4 — LES NOTES QUI PARLENT DE CETTE MERGE REQUEST. L'autolien menait des notes vers
       elle ; l'inverse n'existait pas, et « on en avait parlé, où ? » se terminait en
       recherche plein texte à la main. Servi avec le rapport plutôt qu'en appel à part : le
       coût est un `LIKE` borné sur des notes locales, et un appel de plus par ouverture de
       rapport serait cher payé pour trois lignes. */
    citations: notes.citations({ mr: mr.iid }),
    // B7 — les cartes de domaine que ce diff touche (même calcul que la liste).
    cards: agentknowledge.cartesTouchees(agentknowledge.indexCartes(), mr.repo_id, mr.changed_paths),
    ticket_key: tkey,
    ticket_url: ticketUrl(getConfig(), tkey),
    // Commande pour reprendre la session d'agent de la review dans un terminal.
    resume_cmd: (() => {
      /* Le handle de la session de REVIEW a quitté la ligne `mr` : il ne vaut que dans le
         `~/.claude` de cette machine, alors que l'état de relecture de la MR, lui, se partage. */
      const h = localsession.lire('mr', mr.uid);
      return agentsession.resumeCommand(h.session_backend, h.session_key, h.session_cwd);
    })(),
    /* Session de CODAGE dont cette MR est issue, s'il y en a une. Sert à pré-remplir le champ
       « identifiant de session » quand on demande une correction : l'IA reprend alors le fil de
       son propre travail au lieu de redécouvrir le code. Simple proposition — le champ reste
       modifiable et effaçable, parce que la jointure (dépôt + branche source) n'est pas une
       preuve : une branche peut avoir été reprise à la main, ou par quelqu'un d'autre. */
    origin_session: originSessionKey(mr),
    origin_task: originTask(mr),
    /* CE QUE CETTE REVIEW A COÛTÉ. Les statistiques donnaient une MOYENNE par merge request,
       faute de propriétaire sur les usages de review : « ma review a-t-elle coûté cher ? »
       n'avait pas de réponse. Elle en a une maintenant, à l'endroit où on la lit. */
    tokens_est: (db.prepare(`SELECT SUM(tokens_est) n FROM usage
      WHERE owner_kind = 'mr' AND owner_id = ?`).get(mr.id) || {}).n || null,
    verification: (() => {
      const v = dernieresVerificationsParMr().get(mr.id);
      return v ? resumeVerification(detailVerification(v)) : null;
    })(),
    // Un vérificateur couvre-t-il ce dépôt ? Le bouton n'apparaît que si oui.
    verifiable: !!db.prepare('SELECT 1 FROM verifier_repo WHERE repo_id = ?').get(mr.repo_id),
    /* L'équipe partage-t-elle un dépôt de données ? Alors le rapport y a une adresse, et on
       peut publier ce LIEN sur la merge request plutôt que six cents lignes. Sans dépôt, le
       bouton n'aurait nulle part où pointer : il n'existe pas. */
    data_repo: datasync.estConfigure(),
    review: rev ? {
      md: readFileSafe(rev.md_path),
      explanation: readFileSafe(rev.explanation_path),
      updated_at: rev.updated_at,
      // Ce qui est DÉJÀ parti sur la merge request : le bouton « Publier » le dit, pour
      // qu'on ne poste pas deux fois le même rapport en croyant au premier échec.
      comment_posted_at: rev.comment_posted_at || null,
      /* Et pour le LIEN, la même chose — lue dans les commentaires déjà enregistrés, qui
         voyagent : le bouton dit donc aussi ce qu'un COLLÈGUE a déjà publié. */
      link_posted_at: (reviewer.lienDejaPublie(mr.id) || {}).at || null,
    } : null,
    comments,
    ticket: {
      text: mr.ticket_text || '',
      has_image: !!(mr.ticket_image && fs.existsSync(mr.ticket_image)),
      jira_text: mr.ticket_jira_text || '',
      // Clé stockée (après un fetch) ou, à défaut, déduite du titre/branche — pour
      // qu'une MR jamais fetchée sache tout de même qu'un ticket est récupérable.
      jira_key: mr.ticket_jira_key || jira.ticketKey(mr.title, mr.source_branch) || '',
      jira_at: mr.ticket_jira_at || '',
      jira_error: mr.ticket_jira_error || '',
      jira_configured: jira.isConfigured(getConfig()),
    },
    convergence: converge.latestRun(mr.id), // dernière boucle « Converger » (panneau)
    links: db.prepare(`SELECT ml.repo_id, ml.branch, repo.project, repo.forge FROM mr_link ml JOIN repo ON repo.id = ml.repo_id WHERE ml.mr_id = ?`).all(mr.id),
    repo_links: db.prepare(`SELECT rl.linked_repo_id AS repo_id, rl.branch, repo.project FROM repo_link rl JOIN repo ON repo.id = rl.linked_repo_id WHERE rl.repo_id = ?`).all(mr.repo_id),
    stale: mr.reviewed_sha && mr.reviewed_sha !== mr.current_sha,
  });
}));

// Enregistre le contexte du ticket (texte + capture facultative en data URL).
function saveTicketImage(mrId, dataUrl) {
  const m = /^data:image\/(png|jpe?g|webp|gif);base64,(.+)$/i.exec(dataUrl || '');
  if (!m) throw new Error(t('err.image-invalide-data-url-image'));
  const ext = m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase();
  ensureDir(TICKETS_DIR);
  for (const e of ['png', 'jpg', 'jpeg', 'webp', 'gif']) {
    try { fs.rmSync(path.join(TICKETS_DIR, `${mrId}.${e}`), { force: true }); } catch { /* rien */ }
  }
  const file = path.join(TICKETS_DIR, `${mrId}.${ext}`);
  fs.writeFileSync(file, Buffer.from(m[2], 'base64'));
  return file;
}

app.post('/api/mrs/:id/ticket', wrap((req, res) => {
  const mr = mrById(Number(req.params.id));
  if (!mr) throw new Error(t('err.mr-introuvable'));
  const { text, image, removeImage } = req.body || {};
  let imgPath = mr.ticket_image;
  if (removeImage && imgPath) { try { fs.rmSync(imgPath, { force: true }); } catch { /* rien */ } imgPath = null; }
  if (image) imgPath = saveTicketImage(mr.id, image);
  const texte = (text || '').trim();
  db.prepare('UPDATE mr SET ticket_text = ?, ticket_image = ?, updated_at = ? WHERE id = ?')
    .run(texte || null, imgPath, new Date().toISOString(), mr.id);
  res.json({ ok: true, has_text: !!texte, has_image: !!imgPath });
}));

app.get('/api/mrs/:id/ticket-image', (req, res) => {
  const mr = mrById(Number(req.params.id));
  if (!mr || !mr.ticket_image || !fs.existsSync(mr.ticket_image)) return res.status(404).end();
  return servirFichierNonFiable(res, { chemin: mr.ticket_image });
});

app.post('/api/mrs/:id/review', wrap((req, res) => {
  const mr = mrById(Number(req.params.id));
  if (!mr) throw new Error(t('err.mr-introuvable'));
  // explain absent → suit le réglage global ; présent → surcharge ponctuelle (true/false).
  const opts = {};
  if (req.body && req.body.explain != null) opts.explain = req.body.explain === true || req.body.explain === '1' || req.body.explain === 1;
  const job = jobs.startJob('review', [mr.id], opts);
  res.json(job);
}));

// Génère l'explication pédagogique à la demande pour une MR déjà reviewée (1 appel IA).
app.post('/api/mrs/:id/explain', wrap((req, res) => {
  const mr = mrById(Number(req.params.id));
  if (!mr) throw new Error(t('err.mr-introuvable'));
  const rev = db.prepare('SELECT id FROM review WHERE mr_id = ?').get(mr.id);
  if (!rev) throw new Error(t('err.explain-sans-review'));
  const job = jobs.startJob('explain', [mr.id]);
  res.json(job);
}));

app.get('/api/mrs/:id/diff', wrap(async (req, res) => {
  const mr = mrById(Number(req.params.id));
  if (!mr) throw new Error(t('err.mr-introuvable'));
  res.json({ diff: await diffDeLaMr(mr) });
}));

/* Diff d'une MR AVANT review : permet de juger une MR sans dépenser un appel IA
   (« si elle est triviale, je la classe direct »). Calculé en direct depuis le
   clone — qu'on s'assure d'abord d'avoir (clone/fetch à la demande, d'où le coût
   possible sur un premier accès à un gros dépôt). Sert aussi à réchauffer le clone
   pour que les endpoints /file et /filediff du viewer fonctionnent ensuite. */
app.get('/api/mrs/:id/diffview', wrap(async (req, res) => {
  const mr = mrById(Number(req.params.id));
  if (!mr) throw new Error(t('err.mr-introuvable'));
  // En démo, aucun clone n'est possible (la forge n'existe pas) : dépôt fictif servi tel quel.
  if (demoDiff.isDemo()) { res.json(demoDiff.viewFor(mr)); return; }
  const repo = db.prepare('SELECT * FROM repo WHERE id = ?').get(mr.repo_id);
  if (!repo) throw new Error(t('err.depot-introuvable'));
  const cfg = getConfig();
  const cwd = await git.ensureRepo(cfg, repo, () => {});
  /* Si la review a déjà stocké le diff, on le réutilise ; sinon calcul en direct — et le clone
     vient d'être mis à jour, donc `diffDeLaMr` n'a rien à aller chercher. */
  const diff = await diffDeLaMr(mr, cwd)
    || await git.targetedDiff(cwd, mr.source_branch, mr.target_branch, () => {});
  /* LA MÊME VERSION QUE LE RAPPORT. Le diff servi ici est celui de la review ; l'arborescence
     doit donc être celle du commit REVIEWÉ, pas de la tête de branche — sinon, dès que la
     branche avance, l'écran mélange deux versions : un fichier listé d'après la tête, un
     contenu et des numéros de ligne venus du commit reviewé (routes `/file` et `/filediff`,
     qui visent `reviewed_sha`). Repli sur la tête si l'objet n'est plus là (force-push),
     comme le fait déjà `/tree`. */
  const vise = mr.reviewed_sha && await git.refExists(cwd, mr.reviewed_sha)
    ? mr.reviewed_sha : `origin/${mr.source_branch}`;
  const ctx = { cwd, ref: vise, target: mr.target_branch || 'main' };
  res.json(await viewerPayload(ctx, { diff, source: mr.source_branch }));
}));

// Ensemble des fichiers modifiés (chemins « b/ ») extraits d'un diff unifié.
function changedFilesFromDiff(diff) {
  const set = new Set();
  if (!diff) return set;
  const re = /^diff --git a\/(.+?) b\/(.+)$/gm;
  let m;
  while ((m = re.exec(diff))) set.add(m[2]);
  return set;
}
/* LE DIFF D'UNE REVIEW EST UN FICHIER DE CETTE MACHINE — et le collègue ne l'a pas.
 *
 * `review.diff_path` est un chemin local : il ne part pas dans le dépôt de données, et il n'y
 * aurait aucun sens. Le poste qui REÇOIT une review ouvrait donc « le code » sur un arbre sans
 * un seul fichier colorié et un diff vide — le rapport était arrivé, le code à côté duquel le
 * lire, non.
 *
 * On le RECALCULE depuis son clone quand le fichier manque. Un diff de merge request n'est pas
 * une donnée à transporter : c'est une fonction de deux références que tout le monde a. On vise
 * le commit RELU tant que le clone le porte — c'est de celui-là que parle le rapport, et c'est
 * l'arbre qu'on affiche à côté — et on retombe sur la tête de branche sinon (force-push,
 * branche avancée depuis).
 *
 * Aucun `fetch` tant que les références sont là : `/diff` et `/tree` partent EN PARALLÈLE
 * depuis l'écran, et deux fetch simultanés dans le même clone se disputeraient ses verrous.
 */
async function diffDeLaMr(mr, cwdConnu = null) {
  const rev = db.prepare('SELECT diff_path FROM review WHERE mr_id = ?').get(mr.id);
  const garde = rev ? readFileSafe(rev.diff_path) : null;
  if (garde) return garde;
  const repo = db.prepare('SELECT * FROM repo WHERE id = ?').get(mr.repo_id);
  if (!repo || !mr.target_branch || !(mr.reviewed_sha || mr.source_branch)) return null;
  try {
    let cwd = cwdConnu || git.cloneDirFor(getConfig(), repo);
    const base = `origin/${mr.target_branch}`;
    const vise = async () => (mr.reviewed_sha && await git.refExists(cwd, mr.reviewed_sha)
      ? mr.reviewed_sha
      : (mr.source_branch && await git.refExists(cwd, `origin/${mr.source_branch}`)
        ? `origin/${mr.source_branch}` : null));
    let ref = await vise();
    /* LE CLONE PEUT ÊTRE EN RETARD : une branche créée après le dernier fetch n'y est pas
       encore. On ne va chercher qu'à ce moment-là — pas à chaque ouverture. */
    if (!cwdConnu && (!ref || !await git.refExists(cwd, base))) {
      cwd = await git.ensureRepo(getConfig(), repo, () => {});
      ref = await vise();
    }
    if (!ref || !await git.refExists(cwd, base)) return null;
    return await git.diffTroisPoints(cwd, base, ref);
  } catch { return null; }
}

function mrCloneCtx(mr) {
  const cfg = getConfig();
  const cwd = git.cloneDirFor(cfg, { project: mr.project, forge: mr.forge });
  if (!fs.existsSync(path.join(cwd, '.git'))) {
    throw new Error(t('err.depot-non-clone-localement-lance'));
  }
  const ref = mr.reviewed_sha || `origin/${mr.source_branch}`;
  return { cwd, ref, target: mr.target_branch || 'main' };
}

/* Même contexte pour un PROJET DE SESSION : le viewer plein écran est identique,
   seule la source change (la branche produite par l'IA au lieu de la MR). On vise le
   commit exact produit par la session quand il existe — la branche a pu bouger depuis. */
function targetCloneCtx(tg) {
  const cfg = getConfig();
  const repo = db.prepare('SELECT * FROM repo WHERE id = ?').get(tg.repo_id);
  if (!repo) throw new Error(t('err.depot-introuvable'));
  const cwd = git.cloneDirFor(cfg, repo);
  // Message propre à la session : parler de « relancer une review » n'aurait aucun sens ici.
  if (!fs.existsSync(path.join(cwd, '.git'))) throw new Error(t('err.depot-non-clone-session'));
  return { cwd, ref: tg.commit_sha || `origin/${tg.branch}`, target: tg.base_branch || 'main' };
}

/* --- Corps des trois routes du viewer, partagés MR / session ---------------
   Le chemin demandé est TOUJOURS validé contre l'arborescence de la ref : c'est
   ce qui empêche de lire un fichier hors du dépôt (traversal). */
async function viewerFile(ctx, p) {
  if (!p) throw new Error(t('err.path-requis'));
  const files = await git.lsTree(ctx.cwd, ctx.ref).catch(() => []);
  if (!files.includes(p)) throw new Error(t('err.fichier-hors-arborescence'));
  let content = await git.showFile(ctx.cwd, ctx.ref, p);
  if (content.indexOf(String.fromCharCode(0)) !== -1) content = '(fichier binaire, non affiche)';
  return { path: p, content };
}
async function viewerFileDiff(ctx, p) {
  if (!p) throw new Error(t('err.path-requis'));
  const files = await git.lsTree(ctx.cwd, ctx.ref).catch(() => []);
  if (!files.includes(p)) throw new Error(t('err.fichier-hors-arborescence'));
  let diff = '';
  /* `shaRange` : les deux bornes sont des COMMITS, pas une branche de départ. C'est le cas
     quand on relit une seule itération de codage — `fileDiffFull` préfixerait la base par
     `origin/`, et `origin/<sha>` n'existe pas. */
  try {
    diff = ctx.shaRange
      ? await git.fileDiffRange(ctx.cwd, ctx.target, ctx.ref, p)
      : await git.fileDiffFull(ctx.cwd, ctx.target, ctx.ref, p);
  } catch { diff = ''; }
  return { diff };
}
// Charge utile d'ouverture du viewer : diff complet + arbre marqué + compteurs.
async function viewerPayload(ctx, { diff, source }) {
  const changed = changedFilesFromDiff(diff);
  let files = [];
  try { files = await git.lsTree(ctx.cwd, ctx.ref); } catch { /* arbre indisponible */ }
  return {
    diff,
    source,
    target: ctx.target,
    files: files.map((f) => ({ path: f, changed: changed.has(f) })),
    stats: {
      files: changed.size,
      added: (diff.match(/^\+(?!\+\+)/gm) || []).length,
      removed: (diff.match(/^-(?!--)/gm) || []).length,
    },
  };
}

// Arborescence du projet à la version reviewée + marquage des fichiers modifiés.
app.get('/api/mrs/:id/tree', wrap(async (req, res) => {
  const mr = mrById(Number(req.params.id));
  if (!mr) throw new Error(t('err.mr-introuvable'));
  if (demoDiff.isDemo()) { res.json(demoDiff.treeFor(mr)); return; }
  const { cwd, ref } = mrCloneCtx(mr);
  let files;
  try { files = await git.lsTree(cwd, ref); }
  catch { files = await git.lsTree(cwd, `origin/${mr.source_branch}`); }
  const changed = changedFilesFromDiff(await diffDeLaMr(mr, cwd));
  res.json({ ref, target: mr.target_branch, files: files.map((f) => ({ path: f, changed: changed.has(f) })) });
}));

// Contenu complet d'un fichier à la version reviewée (validé contre l'arborescence).
app.get('/api/mrs/:id/file', wrap(async (req, res) => {
  const mr = mrById(Number(req.params.id));
  if (!mr) throw new Error(t('err.mr-introuvable'));
  if (demoDiff.isDemo()) { res.json(demoDiff.fileFor(mr, String(req.query.path || ''))); return; }
  res.json(await viewerFile(mrCloneCtx(mr), String(req.query.path || '')));
}));

// Diff d'un fichier à contexte complet (fichier entier + changements surlignés).
app.get('/api/mrs/:id/filediff', wrap(async (req, res) => {
  const mr = mrById(Number(req.params.id));
  if (!mr) throw new Error(t('err.mr-introuvable'));
  if (demoDiff.isDemo()) { res.json(demoDiff.fileDiffFor(mr, String(req.query.path || ''))); return; }
  res.json(await viewerFileDiff(mrCloneCtx(mr), String(req.query.path || '')));
}));

app.post('/api/mrs/:id/rereview', wrap((req, res) => {
  const mr = mrById(Number(req.params.id));
  if (!mr) throw new Error(t('err.mr-introuvable'));
  if (mr.status === 'done') throw new Error(t('err.mr-marquee-done-re-review'));
  // incremental : ne reviewer que le delta depuis le dernier SHA reviewé (best-effort :
  // reviewMr retombe sur une review complète s'il n'y a pas de delta exploitable).
  const incremental = !!(req.body && (req.body.incremental === true || req.body.incremental === '1'));
  const job = jobs.startJob('rereview', [mr.id], { incremental });
  res.json(job);
}));

// « Converger » : boucle autonome review → correction IA (commit + push) → re-review
// incrémentale, jusqu'au seuil / à la régression / au plafond. JAMAIS de merge.
// seuil et plafond : réglage global par défaut, surchargeables au lancement.
app.post('/api/mrs/:id/converge', wrap(async (req, res) => {
  const mr = mrById(Number(req.params.id));
  if (!mr) throw new Error(t('err.mr-introuvable'));
  if (mr.status === 'done') throw new Error(t('err.mr-marquee-done-re-review'));
  await gardeConfigAgent(db.prepare('SELECT * FROM repo WHERE id = ?').get(mr.repo_id), mr.source_branch, mr.target_branch, req.body);
  const job = jobs.startConvergeJob(mr.id, parseConvergeOpts(req.body));
  res.json(job);
}));

// « Corriger la review » : crée une Dev session qui applique les corrections de la
// review sur la branche de la MR, et la lance.
/* La consigne qui applique un rapport de revue au code : un seul texte pour « Faire corriger
   par l'IA » et pour chaque passe de Converger, pris dans les réglages et traduit comme les
   autres gabarits. Vide → le défaut de la langue courante. */
function promptCorrection(mr, reviewMd) {
  return reviewer.fillTemplate(prompts.gabarit('prompt_fix', getConfig()), {
    source: mr.source_branch, target: mr.target_branch || '', report: nonFiable('rapport de revue', reviewMd),
  });
}

app.post('/api/mrs/:id/fix-review', wrap(async (req, res) => {
  const mr = mrById(Number(req.params.id));
  if (!mr) throw new Error(t('err.mr-introuvable'));
  await gardeConfigAgent(db.prepare('SELECT * FROM repo WHERE id = ?').get(mr.repo_id), mr.source_branch, mr.target_branch, req.body);
  const rev = db.prepare('SELECT md_path FROM review WHERE mr_id = ?').get(mr.id);
  const reviewMd = rev ? readFileSafe(rev.md_path) : null;
  if (!reviewMd) throw new Error(t('err.aucune-review-a-corriger-pour'));
  const branch = assertValidBranch(mr.source_branch);
  /* LE GABARIT, PAS UN TEXTE EN DUR. Cette consigne était recopiée ici ET dans `converge.js` :
     deux copies françaises, hors `prompts.js`, donc ni traduites ni éditables — et sûres de
     diverger le jour où l'une des deux serait retouchée. */
  const prompt = promptCorrection(mr, reviewMd);
  const now = new Date().toISOString();
  const info = db.prepare(`INSERT INTO task (repo_id, kind, prompt, branch, base_branch, commit_message, auto_push, status, created_at, updated_at)
    VALUES (?, 'code', ?, ?, ?, ?, 0, 'new', ?, ?)`).run(
    mr.repo_id, prompt, branch, mr.target_branch || null, `${branch}: corrections review !${mr.iid}`, now, now);
  const taskId = info.lastInsertRowid;
  // la session porte sur UN projet : la branche de la MR à corriger
  insertTargets(taskId, [{ repo_id: mr.repo_id, branch }]);
  jobs.startTaskJob(taskId, 'run');
  res.json({ ok: true, task_id: taskId });
}));

// Historique des reviews d'une MR : chaque passe est conservée.
/* DE COMBIEN UNE REVIEW EST-ELLE PÉRIMÉE ? Le badge disait « périmé » sans dire l'ampleur :
   trois lignes ou un refactoring, on ne relance pas pour la même raison. La réponse coûte un
   appel à la forge : on ne la demande donc QU'AU SURVOL du badge, jamais pour la liste
   entière. Une comparaison impossible (branche réécrite, force-push) n'est pas une erreur —
   c'est « on ne sait pas », et le badge reste ce qu'il était. */
/* ---------- Le résumé d'une merge request, pour une bulle ----------
   Un autolien `!214` dans une note ou une todo ne disait que son numéro : on cliquait, on
   changeait d'écran, on lisait, on revenait. Quatre faits suffisent — titre, note, verdict,
   état — et ils tiennent dans une bulle. Route à part et minuscule : le détail complet
   (`/api/mrs/:id`) charrie le rapport entier, ce qui n'a pas sa place au survol. */
app.get('/api/mrs/:id/resume', wrap((req, res) => {
  const mr = mrById(Number(req.params.id));
  if (!mr) throw new Error(t('err.mr-introuvable'));
  const v = db.prepare(`SELECT note_value FROM review_version WHERE mr_id = ?
    ORDER BY version DESC LIMIT 1`).get(mr.id);
  const verif = dernieresVerificationsParMr().get(mr.id);
  res.json({
    iid: mr.iid, title: mr.title, project: mr.project, status: mr.status,
    closed: !!mr.closed_seen, author: mr.author || '',
    note: v ? v.note_value : null, verdict: verif ? verif.verdict : null,
    created_at: mr.gitlab_created_at || null,
  });
}));

app.get('/api/mrs/:id/stale-commits', wrap(async (req, res) => {
  const mr = mrById(Number(req.params.id));
  if (!mr) throw new Error(t('err.mr-introuvable'));
  if (!mr.reviewed_sha || !mr.current_sha || mr.reviewed_sha === mr.current_sha) {
    res.json({ known: true, count: 0, commits: [] });
    return;
  }
  try {
    const commits = await forge.clientFor(mr).commitsSince(getConfig(), mr.project, mr.reviewed_sha, mr.current_sha);
    res.json({ known: true, count: commits.length, commits: commits.slice(0, 10) });
  } catch { res.json({ known: false, count: 0, commits: [] }); }
}));

app.get('/api/mrs/:id/versions', wrap((req, res) => {
  const rows = db.prepare(`SELECT version, note_value, reviewed_sha, kind, created_at, instruction,
    n_new, n_persistent, n_resolved, n_disappeared
    FROM review_version WHERE mr_id = ? ORDER BY version DESC`).all(Number(req.params.id));
  res.json(rows.map((v) => ({
    version: v.version,
    note10: v.note_value == null ? null : Math.round(v.note_value * 100) / 10,
    sha: v.reviewed_sha ? String(v.reviewed_sha).slice(0, 8) : null,
    kind: v.kind,
    created_at: v.created_at,
    instruction: v.instruction || null,   // demande à l'origine d'une régénération
    // Delta de résolution (renseigné dès la 2e passe) pour le bandeau du rapport.
    resolution: v.n_resolved == null ? null
      : { resolved: v.n_resolved, persistent: v.n_persistent, new: v.n_new, disappeared: v.n_disappeared },
  })));
}));

// Constats structurés d'une version (par défaut la dernière), avec leur statut.
// Alimente la liste détaillée sous le bandeau du rapport.
app.get('/api/mrs/:id/findings', wrap((req, res) => {
  const id = Number(req.params.id);
  const version = req.query.v
    ? Number(req.query.v)
    : (db.prepare('SELECT MAX(version) v FROM finding WHERE mr_id = ?').get(id) || {}).v;
  if (!version) return res.json({ version: null, findings: [] });
  const rows = db.prepare(`SELECT fingerprint, file, line, severity, title, status
    FROM finding WHERE mr_id = ? AND version = ?
    ORDER BY CASE status WHEN 'new' THEN 0 WHEN 'persistent' THEN 1 WHEN 'resolved' THEN 2 ELSE 3 END,
             CASE severity WHEN 'blocker' THEN 0 WHEN 'major' THEN 1 WHEN 'minor' THEN 2 ELSE 3 END,
             file`).all(id, version);
  /* DEPUIS QUAND CE CONSTAT EST-IL LÀ ? « Persistant » dit qu'il était déjà à la passe
     précédente ; il ne dit pas qu'il traîne depuis la première. Le `fingerprint` est stable
     d'une passe à l'autre — la donnée était là, personne ne la lisait. Une requête pour toute
     la liste, pas une par constat. */
  const depuis = {};
  for (const r of db.prepare('SELECT fingerprint, MIN(version) v FROM finding WHERE mr_id = ? GROUP BY fingerprint').all(id)) {
    depuis[r.fingerprint] = r.v;
  }
  res.json({
    version,
    findings: rows.map((r) => ({ ...r, since: depuis[r.fingerprint] || version })),
  });
}));

// Contenu d'une version précise (pour relire une review antérieure).
app.get('/api/mrs/:id/versions/:v', wrap((req, res) => {
  const v = db.prepare('SELECT * FROM review_version WHERE mr_id = ? AND version = ?')
    .get(Number(req.params.id), Number(req.params.v));
  if (!v) throw new Error(t('err.version-introuvable'));
  res.json({
    version: v.version,
    md: readFileSafe(v.md_path),
    explanation: readFileSafe(v.explanation_path),
    note10: v.note_value == null ? null : Math.round(v.note_value * 100) / 10,
    created_at: v.created_at,
  });
}));

app.post('/api/mrs/:id/modify', wrap((req, res) => {
  const mr = mrById(Number(req.params.id));
  if (!mr) throw new Error(t('err.mr-introuvable'));
  const instruction = (req.body && req.body.instruction || '').trim();
  if (!instruction) throw new Error(t('err.instruction-requise'));
  // même pipeline que la review (job de fond + log en direct + sortie fichier)
  const job = jobs.startJob('modify', [mr.id], { instruction });
  res.json(job);
}));

/* POSER UNE QUESTION SUR LE RAPPORT, sans le réécrire.
 *
 * « Demander une modification » (au-dessus) régénère le rapport et en fait une version de plus :
 * demander un éclaircissement coûtait donc le rapport qu'on lisait, et la note pouvait bouger au
 * passage. Une question ne produit ni version, ni note, ni fichier de rapport — juste un échange
 * de plus dans l'historique. Ce n'est pas une promesse faite au prompt : `askReview` n'écrit
 * nulle part ailleurs. */
app.post('/api/mrs/:id/ask', wrap((req, res) => {
  const mr = mrById(Number(req.params.id));
  if (!mr) throw new Error(t('err.mr-introuvable'));
  const question = (req.body && req.body.question || '').trim();
  if (!question) throw new Error(t('err.question-requise'));
  const job = jobs.startJob('ask-review', [mr.id], { question });
  res.json(job);
}));

/* Les questions posées sur cette revue, et leurs réponses — même forme, même écran et même
   recherche que les itérations d'une session : `passesPayload` ne connaît que des scopes. */
app.get('/api/mrs/:id/passes', wrap((req, res) => {
  const mr = mrById(Number(req.params.id));
  if (!mr) throw new Error(t('err.mr-introuvable'));
  res.json(passesPayload('review', 0, mr.id, req.query.n, `!${mr.iid} — ${mr.title || ''}`.trim(), null));
}));

// B6 : symétrique de /mrs/:id/clear-error — sinon l'erreur d'une tâche revient à chaque refresh.
app.post('/api/tasks/:id/clear-error', wrap((req, res) => {
  db.prepare('UPDATE task SET last_error = NULL WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
}));

/* Même geste pour une session hors dépôt. Sans cette route, la croix de l'encart d'erreur
   retirait la boîte de l'écran et l'erreur revenait au rafraîchissement suivant : un bouton
   qui a l'air de marcher est pire qu'un bouton absent. */
/* Relance CIBLÉE d'une session hors dépôt : un dossier précis, ou ceux qui ont échoué. Même
   contrat que `POST /api/tasks/:id/run` avec ses `targets` — les dossiers d'une session sont
   indépendants les uns des autres, et refaire les quatre qui ont réussi coûte quatre passes
   d'agent pour rien. Corps vide = toute la session, comme avant. */
function normalizeDirIds(taskId, brut) {
  if (!Array.isArray(brut) || !brut.length) return null;
  const connus = new Set(db.prepare('SELECT id FROM local_task_dir WHERE task_id = ?').all(taskId).map((d) => d.id));
  const ids = [...new Set(brut.map(Number).filter((n) => connus.has(n)))];
  if (!ids.length) throw new Error(t('err.local-dir-not-found'));
  return ids;
}

app.post('/api/local-tasks/:id/clear-error', wrap((req, res) => {
  db.prepare('UPDATE local_task SET last_error = NULL WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
}));

app.post('/api/mrs/:id/clear-error', wrap((req, res) => {
  db.prepare('UPDATE mr SET last_error = NULL WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
}));

app.post('/api/mrs/:id/done', wrap((req, res) => {
  const mr = mrById(Number(req.params.id));
  if (!mr) throw new Error(t('err.mr-introuvable'));
  db.prepare(`UPDATE mr SET status = 'done', updated_at = ? WHERE id = ?`).run(new Date().toISOString(), mr.id);
  res.json({ ok: true });
}));

app.post('/api/mrs/:id/reopen', wrap((req, res) => {
  const mr = mrById(Number(req.params.id));
  if (!mr) throw new Error(t('err.mr-introuvable'));
  const rev = db.prepare('SELECT 1 FROM review WHERE mr_id = ?').get(mr.id);
  db.prepare(`UPDATE mr SET status = ?, updated_at = ? WHERE id = ?`)
    .run(rev ? 'reviewed' : 'to_review', new Date().toISOString(), mr.id);
  res.json({ ok: true });
}));

// Supprime le rapport d'une MR (fichiers + ligne en base) et la remet « à reviewer ».
app.post('/api/mrs/:id/delete-review', wrap((req, res) => {
  const mr = mrById(Number(req.params.id));
  if (!mr) throw new Error(t('err.mr-introuvable'));
  const rev = db.prepare('SELECT * FROM review WHERE mr_id = ?').get(mr.id);
  if (rev) {
    for (const p of [rev.md_path, rev.explanation_path, rev.diff_path]) {
      try { if (p && fs.existsSync(p)) fs.rmSync(p, { force: true }); } catch { /* best-effort */ }
    }
    db.prepare('DELETE FROM review WHERE mr_id = ?').run(mr.id);
  }
  /* Les questions posées SUR ce rapport partent avec lui : elles le citent, et les relire sans
     lui ne dirait plus rien de ce qui a été demandé. Pas de clé étrangère (plusieurs tables
     parentes selon le scope), donc le ménage est explicite — comme pour les sessions. */
  agentpass.removeTask('review', mr.id);
  try { fs.rmSync(path.join(TASKS_DIR, 'review', String(mr.id)), { recursive: true, force: true }); } catch { /* rien */ }
  db.prepare("UPDATE mr SET status = 'to_review', reviewed_sha = NULL, updated_at = ? WHERE id = ?")
    .run(new Date().toISOString(), mr.id);
  res.json({ ok: true });
}));

app.post('/api/mrs/:id/comment', wrap(async (req, res) => {
  const mr = mrById(Number(req.params.id));
  if (!mr) throw new Error(t('err.mr-introuvable'));
  const body = (req.body && req.body.body || '').trim();
  if (!body) throw new Error(t('err.commentaire-vide'));
  if (demoDocker.isDemo()) return res.json({ ok: true, note_id: demoComments.post(mr.id, body, null).notes[0].id });
  const cfg = getConfig();
  const note = await forge.clientFor(mr).postMrNote(cfg, mr.project, mr.iid, body);
  db.prepare('INSERT INTO comment_log (mr_id, body, gitlab_note_id, sent_at) VALUES (?,?,?,?)')
    .run(mr.id, body, note && note.id, new Date().toISOString());
  res.json({ ok: true, note_id: note && note.id });
}));

/* PUBLIER LE RAPPORT DE REVIEW sur la merge request, à la demande.
 *
 * Le corps n'est PAS reçu du navigateur : la route relit le rapport sur le disque, par la
 * même fonction que la publication automatique (`reviewer.publierRapport`). Accepter un texte
 * du client ouvrirait la porte à publier autre chose que le rapport, sous son nom. */
/* CE QUE LA FORGE DIT DE CETTE MERGE REQUEST, MAINTENANT.
 *
 * Interrogée à l'ouverture de la modale de merge : on est à un clic d'une action irréversible
 * et visible de toute l'équipe. « Elle est en conflit » doit se lire AVANT, pas dans le message
 * d'erreur qui suivra le refus. Un appel d'API à ce moment-là est largement payé.
 *
 * Ce qu'on apprend est ÉCRIT : la merge request le garde, et les projets de session qui
 * pointent la même branche aussi — leur bouton « Mettre à jour avec … » apparaît donc sans
 * attendre la prochaine découverte. */
async function etatFusion(mr) {
  const reponse = (c) => ({
    has_conflicts: c === null || c === undefined ? null : !!c,
    target_branch: mr.target_branch,
  });
  // En démo, la forge n'existe pas : on rend ce qui est en base plutôt qu'une erreur.
  if (demoDocker.isDemo()) return reponse(mr.has_conflicts);
  const m = await forge.clientFor(mr).getMergeRequest(getConfig(), mr.project, mr.iid);
  const c = m && m.has_conflicts === true ? 1 : (m && m.has_conflicts === false ? 0 : null);
  db.prepare('UPDATE mr SET has_conflicts = ? WHERE id = ?').run(c, mr.id);
  db.prepare('UPDATE task_target SET mr_conflicts = ? WHERE repo_id = ? AND branch = ?')
    .run(c, mr.repo_id, mr.source_branch);
  return { ...reponse(c), target_branch: (m && m.target_branch) || mr.target_branch };
}

app.get('/api/mrs/:id/merge-check', wrap(async (req, res) => {
  const mr = mrById(Number(req.params.id));
  if (!mr) throw new Error(t('err.mr-introuvable'));
  res.json(await etatFusion(mr));
}));

/* Même question, posée depuis un projet de session — c'est le seul chemin où l'on peut aussi
   proposer le rattrapage, puisqu'il faut une session pour rejouer la branche. */
app.get('/api/tasks/:id/targets/:tid/merge-check', wrap(async (req, res) => {
  const tg = targetById(Number(req.params.id), Number(req.params.tid));
  if (!tg) throw new Error(t('err.projet-introuvable-pour-cette-session'));
  const iid = tg.mr_iid || tg.existing_mr_iid;
  const mr = iid && db.prepare(`SELECT mr.*, repo.project AS project, repo.forge AS forge
    FROM mr JOIN repo ON repo.id = mr.repo_id WHERE mr.repo_id = ? AND mr.iid = ?`).get(tg.repo_id, iid);
  if (!mr) throw new Error(t('err.mr-introuvable'));
  const etat = await etatFusion(mr);
  /* Le rattrapage n'est proposé que s'il y a de quoi le faire : une branche de travail, une
     branche de départ, et un projet dont le travail est posé. */
  return res.json({
    ...etat,
    base_branch: tg.base_branch || mr.target_branch,
    branch: tg.branch,
    rebasable: !!tg.branch && ['committed', 'pushed', 'error'].includes(tg.status),
  });
}));

app.post('/api/mrs/:id/publish-review', wrap(async (req, res) => {
  const mr = mrById(Number(req.params.id));
  if (!mr) throw new Error(t('err.mr-introuvable'));
  res.json({ ok: true, ...(await reviewer.publierRapport(mr, getConfig())) });
}));

/* PUBLIER LE LIEN DU RAPPORT, quand l'équipe a un dépôt de données. Comme ci-dessus, rien du
   corps n'est reçu du navigateur : l'adresse est CALCULÉE à partir du fichier que la ligne
   occupe dans le dépôt, sinon la route serait un moyen de poster n'importe quel lien sous le
   nom de l'utilisateur. */
app.post('/api/mrs/:id/publish-review-link', wrap(async (req, res) => {
  const mr = mrById(Number(req.params.id));
  if (!mr) throw new Error(t('err.mr-introuvable'));
  res.json({ ok: true, ...(await reviewer.publierLienRapport(mr, getConfig())) });
}));

/* Compte associé au jeton d'une forge. Sert à reconnaître MES commentaires, donc ceux que
   je peux modifier. Mis en cache : sans cela, chaque ouverture de rapport ajouterait un
   aller-retour réseau pour une réponse qui ne change jamais. Un échec n'est pas une erreur —
   il rend simplement les commentaires non modifiables, ce qui est le repli sûr. */
const meCache = new Map();               // forge -> { username, name, at }
const ME_TTL_MS = 30 * 60 * 1000;
/* Le compte du jeton, par forge. On garde le PSEUDO **et** le nom affiché : les merge requests
   stockent l'un ou l'autre selon la forge (GitLab pose `author.name`, GitHub le `login`), et
   savoir « est-ce la mienne ? » demande de pouvoir reconnaître les deux. */
async function forgeIdentite(nomForge) {
  const hit = meCache.get(nomForge);
  if (hit && Date.now() - hit.at < ME_TTL_MS) return hit;
  try {
    const u = await forge.clientFor(nomForge).currentUser(getConfig());
    const ident = { username: (u && u.username) || '', name: (u && u.name) || '', at: Date.now() };
    meCache.set(nomForge, ident);
    return ident;
  } catch { return { username: '', name: '', at: 0 }; }
}
async function forgeUsername(mr) {
  return (await forgeIdentite(forge.forgeOf(mr))).username;
}

/* QUI SUIS-JE, SUR CHAQUE FORGE. Sert au filtre « mes merge requests / les autres » : un tech
   lead trie d'abord ce que les AUTRES attendent de lui. Route à part et appelée une fois au
   démarrage — jamais depuis `/status`, qui est sondé toutes les deux secondes. Un échec n'est
   pas une erreur : la réponse est vide, et le filtre ne s'affiche simplement pas. */
app.get('/api/me', wrap(async (req, res) => {
  const cfg = getConfig();
  const out = {};
  if (cfg.gitlab_url && cfg.access_token) out.gitlab = await forgeIdentite('gitlab');
  if (cfg.github_token) out.github = await forgeIdentite('github');
  for (const k of Object.keys(out)) delete out[k].at;
  res.json(out);
}));

// Liste les discussions (commentaires) de la MR : inline (avec position) + générales.
app.get('/api/mrs/:id/discussions', wrap(async (req, res) => {
  const mr = mrById(Number(req.params.id));
  if (!mr) throw new Error(t('err.mr-introuvable'));
  const [discs, me] = demoDocker.isDemo()
    ? [demoComments.list(mr.id), demoComments.ME]
    : await Promise.all([
      forge.clientFor(mr).listMrDiscussions(getConfig(), mr.project, mr.iid),
      forgeUsername(mr),
    ]);
  const simplified = discs.map((d) => ({
    id: d.id,
    notes: (d.notes || []).filter((n) => !n.system).map((n) => ({
      id: n.id,
      author: (n.author && (n.author.name || n.author.username)) || '',
      // Modifiable si le compte du jeton est l'auteur. On compare sur le `username`
      // (identifiant) et jamais sur le nom affiché, qui n'est pas unique.
      editable: !!(me && n.author && n.author.username === me),
      body: n.body,
      created_at: n.created_at,
      resolved: !!n.resolved,
      position: n.position ? {
        new_path: n.position.new_path, old_path: n.position.old_path,
        new_line: n.position.new_line, old_line: n.position.old_line,
      } : null,
    })),
  })).filter((d) => d.notes.length);
  res.json({ discussions: simplified });
}));

/* Modifie un commentaire déjà posté. `inline` dit s'il s'agit d'un commentaire de ligne :
   GitHub range les deux familles sous des ressources différentes (GitLab n'en a qu'une).
   Les droits ne sont pas re-vérifiés ici : c'est la forge qui les détient, et elle refuse
   la modification du commentaire d'un autre. Le bouton, lui, n'apparaît que sur les miens. */
app.put('/api/mrs/:id/notes/:noteId', wrap(async (req, res) => {
  const mr = mrById(Number(req.params.id));
  if (!mr) throw new Error(t('err.mr-introuvable'));
  const body = (req.body && req.body.body || '').trim();
  if (!body) throw new Error(t('err.commentaire-vide'));
  if (demoDocker.isDemo()) {
    const n = demoComments.update(mr.id, req.params.noteId, body);
    return res.json({ ok: true, id: n.id, body: n.body });
  }
  const note = await forge.clientFor(mr).updateNote(
    getConfig(), mr.project, mr.iid, req.params.noteId, body, { inline: !!(req.body && req.body.inline) },
  );
  res.json({ ok: true, id: note && note.id, body: (note && note.body) || body });
}));

// Répond à une discussion existante.
app.post('/api/mrs/:id/discussions/:discussionId/reply', wrap(async (req, res) => {
  const mr = mrById(Number(req.params.id));
  if (!mr) throw new Error(t('err.mr-introuvable'));
  const body = (req.body && req.body.body || '').trim();
  if (!body) throw new Error(t('err.reponse-vide'));
  if (demoDocker.isDemo()) return res.json({ ok: true, id: demoComments.reply(mr.id, req.params.discussionId, body).id });
  const note = await forge.clientFor(mr).replyToDiscussion(getConfig(), mr.project, mr.iid, req.params.discussionId, body);
  res.json({ ok: true, id: note && note.id });
}));

// Commentaire inline sur une ligne précise d'un fichier de la MR.
app.post('/api/mrs/:id/discussion', wrap(async (req, res) => {
  const mr = mrById(Number(req.params.id));
  if (!mr) throw new Error(t('err.mr-introuvable'));
  const { body, old_path, new_path, old_line, new_line } = req.body || {};
  if (!(body || '').trim()) throw new Error(t('err.commentaire-vide-2'));
  if (!new_path && !old_path) throw new Error(t('err.fichier-requis'));
  if (demoDocker.isDemo()) {
    const d = demoComments.post(mr.id, body.trim(), { new_path, old_path, new_line, old_line });
    return res.json({ ok: true, id: d.id });
  }
  const cfg = getConfig();
  const full = await forge.clientFor(mr).getMergeRequest(cfg, mr.project, mr.iid);
  const dr = full && full.diff_refs;
  if (!dr || !dr.head_sha) throw new Error(t('err.references-de-diff-introuvables-la'));
  const position = {
    base_sha: dr.base_sha, start_sha: dr.start_sha, head_sha: dr.head_sha,
    position_type: 'text',
    old_path: old_path || new_path, new_path: new_path || old_path,
  };
  if (new_line != null && new_line !== '') position.new_line = Number(new_line);
  if (old_line != null && old_line !== '') position.old_line = Number(old_line);
  const disc = await forge.clientFor(mr).postMrDiscussion(cfg, mr.project, mr.iid, body.trim(), position);
  res.json({ ok: true, id: disc && disc.id });
}));

/* ---------- Commentaires inline EN ATTENTE ----------------------------------
   On relit une MR fichier par fichier et on écrit ses remarques au fil de la lecture. Les
   envoyer une par une bombarde l'auteur de notifications et fige des remarques qu'on aurait
   retirées trois fichiers plus loin. Ils vivent donc en local, modifiables, jusqu'à un envoi
   explicite — et le geste direct (POST /discussion) reste inchangé pour qui le préfère. */

const brouillonsDe = (mrId) => db.prepare('SELECT * FROM mr_comment_draft WHERE mr_id = ? ORDER BY id').all(mrId);

const lireLigne = (v) => (v == null || v === '' ? null : Number(v));

app.get('/api/mrs/:id/comment-drafts', wrap((req, res) => {
  const mr = mrById(Number(req.params.id));
  if (!mr) throw new Error(t('err.mr-introuvable'));
  res.json({ drafts: brouillonsDe(mr.id) });
}));

app.post('/api/mrs/:id/comment-drafts', wrap((req, res) => {
  const mr = mrById(Number(req.params.id));
  if (!mr) throw new Error(t('err.mr-introuvable'));
  const { body, old_path, new_path, old_line, new_line } = req.body || {};
  if (!(body || '').trim()) throw new Error(t('err.commentaire-vide-2'));
  if (!new_path && !old_path) throw new Error(t('err.fichier-requis'));
  const now = new Date().toISOString();
  const info = db.prepare(`INSERT INTO mr_comment_draft
    (mr_id, old_path, new_path, old_line, new_line, body, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?)`).run(mr.id, old_path || null, new_path || null,
    lireLigne(old_line), lireLigne(new_line), String(body).trim(), now, now);
  res.json(db.prepare('SELECT * FROM mr_comment_draft WHERE id = ?').get(info.lastInsertRowid));
}));

/* A7 — LES CONSTATS EN BROUILLONS, D'UN GESTE. Poser huit constats en commentaires demandait
   huit ouvertures du viewer : chercher le fichier, descendre à la ligne, cliquer « + », recopier
   le constat. Le rapport les porte déjà avec leur fichier et leur ligne — c'est exactement ce
   qu'un brouillon inline demande.

   TROIS RÈGLES, et chacune évite d'écrire une bêtise chez quelqu'un :
     — seuls les constats qui portent un FICHIER ET UNE LIGNE deviennent des brouillons ; un
       constat sans position n'a pas d'endroit où s'accrocher, et le poser en tête du fichier
       serait le poser au hasard. Le compte des laissés-pour-compte est rendu ;
     — les RÉSOLUS sont exclus : commenter ce qui vient d'être corrigé serait du bruit ;
     — un brouillon EXISTE DÉJÀ au même endroit avec le même texte → on ne le double pas.
       Cliquer deux fois est le geste le plus naturel du monde.

   Rien n'est envoyé : ce sont des brouillons, qu'on relit et qu'on envoie groupés comme les
   autres. */
/* TOUT SUPPRIMER. Une remarque dont on ne veut plus, ou que la forge refuse (une position
   qu'elle ne reconnaît pas), reste dans le lot et le bloque : l'envoi groupé repart en échec à
   chaque fois, et se débarrasser des brouillons demandait de rouvrir chaque fichier pour les
   retirer un par un. Déclarée AVANT la route à identifiant, comme ailleurs dans ce fichier :
   une collection et un élément ne doivent jamais se disputer la même URL.

   Le nombre supprimé est RENDU — l'écran s'en sert pour demander confirmation avant, et pour
   dire ce qui s'est passé après ; un « c'est fait » sans chiffre laisse douter. */
app.delete('/api/mrs/:id/comment-drafts', wrap((req, res) => {
  const mr = mrById(Number(req.params.id));
  if (!mr) throw new Error(t('err.mr-introuvable'));
  const n = db.prepare('DELETE FROM mr_comment_draft WHERE mr_id = ?').run(mr.id).changes;
  res.json({ deleted: n });
}));

app.post('/api/mrs/:id/comment-drafts/from-findings', wrap((req, res) => {
  const mr = mrById(Number(req.params.id));
  if (!mr) throw new Error(t('err.mr-introuvable'));
  const version = (db.prepare('SELECT MAX(version) v FROM finding WHERE mr_id = ?').get(mr.id) || {}).v;
  if (!version) throw new Error(t('err.findings.none'));
  const rev = db.prepare('SELECT diff_path FROM review WHERE mr_id = ?').get(mr.id);
  const bloquantsSeuls = !!(req.body && req.body.blocking_only);
  const rows = db.prepare(`SELECT file, line, severity, title FROM finding
    WHERE mr_id = ? AND version = ? AND COALESCE(status, '') <> 'resolved'
    ORDER BY CASE severity WHEN 'blocker' THEN 0 WHEN 'major' THEN 1 WHEN 'minor' THEN 2 ELSE 3 END, file, line`)
    .all(mr.id, version)
    .filter((f) => !bloquantsSeuls || f.severity === 'blocker');

  /* UN COMMENTAIRE NE S'ACCROCHE PAS N'IMPORTE OÙ. Un constat cite une ligne de la version
     finale du fichier — c'est ce que l'IA reçoit —, et l'IA a parfaitement le droit de parler
     d'une ligne qu'elle n'a pas vue changer (« cette fonction est maintenant appelée avec
     null »). Mais une remarque inline se pose SUR LE DIFF : hors des hunks, la forge refuse la
     position, et l'écran affiche en attendant une remarque collée à une ligne que personne n'a
     touchée. On croise donc chaque constat avec le diff de LA VERSION REVIEWÉE (celle dont les
     constats viennent) et on ne pose que ce qui peut l'être — le reste est compté et annoncé.

     Ligne de contexte : `old_line` ET `new_line`, sinon GitLab refuse la position. C'est la
     raison d'être de la carte plutôt que d'un simple ensemble de numéros. */
  const patch = rev && rev.diff_path ? readFileSafe(rev.diff_path) : null;
  if (!patch) throw new Error(t('err.findings.no-diff'));
  const ancrables = diffnum.lignesAncrables(patch);

  const existants = new Set(brouillonsDe(mr.id).map((d) => `${d.new_path}\u0000${d.new_line}\u0000${d.body}`));
  const now = new Date().toISOString();
  const ins = db.prepare(`INSERT INTO mr_comment_draft
    (mr_id, old_path, new_path, old_line, new_line, body, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?)`);
  let crees = 0; let sansPosition = 0; let doublons = 0; let horsDiff = 0;
  for (const f of rows) {
    if (!f.file || !f.line) { sansPosition += 1; continue; }
    const ancre = (ancrables.get(f.file) || new Map()).get(Number(f.line));
    if (!ancre) { horsDiff += 1; continue; }
    const corps = t('report.finding.draft-body', { severity: t(`sev.${f.severity || 'minor'}`), title: f.title || '' });
    if (existants.has(`${f.file}\u0000${f.line}\u0000${corps}`)) { doublons += 1; continue; }
    // `old_path` est requis par la forge dès qu'on donne `old_line` : c'est le même fichier.
    ins.run(mr.id, ancre.old_line == null ? null : f.file, f.file, ancre.old_line, f.line, corps, now, now);
    crees += 1;
  }
  res.json({
    created: crees,
    skipped_no_position: sansPosition,
    skipped_outside_diff: horsDiff,
    skipped_existing: doublons,
    total: rows.length,
  });
}));

app.put('/api/mrs/:id/comment-drafts/:did', wrap((req, res) => {
  const mr = mrById(Number(req.params.id));
  if (!mr) throw new Error(t('err.mr-introuvable'));
  const corps = ((req.body && req.body.body) || '').trim();
  if (!corps) throw new Error(t('err.commentaire-vide-2'));
  const info = db.prepare('UPDATE mr_comment_draft SET body = ?, updated_at = ? WHERE id = ? AND mr_id = ?')
    .run(corps, new Date().toISOString(), Number(req.params.did), mr.id);
  if (!info.changes) throw new Error(t('err.brouillon-introuvable'));
  res.json(db.prepare('SELECT * FROM mr_comment_draft WHERE id = ?').get(Number(req.params.did)));
}));

app.delete('/api/mrs/:id/comment-drafts/:did', wrap((req, res) => {
  const mr = mrById(Number(req.params.id));
  if (!mr) throw new Error(t('err.mr-introuvable'));
  db.prepare('DELETE FROM mr_comment_draft WHERE id = ? AND mr_id = ?').run(Number(req.params.did), mr.id);
  res.json({ ok: true });
}));

/* L'ENVOI. Les références de diff sont résolues UNE fois pour tout le lot : elles sont les
   mêmes pour tous, et les redemander à chaque commentaire ferait autant d'allers-retours que
   de remarques. Chaque brouillon parti est supprimé AUSSITÔT — si le dixième échoue, les neuf
   premiers ne doivent pas repartir au prochain essai. Ce qui échoue RESTE, avec sa raison. */
app.post('/api/mrs/:id/comment-drafts/send', wrap(async (req, res) => {
  const mr = mrById(Number(req.params.id));
  if (!mr) throw new Error(t('err.mr-introuvable'));
  const liste = brouillonsDe(mr.id);
  if (!liste.length) throw new Error(t('err.aucun-brouillon'));
  const supprimer = db.prepare('DELETE FROM mr_comment_draft WHERE id = ?');

  if (demoJenkins.isDemo()) {
    for (const d of liste) {
      demoComments.post(mr.id, d.body, { new_path: d.new_path, old_path: d.old_path, new_line: d.new_line, old_line: d.old_line });
      supprimer.run(d.id);
    }
    return res.json({ sent: liste.length, failed: [] });
  }

  const cfg = getConfig();
  const client = forge.clientFor(mr);
  const full = await client.getMergeRequest(cfg, mr.project, mr.iid);
  const dr = full && full.diff_refs;
  if (!dr || !dr.head_sha) throw new Error(t('err.references-de-diff-introuvables-la'));

  const failed = [];
  let sent = 0;
  for (const d of liste) {
    const position = {
      base_sha: dr.base_sha, start_sha: dr.start_sha, head_sha: dr.head_sha,
      position_type: 'text',
      old_path: d.old_path || d.new_path, new_path: d.new_path || d.old_path,
    };
    if (d.new_line != null) position.new_line = Number(d.new_line);
    if (d.old_line != null) position.old_line = Number(d.old_line);
    try {
      const note = await client.postMrDiscussion(cfg, mr.project, mr.iid, d.body, position);
      /* PARTI = PRODUIT. Le brouillon reste à celui qui l'écrit, mais une fois posté le
         commentaire est sur la merge request : il rejoint le journal, qui lui est d'équipe —
         c'est ce qui permet de relire ce qui a été dit sans rouvrir la forge. */
      db.prepare('INSERT INTO comment_log (mr_id, body, gitlab_note_id, sent_at) VALUES (?,?,?,?)')
        .run(mr.id, d.body, (note && (note.id || (note.notes && note.notes[0] && note.notes[0].id))) || null,
          new Date().toISOString());
      supprimer.run(d.id);
      sent += 1;
    } catch (e) {
      failed.push({ id: d.id, path: d.new_path || d.old_path, error: (e && e.message) || String(e) });
    }
  }
  res.json({ sent, failed });
}));

// Merge une MR (depuis l'onglet Rapports de review).
/* Options de merge : ce que demande l'appel, sinon ce qui avait été choisi à la
   création de la MR (colonnes `mr.squash` / `mr.remove_source_branch`). */
function mergeOptsFor(mr, body) {
  const pick = (v, fallback) => (v === undefined ? fallback : !!(v === true || v === 'true' || v === 1 || v === '1'));
  return {
    squash: pick(body && body.squash, !!(mr && mr.squash)),
    removeSourceBranch: pick(body && body.removeSourceBranch, !!(mr && mr.remove_source_branch)),
  };
}

/* Mémorise les options choisies à la création. Indispensable pour GitHub, dont l'API de
   création ne sait pas les exprimer : c'est ici qu'on retrouve l'intention au merge. */
function rememberMergeOpts(repoId, iid, squash, removeSourceBranch) {
  db.prepare('UPDATE mr SET squash = ?, remove_source_branch = ? WHERE repo_id = ? AND iid = ?')
    .run(squash ? 1 : 0, removeSourceBranch ? 1 : 0, repoId, iid);
}

app.post('/api/mrs/:id/merge', wrap(async (req, res) => {
  const mr = mrById(Number(req.params.id));
  if (!mr) throw new Error(t('err.mr-introuvable'));
  const opts = mergeOptsFor(mr, req.body);
  const merged = await forge.clientFor(mr).mergeMergeRequest(getConfig(), mr.project, mr.iid, opts);
  const isMerged = merged && merged.state === 'merged';
  if (isMerged) {
    const now = new Date().toISOString();
    // événement frais pour le footer + flag pour que discover ne re-signale pas
    db.prepare('INSERT INTO feed (type, mr_iid, project, author, title, at) VALUES (?,?,?,?,?,?)')
      .run('mr_merged', mr.iid, mr.project, mr.author || '', mr.title || '', now);
    db.prepare('UPDATE mr SET closed_seen = 1 WHERE id = ?').run(mr.id);
    // si cette MR vient d'une Dev session, la tâche doit aussi passer « mergée »
    db.prepare('UPDATE task_target SET mr_merged = 1, updated_at = ? WHERE repo_id = ? AND mr_iid = ?')
      .run(now, mr.repo_id, mr.iid);
    /* TOP 14 — et l'événement, comme pour une MR mergée par quelqu'un d'autre. `closed_seen`
       vient d'être posé, donc la découverte ne le signalera jamais : sans cette ligne, le SEUL
       merge qui ne produit aucun fait est celui qu'on a fait soi-même — et c'est celui qui clôt
       une attente (l'onglet peut être ailleurs, le merge peut prendre quelques secondes). */
    notify.push('mr_merged', { mr_id: mr.id, iid: mr.iid, project: mr.project, title: mr.title || '', mine: true });
  }
  res.json({ ok: true, merged: isMerged, state: merged && merged.state });
}));

const PORT = Number(process.env.PORT || 4319);
// Rafraîchissement automatique des MR : (re)démarre le timer selon la config.
// 0 = désactivé. Un seul timer actif à la fois ; ne se superpose pas aux découvertes.
let autoRefreshTimer = null;
let autoRefreshBusy = false;
function restartAutoRefresh() {
  if (autoRefreshTimer) { clearInterval(autoRefreshTimer); autoRefreshTimer = null; }
  const min = Number(getConfig().auto_refresh_minutes) || 0;
  if (min <= 0) { console.log('[auto-refresh] désactivé'); return; }
  autoRefreshTimer = setInterval(async () => {
    if (autoRefreshBusy) return; // évite le chevauchement si une découverte est déjà en cours
    autoRefreshBusy = true;
    try {
      const r = await decouvrir();
      console.log(`[auto-refresh] ${r.found} MR · ${r.created} nouvelles · ${r.updated} maj${r.errors && r.errors.length ? ` · ${r.errors.length} erreur(s)` : ''}${r.auto_verify && r.auto_verify.lancees ? ` · ${r.auto_verify.lancees} vérification(s) auto` : ''}`);
    } catch (e) {
      console.error(`[auto-refresh] échec : ${e.message}`);
    } finally { autoRefreshBusy = false; }
  }, min * 60 * 1000);
  console.log(`[auto-refresh] activé : toutes les ${min} min`);
}


/* ---------- Onglet Git : opérations multi-dépôts + explorateur de branches ---------- */

// Refs d'un dépôt, pour alimenter les sélecteurs. Les branches protégées et la
// branche par défaut sont marquées : le front les rend non sélectionnables à la
// suppression plutôt que de laisser l'aperçu les rejeter ensuite.
/* ---------- Comparer le CONTENU de deux dépôts ----------
   Deux dépôts n'ont pas d'histoire commune : `git diff` entre eux n'a aucun sens, et un
   « nombre de commits d'écart » encore moins. Ce qu'on compare, ce sont les ARBRES — la liste
   des fichiers de chaque branche, et le hash de chacun :

     · à gauche seulement / à droite seulement : ce qui manque d'un côté ;
     · des deux côtés mais différents : même chemin, blob différent ;
     · identiques : on n'en rend que le NOMBRE. Sur deux dépôts jumeaux c'est l'écrasante
       majorité des lignes, et c'est la seule liste que personne ne lit.

   Le hash git suffit à décider « identique » : deux fichiers de même contenu ont le même
   objet, quel que soit le dépôt. Aucune lecture de contenu n'est nécessaire. */
const MAX_COMPARE = 2000;
const MAX_FICHIER_COMPARE = 1024 * 1024;   // 1 Mo par côté

/* Une branche et un tag peuvent porter le MÊME nom : `origin/v1.2` ne dit pas lequel des deux
   on veut. L'écran sait ce qui a été choisi, il le dit, et on résout sans deviner. */
function refComplete(kind, nom) {
  return kind === 'tag' ? `refs/tags/${nom}` : `refs/remotes/origin/${nom}`;
}

async function arbreDeBranche(cwd, repo, ref, kind) {
  const complete = refComplete(kind, ref);
  if (!await git.refExists(cwd, complete)) {
    throw new Error(t('err.verify.branch-unknown', { branch: ref, project: repo.project }));
  }
  const { stdout } = await git.run('git', ['ls-tree', '-r', complete], { cwd });
  const arbre = new Map();
  for (const ligne of String(stdout || '').split('\n')) {
    if (!ligne.trim()) continue;
    /* Format historique de `ls-tree` : « <mode> <type> <hash>\t<chemin> ». On ne se sert pas de
       `--format`, arrivé en git 2.36 : cet outil tourne sur les machines des gens. */
    const sep = ligne.indexOf('\t');
    if (sep < 0) continue;
    const [, type, hash] = ligne.slice(0, sep).split(/\s+/);
    if (type !== 'blob') continue;           // sous-modules et arbres : pas des fichiers
    arbre.set(ligne.slice(sep + 1), hash);
  }
  return arbre;
}

app.get('/api/git/compare', wrap(async (req, res) => {
  const lire = (cle) => db.prepare('SELECT * FROM repo WHERE id = ?').get(Number(req.query[cle]));
  const repoA = lire('repo_a');
  const repoB = lire('repo_b');
  if (!repoA || !repoB) throw new Error(t('err.depot-introuvable'));
  const refA = String(req.query.ref_a || '').trim();
  const refB = String(req.query.ref_b || '').trim();
  const kindA = req.query.kind_a === 'tag' ? 'tag' : 'branch';
  const kindB = req.query.kind_b === 'tag' ? 'tag' : 'branch';
  if (!refA) throw new Error(t('err.verify.branch-required', { project: repoA.project }));
  if (!refB) throw new Error(t('err.verify.branch-required', { project: repoB.project }));

  if (demoGit.isDemo()) {
    return res.json(demoGit.compare(repoA.project, { ref: refA, kind: kindA }, repoB.project, { ref: refB, kind: kindB }));
  }

  const cfg = getConfig();
  const [cwdA, cwdB] = await clonesDeComparaison(cfg, repoA, repoB);
  const [a, b] = await Promise.all([
    arbreDeBranche(cwdA, repoA, refA, kindA),
    arbreDeBranche(cwdB, repoB, refB, kindB),
  ]);

  const seulA = []; const seulB = []; const differents = [];
  let identiques = 0;
  for (const [chemin, hash] of a) {
    if (!b.has(chemin)) seulA.push(chemin);
    else if (b.get(chemin) !== hash) differents.push(chemin);
    else identiques += 1;
  }
  for (const chemin of b.keys()) if (!a.has(chemin)) seulB.push(chemin);

  /* On BORNE, et on le dit. Comparer deux dépôts sans rien en commun rendrait des dizaines de
     milliers de lignes que ni l'écran ni personne ne lit — mais une liste tronquée en silence
     se lit comme une liste complète. */
  const tronque = seulA.length > MAX_COMPARE || seulB.length > MAX_COMPARE || differents.length > MAX_COMPARE;
  res.json({
    a: { project: repoA.project, ref: refA, kind: kindA, files: a.size },
    b: { project: repoB.project, ref: refB, kind: kindB, files: b.size },
    only_a: seulA.sort().slice(0, MAX_COMPARE),
    only_b: seulB.sort().slice(0, MAX_COMPARE),
    differ: differents.sort().slice(0, MAX_COMPARE),
    same: identiques,
    tronque,
  });
}));

/* Les deux clones d'une comparaison. Deux côtés sur le MÊME dépôt — comparer `main` à
   `develop` est le cas le plus banal qui soit — ne préparent qu'UN clone : le faire deux fois
   de front lance deux `git clone` dans le même dossier, et le second échoue. */
async function clonesDeComparaison(cfg, repoA, repoB) {
  if (repoA.id === repoB.id) {
    const cwd = await git.ensureRepo(cfg, repoA, () => {});
    return [cwd, cwd];
  }
  return Promise.all([
    git.ensureRepo(cfg, repoA, () => {}),
    git.ensureRepo(cfg, repoB, () => {}),
  ]);
}

/* Le SHA du blob d'un chemin sur une branche, ou null s'il n'y est pas. `rev-parse` refuse
   de lui-même ce qui sort de l'arborescence : le chemin vient de l'écran, mais rien n'oblige
   la requête à venir de l'écran. */
async function shaDuBlob(cwd, ref, kind, chemin) {
  try {
    const { stdout } = await git.run('git', ['rev-parse', '--verify', `${refComplete(kind, ref)}:${chemin}`], { cwd });
    return stdout.trim() || null;
  } catch { return null; }
}

/* Un blob écrit tel quel sur disque. `git cat-file` sort des OCTETS : les faire transiter par
   une chaîne JS abîmerait tout ce qui n'est pas de l'UTF-8 — or c'est précisément sur ces
   fichiers-là qu'il faut pouvoir dire « binaire » plutôt que d'afficher n'importe quoi. */
function extraireBlob(cwd, sha, dest) {
  return new Promise((resolve, reject) => {
    const fd = fs.openSync(dest, 'w');
    const child = spawn('git', ['cat-file', 'blob', sha], { cwd, stdio: ['ignore', fd, 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { fs.closeSync(fd); reject(e); });
    child.on('close', (code) => {
      fs.closeSync(fd);
      if (code === 0) resolve(); else reject(new Error(err.trim() || `git cat-file (${code})`));
    });
  });
}

/* `git diff --no-index` sort 1 quand les deux fichiers diffèrent : ce n'est pas une erreur,
   c'est la réponse. D'où ce lancement à part plutôt que `git.run`, qui rejette tout code non
   nul. C'est git qui calcule le diff — et c'est lui qui sait dire qu'un fichier est binaire. */
function diffDeuxFichiers(a, b) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['diff', '--no-index', '--unified=3', '--', a, b]);
    let out = ''; let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0 || code === 1) resolve(out);
      else reject(new Error(err.trim() || `git diff (${code})`));
    });
  });
}

/* Le contenu d'un fichier des deux côtés, en diff unifié. Un fichier présent d'un seul côté
   se lit contre le vide : toutes ses lignes en ajout (ou en retrait), ce qui est exactement
   ce qu'on veut voir de ce côté-là. */
app.get('/api/git/compare/file', wrap(async (req, res) => {
  const lire = (cle) => db.prepare('SELECT * FROM repo WHERE id = ?').get(Number(req.query[cle]));
  const repoA = lire('repo_a');
  const repoB = lire('repo_b');
  if (!repoA || !repoB) throw new Error(t('err.depot-introuvable'));
  const refA = String(req.query.ref_a || '').trim();
  const refB = String(req.query.ref_b || '').trim();
  const kindA = req.query.kind_a === 'tag' ? 'tag' : 'branch';
  const kindB = req.query.kind_b === 'tag' ? 'tag' : 'branch';
  if (!refA) throw new Error(t('err.verify.branch-required', { project: repoA.project }));
  if (!refB) throw new Error(t('err.verify.branch-required', { project: repoB.project }));
  const chemin = String(req.query.path || '').trim();
  if (!chemin) throw new Error(t('err.compare.path-required'));

  if (demoGit.isDemo()) {
    return res.json(demoGit.compareFile(repoA.project, { ref: refA, kind: kindA }, repoB.project, { ref: refB, kind: kindB }, chemin));
  }

  const cfg = getConfig();
  const [cwdA, cwdB] = await clonesDeComparaison(cfg, repoA, repoB);
  const cote = async (cwd, ref, kind) => {
    const sha = await shaDuBlob(cwd, ref, kind, chemin);
    if (!sha) return { exists: false, size: 0, sha: null };
    const { stdout } = await git.run('git', ['cat-file', '-s', sha], { cwd });
    return { exists: true, size: Number(stdout.trim()) || 0, sha };
  };
  const [a, b] = await Promise.all([cote(cwdA, refA, kindA), cote(cwdB, refB, kindB)]);
  if (!a.exists && !b.exists) throw new Error(t('err.compare.file-absent', { path: chemin }));

  const entetes = {
    path: chemin,
    a: { project: repoA.project, ref: refA, kind: kindA, exists: a.exists, size: a.size },
    b: { project: repoB.project, ref: refB, kind: kindB, exists: b.exists, size: b.size },
  };
  /* On BORNE. Un fichier de plusieurs mégaoctets rendrait un diff que ni le navigateur ni
     personne ne parcourt — mieux vaut le dire que faire semblant. */
  if (a.size > MAX_FICHIER_COMPARE || b.size > MAX_FICHIER_COMPARE) {
    return res.json({ ...entetes, diff: '', trop_gros: true, binaire: false, identique: false });
  }

  const dir = fs.mkdtempSync(path.join(ensureDir(TMP_DIR), 'cmp-'));
  try {
    const fichiers = [];
    for (const [cle, cwd, cote2] of [['a', cwdA, a], ['b', cwdB, b]]) {
      const dest = path.join(dir, cle);
      if (cote2.exists) await extraireBlob(cwd, cote2.sha, dest);
      else fs.writeFileSync(dest, '');       // l'absence se lit comme un fichier vide
      fichiers.push(dest);
    }
    const diff = await diffDeuxFichiers(fichiers[0], fichiers[1]);
    res.json({
      ...entetes,
      diff,
      binaire: /^Binary files /m.test(diff),
      identique: !diff.trim(),
      trop_gros: false,
    });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}));

app.get('/api/git/refs', wrap(async (req, res) => {
  const repo = db.prepare('SELECT * FROM repo WHERE id = ?').get(Number(req.query.repo_id));
  if (!repo) throw new Error(t('err.depot-introuvable'));
  const cfg = getConfig();
  const kind = req.query.kind === 'tags' ? 'tags' : 'branches';
  // `repo.url` : un dépôt de démo peut être un VRAI dépôt sur le disque — on lit alors ses refs.
  if (demoGit.isDemo()) return res.json(demoGit.refs(repo.project, kind, repo.url));
  if (kind === 'tags') {
    const api = forge.clientFor(repo);
    const [tags, prot] = await Promise.all([api.listTags(cfg, repo.project), api.listProtectedTags(cfg, repo.project)]);
    return res.json({ kind, refs: tags.map((x) => ({ name: x.name, sha: x.sha, protected: prot.includes(x.name), annotated: x.annotated, date: x.committed_date })) });
  }
  const apiB = forge.clientFor(repo);
  const [branches, prot] = await Promise.all([apiB.listBranchesFull(cfg, repo.project), apiB.listProtectedBranches(cfg, repo.project)]);
  res.json({
    kind,
    default: (branches.find((b) => b.default) || {}).name || null,
    refs: branches.map((b) => ({ name: b.name, sha: b.sha, default: b.default, protected: b.protected || prot.includes(b.name), merged: b.merged, date: b.committed_date, author: b.author })),
  });
}));

/* ---------- Git · Merge de branche à branche (onglet Git → Merge) ----------
   Toutes ces routes travaillent dans le worktree du merge, jamais dans le clone partagé —
   voir l'en-tête de `src/gitmerge.js` pour le pourquoi. */

app.get('/api/git/merges', wrap((req, res) => res.json(gitmerge.enCours())));

app.post('/api/git/merges', wrap(async (req, res) => {
  const b = req.body || {};
  res.json(await gitmerge.demarrer(getConfig(), {
    repo_id: b.repo_id,
    source: b.source,
    target: b.target,
    // Fusionner deux histoires sans ancêtre commun se DEMANDE : voir `gitmerge.demarrer`.
    allow_unrelated: b.allow_unrelated === true || b.allow_unrelated === '1',
  }));
}));

app.get('/api/git/merges/:id', wrap(async (req, res) => {
  res.json(await gitmerge.etat(Number(req.params.id)));
}));

/* A31 — le diff du merge COMMITÉ. Après trente conflits résolus un par un, « qu'est-ce que ça
   donne, au total ? » demandait un terminal. */
app.get('/api/git/merges/:id/diff', wrap(async (req, res) => {
  res.json(await gitmerge.diffCommit(Number(req.params.id)));
}));

/* Le contenu d'un fichier en conflit, DÉCOUPÉ. L'écran reçoit les morceaux (stables et
   conflits) plutôt que du texte brut : c'est ce qui lui permet d'offrir « garder celle-ci /
   celle-là / les deux » par conflit, sans reparser les marqueurs de son côté. */
app.get('/api/git/merges/:id/file', wrap((req, res) => {
  const fichier = String((req.query && req.query.path) || '');
  const texte = gitmerge.contenu(Number(req.params.id), fichier);
  res.json({ path: fichier, texte, morceaux: gitmerge.decouper(texte) });
}));

app.post('/api/git/merges/:id/resolve', wrap(async (req, res) => {
  const { path: fichier, content, choices } = req.body || {};
  res.json(await gitmerge.resoudre(Number(req.params.id), String(fichier || ''), {
    contenu: content == null ? null : content,
    choix: Array.isArray(choices) ? choices : null,
  }));
}));

app.post('/api/git/merges/:id/commit', wrap(async (req, res) => {
  res.json(await gitmerge.commiter(Number(req.params.id), (req.body && req.body.message) || ''));
}));

app.post('/api/git/merges/:id/push', wrap(async (req, res) => {
  res.json(await gitmerge.pousser(getConfig(), Number(req.params.id)));
}));

app.delete('/api/git/merges/:id', wrap(async (req, res) => {
  res.json(await gitmerge.abandonner(getConfig(), Number(req.params.id)));
}));

// Aperçu : ne modifie rien, sert de confirmation.
/* ---------- B7 : les branches des merge requests mergées ----------
   Fin de sprint, trente branches mortes dans quatre dépôts : on les supprimait une à une dans
   l'interface de la forge, ou on les laissait pourrir. Elles sont TOUTES connues ici — une
   merge request vue fermée porte sa branche source. On rend la liste, groupée par dépôt ;
   l'écran la charge dans le lot de suppression, et c'est l'APERÇU habituel qui dit, branche
   par branche, si elle existe encore, si elle est protégée et si c'est sûr. Rien n'est
   supprimé sans passer par là. */
app.get('/api/git/merged-branches', wrap((req, res) => {
  const rows = db.prepare(`SELECT mr.repo_id, repo.project, mr.source_branch AS branch,
      COUNT(*) AS n, MAX(mr.iid) AS iid
    FROM mr JOIN repo ON repo.id = mr.repo_id
    WHERE mr.closed_seen = 1 AND mr.source_branch IS NOT NULL AND mr.source_branch != ''
      AND repo.enabled = 1
      /* Une branche encore portée par une merge request OUVERTE n'est pas morte : deux merge
         requests ont pu se succéder sur la même branche. */
      AND NOT EXISTS (SELECT 1 FROM mr m2 WHERE m2.repo_id = mr.repo_id
        AND m2.source_branch = mr.source_branch AND (m2.closed_seen IS NULL OR m2.closed_seen = 0))
    GROUP BY mr.repo_id, mr.source_branch
    ORDER BY repo.project, mr.source_branch`).all();
  const parDepot = new Map();
  for (const r of rows) {
    if (!parDepot.has(r.repo_id)) parDepot.set(r.repo_id, { repo_id: r.repo_id, project: r.project, refs: [] });
    parDepot.get(r.repo_id).refs.push({ name: r.branch, iid: r.iid });
  }
  res.json({ total: rows.length, repos: [...parDepot.values()] });
}));

app.post('/api/git/preview', wrap(async (req, res) => {
  res.json(await gitops.preview(req.body || {}));
}));

// Exécution : passe par la file de jobs, car le fetch de sécurité qui précède
// chaque suppression peut être long (clonage initial d'un gros dépôt).
app.post('/api/git/execute', wrap(async (req, res) => {
  // En démo, les écritures sont purement décoratives : on ne touche à rien (pas de job).
  if (demoGit.isDemo()) return res.json({ demo: true });
  res.json(jobs.startGitJob(req.body || {}));
}));

// Historique, avec ce qu'il faut pour proposer la restauration.
app.get('/api/git/ops', wrap((req, res) => {
  const rows = db.prepare('SELECT * FROM git_op ORDER BY id DESC LIMIT 200').all();
  res.json(rows.map((o) => ({
    ...o,
    restorable: gitops.isDestructive(o.action) && o.status === 'done' && !!o.ref_sha && !o.restored_at,
  })));
}));

app.post('/api/git/ops/:id/restore', wrap(async (req, res) => {
  res.json(jobs.startGitJob({ restoreOpId: Number(req.params.id) }));
}));

/* Explorateur de branches. Exige un clone local : l'analyse du graphe
   (ahead/behind, merge-base) a besoin de l'historique, que l'API ne donne pas. */
/* Une entrée par dépôt, en mémoire du processus : l'analyse d'un dépôt pèse quelques dizaines
   de kilo-octets, et un redémarrage la refait — c'est un cache, pas un état. */
const crypto = require('node:crypto');
const cacheExplorateur = new Map();

app.get('/api/git/branches', wrap(async (req, res) => {
  const repo = db.prepare('SELECT * FROM repo WHERE id = ?').get(Number(req.query.repo_id));
  if (!repo) throw new Error(t('err.depot-introuvable'));
  if (demoGit.isDemo()) return res.json(demoGit.branches(repo.project, repo.id));
  const cfg = getConfig();
  const [branches, mrs, tags] = await Promise.all([
    forge.clientFor(repo).listBranchesFull(cfg, repo.project),
    forge.clientFor(repo).listAllMRs(cfg, repo.project).catch(() => []),
    forge.clientFor(repo).listTags(cfg, repo.project).catch(() => []),
  ]);
  const defaultBranch = (branches.find((b) => b.default) || {}).name || 'main';
  await git.ensureRepo(cfg, repo, () => {});
  const cwd = git.cloneDirFor(cfg, repo);
  await gitgraph.fetchRepo(cwd, () => {});
  /* A33 — L'ANALYSE EST MISE EN CACHE, PAR ÉTAT DU DÉPÔT. Elle est quadratique en processus
     git (`merge-base` de chaque branche contre chaque candidate) : sur un dépôt à deux cents
     branches, rouvrir l'explorateur coûtait des dizaines de secondes pour un résultat
     IDENTIQUE — rien n'a bougé entre deux clics. La clé est l'empreinte des sommets : dès
     qu'une branche avance, apparaît ou disparaît, elle change et l'analyse repart. Un cache
     daté aurait menti dans l'autre sens (périmé alors que rien n'a changé, ou l'inverse). */
  const empreinte = crypto.createHash('sha1')
    .update(branches.map((b) => `${b.name}:${b.sha}`).sort().join('\n'))
    .digest('hex');
  let rows = cacheExplorateur.get(repo.id);
  if (!rows || rows.empreinte !== empreinte) {
    rows = { empreinte, lignes: await gitgraph.analyzeBranches(cwd, { branches, defaultBranch, mrs }) };
    cacheExplorateur.set(repo.id, rows);
  }
  rows = rows.lignes.map((r) => ({ ...r }));   // copie : `nommerBranches` annote, sans polluer le cache
  // Tags triés par date de création décroissante. GitLab n'expose pas de date de
  // création de tag distincte : on trie sur committed_date (date du commit pointé),
  // le meilleur proxy disponible — exact pour un tag léger, très proche pour un annoté.
  const tagsSorted = tags.slice().sort((a, b) => (Date.parse(b.committed_date || 0) || 0) - (Date.parse(a.committed_date || 0) || 0));
  // Branche(s) portant chaque tag (commit contenu). Local, best-effort ; borné pour
  // ne pas transformer un dépôt à millier de tags en millier de « git branch --contains ».
  await Promise.all(tagsSorted.slice(0, 200).map(async (tg) => {
    tg.branches = await git.branchesForCommit(cwd, tg.sha, defaultBranch);
  }));
  nommerBranches(repo.id, rows);
  res.json({ project: repo.project, repo_id: repo.id, forge: forge.forgeOf(repo), default: defaultBranch, branches: rows, tags: tagsSorted });
}));

/* ---------- Une branche n'est pas anonyme ----------
   Le graphe des branches disait « ahead 3, behind 12 » et rien de ce qu'elles PORTENT. Ce que
   Mergerie sait d'elles est en base : la note de la review de sa merge request, et la session
   de codage qui l'a créée (une branche `ai/…` vient de quelque part). Le graphe devient alors
   un plan de travail. Deux requêtes pour tout le dépôt, jamais une par branche. */
function nommerBranches(repoId, rows) {
  if (!rows || !rows.length) return;
  const notes = {};
  for (const r of db.prepare(`SELECT mr.source_branch AS br, rv.note_value AS note FROM mr
    JOIN review_version rv ON rv.mr_id = mr.id
    WHERE mr.repo_id = ? AND rv.version = (SELECT MAX(v2.version) FROM review_version v2 WHERE v2.mr_id = mr.id)`).all(repoId)) {
    notes[r.br] = r.note;
  }
  const sessions = {};
  /* `kind` part avec la session : l'écran doit ouvrir la SAVEUR qui la contient (codage,
     exploration…), sinon le clic atterrit sur le sous-onglet consulté la dernière fois — là où
     la session n'est pas. */
  for (const r of db.prepare(`SELECT tt.branch AS br, task.id, task.label, task.prompt, task.status, task.kind
    FROM task_target tt JOIN task ON task.id = tt.task_id
    WHERE tt.repo_id = ? AND tt.branch IS NOT NULL ORDER BY task.id DESC`).all(repoId)) {
    if (!sessions[r.br]) sessions[r.br] = { id: r.id, label: r.label || String(r.prompt || '').slice(0, 60), status: r.status, kind: r.kind || 'code' };
  }
  /* TOP 15 — TOUT CE QUE LA BASE SAIT D'UNE BRANCHE. Le graphe disait « ahead 3, behind 12 » et
     rien de ce que la branche PORTE : le titre de sa merge request est chargé puis jeté par
     `gitgraph`, son ticket Jira est en base, le dernier verdict de vérification aussi (dans
     `targets_json`), et le dernier build Jenkins est à une jointure. Chacune de ces données
     transforme une ligne de graphe en ligne de travail — et aucune ne coûte un appel de plus.
     Trois requêtes pour tout le dépôt, jamais une par branche. */
  const mrs = {};
  for (const r of db.prepare(`SELECT source_branch AS br, iid, title, web_url, status, closed_seen,
      ticket_jira_key, ticket_jira_status, has_conflicts, is_draft
    FROM mr WHERE repo_id = ? ORDER BY id DESC`).all(repoId)) {
    if (!mrs[r.br]) mrs[r.br] = r;
  }
  /* Le dernier verdict par branche : les cibles d'une vérification vivent en JSON, on relit
     donc du plus récent au plus ancien et on retient le premier vu — même geste que le brief. */
  const verdicts = {};
  for (const v of db.prepare(`SELECT verdict, targets_json, finished_at FROM verification
    WHERE status = 'done' ORDER BY id DESC LIMIT 300`).all()) {
    let cibles = [];
    try { cibles = JSON.parse(v.targets_json || '[]'); } catch { continue; }
    for (const c of cibles) {
      if (Number(c.repo_id) !== Number(repoId) || !c.branch) continue;
      if (!verdicts[c.branch]) verdicts[c.branch] = { verdict: v.verdict, at: v.finished_at };
    }
  }
  /* …et le job Jenkins du dépôt (TOP 15, dernier tiers). Une branche se déploie par le même job
     que les merge requests du dépôt ; le bouton existait sur une merge request VERTE et nulle part
     pour une branche qui n'en a pas encore — or c'est exactement le cas d'une branche qu'on veut
     déployer en recette avant de la proposer. Une requête pour tout le dépôt. */
  const jobs = db.prepare('SELECT job_path, param FROM repo_jenkins WHERE repo_id = ? ORDER BY job_path LIMIT 3').all(repoId);
  for (const b of rows) {
    if (notes[b.name] != null) b.mr_note = notes[b.name];
    if (sessions[b.name]) b.session = sessions[b.name];
    if (jobs.length && !b.default) b.jenkins = jobs.map((j) => ({ path: j.job_path, param: j.param || '' }));
    const mr = mrs[b.name];
    if (mr) {
      b.mr = {
        iid: mr.iid, title: mr.title || '', url: mr.web_url || '',
        status: mr.status, merged: !!mr.closed_seen,
        conflicts: mr.has_conflicts === 1, draft: !!mr.is_draft,
      };
      if (mr.ticket_jira_key) b.ticket = { key: mr.ticket_jira_key, status: mr.ticket_jira_status || '' };
    }
    if (verdicts[b.name]) b.verification = verdicts[b.name];
  }
}

// Auteur PRÉCIS d'un tag, à la demande (l'API GitLab n'expose pas le tagger d'un tag
// annoté). Lu dans le clone local via git ; le clone est déjà présent quand on est
// dans l'explorateur, on le (re)fetch au besoin.
app.get('/api/git/tag-author', wrap(async (req, res) => {
  const repo = db.prepare('SELECT * FROM repo WHERE id = ?').get(Number(req.query.repo_id));
  if (!repo) throw new Error(t('err.depot-introuvable'));
  const tag = String(req.query.tag || '').trim();
  if (!tag || /[\s\x00-\x1f~^:?*[\\]/.test(tag)) throw new Error(t('err.tag-invalide'));
  if (demoGit.isDemo()) return res.json(demoGit.tagAuthor(repo.project, tag));
  const cwd = await git.ensureRepo(getConfig(), repo, () => {});
  res.json(await git.tagAuthor(cwd, tag));
}));

// Recherche d'une ref (tag ou branche, saisie libre) À TRAVERS tous les dépôts actifs.
// Renvoie, par dépôt, les correspondances trouvées (avec commit + lien GitLab). Live et
// best-effort : un dépôt injoignable est marqué `error`, pas confondu avec « absente ».
function refUrl(cfg, project, kind, name) {
  const base = String(cfg.gitlab_url || '').replace(/\/+$/, '');
  const seg = kind === 'tag' ? '-/tags/' : '-/tree/';
  return `${base}/${project}/${seg}${encodeURIComponent(name)}`;
}
app.get('/api/git/find-ref', wrap(async (req, res) => {
  const cfg = getConfig();
  const name = String(req.query.name || '').trim();
  if (!name) throw new Error(t('err.ref-name-required'));
  const type = ['branch', 'tag'].includes(req.query.type) ? req.query.type : 'both';
  const kinds = type === 'both' ? ['branch', 'tag'] : [type];
  if (demoGit.isDemo()) return res.json(demoGit.findRef(name, type, db.prepare('SELECT id, project FROM repo WHERE enabled = 1').all()));
  if (!forge.isConfigured(cfg, 'gitlab') && !forge.isConfigured(cfg, 'github')) throw new Error(t('err.aucune-forge-configuree'));
  const repos = db.prepare('SELECT * FROM repo WHERE enabled = 1').all();
  const results = await Promise.all(repos.map(async (r) => {
    const matches = [];
    let error = null;
    for (const kind of kinds) {
      try {
        const ref = await forge.clientFor(r).getRef(cfg, r.project, kind, name);
        if (ref) matches.push({
          kind,
          sha: (ref.commit && (ref.commit.short_id || String(ref.commit.id).slice(0, 8))) || '',
          fullSha: (ref.commit && ref.commit.id) || '',
          date: (ref.commit && ref.commit.committed_date) || null,
          author: (ref.commit && ref.commit.author_name) || '',
          url: forge.refUrl(cfg, r, kind, name),
        });
      } catch (e) { error = String(e.message).slice(0, 200); }
    }
    // Pour un tag trouvé, on renseigne aussi la (les) branche(s) qui le portent — via le
    // clone local, comme dans l'explorateur. Best-effort : ne bloque jamais le résultat.
    const tagMatch = matches.find((m) => m.kind === 'tag');
    if (tagMatch && tagMatch.fullSha) {
      try {
        const cwd = await git.ensureRepo(cfg, r, () => {});
        tagMatch.branches = await git.branchesForCommitDetailed(cwd, tagMatch.fullSha);
      } catch { /* clone injoignable : on garde le tag sans sa branche */ }
    }
    matches.forEach((m) => { delete m.fullSha; });
    return { project: r.project, repo_id: r.id, matches, error };
  }));
  res.json({ name, type, repos: results });
}));

// Banc d'essai « reprise de session IA » (Réglages → AI sessions). Enchaîne deux passes
// dans la même session d'agent pour vérifier que la reprise conserve le contexte. Appel
// direct (hors file de jobs) : c'est un diagnostic manuel, lancé à la demande.
app.post('/api/ai-sessions/test', wrap(async (req, res) => {
  const logs = [];
  const result = await aisession.runSessionTest((m) => logs.push(m));
  res.json({ ...result, logs });
}));

// Création d'une MR depuis l'explorateur : générique (pas liée à une session).
// La même mécanique que Dev IA — titre + création via l'API GitLab — mais entre
// une branche et sa branche source (déduite dans l'explorateur), pas un task_target.
app.post('/api/git/mr', wrap(async (req, res) => {
  const repo = db.prepare('SELECT * FROM repo WHERE id = ?').get(Number(req.body && req.body.repo_id));
  if (!repo) throw new Error(t('err.depot-introuvable'));
  const source = String(req.body.source || '').trim();
  const target = String(req.body.target || '').trim();
  const title = String(req.body.title || '').trim() || source;
  if (!source || !target) throw new Error(t('err.git.mr-missing-refs'));
  if (source === target) throw new Error(t('err.git.mr-same-ref'));
  const squash = !!(req.body && req.body.squash);
  const removeSourceBranch = !!(req.body && req.body.removeSourceBranch);
  const mr = await forge.clientFor(repo).createMergeRequest(getConfig(), repo.project, {
    source_branch: source, target_branch: target, title, squash, removeSourceBranch,
  });
  rememberMergeOpts(repo.id, mr.iid, squash, removeSourceBranch);
  res.json({ iid: mr.iid, url: mr.web_url });
}));

// La langue est posée avant la première requête : les messages d’erreur du serveur
// sont de l’interface, ils doivent sortir dans la bonne langue dès le démarrage.
i18n.setLang(getConfig().language);

/* CE QUE L'ARRÊT PRÉCÉDENT A COUPÉ EN PLEIN VOL. Les jobs ont été marqués `interrupted` au
   chargement de la base ; les sessions et vérifications qu'ils portaient, elles, seraient
   restées « en cours » à jamais — sans bouton pour repartir ni pour arrêter. On le fait ici,
   après `setLang`, pour que la raison inscrite sur la carte sorte dans la bonne langue. */
{
  const repris = db.reconcilierTravauxCoupes(t('err.interrompu-par-arret'));
  const total = repris.sessions + repris.horsDepot + repris.verifications;
  if (total) {
    console.log(t('log.start.reconciled', {
      sessions: repris.sessions, horsDepot: repris.horsDepot, verifications: repris.verifications,
    }));
  }
}

/* LA DERNIÈRE ÉTAPE : TOUTE ERREUR QUI N'A PAS ÉTÉ RATTRAPÉE RÉPOND EN JSON. Sans elle, Express
   rendait sa page d'erreur — pile d'appels et chemins absolus de la machine compris — pour un
   JSON malformé ou une route hors `wrap`. Le détail va au journal du serveur, pas à la réponse. */
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (res.headersSent) { try { res.end(); } catch { /* socket fermé */ } return; }
  const brut = Number(err && (err.status || err.statusCode));
  const status = brut >= 400 && brut < 600 ? brut : 500;
  if (status >= 500) console.log(`[http] ${req.method} ${req.path} : ${(err && err.message) || err}`);
  res.status(status).json({
    error: err && err.type === 'entity.parse.failed' ? t('err.http.json-illisible')
      : (status >= 500 ? t('err.http.interne') : t('err.http.requete-invalide')),
  });
});

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
  /* LA SYNCHRONISATION DU DÉPÔT DE DONNÉES. Sans URL configurée, `demarrer()` rend `false` et
     rien ne tourne : le mode mono-poste est exactement ce cas, et il ne coûte pas un timer. */
  /* EN DÉMO, LE DÉPÔT DE DONNÉES EXISTE VRAIMENT. Sans lui, la section « Données partagées »
     afficherait « mode mono-poste », le pied de page se tairait et le bouton « Historique »
     d'une page de notes resterait caché : on montrerait la fonctionnalité en la décrivant. */
  if (process.env.MERGERIE_DEMO === '1') {
    try {
      // eslint-disable-next-line global-require
      const origine = require('./demo-shared').preparer((m) => console.log(m));
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
    if (autoRefreshTimer) { clearInterval(autoRefreshTimer); autoRefreshTimer = null; }
    // Un timer oublié garde le process en vie : la suite de tests ne rendrait jamais la main.
    if (jiraWatchTimer) { clearInterval(jiraWatchTimer); jiraWatchTimer = null; }
    if (retentionTimer) { clearInterval(retentionTimer); retentionTimer = null; }
    if (archiveTimer) { clearInterval(archiveTimer); archiveTimer = null; }
    veille.arreter();
    /* Le moteur de dictée est un PROCESS ENFANT, pas un timer : oublié, il garde deux
       gigaoctets et le process en vie — la suite de tests ne rendrait jamais la main. */
    dictation.arreterMoteur();
    // Même raison pour le tic des horaires d'agents.
    agentschedule.arreter();
    return new Promise((resolve) => server.close(resolve));
  },
};
