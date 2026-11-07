'use strict';
/* Les tests touchés : les défauts livrés (pour « Remettre les défauts ») et l'aperçu d'un réglage —
   « sur les MR ouvertes de ce dépôt, ces motifs classent 41 fichiers en tests, 12 en neutres ».
   Lecture de la base, zéro réseau, zéro IA. */
const { app } = require('../app');
const { getConfig } = require('../../data/config');
const testsTouches = require('../../review/tests-touches');
const { wrap } = require('../http');

app.get('/api/tests-touches/defauts', wrap((req, res) => {
  res.json({ test_patterns: testsTouches.DEFAUT_TESTS.join('\n'), neutral_patterns: testsTouches.DEFAUT_NEUTRES.join('\n'), max: testsTouches.MAX_MOTIFS });
}));

/* L'aperçu valide les motifs comme l'enregistrement le ferait : un glob refusé est dit avec sa
   ligne avant d'être enregistré, pas découvert à l'affichage. */
app.post('/api/tests-touches/apercu', wrap((req, res) => {
  const b = req.body || {};
  const test_patterns = b.test_patterns != null ? testsTouches.normaliserMotifs(b.test_patterns) : null;
  const neutral_patterns = b.neutral_patterns != null ? testsTouches.normaliserMotifs(b.neutral_patterns) : null;
  res.json(testsTouches.apercu(getConfig(), {
    repoId: Number(b.repo_id) || null, groupId: Number(b.group_id) || null, test_patterns, neutral_patterns,
  }));
}));
