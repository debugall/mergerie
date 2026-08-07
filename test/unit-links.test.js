'use strict';
/* Liens — la logique pure.
 *
 * Ce qui se teste ici ne se provoque pas de bout en bout : un export de marque-pages
 * malformé, un gabarit à variable inconnue, l'ordre exact que produit la frécence. Le reste
 * (routes, grille, import bout-en-bout) est couvert par `e2e-links.test.js`.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Isole la base : ces modules chargent db.js (donc paths.js) au require.
process.env.MERGERIE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'links-unit-'));

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const links = require('../src/links');
const db = require('../src/db');

const MSGS = {
  nomVide: 'NOM-VIDE', nomPris: 'NOM-PRIS', labelVide: 'LABEL-VIDE',
  urlInvalide: 'URL-INVALIDE', templateVide: 'TEMPLATE-VIDE',
  variableInconnue: (n, l) => `VARIABLE:${n}:${l.join(',')}`,
  tropDeTags: 'TROP-TAGS', inconnu: 'INCONNU', envInconnu: 'ENV-INCONNU', tropGros: 'TROP-GROS',
};

describe('validation des URLs : http(s), et rien d’autre', () => {
  /* Ces adresses sont ouvertes d'un clic depuis l'application : un `javascript:` saisi par
     l'utilisateur lui-même n'y a pas plus sa place qu'un autre. */
  test('les protocoles dangereux sont refusés', () => {
    for (const mauvais of ['javascript:alert(1)', 'data:text/html,<b>', 'file:///etc/passwd', 'ftp://x.test/a']) {
      assert.throws(() => links.lireUrl(mauvais, MSGS.urlInvalide), /URL-INVALIDE/, mauvais);
    }
  });

  test('une adresse relative ou incomplète est refusée', () => {
    for (const mauvais of ['/interne/page', 'exemple.test', '', '   ']) {
      assert.throws(() => links.lireUrl(mauvais, MSGS.urlInvalide), /URL-INVALIDE/, JSON.stringify(mauvais));
    }
  });

  test('http et https passent, avec leurs paramètres', () => {
    assert.equal(links.lireUrl('https://x.test/a?b=1&c=2#d', MSGS.urlInvalide), 'https://x.test/a?b=1&c=2#d');
    assert.equal(links.lireUrl('  http://localhost:8080/health  ', MSGS.urlInvalide), 'http://localhost:8080/health');
  });
});

describe('tags : normalisés, dédupliqués, bornés', () => {
  test('accents, casse et espaces sont ramenés à une seule forme', () => {
    // Sans normalisation, « Métier », « metier » et « MÉTIER » feraient trois filtres.
    assert.deepEqual(links.lireTags(['Métier', 'metier', 'MÉTIER'], MSGS.tropDeTags), ['metier']);
    assert.deepEqual(links.lireTags(['back end', ' Front '], MSGS.tropDeTags), ['back-end', 'front']);
  });

  test('une chaîne à virgules vaut une liste', () => {
    assert.deepEqual(links.lireTags('doc, outils ,', MSGS.tropDeTags), ['doc', 'outils']);
  });

  test('au-delà de dix, on refuse plutôt que de tronquer en silence', () => {
    assert.throws(() => links.lireTags(Array.from({ length: 11 }, (_, i) => `t${i}`), MSGS.tropDeTags), /TROP-TAGS/);
  });
});

