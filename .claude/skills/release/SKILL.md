---
name: release
description: Prépare une nouvelle version de Mergerie — décide le numéro SemVer, met à jour CHANGELOG / package.json / documentation FR et EN / ROADMAP, lance les contrôles, puis prépare la fusion develop → main et le tag. À utiliser quand l'utilisateur demande de préparer, sortir ou publier une release.
---

# Préparer une release de Mergerie

Ce projet publie depuis `develop` vers `main`, avec un tag `vX.Y.Z`. Ce qui suit est la
procédure réelle du dépôt, pas une recette générique.

## Contraintes du projet à ne jamais enfreindre

- **Ne jamais pousser.** L'utilisateur pousse lui-même, y compris `main` et le tag.
- **Commits signés DCO** : toujours `git commit -s`. Message **d'une seule ligne, en anglais**,
  sans `Co-Authored-By`.
- **GitLab `gitlab.com/amady/mergerie` est la source de vérité** (remote `origin`).
  **GitHub `github.com/debugall/mergerie` est un miroir** (remote `github`) : on n'y merge jamais.
- **Pas de CI GitLab** — ne pas proposer d'en créer une. La CI vit sur GitHub Actions
  (`.github/workflows/ci.yml`), déclenchée sur `main` et sur les pull requests.
- Le port **4319** est l'instance réelle de l'utilisateur : ne jamais la démarrer, l'arrêter ni
  y écrire. La démo tourne sur un autre port, avec `MERGERIE_DATA_DIR=data-demo`.

## 0. Établir l'état des lieux

```bash
git branch -vv                       # où en sont develop et main
git log --oneline main..develop | wc -l
grep -n '"version"' package.json
git tag | tail -3
```

Lire la section `## [Unreleased]` de `CHANGELOG.md` : c'est le contenu de la release.

## 1. Choisir le numéro (SemVer)

Se décider **d'après le contenu de `[Unreleased]`**, pas d'après l'ampleur ressentie :

- **Majeur** — une entrée décrit un changement qui casse l'existant : configuration à refaire,
  donnée à migrer, comportement retiré.
- **Mineur** — de nouvelles capacités additives (le cas courant ici : un onglet, une forge,
  un mode de session).
- **Correctif** — uniquement des entrées `Fixed`.

Annoncer le numéro retenu **et sa raison** avant de modifier quoi que ce soit.

## 2. Documentation — le point qui se périme en silence

L'anglais et le français sont **deux jeux de fichiers distincts** : rien ne les synchronise, et
c'est le français qui prend du retard. Passer les quatre, dans cet ordre :

| Fichier | Ce qu'il faut y vérifier |
|---|---|
| `CHANGELOG.md` | chaque nouveauté du cycle y a bien une entrée, **écrite pour qui utilise l'outil** |
| `README.md` / `README.fr.md` | la liste des onglets et le paragraphe transversal décrivent la version qui sort |
| `docs/guide.fr.md` | le détail par onglet — c'est le fichier le plus long et le plus oublié |
| `PLAN.md` | l'architecture, si des modules ou des mécanismes ont bougé |
| `ROADMAP.md` | retirer ou marquer ✅ ce qui vient d'être livré |

Méthode fiable : reprendre `[Unreleased]` **entrée par entrée** et chercher chaque
fonctionnalité dans le guide FR (`grep -i`). Une entrée absente du guide est une section à
écrire. Guetter aussi les passages devenus **faux** — une phrase qui décrit l'ancien
comportement fait plus de dégâts qu'une absence.

## 3. Basculer le CHANGELOG

Dans `CHANGELOG.md` :

1. Insérer `## [X.Y.Z] - AAAA-MM-JJ` juste sous `## [Unreleased]`, en laissant `[Unreleased]`
   **vide** au-dessus (le contenu existant devient celui de la version).
2. En bas du fichier, mettre à jour les liens :
   ```
   [Unreleased]: https://github.com/debugall/mergerie/compare/vX.Y.Z...HEAD
   [X.Y.Z]: https://github.com/debugall/mergerie/compare/v<précédente>...vX.Y.Z
   ```

## 4. Version du paquet

```bash
npm version X.Y.Z --no-git-tag-version    # met à jour package.json ET package-lock.json
```

Le flag est indispensable : `npm version` créerait sinon un commit et un tag non signés DCO.

## 5. Contrôles

```bash
npm run check     # garde-fous front + parité i18n
npm test          # doit être vert en totalité
```

Puis un passage **réel** en mode démo — c'est ce qui attrape ce que les tests ne voient pas
(un rendu cassé, une clé i18n manquante à l'écran, une donnée de seed incohérente) :

```bash
node scripts/demo-seed.js
MERGERIE_DEMO=1 MERGERIE_DATA_DIR=data-demo COPILOT_DRY_RUN=1 PORT=<port libre> node src/server.js
```

Ouvrir **les sept onglets**, vérifier l'absence d'erreur console, et regarder les écrans
touchés par la release. Ne jamais lancer la démo sans `MERGERIE_DATA_DIR=data-demo` : elle
écrirait dans les données réelles.

Commiter le tout en une fois : `git commit -s -m "Prepare release X.Y.Z"`.

## 6. Fusion et tag — puis s'arrêter

```bash
git checkout main
git merge --no-ff develop -m "Release X.Y.Z"
git tag -a vX.Y.Z -m "X.Y.Z"
git checkout develop
```

**S'arrêter là.** Annoncer à l'utilisateur ce qui lui reste à faire :

```bash
git push origin main --follow-tags     # GitLab ; le miroir GitHub suit
```

## 7. Notes de release

Proposer un texte tiré de la section `[X.Y.Z]` du CHANGELOG — trois à cinq points, les
nouveautés visibles d'abord, les correctifs ensuite. Elles se publient sur GitLab
(*Releases*) et, si l'utilisateur le souhaite, sur GitHub.

## Rendre compte honnêtement

À la fin, dire **ce qui a été vérifié et comment** : ce que couvrent les tests, ce qui n'a été
regardé qu'à l'écran, et ce qui n'a pas pu l'être. Ne jamais présenter un fichier de
documentation comme relu s'il ne l'a été qu'en diagonale.
