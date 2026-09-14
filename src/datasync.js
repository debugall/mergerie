'use strict';
/* LE DÉPÔT DE DONNÉES PARTAGÉ — git comme moyen de transport, et rien d'autre.
 *
 * `src/store.js` a fait du dossier `data/shared/` la source de vérité : une entité, un fichier,
 * format déterministe. Ce module lui ajoute la seule chose qui manque pour qu'une ÉQUIPE s'en
 * serve : un dépôt git commun, qu'on tire et qu'on pousse tout seul.
 *
 * POURQUOI GIT, ET PAS UN SERVEUR. Il n'y a rien à installer, rien à administrer, rien à
 * sauvegarder à part : l'équipe a déjà une forge, des droits, des sauvegardes et un historique.
 * On gagne en prime « qui a décidé quoi, et quand », sans écrire une ligne pour ça.
 *
 * CE QUI REND LA CHOSE VIVABLE, ET QUI EST LE VRAI SUJET :
 *
 * — LES CONFLITS SONT RARES PAR CONSTRUCTION. Un fichier par entité, nommé par un ULID ou une
 *   clé naturelle : deux postes ne touchent le même fichier que s'ils ont vraiment modifié la
 *   même chose. Une review de plus, une note de plus, un agent de plus n'entrent jamais en
 *   collision.
 * — UN CONFLIT NE BLOQUE JAMAIS. On prend la version DISTANTE, on réapplique la sienne si elle
 *   est plus récente, sinon on la met de côté et on prévient. Jamais de `<<<<<<<` dans le dépôt,
 *   jamais de rebase en plan, jamais un utilisateur devant une commande git.
 * — HORS LIGNE, TOUT MARCHE. Les commits sont locaux ; le `pull` échoue en silence, le pied de
 *   page passe à l'orange, et le retard se rattrape au retour. Le mode mono-poste — URL vide —
 *   n'est que ce cas-là, sans dépôt distant.
 *
 * CE QUE CE MODULE NE FAIT PAS : lire ou écrire des lignes. Il ne connaît que des fichiers et
 * des commits, et délègue toute traduction à `store`.
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const db = require('./db');
const store = require('./store');
const registre = require('./store-registry');
const identite = require('./identite');
const { etat } = require('./localstate');
const { SHARED_DIR } = require('./paths');
const { getConfig } = require('./config');

const execFileP = promisify(execFile);

/* L'octet nul : `%x00` dans le format de `git log`. Il ne peut apparaître ni dans un nom de
   fichier ni dans un nom de personne, donc il sépare sans ambiguïté. */
const SEPARATEUR_AUTEUR = String.fromCharCode(0);

/* Regrouper les écritures : une review, c'est trois fichiers et une merge request touchée. Sans
   regroupement, on produirait quatre commits pour un seul geste, et l'historique — la seule
   chose que git nous offre gratuitement — deviendrait illisible. Trois secondes après la
   DERNIÈRE écriture, pas après la première : une autosauvegarde qui frappe toutes les secondes
   ne doit pas produire un commit par frappe. */
const REGROUPEMENT_MS = 3000;
const TENTATIVES_PUSH = 3;

let minuterieCommit = null;
let minuterieTour = null;
let enCours = false;
let dernierMessage = null;
const etatSync = {
  configure: false, enAvance: 0, enRetard: 0, dernierPull: null, dernierPush: null,
  erreur: null, conflits: 0,
};

/* ---------- git, en tout petit ---------- */

/* Un runner à nous, et non `src/git.js` : celui-ci passe par `proc`, la mécanique d'annulation
   des JOBS. Une synchronisation de fond n'est pas un job — l'utilisateur qui arrête une review
   ne doit pas arrêter la synchronisation, et inversement. */
async function git(args, opts = {}) {
  const { stdout } = await execFileP('git', args, {
    cwd: opts.cwd || SHARED_DIR,
    timeout: opts.timeout || 120000,
    maxBuffer: 32 * 1024 * 1024,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',          // jamais de demande de mot de passe : on ne la verrait pas
      GIT_ASKPASS: 'echo',
      ...(opts.env || {}),
    },
  });
  /* `trim()` PAR DÉFAUT — un sha, une liste de fichiers, un compteur se lisent mieux nus —, mais
     JAMAIS sur un CONTENU. Le store écrit des fichiers déterministes, terminés par un saut de
     ligne ; rendre `git show` rogné, c'est reposer un fichier qui n'est plus celui que le store
     écrirait, et tout export complet le réécrirait ensuite pour un octet. */
  return opts.brut ? String(stdout || '') : String(stdout || '').trim();
}