describe('gabarits de liens contextuels', () => {
  /* Une faute de frappe doit se voir AU MOMENT OÙ ON L'ÉCRIT, pas produire une URL cassée
     trois semaines plus tard sur une merge request. */
  test('une variable inconnue est refusée, et le message dit lesquelles existent', () => {
    assert.throws(
      () => links.lireTemplate('https://k.test/?q={brench}', MSGS.templateVide, MSGS.variableInconnue),
      /VARIABLE:brench:env,branch,mr_iid,service/,
    );
  });

  test('les quatre variables connues passent', () => {
    const g = 'https://kibana-{env}.corp/?q={service}%20{branch}%20{mr_iid}';
    assert.equal(links.lireTemplate(g, MSGS.templateVide, MSGS.variableInconnue), g);
  });

  test('un gabarit qui n’est pas http(s) est refusé', () => {
    assert.throws(() => links.lireTemplate('javascript:x', MSGS.templateVide, MSGS.variableInconnue), /TEMPLATE-VIDE/);
  });

  /* URL-ENCODAGE : une branche `feat/x?y=1` ne doit pas ouvrir un paramètre dans l'URL de
     destination — c'est la différence entre un lien et une injection. */
  test('chaque valeur substituée est URL-encodée', () => {
    const r = links.resoudreTemplate('https://k.test/?q={branch}', { branch: 'feat/x?y=1&z=2' });
    assert.equal(r.url, 'https://k.test/?q=feat%2Fx%3Fy%3D1%26z%3D2');
    assert.equal(r.manquante, null);
  });

  /* Une variable sans valeur ici ne doit pas produire une URL à trous : mieux vaut un bouton
     grisé qui dit pourquoi qu'une adresse qui mène sur une page d'erreur. */
  test('une variable non résoluble rend null, en nommant la coupable', () => {
    const r = links.resoudreTemplate('https://k.test/?q={branch}&e={env}', { branch: 'main' });
    assert.equal(r.url, null);
    assert.equal(r.manquante, 'env');
  });

  test('un gabarit sans variable se résout tel quel', () => {
    assert.equal(links.resoudreTemplate('https://k.test/fixe', {}).url, 'https://k.test/fixe');
  });
});

describe('recherche floue de la palette', () => {
  test('les sous-séquences trouvent ce qu’on abrège', () => {
    assert.ok(links.scoreFuzzy('Kibana preprod', 'kib pre') > 0);
    assert.ok(links.scoreFuzzy('Confluence — specs paiement', 'conf pai') > 0);
  });

  /* Sans contrainte d'étalement, « api » se retrouve dans presque n'importe quelle phrase
     française et la palette se remplit de faux positifs qui chassent les vrais. */
  test('des lettres trop éparpillées ne comptent pas pour un match', () => {
    assert.equal(links.scoreFuzzy('Décider du format de log avant le point archi', 'api'), 0);
  });

  test('un mot absent annule tout le résultat', () => {
    assert.equal(links.scoreFuzzy('api-core dev', 'api preprod'), 0);
  });

  test('un début de mot vaut mieux qu’un milieu de mot', () => {
    assert.ok(links.scoreFuzzy('api-core', 'api') > links.scoreFuzzy('rapide', 'api'));
  });

  test('accents et casse ne changent rien', () => {
    assert.ok(links.scoreFuzzy('Préproduction', 'preprod') > 0);
    assert.ok(links.scoreFuzzy('KIBANA', 'kibana') > 0);
  });
});

describe('frécence : souvent ET récemment', () => {
  const jours = (n) => new Date(Date.now() - n * 24 * 3600 * 1000).toISOString();

  test('à usage égal, le plus récent l’emporte', () => {
    const vieux = links.frecence({ uses: 10, last_used_at: jours(30) });
    const frais = links.frecence({ uses: 10, last_used_at: jours(0) });
    assert.ok(frais > vieux, `${frais} doit dépasser ${vieux}`);
  });

  /* Un simple compteur ferait remonter à vie ce qu'on a beaucoup ouvert le mois dernier. */
  test('un usage massif mais ancien passe derrière un usage modeste et quotidien', () => {
    const massifAncien = links.frecence({ uses: 200, last_used_at: jours(365) });
    const modesteRecent = links.frecence({ uses: 3, last_used_at: jours(0) });
    assert.ok(modesteRecent > massifAncien);
  });

  test('rien d’enregistré vaut zéro, et ne casse pas le classement', () => {
    assert.equal(links.frecence(null), 0);
    assert.equal(links.frecence(undefined), 0);
  });
});

/* Le plafond par source est un garde-fou contre une réponse démesurée — pas un filtre sur ce
   qui est CHERCHABLE. Tant qu'il s'appliquait avant la recherche, une merge request au-delà
   des plus récentes était introuvable, sans le moindre message. */
