# L'API des plugins et ses versions

> English version: [en/MIGRATION.md](./en/MIGRATION.md)

## Ce qui est couvert par `apiVersion`

L'`apiVersion` courante est **`1`** (`sdk/contract.js` → `API_VERSION`). Elle couvre :

- chaque primitive du `ctx` ([API.md](./API.md)) : son existence, sa signature, sa permission ;
- chaque événement du cœur ([EVENTS.md](./EVENTS.md)) : son nom et son payload, qui porte `version` ;
- la forme du manifeste (`plugin.json`) ;
- le kit `window.mergerie` ([UI.md](./UI.md)) et les cibles d'action ;
- les règles de données (préfixe, migrations, P/L/C) ([DATA.md](./DATA.md)).

Tout cela a **une seule source** : `sdk/contract.js`. La documentation et les types (`sdk/index.d.ts`)
en sont générés ; `npm run check:plugins` refuse qu'ils divergent.

## Ce qui est une rupture, et ce qui n'en est pas

**Pas une rupture** (même `apiVersion`) : une primitive ajoutée ; un champ ajouté au payload d'un
événement ; une permission ajoutée ; une cible d'action ajoutée ; un nom ajouté au kit ; une
primitive marquée « non éprouvée » qui le devient.

**Rupture** (`apiVersion` incrémentée) : une primitive retirée ou dont la signature change ; un champ
de payload retiré ou renommé, ou dont le sens change — le `version` de l'événement est alors
incrémenté aussi ; une permission retirée ; une règle de données durcie.

## Comment le cœur gère un changement d'`apiVersion`

1. Le cœur annonce la nouvelle version et déclare dans `API_VERSIONS_SUPPORTEES` **les deux** (l'ancienne
   et la nouvelle) pendant une période de compatibilité : **deux versions mineures de Mergerie**,
   ou six mois, le plus long des deux — écrite dans CHANGELOG.md.
2. Pendant cette période, un plugin qui cible l'ancienne version se charge avec un avertissement dans
   Réglages → Plugins ; les primitives retirées lui sont servies par un **adaptateur** documenté ici.
3. Passé la période, l'ancienne version sort de `API_VERSIONS_SUPPORTEES` : le plugin est listé
   **« incompatible »** avec le message `apiVersion « 1 » non supportée par ce Mergerie (supportées : 2)`,
   et **jamais chargé** — ni à moitié ni en mode dégradé.

Un plugin lit `payload.version` dans ses handlers d'événement : c'est ce qui lui permet de
reconnaître un payload d'une autre version pendant la transition.

## Historique

| apiVersion | Mergerie | Changements |
|---|---|---|
| `1` | 2.1 | première version publique : le ctx, les événements, le kit, le SDK |
| `1` (ajouts) | 2.1 | **additifs, même version** : la permission `storage` et `ctx.dataDir` ; les champs `url` et `startedBy` de `jenkins.job.started`, `url`, `duration` et `startedBy` de `jenkins.job.finished` ; l'option `env` de `ctx.exec` |

Primitives présentes mais **non éprouvées** par un plugin embarqué en `1` (leur forme peut encore
changer sans rupture, le temps que Liens, Docker et Git les exercent) : `http.sse` (indisponible depuis
un worker), `exec`, `ui.registerSettingsTab({ schemaForm: true })` seul, `demo.seed` depuis un worker.