const gitOu = async (args, defaut = '', opts = {}) => {
  try { return await git(args, opts); } catch { return defaut; }
};

/** La sortie telle quelle : pour tout ce qui est un contenu de fichier et non une information. */
const gitBrut = async (args, defaut = '') => gitOu(args, defaut, { brut: true });

const estDepot = () => fs.existsSync(path.join(SHARED_DIR, '.git'));

/* ---------- Réglages et état ---------- */

const config = () => getConfig();
const urlDepot = () => String(config().data_repo_url || '').trim();
const branche = () => String(config().data_repo_branch || '').trim() || 'main';
const cadenceMs = () => Math.max(10, Number(config().data_sync_seconds) || 30) * 1000;

/** Le partage est-il demandé ? URL vide = mono-poste, et rien de ce module ne tourne. */
const estConfigure = () => Boolean(urlDepot());

/** Ce que le pied de page affiche : deux compteurs, deux dates, et la raison d'un ennui. */
function statut() {
  return {
    ...etatSync,
    configure: estConfigure(),
    clone: estDepot(),
    branch: branche(),
    identite: identite.identite(),
  };
}

/* ---------- Message de commit ---------- */

/* EN ANGLAIS ET SUR UNE LIGNE, comme les commits du code. Généré, parce que personne n'écrira un
   message à chaque todo cochée — mais généré À PARTIR DU GESTE, pas du fichier : « note "Prod
   deploy" » se relit dans six mois, « update 3 files » non. */
function messagePour(table, row) {
  const e = registre.pour(table);
  if (e && e.commitMessage) {
    try { return e.commitMessage(row, store.contexte()); } catch { /* on retombe sur le générique */ }
  }
  return `${table.replace(/_/g, ' ')} ${row && (row.slug || row.name || row.title || row.uid) ? String(row.slug || row.name || row.title || row.uid).slice(0, 60) : ''}`.trim();
}

/* ---------- Marquer, commiter ---------- */

/**
 * Une écriture a eu lieu : le dépôt est sale. On ne commite pas tout de suite — on attend que
 * le geste soit fini (§ REGROUPEMENT_MS).
 */
function marquerSale(message) {
  if (!estConfigure()) return;
  dernierMessage = message || dernierMessage;
  if (minuterieCommit) clearTimeout(minuterieCommit);
  minuterieCommit = setTimeout(() => { minuterieCommit = null; commiter().catch(() => {}); }, REGROUPEMENT_MS);
  if (minuterieCommit.unref) minuterieCommit.unref();
}

/** Commite ce qui a changé dans le dépôt de données. Sans rien à commiter, ne fait rien. */
async function commiter(message = null) {
  if (!estDepot()) return false;
  /* CE QUI N'EST PAS ENCORE ÉCRIT NE PEUT PAS ÊTRE COMMITÉ. On écoule la file avant de regarder
     ce qui a changé : sinon un commit partirait sans la modification qui l'a déclenché. */
  try { if (store.enRetard()) store.ecouler(); } catch { /* le tour suivant réessaiera */ }
  const qui = identite.identite();
  /* PAS D'IDENTITÉ GIT, PAS DE COMMIT. Un historique dont l'auteur est « unknown » ne répond pas
     à « qui a reviewé ça ? », et c'est la seule chose qu'on lui demande. On le dit dans l'état,
     et l'écran des réglages le montre — plutôt que d'écrire un historique inutilisable. */
  if (!qui.ok) { etatSync.erreur = 'git-identity'; return false; }
  await git(['add', '-A']);
  const enAttente = await gitOu(['diff', '--cached', '--name-only'], '');
  if (!enAttente) return false;
  const texte = (message || dernierMessage || 'update shared data').replace(/\s+/g, ' ').trim().slice(0, 72);
  dernierMessage = null;
  await git(['-c', `user.name=${qui.name}`, '-c', `user.email=${qui.email || 'mergerie@local'}`,
    'commit', '-m', texte]);
  await majCompteurs();
  return true;
}