describe('palette : le plafond ne cache pas ce qu’on cherche', () => {
  const beaucoup = () => {
    db.prepare('DELETE FROM mr').run();
    db.prepare('DELETE FROM free_link').run();
    db.prepare("INSERT OR IGNORE INTO repo (id, project, url, enabled) VALUES (1, 'grp/app', 'u', 1)").run();
    const now = new Date().toISOString();
    const ins = db.prepare("INSERT INTO mr (repo_id, iid, title, status, updated_at) VALUES (1,?,?,'to_review',?)");
    for (let i = 200; i <= 400; i += 1) ins.run(i, `MR numero ${i}`, now);
    for (let i = 1; i <= 100; i += 1) links.creerFreeLink({ label: `Lien numero ${i}`, url: `https://x${i}.test` }, MSGS);
  };

  test('une merge request ancienne se trouve par son numéro', () => {
    beaucoup();
    // 201 merge requests, plafond par source à 90 : la 214 est loin derrière les plus récentes.
    assert.deepEqual(links.launcher('!214', {}).map((r) => r.label), ['!214 — MR numero 214']);
    assert.deepEqual(links.launcher('numero 214', {}).map((r) => r.label), ['!214 — MR numero 214'],
      'et par les mots de son titre');
  });

  test('un lien libre au-delà du plafond se trouve aussi', () => {
    beaucoup();
    const r = links.launcher('Lien numero 97', {});
    assert.ok(r.some((x) => x.label === 'Lien numero 97'),
      `le 97e sur 100 doit être atteignable, vu : ${JSON.stringify(r.map((x) => x.label))}`);
  });

  /* Sans `ORDER BY`, quels liens étaient cherchables dépendait de l'ordre physique des
     lignes — donc de rien de compréhensible pour qui s'en sert. */
  test('la réponse reste bornée, et stable d’un appel à l’autre', () => {
    beaucoup();
    const a = links.launcher('lien', {}).map((x) => x.ref);
    const b = links.launcher('lien', {}).map((x) => x.ref);
    assert.deepEqual(a, b, 'deux fois la même requête rend deux fois la même chose');
    assert.ok(a.length <= 12, 'le plafond global tient toujours');
  });

  /* Le `%` d'une saisie est du TEXTE, pas un joker SQL : sans échappement, le taper
     ramènerait toute la base. */
  test('les jokers SQL saisis ne font pas tout remonter', () => {
    beaucoup();
    assert.equal(links.launcher('%', {}).length, 0);
    assert.equal(links.launcher('_', {}).length, 0);
  });

  test('sans requête, la palette s’ouvre quand même pleine', () => {
    beaucoup();
    assert.ok(links.launcher('', {}).length > 0);
  });

  /* Le pré-filtre compare la requête — déjà dénudée de ses accents — à des valeurs qui, elles,
     les ont gardés. Sans normalisation des DEUX côtés du `LIKE`, une ligne accentuée
     n'atteignait jamais le flou, qui savait pourtant la trouver. Dans une application dont les
     titres sont largement en français, cela revenait à ne plus rien trouver — et taper la
     requête AVEC son accent échouait tout autant, puisqu'elle est dénudée avant d'être comparée.
     Les libellés ci-dessous portent donc de VRAIS accents : sans eux le test ne prouverait rien. */
  test('les accents ne cachent plus rien, dans un sens comme dans l’autre', () => {
    db.prepare('DELETE FROM free_link').run();
    links.creerFreeLink({ label: 'Génération du rapport', url: 'https://a.test' }, MSGS);
    links.creerFreeLink({ label: 'Vérification des accès', url: 'https://c.test' }, MSGS);

    for (const q of ['generation', 'génération', 'Generation', 'GÉNÉRATION']) {
      assert.deepEqual(links.launcher(q, {}).map((x) => x.label), ['Génération du rapport'], q);
    }
    assert.deepEqual(links.launcher('verification des acces', {}).map((x) => x.label),
      ['Vérification des accès'], 'chaque mot de la requête est normalisé, pas seulement le premier');
  });

  /* UN CHOIX, PAS UN OUBLI. Le flou accepte un mot à trous ; le pré-filtre exige le fragment
     entier. Le traduire fidèlement donnerait `%k%b%a%n%a%` — sur mille titres français,
     « pre » toucherait 622 lignes au lieu de 190, et le plafond recouperait avant que la
     contrainte d'étalement n'ait pu trier. On abrège par MOTS, pas en sautant des lettres. */
  test('on abrège par mots, pas en sautant des lettres dans un mot', () => {
    db.prepare('DELETE FROM free_link').run();
    links.creerFreeLink({ label: 'Kibana preprod', url: 'https://b.test' }, MSGS);

    assert.deepEqual(links.launcher('kib pre', {}).map((x) => x.label), ['Kibana preprod'],
      'chaque mot est un fragment : c’est ce que la documentation promet');
    assert.deepEqual(links.launcher('kbana', {}), [],
      'une lettre sautée au milieu d’un mot ne passe pas le pré-filtre');
  });
});

