# Changelog

All notable changes to Mergerie are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Entries are written **for the people who use the tool**, not copied from commit messages: what changed for
them, and why it matters. Changes land under **Unreleased** as they are merged into `develop`; when
`develop` is merged into `main` and tagged, that section becomes the released version.

## [Unreleased]

## [1.1.0] - 2026-07-31

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
- **Docker logs are readable again — and can be colourful on request.** An application running in a
  container usually colours its output, `docker logs` relays those escape bytes untouched, and the
  browser is not a terminal: every line came through buried under `[34mdebug[39m` and a control
  glyph. Lines are shown as plain text by default, which is also the lighter rendering when the
  stream bursts. A **Show colours** checkbox next to *Wrap lines* renders what the application meant
  — the blue of *debug*, the red of an error, the green of a 200 — and remembers your choice.
  Ticking it replays what is already on screen rather than restarting the stream, and the include /
  exclude filters keep matching on the plain text either way. Background colours are deliberately
  left out: they assume a terminal whose contrast you control, not a light and a dark theme.
- **Accents no longer break in the log stream.** A multi-byte character landing on a network chunk
  boundary was decoded as two invalid halves and shown as a replacement character. The stream is
  decoded properly now. The job log panel also strips escape sequences, which can reach it from an
  agent or from git.
- **"Not running" was three different situations.** The Compose state filter lumped them together
  under *Stopped / not created*, although Docker tells them apart and they call for different
  actions: a container that **ran and exited** wants restarting, one that was **created but never
  started** usually failed to start, and a service with **no container at all** has never been
  brought up. Each is now its own choice, and *Not running (all)* stays as the catch-all. The
  Actions sub-tab offers exactly the same list — the two "Only show" menus are now built from one
  definition, so they cannot drift apart.
- **The Docker badge counts stopped containers too.** Its red number only covered containers that
  were *broken* — restarting or dead — so a service that had simply exited stayed invisible from
  every other tab, although from the outside it serves just as little. Exited containers are now
  part of the red count. The two are still told apart where it matters: hovering the number reads
  "1 container in error (restarting/dead) · 1 stopped container (exited)".
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
- **A tag recreated on another commit no longer blocks Git operations.** The safety fetch that precedes
  every deletion did not force tag updates, so a tag deleted then recreated elsewhere made it fail with
  `would clobber existing tag` — and the whole action was lost although the repository was fine. It now
  forces them, like every other fetch on the tool's own clones. Repositories you own (Git → Navigation)
  are deliberately left untouched: there, a local tag must never be silently overwritten.
- **The convergence dialog says what it will converge.** It named "the MR" even when started from a
  session — where the AI first codes and opens the MR. Title and opening line now follow the context,
  and the dialog shares the layout of the other confirmation modals.
- **Every confirmation now uses the app's own dialog.** The sixteen remaining native `confirm()` boxes
  (delete a repository, a rule, a session, a report; stop a job; git deletions and restores; Docker
  `down`…) share one styled modal: themed, translated, and with a button that names the action instead
  of a mute "OK". Irreversible actions are recognisable at rest, not only on hover.

- **Out-of-repo coding sessions can be edited.** They were the only kind you could not correct: a
  typo in the prompt or a wrong folder meant deleting the session and writing it again. The pencil
  is now on their cards too, and it reopens the same dialog. Editing only the prompt leaves the
  folders exactly as they were — their status, the AI's report and its session are kept, so a
  one-word fix does not throw away work already done. Change which folders are targeted and those
  do start over, which is the point.
- **Out-of-repo coding can be prepared and run later.** Its dialog only offered *Start coding*, which
  created the session and launched it on the spot — writing one down for later meant not writing it
  at all. It now also offers **Create without running**, next to it: the session is created in the
  "to run" state and its card carries a *Run* button, like every other session. Coding sessions and
  explorations already worked this way — their main button saves without launching.