/* ---------- Le tour : fetch, pull --rebase, hydrater, push ---------- */

/** Le dernier commit dont on a hydraté les fichiers. Local : il décrit CETTE base. */
const dernierHydrate = () => etat.lire('data', 'repo', 'hydrated_at');
const poserHydrate = (sha) => etat.ecrire('data', 'repo', 'hydrated_at', sha);

async function majCompteurs() {
  const sortie = await gitOu(['rev-list', '--left-right', '--count', `origin/${branche()}...HEAD`], '0\t0');
  const [retard, avance] = sortie.split(/\s+/).map((n) => Number(n) || 0);
  etatSync.enRetard = retard;
  etatSync.enAvance = avance;
}

/**
 * N'hydrate QUE ce qui a bougé. Une hydratation complète relit des milliers de fichiers ; après
 * un `pull` ordinaire, trois ont changé. Si le dernier commit hydraté n'est plus dans
 * l'historique — clone neuf, `reset`, base supprimée —, on repart de zéro.
 */
async function hydraterDepuis(avant, apres) {
  if (!avant || avant === apres) {
    if (!avant) { const bilan = store.hydraterTout(); poserHydrate(apres); return bilan; }
    return { ecrits: 0, supprimes: 0, orphelins: [] };
  }
  const connu = await gitOu(['cat-file', '-e', `${avant}^{commit}`], null).then(() => true).catch(() => false);
  const diff = connu === false ? null : await gitOu(['diff', '--name-only', `${avant}..${apres}`], null);
  if (diff === null) { const bilan = store.hydraterTout(); poserHydrate(apres); return bilan; }
  const fichiers = diff.split('\n').map((x) => x.trim()).filter(Boolean);
  const bilan = fichiers.length ? store.hydraterFichiers(fichiers) : { ecrits: 0, supprimes: 0, orphelins: [] };
  poserHydrate(apres);
  return bilan;
}

/**
 * Un tour complet. Jamais deux en même temps : une synchronisation qui se chevauche produit
 * exactement le genre de rebase à moitié fait qu'on veut éviter.
 */
async function tour() {
  if (!estConfigure() || !estDepot() || enCours) return null;
  enCours = true;
  const bilan = { pull: false, push: false, hydrate: null, conflits: [] };
  try {
    // Si l'on a accepté de dire sa dépense, c'est le moment : avant de regarder ce qui a changé.
    try { exporterUsage(); } catch { /* la dépense n'est pas une raison d'échouer une synchro */ }
    await git(['fetch', 'origin', branche()]);
    await majCompteurs();
    if (!etatSync.enRetard && !etatSync.enAvance) { etatSync.erreur = null; etatSync.dernierPull = new Date().toISOString(); return bilan; }

    for (let essai = 0; essai < TENTATIVES_PUSH; essai++) {
      const avant = await gitOu(['rev-parse', 'HEAD'], '');
      if (etatSync.enRetard) {
        const conflits = await rebaser();
        bilan.conflits.push(...conflits);
        bilan.pull = true;
      }
      const apres = await gitOu(['rev-parse', 'HEAD'], '');
      if (apres !== avant || !dernierHydrate()) {
        bilan.hydrate = await hydraterDepuis(dernierHydrate(), apres);
        // « par qui » : on ne relit que les commits nouveaux, pas tout l'historique.
        await majAuteurs(avant && apres !== avant ? `${avant}..${apres}` : null);
      }
      await majCompteurs();
      if (!etatSync.enAvance) break;
      try {
        await git(['push', 'origin', `HEAD:${branche()}`]);
        bilan.push = true;
        etatSync.dernierPush = new Date().toISOString();
        break;
      } catch {
        /* Quelqu'un a poussé entre-temps. On refait un tour. Après trois essais on ABANDONNE
           POUR CETTE FOIS — les commits restent locaux, donc rien n'est perdu, et le tour
           suivant réessaiera. Boucler indéfiniment sur un dépôt très actif bloquerait le
           serveur pour un gain nul. */
        await git(['fetch', 'origin', branche()]);
        await majCompteurs();
      }
    }
    etatSync.dernierPull = new Date().toISOString();
    etatSync.erreur = null;
  } catch (e) {
    /* HORS LIGNE EST LE CAS NORMAL, pas une panne : on note la raison, le pied de page passe à
       l'orange, et le prochain tour réessaie. Rien n'est perdu — tout est commité localement. */
    etatSync.erreur = String(e.message || e).slice(0, 300);
  } finally {
    enCours = false;
    etatSync.conflits = db.prepare("SELECT COUNT(*) n FROM local_state WHERE kind = 'conflict'").get().n;
  }
  return bilan;
}

