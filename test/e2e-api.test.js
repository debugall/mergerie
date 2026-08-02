'use strict';
/* Parcours de bout en bout de l'API : configuration, dépôts, découverte des MR,
   règles de review, contexte de ticket, Jira, commentaires GitLab, statistiques.
   Tout passe par HTTP sur le vrai serveur, avec le vrai schéma SQLite — seuls
   GitLab, Jira et l'agent IA sont remplacés par des doubles locaux. */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { startApp } = require('./helpers/app');

const PNG = 'data:image/png;base64,aGVsbG8td29ybGQ=';

describe('API de bout en bout', () => {
  let app;
  let repoId;
  let mrId;

  before(async () => {
    app = await startApp();
    // Un projet accessible côté GitLab, avec une MR ouverte et une MR filtrée.
    app.state.projects = [
      { id: 1, path_with_namespace: 'grp/app', name_with_namespace: 'Grp / App', http_url_to_repo: 'https://gitlab.test/grp/app.git', ssh_url_to_repo: 'git@gitlab.test:grp/app.git' },
      { id: 2, path_with_namespace: 'grp/lib', name_with_namespace: 'Grp / Lib', http_url_to_repo: 'https://gitlab.test/grp/lib.git', ssh_url_to_repo: 'git@gitlab.test:grp/lib.git' },
    ];
    app.state.mrs['grp/app'] = [
      {
        iid: 7, title: 'Ajout du calcul [PROJ-21977]', state: 'opened',
        source_branch: 'feature/PROJ-21977-calcul', target_branch: 'main',
        web_url: 'https://gitlab.test/grp/app/-/merge_requests/7',
        sha: 'sha7', created_at: new Date().toISOString(), author: { name: 'Alice' },
        diff_refs: { base_sha: 'b1', start_sha: 's1', head_sha: 'h1' },
      },
      {
        iid: 8, title: 'Chore divers', state: 'opened',
        source_branch: 'chore/menage', target_branch: 'main',
        web_url: 'https://gitlab.test/grp/app/-/merge_requests/8',
        sha: 'sha8', created_at: new Date().toISOString(), author: { name: 'Bob' },
      },
    ];
    app.state.changes['grp/app!7'] = [{ new_path: 'db/migration.sql' }, { new_path: 'src/calc.js' }];
    app.state.branches['grp/app'] = [
      { name: 'main', default: true, protected: true, merged: false, commit: { id: 'sha-main', committed_date: '2026-01-01T00:00:00Z', author_name: 'Alice' } },
      { name: 'feature/PROJ-21977-calcul', default: false, protected: false, merged: false, commit: { id: 'sha7', committed_date: '2026-02-01T00:00:00Z', author_name: 'Alice' } },
    ];
  });

  after(async () => { await app.stop(); });

  /* ---------- Statut & configuration ---------- */

  test('GET /api/status expose le mode dry-run et l’état des jobs', async () => {
    const { status, body } = await app.api('GET', '/api/status');
    assert.equal(status, 200);
    assert.equal(body.dryRun, true, 'les tests ne doivent jamais appeler le vrai copilot');
    assert.equal(body.running, false);
    assert.equal(body.jiraConfigured, false);
    assert.equal(typeof body.copilotCmdPreview, 'string');
  });

  test('POST /api/ai-sessions/test valide la reprise de session (simulée en dry-run)', async () => {
    const { status, body } = await app.api('POST', '/api/ai-sessions/test');
    assert.equal(status, 200);
    assert.equal(body.dryRun, true, 'en dry-run, le résultat est simulé (pas d’appel agent réel)');
    assert.ok(body.marker, 'un marqueur secret est généré');
    assert.equal(body.recalled, true, 'la reprise restitue le marqueur');
    assert.ok(String(body.output2).includes(body.marker), 'la 2e passe contient le marqueur mémorisé');
    assert.ok(Array.isArray(body.logs), 'les logs de progression sont renvoyés');
  });

  test('Docker : les endpoints répondent proprement (démon dispo OU non — jamais un crash)', async () => {
    // Robuste que le démon soit joignable ou éteint : on vérifie la FORME, pas la présence
    // de containers. Le point de vigilance = un démon injoignable devient une erreur portée.
    const st = await app.api('GET', '/api/docker/status');
    assert.equal(st.status, 200);
    assert.equal(typeof st.body.ok, 'boolean');
    if (!st.body.ok) assert.ok(st.body.error, 'démon injoignable → message actionnable');

    const comp = await app.api('GET', '/api/docker/compose');
    assert.equal(comp.status, 200);
    assert.ok(Array.isArray(comp.body.projects), 'toujours un tableau de projets (vide si démon absent)');

    const orph = await app.api('GET', '/api/docker/orphans');
    assert.equal(orph.status, 200);
    assert.ok(Array.isArray(orph.body.orphans), 'toujours un tableau de containers hors-compose');

    // Garde-fous d'action : action inconnue / répertoire manquant → 400 explicite.
    assert.equal((await app.api('POST', '/api/docker/compose/action', { dir: '/x', action: 'nope' })).status, 400);
    assert.equal((await app.api('POST', '/api/docker/compose/action', { action: 'up' })).status, 400);
    // « build » est une action valide (au moins la validation passe — dir manquant sinon).
    assert.equal((await app.api('POST', '/api/docker/compose/action', { action: 'build' })).status, 400, 'build sans dir → 400 (dir requis), pas action inconnue');

    // Affichage progressif : la liste légère et le détail répondent toujours par une forme stable.
    const clist = await app.api('GET', '/api/docker/compose/list');
    assert.equal(clist.status, 200);
    assert.ok(Array.isArray(clist.body.files), 'liste = tableau de fichiers compose (vide si démon absent)');
    // dir inconnu : soit 200 { error/project:null } (démon absent), soit 400 « fichier inconnu »
    // (démon présent → la validation refuse un dossier non déclaré). Jamais un crash.
    const cone = await app.api('GET', '/api/docker/compose/one?dir=%2Fnope&file=compose.yaml');
    assert.ok([200, 400].includes(cone.status), 'détail : réponse maîtrisée, pas de 500');

    // Onglet Logs : la liste des containers répond toujours par un tableau (vide si démon absent).
    const cont = await app.api('GET', '/api/docker/containers');
    assert.equal(cont.status, 200);
    assert.ok(Array.isArray(cont.body.containers), 'toujours un tableau de containers');

    // Le flux SSE refuse une demande sans container (400) au lieu d'ouvrir un flux vide.
    assert.equal((await app.api('GET', '/api/docker/logs/stream')).status, 400);
    assert.equal((await app.api('GET', '/api/docker/logs/stream?ids=')).status, 400);

    // Action groupée : garde-fous — action inconnue et sélection vide → 400 explicites.
    assert.equal((await app.api('POST', '/api/docker/bulk-action', { action: 'nope', targets: [{ dir: '/x', service: 'a' }] })).status, 400);
    assert.equal((await app.api('POST', '/api/docker/bulk-action', { action: 'recreate', targets: [] })).status, 400);
    assert.equal((await app.api('POST', '/api/docker/bulk-action', { action: 'recreate' })).status, 400);
  });

  test('PUT /api/config enregistre la configuration et masque les secrets', async () => {
    const { status, body } = await app.configure();
    assert.equal(status, 200);
    assert.equal(body.access_token, '***', 'le jeton ne doit jamais ressortir en clair');
    assert.equal(body.gitlab_url, app.gitlabUrl);

    const relu = await app.api('GET', '/api/config');
    assert.equal(relu.body.access_token, '***');
  });

  test('PUT /api/config ignore le masque et ne réécrit pas le vrai jeton', async () => {
    await app.api('PUT', '/api/config', { access_token: '***', jira_token: '***' });
    // Le jeton réel est toujours en base : un appel GitLab authentifié passe encore.
    const projets = await app.api('GET', '/api/gitlab/projects');
    assert.equal(projets.status, 200);
  });

  test('PUT /api/config normalise langue et intervalle de rafraîchissement', async () => {
    const bad = await app.api('PUT', '/api/config', { language: 'kl', auto_refresh_minutes: -5 });
    assert.equal(bad.body.language, 'fr', 'une langue inconnue retombe sur le français');
    assert.equal(bad.body.auto_refresh_minutes, 0, '0 = rafraîchissement automatique désactivé');

    const en = await app.api('PUT', '/api/config', { language: 'en' });
    assert.equal(en.body.language, 'en');
    // Les messages d'erreur du serveur suivent la langue choisie.
    const err = await app.api('POST', '/api/repos', {});
    assert.equal(err.status, 400);
    assert.match(err.body.error, /URL/i);
    await app.api('PUT', '/api/config', { language: 'fr' });
  });

  /* ---------- Dépôts ---------- */

  test('GET /api/gitlab/projects marque les dépôts déjà ajoutés', async () => {
    const { body } = await app.api('GET', '/api/gitlab/projects');
    assert.equal(body.length, 2);
    assert.equal(body[0].project, 'grp/app');
    assert.equal(body[0].already, false);
  });

  test('POST /api/repos déduit le chemin du projet depuis l’URL', async () => {
    const { status, body } = await app.api('POST', '/api/repos', { url: 'https://gitlab.test/grp/app.git', branch_pattern: '' });
    assert.equal(status, 200);
    assert.equal(body.project, 'grp/app');
    assert.equal(body.enabled, 1);
    repoId = body.id;

    const sansUrl = await app.api('POST', '/api/repos', { branch_pattern: 'PROJ-' });
    assert.equal(sansUrl.status, 400);
  });

  test('POST /api/repos/bulk ajoute en masse et ignore les doublons', async () => {
    const { body } = await app.api('POST', '/api/repos/bulk', {
      projects: [{ project: 'grp/app', url: 'https://gitlab.test/grp/app.git' }, { project: 'grp/lib', url: 'https://gitlab.test/grp/lib.git' }],
      branch_pattern: '',
    });
    assert.deepEqual(body, { added: 1, skipped: 1 });

    const vide = await app.api('POST', '/api/repos/bulk', { projects: [] });
    assert.equal(vide.status, 400);
  });

  test('PUT /api/repos/:id modifie, DELETE supprime', async () => {
    const modif = await app.api('PUT', `/api/repos/${repoId}`, { branch_pattern: 'PROJ-', enabled: 0 });
    assert.equal(modif.body.branch_pattern, 'PROJ-');
    assert.equal(modif.body.enabled, 0);
    await app.api('PUT', `/api/repos/${repoId}`, { branch_pattern: '', enabled: 1 });

    assert.equal((await app.api('PUT', '/api/repos/99999', {})).status, 400);

    const liste = await app.api('GET', '/api/repos');
    const lib = liste.body.find((r) => r.project === 'grp/lib');
    assert.equal((await app.api('DELETE', `/api/repos/${lib.id}`)).status, 200);
    assert.equal((await app.api('GET', '/api/repos')).body.length, 1);
  });

  test('GET /api/gitlab/branches liste les branches et la branche par défaut', async () => {
    const { body } = await app.api('GET', `/api/gitlab/branches?repo_id=${repoId}`);
    assert.equal(body.default, 'main');
    assert.ok(body.branches.includes('feature/PROJ-21977-calcul'));
    assert.equal((await app.api('GET', '/api/gitlab/branches?repo_id=99999')).status, 400);
  });

  /* ---------- Règles de review ---------- */

  test('CRUD des règles de review, avec validation du déclencheur', async () => {
    const sansDeclencheur = await app.api('POST', '/api/rules', { content: 'vérifie tout' });
    assert.equal(sansDeclencheur.status, 400, 'une règle sans branche ni chemin est refusée');

    const regle = await app.api('POST', '/api/rules', {
      path_match: '*.sql', label: 'SQL', content: 'Vérifie la réversibilité des migrations.',
    });
    assert.equal(regle.status, 200);
    const id = regle.body.id;

    const maj = await app.api('PUT', `/api/rules/${id}`, { label: 'Migration SQL', enabled: 1 });
    assert.equal(maj.body.label, 'Migration SQL');
    assert.equal((await app.api('PUT', '/api/rules/99999', {})).status, 400);

    const branche = await app.api('POST', '/api/rules', { branch_match: 'PROJ-', content: 'Cite le ticket.' });
    assert.equal(branche.status, 200);

    const liste = await app.api('GET', '/api/rules');
    assert.equal(liste.body.length, 2);
    await app.api('DELETE', `/api/rules/${branche.body.id}`);
    assert.equal((await app.api('GET', '/api/rules')).body.length, 1);
  });

  /* ---------- Découverte des MR ---------- */

  test('POST /api/discover crée les MR ouvertes et applique le filtre de branche', async () => {
    const { body } = await app.api('POST', '/api/discover');
    assert.equal(body.found, 2);
    assert.equal(body.created, 2);
    assert.deepEqual(body.errors, []);

    const relance = await app.api('POST', '/api/discover');
    assert.equal(relance.body.created, 0, 'une 2e découverte ne duplique rien');
    assert.equal(relance.body.updated, 2);

    /* En mode démo, la forge n'existe pas : la découverte ne doit PAS partir sur le réseau
       ni rendre une erreur par dépôt — elle rend simplement ce qui est déjà connu. */
    process.env.MERGERIE_DEMO = '1';
    try {
      const demo = await app.api('POST', '/api/discover');
      assert.deepEqual(demo.body.errors, [], 'aucune erreur de token en démo');
      assert.equal(demo.body.created, 0);
      assert.equal(demo.body.updated, 0);
      assert.equal(demo.body.found, 2, 'la démo rend les MR déjà présentes');
    } finally {
      delete process.env.MERGERIE_DEMO;
    }

    // Avec un filtre de branche, seule la MR correspondante est vue comme ouverte.
    await app.api('PUT', `/api/repos/${repoId}`, { branch_pattern: 'PROJ-' });
    const filtree = await app.api('POST', '/api/discover');
    assert.equal(filtree.body.found, 1);
    await app.api('PUT', `/api/repos/${repoId}`, { branch_pattern: '' });
    await app.api('POST', '/api/discover');
  });

  test('un dépôt dont la récupération des MR est coupée est ignoré, sans perdre les MR déjà là', async () => {
    await app.api('POST', '/api/discover');
    const avant = (await app.api('GET', '/api/mrs')).body.length;
    assert.ok(avant > 0, 'il faut des MR déjà récupérées pour que le test ait un sens');

    const off = await app.api('PUT', `/api/repos/${repoId}`, { fetch_mrs: false });
    assert.equal(off.body.fetch_mrs, 0);

    const scan = await app.api('POST', '/api/discover');
    assert.equal(scan.body.repos, 0, 'le dépôt n’est plus interrogé du tout');
    assert.equal(scan.body.found, 0);

    /* Le point important : couper la récupération ne PURGE pas. Les merge requests déjà
       dans la file — et leurs rapports — doivent survivre, sinon décocher devient destructif. */
    assert.equal((await app.api('GET', '/api/mrs')).body.length, avant);

    // Et le dépôt reste actif par ailleurs : `enabled` n'a pas bougé.
    assert.equal(off.body.enabled, 1);

    const on = await app.api('PUT', `/api/repos/${repoId}`, { fetch_mrs: true });
    assert.equal(on.body.fetch_mrs, 1);
    assert.equal((await app.api('POST', '/api/discover')).body.repos, 1);
  });

  test('les autres modifications d’un dépôt ne remettent pas la récupération à zéro', async () => {
    await app.api('PUT', `/api/repos/${repoId}`, { fetch_mrs: false });
    // Un PUT qui ne parle pas de fetch_mrs (renommage, pattern…) doit le laisser tel quel.
    const apres = await app.api('PUT', `/api/repos/${repoId}`, { branch_pattern: 'PROJ-' });
    assert.equal(apres.body.fetch_mrs, 0, 'un champ absent du corps reste inchangé');
    await app.api('PUT', `/api/repos/${repoId}`, { fetch_mrs: true, branch_pattern: '' });
    await app.api('POST', '/api/discover');
  });

  test('GET /api/mrs enrichit chaque MR (ticket, risque, statut)', async () => {
    const { body } = await app.api('GET', '/api/mrs');
    assert.equal(body.length, 2);
    const mr = body.find((m) => m.iid === 7);
    mrId = mr.id;
    assert.equal(mr.project, 'grp/app');
    assert.equal(mr.status, 'to_review');
    assert.equal(mr.has_review, false);
    assert.equal(mr.ticket_key, 'PROJ-21977', 'la clé est extraite du titre entre crochets');
    assert.deepEqual(mr.risk.map((r) => r.label), ['Migration SQL'], 'db/migration.sql déclenche la règle *.sql');

    const filtre = await app.api('GET', '/api/mrs?status=to_review');
    assert.equal(filtre.body.length, 2);
    const autre = body.find((m) => m.iid === 8);
    assert.equal(autre.ticket_key, null, 'pas de ticket déductible pour chore/menage');
  });

  test('GET /api/mrs/:id renvoie le détail, 400 si inconnue', async () => {
    const { body } = await app.api('GET', `/api/mrs/${mrId}`);
    assert.equal(body.mr.iid, 7);
    assert.equal(body.review, null);
    assert.deepEqual(body.comments, []);
    assert.equal(body.ticket.jira_key, 'PROJ-21977');
    assert.equal(body.ticket.jira_configured, false);
    assert.equal((await app.api('GET', '/api/mrs/99999')).status, 400);
  });

  test('GET /api/notifications rejoue les événements après un curseur', async () => {
    const tout = await app.api('GET', '/api/notifications');
    assert.ok(tout.body.events.length >= 2, 'chaque MR découverte émet un événement');
    assert.ok(tout.body.events.some((e) => e.type === 'mr_new'));
    const apres = await app.api('GET', `/api/notifications?after=${tout.body.latest}`);
    assert.deepEqual(apres.body.events, [], 'rien de neuf après le dernier id vu');
  });

  /* ---------- Contexte de ticket ---------- */

  test('Contexte de ticket : texte, capture, puis suppression de la capture', async () => {
    const ok = await app.api('POST', `/api/mrs/${mrId}/ticket`, { text: '  Spécification métier  ', image: PNG });
    assert.deepEqual(ok.body, { ok: true, has_text: true, has_image: true });

    const detail = await app.api('GET', `/api/mrs/${mrId}`);
    assert.equal(detail.body.ticket.text, 'Spécification métier');
    assert.equal(detail.body.ticket.has_image, true);

    const image = await app.api('GET', `/api/mrs/${mrId}/ticket-image`);
    assert.equal(image.status, 200);

    const sansImage = await app.api('POST', `/api/mrs/${mrId}/ticket`, { text: 'x', removeImage: true });
    assert.equal(sansImage.body.has_image, false);
    assert.equal((await app.api('GET', `/api/mrs/${mrId}/ticket-image`)).status, 404);

    const mauvaise = await app.api('POST', `/api/mrs/${mrId}/ticket`, { image: 'pas-une-data-url' });
    assert.equal(mauvaise.status, 400);
  });

  /* ---------- Jira ---------- */

  test('Jira : test de connexion, récupération et enrichissement d’une MR', async () => {
    app.state.jiraIssues['PROJ-21977'] = {
      key: 'PROJ-21977',
      fields: {
        summary: 'Calculer le total',
        description: {
          type: 'doc',
          content: [
            { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Besoin' }] },
            { type: 'paragraph', content: [{ type: 'text', text: 'Total ', marks: [{ type: 'strong' }] }, { type: 'text', text: 'TTC' }] },
          ],
        },
      },
    };

    const nonConfig = await app.api('POST', '/api/jira/test', { key: 'PROJ-21977' });
    assert.equal(nonConfig.status, 400, 'sans identifiants Jira, on refuse tout de suite');

    await app.configure({ jira_url: app.gitlabUrl, jira_email: 'a@b.c', jira_token: 'jt' });
    assert.equal((await app.api('GET', '/api/status')).body.jiraConfigured, true);

    const sansCle = await app.api('POST', '/api/jira/test', {});
    assert.equal(sansCle.status, 400);

    const test = await app.api('POST', '/api/jira/test', { key: 'PROJ-21977' });
    assert.deepEqual(test.body, { ok: true, key: 'PROJ-21977', summary: 'Calculer le total' });

    const inconnu = await app.api('POST', '/api/jira/test', { key: 'PROJ-0' });
    assert.equal(inconnu.status, 400);
    assert.match(inconnu.body.error, /404/);

    const fetch = await app.api('POST', '/api/jira/fetch', { key: 'proj-21977' });
    assert.equal(fetch.body.key, 'PROJ-21977');
    assert.match(fetch.body.context, /^# Calculer le total/);
    assert.match(fetch.body.context, /## Besoin/);
    assert.match(fetch.body.context, /\*\*Total \*\*TTC/);

    const refresh = await app.api('POST', `/api/mrs/${mrId}/jira-refresh`);
    assert.equal(refresh.body.ok, true);
    const detail = await app.api('GET', `/api/mrs/${mrId}`);
    assert.match(detail.body.ticket.jira_text, /Calculer le total/);
  });

  test('Jira (onglet) : liste des tickets affectés + détail avec métadonnées et commentaires', async () => {
    await app.configure({ jira_url: app.gitlabUrl, jira_email: 'a@b.c', jira_token: 'jt' });
    app.state.jiraIssues['PROJ-500'] = {
      key: 'PROJ-500',
      comments: [{ author: { displayName: 'PO' }, created: '2026-07-20T10:00:00.000+0000', body: { type: 'doc', content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Premier commentaire.' }] },
        { type: 'mediaSingle', content: [{ type: 'media', attrs: { id: 'm-1', type: 'file', alt: 'capture.png' } }] },
      ] } }],
      fields: {
        summary: 'Ticket affecté', status: { name: 'En cours', statusCategory: { key: 'indeterminate' } },
        priority: { name: 'Haute' }, issuetype: { name: 'Bug' },
        assignee: { displayName: 'Moi' }, reporter: { displayName: 'PO' }, labels: ['urgent'],
        description: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Le contenu du ticket.' }] }] },
        attachment: [{ id: '7001', filename: 'capture.png', size: 2048, mimeType: 'image/png', created: '2026-07-20T09:00:00.000+0000', author: { displayName: 'PO' } }],
      },
    };

    // Filtre par assigné : « moi » + les personnes ayant des tickets.
    const asg = await app.api('GET', '/api/jira/assignees');
    assert.equal(asg.status, 200);
    assert.equal(asg.body.configured, true);
    assert.equal(asg.body.me.name, 'Testeur courant');
    assert.ok(asg.body.people.length >= 1, 'au moins une personne candidate');

    // Tickets (par défaut = mes tickets) : la liste renvoie le ticket avec ses métadonnées.
    const tickets = await app.api('GET', '/api/jira/tickets');
    assert.equal(tickets.status, 200);
    assert.equal(tickets.body.configured, true);
    const it = tickets.body.issues.find((i) => i.key === 'PROJ-500');
    assert.ok(it, 'le ticket est listé');
    assert.equal(it.status, 'En cours');
    assert.equal(it.statusCategory, 'indeterminate');
    assert.equal(it.priority, 'Haute');
    assert.equal(it.assignee.name, 'Moi');

    const dd = await app.api('GET', '/api/jira/issue/PROJ-500');
    assert.equal(dd.status, 200);
    assert.match(dd.body.issue.descriptionMd, /Le contenu du ticket/);
    assert.equal(dd.body.issue.comments.length, 1);
    assert.equal(dd.body.issue.comments[0].author, 'PO');
    assert.match(dd.body.issue.comments[0].bodyMd, /Premier commentaire/);
    // Image EMBARQUÉE dans un commentaire → résolue vers le proxy (affichage inline).
    assert.match(dd.body.issue.comments[0].bodyMd, /!\[capture\.png\]\(\/api\/jira\/attachment\/7001\)/);
    // Changement d'état : les transitions possibles sont dans le détail, et on peut en appliquer une.
    assert.ok(dd.body.issue.transitions.some((tr) => tr.name === 'Terminé'), 'transition disponible');
    const trOk = await app.api('POST', '/api/jira/issue/PROJ-500/transition', { transitionId: '31' });
    assert.equal(trOk.status, 200);
    assert.equal(trOk.body.ok, true);
    assert.equal((await app.api('POST', '/api/jira/issue/PROJ-500/transition', { transitionId: 'pas-num' })).status, 400, 'transition non numérique refusée');
    // Poster un commentaire : renvoie le commentaire créé (auteur + corps convertis).
    const cAdd = await app.api('POST', '/api/jira/issue/PROJ-500/comment', { text: 'Mon retour\nsur deux lignes' });
    assert.equal(cAdd.status, 200);
    assert.equal(cAdd.body.comment.author, 'Testeur');
    assert.match(cAdd.body.comment.bodyMd, /Nouveau commentaire/);
    assert.equal((await app.api('POST', '/api/jira/issue/PROJ-500/comment', { text: '   ' })).status, 400, 'commentaire vide refusé');
    // Pièces jointes : métadonnées dans le détail, contenu via le proxy (auth côté serveur).
    assert.equal(dd.body.issue.attachments.length, 1);
    assert.equal(dd.body.issue.attachments[0].filename, 'capture.png');
    const dl = await app.api('GET', '/api/jira/attachment/7001');
    assert.equal(dl.status, 200);
    assert.match(dl.text, /contenu-7001/, 'le contenu binaire est bien proxifié');
    // Sécurité : un type non-raster (ici text/plain) n'est JAMAIS servi inline, + en-têtes durcis.
    assert.match(dl.headers.get('content-disposition') || '', /^attachment; filename=/);
    assert.equal(dl.headers.get('x-content-type-options'), 'nosniff');
    assert.match(dl.headers.get('content-security-policy') || '', /sandbox/);
    assert.equal((await app.api('GET', '/api/jira/attachment/pas-un-id')).status, 400, 'id non numérique refusé');
    delete app.state.jiraIssues['PROJ-500'];
  });

  test('Jira : surveiller un ticket notifie son changement d’état, et seulement lui', async () => {
    await app.configure({ jira_url: app.gitlabUrl, jira_email: 'a@b.c', jira_token: 'jt' });
    const etat = (nom, cat) => ({ name: nom, statusCategory: { key: cat } });
    app.state.jiraIssues['WATCH-1'] = { key: 'WATCH-1', fields: { summary: 'Ticket suivi', status: etat('À faire', 'new') } };
    app.state.jiraIssues['WATCH-2'] = { key: 'WATCH-2', fields: { summary: 'Ticket témoin', status: etat('À faire', 'new') } };

    assert.equal((await app.api('POST', '/api/jira/watch', { key: 'pas une clé' })).status, 400, 'clé invalide refusée');

    // L'ajout mémorise l'état COURANT : c'est ce qui évite une fausse notification au 1er passage.
    const add = await app.api('POST', '/api/jira/watch', { key: 'watch-1' });
    assert.equal(add.status, 200);
    assert.equal(add.body.key, 'WATCH-1', 'la clé est normalisée en majuscules');
    assert.equal(add.body.status, 'À faire');
    assert.equal((await app.api('POST', '/api/jira/watch', { key: 'WATCH-1' })).status, 400, 'doublon refusé');
    await app.api('POST', '/api/jira/watch', { key: 'WATCH-2' });

    const vu = (await app.api('GET', '/api/notifications')).body.latest;
    const rien = await app.api('POST', '/api/jira/watch/check');
    assert.equal(rien.body.changed, 0, 'aucun changement tant que Jira ne bouge pas');
    assert.deepEqual((await app.api('GET', `/api/notifications?after=${vu}`)).body.events.filter((e) => e.type === 'jira_status'), [],
      'une vérification sans changement ne notifie rien');

    // Jira bouge sur UN seul des deux tickets.
    app.state.jiraIssues['WATCH-1'].fields.status = etat('En cours', 'indeterminate');
    const bouge = await app.api('POST', '/api/jira/watch/check');
    assert.equal(bouge.body.changed, 1);

    const evts = (await app.api('GET', `/api/notifications?after=${vu}`)).body.events.filter((e) => e.type === 'jira_status');
    assert.equal(evts.length, 1, 'un seul ticket a bougé, une seule notification');
    assert.equal(evts[0].key, 'WATCH-1');
    assert.equal(evts[0].from, 'À faire');
    assert.equal(evts[0].to, 'En cours');

    // Le nouvel état devient la référence : re-vérifier ne renotifie pas le même changement.
    assert.equal((await app.api('POST', '/api/jira/watch/check')).body.changed, 0);
    const liste = await app.api('GET', '/api/jira/watch');
    const suivi = liste.body.watched.find((w) => w.key === 'WATCH-1');
    assert.equal(suivi.status, 'En cours');
    assert.ok(suivi.changed_at, 'la date du changement est mémorisée');

    // Compteur du menu : les tickets en cours qui me sont affectés.
    await app.api('POST', '/api/jira/watch/check');
    const badge = await app.api('GET', '/api/jira/badge');
    assert.equal(badge.status, 200);
    assert.equal(badge.body.configured, true);

    // Un ticket disparu de Jira est signalé sur sa ligne, sans faire échouer les autres.
    delete app.state.jiraIssues['WATCH-2'];
    const perdu = await app.api('POST', '/api/jira/watch/check');
    assert.equal(perdu.body.errors, 1);
    assert.ok((await app.api('GET', '/api/jira/watch')).body.watched.find((w) => w.key === 'WATCH-2').error);

    /* Deux vérifications SIMULTANÉES ne doivent notifier qu'une fois : sans sérialisation, les
       deux liraient le même ancien état et annonceraient deux fois le même changement. */
    app.state.jiraIssues['WATCH-1'].fields.status = etat('Terminé', 'done');
    const avant = (await app.api('GET', '/api/notifications')).body.latest;
    const [a, b] = await Promise.all([
      app.api('POST', '/api/jira/watch/check'),
      app.api('POST', '/api/jira/watch/check'),
    ]);
    /* On n'affirme PAS que les deux appels se recouvrent : selon le temps d'aller-retour HTTP, le
       second peut démarrer après la fin du premier. L'invariant qui compte ne dépend pas de ça. */
    assert.ok(a.body.changed + b.body.changed >= 1, 'le changement est bien constaté');
    const doubles = (await app.api('GET', `/api/notifications?after=${avant}`)).body.events
      .filter((e) => e.type === 'jira_status' && e.key === 'WATCH-1');
    assert.equal(doubles.length, 1, 'un changement ne produit qu’UNE notification, même vérifié deux fois');

    await app.api('DELETE', '/api/jira/watch/WATCH-1');
    await app.api('DELETE', '/api/jira/watch/WATCH-2');
    assert.deepEqual((await app.api('GET', '/api/jira/watch')).body.watched, []);
    delete app.state.jiraIssues['WATCH-1'];
  });

  test('Jira : sans assigné coché, on prend TOUT — y compris ce qui ne m’est pas affecté', async () => {
    await app.configure({ jira_url: app.gitlabUrl, jira_email: 'a@b.c', jira_token: 'jt' });
    const tk = (key, accountId) => ({
      key,
      fields: {
        summary: key, status: { name: 'À faire', statusCategory: { key: 'new' } },
        ...(accountId ? { assignee: { accountId, displayName: accountId } } : {}),
      },
    });
    app.state.jiraIssues['ASG-1'] = tk('ASG-1', 'me-test');    // à moi
    app.state.jiraIssues['ASG-2'] = tk('ASG-2', 'autre-001');  // à quelqu'un d'autre
    app.state.jiraIssues['ASG-3'] = tk('ASG-3', null);         // à personne

    const cles = (b) => b.issues.map((i) => i.key).filter((k) => k.startsWith('ASG-')).sort();

    // Une sélection explicite reste une sélection.
    const moi = await app.api('GET', '/api/jira/tickets?assignees=me-test');
    assert.deepEqual(cles(moi.body), ['ASG-1']);

    /* Vide = aucune contrainte d'assigné. Avant, le serveur retombait sur `currentUser()` :
       décocher tout le monde ramenait ses propres tickets, soit l'inverse de la demande. */
    const tout = await app.api('GET', '/api/jira/tickets?assignees=');
    assert.deepEqual(cles(tout.body), ['ASG-1', 'ASG-2', 'ASG-3'],
      'le non-assigné et celui d’autrui doivent remonter');

    /* Personne de coché ET les terminés inclus : sans contrainte, la JQL se réduirait à un
       ORDER BY, que Jira Cloud refuse en 400 (« unbounded »). On vérifie donc qu'une clause
       est bien présente — c'est la requête envoyée qui compte, pas la réponse du faux Jira. */
    app.state.calls.length = 0;
    await app.api('GET', '/api/jira/tickets?assignees=&includeDone=1');
    const rech = app.state.calls.filter((c) => c.path.includes('/search')).pop();
    const jql = decodeURIComponent(new URL(`http://x${rech.path}`).searchParams.get('jql'));
    assert.ok(!/^\s*ORDER BY/i.test(jql), `JQL sans contrainte : ${jql}`);
    assert.match(jql, /updated >= -365d/);

    for (const k of ['ASG-1', 'ASG-2', 'ASG-3']) delete app.state.jiraIssues[k];
  });

  test('Jira : le filtre par projet est appliqué PAR Jira, pas après coup', async () => {
    await app.configure({ jira_url: app.gitlabUrl, jira_email: 'a@b.c', jira_token: 'jt' });
    const tk = (key, projet) => ({
      key,
      fields: {
        summary: key, status: { name: 'À faire', statusCategory: { key: 'new' } },
        project: { key: projet, name: `Projet ${projet}` },
      },
    });
    app.state.jiraIssues['AAA-1'] = tk('AAA-1', 'AAA');
    app.state.jiraIssues['BBB-1'] = tk('BBB-1', 'BBB');

    const cles = (b) => b.issues.map((i) => i.key).filter((k) => /^(AAA|BBB)-/.test(k)).sort();
    assert.deepEqual(cles((await app.api('GET', '/api/jira/tickets?assignees=')).body), ['AAA-1', 'BBB-1']);

    /* Le nerf du problème : le résultat Jira est plafonné et trié par date de mise à jour.
       Filtrer côté navigateur ne filtrerait qu'un extrait — les tickets du projet voulu
       pouvant se trouver hors de cet extrait, ils disparaissaient de la liste. */
    const filtre = await app.api('GET', '/api/jira/tickets?assignees=&projects=AAA');
    assert.deepEqual(cles(filtre.body), ['AAA-1']);

    app.state.calls.length = 0;
    await app.api('GET', '/api/jira/tickets?assignees=&projects=AAA');
    const rech = app.state.calls.filter((c) => c.path.includes('/search')).pop();
    const jql = decodeURIComponent(new URL(`http://x${rech.path}`).searchParams.get('jql'));
    assert.match(jql, /project IN \("AAA"\)/, `la contrainte doit être dans la JQL : ${jql}`);

    // Une clé qui n'en est pas une n'atteint jamais la requête.
    app.state.calls.length = 0;
    await app.api('GET', '/api/jira/tickets?assignees=&projects=AAA%22%20OR%20x');
    const rech2 = app.state.calls.filter((c) => c.path.includes('/search')).pop();
    const jql2 = decodeURIComponent(new URL(`http://x${rech2.path}`).searchParams.get('jql'));
    assert.ok(!/ OR x/.test(jql2), `injection dans la JQL : ${jql2}`);

    for (const k of ['AAA-1', 'BBB-1']) delete app.state.jiraIssues[k];
  });

  test('Jira : un refus de Jira remonte SON message, pas seulement le code', async () => {
    await app.configure({ jira_url: app.gitlabUrl, jira_email: 'a@b.c', jira_token: 'jt' });
    // Le faux Jira renvoie un 400 avec le corps que renvoie le vrai.
    app.state.jiraFail = { status: 400, body: { errorMessages: ['The JQL query is unbounded.'] } };
    const r = await app.api('GET', '/api/jira/tickets?assignees=');
    assert.equal(r.status, 400);
    assert.match(r.body.error, /The JQL query is unbounded/,
      'sans le corps, l’utilisateur ne lit que « Jira 400 Bad Request » et ne peut rien en faire');
    delete app.state.jiraFail;
  });

  test('Jira : l’epic d’un ticket est exposé, et un parent qui n’en est pas un ne l’est pas', async () => {
    await app.configure({ jira_url: app.gitlabUrl, jira_email: 'a@b.c', jira_token: 'jt' });
    const parent = (key, type, niveau) => ({
      key, fields: { summary: `Parent ${key}`, issuetype: { name: type, ...(niveau == null ? {} : { hierarchyLevel: niveau }) } },
    });
    app.state.jiraIssues['EPIC-1'] = {
      key: 'EPIC-1',
      fields: { summary: 'Rattaché à un epic', status: { name: 'À faire', statusCategory: { key: 'new' } }, parent: parent('EPIC-100', 'Epic', 1) },
    };
    /* Une SOUS-TÂCHE a elle aussi un `parent` — une story. L'annoncer comme epic serait un
       contresens : c'est le piège de ce champ, et la raison du filtre par niveau. */
    app.state.jiraIssues['EPIC-2'] = {
      key: 'EPIC-2',
      fields: { summary: 'Sous-tâche d’une story', status: { name: 'À faire', statusCategory: { key: 'new' } }, parent: parent('STORY-9', 'Story', 0) },
    };
    app.state.jiraIssues['EPIC-3'] = {
      key: 'EPIC-3',
      fields: { summary: 'Sans parent', status: { name: 'À faire', statusCategory: { key: 'new' } } },
    };

    const list = (await app.api('GET', '/api/jira/tickets')).body.issues;
    const par = (k) => list.find((i) => i.key === k);
    assert.deepEqual(par('EPIC-1').epic,
      { key: 'EPIC-100', summary: 'Parent EPIC-100', color: '', url: `${app.gitlabUrl}/browse/EPIC-100` },
      'l’epic porte sa propre URL : c’est ce qui le rend cliquable');
    assert.equal(par('EPIC-2').epic, null, 'le parent d’une sous-tâche n’est pas un epic');
    assert.equal(par('EPIC-3').epic, null);

    // Le détail porte la même information que la liste.
    assert.deepEqual((await app.api('GET', '/api/jira/issue/EPIC-1')).body.issue.epic,
      { key: 'EPIC-100', summary: 'Parent EPIC-100', color: '', url: `${app.gitlabUrl}/browse/EPIC-100` });

    // Instance sans `hierarchyLevel` : on retombe sur le nom du type.
    app.state.jiraIssues['EPIC-1'].fields.parent = parent('EPIC-101', 'Épique');
    assert.equal((await app.api('GET', '/api/jira/issue/EPIC-1')).body.issue.epic.key, 'EPIC-101');

    for (const k of ['EPIC-1', 'EPIC-2', 'EPIC-3']) delete app.state.jiraIssues[k];
  });

  test('Jira : passer un ticket « en cours » met le compteur du menu à jour tout de suite', async () => {
    await app.configure({ jira_url: app.gitlabUrl, jira_email: 'a@b.c', jira_token: 'jt' });
    app.state.jiraIssues['COUNT-1'] = {
      key: 'COUNT-1',
      fields: { summary: 'Pas encore commencé', status: { name: 'À faire', statusCategory: { key: 'new' } } },
    };
    const avant = (await app.api('GET', '/api/jira/badge')).body.inProgress;

    // Transition « En cours » (id 21 du faux Jira) : le compteur doit suivre SANS attendre le
    // timer de surveillance ni le sondage du navigateur — c'est tout l'objet de ce test.
    const tr = await app.api('POST', '/api/jira/issue/COUNT-1/transition', { transitionId: '21' });
    assert.equal(tr.status, 200);
    assert.equal((await app.api('GET', '/api/jira/badge')).body.inProgress, avant + 1,
      'le compteur est recalculé pendant la transition, pas au prochain tour de timer');

    // Et il redescend quand le ticket sort de « en cours ».
    await app.api('POST', '/api/jira/issue/COUNT-1/transition', { transitionId: '31' });
    assert.equal((await app.api('GET', '/api/jira/badge')).body.inProgress, avant);
    delete app.state.jiraIssues['COUNT-1'];
  });

  test('Jira : l’échec est mémorisé sur la MR pour être affiché', async () => {
    const autre = (await app.api('GET', '/api/mrs')).body.find((m) => m.iid === 8);
    const sansCle = await app.api('POST', `/api/mrs/${autre.id}/jira-refresh`);
    assert.equal(sansCle.status, 400, 'pas de clé de ticket déductible → erreur explicite');

    delete app.state.jiraIssues['PROJ-21977'];
    const echec = await app.api('POST', `/api/mrs/${mrId}/jira-refresh`);
    assert.equal(echec.status, 400);
    const detail = await app.api('GET', `/api/mrs/${mrId}`);
    assert.match(detail.body.ticket.jira_error, /404/, 'la cause est stockée, pas seulement affichée une fois');
  });

  /* ---------- Projets liés ---------- */

  test('Liens par défaut d’un dépôt et liens d’une MR', async () => {
    const lib = await app.api('POST', '/api/repos', { url: 'https://gitlab.test/grp/lib.git' });
    const libId = lib.body.id;

    const repoLinks = await app.api('POST', `/api/repos/${repoId}/links`, {
      links: [{ repo_id: libId, branch: 'main' }, { repo_id: repoId }, { repo_id: 99999 }],
    });
    assert.equal(repoLinks.body.count, 1, 'auto-lien et dépôt inconnu sont ignorés');

    const mrLinks = await app.api('POST', `/api/mrs/${mrId}/links`, { links: [{ repo_id: libId, branch: '' }] });
    assert.equal(mrLinks.body.count, 1);

    const detail = await app.api('GET', `/api/mrs/${mrId}`);
    assert.equal(detail.body.links[0].project, 'grp/lib');
    assert.equal(detail.body.repo_links[0].project, 'grp/lib');

    assert.equal((await app.api('POST', '/api/mrs/99999/links', { links: [] })).status, 400);
    assert.equal((await app.api('POST', '/api/repos/99999/links', { links: [] })).status, 400);

    await app.api('POST', `/api/mrs/${mrId}/links`, { links: [] });
    await app.api('DELETE', `/api/repos/${libId}`);
  });

  /* ---------- Commentaires GitLab ---------- */

  test('Commentaires : note simple, discussion inline et réponse', async () => {
    const vide = await app.api('POST', `/api/mrs/${mrId}/comment`, { body: '   ' });
    assert.equal(vide.status, 400);

    const note = await app.api('POST', `/api/mrs/${mrId}/comment`, { body: 'Merci !' });
    assert.equal(note.body.ok, true);
    const detail = await app.api('GET', `/api/mrs/${mrId}`);
    assert.equal(detail.body.comments.length, 1, 'le commentaire envoyé est journalisé localement');

    const inline = await app.api('POST', `/api/mrs/${mrId}/discussion`, {
      body: 'Ligne à revoir', new_path: 'src/calc.js', new_line: 12,
    });
    assert.equal(inline.body.ok, true);
    const position = app.state.discussions['grp/app!7'][0].notes[0].position;
    assert.equal(position.new_line, 12);
    assert.equal(position.head_sha, 'h1', 'la position reprend les diff_refs de la MR');

    const sansFichier = await app.api('POST', `/api/mrs/${mrId}/discussion`, { body: 'x' });
    assert.equal(sansFichier.status, 400);

    const discussions = await app.api('GET', `/api/mrs/${mrId}/discussions`);
    assert.equal(discussions.body.discussions.length, 1);
    const discId = discussions.body.discussions[0].id;

    const reponse = await app.api('POST', `/api/mrs/${mrId}/discussions/${discId}/reply`, { body: 'Corrigé' });
    assert.equal(reponse.body.ok, true);
    assert.equal((await app.api('POST', `/api/mrs/${mrId}/discussions/${discId}/reply`, { body: '' })).status, 400);
  });

  /* Modifier un commentaire déjà posté. Le point à protéger n'est pas l'appel — c'est
     `editable` : il décide de l'affichage du bouton, et il ne doit s'allumer que sur MES
     commentaires. Le mock répond « testeur » à GET /user, comme auteur des notes. */
  test('Commentaires : modifier une note, générale comme inline', async () => {
    const { body: avant } = await app.api('GET', `/api/mrs/${mrId}/discussions`);
    const inline = avant.discussions.find((d) => d.notes[0].position);
    const note = inline.notes[0];
    assert.ok(note.id != null, 'l’id de note est exposé — sans lui rien n’est modifiable');
    assert.equal(note.editable, true, 'une note écrite par le compte du jeton est modifiable');

    const maj = await app.api('PUT', `/api/mrs/${mrId}/notes/${note.id}`, { body: 'Ligne revue, finalement OK', inline: true });
    assert.equal(maj.status, 200);
    assert.equal(maj.body.body, 'Ligne revue, finalement OK');

    const { body: apres } = await app.api('GET', `/api/mrs/${mrId}/discussions`);
    const memeNote = apres.discussions.flatMap((d) => d.notes).find((n) => n.id === note.id);
    assert.equal(memeNote.body, 'Ligne revue, finalement OK', 'la modification est bien allée jusqu’à la forge');
    assert.equal(apres.discussions.flatMap((d) => d.notes).length,
      avant.discussions.flatMap((d) => d.notes).length, 'modifier n’ajoute pas une note');

    assert.equal((await app.api('PUT', `/api/mrs/${mrId}/notes/${note.id}`, { body: '   ' })).status, 400,
      'un commentaire vidé n’écrase pas l’original');
    assert.equal((await app.api('PUT', `/api/mrs/${mrId}/notes/999999`, { body: 'x' })).status, 400);
  });

  /* ---------- Cycle de vie d’une MR ---------- */

  test('Statuts : done, reopen, effacement d’erreur', async () => {
    assert.equal((await app.api('POST', `/api/mrs/${mrId}/done`)).body.ok, true);
    let mr = (await app.api('GET', '/api/mrs')).body.find((m) => m.id === mrId);
    assert.equal(mr.status, 'done');

    // Une MR classée « done » ne se re-review pas par accident.
    assert.equal((await app.api('POST', `/api/mrs/${mrId}/rereview`)).status, 400);

    await app.api('POST', `/api/mrs/${mrId}/reopen`);
    mr = (await app.api('GET', '/api/mrs')).body.find((m) => m.id === mrId);
    assert.equal(mr.status, 'to_review', 'sans rapport, une MR rouverte repart en « à reviewer »');

    assert.equal((await app.api('POST', `/api/mrs/${mrId}/clear-error`)).body.ok, true);
    assert.equal((await app.api('POST', '/api/mrs/99999/done')).status, 400);
  });

  test('POST /api/mrs/:id/merge marque la MR mergée et alimente le journal', async () => {
    app.state.mergeRefuses = true;
    const refus = await app.api('POST', `/api/mrs/${mrId}/merge`);
    assert.equal(refus.body.merged, false, 'GitLab peut répondre 200 sans merger : on ne ment pas');

    app.state.mergeRefuses = false;
    const ok = await app.api('POST', `/api/mrs/${mrId}/merge`);
    assert.equal(ok.body.merged, true);
    const footer = await app.api('GET', '/api/footer');
    assert.ok(footer.body.feed.some((f) => f.type === 'mr_merged' && f.mr_iid === 7));
  });

  test('Une MR disparue de GitLab est signalée mergée puis oubliée', async () => {
    app.state.mrs['grp/app'] = app.state.mrs['grp/app'].filter((m) => m.iid !== 8);
    const r = await app.api('POST', '/api/discover');
    assert.equal(r.body.found, 0, 'plus aucune MR ouverte côté GitLab');
    const feed = (await app.api('GET', '/api/footer')).body.feed;
    assert.ok(feed.some((f) => f.type === 'mr_merged' && f.mr_iid === 8));
    // 2e passage : plus aucun nouvel événement pour cette MR.
    const avant = feed.filter((f) => f.mr_iid === 8).length;
    await app.api('POST', '/api/discover');
    const apres = (await app.api('GET', '/api/footer')).body.feed.filter((f) => f.mr_iid === 8).length;
    assert.equal(apres, avant, 'une MR déjà signalée close ne re-déclenche pas d’événement');
  });

  /* ---------- Tableaux de bord ---------- */

  test('GET /api/stats agrège le funnel, les projets et les coûts', async () => {
    const { status, body } = await app.api('GET', '/api/stats');
    assert.equal(status, 200);
    assert.equal(typeof body.funnel.to_review, 'number');
    assert.equal(body.notes.total, 0, 'aucune review pour l’instant');
    assert.ok(Array.isArray(body.projects));
    assert.equal(body.weekly.length, 8);
    assert.equal(body.scoreTrend.length, 8);
    assert.equal(body.tokens.isFloor, true);
    assert.equal(body.commentsPosted, 1);
    assert.equal(body.tasks.total, 0);
  });

  test('GET /api/dashboard/commits renvoie le dernier commit par dépôt actif', async () => {
    const repos = (await app.api('GET', '/api/repos')).body.filter((r) => r.enabled);
    assert.ok(repos.length, 'au moins un dépôt actif');
    // Un dernier commit par projet (le plus récent d'abord côté mock).
    repos.forEach((r, i) => {
      app.state.commits[r.project] = [{
        id: `deadbeef${i}cafebabe`, short_id: `deadbee${i}`, title: `Commit démo ${i}`,
        author_name: `Dev ${i}`, committed_date: new Date(Date.now() - i * 3600000).toISOString(),
        web_url: `https://gitlab.test/${r.project}/-/commit/deadbeef${i}cafebabe`,
      }];
    });
    const { status, body } = await app.api('GET', '/api/dashboard/commits');
    assert.equal(status, 200);
    assert.equal(body.configured, true);
    assert.equal(body.commits.length, repos.length, 'un commit par dépôt actif');
    const c = body.commits[0];
    assert.ok(c.project && c.sha && c.author && c.date, 'champs mappés');
    assert.match(c.url, /\/-\/commit\//, 'lien GitLab vers le commit');

    // Un dépôt sans commit est simplement omis (best-effort).
    app.state.commits = {};
    assert.equal((await app.api('GET', '/api/dashboard/commits')).body.commits.length, 0);
  });

  test('GET /api/footer renvoie la télémétrie et l’activité d’équipe', async () => {
    const { body } = await app.api('GET', '/api/footer');
    assert.equal(typeof body.now, 'string');
    assert.equal(body.reviews.total, 0);
    assert.equal(body.streak, 0);
    assert.ok(Array.isArray(body.toReviewList));
    assert.ok(Array.isArray(body.authors));
    assert.ok(Array.isArray(body.noteBuckets));
    assert.equal(body.noteBuckets.length, 5);
  });

  /* ---------- Jobs ---------- */

  test('Jobs : la file est vide et l’arrêt sans job renvoie un conflit', async () => {
    const courant = await app.api('GET', '/api/jobs/current');
    assert.equal(courant.body.running, false);
    const stop = await app.api('POST', '/api/jobs/stop');
    assert.equal(stop.status, 409, 'arrêter alors que rien ne tourne = 409, pas une erreur silencieuse');
    const log = await app.api('GET', '/api/jobs/current/log');
    assert.ok(Array.isArray(log.body.lines));
  });

  /* Voir la file, et en sortir un job pour le lancer à côté. Ce qui est vérifiable de façon
     déterministe en dry-run (où les jobs s'achèvent aussitôt), c'est le CONTRAT : la forme
     de la réponse, et les refus. Le parallélisme lui-même repose sur `keysClash`, testé à
     part sur la règle nue. */
  test('Jobs : la file s’inspecte, et « lancer en parallèle » refuse ce qui n’attend plus', async () => {
    const q = await app.api('GET', '/api/jobs/queue');
    assert.equal(q.status, 200);
    assert.ok(Array.isArray(q.body.running) && Array.isArray(q.body.queued));
    assert.equal(q.body.parallelBusy, false);
    assert.equal(q.body.maxRunning, 3, 'le plafond de jobs simultanés est exposé, pas deviné par le front');

    // Un job inexistant, ou terminé, n'est plus dans la file : on le dit au lieu de l'ignorer.
    assert.equal((await app.api('POST', '/api/jobs/999999/start-now')).status, 409);
    assert.equal((await app.api('POST', '/api/jobs/999999/stop')).status, 409);
    assert.equal((await app.api('GET', '/api/jobs/999999/log')).status, 400);

    /* Arrêter UN job ne doit pas être confondu avec le Stop global. Ici on vérifie ce qui
       est vérifiable sans jobs longs : les deux routes existent et sont distinctes, et
       l'arrêt ciblé refuse proprement un id inconnu au lieu de tout arrêter par défaut. */
    assert.equal((await app.api('POST', '/api/jobs/stop', { job_id: 999999 })).status, 409,
      'un job_id inconnu ne doit PAS retomber sur « tout arrêter »');
  });

  test('POST /api/reports/reset remet les MR à reviewer', async () => {
    const { body } = await app.api('POST', '/api/reports/reset');
    assert.equal(body.ok, true);
    const mrs = await app.api('GET', '/api/mrs');
    assert.ok(mrs.body.every((m) => m.status === 'to_review'));
  });

  test('Les fichiers statiques du front sont servis', async () => {
    const res = await fetch(`${app.base}/index.html`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-cache');
  });
});
