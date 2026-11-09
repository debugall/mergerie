'use strict';
/* La page d'équipe « Notre matin » : une lecture, zéro écriture, zéro appel sortant. HTTP seulement —
   le calcul est dans `notes/equipe.js`. */
const { app } = require('../app');
const db = require('../../db');
const { getConfig } = require('../../data/config');
const datasync = require('../../data/datasync');
const equipe = require('../../notes/equipe');
const { wrap } = require('../http');

app.get('/api/equipe', wrap((req, res) => {
  const cfg = getConfig();
  const d = equipe.construire(cfg, {
    seuilPret: cfg.converge_threshold, silencieuxJours: cfg.team_quiet_days,
    groupId: Number(req.query.group_id) || null, personne: String(req.query.person || '').trim() || null,
  });
  const s = datasync.statut();
  res.json({
    ...d,
    sync: { last: [s.dernierPull, s.dernierPush].filter(Boolean).sort().pop() || null, next: s.prochain || null, cadence: s.cadence || null, error: s.erreur || null },
    groups: db.prepare('SELECT id, name FROM repo_group ORDER BY name').all(),
  });
}));
