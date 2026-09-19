'use strict';
/* Les objets partagés entre collègues : qui est l’auteur d’une ligne, qui a le droit de la retirer, et la présentation des passes d’agent.
   Extrait de server.js (réorganisation de src/ par couches) : les corps sont ceux du serveur, au mot près. */
const db = require('../../db');
const { etat: etatLocal, pref: prefLocale } = require('../../data/localstate');
const store = require('../../data/store');
const datasync = require('../../data/datasync');
const identite = require('../../core/identite');
const i18n = require('../../core/i18n');
const { t } = i18n;
const agentpass = require('../../agent/pass');
const protocol = require('../../agent/protocol');
const { readFileSafe } = require('../http');

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
  /* Une page ou une todo partagée se corrige à plusieurs : son auteur est celui qui l'a PARTAGÉE
     (le premier à avoir écrit son fichier), pas le dernier à l'avoir touchée. Sinon une
     correction de Claire faisait d'elle l'autrice de ma page — et m'interdisait de la retirer. */
  const parFichier = datasync.auteursDe([...new Set(chemins.values())], { createur: table === 'note_page' || table === 'todo' });
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

module.exports = {
  sansChangement, recalculable, unitesAvecRetour, passesPayload, auteurs, auteurDeLigne, exigerProprietaire, basculerPartage, rangement, avecRangement,
};
