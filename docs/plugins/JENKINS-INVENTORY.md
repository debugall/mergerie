# Inventaire : tout ce que Jenkins touche aujourd'hui

Étape 0 du chantier « système de plugins ». Relevé **en lecture seule** sur `develop` (3bf05a7),
avant toute modification. Chaque élément porte la primitive d'API de plugin qu'il exigerait ; les
primitives **absentes de la liste fermée du ctx V1** sont marquées ⚠, les couplages qui demandent
une décision sont renvoyés vers le bloc `<<<QUESTIONS>>>` du rapport.

Chiffres : 114 fichiers citent Jenkins (34 dans `src/`, 57 dans `public/`, 33 fichiers de test,
4 scripts, 2 guides). Code Jenkins *propre* : ~1 100 lignes serveur, ~1 500 lignes front
(JS + HTML + CSS + i18n). Code **des autres écrans** qui parle de Jenkins : ~40 points de contact.

---

## 1. Routes HTTP et handlers (`src/app/routes/jenkins.js`, 107 l.)

| Route | Rôle | Dépend de | Primitive ctx |
|---|---|---|---|
| `GET /api/jenkins/jobs` | liste aplatie ; `{configured:false}` si non réglé | `demo/jenkins`, `integrations/jenkins`, `lib/connexions.jenkinsCfg` | `ctx.http.router`, `ctx.settings`, `ctx.secrets`, `ctx.demo` |
| `GET /api/jenkins/job?path&builds` | détail + paramètres + historique (10, max 200) | idem | idem |
| `POST /api/jenkins/build` | **seul geste qui écrit chez Jenkins** ; puis `veille.attendreJenkins(path, since)` | `integrations/veille` | `ctx.http.router` + `ctx.schedule` (l'attente devient une tâche du plugin) + `ctx.events.emit('jenkins.job.started')` |
| `GET /api/jenkins/console?path&build` | console bornée à 200 ko | | `ctx.http.router` |
| `POST /api/jenkins/test` | test de connexion ; `exigerJetonFrais` ; `noterTest('jenkins', …)` | `lib/connexions`, `core/garde`, table `conn_test` | ⚠ **souvenir de test de connexion** (`conn_test`, affiché par Réglages → `GET /api/conn-tests`) et ⚠ **jeton lié à une origine** (`garde.jetonFraisRequis`) |
| `GET /api/jenkins/build-links?path` | adresses des services du dépôt lié (`links.liensDeMr`) | `notes/links` (noyau Liens) | ⚠ **lecture du noyau Liens** — devient un *futur plugin* : tissage plugin ↔ plugin, à passer par un événement/une requête de service (voir PLUGIN-CANDIDATES) |
| `GET/POST /api/jenkins/links`, `DELETE /api/jenkins/links/:id` | table `repo_jenkins` (job ↔ dépôt) ; vérifie `repo.id` | `db` (`repo`) | `ctx.db` + ⚠ `ctx.repos` (lecture du registre des dépôts, existence d'un id) |

Garde-fous communs hérités du noyau : `wrap()` (erreurs → JSON + status), middleware d'origine
(`app/middleware/origine.js`), jeton local, lecteur de corps. Un routeur de plugin monté sur
`/api/plugins/jenkins/` **après** ces middlewares en hérite sans rien faire.

Autres handlers du noyau qui parlent de Jenkins :

| Fichier | Ce qu'il fait | Primitive |
|---|---|---|
| `app/routes/mrs.js:131-171` | joint `repo_jenkins` pour poser `jenkins_jobs` sur chaque carte de MR | ⚠ **décoration d'une carte MR par un plugin** (`ctx.ui.registerAction({target:'mr'})` suffit pour le *bouton* ; la donnée `jenkins_jobs` est calculée côté plugin à partir de `mr.repo_id`) |
| `app/routes/repos.js:81` | fiche d'un dépôt : section « Jobs Jenkins » | ⚠ **section de fiche de dépôt** (`registerAction({target:'repo'})` ou `registerRepoSheetSection`) |
| `app/lib/branches.js:66-70` | explorateur Git : `b.jenkins = [{path,param}]` sur chaque branche | ⚠ `registerAction({target:'branch'})` |
| `app/routes/statut.js:56` | `jenkinsRefreshMinutes` dans `/api/status` (le front relit la cadence à chaque tic) | remplacé par la lecture des réglages du plugin côté front (`window.mergerie.settings`) |
| `app/routes/config.js:169,205` | masque `***` du `jenkins_token` ; `***` = « garde-le » | `ctx.secrets` (même masque) |
| `app/routes/links.js:85` | libellé `palette.act.jenkins` passé à `notes/links.palette` | `ctx.ui.registerPaletteProvider` |
| `app/routes/mrs-commentaires.js:13,153` | **utilise `demoJenkins.isDemo()` comme drapeau de démo générique** | couplage accidentel : à remplacer par `demo/shared.isDemo` dans le noyau (correction neutre) |
| `app/lib/connexions.js` | `jenkinsCfg()` (= `getConfig()`), `noterTest`, `exigerJetonFrais` | voir ci-dessus |

## 2. Client et logique métier (`src/integrations/jenkins.js`, 536 l.)

Pur : n'importe que `core/httpreq` (`request`, `makeAgentFactory('JENKINS_CA_CERT','JENKINS_INSECURE_TLS')`)
et `core/i18n` (`t('err.jenkins.*')`). Exporte `isConfigured, lister, detail, lancer, console,
tester` + 10 fonctions de traduction exportées **pour les tests** (`lireCouleur, aplatir,
cheminUrl, lireParametres, auteurDe, refDe, paramsDuBuild, paramsCachesDe, choixDe, lireChoixHtml`).

| Besoin | Primitive |
|---|---|
| requête HTTP(S) sortante avec agent TLS épinglable (`<SERVICE>_CA_CERT` / `<SERVICE>_INSECURE_TLS`), timeout 30 s, erreurs TLS traduites en gestes | ⚠ **absent de la liste fermée** : soit `ctx.net.request(url, opts)` (recommandé : garde la convention TLS et le timeout du noyau, et permet au noyau de refuser des cibles), soit le plugin embarque son propre client `https` (duplication de `httpreq`, et `unit-jenkins-tls` perd son sens) |
| messages d'erreur traduits côté serveur (`err.jenkins.*`, 8 clés fr/en dans `public/i18n/erreurs.js`) | `ctx.i18n.register(locale, dict)` **doit valoir côté serveur aussi** (`ctx.i18n.t`), pas seulement côté front |
| variables d'environnement `JENKINS_CA_CERT`, `JENKINS_INSECURE_TLS` lues au chargement | `ctx.env.get(name)` ou lecture directe de `process.env` dans le worker (à trancher : un plugin tiers lit-il l'environnement du serveur ?) ⚠ |

## 3. Tables SQLite, migrations, classement P/L/C

| Objet | Où | Classement | Primitive |
|---|---|---|---|
| `repo_jenkins (id, repo_id FK repo ON DELETE CASCADE, job_path, param, UNIQUE(repo_id, job_path))` + colonne `uid` (uidPropre) | `db/schema/10-jenkins-config.js:16` | **L** (`store-registry.js:205`), `UNIQUES_SANS_CLE['repo_jenkins.repo_id+job_path']`, `CHAMPS_CHEMIN['repo_jenkins.job_path']` (note « pas un chemin de disque ») | `ctx.db` avec préfixe `plugin_jenkins_` ; ⚠ la **FK vers `repo`** ne peut pas traverser la frontière (table du noyau, et un worker n'a pas la même connexion) : il faut un événement `repo.deleted` ou `ctx.repos.onRemoved` pour reproduire le `CASCADE`, **et une migration de données** `repo_jenkins → plugin_jenkins_link` |
| `config.jenkins_url` | `02-migrations-noyau.js:141` | **P — partagée** (`store-registry.js:1778`) : écrite dans le fichier `config` du dépôt de données d'équipe | ⚠ voir QUESTIONS : un réglage de plugin « d'équipe » (P) n'existe pas dans le ctx (`ctx.settings` n'a pas de portée) ; et déplacer la colonne change le **format du dépôt partagé** |
| `local_config.jenkins_user`, `local_config.jenkins_token`, `local_config.jenkins_refresh_minutes` (+ anciennes colonnes de `config`, conservées) | `02-migrations-noyau.js:142-147`, `13-local-config.js:35-39` | **L** (secrets + cadence de poste) | `ctx.secrets` (user + token) et `ctx.settings` (cadence, bornée 0/1..60 par `data/config.js:111`) |
| `conn_test (service PK …)` ligne `'jenkins'` | `10-jenkins-config.js:45` | L | ⚠ (voir § 1) |
| validation/normalisation dans `data/config.js` : `ALLOWED` (4 champs), trim de l'URL, `invaliderSiOrigineChangee('jenkins_url','jenkins_token')`, bornes de `jenkins_refresh_minutes`, les deux `UPDATE … SET` | `data/config.js:42,85,96,111,264,303-305` | | `settingsSchema` (JSON Schema : `format: uri`, `minimum/maximum`) + ⚠ **secret rattaché à une URL** : « l'adresse change ⇒ le jeton est effacé » doit être exprimable dans le schéma (`x-secretBoundTo: 'url'`) |
| `scripts/check-server.js:140-160` vérifie `ALLOWED` ↔ `UPDATE` pour chaque champ | | | ne s'applique plus au plugin ; `settingsSchema` est la liste unique |

Tranche `db/schema/10-jenkins-config.js` : mal nommée — elle porte aussi `conn_test`, `git_command`,
l'amorçage de `config` et 12 migrations du noyau. Seules les lignes 9-22 sont Jenkins.

## 4. Tâches de fond

| Tâche | Où | Cadence | Primitive |
|---|---|---|---|
| **Veille serveur** : `attentes` (job → dernier numéro), `tourJenkins(cfg)` → `notify.push('jenkins_done', {path, number, result, ok})` ; oubli après 6 h ; 20 attentes max ; un seul timer partagé avec Docker, démarré par `server.js` (`veille.demarrer`, pas en démo), arrêté dans `close()` | `integrations/veille.js:36-64,104-121` | 60 s | `ctx.schedule(60000, fn)` + `ctx.events.emit('jenkins.job.finished')` + `ctx.notify` ; la partie Docker reste dans `veille.js` (et suivra Docker) |
| **Rafraîchissement de l'onglet** (`jkAutoRelance`, `jkPeriodeMs` relu de `/api/status` à chaque tic) : seulement onglet ouvert et fenêtre visible | `js/ecrans/jenkins/rafraichissement.js` | `jenkins_refresh_minutes` (1 min défaut, 0 = jamais, max 60) | front du plugin (timer navigateur) ; la cadence vient de `ctx.settings` exposée au front |
| **Badge « jobs du jour »** : `amorcerBadgeJenkins()` au démarrage (`demarrage.js:61`) → `GET /jenkins/jobs` une fois → `majBadgeJenkins()` remplit `#navCountJenkins` (bleu) et `#navJenkinsFail` (rouge) | `js/ecrans/jenkins/liste.js:108-157` | au chargement + à chaque liste | `ctx.ui.setBadge('jenkins', {count, failed})` ⚠ **deux pastilles** (compte + échecs) : la valeur de `setBadge` doit être un objet, pas un nombre |
| **Mes lancements** (`JENKINS_LANCES` en localStorage, TTL) : marque « lancé par moi » dans la liste | `rafraichissement.js:43-60` | | localStorage du front du plugin |
| **Notification bureau** `jenkins_done` : le front lit `/api/notifications` (ring buffer `core/notify.js`), case Réglages → Notifications (`data-notif="jenkins_done"`, **cochée par défaut**, `notifications.js:19`), `adresses.js:187` affiche et ouvre `openJenkinsJob` | `transverse/adresses.js`, `transverse/notifications.js`, `html/ecrans/reglages.html:282` | | ⚠ `ctx.notify(desktop)` ne suffit pas : il faut **déclarer un genre de notification** (clé, libellé, défaut coché, action au clic) → `ctx.notify.registerKind({id, label, default, onClick})` |

## 5. Composants UI

### 5.1 Fichiers propres au plugin (déplaçables tels quels)

| Fichier | Lignes | Ports exposés (`// @expose`) |
|---|---|---|
| `js/ecrans/jenkins/liste.js` | 557 | `JENKINS` (état global), `amorcerBadgeJenkins`, `loadJenkins` |
| `js/ecrans/jenkins/rafraichissement.js` | 66 | `jkAutoRelance`, `jkPeriodeMs` |
| `js/ecrans/jenkins/fiche.js` | 217 | `jkPoserParams` |
| `js/ecrans/jenkins/lancer.js` | 400 | `openJenkinsJob` |
| `js/ecrans/reglages/jenkins.js` | 86 | — (sous-onglet Réglages : liens job ↔ dépôt, combos) |
| `html/ecrans/jenkins.html` (onglet) · `html/modales/jenkins.html` (fiche `#jenkinsModal`, console) | 38 · 45 | ids : `jenkinsBox`, `jenkinsSearch`, `jenkinsCount`, `jenkinsModal`, `jenkinsModalBody`… |
| `css/ecrans/jenkins.css` | 267 | classes `jk-*` |
| `i18n/jenkins.js` (`jenkins.*`, 229 l.) + **60 clés dans `i18n/reglages.js`** (`settings.jenkins.*`, `settings.lbl.jenkins-*`, `settings.tip.jenkins-*`, `settings.notif.jenkins-done`, `onboard.s3.jenkins`) + 12 dans `transverse.js` (`nav.jenkins`, `notif.jenkins-done.*`, `palette.go.jenkins`, `palette.act.jenkins`, `shortcuts.badge.jenkins`) + 18 dans `erreurs.js` + 4 dans `reviews.js` + 2 dans `git.js` + 3 dans `sessions.js` | | `ctx.i18n.register('fr'/'en', dict)` ; les clés **consommées par des écrans du noyau** (`mr.btn.jenkins-run`, `git.br.jenkins-title`, `task.title.followup-ci`) suivent le bouton qui les porte (libellé fourni par `registerAction`) |

### 5.2 Points d'accroche dans le noyau (chaque ligne = un morceau de noyau à rendre générique)

| Où | Quoi | Primitive |
|---|---|---|
| `html/sidebar.html:9` | bouton d'onglet (`data-tab="jenkins"`, icône `#i-pipeline`, titre, 2 pastilles) | `ctx.ui.registerTab({id, label, icon, position})` ; ⚠ l'icône est un `<symbol>` du **sprite** (`html/sprite.html:33`) : `registerTab` doit accepter un SVG inline |
| `transverse/navigation.js:29` | `loadJenkins()` à l'ouverture de l'onglet | `registerTab({ onOpen })` |
| `transverse/menus.js:88,116` | `NAV_MASQUES_DEFAUT = ['git','docker','jenkins','links']` (replié d'office) ; légende des pastilles (`shortcuts.badge.jenkins`) | `registerTab({ foldedByDefault: true, badgeLegend })` ⚠ |
| `transverse/palette.js:24,103` | « Aller à Jenkins » ; `nav.jenkins_path` → `openJenkinsJob` | `registerTab` (le « aller à » est générique) + `registerPaletteProvider` (entrées `kind:'jenkins'` calculées par `notes/links.js:846-855` depuis `repo_jenkins`, **côté serveur, sans appel réseau**) ⚠ le provider doit pouvoir rendre des entrées **depuis le serveur** (données du plugin) |
| `transverse/raccourcis.js:113` | `#jenkinsSearch` dans la liste des champs que « / » focalise | `registerTab({ searchField: '#jenkinsSearch' })` ⚠ |
| `core/theme.js:56` | `#jenkinsBox` dans les listes que `j`/`k` parcourent | `registerTab({ list: '#jenkinsBox' })` ⚠ |
| raccourcis chiffrés (1..9 par ordre de barre) | implicite par la position dans la barre | `registerTab({ shortcut })` |
| `transverse/jobs/statut.js:222-227` | relit `jenkinsRefreshMinutes` de `/api/status` → `jkPeriodeMs`, `jkAutoRelance()` | front du plugin, abonné à `settings.changed` |
| `transverse/accueil.js:69,138` | onboarding : case « Jenkins » (déplie le menu) ; action `jenkins-config` → Réglages → Jenkins | `registerTab({ onboarding: { label } })` ⚠ + `registerSettingsTab` |
| `ecrans/reglages/sous-onglets.js:14,24,33,63` | `ADMIN_SUBS.jenkinscfg`, `SOUS_ONGLETS_PAR_MENU = { jenkinscfg: 'jenkins' }` (le sous-onglet suit le menu), `majEtatsConnexions()` | `ctx.ui.registerSettingsTab({id, label, followsTab:'jenkins', render})` |
| `html/ecrans/reglages.html:18,505-546` | sous-onglet Jenkins : 4 champs `form="configForm"`, bouton Tester, formulaire « Jobs liés aux dépôts » | formulaire généré depuis `settingsSchema` **+ un rendu libre** (la liste job ↔ dépôt n'est pas un réglage scalaire) : `registerSettingsTab` doit accepter du HTML/JS du plugin, pas seulement un schéma ⚠ |
| `ecrans/reglages/{formulaire,portee,connexions}.js` | `CONFIG_FIELDS` (4 champs), masque `***`, `configInfoJenkins`, `btnTestJenkins`, garde à vide commune | disparaissent du noyau avec les champs |
| `ecrans/reglages/depots.js:22,61` | fiche d'un dépôt : section « Jobs Jenkins », clic → `openJenkinsJob` | ⚠ `registerAction({target:'repo'})` |
| `ecrans/reviews/rapports.js:267-327` | **logique Jenkins dans l'écran Reviews** : `assurerJenkinsPourCI` (charge la liste une fois par page si configuré), `ciDeLaBranche`, `badgeCI` (badge « dernier build sur cette branche » sur la carte), handler `[data-mr-jenkins]` (ouvre la fiche + `jkPoserParams([{name: param, value: branche}])`), handler `[data-ci-job]` | ⚠ **décorateur de carte MR** (`ctx.ui.registerDecorator({target:'mr', render(mr) → html})`) + `registerAction({target:'mr', when(mr) → mr.verification.verdict==='verified_pass' && !stale})` |
| `ecrans/reviews/liste.js:250,476` | `assurerJenkinsPourCI()` ; bouton « Lancer {job} » sur une MR **vérifiée verte** | idem |
| `ecrans/verification/rapport.js:57-60` | même bouton dans le rapport de vérification (3 MR max) | `registerAction({target:'verification'})` ⚠ |
| `ecrans/git/explorateur.js:94-100` | bouton « Ouvrir le job avec la branche » sur une ligne de branche (`b.jenkins`) | `registerAction({target:'branch'})` ⚠ |
| `ecrans/sessions/reponse.js:178-186,550-570` | `ciDeLaBranche(tg.branch)` → bouton « Reprendre la console » qui lit `/jenkins/console` et remplit le suivi | `registerAction({target:'session'})` + accès à la route du plugin |
| `ecrans/notes/brief.js:17-24,167-180` | section « CI rouge » du brief, calculée depuis `JENKINS.jobs` × mes MR ouvertes ; `assurerJenkinsPourCI()` puis re-rendu | ⚠ `registerBriefSection({ render(contexte) })` — ou événement front `brief.rendered` |
| `ecrans/notes/todos.js:107` | lien de todo `kind:'build'` (`<job>#<n>`) → `openJenkinsJob` ; `notes/notes.js:46 LINK_KINDS` + `CHECK` SQL de la table `todo` | ⚠ **genre de lien de todo déclaré par un plugin** (`registerLinkKind({kind:'build', open})`) ; le `CHECK` de la table du noyau cite `'build'` |
| `ecrans/agents/lancer.js:140` | commentaire seulement (« Enquêter » depuis la console) — le bouton vit dans la modale Jenkins | — |
| `core/champs.js:114`, `css/composants/{formulaire,modale-tailles}.css`, `css/ecrans/agents.css:91`, `css/ecrans/liens.css:73,178`, `css/ecrans/reglages-notifications.css:8` | commentaires, ou règles génériques (`.modal-lg`) nées de Jenkins ; `#jenkinsCount` dans une feuille du noyau | `#jenkinsCount` suit le plugin ; le reste reste |
| `public/index.html` : 1 `<link>`, 2 `<!--@include>`, 1 `<script>` i18n, 5 `<script>` js | manifeste | ⚠ **le manifeste est la seule liste de ce qui se charge** (`check-front.js` (a)) : un bundle chargé dynamiquement est, par construction, « sur le disque, absent du manifeste » |

## 6. Secrets et masquage

| Secret | Stockage | Masquage | Primitive |
|---|---|---|---|
| `jenkins_token` | `local_config` (L) ; jamais exporté ; effacé si l'origine de `jenkins_url` change ; `***` en lecture, `***` en écriture = inchangé, `''` = effacé ; refus d'envoyer le jeton en base vers une autre URL (`exigerJetonFrais`) ; interdit en lecture au sandbox de l'agent (`agent/policy.js:196`, générique : toute la base) | `/api/config` | `ctx.secrets.get/set` avec le même protocole `***` ; ⚠ le lien secret ↔ URL (deux règles) doit être déclaratif |
| `jenkins_user` | `local_config`, classé avec les secrets (`store-registry.js:1753`) | non masqué (`e2e-jenkins.test.js:92`) | `ctx.settings` (local) |
| `JENKINS_CA_CERT`, `JENKINS_INSECURE_TLS` | environnement du serveur, lu au chargement du module | | ⚠ § 2 |
| mots de passe de paramètres de build | jamais rendus (`estSecret`), seulement comptés (`paramsCaches`) | | interne au plugin |

## 7. Tissages inter-features

| Tissage | Sens | Aujourd'hui | Demain |
|---|---|---|---|
| **Vérificateur en fin de session** | — | **Introuvable.** La fin de session déclenche la vérification dans `jobs/apres-session.js` (noyau), sans Jenkins. Jenkins ne lance rien à la fin d'une session ; c'est la *console* d'un build rouge qui remplit un **suivi** de session (§ 5.2, `sessions/reponse.js`) | `session.finished` reste un événement du noyau ; Jenkins ne l'écoute pas |
| **Brief « Aujourd'hui »** → section « CI rouge » | brief lit Jenkins | calcul **front** depuis `JENKINS.jobs` (aucun appel serveur de plus) | `registerBriefSection` (⚠) ou le brief écoute `jenkins.jobs.loaded` côté front |
| **Todos** | todo → build | `LINK_KINDS` + `CHECK` SQL + `data-todo-build` | `registerLinkKind` (⚠) |
| **Notifications bureau** | Jenkins → bureau | `notify.push('jenkins_done')`, case par défaut cochée | `ctx.notify.registerKind` + `ctx.notify.push` |
| **Cartes MR / rapport de vérif / branche Git** | Jenkins → écrans du noyau | jointure serveur (`mrs.js`, `branches.js`) + rendu dans trois écrans | `registerAction` (3 cibles) + `registerDecorator('mr')` |
| **Session** | Jenkins → suivi | bouton « Reprendre la console » | `registerAction('session')` |
| **Fiche de dépôt** | Jenkins → Réglages → Dépôts | `repos.js:81`, `depots.js:22` | `registerAction('repo')` |
| **Palette** | Jenkins → palette | `notes/links.js:846` lit `repo_jenkins` côté serveur | `registerPaletteProvider` serveur |
| **Liens** | Jenkins → Liens | `build-links` appelle `links.liensDeMr` | plugin ↔ futur plugin : `ctx.events` / requête de service (PLUGIN-CANDIDATES § 4) |
| **Démo** | | `src/demo/jenkins.js` (jeu statique, utilisé par les routes) ; `scripts/demo-seed.js:1583` insère 2 lignes `repo_jenkins` ; `demo/jenkins.isDemo()` emprunté par `mrs-commentaires.js` | `ctx.demo.seed(fn)` + `ctx.demo.isDemo()` ; la seed du noyau ne doit plus citer `repo_jenkins` (le plugin sème sa table) |
| **Dépôt de données partagé** | | `config.jenkins_url` est **P** ; `store.js:803 RACINES_RETIREES` et le commentaire « quatre onglets restent à soi » ; `datasync.rattraperFormat` | ⚠ QUESTIONS |
| **Sauvegarde** | | `data/backup.js:122` : texte « jetons (forge, Jira, Jenkins) » | texte générique |
| **Vieille URL `/api/jenkins/*`** | | utilisée par le front, 4 fichiers de test, PLAN.md § API | `/api/plugins/jenkins/*` (prompt) ⚠ change les tests |

## 8. Tests qui couvrent Jenkins (33 fichiers)

**Dédiés (9)** — ils *importent* ou *bouchonnent* du code du noyau, ce qui est le point dur :

| Fichier | Tests | Couplage |
|---|---|---|
| `test/unit-jenkins.test.js` (284 l.) | 15 | `require('../src/integrations/jenkins')` **au premier niveau** ; appelle `lister/detail/lancer/console` + les 10 fonctions exportées pour les tests, contre `helpers/mock-jenkins.js` |
| `test/unit-jenkins-tls.test.js` | 3 | vide `require.cache` de `integrations/jenkins` **et** `core/httpreq`, pose `JENKINS_CA_CERT`/`JENKINS_INSECURE_TLS`, recharge le module : prouve l'agent TLS **du noyau** |
| `test/unit-demo-jenkins.test.js` | 3 | `require('../src/demo/jenkins')`, fige `Date.now` |
| `test/e2e-jenkins.test.js` | 7 | `PUT /api/config {jenkins_url, jenkins_user, jenkins_token}`, `GET /api/config` → `jenkins_token === '***'`, `/api/jenkins/*`, `/api/status.jenkinsRefreshMinutes` bornée |
| `test/e2e-jenkins-ui.test.js` (1 191 l.) | ~30 | Playwright : champs `[name="jenkins_url"]` du `#configForm`, `GET /api/config` relu, onglet, fiche, confirmation, filtres |
| `test/e2e-menu-jenkins-{fiche,liste,liens}.test.js` | ~40 | Playwright, `afficherMenusOptionnels()`, `/api/jenkins/links` |
| `test/e2e-veille.test.js` (bloc Jenkins) | 3 | **monkeypatch** `jenkins.detail`/`jenkins.isConfigured` sur le module du noyau, appelle `veille.tourJenkins({})`, `veille.attendreJenkins` ; lit `notify.since` |
| `test/helpers/mock-jenkins.js` | | faux serveur HTTP (crumb, arbre, console) — réutilisable tel quel |

**Incidents (24)** — ils citent Jenkins au passage : `e2e-settings-tabs`, `e2e-reglages-portee`,
`e2e-menu-reglages-{champs,listes}`, `e2e-premier-lancement` (onboarding), `e2e-portes-contextuelles`,
`e2e-nav-prefs` (menus repliés), `e2e-menu-transverse-{palette,clavier,demo}`, `e2e-menu-notes-{brief-tiers,todos}`,
`e2e-notes-ui`, `e2e-review-publish-ui`, `e2e-formulaires-revue`, `e2e-contraste`, `e2e-liens-4e-passe`,
`e2e-ameliorations`, `e2e-menu-devia-codage`, `e2e-menu-synchro-confiance`, `unit-local-config`
(`jenkins_token` migré vers `local_config`), `unit-store-registry` (jetons dont `jenkins_token`),
`unit-store-complet` (`repo_jenkins` reste local), `unit-datasync`, `helpers/app.js`
(`afficherMenusOptionnels` déplie `jenkins`).

Conséquence, chiffrée : la règle « assertions inchangées, seuls les chemins d'import/câblage
changent » tient pour `unit-jenkins`, `unit-demo-jenkins` et `mock-jenkins` (import vers
`plugins/jenkins/…`). Elle **ne peut pas tenir** telle quelle pour :
- `e2e-veille` (bouchonne le module *dans le processus du serveur* : impossible si le plugin tourne
  dans un worker) ;
- `unit-jenkins-tls` (recharge `core/httpreq` et prouve une convention du noyau que le plugin
  n'exercerait plus s'il embarquait son client) ;
- `e2e-jenkins`, `e2e-jenkins-ui`, `e2e-menu-jenkins-*`, `e2e-menu-reglages-*`, `unit-local-config`,
  `unit-store-registry`, `unit-store-complet` : les **URL** (`/api/jenkins/*`), les **champs**
  (`jenkins_url` dans `/api/config`) et les **tables** (`repo_jenkins`, colonnes de `local_config`)
  sont dans les assertions.

## 9. Synthèse : primitives exigées par Jenkins vs liste fermée du ctx V1

| Dans la liste fermée | Utilisée par Jenkins |
|---|---|
| `events.on/emit` | oui (`jenkins.job.started/finished`) |
| `settings.get/set` + `settingsSchema` | oui (url, user, refresh_minutes) — ⚠ **portée** : `url` est un réglage d'équipe (P) |
| `secrets.get/set` | oui (token) — ⚠ lien secret ↔ URL |
| `db` (préfixe, migrations, P/L/C) | oui (`plugin_jenkins_link`) — ⚠ FK vers `repo` impossible ; migration de `repo_jenkins` |
| `http.router` | oui (9 routes) |
| `schedule/unschedule` | oui (veille 60 s) |
| `ui.registerTab` | oui — ⚠ options : icône SVG, replié d'office, `onOpen`, champ de recherche, liste `j/k`, onboarding, légende de pastille |
| `ui.registerSettingsTab` | oui — ⚠ rendu libre en plus du schéma ; suit le menu |
| `ui.setBadge` | oui — ⚠ valeur objet (compte + échecs) |
| `ui.registerAction({target})` | oui — cibles `mr`, `session` dans la liste ; ⚠ `branch`, `verification`, `repo` à ajouter |
| `notify` | oui — ⚠ `registerKind` (libellé, défaut, action) |
| `log` | oui |
| `demo.seed` | oui + ⚠ `demo.isDemo()` |
| `i18n.register` | oui — ⚠ aussi côté serveur |

| **Hors liste, exigée par Jenkins** | Pourquoi |
|---|---|
| `net.request` (client HTTP sortant avec convention TLS du noyau) | `integrations/jenkins.js:25-31`, `unit-jenkins-tls` |
| `repos` (lecture : existence, liste, `onRemoved`) | `repo_jenkins.repo_id`, `CASCADE`, combo de dépôts dans Réglages |
| `ui.registerDecorator('mr')` | badge CI sur la carte |
| `ui.registerPaletteProvider` (serveur) | entrées `kind:'jenkins'` sans appel réseau |
| `ui.registerBriefSection` | section « CI rouge » |
| `notes.registerLinkKind('build')` | todo → build (+ `CHECK` SQL du noyau) |
| `connections.noteTest` (ou table du plugin + affichage Réglages) | `conn_test` |
| `env.get` | `JENKINS_CA_CERT` |

Rien de tout cela n'est un privilège : chaque ligne est une primitive **publique** manquante, à
ajouter à la liste fermée (ou à refuser explicitement, auquel cas la fonctionnalité correspondante
change — ce que la règle absolue interdit). C'est l'objet des questions.
