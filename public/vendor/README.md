# `public/vendor/` — les bibliothèques tierces, telles qu'elles sont livrées

Mergerie déclare **trois** dépendances runtime (`better-sqlite3`, `express`, `gpt-tokenizer`) et
promet un `npm install` court. Mermaid publié en npm, c'est vingt-trois dépendances directes et
cent vingt-quatre mégaoctets décompressés — alors que le navigateur n'a besoin que d'**un
fichier**. Il est donc posé ici, versionné avec le reste, plutôt qu'installé.

Rien ici n'est modifié à la main : ce sont les fichiers publiés, octet pour octet. Une
modification locale serait invisible à la revue et perdue à la mise à jour suivante.

## mermaid.min.js

| | |
|---|---|
| version | **12.0.0** |
| origine | `https://cdn.jsdelivr.net/npm/mermaid@12.0.0/dist/mermaid.min.js` |
| taille | 5 575 485 octets |
| licence | MIT — © Knut Sveidqvist et les contributeurs de Mermaid |
| chargé | à la demande, seulement quand un rendu contient un bloc ` ```mermaid ` |

Script classique (pas un module) : il pose `window.mermaid`. C'est `dist/mermaid.min.js` qu'il
faut prendre, pas `dist/mermaid.esm.min.mjs` — ce dernier est découpé en fragments chargés
dynamiquement, donc invendorisable en un fichier.

### Mettre à jour

```sh
curl -sSo public/vendor/mermaid.min.js https://cdn.jsdelivr.net/npm/mermaid@<version>/dist/mermaid.min.js
```

Puis relancer `npm test` : `test/e2e-notes-mermaid.test.js` rend un diagramme de chaque type
utilisé par le documentaliste (`flowchart`, `erDiagram`, `sequenceDiagram`) et vérifie qu'un
diagramme incorrect retombe sur son texte source au lieu de casser la page. Mettre à jour le
tableau ci-dessus dans le même commit : la version affichée ici est ce sur quoi s'appuie la
revue.
