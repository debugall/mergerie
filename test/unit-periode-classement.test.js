'use strict';
/* ISOLER LES COMMITS DIRECTS — le seul vrai risque fonctionnel de Notes → Période : un faux
 * « sans relecture » accuse un collègue d'avoir contourné le processus. L'algorithme est pur
 * (`classer`), et se prouve ici sur chaque stratégie de merge sans git ni forge :
 *   merge commit, squash, fast-forward (même SHA), rebase-merge à SHA réécrits (patch-id),
 *   merge manuel, revert, bot, plafond de la passe forge (« non vérifié », jamais « direct »).
 * Puis le regroupement en pushs, et le classement d'une MR par la date de l'événement. */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { classer, regrouperPushs, classerMr } = require('../src/notes/periode-classement');

const c = (sha, o = {}) => ({ sha, parents: o.parents || ['p'], author: o.author || 'karim', author_email: o.email || 'k@x', date: o.date || '2026-10-05T10:00:00Z', title: o.title || `commit ${sha}`, branche: o.branche || 'main', patch_id: o.patch_id || null });

describe('periode-classement · classer()', () => {
  test('un merge commit, un squash et un fast-forward sont attribués par les SHA connus (passe 1)', () => {
    const mrs = [
      { iid: 1, head_sha: 'a1', merge_commit_sha: 'M1', squash_commit_sha: null },
      { iid: 2, head_sha: 'b1', merge_commit_sha: null, squash_commit_sha: 'S1' },
      { iid: 3, head_sha: 'c1', merge_commit_sha: null, squash_commit_sha: null },
    ];
    const r = classer({ candidats: [c('M1', { parents: ['x', 'a1'] }), c('S1'), c('c1'), c('d1')], mrs });
    assert.deepEqual(r.attribues.map((a) => [a.sha, a.iid, a.par]), [['M1', 1, 'sha'], ['S1', 2, 'sha'], ['c1', 3, 'sha']]);
    assert.deepEqual(r.directs.map((d) => d.sha), ['d1']);
    assert.deepEqual(r.aVerifier, ['d1'], 'ce qui reste est à demander à la forge');
  });

  test('un merge commit dont le second parent est la tête d’une MR est son merge (passe 1 bis)', () => {
    const mrs = [{ iid: 7, head_sha: 'h7' }];
    const r = classer({ candidats: [c('M7', { parents: ['x', 'h7'] })], mrs });
    assert.equal(r.attribues[0].par, 'merge');
    // …et par le détour « descend d'une MR » (merge train) que l'appelant a résolu avec git.
    const r2 = classer({ candidats: [c('M8', { parents: ['x', 'h7bis'] })], mrs, secondParentMr: new Map([['M8', 7]]) });
    assert.equal(r2.attribues[0].iid, 7);
  });

  test('un rebase-merge GitHub réécrit les SHA : le patch-id reconnaît le contenu (passe 2)', () => {
    const mrs = [{ iid: 4, head_sha: 'orig2', merge_commit_sha: 'new2' }];
    const patchIdsParMr = new Map([['pid-1', 4], ['pid-2', 4]]);
    const r = classer({ candidats: [c('new1', { patch_id: 'pid-1' }), c('new2', { patch_id: 'pid-2' })], mrs, patchIdsParMr });
    assert.deepEqual(r.attribues.map((a) => [a.sha, a.par]), [['new1', 'patch'], ['new2', 'sha']], 'le dernier commit réécrit est aussi le merge_commit_sha');
    assert.equal(r.directs.length, 0);
  });

  test('la forge attribue ce qui reste (passe 3) ; au-delà du plafond, « non vérifié », jamais « direct »', () => {
    const r = classer({
      candidats: [c('e1'), c('e2'), c('e3')], mrs: [],
      mrsParCommit: new Map([['e1', [12]], ['e2', []]]), nonVerifies: new Set(['e3']),
    });
    assert.deepEqual(r.attribues.map((a) => [a.sha, a.iid, a.par]), [['e1', 12, 'forge']]);
    assert.deepEqual(r.directs.map((d) => [d.sha, d.etiquettes.non_verifie]), [['e2', false], ['e3', true]]);
    assert.deepEqual(r.aVerifier, [], 'tout a été demandé ou plafonné : plus rien à demander');
  });

  test('revert, merge manuel et bot sont étiquetés, pas cachés', () => {
    const r = classer({
      candidats: [
        c('r1', { title: 'Revert "feat: x"' }),
        c('mm', { parents: ['x', 'y'] }),
        c('bot', { author: 'dependabot[bot]' }),
      ],
      mrs: [], mrsParCommit: new Map(), nonVerifies: new Set(),
    });
    const et = Object.fromEntries(r.directs.map((d) => [d.sha, d.etiquettes]));
    assert.equal(et.r1.revert, true);
    assert.equal(et.mm.merge_manuel, true);
    assert.equal(et.bot.bot, true);
    assert.equal(et.r1.merge_manuel, false);
  });
});