/* ---------- Conflits : jamais de blocage, jamais de marqueur ---------- */

/**
 * `pull --rebase`, et s'il coince : LA VERSION DISTANTE GAGNE d'abord, puis on réapplique la
 * sienne si elle est plus récente. Ce choix n'est pas arbitraire — il rend la situation
 * toujours réparable d'un clic, là où un rebase interrompu demande de savoir ce qu'est un
 * rebase. La version écrasée n'est jamais perdue : elle est gardée, et l'écran le dit.
 */
async function rebaser() {
  const conflits = [];
  try {
    await git(['pull', '--rebase', 'origin', branche()]);
    return conflits;
  } catch {
    /* On est au milieu d'un rebase — et PENDANT UN REBASE, « ours » et « theirs » sont
       INVERSÉS par rapport à un merge. Git rejoue nos commits par-dessus les leurs : la branche
       en place est donc celle d'EN FACE (`--ours`, étape 2), et le commit qu'on est en train
       d'appliquer est le NÔTRE (`--theirs`, étape 3). Prendre `--theirs` ici, comme on le
       ferait pour un merge, garderait sa propre version en croyant prendre celle du voisin —
       et le conflit reviendrait au tour suivant, en boucle. */
    const enConflit = (await gitOu(['diff', '--name-only', '--diff-filter=U'], ''))
      .split('\n').map((x) => x.trim()).filter(Boolean);
    for (const fichier of enConflit) {
      const mienne = await gitBrut(['show', `:3:${fichier}`], null); // étape 3 = le commit rejoué
      await gitOu(['checkout', '--ours', '--', fichier], '');        // étape 2 = ce qui est déjà en place
      await gitOu(['add', '--', fichier], '');
      conflits.push({ fichier, mienne });
    }
    try { await git(['-c', 'core.editor=true', 'rebase', '--continue']); } catch {
      /* Même ça a échoué : on abandonne le rebase plutôt que de laisser le dépôt dans un état
         que personne ne saura défaire. Les commits locaux restent, le tour suivant réessaiera. */
      await gitOu(['rebase', '--abort'], '');
      return conflits;
    }
    for (const c of conflits) garderVersionEcrasee(c);
    return conflits;
  }
}

/** Garde la version écrasée, pour que l'écran puisse proposer de la reprendre. */
function garderVersionEcrasee({ fichier, mienne }) {
  if (!mienne) return;
  etat.ecrire('conflict', fichier, 'mine', mienne.slice(0, 200000));
  etat.ecrire('conflict', fichier, 'at', new Date().toISOString());
}

/* LES CONFLITS SE COMPTENT EN OBJETS, PAS EN FICHIERS. Une page de notes en produit DEUX — son
   corps et son `.json` jumeau —, et l'utilisateur, lui, a modifié UNE page. Lui en montrer deux
   lui demanderait de comprendre notre format de stockage pour répondre deux fois à la même
   question. On regroupe donc sur le fichier principal du document. */
function conflitsGardes() {
  const lignes = db.prepare(
    "SELECT ref AS fichier, value AS at FROM local_state WHERE kind = 'conflict' AND key = 'at' ORDER BY value DESC",
  ).all();
  const parDocument = new Map();
  for (const l of lignes) {
    const cle = store.versMd(l.fichier);
    if (!parDocument.has(cle)) parDocument.set(cle, { fichier: cle, at: l.at, fichiers: [] });
    const doc = parDocument.get(cle);
    doc.fichiers.push(l.fichier);
    // La version de l'utilisateur à MONTRER est celle du corps, pas celle des métadonnées.
    if (l.fichier === cle || doc.mienne === undefined) doc.mienne = etat.lire('conflict', l.fichier, 'mine');
  }
  return [...parDocument.values()];
}

