'use strict';
/* LES RETOUCHES APRÈS MERGE SONT UN FAIT DE GIT — `git blame` sur les lignes qu'une merge request B
 * retire, comparées aux commits d'une merge request A mergée avant elle sur la même cible — sans
 * aucun appel d'IA, sans aucun appel de forge, sans jugement.
 *
 * Ce que ce fichier prouve, sur une base temporaire, un dépôt git de fixture et sans serveur : A
 * ajoute 10 lignes (squash), B en retire 4 trois jours après → `rewrites`, 4 lignes, 3 jours ; le
 * même scénario sans squash (commit de merge) reconnaît les commits de A ; un ajout pur de B au
 * milieu du code de A ne fait aucun lien ; la fenêtre (15 jours sur 14 : rien ; 30 : lien) ; le
 * minimum de lignes (2 sur 3 : rien) ; `This reverts commit <squash de A>` fait un `revert` même
 * sous le minimum ; une référence `!A` seule fait un `reference` absent du chiffre ; 500 lignes sur
 * 25 MR d'origine sont marquées `large` et exclues ; un commit direct sur `main` donne un lien avec
 * `fix_commit_sha` ; « Pas un correctif » sort du chiffre et survit au recalcul ; Stats compte par
 * tranche, exclut les MR de moins de N jours, sans clé d'auteur ; le plafond par tour ; et le module
 * n'importe ni `agent/` ni `forge/`, aucun libellé n'accuse le rapport. */
const { test, before, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { lireSource } = require('./helpers/sources');
const { lireFichierFront } = require('./helpers/front');

process.env.MERGERIE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'retouches-'));

const JOUR = 24 * 3600 * 1000;
const il_y_a = (jours) => new Date(Date.now() - jours * JOUR).toISOString();

