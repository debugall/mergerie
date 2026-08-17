'use strict';
/* PUBLIER LE VERDICT SUR LA MERGE REQUEST — le texte relu, pas le texte proposé.
 *
 * C'est la seule fonctionnalité de l'outil qui écrit chez les autres sans qu'un agent soit en
 * cause : ce qui part est lu par des collègues, sur leur merge request. Trois choses doivent
 * donc être vraies, et ce fichier ne teste presque que ça :
 *
 *   1. Ce qu'on relit dans la modale est EXACTEMENT ce que la publication automatique
 *      enverrait — sinon relire avant de publier ne prouve rien.
 *   2. C'est le texte MODIFIÉ qui part. Un mutant qui posterait le pré-rempli doit faire
 *      tomber un test : c'est toute la valeur de la fonctionnalité.
 *   3. Ce qui a été publié se voit ensuite, pour ne pas poster deux fois le même verdict.
 *
 * Le gabarit et l'horodatage se prouvent sans base ni réseau (`verify.composerCommentaire`),
 * le reste de bout en bout.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { startApp, poserIdentiteGit } = require('./helpers/app');
const verify = require('../src/verify');

describe('Verdict publié en commentaire', () => {
  let app; let repoId; let mrId; let bin; let distant;

  before(async () => {
    app = await startApp();
    bin = fs.mkdtempSync(path.join(os.tmpdir(), 'bin-'));
    distant = fs.mkdtempSync(path.join(os.tmpdir(), 'depot-'));
    const git = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'pipe' }).toString().trim();
    git(distant, 'init', '-q', '-b', 'main');
    poserIdentiteGit(distant);
    fs.writeFileSync(path.join(distant, 'a.txt'), 'base\n');
    git(distant, 'add', '-A'); git(distant, 'commit', '-qm', 'base');
    git(distant, 'checkout', '-q', '-b', 'feature/x');
    fs.writeFileSync(path.join(distant, 'a.txt'), 'tete\n');
    git(distant, 'add', '-A'); git(distant, 'commit', '-qm', 'tete');
    const head = git(distant, 'rev-parse', 'HEAD');
    git(distant, 'checkout', '-q', 'main');
    await app.configure();
    repoId = (await app.api('POST', '/api/repos', { project: 'grp/app', url: distant })).body.id;
    app.state.projects = [{ id: 1, path_with_namespace: 'grp/app', http_url_to_repo: distant }];
    app.state.mrs['grp/app'] = [{
      iid: 5, title: 'X', state: 'opened', source_branch: 'feature/x', target_branch: 'main',
      web_url: 'http://x/5', sha: head, created_at: new Date().toISOString(), author: { name: 'A' },
    }];
    await app.api('POST', '/api/discover');
    mrId = (await app.api('GET', '/api/mrs')).body.find((m) => m.iid === 5).id;
  });
  after(async () => { await app.stop(); });

  const script = (nom, corps) => {
    const p = path.join(bin, `${nom}.sh`);
    fs.writeFileSync(p, `#!/bin/sh\n${corps}\n`, { mode: 0o755 });
    return p;
  };

  async function verifier(opts = {}) {
    const v = (await app.api('POST', '/api/verifiers', {
      name: opts.nom || `v${Date.now()}`, kind: 'commands', run_base: false, timeout_s: 60,
      commands: [opts.commande || script('ok', 'exit 0')],
      repos: [{ repo_id: repoId, mode: 'worktree' }],
      ...opts.champs,
    })).body;
    const lance = await app.api('POST', `/api/mrs/${mrId}/verify`, { verifier_id: v.id });
    assert.equal(lance.status, 200, JSON.stringify(lance.body));
    for (let i = 0; i < 600; i += 1) {
      const { body } = await app.api('GET', `/api/verifications/${lance.body.verification.id}`);
      if (body.status === 'done' || body.status === 'error') {
        /* La vérification est close, mais le JOB qui la porte peut ne pas l'être — et c'est lui
           qui tient le verrou « une seule vérification à la fois par dépôt ». Sans cette
           attente, le test suivant se fait refuser son lancement. */
        for (let j = 0; j < 600; j += 1) {
          const { body: st } = await app.api('GET', '/api/status');
          if (!st.running && !st.queued) break;
          await new Promise((r) => setTimeout(r, 50));
        }
        return { v, d: body };
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('la vérification ne se termine pas');
  }

  /* ------------------------------------------------------------- le gabarit ---- */

  test('le gabarit pose les blocs, l’horodatage, et ignore un champ inconnu', () => {
    const quand = new Date('2026-08-17T14:12:00');
    const blocs = { verdict: 'V', tests: 'T', commits: 'C', verificateur: 'integ' };
    const rendu = verify.composerCommentaire(blocs, 'Le {date} à {heure} — {verificateur}\n{verdict}\n{tests}\n{commits}', quand);
    assert.match(rendu, /Le 17\/08\/2026 à 14:12 — integ/, 'la date ET l’heure du moment de la composition');
    assert.match(rendu, /^Le .*\nV\nT\nC$/s);

    /* Un marqueur inconnu reste TEL QUEL au lieu de disparaître : une faute de frappe doit se
       voir dans l'aperçu, pas se traduire par un trou silencieux dans le commentaire. */
    assert.match(verify.composerCommentaire(blocs, '{verdict} {inconnu}', quand), /V \{inconnu\}/);
  });

  test('un gabarit vide retombe sur le défaut, et un bloc vide ne laisse pas de trou', () => {
    const rendu = verify.composerCommentaire({ verdict: 'V', tests: '', commits: 'C' }, '', new Date());
    assert.match(rendu, /^V\n\nC/, 'le bloc « tests » vide ne laisse pas trois sauts de ligne');
    assert.doesNotMatch(rendu, /\n{3}/);
  });

  /* --------------------------------------------------------- la publication ---- */

  test('le corps proposé est celui qui partirait tout seul, et il nomme la MR', async () => {
    const { d } = await verifier({
      nom: 'ko-pre', commande: script('ko', "printf 'TAP version 13\\nnot ok 1 - panier › total\\n1..1\\n'\nexit 1"),
    });
    const { body: pre } = await app.api('GET', `/api/verifications/${d.id}/comment`);
    assert.deepEqual(pre.mrs, ['grp/app !5'], 'la confirmation doit pouvoir nommer la merge request');
    assert.equal(pre.posted_at, null, 'rien n’a encore été publié');
    assert.match(pre.body, /✗ 1 test\(s\) cassé\(s\) par cette branche/);
    assert.match(pre.body, /panier › total/, 'les faits, pas seulement le verdict');
    assert.match(pre.body, /Commandes en échec :/, 'le gabarit par défaut nomme la commande fautive');
    assert.match(pre.body, /code de sortie 1/);
    assert.match(pre.body, /_Vérifié le \d{2}\/\d{2}\/\d{4} à \d{2}:\d{2}\._/, 'l’horodatage du gabarit par défaut');
  });

  /* LE CŒUR. Si un jour quelqu'un « simplifie » en publiant le corps recomposé côté serveur,
     ce test tombe — et c'est exactement ce qu'on veut. */
  test('c’est le texte MODIFIÉ qui est publié, pas le pré-rempli', async () => {
    const { d } = await verifier({ nom: 'edite' });
    const { body: pre } = await app.api('GET', `/api/verifications/${d.id}/comment`);
    const avant = app.state.calls.length;

    const r = await app.api('POST', `/api/verifications/${d.id}/comment`, {
      body: 'Relu et corrigé à la main : le tunnel de paiement est vert.',
    });
    assert.equal(r.status, 200);
    const note = app.state.calls.slice(avant).find((c) => c.method === 'POST' && c.path.includes('/notes'));
    assert.ok(note, 'le commentaire part sur la forge');
    assert.equal(note.body.body, 'Relu et corrigé à la main : le tunnel de paiement est vert.');
    assert.notEqual(note.body.body, pre.body, 'le pré-rempli n’est PAS ce qui a été envoyé');
  });

  test('ce qui est publié laisse une trace, pour ne pas le publier deux fois', async () => {
    const { d } = await verifier({ nom: 'trace' });
    await app.api('POST', `/api/verifications/${d.id}/comment`, { body: 'un texte' });
    const { body: apres } = await app.api('GET', `/api/verifications/${d.id}/comment`);
    assert.ok(apres.posted_at, 'la date de publication est rendue à l’écran');
    assert.deepEqual(apres.posted_targets, ['grp/app!5']);
  });

  test('un commentaire vide est refusé — il n’y a rien à publier', async () => {
    const { d } = await verifier({ nom: 'vide' });
    const avant = app.state.calls.length;
    assert.equal((await app.api('POST', `/api/verifications/${d.id}/comment`, { body: '   ' })).status, 400);
    assert.equal(app.state.calls.slice(avant).filter((c) => c.path.includes('/notes')).length, 0);
  });

  /* La trace n'est posée QUE si quelque chose est parti : sinon le bouton disparaîtrait après
     un échec réseau, en laissant croire que le verdict a été publié. */
  test('une publication qui échoue ne laisse pas de trace de publication', async () => {
    const { d } = await verifier({ nom: 'echec-reseau' });
    app.state.failNextNote = true;                      // la forge refuse le prochain commentaire
    const r = await app.api('POST', `/api/verifications/${d.id}/comment`, { body: 'texte' });
    assert.equal(r.status, 400, JSON.stringify(r.body));
    const { body: apres } = await app.api('GET', `/api/verifications/${d.id}/comment`);
    assert.equal(apres.posted_at, null, 'rien n’est parti : rien n’est marqué comme publié');
  });

  /* ------------------------------------------- la publication AUTOMATIQUE ---- */

  /* LA RÈGLE : on n'écrit sur la merge request de quelqu'un que si la base PASSAIT et que sa
     branche l'a CASSÉE. C'est le seul cas où le commentaire apprend quelque chose. La décision
     est pure — elle se prouve sans base ni réseau. */
  test('c’est la BASE VERTE qui autorise à publier, vert comme rouge', () => {
    const p = { status: 'pass' }; const f = { status: 'fail' }; const e = { status: 'error' };
    assert.equal(verify.doitCommenterAuto(p, f), true, 'la base passait, cette branche casse : on le dit');
    assert.equal(verify.doitCommenterAuto(p, p), true, 'la base passait, la branche tient : un vert ÉCRIT vaut mieux qu’un badge à aller chercher');
    assert.equal(verify.doitCommenterAuto(f, f), false, 'base déjà rouge : ce n’est pas imputable à cette branche');
    assert.equal(verify.doitCommenterAuto(f, p), false, 'base rouge : le verdict ne veut rien dire de la branche');
    assert.equal(verify.doitCommenterAuto(null, f), false, 'sans run base, on ne SAIT PAS : publier serait affirmer');
    assert.equal(verify.doitCommenterAuto(p, e), false, 'run en erreur : il n’y a pas de verdict à publier');
    assert.equal(verify.doitCommenterAuto(p, null), false);
  });

  /* Et de bout en bout : c'est le chemin automatique, celui qui écrit sans qu'on regarde. */
  test('coché, il publie dès que la base est verte — et se tait quand elle ne l’est pas', async () => {
    const rouge = script('auto-ko', "printf 'TAP version 13\nnot ok 1 - panier › total\n1..1\n'\nexit 1");
    const vert = script('auto-ok', 'exit 0');

    /* Base VERTE, tête ROUGE. Le script répond selon le rôle : le run base part en premier,
       on compte donc les appels — la base est le 1er, la tête le 2e. */
    const compteur = path.join(bin, 'compteur.txt');
    fs.rmSync(compteur, { force: true });
    const causal = script('auto-causal', [
      `n=$(cat ${compteur} 2>/dev/null || echo 0)`,
      `n=$((n+1)); echo $n > ${compteur}`,
      'if [ "$n" = "1" ]; then exit 0; fi',      // base : verte
      "printf 'TAP version 13\nnot ok 1 - panier › total\n1..1\n'",
      'exit 1',                                   // tête : rouge
    ].join('\n'));

    let avant = app.state.calls.length;
    let { d } = await verifier({ nom: 'auto-causal', commande: causal, champs: { comment_on_forge: 1, run_base: 1 } });
    assert.equal(d.verdict, 'verified_fail');
    const note = app.state.calls.slice(avant).find((c) => c.method === 'POST' && c.path.includes('/notes'));
    assert.ok(note, 'la base passait, la branche casse : le verdict est publié');
    assert.match(note.body.body, /panier › total/, '…avec les faits');

    // TOUT VERT : on publie aussi — sur une MR qu'on va relire, un vert écrit vaut mieux qu'un
    // badge qu'il faut aller chercher dans un autre outil.
    avant = app.state.calls.length;
    ({ d } = await verifier({ nom: 'auto-vert', commande: vert, champs: { comment_on_forge: 1, run_base: 1 } }));
    assert.equal(d.verdict, 'verified_pass');
    const vertPoste = app.state.calls.slice(avant).find((c) => c.method === 'POST' && c.path.includes('/notes'));
    assert.ok(vertPoste, 'base verte et tête verte : le verdict est publié');
    assert.match(vertPoste.body.body, /✓ vérifié/);

    // BASE DÉJÀ ROUGE (le même script échoue des deux côtés) : rien ne part non plus.
    avant = app.state.calls.length;
    ({ d } = await verifier({ nom: 'auto-base-rouge', commande: rouge, champs: { comment_on_forge: 1, run_base: 1 } }));
    assert.equal(d.verdict, 'broken_base');
    assert.equal(app.state.calls.slice(avant).filter((c) => c.path.includes('/notes')).length, 0,
      'base déjà rouge : accuser cette branche serait faux');

    // SANS RUN BASE : on ne sait pas si c'était déjà rouge, donc on se tait.
    avant = app.state.calls.length;
    ({ d } = await verifier({ nom: 'auto-sans-base', commande: rouge, champs: { comment_on_forge: 1, run_base: 0 } }));
    assert.equal(d.verdict, 'verified_fail');
    assert.equal(app.state.calls.slice(avant).filter((c) => c.path.includes('/notes')).length, 0,
      'sans run base, publier reviendrait à affirmer ce qu’on n’a pas vérifié');
  });

  /* ------------------------------------------------- le gabarit du vérificateur ---- */

  /* `{commandes}` répond à « laquelle a cassé ? » — la question que `{tests}` laisse ouverte
     quand la sortie nomme les tests. */
  test('{commandes} nomme les commandes en échec, avec leur code de sortie', async () => {
    const { v, d } = await verifier({
      nom: 'cmds', commande: script('cmds-ko', "printf 'TAP version 13\nnot ok 1 - panier › total\n1..1\n'\nexit 3"),
    });
    await app.api('PUT', `/api/verifiers/${v.id}`, { comment_template: '{tests}\n\n{commandes}' });
    const { body: pre } = await app.api('GET', `/api/verifications/${d.id}/comment`);

    assert.match(pre.body, /panier › total/, 'le nom du test vient du TAP…');
    assert.match(pre.body, /Commandes en échec :/);
    assert.match(pre.body, /cmds-ko\.sh` — code de sortie 3/, '…et la commande fautive est nommée, avec son code');
  });

  test('{commandes} reste vide quand rien n’a échoué', async () => {
    const { v, d } = await verifier({ nom: 'cmds-vert' });
    await app.api('PUT', `/api/verifiers/${v.id}`, { comment_template: '{verdict}\n\n{commandes}\n\n{commits}' });
    const { body: pre } = await app.api('GET', `/api/verifications/${d.id}/comment`);
    assert.doesNotMatch(pre.body, /Commandes en échec/, 'tout est vert : pas de section vide');
    assert.doesNotMatch(pre.body, /\n{3}/, '…et pas de trou laissé par le champ absent');
  });

  test('le gabarit du vérificateur remplace le défaut, à l’écran comme à l’envoi', async () => {
    const { v, d } = await verifier({ nom: 'gabarit' });
    await app.api('PUT', `/api/verifiers/${v.id}`, {
      comment_template: 'Vérif {verificateur} — {date}\n{verdict}',
    });
    const { body: pre } = await app.api('GET', `/api/verifications/${d.id}/comment`);
    assert.match(pre.body, /^Vérif gabarit — \d{2}\/\d{2}\/\d{4}/);
    assert.doesNotMatch(pre.body, /Commits testés/, 'un champ absent du gabarit ne s’invite pas');

    // Le gabarit est relu tel quel : ni tronqué, ni normalisé.
    const relu = (await app.api('GET', '/api/verifiers')).body.find((x) => x.id === v.id);
    assert.equal(relu.comment_template, 'Vérif {verificateur} — {date}\n{verdict}');
  });

  test('le gabarit par défaut est servi par le serveur, pas recopié dans l’écran', async () => {
    const { body } = await app.api('GET', '/api/verifiers/comment-template-default');
    assert.equal(body.template, verify.GABARIT_COMMENTAIRE_DEFAUT);
    assert.ok(body.champs.includes('date') && body.champs.includes('heure'));
  });
});
