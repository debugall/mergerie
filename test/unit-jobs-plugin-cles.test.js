'use strict';
/* CE QU'UN JOB DE PLUGIN TOUCHE. Il ne touche aucun clone tant qu'il ne le DÉCLARE pas (`repoIds`, `dirs` à `ctx.jobs.start`) — Docker tourne avec tout le monde —, et
 * dès qu'il le déclare il se sérialise avec les reviews, sessions et vérifications du même clone ou du même dossier : un futur plugin Git ne peut pas faire de `git` dans un
 * clone qu'une session est en train de modifier. */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.MERGERIE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'jobs-cles-'));

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

describe('jobKeys d’un job de plugin', () => {
  const file = require('../src/jobs/file');
  require('../src/jobs/runners/plugin');
  const jobsPlugins = require('../src/plugins/jobs-plugins');
  jobsPlugins.inscrire('demo', 'op', async () => {}, async () => ({ code: 0, tail: '' }));
  const lancer = (options) => {
    const { id } = jobsPlugins.demarrer('demo', 'op', null, options);
    return file.queue.find((e) => e.jobId === id);
  };

  test('sans déclaration : aucune clé, parallélisable avec tout', () => {
    assert.deepEqual([...file.jobKeys(lancer({ label: 'rien' }))], []);
  });

  test('un dépôt et un dossier déclarés deviennent des clés, nettoyées', () => {
    const e = lancer({ repoIds: [3, '3', 0, 'x', 7], dirs: ['/p/a', '', '/p/a'] });
    assert.deepEqual([...file.jobKeys(e)].sort(), ['dir:/p/a', 'repo:3', 'repo:7']);
  });

  test('il entre en conflit avec une session du même dépôt, pas avec un autre', () => {
    const e = lancer({ repoIds: [3] });
    assert.equal(file.keysClash(file.jobKeys(e), new Set(['repo:3'])), true);
    assert.equal(file.keysClash(file.jobKeys(e), new Set(['repo:4'])), false);
    assert.equal(file.keysClash(file.jobKeys(lancer({})), new Set(['repo:3'])), false, 'sans déclaration, jamais en conflit avec un dépôt');
  });
});
