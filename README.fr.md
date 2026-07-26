> 🇬🇧 **English:** [README.md](./README.md) · 📖 [Guide complet](./docs/guide.fr.md) · 🗺️ [Roadmap](./ROADMAP.md)

# Mergerie

[![CI](https://github.com/debugall/mergerie/actions/workflows/ci.yml/badge.svg)](https://github.com/debugall/mergerie/actions/workflows/ci.yml)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](./LICENSE)

**From prompt to merge — un cockpit de dev local, assisté par IA, pour GitLab et GitHub.**

Outil local (mono-utilisateur) pour **reviewer les merge requests GitLab et les pull requests GitHub** assisté par IA, **piloter des
sessions de développement** automatisées (l'IA code, commite, pousse, ouvre et merge les MR) et **explorer
du code** en lecture seule pour répondre à une question, via un CLI d'agent (`copilot` / `claude`) et le
skill `git-review`.

Dans toute la documentation, **« MR »** désigne indifféremment une *merge request* GitLab ou une
*pull request* GitHub : les écrans et les actions sont les mêmes.

Tout tourne **en local** : un serveur Node + SQLite + une interface web. Aucune donnée n'est envoyée
ailleurs que vers les services que **tu** configures. L'IA **prépare** (review, corrections, convergence),
c'est **toi** qui merges. Voir [PLAN.md](./PLAN.md) pour l'architecture détaillée, et le
**[Guide complet](./docs/guide.fr.md)** pour le détail de chaque onglet.

## Démarrage

Nécessite **Node 22.9+**.

```bash
npm install
npm start          # http://localhost:4319
```

Au premier lancement, l'onglet **Reviews** affiche les trois étapes de démarrage, chacune avec son
bouton. Elles correspondent à l'onglet **Réglages** :
1. **Git** — URL GitLab + **access token** (PAT scopes `api` + `read_repository`) et/ou **token GitHub** (scope `repo`), dossier de clonage. Un bouton **Tester la connexion** par forge valide le tout. *(URL Jira et connexion Jira optionnelles : onglet **Jira**.)*
2. **Dépôts** — ajoute-les un par un, ou en masse **depuis GitLab** ou **depuis GitHub** (coche tes projets). Laisse le **pattern vide** pour prendre **toutes** les MR, ou mets un fragment (`PROJ-`) pour ne garder que ces branches.
3. De retour sur **Reviews**, `Chercher les nouvelles MR` remplit la liste.

## Mode démo (voir l'outil en 30 s, sans rien configurer)

```bash
npm run demo          # http://localhost:4319
```

Sème une base **fictive mais réaliste** (MR à traiter, rapports notés, suivi de résolution, statistiques,
coût en tokens, sessions Dev IA, codage hors dépôt) dans `data-demo/` — **isolée** de ta vraie base
`data/` — puis lance l'outil dessus, en dry-run et **sans aucune connexion à une forge ni token**. Idéal pour
découvrir l'outil : **zéro configuration**. La démo inclut une **MR convergée** (5,8 → 7,1 → 8,4) pour voir
la feature *Converger* en action, et une **session reliée à sa MR** — le chemin *du prompt à la MR convergée*.

*(Enregistrer une vidéo de présentation : voir le [Guide complet → Mode démo](./docs/guide.fr.md#enregistrer-une-vidéo-de-présentation-prête-pour-youtube).)*

## Les onglets

**Sept onglets** — détail de chacun dans le **[Guide complet](./docs/guide.fr.md#les-onglets-en-détail)** :

- **Reviews** — les trois stades d'une MR (à traiter · reviewées · traitées), review IA notée et versionnée,
  re-review incrémentale et **boucle de convergence autonome** (review → correction → re-review jusqu'au seuil).
- **Dev IA** — sessions de codage automatisées (l'IA code, commite, pousse, ouvre la MR), **codage hors dépôt**
  et **exploration** de code en lecture seule ; *du prompt à la MR convergée* en un bouton.
- **Statistiques** — funnel des MR, évolution des notes, taux de résolution par projet, coût en tokens.
- **Git** — opérations multi-dépôts (branches, tags, commandes git) sur les deux forges, navigation de branches
  et recherche de refs, suppressions **restaurables**, tout **avec aperçu**.
- **Docker** — état des projets compose (drift `.env`, santé), actions par lot, **logs live** multi-containers,
  badges d'erreur dans le menu.
- **Jira** — tes tickets récupérés automatiquement, détail + pièces jointes, changement d'état et commentaires.
- **Réglages** — connexions GitLab / GitHub / Jira, dépôts, règles de review, templates de prompt, thème et langue.

Les badges signalent le **travail en attente** (MR à traiter, sessions non lancées), pas des totaux.

## Sécurité (résumé)

L'outil est **local et mono-utilisateur** : pas d'authentification, et par défaut le serveur **n'écoute que
sur `localhost`** (`127.0.0.1`). L'exposer (`HOST=0.0.0.0`) est un **opt-in explicite** à réserver à un réseau
de confiance. L'agent IA tourne en mode « yolo » (permissions désactivées) pour pouvoir coder — son rayon
d'action nominal est le clone de travail, mais pendant une session de codage il a **les droits de l'utilisateur**
sur la machine : à connaître avant usage. Les **secrets** (PAT GitLab, token GitHub, jeton Jira) sont stockés en local et
**jamais renvoyés en clair**. Exécution **sans shell**, garde-fous **anti-injection** (git / Docker / Jira /
chemins), rendu **anti-XSS**, opérations destructrices **restaurables** et **jamais de merge automatique**.

→ **[Modèle de sécurité détaillé](./docs/guide.fr.md#sécurité)** · Signaler une vulnérabilité : [SECURITY.md](./SECURITY.md)

## Contribuer

Le développement se fait sur **[GitLab](https://gitlab.com/amady/mergerie)** : les merge requests y sont
ouvertes et **reviewées par Mergerie lui-même**. Le dépôt **[GitHub](https://github.com/debugall/mergerie)**
est un miroir synchronisé — les issues y sont les bienvenues. Voir [CONTRIBUTING.md](./CONTRIBUTING.md).

## Licence

**GNU AGPL-3.0-only** — voir [LICENSE](./LICENSE). En bref : tu peux utiliser, modifier et
redistribuer le code, mais toute version modifiée **mise à disposition via un réseau** (SaaS inclus)
doit rendre son code source disponible sous la même licence.
