'use strict';
/* Les règles de review spécifiques : lister, créer, modifier, supprimer.
   Extrait de server.js (réorganisation de src/ par couches) : les corps sont ceux du serveur, au mot près. */
const { app } = require('../app');
const db = require('../../db');
const store = require('../../data/store');
const i18n = require('../../core/i18n');
const { t } = i18n;
const glob = require('../../core/glob');
const { wrap } = require('../http');
const { auteurs } = require('../lib/partage');

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
