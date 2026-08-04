'use strict';
/* Vérification objective, mode worktree — parcours réel (plan_add_verify.md §14).
 *
 * On exerce le VRAI chemin : vrai dépôt git, vrais worktrees, vrai spawn d'un script.
 * Le script factice est piloté par une variable d'environnement écrite dans son propre corps
 * à la création — le vérificateur ne reçoit qu'un environnement minimal, on ne peut donc pas
 * lui passer de consigne par l'env au moment du run. C'est précisément ce qu'on veut vérifier.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { startApp } = require('./helpers/app');

// Écrit un script de vérification qui répond ce qu'on lui demande, une fois pour toutes.
function ecrireScript(dir, nom, corps) {
  const p = path.join(dir, nom);
  fs.writeFileSync(p, `#!/bin/sh\n${corps}\n`, { mode: 0o755 });
  return p;
}

const reponse = (obj) => `cat >/dev/null\nprintf '%s\\n' '${JSON.stringify(obj)}'`;

describe('Vérification objective — mode worktree', () => {
  let app;
  let repoId;
  let mrId;
  let bin;
  let depotDistant;

  before(async () => {
    app = await startApp();
    bin = fs.mkdtempSync(path.join(os.tmpdir(), 'verif-bin-'));

    /* Un vrai dépôt git servant de remote : les worktrees ont besoin de vrais commits, et
       c'est aussi ce qui rend le test capable d'attraper une erreur de manipulation git. */
    depotDistant = fs.mkdtempSync(path.join(os.tmpdir(), 'verif-remote-'));
    const g = (...a) => execFileSync('git', a, { cwd: depotDistant, stdio: 'pipe' });
    g('init', '-q', '-b', 'main');
    g('config', 'user.email', 'test@example.com');
    g('config', 'user.name', 'Test');
    fs.writeFileSync(path.join(depotDistant, 'a.txt'), 'base\n');
    g('add', '-A'); g('commit', '-qm', 'base');
    const baseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: depotDistant }).toString().trim();
    g('checkout', '-q', '-b', 'feature/x');
    fs.writeFileSync(path.join(depotDistant, 'a.txt'), 'tête\n');
    g('add', '-A'); g('commit', '-qm', 'tête');
    const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: depotDistant }).toString().trim();
    g('checkout', '-q', 'main');

    await app.configure({ clone_path: fs.mkdtempSync(path.join(os.tmpdir(), 'verif-clones-')) });
    repoId = (await app.api('POST', '/api/repos', { project: 'grp/app', url: depotDistant })).body.id;

    // Une MR qui pointe sur ces deux SHAs — c'est tout ce dont la vérification a besoin.
    app.state.projects = [{ id: 1, path_with_namespace: 'grp/app', http_url_to_repo: depotDistant }];
    app.state.mrs['grp/app'] = [{
      iid: 5, title: 'Changement', state: 'opened',
      source_branch: 'feature/x', target_branch: 'main',
      web_url: 'https://gitlab.test/grp/app/-/merge_requests/5',
      sha: headSha, created_at: new Date().toISOString(), author: { name: 'A' },
    }];
    await app.api('POST', '/api/discover');
    mrId = (await app.api('GET', '/api/mrs')).body.find((m) => m.iid === 5).id;
    void baseSha;
  });

  after(async () => { await app.stop(); });

  // Attend la fin du job de vérification et rend le détail.
  async function attendre(verificationId) {
    let detail = null;
    for (let i = 0; i < 300 && !detail; i++) {
      const { body } = await app.api('GET', `/api/verifications/${verificationId}`);
      if (body.status === 'done' || body.status === 'error') detail = body;
      else await new Promise((r) => setTimeout(r, 50));
    }
    if (!detail) throw new Error('la vérification ne se termine pas');
    /* La vérification est close, mais le JOB qui la porte peut ne pas l'être encore — et
       c'est lui qui tient le verrou « une seule vérification à la fois ». Sans cette
       attente, le test suivant se ferait refuser son lancement. */
    for (let i = 0; i < 300; i++) {
      const { body } = await app.api('GET', '/api/status');
      if (!body.running && !body.queued) return detail;
      await new Promise((r) => setTimeout(r, 50));
    }
    return detail;
  }

  async function poser(corps, opts = {}) {
    const cmd = ecrireScript(bin, `v-${Math.abs(corps.length)}-${opts.nom || 'x'}.sh`, corps);
    const v = await app.api('POST', '/api/verifiers', {
      name: opts.nom || `v${Date.now()}`, command: cmd, timeout_s: opts.timeout_s || 60,
      run_base: opts.run_base !== false,
      repos: [{ repo_id: repoId, mode: 'worktree' }],
    });
    assert.equal(v.status, 200, JSON.stringify(v.body));
    return v.body;
  }

  test('sans vérificateur couvrant le dépôt, on refuse au lieu de lancer un run vide', async () => {
    const r = await app.api('POST', `/api/mrs/${mrId}/verify`);
    assert.equal(r.status, 400);
    assert.match(r.body.error, /Aucun vérificateur/);
  });

  test('base verte et tête verte : verified_pass, et les worktrees sont nettoyés', async () => {
    const v = await poser(reponse({ version: 1, status: 'pass', total: 12 }), { nom: 'tout-vert' });
    const lance = await app.api('POST', `/api/mrs/${mrId}/verify`, { verifier_id: v.id });
    assert.equal(lance.status, 200);
    const d = await attendre(lance.body.verification.id);
    assert.equal(d.verdict, 'verified_pass');
    assert.equal(d.status, 'done');
    assert.equal(d.base_run.status, 'pass', 'le run base a bien eu lieu');
    assert.equal(d.head_run.total, 12);
    assert.deepEqual(d.imputable, []);

    // §5.7 : rien ne doit rester dans le dossier des worktrees.
    const wt = path.join(process.env.MERGERIE_DATA_DIR, 'worktrees');
    assert.ok(!fs.existsSync(wt) || fs.readdirSync(wt).length === 0,
      `worktrees non nettoyés : ${fs.existsSync(wt) ? fs.readdirSync(wt) : ''}`);
    await app.api('DELETE', `/api/verifiers/${v.id}`);
  });

  test('base verte, tête rouge : verified_fail, et tout l’échec est imputable à la branche', async () => {
    const v = await poser(reponse({
      version: 1, status: 'fail',
      failed: [{ test: 'checkout › total', message: 'attendu 42, reçu 41' }],
    }), { nom: 'tout-rouge' });
    /* Le script répond la même chose aux deux rôles : base rouge ET tête rouge, sans delta.
       C'est le cas subtil du tableau — le verdict doit être « base rouge », pas « échec ». */
    const lance = await app.api('POST', `/api/mrs/${mrId}/verify`, { verifier_id: v.id });
    const d = await attendre(lance.body.verification.id);
    assert.equal(d.verdict, 'broken_base', 'rien de NOUVEAU n’est cassé : la branche n’est pas comptable');
    assert.deepEqual(d.imputable, []);
    await app.api('DELETE', `/api/verifiers/${v.id}`);
  });

  test('sans run base, le verdict tombe quand même — signalé non causal', async () => {
    const v = await poser(reponse({ version: 1, status: 'fail', failed: [{ test: 'a' }] }),
      { nom: 'sans-base', run_base: false });
    const lance = await app.api('POST', `/api/mrs/${mrId}/verify`, { verifier_id: v.id });
    const d = await attendre(lance.body.verification.id);
    assert.equal(d.verdict, 'verified_fail');
    assert.equal(d.base_run, null, 'aucun run base n’a été lancé');
    assert.deepEqual(d.imputable.map((f) => f.test), ['a']);
    await app.api('DELETE', `/api/verifiers/${v.id}`);
  });

  test('une sortie illisible ne devient jamais un vert', async () => {
    const v = await poser('cat >/dev/null\necho "tout va bien"', { nom: 'muet' });
    const lance = await app.api('POST', `/api/mrs/${mrId}/verify`, { verifier_id: v.id });
    const d = await attendre(lance.body.verification.id);
    assert.equal(d.verdict, 'verify_error');
    assert.equal(d.status, 'error');
    assert.match(d.log_excerpt || '', /JSON/, 'le journal dit POURQUOI, pas seulement que ça a raté');
    await app.api('DELETE', `/api/verifiers/${v.id}`);
  });

  test('un code de sortie non nul avec un verdict valide est accepté : stdout fait foi', async () => {
    const v = await poser(`${reponse({ version: 1, status: 'pass' })}\nexit 3`, { nom: 'exit3' });
    const lance = await app.api('POST', `/api/mrs/${mrId}/verify`, { verifier_id: v.id });
    const d = await attendre(lance.body.verification.id);
    assert.equal(d.verdict, 'verified_pass', 'beaucoup de lanceurs de tests sortent en ≠ 0');
    await app.api('DELETE', `/api/verifiers/${v.id}`);
  });

  test('un script qui ne rend jamais la main est arrêté, et le run conclut à une erreur', async () => {
    const v = await poser('cat >/dev/null\nsleep 60', { nom: 'bloque', timeout_s: 10 });
    const lance = await app.api('POST', `/api/mrs/${mrId}/verify`, { verifier_id: v.id });
    const d = await attendre(lance.body.verification.id);
    assert.equal(d.verdict, 'verify_error');
    assert.match(d.log_excerpt || '', /délai dépassé/);
    await app.api('DELETE', `/api/verifiers/${v.id}`);
  });

  test('le script reçoit les dépôts sur stdin, et un environnement sans secret', async () => {
    /* Le script recopie ce qu'il a reçu dans son message d'échec : c'est la seule façon
       d'observer le contrat côté script sans lui faire confiance. */
    const cmd = ecrireScript(bin, 'espion.sh', [
      'ENTREE=$(cat)',
      'REPO=$(printf "%s" "$ENTREE" | sed -n \'s/.*"name":"\\([^"]*\\)".*/\\1/p\')',
      'ROLE=$(printf "%s" "$ENTREE" | sed -n \'s/.*"role":"\\([^"]*\\)".*/\\1/p\')',
      'printf \'{"version":1,"status":"fail","failed":[{"test":"espion","message":"repo=%s role=%s verif=%s token=%s"}]}\\n\' \\',
      '  "$REPO" "$ROLE" "$MERGERIE_VERIFY" "${GITLAB_TOKEN:-absent}"',
    ].join('\n'));
    const v = (await app.api('POST', '/api/verifiers', {
      name: 'espion', command: cmd, run_base: false,
      repos: [{ repo_id: repoId, mode: 'worktree' }],
    })).body;
    const lance = await app.api('POST', `/api/mrs/${mrId}/verify`, { verifier_id: v.id });
    const d = await attendre(lance.body.verification.id);
    const msg = d.head_run.failed[0].message;
    assert.match(msg, /repo=grp\/app/, 'le dépôt cible est transmis');
    assert.match(msg, /role=head/);
    assert.match(msg, /verif=1/, 'MERGERIE_VERIFY signale d’où vient l’appel');
    assert.match(msg, /token=absent/, 'aucun jeton ne doit atteindre le script');
    await app.api('DELETE', `/api/verifiers/${v.id}`);
  });

  /* Un job de vérification doit se DÉCLARER en cours. Sans ça il restait « en file » du début
     à la fin : le panneau de journal, le compteur de la file et l'état du favicon annonçaient
     une attente pendant qu'une suite de tests tournait. */
  test('pendant le run, le job est « en cours » et sait ce qu’il vérifie', async () => {
    const v = await poser('cat >/dev/null\nsleep 3\nprintf \'{"version":1,"status":"pass"}\\n\'',
      { nom: 'declare-running', timeout_s: 30, run_base: false });
    const lance = await app.api('POST', `/api/mrs/${mrId}/verify`, { verifier_id: v.id });

    let vu = null;
    for (let i = 0; i < 60 && !vu; i++) {
      const { body } = await app.api('GET', '/api/status');
      if (body.running && body.job && body.job.kind === 'verify') vu = body;
      else await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(vu, 'le job doit apparaître EN COURS, pas en file');
    assert.equal(vu.job.status, 'running');
    assert.equal(vu.queued, 0, 'il ne compte plus comme en attente une fois démarré');

    // Le journal d'activité doit pouvoir nommer ce que le job vérifiait.
    const { body: act } = await app.api('GET', '/api/jobs/history');
    const ligne = (act.jobs || []).find((j) => j.id === vu.job.id);
    assert.ok(ligne, 'le job figure dans le journal d’activité');
    assert.match(ligne.label || '', /declare-running/, 'la ligne nomme le vérificateur…');
    assert.match(ligne.label || '', /grp\/app !5/, '…et la merge request vérifiée');

    await attendre(lance.body.verification.id);
    await app.api('DELETE', `/api/verifiers/${v.id}`);
  });

  /* Un doublon sur le MÊME dépôt est refusé : relancer la même chose ne donne pas un second
     avis, seulement un run qui attend le premier pour dire la même chose. (Le cas d'un AUTRE
     dépôt — accepté — et celui d'un run multi-dépôts — bloquant — sont couverts par
     e2e-verify-commands.test.js, qui dispose de plusieurs dépôts.) */
  test('relancer la même vérification pendant qu’elle tourne est refusé', async () => {
    const v = await poser('cat >/dev/null\nsleep 5', { nom: 'lent', timeout_s: 30 });
    const un = await app.api('POST', `/api/mrs/${mrId}/verify`, { verifier_id: v.id });
    assert.equal(un.status, 200);
    const deux = await app.api('POST', `/api/mrs/${mrId}/verify`, { verifier_id: v.id });
    assert.equal(deux.status, 400);
    assert.match(deux.body.error, /déjà en file pour ce dépôt/);
    await attendre(un.body.verification.id);
    await app.api('DELETE', `/api/verifiers/${v.id}`);
  });

  /* L'escalade SIGTERM → SIGKILL, prouvée sur un script qui IGNORE SIGTERM.
     Le test de timeout voisin utilise `sleep`, qui meurt au premier signal : il ne pouvait
     donc rien dire de l'escalade, et celle-ci a été du code mort sans que rien ne le signale.
     Un script qui piège TERM, lui, ne s'arrête que si le SIGKILL part réellement — sinon il
     tourne indéfiniment, hors de portée du bouton Stop, dans un répertoire qu'on croit rendu. */
  test('un script qui ignore SIGTERM est tout de même tué', async () => {
    const pidFile = path.join(bin, 'pid-tetu.txt');
    if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile);
    const v = await poser(`cat >/dev/null\ntrap '' TERM\necho $$ > ${pidFile}\nwhile true; do sleep 1; done`,
      { nom: 'tetu', timeout_s: 10, run_base: false });

    const d = await attendre((await app.api('POST', `/api/mrs/${mrId}/verify`, { verifier_id: v.id })).body.verification.id);
    assert.equal(d.verdict, 'verify_error');
    assert.match(d.log_excerpt || '', /délai dépassé/);

    const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    assert.ok(pid > 0, 'le script a bien démarré et publié son pid');
    const mort = () => { try { process.kill(pid, 0); return false; } catch { return true; } };
    // SIGTERM est ignoré : seule l'escalade (SIGKILL à +10 s) peut le faire disparaître.
    for (let i = 0; i < 300 && !mort(); i++) await new Promise((r) => setTimeout(r, 100));
    if (!mort()) { try { process.kill(pid, 'SIGKILL'); } catch { /* déjà parti */ } }
    assert.ok(mort(), 'le processus survit à l’arrêt : l’escalade SIGKILL ne part pas');
    await app.api('DELETE', `/api/verifiers/${v.id}`);
  });

  /* Un run base en ERREUR ne doit pas devenir collant : un souci d'environnement passager
     serait resservi du cache à chaque vérification suivante sur les mêmes SHAs, et la base ne
     serait plus jamais rejouée. Seul un run qui a CONCLU mérite d'être mémorisé. */
  test('un run base en erreur n’est pas mis en cache', async () => {
    const compteur = path.join(bin, 'compteur-base.txt');
    if (fs.existsSync(compteur)) fs.unlinkSync(compteur);
    // Premier appel : erreur. Les suivants : vert. Le verdict change donc SI la base est rejouée.
    const v = await poser(`cat >/dev/null\nn=$(cat ${compteur} 2>/dev/null || echo 0)\nn=$((n+1))\necho $n > ${compteur}\n`
      + `if [ "$n" = "1" ]; then printf '{"version":1,"status":"error"}\\n'; else printf '{"version":1,"status":"pass"}\\n'; fi`,
      { nom: 'base-capricieuse' });

    const d1 = await attendre((await app.api('POST', `/api/mrs/${mrId}/verify`, { verifier_id: v.id })).body.verification.id);
    assert.equal(d1.verdict, 'verify_error', 'une base en erreur ne conclut pas');

    const d2 = await attendre((await app.api('POST', `/api/mrs/${mrId}/verify`, { verifier_id: v.id })).body.verification.id);
    assert.equal(d2.verdict, 'verified_pass', 'la base a été REJOUÉE, pas relue du cache');
    assert.equal(d2.base_run.status, 'pass');
    await app.api('DELETE', `/api/verifiers/${v.id}`);
  });

  test('le verdict se périme quand la branche avance', async () => {
    const v = await poser(reponse({ version: 1, status: 'pass' }), { nom: 'perime' });
    const lance = await app.api('POST', `/api/mrs/${mrId}/verify`, { verifier_id: v.id });
    const d = await attendre(lance.body.verification.id);
    assert.equal(d.stale, false);

    // La MR reçoit un nouveau commit : le verdict reste vrai pour l'ancien SHA, plus pour celui-ci.
    app.state.mrs['grp/app'][0].sha = 'nouveau-sha-après-le-run';
    await app.api('POST', '/api/discover');
    const relu = (await app.api('GET', `/api/verifications/${lance.body.verification.id}`)).body;
    assert.equal(relu.stale, true);
    assert.equal(relu.verdict, 'verified_pass', 'le verdict est conservé, pas effacé — il est daté');
    await app.api('DELETE', `/api/verifiers/${v.id}`);
  });

  /* Le badge de la liste. Sans ça, il faudrait ouvrir chaque MR pour savoir laquelle est
     vérifiée — l'intérêt de la fonctionnalité est justement de le voir sans cliquer. */
  test('la liste des MR porte le dernier verdict', async () => {
    const avant = (await app.api('GET', '/api/mrs')).body.find((m) => m.id === mrId);
    assert.equal(avant.verifiable, false, 'sans vérificateur, la liste doit permettre de GRISER le bouton');
    assert.equal(avant.verification.verdict, 'verified_pass', 'le verdict précédent est toujours rendu');
    assert.equal(avant.verification.stale, true, 'et sa péremption voyage avec lui');
    assert.equal(avant.verification.failed_count, 0);

    const v = await poser(reponse({ version: 1, status: 'fail', failed: [{ test: 'a' }, { test: 'b' }] }),
      { nom: 'badge-rouge', run_base: false });
    // La MR est repositionnée sur un SHA réel, sinon le run ne trouverait pas le commit.
    app.state.mrs['grp/app'][0].sha = execFileSync('git', ['rev-parse', 'feature/x'], { cwd: depotDistant }).toString().trim();
    await app.api('POST', '/api/discover');
    await attendre((await app.api('POST', `/api/mrs/${mrId}/verify`, { verifier_id: v.id })).body.verification.id);

    const apres = (await app.api('GET', '/api/mrs')).body.find((m) => m.id === mrId);
    assert.equal(apres.verifiable, true, 'un vérificateur couvre désormais ce dépôt');
    assert.equal(apres.verification.verdict, 'verified_fail');
    assert.equal(apres.verification.failed_count, 2, 'le badge sait combien de tests cassent, sans charger les logs');
    assert.equal(apres.verification.stale, false);
    assert.equal(apres.verification.log_excerpt, undefined, 'le résumé ne charge pas les journaux du run');
    await app.api('DELETE', `/api/verifiers/${v.id}`);
  });

  /* Écrire chez les autres est une décision : elle se prend par vérificateur, et le
     commentaire porte les faits — un « ✗ » sans dossier est une accusation. */
  test('le verdict n’est commenté sur la forge que sur opt-in explicite', async () => {
    const muet = await poser(reponse({ version: 1, status: 'fail', failed: [{ test: 'x' }] }), { nom: 'muet-forge', run_base: false });
    let avant = app.state.calls.length;
    await attendre((await app.api('POST', `/api/mrs/${mrId}/verify`, { verifier_id: muet.id })).body.verification.id);
    assert.equal(app.state.calls.slice(avant).filter((c) => c.method === 'POST' && c.path.includes('/notes')).length, 0,
      'sans opt-in, rien n’est écrit sur la merge request');
    await app.api('DELETE', `/api/verifiers/${muet.id}`);

    const bavard = (await app.api('POST', '/api/verifiers', {
      name: 'bavard', run_base: false, comment_on_forge: 1,
      command: ecrireScript(bin, 'bavard.sh', reponse({
        version: 1, status: 'fail', failed: [{ test: 'panier › total', message: 'attendu 42, reçu 41' }],
      })),
      repos: [{ repo_id: repoId, mode: 'worktree' }],
    })).body;
    avant = app.state.calls.length;
    await attendre((await app.api('POST', `/api/mrs/${mrId}/verify`, { verifier_id: bavard.id })).body.verification.id);
    const note = app.state.calls.slice(avant).find((c) => c.method === 'POST' && c.path.includes('/notes'));
    assert.ok(note, 'avec opt-in, le verdict est publié');
    assert.match(note.body.body, /panier › total/, 'le commentaire dit QUEL test casse');
    assert.match(note.body.body, /attendu 42, reçu 41/, '…et pourquoi');
    assert.match(note.body.body, /Commits testés/, '…et sur quels commits le verdict porte');
    await app.api('DELETE', `/api/verifiers/${bavard.id}`);
  });
});