- **See what is queued, and jump the queue when it is safe.** The log panel said "+3 waiting"
  without saying what. A **Queued** button now opens the list — what each job is, how much it has to
  do — and offers **Start in parallel** on any job that can run alongside the current one. The
  queue stays sequential by default; promoting a job is a deliberate act, and at most **three** run at
  once — past that you stop gaining time and start making them fight for the machine. When more than
  one is running, the banner says how many, since it can only describe one of them. Jobs that would touch the same repositories or folders are **refused**, not merely
  discouraged, and the line says which running job is in the way: two agents in one clone corrupt
  it, and waiting your turn is cheaper than repairing that. The queue obeys the same rule as it
  drains: it holds a job back rather than starting it next to a parallel job it would collide
  with, and it keeps its order instead of quietly skipping ahead. A queued job can also simply be
  removed.
- **A job that did not finish can be restarted from where you are.** The banner said "stopped" and
  left you to work out where to click. A **Restart** button now sits next to it and replays the same
  action on the same object. A review picks up where it stopped rather than redoing what is done:
  what is remembered is the intent, not the list, and the list is recomputed from the state of the
  merge requests. Git operations are deliberately left out — replaying "delete these twelve
  branches" from a small button, skipping the preview, is exactly what should not be one click away.
- **Stopping a Git or Docker job no longer looks like a failure.** Every other kind of job told a
  requested stop apart from an error; those two did not, so your own *Stop* came back in red with
  "stopped by the user" as the error message. They now end as stopped, like the rest.
- **The log panel gets a tab per running job.** Each keeps its own output and its own scroll
  position; switching tabs shows the other one rather than replaying anything. A tab **stays after
  its job ends**, carrying a dot for how it ended — green finished, red failed, grey stopped — and
  keeps its log until a new batch of jobs starts: the moment a job ends is exactly when you want to
  read it, especially if it failed. The tab bar only appears when there is more than one job — a
  lone tab teaches nothing and costs a line. Each tab of a running job carries **its own stop**,
  which leaves the others and the queue alone; the panel's *Stop* remains "stop everything" and now
  says so once more than one job is running, instead of claiming to stop "the running job".
- **A new session can continue an existing one.** Creating a coding session, an out-of-repo coding
  session or an exploration now offers an optional **Resume an existing agent session** field. Fill
  it in and no new session is opened: the work happens inside that one, so the AI still has
  everything it worked out earlier — its reading of the code, the decisions already made, what it
  already tried. Leave it empty and nothing changes. The id is the one shown by *Resume in terminal*
  on an existing session, and that button now appears on a session pointed at a supplied id too —
  without the `cd`, since where that session came from is not ours to know. The field is also there
  when **editing** a session, pre-filled with the current id, which is the only way to move a session
  onto another one after the fact; clearing it never wipes anything, so a form merely submitted
  cannot lose a session. A session belongs to one working directory, so if resuming is refused the
  usual fallback opens a fresh session with the context re-injected rather than losing the run.
- **Explorations show their resume command too.** They gained a resumable session, but their card
  never offered *Resume in terminal* — the button only existed per project, and an exploration has
  a single session shared by all of its repositories, working from the clone root rather than any
  one repository. It now sits with the card's own actions, where it belongs, rather than being
  repeated identically on every line.
- **Explorations remember, instead of being reminded.** A follow-up question used to paste the
  previous answer back into the prompt — but an answer is a summary, not the reasoning that produced
  it, so the AI had to work out again what it had already read. Explorations now run in a resumable
  session like coding sessions do, and a follow-up simply continues it. Pasting the previous answer
  back remains as the fallback, for dry-run and for the case where resuming fails.
- **Picking a branch no longer means scrolling.** In Git → Actions the source branch was a plain
  dropdown listing every branch of the repository, in whatever order the forge returned them — on a
  busy repository that is hundreds of entries. It is now a field you type into, like the repository
  picker next to it. The two other places where branches are chosen got a filter as well: the list of
  branches (or tags) to delete, and the branch table of the explorer. Both filters only *hide* rows —
  tick a branch, search for another, tick it too, then delete them together.
- **Your own review comments can be edited.** A typo, a wrong line number, a sentence you'd rather
  rephrase: an **Edit** link now appears on the comments *you* wrote — on a line in the code viewer
  as well as on the merge request itself. The editor opens in place, pre-filled with the original
  Markdown, and the change goes to GitLab or GitHub. Comments written by other people carry no such
  link: Mergerie compares each comment's author with the account behind your token, and if it cannot
  work out who you are, nothing is offered as editable.
