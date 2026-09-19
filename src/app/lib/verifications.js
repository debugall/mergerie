'use strict';
/* Une vérification vue par la couche HTTP : ses cibles, la créer, la détailler, la résumer, et la dernière connue de chaque MR (mémorisée le temps d’une requête).
   Extrait de server.js (réorganisation de src/ par couches) : les corps sont ceux du serveur, au mot près. */
const db = require('../../db');
const approbation = require('../../data/approbation');
const i18n = require('../../core/i18n');
const { t } = i18n;
const jobs = require('../../jobs');
const verifyLib = require('../../verify/verify');
const verifyrun = require('../../verify/verifyrun');
const { mrById } = require('../http');
const memo = require('../middleware/memo-requete');

/* L'état APPROUVÉ est celui que l'écran a montré : sa signature revient avec le clic, et un objet
   changé entre-temps par la synchro est refusé (409) — l'écran recharge et le montre. */
function exigerMemeEtat(vue, courante) {
  if (vue !== courante) throw Object.assign(new Error(t('err.approval.stale')), { status: 409, code: 'APPROBATION_PERIMEE' });
}
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
  if (!memo.verifs) memo.verifs = dernieresVerificationsParMr();
  return memo.verifs;
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

module.exports = {
  exigerMemeEtat, ciblesDepuisMrs, verifierPour, appliquerModes, creerVerification, detailVerification, resumeVerification, verifsParMrDuTour, dernieresVerificationsParMr, lotAvecMembres, promptCorrectionVerif, messageCorrectionVerif,
};
