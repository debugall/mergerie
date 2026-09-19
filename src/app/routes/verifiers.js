'use strict';
/* Les vérificateurs : leurs commandes, leurs dépôts, leur environnement, leur gabarit de commentaire, leur approbation.
   Extrait de server.js (réorganisation de src/ par couches) : les corps sont ceux du serveur, au mot près. */
const { app } = require('../app');
const db = require('../../db');
const store = require('../../data/store');
const approbation = require('../../data/approbation');
const verifierenv = require('../../verify/verifierenv');
const configModule = require('../../data/config');
const { getConfig, updateConfig } = configModule;
const i18n = require('../../core/i18n');
const { t } = i18n;
const verifyLib = require('../../verify/verify');
const verifyrun = require('../../verify/verifyrun');
const path = require('path');
const { repoById, wrap } = require('../http');
const { exigerMemeEtat } = require('../lib/verifications');

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
