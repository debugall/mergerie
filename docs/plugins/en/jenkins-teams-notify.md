# Jenkins Teams Notify — Jenkins jobs in a Teams channel

> Version française : [../jenkins-teams-notify.md](../jenkins-teams-notify.md)

`plugins/jenkins-teams-notify/` posts a message in a Microsoft Teams channel when a Jenkins job **started from Mergerie**
starts or finishes. Teams webhooks and the Graph API not being available, it **drives a browser** (Playwright) signed
in to your account. It is the second public example plugin, written the way an outside contributor would: generated
by `npm create mergerie-plugin`, tested with `createTestContext`.

**Disabled by default.** Settings → Plugins → Jenkins Teams Notify → Enable.

> ⚠️ **IT policy.** The plugin automates a browser signed in to **your personal** Teams account. It is not an
> official integration: your company may forbid it, or see it as abnormal behaviour. Ask before enabling it. The
> message goes out **under your name**.

> ⚠️ **Fragile selectors.** Teams changes its interface without notice. If sending fails after a Teams update
> ("Message editor not found"), the selectors need adjusting — see [where to edit them](#where-to-edit-the-selectors).
> The tests did **not** check them against a real Teams: see the [manual checklist](#manual-checklist).

## Prerequisites

```bash
npm i playwright            # already in Mergerie's repository
npx playwright install chromium
```

In Mergerie's repository `playwright` is already installed: only the browser has to be downloaded. For a plugin copied
into `<dataDir>/plugins/`, install `playwright` in its folder (`npm i playwright`) or give its path through
`JENKINS_TEAMS_NOTIFY_NODE_PATH`. When Playwright or Chromium is missing, the script exits with code 3 and the log says what to
install.

## Settings (Settings → Teams)

| Setting | Role |
|---|---|
| Channel link | In Teams: "…" next to the channel → *Get link to channel*. **https only** |
| Channel name | Optional. When set, nothing is posted unless the Teams page title contains it (a guard against a wrong link) |
| Session | `profile` (persistent Playwright profile) or `cdp` (an already open Chrome) |
| CDP address | `cdp` mode: `http://127.0.0.1:9222`. **The local machine only** (`localhost`, `127.0.0.1`, `[::1]`) |
| No window | `profile` mode: the browser shows nothing while sending |
| Jobs notified | Glob patterns on the job's **full name** (`folder/sub/job`), one per line. `*` does not cross `/`, `**` does, `?` is one character. **Empty = all** |
| Templates | One per type: started, succeeded, failed, aborted. Variables `{{job}} {{number}} {{url}} {{result}} {{duration}} {{startedBy}}`; a missing variable gives empty text. Leave empty for the language's default template |
| Log: days kept | 90 by default (like the core's retention); 0 = forever; otherwise at least 7 |

Buttons: **Send a test message**, **Open Teams to sign in**, **Forget the session**.

A message's type comes from the Jenkins result: `SUCCESS` → succeeded, `ABORTED` → aborted, everything else
(`FAILURE`, `UNSTABLE`, `NOT_BUILT`…) → failed. A message is **one line** (Enter sends it in Teams): newlines in a
template are replaced by spaces.

### There is no "only my jobs" option

Only builds **started from Mergerie, by you** emit `jenkins.job.started` and `jenkins.job.finished`: all of them are
"your jobs" by construction. Such an option would filter nothing, so it does not exist. Builds started elsewhere (a
push, a colleague, the scheduler) are never seen by this plugin.

## The two session modes

### `profile` — a persistent Playwright profile (default)

The plugin launches a Chromium with a dedicated profile, `<dataDir>/plugin-data/jenkins-teams-notify/profile/`. The session
(cookies, MFA already passed) stays there between sends. **First sign-in**: *Open Teams to sign in* opens the window,
you sign in by hand (MFA included); as soon as the message editor appears the window closes and the state becomes
"valid".

### `cdp` — an already open Chrome

The plugin attaches to **your** Chrome, already signed in to Teams, through the debugging protocol. Start Chrome like
this (a **separate** profile folder is mandatory: since Chrome 136 the debugging port is ignored on the default
profile):

```bash
# macOS
open -a "Google Chrome" --args --remote-debugging-port=9222 --user-data-dir="$HOME/.mergerie-chrome"
# Linux
google-chrome --remote-debugging-port=9222 --user-data-dir="$HOME/.mergerie-chrome"
# Windows (PowerShell)
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="$env:USERPROFILE\.mergerie-chrome"
```

Sign in to Teams once in that window, leave it open, and enter `http://127.0.0.1:9222`. The plugin opens **one tab**
and closes it; it never closes your browser. ⚠️ **A debugging port gives access to the whole browser** (cookies,
sessions): expose it on the local machine only — the plugin refuses anything else — and do not leave it open on a
shared workstation.

## The sign-in expires: "sign-in required"

When the script sees the Microsoft sign-in page it exits with **code 2**. The plugin:

- sets the state to **"sign-in required"**: a badge on the *Teams* tab and a section in the "Today" brief;
- **stops calling the script**: later events are logged as "skipped", without opening a browser or looping;
- resumes as soon as a **manual test succeeds** (*Send a test message*, or *Open Teams to sign in*).

An ordinary failure (code 1, timeout) is retried **once**; an expired session (2) and a missing prerequisite (3) are not.

## The log and what goes to Teams

Every send leaves a row in `plugin_jenkins_teams_notify_log`: timestamp, job, event, status, truncated error. **The message
text is not kept there.** The log is **local** (class L): it is never shared through `shared_database`. It can be read
in Settings → Teams and in the *Teams* tab.

Only the fields of the `jenkins.job.started` / `jenkins.job.finished` events reach Teams, rendered by your template:
job name, number, build address, result, duration, the account that started it. **No session, merge request or
repository content is sent.**

The **browser profile** (`<dataDir>/plugin-data/jenkins-teams-notify/profile/`) holds cookies: protect it like a password.
*Forget the session* deletes it. It enters neither the team repository nor Mergerie's backup.

## What the plugin asks for (permissions)

| Permission | Why |
|---|---|
| `events` | listen to `jenkins.job.started` and `jenkins.job.finished` (nothing else) |
| `settings` | its settings, validated by its schema |
| `db` | its `plugin_jenkins_teams_notify_log` log |
| `http` | status, log, test, sign-in, forgetting the session |
| `exec` | run `bin/teams-post.js` with Node, **without a shell**: `ctx.exec(node, [script, "--message=…", …])`; the message is only an argument value |
| `storage` | the browser profile (`ctx.dataDir`) |
| `ui.tab`, `ui.actions` | the tab (badge), the Settings sub-tab, the brief section |
| `demo` | two fictitious notifications in the demo log |
| `services` | to know whether the Jenkins plugin is active (`jenkins.status`) and say so in Settings |

No `net`: the plugin opens no connection itself — the **browser** talks to Teams. No `secrets`: the session lives in the
profile, not in the database.

Jenkins is the **only** dependency, through its two events; if the Jenkins plugin is disabled, Jenkins Teams Notify stays loaded
and Settings says so ("Jenkins is disabled…").

## The `bin/teams-post.js` script

It is **provided** (`teamsPoster.js`, a `postToTeams(message)` module configured by environment variables) and
**adapted only where the integration required it**. Each change is listed at the top of the file:

1. **CLI** — configuration arrives as `--key=value` arguments (never through the environment nor a command string); the
   `TEAMS_*` variables stay the defaults. *Why: the plugin runs the script through `ctx.exec`, without a shell, and
   cannot set an arbitrary environment.*
2. **Exit codes** — `0` posted · `1` failure · `2` session expired · `3` prerequisite missing. *Why: the original exited
   with 1 for everything; the plugin must tell "sign in again" from a breakdown.*
3. **Expired session detected at once** — the sign-in page is tested on every turn of the wait for the editor (Teams
   redirects after load), and exits with 2 outside `--dry-run`. *Why: headless, the original waited 5 minutes before
   failing.*
4. **`--dry-run`** — goes as far as the editor without posting anything: it is "Open Teams to sign in".
5. **`--cdp-url`** — attaches to an open Chrome; only closes the tab it opened.
6. **`--channel-name`** — guard: the page title must contain the channel name.
7. **Lazy `require('playwright')`** — argument parsing works without Playwright, and its absence gives code 3 rather
   than a stack trace.
8. **The message is never written to the output.**

The rest — persistent profile, editor inside an iframe, Enter to send, start-up delay — is the provided code, unchanged.

### Where to edit the selectors

At the top of `plugins/jenkins-teams-notify/bin/teams-post.js`, in `CONFIG.selectors`:

```js
selectors: {
    editor: 'div[contenteditable="true"][role="textbox"]',   // the message input
    loginPage: 'input[type="email"], #i0116',                // the Microsoft sign-in page
    sendButton: 'button[data-tid="newMessageCommands-send"]',
},
```

Open Teams in Chrome, inspect the channel's input, and adjust the selector. The plugin needs no change: it only knows the
contract (arguments and exit codes). `sendButton` is kept from the provided file but unused: sending is done with Enter.

## Troubleshooting

| The log says | Likely cause | What to do |
|---|---|---|
| sign-in required | session expired | *Open Teams to sign in* |
| prerequisite missing | Playwright or Chromium absent | `npm i playwright && npx playwright install chromium` |
| Message editor not found | Teams changed its interface, or the link does not open a channel | adjust the selector; check the link |
| expected channel "X" absent from the title | wrong link, or title not loaded yet | check the link and the channel name |
| timed out | slow Teams, or a window waiting for an action | retry; try without "no window" |
| skipped | sign-in is required | see above |

On Linux a browser with a window needs a display: `JENKINS_TEAMS_NOTIFY_DISPLAY=:0`. The script runs with a **minimal**
environment (`PATH`, `HOME`, `LANG`); only the server's `JENKINS_TEAMS_NOTIFY_PLAYWRIGHT_BROWSERS_PATH`, `JENKINS_TEAMS_NOTIFY_DISPLAY` and
`JENKINS_TEAMS_NOTIFY_NODE_PATH` are passed to it.

## Known limits

- One queue: one send at a time on the profile (20 waiting at most, beyond that dropped and logged).
- A message is one line; no formatting, no mention, no thread reply.
- The plugin does not know whether the message actually appeared: it knows the script exited 0.
- Only builds started from Mergerie are seen.

## <a id="manual-checklist"></a>Manual checklist on a real Teams

The tests (fake script) cannot prove what follows.

1. `npx playwright install chromium`, enable the plugin, paste the channel link.
2. *Open Teams to sign in*: the window opens, sign in (MFA), it closes, the state becomes "valid".
3. *Send a test message*: the message appears in the right channel, under your name.
4. Start a job from the Jenkins tab: "started" then "succeeded/failed" arrive, with the right link.
5. Enter a **wrong** channel name: nothing is posted, the log says why.
6. `cdp` mode: Chrome started with `--remote-debugging-port`, the test posts without opening a window; your Chrome stays open.
7. Delete the profile's cookies (*Forget the session*) then start a job: "sign-in required" (badge, brief), and no browser
   opens any more; a successful manual test restores sending.
8. Go offline during a send: a "timed out" or "failed" result, retried once, logged.
9. A job whose name does not match the filter: no message.
10. A template containing `;` `|` `$(…)`: it arrives as is.
