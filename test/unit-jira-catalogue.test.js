'use strict';
/* LE CATALOGUE DES FILTRES JIRA, LA PARTIE PURE : ce que Jira déclare pour un projet (types,
   composants, versions non archivées) et les sprints de ses tableaux — dédoublonnés, les clos
   bornés aux plus récents. Sans base, sans Jira. */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const catalogue = require('../src/integrations/jiracatalogue.js');

describe('jiracatalogue', () => {
  test('le détail d’un projet donne ses types, composants et versions — sans les archivées', () => {
    const m = catalogue.metaDeProjet({
      issueTypes: [{ name: 'Story' }, { name: 'Bug' }, { name: 'Sous-tâche', subtask: true }, { name: 'Bug' }],
      components: [{ name: 'web' }, { name: 'api' }],
      versions: [{ name: '2.10' }, { name: '2.9' }, { name: '1.0', archived: true }],
    });
    assert.deepEqual(m.type.map((x) => x.v), ['Bug', 'Sous-tâche', 'Story']);
    assert.deepEqual(m.components.map((x) => x.v), ['api', 'web']);
    assert.deepEqual(m.fixVersions.map((x) => x.v), ['2.9', '2.10'], 'tri naturel, archivée retirée');
    assert.deepEqual(catalogue.metaDeProjet(null), { type: [], components: [], fixVersions: [] });
  });

  test('les sprints : dédoublonnés entre tableaux, ouverts d’abord, puis les clos les plus récents', () => {
    const clos = Array.from({ length: catalogue.SPRINTS_CLOS_GARDES + 5 }, (_, i) => ({
      id: i + 1, name: `S${i + 1}`, state: 'closed', startDate: new Date(Date.UTC(2024, 0, 1 + i * 14)).toISOString(),
    }));
    const r = catalogue.sprintsDeTableaux([
      [{ id: 900, name: 'Courant', state: 'active' }, { id: 901, name: 'Suivant', state: 'future' }],
      clos,
      [{ id: 900, name: 'Courant', state: 'active' }],   // le même sprint, vu par un second tableau
    ]);
    assert.deepEqual(r.slice(0, 2).map((s) => s.l), ['Courant', 'Suivant']);
    assert.equal(r.length, 2 + catalogue.SPRINTS_CLOS_GARDES);
    assert.equal(r[2].l, `S${clos.length}`, 'le clos le plus récent en tête des clos');
    assert.ok(!r.some((s) => s.l === 'S1'), 'les plus anciens au-delà du plafond sont laissés');
  });
});