describe('Retouches après merge', () => {
  let db; let r; let repoId; let work; let bare; let cwd;
  const cfg = { fix_links_enabled: '1', fix_window_days: '14', fix_min_lines: '3', fix_links_max: '10', clone_path: path.join(process.env.MERGERIE_DATA_DIR, 'clones') };
  const repo = () => ({ id: repoId, project: 'grp/app', forge: 'gitlab', url: bare });
  const g = (...a) => execFileSync('git', a, { cwd: work, stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@x' } }).toString().trim();
  const lignes = (n, prefixe) => Array.from({ length: n }, (x, i) => `${prefixe} ${i + 1}`).join('\n');
  const ecrire = (f, contenu) => { fs.mkdirSync(path.join(work, path.dirname(f)), { recursive: true }); fs.writeFileSync(path.join(work, f), `${contenu}\n`); };
  const commit = (msg) => { g('add', '-A'); g('commit', '-q', '-m', msg); return g('rev-parse', 'HEAD'); };
  /* Une branche depuis `main`, un commit, et son merge sur `main` — squash (un commit de squash),
     `no-ff` (un commit de merge à deux parents) ou `ff`. Rend les SHA que la forge donnerait. */
  const brancheMergee = (nom, modifier, { msg = nom, mode = 'squash' } = {}) => {
    g('checkout', '-q', 'main');
    const base = g('rev-parse', 'HEAD');
    g('checkout', '-q', '-b', nom);
    modifier();
    const head = commit(msg);
    g('checkout', '-q', 'main');
    let squash = null; let merge = null;
    if (mode === 'squash') { g('merge', '--squash', '-q', nom); squash = commit(msg); } else if (mode === 'no-ff') { g('merge', '--no-ff', '-q', '-m', `Merge ${nom}`, nom); merge = g('rev-parse', 'HEAD'); } else { g('merge', '-q', '--ff-only', nom); }
    g('push', '-q', 'origin', 'main');
    return { base, head, squash, merge };
  };
  let iid = 0;
  const mr = (shas, { jours, note = null, titre = '', description = '', source = null, target = 'main', ticket = null, type = null } = {}) => {
    iid += 1;
    const info = db.prepare(`INSERT INTO mr (repo_id, iid, title, source_branch, target_branch, current_sha, status, updated_at, gitlab_created_at, closed_seen, merged_at,
        head_sha, base_sha, merge_commit_sha, squash_commit_sha, description, ticket_jira_key, ticket_jira_type)
      VALUES (?, ?, ?, ?, ?, ?, 'done', ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(repoId, iid, titre || `MR ${iid}`, source || `feature/${iid}`, target, shas.head, il_y_a(jours), il_y_a(jours + 2), il_y_a(jours), shas.head, shas.base, shas.merge, shas.squash, description, ticket, type);
    const id = Number(info.lastInsertRowid);
    if (note != null) db.prepare('INSERT INTO review (mr_id, md_path, note_value, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(id, '/nope.md', note, il_y_a(jours + 1), il_y_a(jours + 1));
    return { ...db.prepare('SELECT * FROM mr WHERE id = ?').get(id), note };
  };
  const liens = (originId) => db.prepare('SELECT * FROM mr_fix_link WHERE origin_mr_id = ? ORDER BY kind').all(originId);
  const analyser = (b, extra = {}) => r.analyserMr({ ...cfg, ...extra }, repo(), b, { cwd });

  before(async () => {
    db = require('../src/db');
    r = require('../src/review/retouches');
    const git = require('../src/git/git');
    const racine = fs.mkdtempSync(path.join(os.tmpdir(), 'retouches-git-'));
    bare = path.join(racine, 'origin.git'); work = path.join(racine, 'work');
    fs.mkdirSync(bare); fs.mkdirSync(work);
    execFileSync('git', ['init', '-q', '--bare', '--initial-branch=main', '.'], { cwd: bare });
    g('init', '-q', '--initial-branch=main', '.');
    g('remote', 'add', 'origin', bare);
    ecrire('src/tva.js', lignes(10, 'base'));
    ecrire('README.md', '# t');
    commit('init');
    g('push', '-q', '-u', 'origin', 'main');
    repoId = Number(db.prepare("INSERT INTO repo (project, url, enabled, forge, fetch_mrs) VALUES ('grp/app', ?, 1, 'gitlab', 1)").run(bare).lastInsertRowid);
    cwd = await git.ensureRepo(cfg, repo());
  });

  let A; let B;
  test('A ajoute 10 lignes (squash) ; B en retire 4 trois jours après → rewrites, lines = 4, days ≈ 3, avec les plages', async () => {
    const sa = brancheMergee('feature/a', () => ecrire('src/tva.js', `${lignes(10, 'base')}\n${lignes(10, 'tva')}`), { msg: 'feat: tva' });
    A = mr(sa, { jours: 10, note: 0.84 });
    const sb = brancheMergee('feature/b', () => ecrire('src/tva.js', `${lignes(10, 'base')}\n${lignes(6, 'tva')}`), { msg: 'retire quatre lignes' });
    B = mr(sb, { jours: 7 });
    await require('../src/git/git').ensureRepo(cfg, repo());
    const bilan = await analyser(B);
    assert.equal(bilan.candidats, 1);
    const l = liens(A.id);
    assert.equal(l.length, 1);
    assert.equal(l[0].kind, 'rewrites');
    assert.equal(l[0].fix_mr_id, B.id);
    assert.equal(l[0].lines, 4);
    assert.equal(l[0].files, 1);
    assert.ok(Math.abs(l[0].days - 3) < 0.2, `days ≈ 3, lu ${l[0].days}`);
    assert.equal(l[0].large, 0);
    assert.equal(l[0].status, 'auto');
    const detail = JSON.parse(l[0].detail);
    assert.deepEqual(detail.ranges, { 'src/tva.js': [[17, 20]] }, 'les plages de la base de B, vérifiables avec git blame -L');
    assert.deepEqual(JSON.parse(l[0].bug), [], 'rien ne qualifie : retouche non tranchée');
    assert.equal(db.prepare("SELECT sha FROM mr_fix_scan WHERE kind = 'mr' AND ref = ?").get(String(B.id)).sha, sb.squash, 'analysée une fois, sur son SHA');
    const cartes = r.pourCartes(cfg, { mrIds: [A.id, B.id] });
    assert.equal(cartes[A.id].touched_by.length, 1);
    assert.equal(cartes[A.id].touched_by[0].fix.iid, B.iid);
    assert.equal(cartes[A.id].touched_by[0].counted, true);
    assert.equal(cartes[A.id].touched_by[0].bug_qualified, false);
    assert.equal(cartes[B.id].touches[0].origin.iid, A.iid, 'le miroir sur la carte de B');
    assert.equal(cartes[B.id].touches[0].origin.note, 0.84);
  });

  test('même scénario sans squash (commit de merge) → les commits de A sont reconnus, par mr_commits ou par le clone', async () => {
    const sa = brancheMergee('feature/a2', () => ecrire('src/b.js', lignes(10, 'b')), { mode: 'no-ff' });
    const a2 = mr(sa, { jours: 9, note: 0.9 });
    const sb = brancheMergee('feature/b2', () => ecrire('src/b.js', lignes(5, 'b')), { msg: 'fix: cinq lignes de moins' });
    const b2 = mr(sb, { jours: 6 });
    await require('../src/git/git').ensureRepo(cfg, repo());
    await analyser(b2);
    const l = liens(a2.id).filter((x) => x.fix_mr_id === b2.id);
    assert.equal(l.length, 1);
    assert.equal(l[0].kind, 'rewrites');
    assert.equal(l[0].lines, 5);
    assert.deepEqual(JSON.parse(l[0].bug), [{ kind: 'commit-fix' }], 'un commit `fix:` qualifie la retouche');
    // Avec `mr_commits` seuls (le clone ne porterait pas le merge) : même résultat.
    db.prepare("DELETE FROM mr_fix_link WHERE fix_mr_id = ?").run(b2.id);
    db.prepare('UPDATE mr SET merge_commit_sha = NULL WHERE id = ?').run(a2.id);
    db.prepare('INSERT INTO mr_commits (mr_id, sha, position) VALUES (?, ?, 0)').run(a2.id, sa.head);
    await analyser({ ...b2 });
    assert.equal(liens(a2.id).filter((x) => x.fix_mr_id === b2.id).length, 1, 'reconnu par mr_commits');
    db.prepare('UPDATE mr SET merge_commit_sha = ? WHERE id = ?').run(sa.merge, a2.id);
  });

  test('B ajoute une ligne entre deux lignes de A sans rien retirer → aucun lien', async () => {
    const sb = brancheMergee('feature/b3', () => ecrire('src/tva.js', `${lignes(10, 'base')}\n${lignes(3, 'tva')}\ninsert\n${['tva 4', 'tva 5', 'tva 6'].join('\n')}`));
    const b3 = mr(sb, { jours: 5 });
    await require('../src/git/git').ensureRepo(cfg, repo());
    const bilan = await analyser(b3);
    assert.ok(bilan.candidats >= 1);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM mr_fix_link WHERE fix_mr_id = ?').get(b3.id).c, 0);
  });

  test('B quinze jours après (fenêtre 14) → aucun lien ; fenêtre 30 → lien', async () => {
    const sa = brancheMergee('feature/a4', () => ecrire('src/c.js', lignes(10, 'c')));
    const a4 = mr(sa, { jours: 20, note: 0.8 });
    const sb = brancheMergee('feature/b4', () => ecrire('src/c.js', lignes(4, 'c')));
    const b4 = mr(sb, { jours: 5 });
    await require('../src/git/git').ensureRepo(cfg, repo());
    await analyser(b4);
    assert.equal(liens(a4.id).length, 0, 'hors fenêtre : de l’évolution, pas un lien');
    await analyser(b4, { fix_window_days: '30' });
    assert.equal(liens(a4.id).length, 1);
    assert.equal(liens(a4.id)[0].lines, 6);
  });

  test('B retire 2 lignes (minimum 3) → aucun lien ; minimum 2 → lien', async () => {
    const sa = brancheMergee('feature/a5', () => ecrire('src/d.js', lignes(10, 'd')));
    const a5 = mr(sa, { jours: 8, note: 0.7 });
    const sb = brancheMergee('feature/b5', () => ecrire('src/d.js', lignes(8, 'd')));
    const b5 = mr(sb, { jours: 4 });
    await require('../src/git/git').ensureRepo(cfg, repo());
    await analyser(b5);
    assert.equal(liens(a5.id).length, 0);
    await analyser(b5, { fix_min_lines: '2' });
    assert.equal(liens(a5.id).length, 1);
    assert.equal(liens(a5.id)[0].lines, 2);
  });

  test('B contient « This reverts commit <squash de A> » → lien revert, même sous le minimum de lignes', async () => {
    const sa = brancheMergee('feature/a6', () => ecrire('src/e.js', lignes(10, 'e')));
    const a6 = mr(sa, { jours: 8, note: 0.75 });
    const sb = brancheMergee('feature/b6', () => ecrire('src/e.js', lignes(9, 'e')), { msg: `Revert "e"\n\nThis reverts commit ${sa.squash}.`, mode: 'no-ff' });
    const b6 = mr(sb, { jours: 7 });
    await require('../src/git/git').ensureRepo(cfg, repo());
    await analyser(b6);
    const l = liens(a6.id);
    assert.deepEqual(l.map((x) => x.kind), ['revert']);
    assert.equal(l[0].lines, 1, 'les lignes réécrites sont dites, même sous le minimum');
    assert.ok(JSON.parse(l[0].bug).some((q) => q.kind === 'revert'), 'un revert qualifie la retouche');
    const c = r.pourCartes(cfg, { mrIds: [a6.id] })[a6.id].touched_by[0];
    assert.equal(c.kind, 'revert'); assert.equal(c.counted, true); assert.equal(c.bug_qualified, true);
    // `Reverts !<iid>` dans la description suffit aussi (c'est ce que GitLab écrit).
    db.prepare('DELETE FROM mr_fix_link WHERE fix_mr_id = ?').run(b6.id);
    await analyser({ ...b6, description: `Reverts !${a6.iid}` });
    assert.deepEqual(liens(a6.id).map((x) => x.kind), ['revert']);
  });

  test('B cite !A sans réécrire ses lignes → lien reference seul, absent du chiffre, présent sur la carte comme référence', async () => {
    const sa = brancheMergee('feature/a7', () => ecrire('src/f.js', lignes(10, 'f')));
    const a7 = mr(sa, { jours: 8, note: 0.85 });
    const sb = brancheMergee('feature/b7', () => ecrire('src/g.js', lignes(3, 'g')));
    const b7 = mr(sb, { jours: 6, titre: `Suite de !${a7.iid}` });
    await require('../src/git/git').ensureRepo(cfg, repo());
    await analyser(b7);
    const l = liens(a7.id);
    assert.deepEqual(l.map((x) => x.kind), ['reference']);
    assert.deepEqual(JSON.parse(l[0].detail).signals, [{ kind: 'reference', where: 'title' }]);
    const c = r.pourCartes(cfg, { mrIds: [a7.id] })[a7.id].touched_by[0];
    assert.equal(c.reference_only, true); assert.equal(c.counted, false);
    const st = r.stats(cfg, {});
    assert.ok(!st.links.some((p) => p.origin.id === a7.id), 'une référence seule ne figure pas dans la liste des retouches');
  });

  test('B réécrit 500 lignes sur 25 MR d’origine → liens marqués large, exclus du chiffre, dits sur la carte', async () => {
    const origines = [];
    for (let i = 0; i < 25; i += 1) {
      g('checkout', '-q', 'main');
      ecrire(`src/large/f${i}.js`, lignes(20, `l${i}`));
      const sha = commit(`large ${i}`);
      origines.push(mr({ head: sha, base: `${sha}^`, squash: sha, merge: null }, { jours: 9, note: 0.8 }));
    }
    g('push', '-q', 'origin', 'main');
    const sb = brancheMergee('feature/large', () => { for (let i = 0; i < 25; i += 1) fs.rmSync(path.join(work, `src/large/f${i}.js`)); });
    const bl = mr(sb, { jours: 3 });
    await require('../src/git/git').ensureRepo(cfg, repo());
    await analyser(bl);
    const l = db.prepare("SELECT * FROM mr_fix_link WHERE fix_mr_id = ? AND kind = 'rewrites'").all(bl.id);
    assert.equal(l.length, 25);
    assert.ok(l.every((x) => x.large === 1 && x.lines === 20));
    const c = r.pourCartes(cfg, { mrIds: [origines[0].id] })[origines[0].id].touched_by.find((p) => p.fix.id === bl.id);
    assert.equal(c.large, true); assert.equal(c.counted, false);
  });

  test('commit direct sur main qui retire des lignes de A → lien avec fix_commit_sha, sans carte', async () => {
    const sa = brancheMergee('feature/a9', () => ecrire('src/h.js', lignes(10, 'h')));
    const a9 = mr(sa, { jours: 2, note: 0.88 });
    await require('../src/git/git').ensureRepo(cfg, repo());
    assert.equal(await r.tourCommitsDirects(cfg, repo(), cwd, 'main'), 0, 'première lecture : la pointe est posée, rien n’est analysé');
    g('checkout', '-q', 'main');
    ecrire('src/h.js', lignes(4, 'h'));
    const hot = commit('hotfix: six lignes de trop');
    g('push', '-q', 'origin', 'main');
    await require('../src/git/git').ensureRepo(cfg, repo());
    assert.equal(await r.tourCommitsDirects(cfg, repo(), cwd, 'main'), 1);
    const l = liens(a9.id);
    assert.equal(l.length, 1);
    assert.equal(l[0].fix_mr_id, 0);
    assert.equal(l[0].fix_commit_sha, hot);
    assert.equal(l[0].lines, 6);
    assert.ok(JSON.parse(l[0].bug).some((q) => q.kind === 'commit-fix'));
    const c = r.pourCartes(cfg, { mrIds: [a9.id] })[a9.id].touched_by[0];
    assert.equal(c.fix.id, null); assert.equal(c.fix.sha, hot); assert.equal(c.counted, true);
    assert.equal(await r.tourCommitsDirects(cfg, repo(), cwd, 'main'), 0, 'la pointe n’a pas bougé : rien à relire');
  });

  test('« Pas un correctif » → dismissed, hors du chiffre, et un recalcul ne le réécrit pas ; « Marquer comme correctif » crée un lien manuel', async () => {
    const court = { ...cfg, fix_window_days: '5' };   // A, mergée il y a 10 jours, a son bilan sous une fenêtre de 5
    const avant = r.stats(court, {});
    const p = r.requalifier(cfg, { originId: A.id, fixMrId: B.id, status: 'dismissed', par: 'Claire' });
    assert.equal(p.status, 'dismissed'); assert.equal(p.status_by, 'Claire'); assert.equal(p.counted, false);
    const apres = r.stats(court, {});
    assert.equal(apres.touched, avant.touched - 1, 'sort du chiffre');
    assert.equal(apres.merged, avant.merged, 'le dénominateur ne bouge pas');
    await analyser(B);
    const l = liens(A.id)[0];
    assert.equal(l.status, 'dismissed'); assert.equal(l.status_by, 'Claire');
    assert.equal(l.lines, 4, 'les faits se recalculent, l’arbitrage reste');
    // Et le fichier partagé de A porte l'arbitrage, et lui seul.
    const registre = require('../src/data/store-registry');
    const e = registre.pour('mr');
    assert.ok(e.listes.some((x) => x.table === 'mr_fix_link' && x.liste === 'fix_links'));
    assert.equal(registre.pour('mr_fix_link').famille, 'P');
    // Défaire, puis poser un lien manuel sur une paire que rien n'a reliée.
    assert.equal(r.requalifier(cfg, { originId: A.id, fixMrId: B.id, status: 'auto' }).status, 'auto');
    const sb = brancheMergee('feature/b10', () => ecrire('src/i.js', 'un'));
    const b10 = mr(sb, { jours: 6 });
    assert.throws(() => r.requalifier(cfg, { originId: A.id, fixMrId: b10.id, status: 'dismissed' }), /introuvable|not found/i);
    const m = r.requalifier(cfg, { originId: A.id, fixMrId: b10.id, status: 'confirmed', par: 'Ali' });
    assert.equal(m.kind, 'manual'); assert.equal(m.counted, true); assert.equal(m.bug_qualified, true);
    assert.ok(r.originesPossibles(cfg, b10.id).some((o) => o.id === A.id));
    await analyser(b10);
    assert.equal(liens(A.id).filter((x) => x.fix_mr_id === b10.id && x.kind === 'manual').length, 1, 'le lien manuel survit au recalcul');
  });

  test('Stats : la table par tranche, le dénominateur sans les MR de moins de N jours, aucune clé d’auteur', () => {
    const st = r.stats(cfg, {});
    assert.equal(st.window, 14);
    assert.deepEqual(st.tranches.map((t) => t.tranche), ['8+', '7-8', '<7', 'none']);
    const connues = db.prepare('SELECT COUNT(*) c FROM mr WHERE merged_at IS NOT NULL AND merged_at <= ?').get(il_y_a(14)).c;
    assert.equal(st.merged, connues, 'le dénominateur : les MR dont la fenêtre est écoulée');
    assert.ok(st.pending > 0, 'les autres attendent leur bilan');
    // Le retard du tour : les MR mergées de la rétention jamais relues sur leur SHA de merge.
    const relues = new Set(db.prepare("SELECT ref FROM mr_fix_scan WHERE kind = 'mr'").all().map((x) => Number(x.ref)));
    const attendues = db.prepare('SELECT id FROM mr WHERE merged_at IS NOT NULL AND merged_at >= ?').all(il_y_a(r.retentionJours(cfg))).map((x) => x.id);
    assert.ok(attendues.length > 0);
    assert.equal(st.unscanned, attendues.filter((id) => !relues.has(id)).length, 'le compte des MR en attente d’analyse');
    assert.equal(r.enAttente(cfg, { projet: 'nulle/part' }).length, 0, 'filtré par dépôt');
    assert.equal(st.tranches.reduce((s, t) => s + t.merged, 0), st.merged);
    assert.ok(st.links.every((p) => p.days != null));
    assert.ok(st.links.every((p, i) => i === 0 || st.links[i - 1].days <= p.days), 'les plus rapides d’abord');
    const json = JSON.stringify(st);
    assert.ok(!/"author/.test(json), 'jamais une clé d’auteur');
    assert.ok(!/"author/.test(JSON.stringify(r.pourCartes(cfg, {}))));
    assert.equal(r.stats({ ...cfg, fix_links_enabled: '0' }, {}).enabled, false);
    assert.deepEqual(r.pourCartes({ ...cfg, fix_links_enabled: '0' }, {}), {});
  });

  test('plafond 2, cinq B mergées dans le même tour → deux analysées, trois au tour suivant', async () => {
    db.prepare('DELETE FROM mr_fix_scan').run();
    db.prepare("DELETE FROM mr_fix_link WHERE status = 'auto'").run();
    const b1 = await r.tour({ ...cfg, fix_links_max: '2' }, { onLog: () => {} });
    assert.equal(b1.analysees, 2);
    assert.ok(b1.restantes >= 3);
    const b2 = await r.tour({ ...cfg, fix_links_max: '2' }, { onLog: () => {} });
    assert.equal(b2.analysees, 2);
    assert.equal(b2.restantes, b1.restantes - 2);
    const b3 = await r.tour({ ...cfg, fix_links_max: '0' }, { onLog: () => {} });
    assert.equal(b3.analysees, b2.restantes); assert.equal(b3.restantes, 0);
    assert.equal((await r.tour(cfg, { onLog: () => {} })).analysees, 0, 'tout est analysé');
    assert.equal((await r.tour({ ...cfg, fix_links_enabled: '0' }, { onLog: () => {} })).analysees, 0, 'décoché : rien');
  });

  test('le module n’importe ni agent/ ni forge/ ; aucun libellé n’accuse le rapport ; rétention = fenêtre + 7', () => {
    const src = lireSource('review/retouches');
    assert.ok(!/require\(['"]\.\.\/agent/.test(src));
    assert.ok(!/require\(['"]\.\.\/forge/.test(src));
    assert.ok(!/\bauthor\b/.test(src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')), 'le code ne lit jamais l’auteur');
    assert.equal(r.retentionJours(cfg), 21);
    assert.equal(r.fenetre({}), 30, '30 jours par défaut');
    assert.equal(r.retentionJours({}), 37);
    assert.equal(r.retentionJours({ ...cfg, fix_links_enabled: '0' }), 0);
    const libelles = [];
    for (const f of ['i18n/reviews.js', 'i18n/stats.js', 'i18n/reglages.js']) {
      const dico = require(path.join(__dirname, '..', 'public', f));
      for (const langue of ['fr', 'en']) for (const [k, v] of Object.entries(dico[langue])) if (/^(mr\.fix|stats\.fix|settings\.(lbl|tip)\.fix)/.test(k)) libelles.push([k, typeof v === 'string' ? v : Object.values(v).join(' ')]);
    }
    assert.ok(libelles.length > 60);
    const interdits = /(?<!par )défaut|defect|erreur du rapport|report (was )?wrong|rapport (s’est )?trompé|faulty|fautif/i;
    for (const [k, v] of libelles) assert.ok(!interdits.test(v), `${k} : « ${v} »`);
    for (const [k, v] of libelles) if (/\bbug\b/i.test(v)) assert.ok(/qualif|ticket|fix:/i.test(v), `${k} ne dit « bug » que pour une qualification : « ${v} »`);
    assert.ok(lireFichierFront('ecrans/reviews/retouches.js').startsWith("'use strict';"));
  });
});
