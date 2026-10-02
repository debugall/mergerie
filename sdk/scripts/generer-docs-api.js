#!/usr/bin/env node
'use strict';
/* `docs/plugins/API.md` (et `en/API.md`) SONT GÉNÉRÉS depuis `sdk/contract.js` : la référence du
   ctx — chaque primitive, sa permission, sa signature, ce qu'elle fait — ne peut pas diverger du
   code, elle en vient. La prose autour (le modèle, les erreurs, les exemples) vit ici, à côté du
   contrat qu'elle commente. `npm run check:plugins` vérifie que le fichier commité est bien celui
   que ce script rend. */
const fs = require('fs');
const path = require('path');
const { CTX, PERMISSIONS, API_VERSION, CIBLES_UI } = require('../contract');

const ROOT = path.join(__dirname, '..', '..');
const cell = (s) => String(s).replace(/\|/g, '\\|');

const TEXTES = {
  fr: {
    titre: '# Référence de l’API du ctx',
    gen: `> Généré depuis \`sdk/contract.js\` (API ${API_VERSION}) par \`sdk/scripts/generer-docs-api.js\` — ne pas éditer à la main. Les exemples cités sont des fichiers de \`docs/plugins/examples/\`, exécutés par la CI.`,
    intro: `Un plugin exporte \`activate(ctx)\` et \`deactivate()\`. Le \`ctx\` est **la liste fermée** de ce qu'il peut faire : il ne porte que les primitives couvertes par les permissions de son \`plugin.json\`, et rien d'autre (il est gelé). Un plugin embarqué, un plugin tiers dans son worker et un plugin sous test (\`createTestContext\`) reçoivent le même ctx, construit par le même code (\`sdk/lib/contexte.js\`).

Toujours présents, sans permission : \`ctx.name\`, \`ctx.version\`, \`ctx.apiVersion\`, \`ctx.log\`, \`ctx.i18n\`.`,
    permissions: '## Permissions',
    permissionsIntro: 'Déclarées dans `plugin.json` → `permissions`. Réglages → Plugins les affiche avant l’activation ; `exec` déclenche un avertissement explicite pour un plugin tiers.',
    primitives: '## Primitives',
    colonnes: '| Primitive | Permission | Signature | Rôle |',
    erreurs: '## Erreurs',
    erreursTexte: `Chaque primitive **lève** (ou rejette) avec un message qui nomme le plugin et la règle enfreinte :

- \`ctx.db.*\` : \`requête refusée : la table « x » n'appartient pas au plugin (préfixe attendu : plugin_<nom>_)\` — aussi pour \`sqlite_master\`, \`ATTACH\`, \`PRAGMA\` hors \`table_info\`/\`index_*\`/\`foreign_key_list\` ;
- \`ctx.http.router.*\` : \`un plugin ne monte rien hors de /api/plugins/<nom>/\` — un chemin doit être relatif et commencer par \`/\` ;
- \`ctx.settings.set\` : \`réglage inconnu : x\`, \`x : nombre attendu\`, \`x : adresse http(s) attendue\`… (statut 400 quand l'écran l'appelle) ;
- \`ctx.events.emit\` : \`non déclaré dans plugin.json (events.emits)\` ;
- \`ctx.notify.push\` : \`genre non déclaré (notify.registerKind)\` ;
- \`ctx.schedule\` : \`intervalle ≥ 1000 ms requis\` ;
- \`ctx.exec\` : \`sous-commande « x » hors liste blanche\`, \`drapeau refusé : --exec\` ;
- \`ctx.env.get\` : \`seules les variables <NOM>_* sont lisibles\` ;
- \`ctx.ui.register*\` : \`id en kebab-case requis\`, \`target hors de …\`, \`déjà déclaré\` ;
- un \`require\` qui mène dans \`src/\` ou dans un autre plugin : \`require('…') refusé — un plugin n'importe rien de src/, il passe par le ctx\`.

Une erreur dans \`activate(ctx)\` met le plugin **en erreur** (le message est affiché dans Réglages → Plugins) et n'empêche pas Mergerie de démarrer. Un \`activate\` qui ne répond pas en 10 s est abandonné (et, pour un plugin tiers, son worker est tué).`,
    cibles: '## Cibles d’action et de décoration',
    ciblesTexte: `\`target\` d'une action ou d'une décoration, et l'objet que le navigateur passe au rendu :

| Cible | Où | Objet reçu par \`render(obj, ctx)\` |
|---|---|---|
| \`mr\` | le menu « ⋯ » d'une carte de merge request | la merge request (\`id\`, \`iid\`, \`repo_id\`, \`source_branch\`, \`verification\`…) |
| \`mr-badge\` | les badges d'une carte de merge request | idem |
| \`session-target\` | le formulaire de suivi d'un projet d'une session | \`{ task, target }\` |
| \`branch\` | une ligne de l'explorateur Git | \`{ branch, repo_id }\` |
| \`verification\` | la suite d'un verdict vert, dans le rapport de vérification | la merge request, \`ctx.verification\` |
| \`repo-sheet\` | la fiche d'un dépôt dans Réglages → Dépôts | la fiche (\`id\`, \`project\`, \`verifiers\`…) |`,
    exemples: '## Exemples',
    exemplesTexte: `- [examples/activate-minimal.js](./examples/activate-minimal.js) — le squelette : réglages, une route, un journal.
- [examples/db-migrations.js](./examples/db-migrations.js) — des tables préfixées et des migrations en avant seulement.
- [examples/events-and-schedule.js](./examples/events-and-schedule.js) — réagir à \`session.finished\`, poser une tâche périodique, notifier.
- [examples/ui-registrations.js](./examples/ui-registrations.js) — un onglet, un sous-onglet de réglages, une action sur une merge request, une entrée de palette.

Chaque exemple est chargé par \`test/unit-plugins-docs.test.js\` sur un \`createTestContext()\` : s'il cesse de fonctionner, la CI le dit.`,
  },
  en: {
    titre: '# The ctx API reference',
    gen: `> Generated from \`sdk/contract.js\` (API ${API_VERSION}) by \`sdk/scripts/generer-docs-api.js\` — do not edit by hand. The examples cited are files under \`docs/plugins/examples/\`, run by the CI.`,
    intro: `A plugin exports \`activate(ctx)\` and \`deactivate()\`. The \`ctx\` is **the closed list** of what it can do: it only carries the primitives covered by the permissions of its \`plugin.json\`, nothing else (it is frozen). A built-in plugin, a third-party plugin in its worker and a plugin under test (\`createTestContext\`) receive the same ctx, built by the same code (\`sdk/lib/contexte.js\`).

Always present, no permission needed: \`ctx.name\`, \`ctx.version\`, \`ctx.apiVersion\`, \`ctx.log\`, \`ctx.i18n\`.`,
    permissions: '## Permissions',
    permissionsIntro: 'Declared in `plugin.json` → `permissions`. Settings → Plugins shows them before activation; `exec` triggers an explicit warning for a third-party plugin.',
    primitives: '## Primitives',
    colonnes: '| Primitive | Permission | Signature | Role |',
    erreurs: '## Errors',
    erreursTexte: `Every primitive **throws** (or rejects) with a message naming the plugin and the rule it broke:

- \`ctx.db.*\`: \`requête refusée : la table « x » n'appartient pas au plugin (préfixe attendu : plugin_<name>_)\` — also for \`sqlite_master\`, \`ATTACH\`, any \`PRAGMA\` other than \`table_info\`/\`index_*\`/\`foreign_key_list\`;
- \`ctx.http.router.*\`: \`un plugin ne monte rien hors de /api/plugins/<name>/\` — a path must be relative and start with \`/\`;
- \`ctx.settings.set\`: \`réglage inconnu : x\`, \`x : nombre attendu\`, \`x : adresse http(s) attendue\`… (status 400 when called from the screen);
- \`ctx.events.emit\`: \`non déclaré dans plugin.json (events.emits)\`;
- \`ctx.notify.push\`: \`genre non déclaré (notify.registerKind)\`;
- \`ctx.schedule\`: \`intervalle ≥ 1000 ms requis\`;
- \`ctx.exec\`: \`sous-commande « x » hors liste blanche\`, \`drapeau refusé : --exec\`;
- \`ctx.env.get\`: \`seules les variables <NAME>_* sont lisibles\`;
- \`ctx.ui.register*\`: \`id en kebab-case requis\`, \`target hors de …\`, \`déjà déclaré\`;
- a \`require\` that leads into \`src/\` or into another plugin: \`require('…') refusé — un plugin n'importe rien de src/, il passe par le ctx\`.

An error in \`activate(ctx)\` puts the plugin **in error** (the message shows in Settings → Plugins) and does not stop Mergerie from starting. An \`activate\` that does not answer within 10 s is abandoned (and, for a third-party plugin, its worker is killed).`,
    cibles: '## Action and decoration targets',
    ciblesTexte: `The \`target\` of an action or a decoration, and the object the browser passes to the render:

| Target | Where | Object received by \`render(obj, ctx)\` |
|---|---|---|
| \`mr\` | the "⋯" menu of a merge request card | the merge request (\`id\`, \`iid\`, \`repo_id\`, \`source_branch\`, \`verification\`…) |
| \`mr-badge\` | the badges of a merge request card | same |
| \`session-target\` | the follow-up form of a session's project | \`{ task, target }\` |
| \`branch\` | a row of the Git explorer | \`{ branch, repo_id }\` |
| \`verification\` | what follows a green verdict, in the verification report | the merge request, \`ctx.verification\` |
| \`repo-sheet\` | a repository's sheet in Settings → Repositories | the sheet (\`id\`, \`project\`, \`verifiers\`…) |`,
    exemples: '## Examples',
    exemplesTexte: `- [examples/activate-minimal.js](./examples/activate-minimal.js) — the skeleton: settings, one route, a log line.
- [examples/db-migrations.js](./examples/db-migrations.js) — prefixed tables and forward-only migrations.
- [examples/events-and-schedule.js](./examples/events-and-schedule.js) — react to \`session.finished\`, set a periodic task, notify.
- [examples/ui-registrations.js](./examples/ui-registrations.js) — a tab, a settings sub-tab, an action on a merge request, a palette entry.

Every example is loaded by \`test/unit-plugins-docs.test.js\` on a \`createTestContext()\`: if it stops working, the CI says so.`,
  },
};

