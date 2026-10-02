'use strict';
/* PRÉCISION TECHNIQUE D'UN TICKET — la chaîne entière, par l'API.
 *
 * Un ticket écrit par un PO, un dépôt, une page Confluence : l'IA (en dry-run) pose ses
 * questions, on répond, elle propose ; on fait ajuster (suivi), on corrige à la main, on poste
 * en commentaire ; on reposte : c'est le MÊME commentaire qui est mis à jour, pas un nouveau ;
 * le ticket change de description : la spec passe « à revoir » ; Jira refuse la mise à jour
 * (commentaire d'un collègue) : rien n'est posté en silence, on choisit ; une page Confluence
 * refusée n'empêche pas la proposition ; une epic lance un lot. */
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startApp, makeRemoteRepo, waitForJobs, attendreServeur } = require('./helpers/app');

const MOI = { accountId: 'me-test', displayName: 'Testeur courant' };
const etat = (nom, cat) => ({ name: nom, statusCategory: { key: cat } });
const adf = (texte) => ({ type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: texte }] }] });
const texteAdf = (doc) => JSON.stringify(doc);

describe('Précision technique d’un ticket Jira', () => {
  let app; let repoId; let repoId2;
  const appels = (motif, methode = null) => app.state.calls.filter((c) => motif.test(c.path) && (!methode || c.method === methode));

  before(async () => {
    app = await startApp();
    const repo = makeRemoteRepo(fs.mkdtempSync(path.join(app.dataDir, 'spec-')));
    app.state.branches['grp/app'] = [{ name: 'main', default: true, protected: false, merged: false, commit: { id: repo.mainSha } }];
    await app.configure({ jira_url: app.gitlabUrl, jira_email: 'moi@example.com', jira_token: 'jetonjira', jira_watch_minutes: '0' });
    repoId = (await app.api('POST', '/api/repos', { url: repo.url, project: 'grp/app' })).body.id;
    const repo2 = makeRemoteRepo(fs.mkdtempSync(path.join(app.dataDir, 'spec2-')));
    app.state.branches['grp/api'] = [{ name: 'main', default: true, protected: false, merged: false, commit: { id: repo2.mainSha } }];
    repoId2 = (await app.api('POST', '/api/repos', { url: repo2.url, project: 'grp/api' })).body.id;

    const commun = { assignee: MOI, project: { key: 'PROJ', name: 'Boutique' }, updated: '2026-09-10T10:00:00.000+0000', status: etat('À faire', 'new'), issuetype: { name: 'Story' } };
    const epic = { key: 'PROJ-100', fields: { summary: 'Facturation 2026', issuetype: { name: 'Epic', hierarchyLevel: 1 } } };
    app.state.jiraIssues['PROJ-100'] = { key: 'PROJ-100', fields: { ...commun, summary: 'Facturation 2026', issuetype: { name: 'Epic', hierarchyLevel: 1 }, description: adf('Tout ce qui touche à la facturation.') } };
    app.state.jiraIssues['PROJ-10'] = { key: 'PROJ-10', fields: { ...commun, summary: 'Paiement en trois fois', parent: epic, description: adf('Le client peut payer en trois fois sans frais.') }, comments: [] };
    app.state.jiraIssues['PROJ-11'] = { key: 'PROJ-11', fields: { ...commun, summary: 'Avoir sur facture', parent: epic, description: adf('Émettre un avoir.') }, comments: [] };
    app.state.jiraIssues['PROJ-12'] = { key: 'PROJ-12', fields: { ...commun, summary: 'Export comptable', parent: epic, description: adf('Exporter les factures.') }, comments: [] };
    app.state.confluencePages['123456'] = { title: 'Règles TVA', storage: '<h1>TVA</h1><p>Le taux <strong>réduit</strong> s’applique aux livres.</p><ul><li>5,5 %</li><li>20 %</li></ul>' };
    app.state.confluencePages['999'] = { status: 403 };
  });
  after(async () => { await app.stop(); });

  test('ticket seul : questions, réponse, proposition rangée en version 1', async () => {
    const r = await app.api('POST', '/api/jira/spec', {
      key: 'PROJ-10', repo_ids: [repoId], complement: 'C’est le service billing, pas crm.', detail: 'synthese',
      confluence_urls: [`${app.gitlabUrl}/wiki/spaces/DEV/pages/123456/Regles-TVA`, `${app.gitlabUrl}/wiki/spaces/DEV/pages/999/Interdite`],
      include_epic: true, ask_questions: true,
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const s = r.body.spec;
    assert.equal(s.status, 'running');
    assert.ok(s.task_id, 'une session d’exploration porte l’analyse');
    assert.equal(s.epic_key, 'PROJ-100', 'l’epic du ticket est relevée');
    // Les pages : l'une lue (titre, taille), l'autre refusée — et dite comme telle.
    const lue = s.confluence.find((p) => /123456/.test(p.url));
    const refusee = s.confluence.find((p) => /999/.test(p.url));
    assert.equal(lue.title, 'Règles TVA');
    assert.ok(lue.chars > 0 && !lue.error);
    assert.match(refusee.error, /403/, 'la page refusée porte son erreur');
    assert.ok(appels(/\/rest\/api\/3\/search/).some((c) => /parent/.test(decodeURIComponent(c.path))), 'les enfants de l’epic sont demandés');

    await waitForJobs(app.api);
    let vue = (await app.api('GET', '/api/jira/spec/PROJ-10')).body.spec;
    assert.equal(vue.status, 'needs_input', 'l’agent (dry-run) a posé ses questions : la spec attend');
    const tache = (await app.api('GET', `/api/tasks/${vue.task_id}`)).body.task;
    assert.equal(tache.status, 'needs_input');
    // Le prompt porte le ticket, la page lue, le complément, et NE porte PAS la page refusée en données.
    const md = (await app.api('GET', `/api/tasks/${vue.task_id}/md`)).body;
    assert.match(md.prompt, /Paiement en trois fois/);
    assert.match(md.prompt, /taux \*\*réduit\*\*/, 'la page Confluence est convertie en Markdown');
    assert.match(md.prompt, /service billing/);
    assert.match(md.prompt, /<<<SPEC [0-9a-f]{6}/, 'le bloc de réponse est demandé au nonce de la spec');
    assert.match(md.prompt, /999\/Interdite[^\n]*403/, 'la page refusée est signalée');
    assert.match(md.prompt, /PROJ-11 — Avoir sur facture/, 'les tickets de l’epic sont en contexte');

    const tg = tache.targets[0];
    const rep = await app.api('POST', `/api/tasks/${vue.task_id}/targets/${tg.id}/answer`, { answers: { q1: 'decorator', q2: 'Oui' } });
    assert.equal(rep.status, 200);
    await waitForJobs(app.api);
    vue = (await app.api('GET', '/api/jira/spec/PROJ-10')).body.spec;
    assert.equal(vue.status, 'proposed', 'après réponses, la proposition est là');
    assert.equal(vue.version, 1);
    assert.equal(vue.versions[0].origin, 'ai');
    assert.match(vue.markdown, /## Dépôts concernés/);
    assert.match(vue.markdown, /## Questions ouvertes pour le PO/);
    assert.doesNotMatch(vue.markdown, /<<<SPEC/, 'le bloc est extrait, pas recopié');
    assert.equal(vue.unposted, true);
    // La session apparaît dans Dev IA avec sa clé : la liste peut la masquer d'un geste.
    const liste = (await app.api('GET', '/api/tasks')).body;
    assert.equal(liste.find((x) => x.id === vue.task_id).spec_key, 'PROJ-10');
    // Et le bloc de protocole ne s'affiche pas dans la réponse de la session.
    assert.doesNotMatch((await app.api('GET', `/api/tasks/${vue.task_id}/md`)).body.md, /<<<SPEC/);
  });

  test('suivi puis édition : deux versions de plus, chacune avec son origine', async () => {
    let vue = (await app.api('GET', '/api/jira/spec/PROJ-10')).body.spec;
    const r = await app.api('POST', `/api/jira/spec/${vue.id}/followup`, { instruction: 'Détaille la partie migration.' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.spec.status, 'running');
    await waitForJobs(app.api);
    vue = (await app.api('GET', '/api/jira/spec/PROJ-10')).body.spec;
    assert.equal(vue.status, 'proposed');
    assert.equal(vue.version, 2, 'le suivi produit une version de plus');
    assert.equal(vue.versions[1].origin, 'followup');

    const e = await app.api('PUT', `/api/jira/spec/${vue.id}`, { markdown: `${vue.markdown}\n\n## Note du dev\nOn garde l’ancien endpoint.` });
    assert.equal(e.status, 200);
    assert.equal(e.body.spec.version, 3);
    assert.equal(e.body.spec.status, 'edited');
    assert.equal(e.body.spec.versions[2].origin, 'edit');
    assert.match(e.body.spec.markdown, /Note du dev/);
    // Une version vide est refusée.
    assert.equal((await app.api('PUT', `/api/jira/spec/${vue.id}`, { markdown: '  ' })).status, 400);
  });

  test('poster, puis reposter : le même commentaire est mis à jour, jamais empilé', async () => {
    let vue = (await app.api('GET', '/api/jira/spec/PROJ-10')).body.spec;
    const avant = appels(/\/issue\/PROJ-10\/comment/, 'POST').length;
    const p1 = await app.api('POST', `/api/jira/spec/${vue.id}/post`);
    assert.equal(p1.status, 200, JSON.stringify(p1.body));
    assert.equal(p1.body.updated, false);
    assert.equal(appels(/\/issue\/PROJ-10\/comment/, 'POST').length, avant + 1, 'un commentaire créé');
    const poste = appels(/\/issue\/PROJ-10\/comment/, 'POST').pop().body;
    const texte = texteAdf(poste.body);
    assert.match(texte, /Précision technique — Mergerie v3/, 'la ligne repère ouvre le commentaire, avec la version');
    assert.match(texte, /"type":"heading"/, 'les titres Markdown deviennent des titres ADF');
    assert.match(texte, /"type":"bulletList"/, 'les listes aussi');
    vue = p1.body.spec;
    assert.equal(vue.status, 'posted');
    assert.equal(vue.posted_version, 3);
    assert.equal(vue.unposted, false);
    assert.ok(vue.comment_id, 'l’id du commentaire est mémorisé');
    const idCommentaire = vue.comment_id;

    // Une édition de plus, et on reposte : PUT sur le même id, aucun POST de plus.
    await app.api('PUT', `/api/jira/spec/${vue.id}`, { markdown: `${vue.markdown}\n\nRelu.` });
    const p2 = await app.api('POST', `/api/jira/spec/${vue.id}/post`);
    assert.equal(p2.status, 200, JSON.stringify(p2.body));
    assert.equal(p2.body.updated, true, 'mise à jour, pas création');
    assert.equal(appels(/\/issue\/PROJ-10\/comment/, 'POST').length, avant + 1, 'toujours un seul commentaire créé');
    assert.equal(appels(new RegExp(`/issue/PROJ-10/comment/${idCommentaire}`), 'PUT').length, 1, 'le PUT vise l’id mémorisé');
    assert.equal(p2.body.spec.comment_id, idCommentaire);
    assert.equal(p2.body.spec.posted_version, 4);
    assert.match(texteAdf(appels(/\/comment\/\d+$/, 'PUT').pop().body.body), /Mergerie v4/);

    /* L'ID OUBLIÉ, LE REPÈRE RETROUVE. Spec refaite sur un autre poste, base restaurée : on
       efface l'id — le post suivant relit les commentaires du ticket et ADOPTE celui qui porte
       la ligne repère et appartient à ce compte, au lieu d'en créer un deuxième. */
    app.db.prepare('UPDATE ticket_spec SET comment_id = NULL WHERE id = ?').run(vue.id);
    await app.api('PUT', `/api/jira/spec/${vue.id}`, { markdown: `${vue.markdown}\n\nRelu encore.` });
    const p3 = await app.api('POST', `/api/jira/spec/${vue.id}/post`);
    assert.equal(p3.status, 200, JSON.stringify(p3.body));
    assert.equal(p3.body.updated, true, 'retrouvé par la ligne repère');
    assert.equal(p3.body.spec.comment_id, idCommentaire);
    assert.equal(appels(/\/issue\/PROJ-10\/comment/, 'POST').length, avant + 1);

    /* SUPPRIMÉ SUR JIRA ENTRE-TEMPS : on recrée, et on le dit. */
    app.state.jiraIssues['PROJ-10'].comments = [];
    await app.api('PUT', `/api/jira/spec/${vue.id}`, { markdown: `${vue.markdown}\n\nAprès suppression.` });
    const p4 = await app.api('POST', `/api/jira/spec/${vue.id}/post`);
    assert.equal(p4.status, 200, JSON.stringify(p4.body));
    assert.equal(p4.body.recreated, true);
    assert.notEqual(p4.body.spec.comment_id, idCommentaire, 'le nouvel id remplace l’ancien');
    assert.equal(appels(/\/issue\/PROJ-10\/comment/, 'POST').length, avant + 2);

    /* REFUSÉ (commentaire d'un collègue, droit retiré) : 409, rien de posté, puis on choisit. */
    app.state.jiraCommentDenied = true;
    await app.api('PUT', `/api/jira/spec/${vue.id}`, { markdown: `${vue.markdown}\n\nSous mon nom.` });
    const p5 = await app.api('POST', `/api/jira/spec/${vue.id}/post`);
    assert.equal(p5.status, 409);
    assert.equal(p5.body.code, 'SPEC_COMMENT_DENIED');
    assert.equal(appels(/\/issue\/PROJ-10\/comment/, 'POST').length, avant + 2, 'rien n’a été créé en silence');
    const p6 = await app.api('POST', `/api/jira/spec/${vue.id}/post`, { force_new: true });
    assert.equal(p6.status, 200, JSON.stringify(p6.body));
    assert.equal(appels(/\/issue\/PROJ-10\/comment/, 'POST').length, avant + 3, 'une nouvelle version sous mon nom');
    app.state.jiraCommentDenied = false;
  });

  test('le ticket change de sens : la spec passe « à revoir » quand on l’ouvre ; un changement d’état, non', async () => {
    const vue = (await app.api('GET', '/api/jira/spec/PROJ-10')).body.spec;
    assert.equal(vue.status, 'posted');
    app.state.jiraIssues['PROJ-10'].fields.status = etat('En cours', 'indeterminate');
    await app.api('GET', '/api/jira/issue/PROJ-10');
    assert.equal((await app.api('GET', '/api/jira/spec/PROJ-10')).body.spec.status, 'posted', 'un état qui bouge ne périme rien');
    app.state.jiraIssues['PROJ-10'].fields.description = adf('Le client peut payer en QUATRE fois, avec frais.');
    await app.api('GET', '/api/jira/issue/PROJ-10');
    assert.equal((await app.api('GET', '/api/jira/spec/PROJ-10')).body.spec.status, 'stale', 'la description a changé : à revoir');
    // Relancer relit le ticket : nouvelle photo, nouvelle session, les versions restent.
    const r = await app.api('POST', `/api/jira/spec/${vue.id}/rerun`, { ask_questions: false });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.notEqual(r.body.spec.task_id, vue.task_id, 'une session neuve');
    await waitForJobs(app.api);
    const apres = (await app.api('GET', '/api/jira/spec/PROJ-10')).body.spec;
    assert.equal(apres.status, 'proposed');
    assert.ok(apres.version > vue.version, 'les versions s’empilent');
    assert.ok(apres.comment_id, 'le commentaire posté n’est pas oublié');
    assert.equal(apres.unposted, true);
    await app.api('GET', '/api/jira/issue/PROJ-10');
    assert.equal((await app.api('GET', '/api/jira/spec/PROJ-10')).body.spec.status, 'proposed', 'la nouvelle photo est à jour');
  });

  test('sans dépôt, pas d’analyse ; une clé invalide est refusée', async () => {
    assert.equal((await app.api('POST', '/api/jira/spec', { key: 'PROJ-11', repo_ids: [] })).status, 400);
    assert.equal((await app.api('POST', '/api/jira/spec', { key: 'nimporte', repo_ids: [repoId] })).status, 400);
    assert.equal((await app.api('GET', '/api/jira/spec/PROJ-11')).body.spec, null);
  });

  test('une epic : ses tickets listés, un lot lancé, une spec par ticket coché', async () => {
    const enfants = (await app.api('GET', '/api/jira/spec/epic/PROJ-100/children')).body;
    assert.deepEqual(enfants.children.map((c) => c.key).sort(), ['PROJ-10', 'PROJ-11', 'PROJ-12']);
    assert.ok(enfants.specs['PROJ-10'], 'le ticket déjà précisé est signalé');
    const r = await app.api('POST', '/api/jira/spec/epic', { epic_key: 'PROJ-100', keys: ['PROJ-11', 'PROJ-12'], repo_ids: [repoId, repoId2], ask_questions: false, detail: 'detaille' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.specs.length, 2);
    assert.deepEqual(r.body.errors, []);
    await waitForJobs(app.api);
    const lot = (await app.api('GET', `/api/jira/spec/batch/${r.body.batch_id}`)).body;
    assert.equal(lot.specs.length, 2);
    for (const s of lot.specs) {
      assert.equal(s.status, 'proposed', `${s.ticket_key} : ${s.last_error || s.status}`);
      assert.equal(s.epic_key, 'PROJ-100');
      assert.deepEqual(s.repos.map((x) => x.id).sort(), [repoId, repoId2].sort(), 'les deux dépôts sont les cibles');
      assert.match(s.markdown, /## Ce qu’il faut faire|## Ce qu'il faut faire/);
    }
    const badges = (await app.api('GET', '/api/jira/specs?keys=PROJ-10,PROJ-11,PROJ-12,PROJ-99')).body.specs;
    assert.equal(Object.keys(badges).length, 3);
    assert.equal(badges['PROJ-11'].status, 'proposed');
    assert.equal(badges['PROJ-11'].unposted, true);
    // Pré-remplissage d'une session depuis la spec : les dépôts et la proposition.
    const pre = (await app.api('GET', `/api/jira/spec/${badges['PROJ-11'].id}/prefill`)).body;
    assert.equal(pre.repos.length, 2);
    assert.match(pre.prompt, /PROJ-11/);
    assert.match(pre.prompt, /## Dépôts concernés/);
    // Supprimer une spec retire ses versions.
    assert.equal((await app.api('DELETE', `/api/jira/spec/${badges['PROJ-12'].id}`)).status, 200);
    assert.equal((await app.api('GET', '/api/jira/spec/PROJ-12')).body.spec, null);
    await attendreServeur(async () => (await app.api('GET', '/api/jira/specs?keys=PROJ-12')).body.specs['PROJ-12'] == null, 'spec supprimée');
  });
});