- **The demo has comments now.** The review screen used to show "comments unavailable" in demo mode,
  since those routes went straight to the forge. A short fictional thread — one comment of yours, one
  from a colleague — makes the whole bottom half of a report worth looking at, and shows which
  comments you may edit.
- **Finished sessions can be tidied away.** Coding, off-repo coding and exploration sessions each
  gain a *hide* button: the session leaves the list without being deleted — its diffs, its AI
  passes and its merge request stay exactly where they were. A **Show hidden sessions** checkbox
  above the list brings them back, dimmed and dashed so you can tell them apart, and its state is
  remembered. When the box is unchecked, a count beside it says how many sessions are being kept
  out of the way: a session that vanished without a trace would be assumed deleted, and recreated.
- **A long prompt is no longer cut off in the list.** It used to stop dead at 220 characters, which
  is enough to lose the point of a detailed instruction, with no way to read the rest short of
  opening the session. The prompt is now folded to three lines with a **Show more** link, and the
  whole text is in the page — so the browser's own search finds it even while folded.
- **The log panel says how long the job has been running.** A review over thirty merge requests can
  run for a quarter of an hour; until now nothing told you whether it had been going for ten seconds
  or ten minutes. A counter next to the status ticks while the job runs and freezes on the total
  once it ends. It is computed from the server's start time, so a tab opened halfway through a job
  still shows the true elapsed time.
- **Two guard rails where there were none.** Running a free git command on several repositories now
  asks for confirmation — but only when the command can destroy unpushed work (`reset --hard`,
  `clean -fd`, `push --force`, `branch -D`…); a `git fetch` still runs on one click, because a
  confirmation you always accept teaches nothing. Docker's bulk action does the same for `stop` and
  `recreate`, listing the services it is about to interrupt, and its button turns red as soon as such
  a verb is picked. Stopping a *single* compose service is not guarded: it offers **Undo** instead,
  which costs nothing when the stop was intended.
- **Start a coding session straight from a Jira ticket.** The ticket detail gains a *Let the AI code it*
  button that opens the coding session modal already filled in: ticket content at the top of the prompt,
  suggested branch name and commit message from the key and summary, ticket number set. You pick the
  repository and add your own instructions — nothing is launched until you say so.

- **Mergerie has a face now.** The product mark — an `M` drawn as a commit graph, its two branches
  meeting on a green merge commit — sits in the header (one drawing per theme, since only the ink
  changes) and became the browser tab icon. The tab icon still carries the job state as its
  background: blue at rest, amber while running, red on error.
- **The interface got calmer, and a little more alive.** A study of what makes the tool pleasant to
  live in — it runs all day — turned into a batch of changes that share one rule: nothing is added
  that does not carry information.
  - **Lists stop blinking.** A refresh that changes nothing no longer rebuilds the list, so the page
    holds still while you read it. When a list really does load, its cards arrive in a short cascade
    — once, on load, not on every filter keystroke.
  - **The job log stops eating the browser.** A long run used to pile up tens of thousands of lines
    until scrolling stuttered; the panel now keeps the last few thousand and says so at the top.
  - **You can see how long it has been running, and roughly how long is left.** The remaining time
    only appears once it can be honest — several units done, at least twenty seconds in — and
    disappears rather than lie when the pace changes.
  - **Reading a report survives a refresh.** Scroll position, the tab you were on and the version you
    were comparing are kept while the report itself has not changed; when it does change, you land at
    the top of the new one.
  - **What is running is shown *on* the thing that is running** — the merge request or the session
    itself carries a soft pulsing marker, one object at a time. It stops when the tab is in the
    background and stays still (but visible) if you asked the system for less motion.
  - **New comments landing on a report announce themselves** discreetly, and a resolved discussion
    fades out instead of vanishing between two renders.
  - **`Ctrl`/`Cmd` + `K` opens a command palette**: jump to a tab, a stage, a merge request or a
    session by typing part of its name. `j` / `k` move through the current list, `Enter` opens,
    `Escape` releases. `?` shows the whole list of shortcuts.
  - **The tool reopens where you left it** — same tab, same review stage. Nothing else is restored:
    a stale modal or a stale report is worse than a clean start.
  - **The report panel opens on what changed since your last visit** — arrivals, departures, and the
    one that has been waiting longest. At most three lines, and nothing at all when nothing moved.
  - **A finished job says so once**, even if you were looking elsewhere.

