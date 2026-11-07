# Mergerie — Dépendances ajoutées par une MR (spec)

Nov 7, 2026 · @DEBUG-ALL-52

## Intention

Chaque merge request ouverte dit quelles dépendances directes elle ajoute, retire ou change de version — `+2 dépendances` sur la carte, les noms et versions dans le panneau — pour que l'entrée d'un paquet dans le projet se lise avant la review, et non dans un `package.json` perdu au milieu de quatorze fichiers.

C'est la deuxième question devant une merge request produite par un agent, après les tests : un paquet ajouté pour trente lignes, la première bibliothèque venue, un nom qui n'existe pas sur le registre. Personne ne lit le manifeste dans un diff ; la carte le dirait.

Règle produit, non négociable : **une dépendance ajoutée est une ligne de manifeste qui n'existait pas avant**. C'est un fait, lu par comparaison des lignes `−` / `+` d'un diff que la forge envoie déjà, **sans aucun appel d'IA et sans aucun appel réseau de plus**. Rien n'est jugé : le badge compte, le panneau nomme, l'humain décide si ce paquet méritait d'entrer. Rien n'est bloqué, aucune note ne bouge, aucune licence ni vulnérabilité n'est évaluée.

On compte les **dépendances directes** — celles du manifeste, que quelqu'un a choisies — et pas les lockfiles, qui restent neutres : un lockfile bouge pour mille raisons, un manifeste pour une seule.

Nom dans l'interface : **dépendances** (FR) / **dependencies** (EN). Le badge dit `+2 dépendances`, jamais « risque » ni « suspect » : il compte.

## Comportement attendu

Un **manifeste** est un fichier dont le chemin correspond à l'un des motifs de manifestes en vigueur pour le dépôt (défauts : `package.json`, `composer.json`, `requirements*.txt`, `pyproject.toml`, `go.mod`, `Cargo.toml`, `Gemfile`, `pom.xml`, `build.gradle*`, `*.csproj`, à toute profondeur). Dans un manifeste, une **dépendance** est une entrée nommée avec sa contrainte de version, dans une section de dépendances (prod ou dev).

La comparaison du diff d'un manifeste donne trois listes :

- **ajoutée** : le nom apparaît en `+` sans `−` correspondant ;
- **retirée** : le nom apparaît en `−` sans `+` ;
- **changée** : le nom apparaît des deux côtés avec une contrainte différente ; si les deux contraintes se lisent, le passage de majeur (`^3.x` → `^4.x`) est signalé.

Le badge est **accentué quand quelque chose entre, discret quand ça bouge, absent sinon** :

- `+2 dépendances` (accentué, comme « périmé ») dès qu'au moins une dépendance est ajoutée ; avec des retraits ou des changements en plus : `+2 dépendances · 1 majeur`.
- `3 dépendances changées` (discret) pour des changements ou retraits seuls ; `1 majeur` est ajouté au texte s'il y en a.
- Manifeste non touché, ou touché sans qu'aucune ligne de dépendance ne change (une description, un script npm) : rien.
- Diff du manifeste non gardé (relevé antérieur à cette fonctionnalité, liste refusée, manifeste de plus de 200 Ko) : rien — jamais un faux « aucune dépendance ».

Le badge s'affiche à trois endroits, et nulle part ailleurs en v1.

1. **Carte de MR (Reviews, les trois stades)** et en-tête du rapport, dans la ligne des badges après les tests touchés. Clic : un panneau ancré sur la carte, une ligne par dépendance (`nom · contrainte · ajoutée / retirée / a → b`), groupées par manifeste quand il y en a plusieurs (monorepo), section prod ou dev indiquée, et le relevé (`Relevé sur <sha> · il y a 4 min`).
2. **Ligne de projet d'une session de codage (Dev IA)**, dès qu'un commit existe : `2 dépendances ajoutées` (accentué) ou `1 dépendance changée` (discret), calculé sur le diff de la branche de session lu dans le clone. C'est là qu'un suivi « enlève left-pad, écris la fonction » coûte le moins.
3. **Brief du matin** : section « MR qui ajoutent des dépendances » — une ligne par merge request ouverte portant le badge accentué, `!214 · tarification · +2 dépendances · ouverte il y a 2 j`, les plus anciennes d'abord, plafonnée à huit, masquée si vide, écartable par merge request et SHA.