function rendre(lang) {
  const T = TEXTES[lang];
  const out = [T.titre, '', T.gen, '', T.intro, '', T.permissions, '', T.permissionsIntro, '', '| Permission | Ce qu’elle ouvre |'.replace('Ce qu’elle ouvre', lang === 'fr' ? 'Ce qu’elle ouvre' : 'What it opens'), '|---|---|'];
  for (const [k, v] of Object.entries(PERMISSIONS)) out.push(`| \`${k}\` | ${cell(v)} |`);
  out.push('', T.primitives, '', T.colonnes, '|---|---|---|---|');
  for (const [k, v] of Object.entries(CTX)) out.push(`| \`ctx.${k}\` | ${v.permission ? `\`${v.permission}\`` : '—'} | \`${cell(v.signature)}\` | ${cell(v.description)} |`);
  out.push('', T.cibles, '', T.ciblesTexte.replace('…', `… (\`${CIBLES_UI.join('`, `')}\`)`), '', T.erreurs, '', T.erreursTexte, '', T.exemples, '', T.exemplesTexte, '');
  return out.join('\n');
}

function ecrire() {
  const cibles = { fr: path.join(ROOT, 'docs', 'plugins', 'API.md'), en: path.join(ROOT, 'docs', 'plugins', 'en', 'API.md') };
  for (const [lang, f] of Object.entries(cibles)) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, rendre(lang)); }
  return cibles;
}

module.exports = { rendre, ecrire };
if (require.main === module) { const c = ecrire(); console.log(`API.md écrit : ${Object.values(c).join(', ')}`); }
