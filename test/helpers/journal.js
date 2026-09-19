'use strict';
/* DES JOBS DE FOND PILOTABLES, POUR LES TESTS DU PANNEAU DE JOURNAL.
 *
 * Le panneau de journal (bandeau de job, file d'attente, onglets parallèles, Stop, Activité)
 * ne se teste qu'avec des jobs qu'on tient en main : un job qui TOURNE tant que le test ne l'a
 * pas libéré, un job qui échoue, un job bavard. Une review en dry-run dure quelques dizaines de
 * millisecondes — trop vite pour observer « en cours », et parier sur sa durée serait parier
 * sur la vitesse de la machine.
 *
 * On passe donc par la seule saveur de job qui exécute une commande qu'on écrit soi-même : une
 * cible `make` à côté d'un fichier compose (job « docker », `op: make`). Chaque cible `porte-*`
 * attend un FEU VERT — un fichier que le test pose — au lieu d'un délai : le job dure exactement
 * le temps que le test décide, sur un runner lent comme sur une machine rapide. Un plafond de
 * deux minutes l'empêche de survivre à un test qui aurait oublié de le libérer.
 *
 * Un job docker ne touche aucun dépôt : il peut tourner à côté de n'importe quel autre, ce qui
 * rend la voie parallèle (« Lancer en parallèle ») exerçable sans conflit.
 *
 * Aucun module de `src/` n'est chargé ici : ce helper peut être requis en tête de fichier. */

const fs = require('node:fs');
const path = require('node:path');

// Une cible qui attend son fichier de feu vert (`.feu-<cible>`), 1 200 × 0,1 s au plus.
const porte = (nom) => [
  `${nom}: ## Attend le feu vert du test`,
  `\t@echo "${nom} : en attente du feu vert"`,
  `\t@i=0; while [ ! -f .feu-$@ ] && [ $$i -lt 1200 ]; do sleep 0.1; i=$$((i+1)); done`,
  `\t@echo "${nom} : feu vert reçu"`,
];

const MAKEFILE = [
  '.PHONY: bavard casse flot porte-a porte-b porte-c porte-d porte-e porte-f',
  'bavard: ## Un journal varié : en-tête, erreurs, lignes ordinaires',
  '\t@echo "=== Préparation ==="',
  '\t@echo "installation des dépendances"',
  '\t@echo "ERROR: connexion ECONNREFUSED 127.0.0.1:5432"',
  '\t@echo "nouvelle tentative"',
  '\t@echo "fatal: délai dépassé sur le registre"',
  '\t@echo "compilation terminée"',
  'casse: ## Échoue exprès',
  '\t@echo "avant la casse"',
  '\texit 3',
  // Cent cinquante lignes, le feu vert, cent cinquante autres : de quoi faire défiler.
  'flot: ## Beaucoup de lignes, en deux temps',
  '\t@for i in $$(seq 1 150); do echo "flot ligne $$i"; done',
  '\t@i=0; while [ ! -f .feu-$@ ] && [ $$i -lt 1200 ]; do sleep 0.1; i=$$((i+1)); done',
  '\t@for i in $$(seq 151 300); do echo "flot ligne $$i"; done',
  ...['porte-a', 'porte-b', 'porte-c', 'porte-d', 'porte-e', 'porte-f'].flatMap(porte),
  '',
].join('\n');

/* Crée le chantier (un compose + ce Makefile) sous `racine` et l'enregistre comme répertoire
   local : c'est ce que le serveur exige avant d'exécuter une cible make. */
async function preparerChantier(app, racine) {
  const dir = path.join(racine, 'chantier');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'compose.yaml'), 'name: chantier\nservices: {}\n');
  fs.writeFileSync(path.join(dir, 'Makefile'), MAKEFILE);
  const r = await app.api('POST', '/api/local-roots', { path: racine });
  if (r.status !== 200) throw new Error(`répertoire local refusé : ${r.status} ${r.text}`);

  return {
    dir,
    // Lance une cible (le feu vert d'une exécution précédente est retiré d'abord).
    async lancer(cible) {
      try { fs.rmSync(path.join(dir, `.feu-${cible}`)); } catch { /* absent */ }
      const res = await app.api('POST', '/api/docker/make/run', { dir, target: cible });
      if (res.status !== 200 || !res.body || !res.body.id) throw new Error(`lancement de ${cible} refusé : ${res.status} ${res.text}`);
      return res.body.id;
    },
    feuVert(cible) { fs.writeFileSync(path.join(dir, `.feu-${cible}`), 'go'); },
    // Libère toutes les portes : à appeler en fin de fichier, pour ne laisser aucun make derrière soi.
    toutLiberer() {
      for (const c of ['flot', 'porte-a', 'porte-b', 'porte-c', 'porte-d', 'porte-e', 'porte-f']) {
        try { fs.writeFileSync(path.join(dir, `.feu-${c}`), 'go'); } catch { /* dossier parti */ }
      }
    },
  };
}

// Le job tel que le serveur le voit (la ligne de l'historique).
async function jobServeur(app, id) {
  const { body } = await app.api('GET', '/api/jobs/history?limit=200');
  return (body.jobs || []).find((j) => j.id === id) || null;
}

module.exports = { preparerChantier, jobServeur };
