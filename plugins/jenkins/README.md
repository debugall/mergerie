# Plugin Jenkins (embarqué)

Voir l'état des jobs Jenkins et les lancer, lier un job à un dépôt, suivre la fin des builds
lancés depuis Mergerie — sans quitter l'outil. Livré avec Mergerie, activé d'office,
désactivable depuis Réglages → Plugins.

Ce plugin n'a **aucun privilège** qu'un plugin tiers n'aurait pas : il n'utilise que le `ctx`
public (docs/plugins/API.md), ses tables sont préfixées `plugin_jenkins_`, ses routes vivent
sous `/api/plugins/jenkins/`, son front passe par le kit `window.mergerie`. Le dossier peut
être copié tel quel dans `<dataDir>/plugins/jenkins/` et chargé comme un tiers (dans un worker).

| Dossier | Rôle |
|---|---|
| `index.js` | `activate(ctx)` / `deactivate()` : relie tout |
| `src/client.js` | le client HTTP Jenkins (arbre des jobs, couleurs, crumb CSRF, paramètres) |
| `src/routes.js` | `/jobs`, `/job`, `/build`, `/console`, `/test`, `/status`, `/links`, `/build-links` |
| `src/veille.js` | la fin des builds lancés d'ici (tâche périodique, notification, événement) |
| `src/demo.js` | le jeu de jobs du mode démo |
| `ui/` | l'onglet, les modales, le sous-onglet de réglages, le dictionnaire fr/en, la feuille de style, les scripts |

Réglages (`settingsSchema`) : `jenkins_url`, `jenkins_user`, `jenkins_token` (secret, lié à l'URL),
`jenkins_refresh_minutes`. Événements émis : `jenkins.job.started`, `jenkins.job.finished`.
Variables d'environnement lues : `JENKINS_CA_CERT`, `JENKINS_INSECURE_TLS` (par `ctx.net`).