Le badge ne change ni la note, ni le verdict de vérification, ni le classement de la file ; il ne déclenche rien, ne notifie rien et ne bloque jamais `Merger`.

## Données et calcul

**La donnée existe déjà, elle est jetée.** Les deux appels du relevé (`listMrChanges` : GitLab `/merge_requests/:iid/changes` rend `changes[].diff`, GitHub `/pulls/:n/files` rend `files[].patch`) rapportent le diff de chaque fichier ; on y compte les lignes et on ne garde que les chemins. La fonctionnalité consiste à **garder le diff des seuls manifestes** au passage. Aucun appel de plus, aucun appel à l'affichage.

**Table `mr_manifest_diff`** (tranche `22-dependances`) : `mr_id`, `path`, `head_sha`, `diff TEXT`, `fetched_at`. Une ligne par manifeste touché, posée par `releverEtPoser` dans le même geste que `mr_files` ; invalidée avec le SHA de tête (même règle que `mr_file_fetch`) ; purgée avec les données de la merge request fermée. Les trois sources du relevé la remplissent toutes : le diff stocké de la review (déjà un diff unifié complet), le clone (`git diff base...head -- <manifestes>`, aucun réseau), la forge (le diff par fichier qu'elle renvoie). Un diff de manifeste de plus de **200 Ko** n'est pas gardé (`refused = 'too-large'`) : ce n'est plus un manifeste qu'on relit, et la merge request n'affiche rien.

`listMrChanges` évolue d'une ligne : à côté de `paths`, `files`, `additions`, `deletions`, il rend `manifests: [{ path, diff }]` pour les chemins qui matchent les motifs de manifestes passés en argument — le filtre se fait **avant** de jeter le reste, dans le client forge, pour que la mémoire ne porte jamais tous les diffs.

**Analyse**, module `src/review/dependances.js` (même famille que `tests-touches.js`, même interdiction d'importer `agent/`, même test d'import fermé), calculée à l'affichage, jamais stockée :

1. Choisir l'analyseur selon le nom du fichier.
2. Lire les lignes `−` et `+` du diff (les `−−−` / `+++` d'en-tête exclues), en extraire `{ nom, contrainte, section }` quand la ligne est une entrée de dépendance, ignorer le reste.
3. Rapprocher par nom : `+` seul → ajoutée, `−` seul → retirée, les deux → changée (contrainte différente) ou rien (ligne déplacée, contrainte identique). Le passage de majeur est signalé quand les deux contraintes commencent par un entier lisible (`^3.2`, `~3`, `3.x`, `>=3.0`) et que l'entier change ; sinon `majeur : non lisible`, sans autre tentative.

Analyseurs v1, un par écosystème, volontairement ligne à ligne (pas de parse JSON/TOML : un diff ne contient pas le fichier entier) :

| Manifeste | Ce qu'est une ligne de dépendance | Section |
| --- | --- | --- |
| `package.json` | `"nom": "contrainte"` sous `dependencies`, `devDependencies`, `peerDependencies`, `optionalDependencies` (la section se lit par les lignes de contexte du hunk ; sans contexte lisible : `section inconnue`) | prod / dev |
| `composer.json` | idem sous `require`, `require-dev` | prod / dev |
| `requirements*.txt` | `nom[extras]opérateur version` ou `nom` seul ; `-r`, `#`, `--` ignorés | prod |
| `pyproject.toml` | `"nom>=x"` dans `dependencies = [...]` ; `nom = "x"` sous `[tool.poetry.dependencies]` / `[tool.poetry.group.*.dependencies]` | prod / dev |
| `go.mod` | `module v1.2.3` dans `require` ; `// indirect` → ignoré (transitif) | prod |
| `Cargo.toml` | `nom = "x"` ou `nom = { version = "x" }` sous `[dependencies]`, `[dev-dependencies]`, `[build-dependencies]` | prod / dev |
| `Gemfile` | `gem 'nom', 'x'` ; groupe `:test` / `:development` → dev | prod / dev |
| `pom.xml` | `<artifactId>` suivi de `<version>` dans un bloc `<dependency>` ; `<scope>test</scope>` → dev | prod / dev |
| `build.gradle*` | `implementation 'g:a:v'`, `api`, `testImplementation` (→ dev), notation `group: 'g', name: 'a', version: 'v'` | prod / dev |
| `*.csproj` | `<PackageReference Include="nom" Version="x" />` | prod |

Un manifeste touché dont l'analyseur ne reconnaît aucune ligne de dépendance ne produit rien (un `package.json` dont seuls les scripts changent). Un manifeste sans analyseur (motif ajouté par l'équipe pour un écosystème non couvert) produit `manifeste modifié` dans le panneau, sans compte, et le badge ne s'affiche pas.

**Session de codage.** Même analyse sur `git diff --name-status` puis `git diff base...head -- <manifestes>` dans le clone de la session, avec les motifs du dépôt ; rien hors dépôt.

`pourCartes(cfg, { mrIds })` rend le badge prêt à rendre ; `ajoutantDesDependances(cfg, limite)` rend les merge requests du brief ; `pourCible(cfg, cible)` sert la ligne de projet, exactement comme pour les tests touchés.

## Interface

Un seul élément nouveau : le badge de dépendances, dans la ligne des badges de la carte, juste après les tests touchés. Même police, même taille, mêmes deux rendus (accentué / discret) que les tests.

| Situation | Texte (FR) | Texte (EN) | Rendu |
| --- | --- | --- | --- |
| Au moins une ajoutée | `+2 dépendances` | `+2 dependencies` | accentué |
| Ajoutées et un saut de majeur | `+2 dépendances · 1 majeur` | `+2 dependencies · 1 major` | accentué |
| Changées ou retirées seulement | `3 dépendances changées` | `3 dependencies changed` | discret |
| Changées avec saut de majeur | `3 dépendances changées · 1 majeur` | `3 dependencies changed · 1 major` | discret |
| Manifeste touché, aucune entrée de dépendance | aucun badge | aucun badge | — |
| Manifeste non touché, diff non gardé, refusé | aucun badge | aucun badge | — |

Singulier au singulier : `+1 dépendance`, `1 dépendance changée`.

**Panneau** (clic sur le badge, ancré sur la carte, fermé par Échap ou clic ailleurs) :

- Titre : `Dépendances` ; sous-titre : `2 ajoutées · 1 changée · 1 retirée`.
- Une section par manifeste touché quand il y en a plusieurs (`packages/api/package.json`), sinon pas d'en-tête.
- Une ligne par dépendance, en monospace : `left-pad  ^1.3.0  ajoutée · prod`, `axios  ^0.27.2 → ^1.7.0  majeur · prod`, `moment  retirée · dev`. Les ajoutées d'abord, puis les changées, puis les retirées ; dans chaque groupe, l'ordre du fichier.
- Un manifeste sans analyseur : `manifeste modifié (non analysé)`, rien d'autre.
- Un lien `Motifs de manifestes : dépôt / groupe / défaut` qui ouvre le réglage, comme pour les tests.
- Pied : `Relevé sur <sha court> · il y a 4 min`.

Aucun lien vers npm, Packagist ou un registre en v1 : un lien dit implicitement « va vérifier là », et l'outil ne recommande rien. Le nom se copie.

**Ligne de projet (session de codage)** : `2 dépendances ajoutées` (accentué) ou `1 dépendance changée` (discret), après les tests modifiés, dès l'état *commité*. Sans dépôt : rien.

**Brief** : section « MR qui ajoutent des dépendances », après « MR sans test » ; une ligne par merge request : `!214 · tarification · +2 dépendances · ouverte il y a 2 j`. Clic : la merge request dans Reviews. Croix d'écartement au survol.

**Rapport de review** : le badge est repris dans l'en-tête, comme les deux autres. Le contenu du panneau n'est **pas** injecté dans le prompt de review en v1 : la review lit déjà le diff complet, manifeste compris.

## Réglages et garanties

Deux réglages dans Réglages → Merge Request → Découverte, sous ceux des tests touchés, badgés « équipe » ; la liste de motifs est **aussi** éditable sur un dépôt et sur un groupe, au même endroit que les motifs de tests.

| Réglage | Colonne | Défaut | Rôle |
| --- | --- | --- | --- |
| Afficher les dépendances | `config.deps_enabled` | coché | Interrupteur général ; décoché, aucun diff de manifeste gardé et aucun badge |
| Motifs de manifestes | `config.manifest_patterns`, `repo_group.manifest_patterns`, `repo.manifest_patterns` | les défauts livrés | Un glob par ligne ; vide = hérite du niveau au-dessus ; même résolution dépôt → groupe(s) → global → défauts que les tests |

`Remettre les défauts` et le même aperçu que pour les tests : « Sur les MR ouvertes de ce dépôt, ces motifs désignent 3 manifestes ». Le lockfile n'a pas de réglage : il reste dans les motifs neutres des tests touchés, et cette fonctionnalité ne le lit pas.

Garanties, écrites pour être testées :

- **Aucun appel d'IA**, aucun token. `dependances.js` n'importe rien de `agent/` ; test d'import fermé.
- **Aucun appel réseau de plus.** Le nombre d'appels forge par tour de découverte est inchangé : les diffs de manifestes sortent des appels déjà faits. L'affichage lit `mr_manifest_diff`.
- **Aucun appel vers un registre** (npm, Packagist, PyPI…). Pas d'existence, pas d'âge, pas de licence, pas de CVE en v1.
- **Jamais de faux « rien ».** Diff non gardé → pas de badge ; manifeste sans analyseur → `manifeste modifié (non analysé)` dans le panneau, pas de compte inventé ; majeur non lisible → dit tel quel.
- **Rien n'est décidé.** Pas de blocage, pas de note, pas de règle créée, pas de notification, pas de lien « va vérifier ».
- **Le diff d'un manifeste est la seule chose conservée** — jamais celui des autres fichiers. Un test vérifie que `mr_manifest_diff` ne contient que des chemins qui matchent les motifs.
- **Les motifs sont de l'équipe** et voyagent avec le dépôt de données partagé, comme les motifs de tests.
- **La démo** montre une MR `+2 dépendances · 1 majeur` sur `groupe/tarification` (un ajout de `left-pad`, un passage `axios ^0.27 → ^1.7`) et une MR avec un `package.json` dont seuls les scripts changent, sans badge.

Refus explicites : un glob invalide est refusé à l'enregistrement avec sa ligne ; un diff de manifeste de plus de 200 Ko n'est pas gardé et le survol du bouton ⋯ dit `dépendances non relevées · manifeste trop gros` ; une merge request relevée avant cette version n'a pas de diff de manifeste et n'affiche rien jusqu'au prochain relevé — le tour suivant la reprend sous le plafond habituel, comme un SHA qui a bougé, et le journal le dit une fois (`N MR à relever pour les dépendances`).

## Hors périmètre v1

La v1 lit des lignes de manifeste. Tout ce qui suit est exclu, et ne doit pas apparaître « en passant ».

- **Pas de registre.** Ni existence du paquet, ni date de publication, ni téléchargements, ni mainteneurs. C'est la suite la plus tentante (un nom inventé, un paquet publié il y a trois jours) et c'est un fait aussi — mais c'est du réseau vers npm, Packagist, PyPI à la découverte, donc une v2 avec son propre réglage, décoché par défaut, et son propre plafond.
- **Pas de licence, pas de CVE, pas de score.** D'autres outils le font avec des bases qu'ils maintiennent ; Mergerie compte.
- **Pas de lockfile.** Ni les dépendances transitives, ni « le lockfile a bougé sans le manifeste » (dérive) — à discuter en v2, c'est un fait utile mais un autre.
- **Pas de parse complet des manifestes** (JSON, TOML, XML). Le diff ne contient pas le fichier ; les analyseurs lisent des lignes et disent quand ils ne lisent pas.
- **Pas de contenu injecté dans le prompt de review** : la review voit déjà le diff.
- **Pas de règle de review ni de consigne générée** à partir du badge. Si l'équipe refuse les ajouts sans discussion, elle l'écrit dans ses consignes ; le badge dit seulement qu'il y en a eu.
- **Pas de statistiques** (dépendances ajoutées par mois, par dépôt, par auteur ou agent). Suite naturelle dans Stats, sans auteur en première version.
- **Pas de badge sur les sessions hors dépôt** ni sur les explorations ; pas de filtre dans la file.

Suites possibles, dans cet ordre si la v1 sert : le registre (existence et âge, réglage à part) ; la dérive de lockfile ; la part de MR ajoutant des dépendances par dépôt dans Stats ; un filtre dans la file.

## Tests, documentation, acceptation

**Tests** (même style que `tests-touches` : unitaires sur les analyseurs, intégration sur le relevé avec une forge simulée, carte et brief sur la base de démo). Les diffs de manifestes de test vivent dans `test/fixtures/manifests/`, un fichier par cas :

- [ ] `package.json` : `+ "left-pad": "^1.3.0"` sous `dependencies` → 1 ajoutée, prod ; sous `devDependencies` → dev ; hunk sans ligne de contexte de section → `section inconnue`.
- [ ] `package.json` : `− "axios": "^0.27.2"` / `+ "axios": "^1.7.0"` → 1 changée, majeur ; `^1.6` → `^1.7` → changée, pas majeur ; `"*"` → `"^2"` → changée, majeur non lisible.
- [ ] `package.json` : seule la ligne `"description"` ou un script change → aucune dépendance, aucun badge.
- [ ] Ligne déplacée (`−` et `+` identiques) → rien.
- [ ] `composer.json` `require` / `require-dev` ; `requirements.txt` avec `-r base.txt` et `#` ignorés ; `go.mod` avec `// indirect` ignoré ; `Cargo.toml` table et inline ; `Gemfile` groupe `:test` → dev ; `pom.xml` `<scope>test</scope>` → dev ; `build.gradle` `testImplementation` → dev ; `.csproj` `PackageReference`.
- [ ] Monorepo : deux `package.json` touchés → deux sections dans le panneau, compte total sur le badge.
- [ ] Diff de manifeste de 201 Ko → non gardé, `refused = 'too-large'`, aucun badge, survol du bouton ⋯ renseigné.
- [ ] Motif ajouté pour un manifeste sans analyseur → `manifeste modifié (non analysé)`, pas de badge.
- [ ] `mr_manifest_diff` ne reçoit que des chemins matchant les motifs (test sur le relevé des trois sources : review, clone, forge).
- [ ] Nombre d'appels forge par tour inchangé avec la fonctionnalité activée (forge simulée comptée).
- [ ] SHA de tête changé → diff invalidé, badge absent jusqu'au relevé suivant, puis de retour.
- [ ] `deps_enabled = 0` → rien gardé, rien affiché.
- [ ] Le module n'importe aucun module d'agent (import fermé).
- [ ] Ligne de projet d'une session : diff base...head avec un ajout → `1 dépendance ajoutée` ; avant le commit → rien.
- [ ] Brief : section absente sans MR concernée, plafonnée à huit, l'écartement retient la MR et le SHA.
- [ ] Démo : `groupe/tarification` montre `+2 dépendances · 1 majeur` et un `package.json` sans badge.

**Documentation**, dans le même geste que le code :

- [ ] `docs/guide.fr.md` et `docs/guide.en.md` : un paragraphe dans Reviews après les tests touchés, la ligne de projet dans Dev IA, l'entrée du brief, les réglages dans Réglages → Merge Request et dans Dépôts / Groupes, la liste des manifestes reconnus.
- [ ] `README.md` et `README.fr.md` : la ligne Reviews de « What it does » dit désormais les trois faits (croisements, tests, dépendances) en une phrase.
- [ ] `CHANGELOG.md` : une entrée sous la prochaine version mineure, sur le modèle des deux précédentes.
- [ ] `PLAN.md` : la table `mr_manifest_diff`, son cycle de vie (relevé, invalidation, purge) et la liste des analyseurs.

**Critères d'acceptation** :

1. Aucun appel forge ni registre supplémentaire : le compteur d'appels par tour de découverte est identique avant et après, fonctionnalité activée.
2. L'affichage de la file avec les trois badges reste sous 100 ms côté serveur sur 150 MR ouvertes.
3. Aucun token d'IA consommé, vérifiable dans Stats.
4. Sur les dix manifestes couverts, chaque fixture produit le résultat attendu ; un manifeste inconnu ne produit jamais un compte.
5. Une capture de carte avec `+2 dépendances · 1 majeur` à côté d'une note de 8/10 suffit à comprendre la fonctionnalité sans légende.