describe('import : le format « Netscape » de Chrome', () => {
  const FICHIER = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<DL><p>
    <DT><H3>Barre de favoris</H3>
    <DL><p>
        <DT><H3>Travail</H3>
        <DL><p>
            <DT><A HREF="https://kibana.corp/app" ADD_DATE="1">Kibana &amp; logs</A>
            <DT><A HREF="javascript:alert(1)">Piège</A>
            <DT><A HREF="place:sortColumn">Historique</A>
        </DL><p>
        <DT><A HREF="https://confluence.corp/x">Confluence</A>
    </DL><p>
    <DT><A HREF="https://example.com/racine">Hors dossier</A>
</DL><p>`;

  test('l’arbre est suivi : chaque lien porte son chemin de dossier en tags', () => {
    const l = links.parserBookmarks(FICHIER, MSGS);
    const parLabel = Object.fromEntries(l.map((x) => [x.label, x]));
    assert.equal(l.length, 3, 'trois liens http(s)');
    assert.deepEqual(parLabel['Kibana & logs'].tags, ['barre-de-favoris', 'travail'],
      'le chemin complet devient les tags');
    assert.equal(parLabel.Confluence.folder, 'Barre de favoris', 'le `</DL>` dépile bien');
    assert.deepEqual(parLabel['Hors dossier'].tags, [], 'un lien de la racine n’invente pas de tag');
  });

  /* Un fichier fourni par l'extérieur : on l'analyse, on ne l'exécute ni ne le rend jamais.
     Et tout ce qui n'est pas http(s) n'a rien à faire dans une liste de liens cliquables. */
  test('les entrées non http(s) sont ignorées, et les entités décodées', () => {
    const l = links.parserBookmarks(FICHIER, MSGS);
    assert.ok(!l.some((x) => /javascript:|place:/.test(x.url)));
    assert.ok(l.some((x) => x.label === 'Kibana & logs'), '`&amp;` est redevenu `&`');
  });

  test('un fichier malformé rend ce qu’il peut au lieu d’échouer', () => {
    const l = links.parserBookmarks('<DL><DT><H3>Sans fin<DT><A HREF="https://x.test/a">A</A>', MSGS);
    assert.equal(l.length, 1);
    assert.equal(l[0].url, 'https://x.test/a');
  });

  test('au-delà de cinq mégaoctets, on refuse', () => {
    assert.throws(() => links.parserBookmarks('x'.repeat(links.MAX_IMPORT + 1), MSGS), /TROP-GROS/);
  });

  test('un fichier sans le moindre lien ne fabrique rien', () => {
    assert.deepEqual(links.parserBookmarks('<html><body>rien</body></html>', MSGS), []);
  });

  /* REJOUABLE : réimporter le même fichier après en avoir ajouté trois ne doit pas doubler
     les cent autres. Le compte des ignorés est rendu — un silence passerait pour un échec. */
  test('l’import est rejouable : une URL déjà connue n’est pas recréée', () => {
    db.prepare('DELETE FROM free_link').run();
    const liens = links.parserBookmarks(FICHIER, MSGS);
    assert.deepEqual(links.appliquerImport({ links: liens }, MSGS), { created: 3, skipped: 0 });
    assert.deepEqual(links.appliquerImport({ links: liens }, MSGS), { created: 0, skipped: 3 });
    assert.equal(db.prepare('SELECT COUNT(*) c FROM free_link').get().c, 3);
  });

  test('une ligne invalide est comptée, pas fatale au reste de l’import', () => {
    db.prepare('DELETE FROM free_link').run();
    const r = links.appliquerImport({ links: [
      { label: 'bon', url: 'https://ok.test/a' },
      { label: 'mauvais', url: 'javascript:alert(1)' },
    ] }, MSGS);
    assert.deepEqual(r, { created: 1, skipped: 1 });
  });
});

describe('grille et conversion', () => {
  test('une case se pose, se remplace, et se vide', () => {
    db.prepare('DELETE FROM service').run();
    db.prepare('DELETE FROM environment').run();
    const env = links.creerEnvironnement({ name: 'dev' }, MSGS);
    const svc = links.creerService({ name: 'api', tags: ['backend'] }, MSGS);

    links.poserUrl(svc.id, { environment_id: env.id, url: 'https://a.test/1' }, MSGS);
    links.poserUrl(svc.id, { environment_id: env.id, url: 'https://a.test/2' }, MSGS);
    assert.equal(links.grille().services[0].urls[env.id], 'https://a.test/2', 'la seconde remplace la première');

    // Vider le champ EFFACE la case : c'est le geste naturel, il ne mérite pas un second bouton.
    links.poserUrl(svc.id, { environment_id: env.id, url: '' }, MSGS);
    assert.equal(links.grille().services[0].urls[env.id], undefined);
  });

  /* Effacer l'URL d'un service en panne faisait disparaître la pastille (la case est vide)
     mais laissait le compteur `down` la compter : un badge rouge permanent sur le menu, sans
     rien à montrer. */
  test('vider une case emporte son verdict de santé', () => {
    db.prepare('DELETE FROM service').run();
    db.prepare('DELETE FROM environment').run();
    const env = links.creerEnvironnement({ name: 'dev', health_check: 1 }, MSGS);
    const svc = links.creerService({ name: 'sonde' }, MSGS);
    links.poserUrl(svc.id, { environment_id: env.id, url: 'https://ko.test' }, MSGS);
    db.prepare(`INSERT INTO health_status (service_id, environment_id, status, http_code, latency_ms, checked_at)
      VALUES (?,?, 'down', 503, 12, ?)`).run(svc.id, env.id, new Date().toISOString());
    assert.equal(links.grille().down, 1);

    links.poserUrl(svc.id, { environment_id: env.id, url: '' }, MSGS);
    assert.equal(links.grille().down, 0, 'plus de case, plus de verdict — donc plus de badge');
  });

  /* TOUT OU RIEN : un environnement supprimé entre l'ouverture de la modale et le clic
     laissait un service à moitié fait, des liens déjà supprimés, et un rejeu impossible
     (« nom déjà pris »). */
  test('une conversion qui échoue en cours de route ne laisse rien derrière elle', () => {
    db.prepare('DELETE FROM service').run();
    db.prepare('DELETE FROM environment').run();
    db.prepare('DELETE FROM free_link').run();
    const dev = links.creerEnvironnement({ name: 'dev' }, MSGS);
    const a = links.creerFreeLink({ label: 'A', url: 'https://a.test' }, MSGS);
    const b = links.creerFreeLink({ label: 'B', url: 'https://b.test' }, MSGS);

    assert.throws(() => links.convertirEnService({
      name: 'Kibana',
      mapping: [
        { free_link_id: a.id, environment_id: dev.id },
        { free_link_id: b.id, environment_id: 99999 },     // environnement disparu
      ],
    }, MSGS), /ENV-INCONNU/);

    assert.equal(db.prepare("SELECT COUNT(*) c FROM service WHERE name = 'Kibana'").get().c, 0,
      'le service à moitié fait est défait');
    assert.equal(db.prepare('SELECT COUNT(*) c FROM free_link').get().c, 2,
      'les deux liens libres sont toujours là');
    // …et rejouer proprement fonctionne, au lieu de buter sur « nom déjà pris ».
    const ok = links.convertirEnService({ name: 'Kibana', mapping: [{ free_link_id: a.id, environment_id: dev.id }] }, MSGS);
    assert.equal(ok.convertis, 1);
  });

  test('un nom d’environnement ou de service en double est refusé', () => {
    db.prepare('DELETE FROM environment').run();
    links.creerEnvironnement({ name: 'preprod' }, MSGS);
    assert.throws(() => links.creerEnvironnement({ name: 'preprod' }, MSGS), /NOM-PRIS/);
  });

  test('les services épinglés passent en tête, puis l’ordre alphabétique', () => {
    db.prepare('DELETE FROM service').run();
    links.creerService({ name: 'zeta' }, MSGS);
    const b = links.creerService({ name: 'beta' }, MSGS);
    links.creerService({ name: 'alpha' }, MSGS);
    links.majService(b.id, { pinned: 1 }, MSGS);
    assert.deepEqual(links.grille().services.map((s) => s.name), ['beta', 'alpha', 'zeta']);
  });

  /* La conversion est le geste d'APRÈS l'import : un mapping EXPLICITE, pas une devinette
     faite sur des noms de dossiers. */
  test('des liens libres deviennent un service, une URL par environnement', () => {
    db.prepare('DELETE FROM service').run();
    db.prepare('DELETE FROM environment').run();
    db.prepare('DELETE FROM free_link').run();
    const dev = links.creerEnvironnement({ name: 'dev' }, MSGS);
    const prod = links.creerEnvironnement({ name: 'prod' }, MSGS);
    const l1 = links.creerFreeLink({ label: 'Kibana dev', url: 'https://k-dev.test' }, MSGS);
    const l2 = links.creerFreeLink({ label: 'Kibana prod', url: 'https://k-prod.test' }, MSGS);

    const r = links.convertirEnService({
      name: 'Kibana',
      mapping: [{ free_link_id: l1.id, environment_id: dev.id }, { free_link_id: l2.id, environment_id: prod.id }],
    }, MSGS);
    assert.equal(r.convertis, 2);
    const g = links.grille();
    assert.equal(g.services[0].urls[dev.id], 'https://k-dev.test');
    assert.equal(g.services[0].urls[prod.id], 'https://k-prod.test');
    assert.equal(g.free_links.length, 0, 'les liens convertis ne restent pas en double');
  });
});

describe('liens contextuels d’une merge request', () => {
  test('le gabarit sans {env} donne UN bouton, avec {env} un bouton par environnement', () => {
    db.prepare('DELETE FROM service').run();
    db.prepare('DELETE FROM environment').run();
    db.prepare("INSERT OR IGNORE INTO repo (id, project, url, enabled) VALUES (77, 'grp/app', 'u', 1)").run();
    const dev = links.creerEnvironnement({ name: 'dev' }, MSGS);
    const pre = links.creerEnvironnement({ name: 'preprod' }, MSGS);
    const svc = links.creerService({ name: 'api', repo_id: 77 }, MSGS);
    links.poserUrl(svc.id, { environment_id: dev.id, url: 'https://api-dev.test' }, MSGS);
    links.poserUrl(svc.id, { environment_id: pre.id, url: 'https://api-pre.test' }, MSGS);
    links.creerContextLink(svc.id, { label: 'Logs', url_template: 'https://k-{env}.test/?q={branch}' }, MSGS);
    links.creerContextLink(svc.id, { label: 'Runbook', url_template: 'https://doc.test/{service}' }, MSGS);

    const d = links.liensDeMr({ repo_id: 77, iid: 214, source_branch: 'feat/x?y' });
    assert.equal(d.service.name, 'api');
    assert.equal(d.envs.length, 2, 'un bouton par environnement ayant une URL');

    const logs = d.context.find((c) => c.label === 'Logs');
    assert.equal(logs.per_env.length, 2, '{env} → un bouton par environnement');
    assert.match(logs.per_env[0].url, /q=feat%2Fx%3Fy/, 'la branche est URL-encodée');

    const runbook = d.context.find((c) => c.label === 'Runbook');
    assert.deepEqual(runbook.per_env, [], 'sans {env}, un seul bouton — pas N fois la même URL');
    assert.equal(runbook.url, 'https://doc.test/api');
  });

  test('une variable sans valeur ici laisse le bouton, sans URL, en nommant la coupable', () => {
    const svc = links.grille().services[0];
    links.creerContextLink(svc.id, { label: 'Sans branche', url_template: 'https://x.test/{branch}' }, MSGS);
    const d = links.liensDeMr({ repo_id: 77, iid: 9, source_branch: '' });
    const c = d.context.find((x) => x.label === 'Sans branche');
    assert.equal(c.per_env.length, 0);
    assert.equal(c.url, null, 'pas d’URL à trous');
    assert.equal(c.manquante, 'branch');
  });

  test('un dépôt sans service associé ne rend aucun bouton', () => {
    assert.deepEqual(links.liensDeMr({ repo_id: 99999, iid: 1, source_branch: 'main' }),
      { service: null, envs: [], context: [] });
  });

  /* Un service lié à un dépôt mais SANS aucune case remplie : `per_env` est vide, et rien ne
     peut dire quelle variable manque. L'info-bulle annonçait alors « {null} ». */
  test('un gabarit {env} sans aucune case remplie nomme « env », pas « null »', () => {
    db.prepare('DELETE FROM service').run();
    db.prepare('DELETE FROM environment').run();
    links.creerEnvironnement({ name: 'dev' }, MSGS);
    const svc = links.creerService({ name: 'orphelin', repo_id: 77 }, MSGS);
    links.creerContextLink(svc.id, { label: 'Logs', url_template: 'https://k-{env}.test/x' }, MSGS);

    const c = links.liensDeMr({ repo_id: 77, iid: 5, source_branch: 'main' }).context[0];
    assert.equal(c.url, null);
    assert.equal(c.manquante, 'env', 'la coupable est nommée : il n’y a aucun environnement où aller');
  });
});
