# Créer son premier plugin

> English version: [en/GETTING-STARTED.md](./en/GETTING-STARTED.md)

Prérequis : Node 22, et un clone de Mergerie (pour le SDK, tant qu'il n'est pas publié sur npm :
`sdk/` du dépôt est `@mergerie/plugin-sdk`).

## 1. Générer le squelette

```bash
node sdk/scripts/creer-plugin.js mon-plugin            # → ./mergerie-plugin-mon-plugin/
# ou, une fois le SDK publié : npm create mergerie-plugin mon-plugin
```

Le dossier produit contient :

```
mergerie-plugin-mon-plugin/
  plugin.json          le manifeste : nom, version, apiVersion, permissions, settingsSchema, ui
  index.js             activate(ctx) / deactivate()
  ui/i18n.js           le dictionnaire fr/en (clés préfixées « mon-plugin. »)
  ui/main.js           le front : évalué avec le kit window.mergerie en portée
  ui/html/onglet.html  le panneau de l'onglet
  test/plugin.test.js  le plugin sous createTestContext, sans Mergerie
  README.md, package.json, .github/workflows/ci.yml
```

C'est **exactement** ce que `plugins/hello/` contient : le générateur produit un plugin qui marche.

## 2. Lire `index.js`

```js
async function activate(ctx) {
  ctx.i18n.register('fr', require('./ui/i18n').fr);        // libellés, serveur et navigateur
  ctx.db.migrate(MIGRATIONS);                               // ses tables, plugin_mon_plugin_*
  ctx.ui.registerTab({ id: 'mon-plugin', label: 'Mon plugin', icon: 'i-plug' });
  ctx.events.on('session.finished', (p) => ctx.log(`session ${p.id} : ${p.status}`));
  ctx.http.router.get('/ping', () => ({ ok: true, greeting: ctx.settings.get('greeting') }));
}
```

Le `ctx` ne porte que les primitives des **permissions déclarées** dans `plugin.json` ; une
primitive absente est `undefined`. La référence complète : [API.md](./API.md).

## 3. Tester sans lancer Mergerie

```bash
cd mergerie-plugin-mon-plugin && npm install && npm test
```

`createTestContext()` (ou `activatePlugin(dir)`) rend un ctx **en mémoire** : une base SQLite avec le
socle des plugins, un bus d'événements, un dictionnaire, un registre d'écran, une horloge que le test
avance à la main (`tick()`), un routeur qu'on appelle directement (`http.call('GET', '/ping')`) ou
qu'on monte sur Express (`http.express()` pour supertest). Le même code construit le ctx du serveur :
ce que votre test prouve vaut pour Mergerie.

```js
const { activatePlugin } = require('@mergerie/plugin-sdk');
const t = await activatePlugin(path.join(__dirname, '..'));
await t.emit('session.finished', { kind: 'task', id: 1, action: 'run', status: 'done' });
assert.equal((await t.http.call('GET', '/events')).body.events.length, 1);
await t.deactivate();
```

Voir [examples/](./examples/) — quatre exemples que la CI de Mergerie exécute.

## 4. Installer dans son Mergerie

- Réglages → Plugins → **Installer un plugin** → le chemin du dossier (ou son adresse git), puis **Activer** ;
- ou copier le dossier dans `<dataDir>/plugins/mon-plugin/` et **Rescanner**.

Un plugin tiers tourne dans un worker, désactivé tant que vous ne l'activez pas. Après une modification
du code : **Rescanner** signale la nouvelle version ; désactiver puis réactiver la charge (les migrations
de tables sont rejouées en avant seulement).

## 5. Les règles qui font échouer le chargement

- `apiVersion` inconnue → « incompatible », jamais chargé ;
- un `require` qui mène dans `src/` de Mergerie ou dans un autre plugin → refusé ;
- une table hors `plugin_<nom>_`, une route hors `/api/plugins/<nom>/`, un réglage hors schéma, un
  événement émis non déclaré → refusés avec un message qui nomme la règle ;
- `activate()` qui lève ou ne répond pas en 10 s → le plugin est « en erreur », Mergerie démarre quand même.

Ensuite : [UI.md](./UI.md) pour l'écran, [DATA.md](./DATA.md) pour les tables,
[PUBLISHING.md](./PUBLISHING.md) pour partager.
