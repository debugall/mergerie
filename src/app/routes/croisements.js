'use strict';
/* Les croisements de merge requests vus depuis la modale de session : ce que le dépôt choisi porte
   comme MR ouvertes, et ce qu'elles touchent. Lecture de la base, zéro réseau, zéro IA. */
const { app } = require('../app');
const { getConfig } = require('../../data/config');
const croisements = require('../../review/croisements');
const empilees = require('../../review/empilees');
const { wrap } = require('../http');

/* Sous le sélecteur de dépôt de la modale de session : `N MR ouvertes sur ce dépôt`, les
   croisements de la MR dont la session repart (`branch`), et les MR ouvertes qui touchent un
   chemin écrit dans le prompt (`text`, chemin existant dans le clone). Information seulement. */
app.post('/api/croisements/session', wrap((req, res) => {
  const cfg = getConfig();
  const b = req.body || {};
  const cibles = Array.isArray(b.targets) ? b.targets : [];
  const texte = String(b.text || '').slice(0, 20000);
  res.json({
    enabled: croisements.actif(cfg),
    targets: cibles.slice(0, 50).map((c) => {
      const d = croisements.pourSession(cfg, { repoId: c && c.repo_id, branch: String((c && c.branch) || '').trim(), texte });
      // La session repart de la branche d'une MR ouverte : « la branche créée contiendra !214 ».
      if (d) d.stack = empilees.pourBranche(cfg, { repoId: d.repo_id, branch: String((c && c.branch) || '').trim() });
      return d;
    }).filter(Boolean),
  });
}));