/** Reprendre SA version : on réécrit les fichiers du document, le tour suivant les commitera. */
function reprendreVersion(cle) {
  const doc = conflitsGardes().find((c) => c.fichier === cle);
  if (!doc) return false;
  const repris = [];
  for (const fichier of doc.fichiers) {
    const mienne = etat.lire('conflict', fichier, 'mine');
    if (mienne !== null) { store.ecrireFichier(fichier, mienne); repris.push(fichier); }
    etat.oublier('conflict', fichier);
  }
  /* LE FICHIER REPOSÉ DOIT REDEVENIR LA LIGNE. Sans ça, l'écran continuerait d'afficher la
     version du voisin — celle que le rebase avait fait gagner — pendant que le dépôt, lui,
     porterait de nouveau la sienne : deux vérités, et l'utilisateur croirait son clic perdu. */
  if (repris.length) { try { store.hydraterFichiers(repris); } catch { /* le tour suivant relira */ } }
  marquerSale(`restore ${cle}`);
  return true;
}

/** Oublier un conflit sans rien reprendre — « garder la leur ». */
function oublierConflit(cle) {
  const doc = conflitsGardes().find((c) => c.fichier === cle);
  if (!doc) return false;
  for (const fichier of doc.fichiers) etat.oublier('conflict', fichier);
  return true;
}

/* ---------- LA DÉPENSE, SI ON VEUT BIEN LA DIRE ----------
 *
 * `usage` reste LOCAL : c'est la dépense d'un abonnement personnel, et rien n'oblige à la
 * publier. Coché, on n'envoie qu'un TOTAL PAR JOUR — jamais le détail par appel, qui dirait ce
 * qu'on a demandé et à quelle heure. C'est la différence entre « l'équipe sait ce qu'elle
 * dépense » et « l'équipe sait ce que je fais de mes journées ».
 *
 * Le fichier est nommé par l'identité git et par le mois : un fichier par personne et par mois,
 * donc deux postes n'écrivent jamais le même — aucun conflit possible.
 */
function exporterUsage() {
  const cfg = config();
  const qui = identite.identite();
  if (String(cfg.usage_share || '0') !== '1' || !qui.ok) return 0;
  const dossier = String(qui.name).replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 60) || 'inconnu';
  /* Trois mois glissants : au-delà, on réécrirait chaque jour des fichiers que plus personne ne
     regarde, et chaque réécriture est un commit. */
  const depuis = new Date(Date.now() - 92 * 86400000).toISOString();
  const lignes = db.prepare(`SELECT substr(created_at, 1, 10) AS jour, kind,
      COUNT(*) AS appels, SUM(tokens_est) AS tokens, SUM(COALESCE(cost_usd, 0)) AS cout
    FROM usage WHERE created_at >= ? GROUP BY jour, kind ORDER BY jour`).all(depuis);
  const parMois = new Map();
  for (const l of lignes) {
    const mois = l.jour.slice(0, 7);
    if (!parMois.has(mois)) parMois.set(mois, { who: qui.name, month: mois, days: {} });
    const doc = parMois.get(mois);
    if (!doc.days[l.jour]) doc.days[l.jour] = {};
    doc.days[l.jour][l.kind] = {
      calls: l.appels,
      tokens: l.tokens || 0,
      cost_usd: Math.round((l.cout || 0) * 10000) / 10000,
    };
  }
  for (const [mois, doc] of parMois) store.ecrireFichier(`usage/${dossier}/${mois}.json`, store.serialize(doc));
  return parMois.size;
}

/* ---------- QUI A ÉCRIT ÇA ----------
 *
 * « par Claire » sur une carte de review ne demande AUCUNE colonne : le fichier a été commité par
 * quelqu'un, et git le sait. Inventer une colonne `author` à côté, ce serait une seconde vérité à
 * tenir alignée — et elle mentirait le jour où quelqu'un corrige le fichier à la main.
 *
 * On ne relance pas `git log` à chaque affichage, en revanche : une liste de reviews en
 * demanderait cinquante, et elle se redessine toutes les secondes et demie. Le nom est donc mis
 * en cache dans `local_state`, et rafraîchi pour les seuls fichiers qu'un `pull` a touchés.
 */
const AUTEUR = 'author';

/** Le nom de qui a écrit ce fichier en dernier, ou `null`. Lu du cache. */
const auteurDe = (relatif) => etat.lire(AUTEUR, relatif, 'name');

