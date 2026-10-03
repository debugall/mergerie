# Jenkins Teams Notify — les jobs Jenkins dans un canal Teams

> English version: [en/jenkins-teams-notify.md](./en/jenkins-teams-notify.md)

`plugins/jenkins-teams-notify/` publie un message dans un canal Microsoft Teams quand un job Jenkins **lancé depuis
Mergerie** démarre ou se termine. Les webhooks Teams et l'API Graph n'étant pas disponibles, il **pilote un
navigateur** (Playwright) connecté à ton compte : c'est un second exemple public de plugin, écrit comme le ferait
un contributeur externe — généré par `npm create mergerie-plugin`, testé avec `createTestContext`.

**Désactivé par défaut.** Réglages → Plugins → Jenkins Teams Notify → Activer.

> ⚠️ **Charte informatique.** Le plugin automatise un navigateur connecté à **ton compte personnel** Teams. Ce
> n'est pas une intégration officielle : ton entreprise peut l'interdire, ou le voir comme un comportement
> anormal. Demande avant de l'activer. Le message part **sous ton nom**.

> ⚠️ **Sélecteurs fragiles.** Teams change son interface sans prévenir. Si les envois échouent après une mise
> à jour de Teams (« Éditeur de message introuvable »), les sélecteurs sont à ajuster — voir
> [où les modifier](#ou-modifier-les-selecteurs). Ils n'ont **pas** été vérifiés contre un Teams réel par les
> tests : voir la [checklist manuelle](#checklist-manuelle).

## Prérequis

```bash
npm i playwright            # déjà présent dans le dépôt de Mergerie
npx playwright install chromium
```

Dans le dépôt de Mergerie, `playwright` est déjà installé : seul le navigateur est à télécharger. Pour un plugin
copié dans `<dataDir>/plugins/`, installe `playwright` dans son dossier (`npm i playwright`) ou donne son chemin
par `JENKINS_TEAMS_NOTIFY_NODE_PATH`. Si Playwright ou Chromium manque, le script sort avec le code 3 et le journal dit
quoi installer.

## Réglages (Réglages → Teams)

| Réglage | Rôle |
|---|---|
| Lien du canal | Dans Teams : « … » à côté du canal → *Obtenir le lien vers le canal*. **https uniquement** |
| Nom du canal | Facultatif. Renseigné, rien n'est posté tant que le titre de la page Teams ne le contient pas (garde-fou contre un mauvais lien) |
| Session | `profile` (profil Playwright persistant) ou `cdp` (un Chrome déjà ouvert) |
| Adresse CDP | Mode `cdp` : `http://127.0.0.1:9222`. **La machine locale uniquement** (`localhost`, `127.0.0.1`, `[::1]`) |
| Sans fenêtre | Mode `profile` : le navigateur n'affiche rien pendant l'envoi |
| Jobs notifiés | Motifs glob sur le **nom complet** du job (`dossier/sous/job`), un par ligne. `*` ne traverse pas `/`, `**` le traverse, `?` un caractère. **Vide = tous** |
| Modèles | Un par type : démarré, réussi, échec, interrompu. Variables `{{job}} {{number}} {{url}} {{result}} {{duration}} {{startedBy}}` ; une variable absente donne un texte vide. Laisser vide : le modèle par défaut de la langue |
| Journal : jours conservés | 90 par défaut (comme la rétention du cœur) ; 0 = pour toujours ; sinon au moins 7 |

Boutons : **Envoyer un message de test**, **Ouvrir Teams pour se connecter**, **Oublier la session**.

Le type d'un message vient du résultat Jenkins : `SUCCESS` → réussi, `ABORTED` → interrompu, tout le reste
(`FAILURE`, `UNSTABLE`, `NOT_BUILT`…) → échec. Le message tient sur **une ligne** (Entrée envoie le message dans
Teams) : les retours à la ligne d'un modèle sont remplacés par des espaces.

### Il n'y a pas d'option « ne notifier que mes jobs »

Seuls les builds **lancés depuis Mergerie, par toi** émettent `jenkins.job.started` et `jenkins.job.finished` : tous
sont « tes jobs » par construction. Une telle option ne filtrerait rien ; elle n'existe donc pas. Les builds lancés
ailleurs (un push, un collègue, le planificateur) ne sont jamais vus par ce plugin.

## Les deux modes de session

### `profile` — un profil Playwright persistant (par défaut)

Le plugin lance un Chromium avec un profil dédié, `<dataDir>/plugin-data/jenkins-teams-notify/profile/`. La session (cookies,
MFA déjà passé) y reste d'un envoi à l'autre. **Première connexion** : *Ouvrir Teams pour se connecter* ouvre
la fenêtre, tu te connectes à la main (MFA compris) ; dès que l'éditeur de message apparaît, la fenêtre se ferme et
l'état passe à « valide ».

### `cdp` — un Chrome déjà ouvert

Le plugin se rattache à **ton** Chrome, déjà connecté à Teams, par le protocole de débogage. Lance Chrome ainsi (un
dossier de profil **à part** est obligatoire : depuis Chrome 136, le port de débogage est ignoré sur le profil par
défaut) :

```bash
# macOS
open -a "Google Chrome" --args --remote-debugging-port=9222 --user-data-dir="$HOME/.mergerie-chrome"
# Linux
google-chrome --remote-debugging-port=9222 --user-data-dir="$HOME/.mergerie-chrome"
# Windows (PowerShell)
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="$env:USERPROFILE\.mergerie-chrome"
```

Connecte-toi à Teams une fois dans cette fenêtre, laisse-la ouverte, et renseigne `http://127.0.0.1:9222`. Le plugin
n'ouvre qu'**un onglet** et le referme ; il ne ferme jamais ton navigateur. ⚠️ **Un port de débogage donne accès à
tout le navigateur** (cookies, sessions) : ne l'expose que sur la machine locale — le plugin le refuse autrement —
et ne le laisse pas ouvert sur un poste partagé.

## La connexion expire : « connexion requise »

Quand le script voit la page de connexion Microsoft, il sort avec le **code 2**. Le plugin :

- passe l'état à **« connexion requise »** : pastille sur l'onglet *Teams* et section dans le brief « Aujourd'hui » ;
- **n'appelle plus le script** : les événements suivants sont notés « ignoré » au journal, sans ouvrir de navigateur
  ni boucler ;
- reprend dès qu'un **test manuel réussit** (*Envoyer un message de test*, ou *Ouvrir Teams pour se connecter*).

Un échec ordinaire (code 1, délai dépassé) est réessayé **une fois** ; une session expirée (2) et un prérequis
manquant (3) ne le sont pas.

## Le journal et ce qui part vers Teams

Chaque envoi laisse une ligne dans `plugin_jenkins_teams_notify_log` : horodatage, job, événement, statut, erreur tronquée.
**Le texte du message n'y est pas conservé.** Le journal est **local** (classement L) : il n'est jamais partagé par
`shared_database`. Il se consulte dans Réglages → Teams et dans l'onglet *Teams*.

Ne partent vers Teams que les champs des événements `jenkins.job.started` / `jenkins.job.finished`, rendus par
ton modèle : nom du job, numéro, adresse du build, résultat, durée, compte qui l'a lancé. **Aucun contenu de session,
de merge request ni de dépôt n'est envoyé.**

Le **profil du navigateur** (`<dataDir>/plugin-data/jenkins-teams-notify/profile/`) contient des cookies : protège-le comme
un mot de passe. *Oublier la session* l'efface. Il n'entre ni dans le dépôt d'équipe, ni dans la sauvegarde de Mergerie.

## Ce que le plugin demande (permissions)

| Permission | Pourquoi |
|---|---|
| `events` | écouter `jenkins.job.started` et `jenkins.job.finished` (rien d'autre) |
| `settings` | ses réglages, validés par son schéma |
| `db` | son journal `plugin_jenkins_teams_notify_log` |
| `http` | l'état, le journal, le test, la connexion, l'oubli de session |
| `exec` | lancer `bin/teams-post.js` avec Node, **sans shell** : `ctx.exec(node, [script, "--message=…", …])` ; le message n'est qu'une valeur d'argument |
| `storage` | le profil du navigateur (`ctx.dataDir`) |
| `ui.tab`, `ui.actions` | l'onglet (pastille), le sous-onglet de Réglages, la section du brief |
| `demo` | deux notifications fictives dans le journal de la démo |
| `services` | savoir si le plugin Jenkins est actif (`jenkins.status`) pour le dire dans Réglages |

Pas de `net` : le plugin n'ouvre aucune connexion lui-même — c'est le **navigateur** qui parle à Teams. Pas de
`secrets` : la session vit dans le profil, pas dans la base.

Jenkins est la **seule** dépendance, par ses deux événements ; si le plugin Jenkins est désactivé, Jenkins Teams Notify reste
chargé et Réglages le dit (« Jenkins est désactivé… »).

## Le script `bin/teams-post.js`

Il est **fourni** (`teamsPoster.js`, un module `postToTeams(message)` configuré par variables d'environnement) et
**adapté seulement là où l'intégration l'exigeait**. Chaque changement est listé en tête du fichier :

1. **CLI** — la configuration arrive en arguments `--clé=valeur` (jamais par l'environnement ni par une chaîne de
   commande) ; les variables `TEAMS_*` restent les valeurs par défaut. *Pourquoi : le plugin lance le script par
   `ctx.exec`, sans shell, et ne peut pas poser d'environnement arbitraire.*
2. **Codes de sortie** — `0` posté · `1` échec · `2` session expirée · `3` prérequis manquant. *Pourquoi :
   l'original sortait en 1 pour tout ; le plugin doit distinguer « reconnecte-toi » d'une panne.*
3. **Session expirée détectée tout de suite** — la page de connexion est testée à chaque tour de l'attente de
   l'éditeur (Teams redirige après le chargement), et fait sortir en 2 hors `--dry-run`. *Pourquoi : en headless,
   l'original attendait 5 minutes avant d'échouer.*
4. **`--dry-run`** — va jusqu'à l'éditeur sans rien poster : c'est « Ouvrir Teams pour se connecter ».
5. **`--cdp-url`** — se rattache à un Chrome ouvert ; ne ferme que l'onglet ouvert.
6. **`--channel-name`** — garde-fou : le titre de la page doit contenir le nom du canal.
7. **`require('playwright')` paresseux** — l'analyse des arguments marche sans Playwright, et son absence donne le
   code 3 plutôt qu'une trace.
8. **Le message n'est jamais écrit dans la sortie.**

Le reste — profil persistant, éditeur dans une iframe, Entrée pour envoyer, délai de départ — est le code fourni,
inchangé.

### Où modifier les sélecteurs

En tête de `plugins/jenkins-teams-notify/bin/teams-post.js`, dans `CONFIG.selectors` :

```js
selectors: {
    editor: 'div[contenteditable="true"][role="textbox"]',   // la zone de saisie du message
    loginPage: 'input[type="email"], #i0116',                // la page de connexion Microsoft
    sendButton: 'button[data-tid="newMessageCommands-send"]',
},
```

Ouvre Teams dans Chrome, inspecte la zone de saisie du canal, et ajuste le sélecteur. Le plugin n'a rien à changer :
il ne connaît que le contrat (arguments et codes de sortie). `sendButton` est conservé du fichier fourni mais non
utilisé : l'envoi se fait par Entrée.

## Dépannage

| Le journal dit | Cause probable | Que faire |
|---|---|---|
| connexion requise | session expirée | *Ouvrir Teams pour se connecter* |
| prérequis manquant | Playwright ou Chromium absent | `npm i playwright && npx playwright install chromium` |
| Éditeur de message introuvable | Teams a changé son interface, ou le lien n'ouvre pas un canal | ajuster le sélecteur ; vérifier le lien |
| canal attendu « X » absent du titre | mauvais lien, ou titre pas encore chargé | vérifier le lien et le nom du canal |
| délai dépassé | Teams lent, ou fenêtre en attente d'une action | relancer ; essayer sans « sans fenêtre » |
| ignoré | la connexion est requise | voir ci-dessus |

Sous Linux, un navigateur avec fenêtre a besoin d'un affichage : `JENKINS_TEAMS_NOTIFY_DISPLAY=:0`. Le script s'exécute avec un
environnement **minimal** (`PATH`, `HOME`, `LANG`) ; seules `JENKINS_TEAMS_NOTIFY_PLAYWRIGHT_BROWSERS_PATH`,
`JENKINS_TEAMS_NOTIFY_DISPLAY` et `JENKINS_TEAMS_NOTIFY_NODE_PATH` du serveur lui sont transmises.

## Limites connues

- Une seule file : un envoi à la fois sur le profil (20 en attente au plus, au-delà abandonnés et journalisés).
- Un message tient sur une ligne ; pas de mise en forme, pas de mention, pas de réponse dans un fil.
- Le plugin ne sait pas si le message est réellement apparu : il sait que le script a sorti 0.
- Seuls les builds lancés depuis Mergerie sont vus.

## <a id="checklist-manuelle"></a>Checklist manuelle sur un vrai Teams

Les tests (faux script) ne peuvent pas prouver ce qui suit.

1. `npx playwright install chromium`, activer le plugin, coller le lien du canal.
2. *Ouvrir Teams pour se connecter* : la fenêtre s'ouvre, connecte-toi (MFA), elle se ferme, l'état passe à « valide ».
3. *Envoyer un message de test* : le message apparaît dans le bon canal, sous ton nom.
4. Lancer un job depuis l'onglet Jenkins : « démarré » puis « réussi/échec » arrivent, avec le bon lien.
5. Renseigner un **mauvais** nom de canal : rien n'est posté, le journal dit pourquoi.
6. Mode `cdp` : Chrome lancé avec `--remote-debugging-port`, le test poste sans ouvrir de fenêtre ; ton Chrome reste ouvert.
7. Supprimer les cookies du profil (*Oublier la session*) puis lancer un job : « connexion requise » (pastille, brief),
   et plus aucun navigateur ne s'ouvre ; un test manuel réussi rétablit les envois.
8. Mettre le Wi-Fi hors ligne pendant un envoi : un échec « délai dépassé » ou « échec », réessayé une fois, journalisé.
9. Un job dont le nom ne correspond pas au filtre : aucun message.
10. Un message avec `;` `|` `$(…)` dans un modèle : il arrive tel quel.
