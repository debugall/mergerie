'use strict';
/* Les données partagées : l’état du dépôt de données, l’aperçu, l’attache, la réexportation, la synchro à la demande, les conflits ; l’export d’une réponse en .docx ; la sauvegarde.
   Extrait de server.js (réorganisation de src/ par couches) : les corps sont ceux du serveur, au mot près. */
const { app } = require('../app');
const db = require('../../db');
const store = require('../../data/store');
const datasync = require('../../data/datasync');
const registre = require('../../data/store-registry');
const configModule = require('../../data/config');
const { getConfig, updateConfig } = configModule;
const i18n = require('../../core/i18n');
const { t } = i18n;
const docx = require('../../integrations/docx');
const backup = require('../../data/backup');
const { wrap } = require('../http');

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
  mr: 'mrs', review: 'reviews', review_version: 'reviews', finding: 'reviews',
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