### Changed

- **Action buttons follow one rule now.** A study of every screen found the same three problems
  everywhere, and they are fixed: a destructive button is recognisable **at rest** and not only on
  hover (`Merge`, `Stop`, `Delete` carry a red outline all the time); **one** strong-emphasis button
  per row, card or dialog, so the recommended path is unambiguous — the seven Makefile *Run* buttons,
  `Converge` in the new-session dialog and `Dismiss without review` all went back to neutral; and
  **Cancel is always on the left**, the action on the right, in dialogs and in inline forms alike.
  `Dismiss without review` also lost its green tick — it means "not now", not "approved" — for an
  archive icon.
- **Action rows are grouped by intent, and the grouping no longer depends on the language.** A merge
  request card and a report's detail panel line up their buttons in three declared groups —
  *consult* (view diff, context), *act* (converge, have the AI fix it, re-run) and *close* (mark
  done, merge, delete). Until now the groups were whatever the row happened to wrap into, so the
  same buttons clustered differently in French and in English. A group now stays whole: only the
  space *between* groups breaks.
- **`Delete the report` moved where it belongs.** It used to be the only button on the cards of the
  left-hand list, which put a housekeeping action on the same footing as the whole review journey.
  It now sits last among the report's own actions, in the detail panel, still red and still asking
  for confirmation.
- **The Dev AI columns stopped moving.** In coding, out-of-repo and exploration sessions the action
  column now has a fixed width, and the actions on the *record* (edit, delete) sit below a separator,
  right-aligned. The ✕ is at the same place on all three sub-tabs, whatever buttons the card shows.
- **Coding sessions: `Diff` became `See the diff`** and opens the *same* full-screen viewer as merge
  requests — file tree, whole file with the changes in place, change navigation and minimap — with the
  **AI's report on the left** instead of the review report. The server routes behind both viewers are now
  shared, so there is a single implementation to maintain.
- **`.env.example` is in English**, documents the GitHub TLS variables (`GITHUB_CA_CERT`,
  `GITHUB_INSECURE_TLS`) and makes clear that forge API tokens are *not* set there — they live in
  Settings. It also carries a ready-to-uncomment `NO_PROXY` / `no_proxy` pair listing the hosts the
  agent CLI calls, with the two error messages that tell you it is time to uncomment them.

### Fixed

- **The ticket and forge links were being cut off.** On a merge request to review, they came last
  on the identity line — after the project path, the author and the date — and that line is
  truncated to the width of the card, so they were the first thing to vanish behind the ellipsis.
  The longer the project path, the more certain it was. They now have their own line, where they
  wrap instead of being cut, each with an icon telling the ticket from the merge request. A card
  with neither link does not pay for an empty line. What stays on the identity line — project,
  author, date — can still be truncated on a very long project path, so hovering it now shows the
  full text; the tooltip only appears when the text really is cut, and goes away when the window
  is widened.
- **A card could keep showing stale details.** The check that decides whether a list needs
  redrawing did not look at the project, the author, the date, the branches or the ticket, so a
  renamed repository, a ticket attached after the fact or a changed target branch stayed on screen
  in their old form until a full reload. The check now covers everything the card shows.
- **"t is not a function" instead of "Session not found".** Six routes named their local variable
  after the translation helper, so asking for a session that no longer exists — a stale tab, a
  bookmarked link, a deleted session — answered with an internal error message that told the user
  nothing. They now say what happened.
- **A network failure no longer masquerades as a login problem.** The Copilot CLI says
  "authentication" in two very different situations: when the token is missing, and when it *found*
  a token but could not reach GitHub to validate it. Mergerie only looked for the word, so a machine
  behind a corporate proxy was told its authentication was missing and sent off to run `/login` —
  which fixes nothing. Transport-level signals (`network fetch failed`, `ECONNRESET`, `tunnel error`,
  DNS failures…) are now recognised first and produce their own message, naming the hosts to allow
  and the `NO_PROXY` entry to add. The authentication message is unchanged when it really applies.
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

[Unreleased]: https://github.com/debugall/mergerie/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/debugall/mergerie/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/debugall/mergerie/releases/tag/v1.0.0
