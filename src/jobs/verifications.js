'use strict';
/* Créer une vérification : le vérificateur qui couvre les cibles, le mode de chaque cible, la ligne en
   base et son job. Descendu de `app/lib/verifications.js` dans `jobs/` parce qu'une vérification n'est
   plus seulement lancée par un clic : un enchaînement de vérificateurs (`plan-verif.js`) lance la
   suivante quand la précédente finit, depuis l'exécutant du job. */
const db = require('../db');
const store = require('../data/store');
const approbation = require('../data/approbation');
const groupes = require('../data/groupes');
const { t } = require('../core/i18n');
const { verifyBloquePar } = require('./file');
const { startVerifyJob } = require('./ordonnanceur');

/* Le vérificateur doit couvrir TOUS les dépôts visés. Un run partiel donnerait un vert qui
   ne dit rien de la moitié du lot — pire qu'une absence de verdict. */
function verifierPour(cibles, verifierId) {
  const ids = cibles.map((c) => c.repo_id);
  const candidats = db.prepare('SELECT * FROM verifier ORDER BY name').all().filter((v) => {
    const couverts = groupes.couvertureVerifier(v.id);   // dépôts directs ET dépôts des groupes
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
  const par = groupes.couvertureVerifier(verifier.id);   // une ligne directe l'emporte, un groupe = worktree
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
/* `planRunId` et `positions` : posés par un enchaînement de vérificateurs (`plan-verif.js`) — le lancement
   auquel la vérification appartient, et les dépôts du plan que CE vérificateur ne couvre pas, à mettre sur
   leur ref dans le clone local le temps du run. */
function creerVerification({ verifier, cibles, lotId = null, enFile = false, automatique = false, homeJetable = null, planRunId = null, positions = null }) {
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
  const bloque = enFile ? null : verifyBloquePar(cibles.map((c) => c.repo_id));
  if (bloque) {
    throw new Error(t(bloque === 'integration' ? 'err.verify.integration-running' : 'err.verify.already-running'));
  }
  const lot = lotId ? db.prepare('SELECT name FROM lot WHERE id = ?').get(lotId) : null;
  /* On recopie les noms : le rapport doit rester lisible après suppression du vérificateur
     ou du lot, et sa suppression ne doit jamais être bloquée par un vieux verdict. */
  /* LE `HOME` DE CE RUN : jetable d'office pour un run automatique ; pour un run à la main, la case
     de la fenêtre de lancement (mémorisée sur le vérificateur) — absente du corps, le réglage du
     vérificateur. Un choix fait au clic est retenu pour la prochaine fois : c'est ce qu'on entend
     par « mémorisée par vérificateur ». */
  const jetable = automatique ? 1 : (homeJetable == null ? (verifier.isolated_home ? 1 : 0) : (homeJetable ? 1 : 0));
  if (!automatique && homeJetable != null && jetable !== (verifier.isolated_home ? 1 : 0)) {
    store.ecrire('verifier', () => { db.prepare('UPDATE verifier SET isolated_home = ? WHERE id = ?').run(jetable, verifier.id); return verifier.id; });
  }
  const info = db.prepare(`INSERT INTO verification
    (verifier_id, verifier_name, lot_id, lot_name, status, targets_json, created_at, automatic, isolated_home, plan_run_id, positions_json)
    VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?)`).run(verifier.id, verifier.name, lotId,
    lot ? lot.name : null, JSON.stringify(cibles), new Date().toISOString(), automatique ? 1 : 0, jetable,
    planRunId, positions && positions.length ? JSON.stringify(positions) : null);
  const id = info.lastInsertRowid;
  const job = startVerifyJob(id);
  return { verification: db.prepare('SELECT * FROM verification WHERE id = ?').get(id), job };
}

/* ---------- Cibles depuis des refs (branche ou tag), sans merge request ----------
   Vérifier une branche (Reviews) et les préparations de Git → Vérificateur partagent cette lecture. */
/* Une ref telle que git l'admet — et surtout pas une option : elle sera passée à `rev-parse` dans
   le job. Pas de tiret en tête, pas de `..`, ni blanc ni caractère que git refuse de toute façon. */
const REF_SURE = /^(?!-)(?!.*\.\.)(?!.*[\s~^:?*[\\])[^\0]{1,200}$/;
function ciblesDepuisBranches(entrees) {
  const cibles = [];
  const vus = new Set();
  for (const e of entrees) {
    const repo = db.prepare('SELECT * FROM repo WHERE id = ?').get(Number(e.repo_id));
    if (!repo) throw new Error(t('err.depot-introuvable'));
    if (vus.has(repo.id)) throw new Error(t('err.verify.repo-twice'));
    vus.add(repo.id);
    const tag = String(e.tag || '').trim();
    const branche = String(e.branch || '').trim();
    if (!tag && !branche) throw new Error(t('err.verify.branch-required', { project: repo.project }));
    if (!REF_SURE.test(tag || branche)) throw new Error(t('err.verify.invalid-ref', { ref: tag || branche, project: repo.project }));
    /* LE SHA N'EST PLUS RÉSOLU ICI MAIS DANS LE JOB. Cloner ou rapatrier chaque dépôt avant de
       répondre tenait la fenêtre de lancement ouverte, bouton en attente, pendant une dizaine de
       secondes par dépôt — sans rien dire. La cible part avec sa ref (`origin/<branche>` ou le
       commit pointé par le tag, `^{commit}` : l'objet d'un tag annoté a son propre SHA, qu'aucun
       checkout ne veut), et `executerVerification` la résout en SHA au premier usage, clone et
       fetch compris, sous les yeux du journal — comme il le fait déjà pour la base d'une MR. Une
       ref inconnue met la vérification en erreur, avec son nom, au lieu de bloquer la fenêtre.
       Le verdict reste attaché à des commits : la cible est réécrite résolue avant de tourner. */
    const ref = tag ? `refs/tags/${tag}^{commit}` : `origin/${branche}`;
    /* `branch` porte le nom du tag aussi : c'est le champ que le rapport, le brief et le
       commentaire écrivent déjà ; `tag` dit qu'il s'agit d'un tag, pour l'annoncer comme tel. */
    cibles.push({
      repo_id: repo.id, mr_id: null, head_sha: ref,
      base_sha: null, branch: tag || branche, tag: tag || null, mode: 'worktree',
    });
  }
  return cibles;
}

module.exports = { verifierPour, appliquerModes, creerVerification, ciblesDepuisBranches, REF_SURE };
