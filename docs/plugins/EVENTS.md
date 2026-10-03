# Les événements

> Généré depuis `sdk/contract.js` (API 1) par `sdk/scripts/generer-docs-events.js` — ne pas éditer à la main.

Un événement est un nom (`domaine.action`) et un payload **sérialisable** qui porte toujours `version`. Les handlers tournent en file, chacun sous try/catch et délai (30 s) : un abonné qui échoue est journalisé, jamais propagé. Un plugin s’abonne avec `ctx.events.on(name, handler)` et émet les siens (déclarés dans `plugin.json` → `events.emits`) avec `ctx.events.emit(name, payload)`.

| Événement | Version | Source | Quand |
|---|---|---|---|
| [`app.ready`](#appready) | 1 | cœur | le serveur écoute et les plugins sont activés |
| [`app.shutdown`](#appshutdown) | 1 | cœur | le serveur s’arrête (avant la désactivation des plugins) |
| [`repo.deleted`](#repodeleted) | 1 | cœur | un dépôt suivi est retiré de Réglages → Dépôts |
| [`session.started`](#sessionstarted) | 1 | cœur | une session (codage, exploration, hors dépôt, question) commence à tourner |
| [`session.finished`](#sessionfinished) | 1 | cœur | une session a fini de tourner (succès, erreur, arrêt, question posée) |
| [`mr.created`](#mrcreated) | 1 | cœur | une merge request devient connue de Mergerie (découverte sur la forge) |
| [`review.completed`](#reviewcompleted) | 1 | cœur | un rapport de review est enregistré |
| [`converge.finished`](#convergefinished) | 1 | cœur | une boucle de convergence s’arrête |
| [`verify.finished`](#verifyfinished) | 1 | cœur | une vérification objective a rendu son verdict (ou échoué) |
| [`jenkins.job.started`](#jenkinsjobstarted) | 1 | plugin jenkins | un build est lancé depuis Mergerie |
| [`jenkins.job.finished`](#jenkinsjobfinished) | 1 | plugin jenkins | un build lancé depuis Mergerie s’est terminé |

## `app.ready`

**Quand** : le serveur écoute et les plugins sont activés. **Source** : cœur. **Version** : 1.

| Champ | Type |
|---|---|
| `port` | `number` |
| `host` | `string` |
| `demo` | `boolean` |

```json
{
  "version": 1,
  "port": 42,
  "host": "host-example",
  "demo": true
}
```

## `app.shutdown`

**Quand** : le serveur s’arrête (avant la désactivation des plugins). **Source** : cœur. **Version** : 1.

_(aucun champ en dehors de `version`)_

```json
{
  "version": 1
}
```

## `repo.deleted`

**Quand** : un dépôt suivi est retiré de Réglages → Dépôts. **Source** : cœur. **Version** : 1.

| Champ | Type |
|---|---|
| `id` | `number` |
| `project` | `string` |

```json
{
  "version": 1,
  "id": 42,
  "project": "project-example"
}
```

## `session.started`

**Quand** : une session (codage, exploration, hors dépôt, question) commence à tourner. **Source** : cœur. **Version** : 1.

| Champ | Type |
|---|---|
| `kind` | `"task" | "local" | "ask"` |
| `id` | `number` |
| `action` | `string` |

```json
{
  "version": 1,
  "kind": "task",
  "id": 42,
  "action": "action-example"
}
```

## `session.finished`

**Quand** : une session a fini de tourner (succès, erreur, arrêt, question posée). **Source** : cœur. **Version** : 1.

| Champ | Type |
|---|---|
| `kind` | `"task" | "local" | "ask"` |
| `id` | `number` |
| `action` | `string` |
| `status` | `"done" | "error" | "stopped" | "needs_input"` |

```json
{
  "version": 1,
  "kind": "task",
  "id": 42,
  "action": "action-example",
  "status": "done"
}
```

## `mr.created`

**Quand** : une merge request devient connue de Mergerie (découverte sur la forge). **Source** : cœur. **Version** : 1.

| Champ | Type |
|---|---|
| `mr_id` | `number` |
| `iid` | `number` |
| `project` | `string` |
| `title` | `string` |

```json
{
  "version": 1,
  "mr_id": 42,
  "iid": 42,
  "project": "project-example",
  "title": "title-example"
}
```

## `review.completed`

**Quand** : un rapport de review est enregistré. **Source** : cœur. **Version** : 1.

| Champ | Type |
|---|---|
| `mr_id` | `number` |
| `iid` | `number` |
| `note10` | `number | null` |

```json
{
  "version": 1,
  "mr_id": 42,
  "iid": 42,
  "note10": 42
}
```

## `converge.finished`

**Quand** : une boucle de convergence s’arrête. **Source** : cœur. **Version** : 1.

| Champ | Type |
|---|---|
| `mr_id` | `number` |
| `iid` | `number` |
| `status` | `string` |
| `note10` | `number | null` |
| `passes` | `number` |

```json
{
  "version": 1,
  "mr_id": 42,
  "iid": 42,
  "status": "status-example",
  "note10": 42,
  "passes": 42
}
```

## `verify.finished`

**Quand** : une vérification objective a rendu son verdict (ou échoué). **Source** : cœur. **Version** : 1.

| Champ | Type |
|---|---|
| `verification_id` | `number` |
| `verdict` | `string` |

```json
{
  "version": 1,
  "verification_id": 42,
  "verdict": "verdict-example"
}
```

## `jenkins.job.started`

**Quand** : un build est lancé depuis Mergerie. **Source** : plugin jenkins. **Version** : 1.

| Champ | Type |
|---|---|
| `path` | `string` |
| `since` | `number` |
| `parameters` | `Record<string, string>` |
| `url` | `string` |
| `startedBy` | `string` |

```json
{
  "version": 1,
  "path": "path-example",
  "since": 42,
  "parameters": {
    "BRANCH": "main"
  },
  "url": "url-example",
  "startedBy": "startedBy-example"
}
```

## `jenkins.job.finished`

**Quand** : un build lancé depuis Mergerie s’est terminé. **Source** : plugin jenkins. **Version** : 1.

| Champ | Type |
|---|---|
| `path` | `string` |
| `number` | `number` |
| `result` | `string` |
| `ok` | `boolean` |
| `url` | `string` |
| `duration` | `number` |
| `startedBy` | `string` |

```json
{
  "version": 1,
  "path": "path-example",
  "number": 42,
  "result": "result-example",
  "ok": true,
  "url": "url-example",
  "duration": 42,
  "startedBy": "startedBy-example"
}
```

## Compatibilité

Un champ **ajouté** au payload ne change pas la version. Un champ retiré ou renommé, ou un sens qui change, incrémente `version` : le plugin lit `payload.version` et sait à quoi s’attendre. Voir [MIGRATION.md](./MIGRATION.md).
