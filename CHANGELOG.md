# Changelog

All notable changes to Mergerie are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Entries are written **for the people who use the tool**, not copied from commit messages: what changed for
them, and why it matters. Changes land under **Unreleased** as they are merged into `develop`; when
`develop` is merged into `main` and tagged, that section becomes the released version.

## [Unreleased]

### Added

- **GitHub support — full parity with GitLab.** Repositories are now handled forge by forge: pull requests
  are discovered, reviewed, scored, commented (general, inline and replies) and merged exactly like GitLab
  merge requests. Coding sessions create the PR, convergence runs on it, and the Git tab (refs, preview,
  restorable deletions, branch explorer, ref finder) works on both. Settings gained a GitHub connection
  (URL for GitHub Enterprise, token, *Test* button), and the repository list a **Bulk add from GitHub**
  button. A repository is unique per *(forge, path)*, so the same path can exist on both forges.
- **Off-repo coding: the AI reports back, and you can ask for a fix.** Each folder now exposes
  **AI output** — what the agent says it did, which is the only window on its work when the folder did not
  change — and a session offers **Request a fix**: another pass over the same folders that *resumes each
  agent session*, so the AI keeps the context of what it just produced.
- **Docker → Compose: find a container.** A search field (service, container or project name) and a
  **Only show** state filter (running, stopped/not created, unhealthy, restarting, drifted) narrow the view
  service by service. A project with no matching service disappears entirely. Both settings are persisted
  and applied client-side, without querying Docker again.
- **Docker menu badges explain themselves.** Hovering the red or amber count in the Docker tab now shows
  what it counts ("1 container in error (restarting/dead)"), using the app's own tooltip.
- **Search across sessions.** A search field filters coding sessions, off-repo sessions and explorations
  by prompt, project, branch or folder. It resets when switching sub-tab, so it never contradicts the
  totals shown on the tabs.
- **Every iteration of a coding session is kept.** A session iterates (initial run, *Request a fix*,
  answers to the AI's questions, convergence passes); each pass now keeps **the prompt actually sent** and
  **its own AI answer**, instead of only the last output. An iteration picker appears in *AI output* from
  the second pass on, and shows the request next to the answer — reading an answer without knowing what it
  answered teaches nothing. Applies to off-repo coding too, folder by folder, and to **explorations**,
  where a follow-up question used to overwrite the previous answer.

- **Review reports keep the change requests that produced them.** The *Ask the AI for a change* section
  now lists the requests already made on a report, with their date, and opens the report version each one
  produced.

- **Merging asks for confirmation, with options.** A modal recalls the MR and its target branch and
  offers **squash** and **delete the source branch**, pre-checked from what was chosen when the MR was
  created. Creating an MR uses the same modal family (title + the two options) instead of a native
  browser prompt. GitLab keeps both at creation time; GitHub cannot express them there, so Mergerie
  remembers them and applies them at merge — the modal says so.
- **The convergence dialog says what it will converge.** It named "the MR" even when started from a
  session — where the AI first codes and opens the MR. Title and opening line now follow the context,
  and the dialog shares the layout of the other confirmation modals.
- **Every confirmation now uses the app's own dialog.** The sixteen remaining native `confirm()` boxes
  (delete a repository, a rule, a session, a report; stop a job; git deletions and restores; Docker
  `down`…) share one styled modal: themed, translated, and with a button that names the action instead
  of a mute "OK". Irreversible actions are recognisable at rest, not only on hover.

### Changed

- **Coding sessions: `Diff` became `See the diff`** and opens the *same* full-screen viewer as merge
  requests — file tree, whole file with the changes in place, change navigation and minimap — with the
  **AI's report on the left** instead of the review report. The server routes behind both viewers are now
  shared, so there is a single implementation to maintain.
- **`.env.example` is in English**, documents the GitHub TLS variables (`GITHUB_CA_CERT`,
  `GITHUB_INSECURE_TLS`) and makes clear that forge API tokens are *not* set there — they live in Settings.

### Fixed

- **Labels name the right forge.** On a GitHub repository, the inline comment button said "Send to
  GitLab"; the same applied to the MR comment section, the merge and "already merged" tooltips. Every
  user-facing label now follows the repository's forge, and the ones that span all repositories (fetch
  MRs, restore safety note) no longer name a single forge. The inline comment editor was also still
  hardcoded in French — it is translated now.
- **Search fields no longer rebuild their list on every keystroke.** The session and Docker Compose
  searches are debounced: typing an 8-character query now rebuilds the list once instead of eight times.
- **Statuses update as soon as a job starts.** Launching an iteration left the card on its previous
  status ("pushed") until the page was reloaded: the lists were only refreshed when a job *ended*. They
  now refresh when one *starts* too, so the badge switches to "running" on its own.
- **The follow-up form closes once the request is sent.** Asking for a fix (coding session,
  off-repo coding or exploration) left the text box open with its content, which read as if nothing had
  been submitted — the form now clears and closes on success.

- **The score shown in the list is the one from the latest review.** A re-review usually recalls the
  previous score in its opening summary ("6.4 → 7.8"); the extractor read the report from the top and
  returned that older score, so the list stayed stuck on the first review's result. It now reads the score
  that *concludes* the report. Scores already stored in the database are left untouched and are refreshed
  the next time each merge request is reviewed.
- **GitHub URL and token are actually saved.** Both fields were displayed and accepted input but silently
  dropped on submit, because the settings form saves through an explicit whitelist they were missing from.
  A static check now fails when a form field is not wired to that list.

## [1.0.0] - 2026-07-26

First public release — see the [README](./README.md) for what the tool does.

[Unreleased]: https://github.com/debugall/mergerie/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/debugall/mergerie/releases/tag/v1.0.0
