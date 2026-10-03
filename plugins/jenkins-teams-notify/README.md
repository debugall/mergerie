# Jenkins Teams Notify

Publie un message dans un canal Microsoft Teams quand un job Jenkins **lancé depuis Mergerie** démarre ou se termine,
par **automatisation du navigateur** (Playwright) — faute de webhook et d'API Graph. Plugin embarqué, **désactivé
par défaut**, second exemple public après `hello`.

*Posts a Microsoft Teams message when a Jenkins job started from Mergerie starts or finishes, by browser automation
(Playwright). Built-in, disabled by default.*

**Documentation complète / full documentation : [docs/plugins/jenkins-teams-notify.md](../../docs/plugins/jenkins-teams-notify.md) ·
[en](../../docs/plugins/en/jenkins-teams-notify.md)** — prérequis, modes de session (profil / CDP), « connexion requise »,
sélecteurs, dépannage, checklist manuelle.

## Permissions demandées, et pourquoi

| Permission | Ce que le plugin en fait |
|---|---|
| `events` | écoute `jenkins.job.started` et `jenkins.job.finished`, rien d'autre |
| `settings` | lien du canal, mode de session, filtre, modèles, rétention |
| `db` | `plugin_jenkins_teams_notify_log` : horodatage, job, événement, statut, erreur tronquée (local, pas le texte du message) |
| `http` | état, journal, test, connexion, oubli de session — sous `/api/plugins/jenkins-teams-notify/` |
| `exec` | lance **`node bin/teams-post.js`, sans shell** ; le message est un argument `--message=…` |
| `storage` | le profil du navigateur, `ctx.dataDir/profile` (cookies : à protéger comme un mot de passe) |
| `ui.tab`, `ui.actions` | l'onglet (pastille « connexion requise »), le sous-onglet de Réglages, la section du brief |
| `demo` | deux notifications fictives dans le journal de la démo |
| `services` | savoir si le plugin Jenkins est actif (`jenkins.status`) |

**Réseau** : le plugin n'ouvre aucune connexion — c'est le navigateur qu'il lance qui parle à Teams (https seulement ;
l'adresse CDP, elle, est **locale** seulement). **Machine** : il exécute Node sur `bin/teams-post.js`, avec un
environnement minimal.

## Réglages

`team_link` (https), `channel_name`, `session_mode` (`profile` | `cdp`), `cdp_url` (localhost), `headless`,
`job_filter` (globs), `template_started|success|failure|aborted` (`{{job}} {{number}} {{url}} {{result}} {{duration}}
{{startedBy}}`), `retention_days`. **Aucun secret.**

## Installer, tester

Embarqué : rien à installer, activer dans Réglages → Plugins. Copié dans `<dataDir>/plugins/jenkins-teams-notify/` ou depuis
git : `npm i playwright && npx playwright install chromium` dans son dossier.

```bash
npm test        # unitaires + intégration avec un faux bin/teams-post.js, sans navigateur
```

## Licence, problèmes

AGPL-3.0-only (comme Mergerie). Un problème : ouvrir un ticket sur le dépôt de Mergerie, en indiquant la version du
plugin, le mode de session et la ligne du journal.