/** Les auteurs de plusieurs fichiers d'un coup — pour une liste, une seule requete. */
function auteursDe(relatifs) {
  const tout = etat.carte(AUTEUR, 'name');
  return new Map(relatifs.map((r) => [r, tout.get(r) || null]));
}

/**
 * Relit les auteurs des fichiers touchés entre deux commits. Un seul `git log` : l'auteur sort
 * préfixé d'un octet nul — impossible dans un nom de fichier —, suivi des fichiers de son
 * commit. On garde le PREMIER vu pour chaque fichier : `git log` va du plus récent au plus
 * ancien, donc c'est bien le dernier à avoir écrit.
 */
async function majAuteurs(plage) {
  if (!estDepot()) return 0;
  const brut = await gitOu(['log', '--format=%x00%an', '--name-only', ...(plage ? [plage] : ['-2000'])], '');
  if (!brut) return 0;
  const vus = new Map();
  let courant = null;
  for (const ligne of brut.split('\n')) {
    if (ligne.startsWith(SEPARATEUR_AUTEUR)) { courant = ligne.slice(1).trim(); continue; }
    const f = ligne.trim();
    if (!f || !courant || vus.has(f)) continue;
    vus.set(f, courant);
  }
  db.transaction(() => {
    for (const [f, nom] of vus) etat.ecrire(AUTEUR, f, 'name', nom);
  })();
  return vus.size;
}

/* ---------- L'HISTOIRE D'UN FICHIER ----------
 *
 * C'est le seul service que git rend GRATUITEMENT et qu'il faut prendre : « qui a écrit ça, et
 * qu'est-ce qu'il y avait avant ? ». Aucune table à tenir, aucun champ à remplir — l'information
 * existe déjà parce qu'on est passé par git, et la montrer ne coûte qu'un appel.
 *
 * Bornée à quarante entrées : on veut relire les derniers changements d'une page, pas auditer
 * trois ans. */
async function historique(relatif, limite = 40) {
  if (!estDepot()) return [];
  const brut = await gitOu(['log', `-${Math.max(1, Math.min(200, limite))}`,
    '--format=%H%x1f%an%x1f%aI%x1f%s', '--', relatif], '');
  return brut.split('\n').filter(Boolean).map((l) => {
    const [sha, auteur, date, sujet] = l.split('\u001f');
    return { sha, auteur, date, sujet };
  });
}

/** Le diff d'UN commit sur CE fichier — pas le commit entier, qui en touche souvent d'autres. */
async function diffDe(relatif, sha) {
  if (!estDepot() || !/^[0-9a-f]{7,40}$/i.test(String(sha))) return '';
  return gitOu(['show', '--format=', '--patch', String(sha), '--', relatif], '');
}

/** Le contenu du fichier À un commit donné — ce qu'on remet si l'on veut revenir en arrière. */
async function contenuA(relatif, sha) {
  if (!estDepot() || !/^[0-9a-f]{7,40}$/i.test(String(sha))) return null;
  return gitBrut(['show', `${String(sha)}:${relatif}`], null);
}

/* ---------- Clonage / rattachement ---------- */

/**
 * Rattache ce poste au dépôt de données. Trois cas, et un seul geste :
 *   — le dossier n'est pas un dépôt et le distant a du contenu → on clone, puis on hydrate ;
 *   — le dossier n'est pas un dépôt et le distant est VIDE → on initialise avec ce qu'on a
 *     déjà en local. C'est la bascule d'une équipe : le poste qui a l'historique le pousse ;
 *   — c'est déjà un dépôt → on remet l'origine à jour, et on fait un tour.
 */
