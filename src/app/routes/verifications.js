'use strict';
/* Lancer et consulter une vérification — d’une MR, d’un lot, d’une branche sans MR —, publier son verdict, et ouvrir la session qui la corrige.
   Extrait de server.js (refacto.md, étape 2) : les corps sont ceux du serveur, au mot près. */
const { app } = require('../app');
const db = require('../../db');
const configModule = require('../../data/config');
const { getConfig, updateConfig } = configModule;
const i18n = require('../../core/i18n');
const { t } = i18n;
const git = require('../../git/git');
const docker = require('../../integrations/docker');
const verifyrun = require('../../verify/verifyrun');
const path = require('path');
const fs = require('fs');
const { mrById, wrap } = require('../http');
const { auteurs } = require('../lib/partage');
const { insertTargets, normalizeTargets, taskById, taskTargets } = require('../lib/sessions');
const { appliquerModes, ciblesDepuisMrs, creerVerification, detailVerification, lotAvecMembres, messageCorrectionVerif, promptCorrectionVerif, verifierPour } = require('../lib/verifications');

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
