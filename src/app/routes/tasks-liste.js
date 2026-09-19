'use strict';
/* La liste des sessions de codage et d’exploration, une fiche, et les sessions d’agent — ce que l’onglet AI Dev affiche avant qu’on ouvre quoi que ce soit.
   Extrait de server.js (refacto.md, étape 2) : les corps sont ceux du serveur, au mot près. */
const { app } = require('../app');
const db = require('../../db');
const i18n = require('../../core/i18n');
const { t } = i18n;
const { wrap } = require('../http');
const { auteurs, avecRangement, rangement } = require('../lib/partage');
const { piecesExposees } = require('../lib/pieces');
const { chapeauReponse, coutParSession, dureeParSession, taskById, taskTargets } = require('../lib/sessions');

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