describe('periode-classement · regrouperPushs()', () => {
  test('les commits consécutifs du même auteur à moins de 30 min forment un push ; un autre auteur ou un trou en ouvre un autre', () => {
    // Ordre de `git log` : du plus récent au plus ancien.
    const directs = [
      { ...c('k3', { date: '2026-10-05T10:20:00Z', parents: ['k2'] }), etiquettes: { revert: true, merge_manuel: false, bot: false, non_verifie: false } },
      { ...c('k2', { date: '2026-10-05T10:10:00Z', parents: ['k1'] }), etiquettes: { revert: false, merge_manuel: false, bot: false, non_verifie: false } },
      { ...c('k1', { date: '2026-10-05T10:00:00Z', parents: ['l1'] }), etiquettes: { revert: false, merge_manuel: false, bot: false, non_verifie: false } },
      { ...c('l1', { author: 'lina', email: 'l@x', date: '2026-10-05T09:55:00Z', parents: ['k0'] }), etiquettes: { revert: false, merge_manuel: false, bot: false, non_verifie: false } },
      { ...c('k0', { date: '2026-10-04T08:00:00Z', parents: ['z'] }), etiquettes: { revert: false, merge_manuel: false, bot: false, non_verifie: true } },
    ];
    const p = regrouperPushs(directs);
    assert.deepEqual(p.map((x) => [x.author, x.commits.map((y) => y.sha)]), [['karim', ['k1', 'k2', 'k3']], ['lina', ['l1']], ['karim', ['k0']]]);
    assert.equal(p[0].head_sha, 'k3');
    assert.equal(p[0].base_sha, 'l1', 'la base du push est le parent de son premier commit');
    assert.equal(p[0].etiquettes.revert, true, 'un push porte les étiquettes de ses commits');
    assert.equal(p[2].etiquettes.non_verifie, true);
  });

  test('un push connu de la forge regroupe EXACTEMENT ses commits : deux pushs consécutifs font deux lignes, un commit sans événement garde l’heuristique', () => {
    const et = { revert: false, merge_manuel: false, bot: false, non_verifie: false };
    const directs = [
      { ...c('k3', { date: '2026-10-05T10:20:00Z', parents: ['k2'] }), etiquettes: et },
      { ...c('k2', { date: '2026-10-05T10:10:00Z', parents: ['k1'] }), etiquettes: et },
      { ...c('k1', { date: '2026-10-05T10:00:00Z', parents: ['k0'] }), etiquettes: et },
      { ...c('k0', { date: '2026-10-05T09:58:00Z', parents: ['z'] }), etiquettes: et },
    ];
    // k3 et k2 partis ensemble ; k1 seul dans son push ; k0 inconnu de la forge.
    const evenementDe = new Map([['k3', 'main@k3'], ['k2', 'main@k3'], ['k1', 'main@k1']]);
    const p = regrouperPushs(directs, { evenementDe });
    assert.deepEqual(p.map((x) => [x.commits.map((y) => y.sha), x.exact]), [[['k2', 'k3'], true], [['k1'], true], [['k0'], false]]);
    // Sans événements, les quatre sont un seul push (même auteur, moins de 30 minutes).
    assert.equal(regrouperPushs(directs).length, 1);
  });

  test('deux branches ne se mélangent jamais', () => {
    const directs = [
      { ...c('a', { branche: 'main' }), etiquettes: {} },
      { ...c('b', { branche: 'develop' }), etiquettes: {} },
    ];
    assert.equal(regrouperPushs(directs).length, 2);
  });
});

describe('periode-classement · classerMr()', () => {
  const D = '2026-10-03T00:00:00.000Z'; const F = '2026-10-17T23:59:59.999Z';
  test('la date qui classe est celle de l’événement, jamais updated_at', () => {
    assert.equal(classerMr({ state: 'merged', merged_at: '2026-10-08T10:00:00Z', updated_at: '2026-10-20T10:00:00Z' }, D, F), 'mr_merged');
    assert.equal(classerMr({ state: 'merged', merged_at: '2026-09-30T10:00:00Z', updated_at: '2026-10-08T10:00:00Z' }, D, F), 'mr_active', 'mergée AVANT la fenêtre, touchée pendant : de l’activité, pas une mergée');
    assert.equal(classerMr({ state: 'closed', closed_at: '2026-10-08T10:00:00Z' }, D, F), 'mr_closed');
    assert.equal(classerMr({ state: 'opened', created_at: '2026-10-08T10:00:00Z', updated_at: '2026-10-09T10:00:00Z' }, D, F), 'mr_new');
    assert.equal(classerMr({ state: 'opened', created_at: '2026-09-08T10:00:00Z', updated_at: '2026-10-09T10:00:00Z' }, D, F), 'mr_active');
    assert.equal(classerMr({ state: 'opened', created_at: '2026-09-08T10:00:00Z', updated_at: '2026-09-09T10:00:00Z' }, D, F), null);
  });
});