async function rattacher({ url, onLog = () => {} } = {}) {
  const adresse = String(url || urlDepot()).trim();
  if (!adresse) throw new Error('datasync: aucune URL de dépôt de données');
  const qui = identite.identite();
  if (!qui.ok) throw new Error('datasync: git n’a pas de `user.name` — configurez-le avant de partager');

  if (!estDepot()) {
    await git(['init'], { cwd: SHARED_DIR });
    await git(['symbolic-ref', 'HEAD', `refs/heads/${branche()}`]);
    await git(['remote', 'add', 'origin', adresse]);
  } else {
    await gitOu(['remote', 'remove', 'origin'], '');
    await git(['remote', 'add', 'origin', adresse]);
  }

  const distant = await gitOu(['ls-remote', '--heads', 'origin', branche()], '');
  if (distant) {
    onLog('fetch');
    await git(['fetch', 'origin', branche()]);
    /* `--autostash` : le dossier local porte peut-être déjà des fichiers (le store écrit dès la
       première note). On les remet par-dessus plutôt que de refuser, et le premier commit les
       emportera — c'est exactement ce qu'on veut pour un poste qui rejoint l'équipe. */
    await gitOu(['stash', 'push', '-u', '-m', 'mergerie-avant-rattachement'], '');
    await git(['reset', '--hard', `origin/${branche()}`]);
    await gitOu(['stash', 'pop'], '');
    const sha = await gitOu(['rev-parse', 'HEAD'], '');
    onLog('hydrate');
    const bilan = store.hydraterTout();
    poserHydrate(sha);
    /* CE POSTE APPORTE SON HISTORIQUE. Rejoindre une équipe, ce n'est pas repartir de zéro : les
       MR relues, les sessions, les notes accumulées ici depuis des mois doivent monter avec le
       premier commit — sans quoi le rattachement ne partagerait que ce qui sera écrit APRÈS, et
       le dépôt s'ouvrirait sur un dossier vide. Le cas est la règle, pas l'exception : un dépôt
       créé sur la forge porte presque toujours un commit initial (un README), donc on passe par
       ici et non par l'initialisation.
       APRÈS l'hydratation, jamais avant : exporter d'abord écraserait avec nos fichiers ceux
       qu'on vient de recevoir. Les lignes venues du dépôt se réécrivent à l'identique — la
       sérialisation est déterministe —, git ne voit rien ; seules les lignes qui n'existaient
       que chez nous font des fichiers neufs. */
    onLog('export');
    const compte = store.exporterTout();
    await majAuteurs(null);          // au rattachement, on recense tout ce que l'équipe a écrit
    await commiter('join shared data repository');
    /* On vient de commiter NOS fichiers : ils décrivent déjà cette base, il n'y a rien à en
       réhydrater. Sans ça le premier tour rejouerait notre propre export contre nous-mêmes. */
    poserHydrate(await gitOu(['rev-parse', 'HEAD'], sha));
    await majCompteurs();
    return { mode: 'clone', bilan, compte };
  }

  onLog('export');
  const compte = store.exporterTout();
  await commiter('initialise shared data repository');
  poserHydrate(await gitOu(['rev-parse', 'HEAD'], ''));
  try {
    await git(['push', '-u', 'origin', `HEAD:${branche()}`]);
    etatSync.dernierPush = new Date().toISOString();
  } catch (e) {
    etatSync.erreur = String(e.message || e).slice(0, 300);
  }
  await majCompteurs();
  return { mode: 'init', compte };
}

/* ---------- La boucle ---------- */

/* L'ABONNEMENT AU STORE. Chaque écriture de fichier marque le dépôt sale et arme le commit
   groupé. Posé UNE FOIS, au chargement : `marquerSale` ne fait rien tant que le partage n'est
   pas configuré, donc l'abonnement ne coûte rien en mode mono-poste. */
store.surEcriture((table, row, genre) => {
  marquerSale(genre === 'supprime' ? `remove ${messagePour(table, row)}` : messagePour(table, row));
});

function demarrer() {
  arreter();
  if (!estConfigure()) return false;
  minuterieTour = setInterval(() => { tour().catch(() => {}); }, cadenceMs());
  if (minuterieTour.unref) minuterieTour.unref();
  return true;
}

function arreter() {
  if (minuterieTour) clearInterval(minuterieTour);
  if (minuterieCommit) clearTimeout(minuterieCommit);
  minuterieTour = null;
  minuterieCommit = null;
}

module.exports = {
  REGROUPEMENT_MS,
  estConfigure,
  estDepot,
  statut,
  messagePour,
  marquerSale,
  commiter,
  tour,
  rattacher,
  exporterUsage,
  auteurDe,
  auteursDe,
  majAuteurs,
  historique,
  diffDe,
  contenuA,
  conflitsGardes,
  reprendreVersion,
  oublierConflit,
  hydraterDepuis,
  demarrer,
  arreter,
};
