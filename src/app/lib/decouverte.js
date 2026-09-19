'use strict';
/* Découvrir les MR sur les forges, et ce qui se déclenche tout seul ensuite : vérifications et reviews automatiques, avec leurs plafonds.
   Extrait de server.js (refacto.md, étape 2) : les corps sont ceux du serveur, au mot près. */
const db = require('../../db');
const datasync = require('../../data/datasync');
const approbation = require('../../data/approbation');
const identite = require('../../core/identite');
const configModule = require('../../data/config');
const { getConfig, updateConfig } = configModule;
const i18n = require('../../core/i18n');
const { t } = i18n;
const notify = require('../../core/notify');
const { discoverAll } = require('../../notes/discover');
const jobs = require('../../jobs');
const forge = require('../../forge');
const docker = require('../../integrations/docker');
const { mrById } = require('../http');
const { forgeIdentite } = require('./forge-identite');
const { appliquerModes, ciblesDepuisMrs, creerVerification } = require('./verifications');

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

module.exports = {
  plafondVerifAuto, servicesPretsPour, lancerVerificationsAuto, plafondReviewAuto, lancerLotReview, AUTEUR_AUTO, executantAuto, dernierRefusAuto, direRefusAuto, mrDeMoi, mrsAMoi, lancerReviewsAuto, lancerRereviewsAuto, decouvrir,
};
