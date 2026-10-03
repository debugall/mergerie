# Hello

Un plugin [Mergerie](https://mergerie.dev) — généré par `npm create mergerie-plugin`.

## Ce qu'il fait

Il écoute les événements du cœur (fin de session, review, vérification, merge request découverte…),
les journalise et les montre dans son onglet ; il expose un réglage (`greeting`) et deux routes
sous `/api/plugins/hello/`.

## Développer

```bash
npm install
npm test            # le plugin sous createTestContext, sans Mergerie
```

## Installer dans Mergerie

Réglages → Plugins → « Installer un plugin » (dossier local ou adresse git), puis « Activer ».
Ou copie ce dossier dans `<dataDir>/plugins/hello/` et clique « Rescanner ».

Référence de l'API : docs/plugins/API.md du dépôt Mergerie. Licence : AGPL-3.0-only (voir PUBLISHING.md).
