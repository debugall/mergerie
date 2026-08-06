# Changelog

All notable changes to Mergerie are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Entries are written **for the people who use the tool**, not copied from commit messages: what changed for
them, and why it matters. Changes land under **Unreleased** as they are merged into `develop`; when
`develop` is merged into `main` and tagged, that section becomes the released version.

## [Unreleased]

### Added

- **See which projects are alive over the last six months.** A new chart in Statistics: one bar per tracked
  repository — a horizontal bar, longest first, with the name spelled out on the left. The chart has a fixed
  height and scrolls, so twenty repositories fit without pushing the rest of the page down and without a
  single name being cut off. The length is the number of **active days**, not commits: a working day means the same thing everywhere, whereas a commit
  count mostly measures whether you squash — the same work lands as one commit in one repository and forty
  in the next. Being bounded (about twenty working days a month), it also compares honestly across
  repositories. Commits and contributors are one hover away. Each bar is stacked by month, oldest (pale,
  left) to most recent, so the shading says whether the work is recent or old. Clicking a project's name
  opens it over **twelve** months: six months say *which* repositories move, twelve say *in which
  direction* — quiet for two months after ten busy ones is not the same story as dead for a year, and the
  overview cannot tell them apart. The window also names the busiest month and the last month with any
  activity. Bot commits (Dependabot, Renovate, GitHub Actions) are left out: a repository nobody maintains
  but a robot updates weekly would otherwise never be flagged as asleep. Repositories are queried four at a
  time, so a first load over twenty of them takes seconds rather than a minute. A repository with nothing in the last two months turns
  grey and is labelled asleep: still on screen, since that is exactly what you came to see, but not to be
  mistaken for a merely quiet one. Hovering a bar gives the month-by-month breakdown and the number of
  distinct contributors. Counts are cached per month, so a closed month is never paid for twice.

- **Export an AI answer as HTML, Word or PDF.** An agent's answer often has to be read outside Mergerie —
  pasted into a ticket, attached to a report, sent to somebody who does not run the tool. The full-screen
  view now has an **Export** button. The HTML is a **standalone** document: styles embedded, nothing loaded
  from the network, so it reads offline and travels as one file. The `.docx` is a real Word document —
  headings, lists, tables, code blocks — built without installing anything. PDF goes through your browser's
  own print dialog (“Save as PDF”), which lays the page out better than a rendering engine we would have to
  ship. All three carry the title and the date inside the document, since a file loses its name long before
  it loses its content.

- **Read a watched Jira ticket without leaving Mergerie.** Picking a ticket in the “Watched” list now
  opens it on the right, exactly as under “My tickets”: description, metadata, comments, attachments, and
  the same actions — change status, comment, “Let the AI code it”. It is the same panel rather than a copy,
  so the two can never drift apart. Each sub-tab keeps its own selection, and the card's own controls
  (unwatch, edit the reason) still do only what they say.

- **Say why you are watching a Jira ticket.** An optional note next to the key — “blocks the billing
  migration”, “tell Sofia as soon as it is in review”. Three months later a key and a summary no longer
  recall the reason. It shows under the ticket title and can be edited from its line at any time: going
  through unwatch-then-rewatch would lose the date you added it and the last state Mergerie knows, and would
  fire a false notification on the next check. Clearing it is fine too — a stale reminder helps nobody.

- **Filter reviewed merge requests by score colour.** Three checkboxes sit above the list, under
  “Reviewed” and “Processed”: green (7/10 and above), amber (4 to 6.9), red (below 4). They combine, so
  “show me the red and amber ones” is one click each, and each carries the number of merge requests it
  will bring up. The choice is remembered between visits, unticking the last box brings everything back
  rather than leaving you with an empty list and no way out, and the summary on the right follows the
  filter instead of describing merge requests you can no longer see.

- **Ask for a fix on one repository of a multi-repo coding session.** Each project line now has its own
  “Request a fix” button, next to “Run”. A remark is nearly always about one repository — “use
  AbortController here” means nothing in the other four — yet the only way to say it was to send it to the
  whole session: one AI call per repository, to redo work that was already good, and the agent walking back
  over code you did not want touched. The session-wide button is unchanged, and the per-project one only
  shows up from two projects on. An exploration still answers as a whole, so it cannot be narrowed that way.

- **“AI's answer” on an out-of-repo session, not just on each folder.** Looking at the card, the question
  is “what did the AI do?”, not “what did it do in that one folder” — and since the folder list now starts
  folded, the per-folder buttons were a click away. When a session covers several folders the full-screen
  view gains a folder selector, so you move from one answer to the next without closing it.
- **Sessions with several projects now fold away.** Exploration and out-of-repo coding gained the collapse
  that coding already had, and all three start **folded**: past a few repositories a single session filled
  the screen and hid the others, which are exactly what you came to look at. The state is remembered per
  session, so it survives the automatic refresh that redraws the list every second and a half.

- **Objective verification of a merge request.** A review says what it *thinks* of the code; a **verifier**
  says what happens when you *run* it. A verifier is your own script: Mergerie hands it repositories already
  positioned on the right commits and reads its verdict — `✓ verified`, `✗ N tests broken`, `⚠ base already
  red`, `⟳ out of date`. It runs **without a shell**, with an environment that carries **no token**, and its
  answer is validated against a fixed contract: an unreadable output never becomes a green.
  Mergerie runs the same suite on the **base** first, so a test broken by somebody else is never blamed on
  your branch — that distinction is the whole point of the verdict.
- **A verifier can be just a list of commands.** Writing an executable that speaks a JSON contract is a lot
  to ask when all you want is “run `npm ci` then `npm test` in this repository”. So a verifier can now be a
  plain ordered list of commands: the verdict comes from the **exit codes**, the first failing command stops
  the rest, and the report shows what each one did. Commands run **without a shell** — `&&`, pipes,
  redirections and `$VAR` are refused at save time, with the reason, rather than becoming baffling arguments
  ten minutes into a run. One repository per verifier of this kind, because a list of commands runs in one
  directory, not several.
- **One command list, several repositories.** Projects that test themselves the same way no longer need one
  identical verifier each: a “commands” verifier can cover as many repositories as you like, and the list is
  **replayed in each one**, with the verdict being the AND. The order of the commands carries meaning, so
  each line shows its rank and can be moved up or down without retyping anything. Inside a repository the first failing command
  stops the rest, since they depend on it; from one repository to the next it carries on, because they do
  not — knowing that two are broken beats stopping at the first. Failures are prefixed with the repository,
  without which two projects owning a test of the same name would be indistinguishable.
- **Broken test names are recovered without guessing.** A verdict is far more useful when it says *which*
  test broke — that name is what makes the base/head comparison causal. Mergerie looks for it in a
  **JUnit report** if you declare one (pytest, jest, PHPUnit, Surefire, go-junit-report all write it), then
  in the **TAP** many runners emit as soon as their output is not a terminal — recognised with nothing to
  declare, sub-tests not double-counted, `# TODO` and `# SKIP` honoured, and the plan line used to notice a
  truncated output instead of presenting a partial list as complete. When neither is there, the **command
  itself** is what is reported: no invented test count, and a command already red on the base still yields
  “base already red”. The report then also isolates **what is new compared to the base** — the lines that
  appear on the branch and not before, which usually points straight at the regression even behind an
  opaque `make test`.
- **Two verifications can run at once when nothing ties them together.** Refusing every second
  verification outright sent you back to your screen while every other job in Mergerie simply waits its
  turn. What is refused now follows what the runs actually do: a **multi-repository** verification is an
  integration run — it brings up a whole environment, so it blocks everything and is blocked by everything
  — whereas a **single-repository** one is contained in its directory and only has to avoid the *same*
  repository. The refusal says which of the two reasons applies, since they are not fixed the same way.
- **Pick the working directory instead of typing it.** In “in place” mode, a selector now lists the git
  projects of every local directory you have declared — with type-ahead search, since one root commonly
  holds dozens — and fills in the absolute path. Typing a path by hand still works for a directory outside
  any declared root, but a typo there is only discovered on the first run, and costs that run.
- **A confirmation before running anything.** Clicking “Verify” now opens a dialog that says what is about
  to happen — which commands or which script, which repository, which mode, which time limit — and lets you
  pick between the verifiers that cover it. It appears even when only one does: running commands on your
  machine deserves a screen, not a silent click.
- **Verify a merge request that has already been reviewed.** The button now sits on reviewed merge requests
  too, in the list and in the report panel. A review is an opinion, a verdict is a fact; the second keeps
  all its value once the first is in.
- **The contract is written on the screen where you configure it.** Settings → Verifiers unfolds the full
  format: which file is expected (any executable — the extension is irrelevant, but the executable bit and
  a shebang are not, and the Command field takes a path, never a command line with arguments), the JSON
  Mergerie sends on stdin, the JSON it expects back, the limits, and two complete example scripts in shell
  and in Python. Sending someone to the guide to find the exact field names would mean changing screen at
  the exact moment they are writing the script.
- **Verify merge requests together, as a batch.** Some merge requests only hold together as a set: the front
  one and the API one that pass only when combined. Tick them in Reviews and verify them in one run — the
  verdict then applies to all of them. Name the selection and it becomes a **batch**, re-verifiable with one
  button. Two merge requests from the same repository are refused: nobody could say which code was tested.
- **“Fix (AI session)” on a red verdict.** One coding session covering **every** repository of the batch —
  not only the one where the test broke, because the cause of an integration failure is often elsewhere. The
  prompt carries the facts (broken tests, messages, log excerpts, the exact commits tested) and the work
  happens on the merge requests' existing branches, so pushing updates them in place.
- **Two ways to run a verifier, repository by repository.** A throwaway **worktree** created and removed by
  Mergerie, or **in place** in your own working directory when the test environment cannot be recreated
  (local database, warm containers, installed dependencies). In place asks for explicit consent, checks the
  directory really is that repository, and **refuses outright if it has uncommitted changes** — never an
  automatic stash. Your directory is put back on its original ref in every case, including on timeout; if
  that fails, the report says so in a banner instead of burying it in a log.

- **Filter Jira tickets by sprint.** A Sprints chip appears as soon as your tickets carry one. Sprint is
  a custom field whose identifier differs from one Jira to the next, so it is found by its Jira *schema
  marker* rather than its name — a field labelled "Itération" is recognised just the same. The selection
  is applied by Jira itself (`sprint IN (…)`), like projects, so it narrows the search instead of sifting
  a capped extract. Sprints already seen stay on offer after you pick one, otherwise you could never tick
  a second. The **active sprint sits at the top** and is marked as such — it is the one you want nine
  times out of ten, and a date alone does not tell it apart from an upcoming one; the rest follow by
  sprint date, most recent first.

- **Watch Jira tickets and be told when they move.** Some tickets matter to you without being yours —
  the one blocking your work, held by someone else. Checking them by hand three times a day is the
  kind of thing a tool should do. The Jira tab now has two sub-tabs: **My tickets**, and **Watched**.
  Add a ticket by its key, or from the **Watch** button on any ticket's detail; a background check
  (every N minutes, set in Settings → Jira, `0` disables it) compares each watched ticket's status and
  raises a desktop notification giving the old and the new one — *To do → In Progress* — with a click
  that takes you back to the list. The current status is recorded when you add the ticket, so the first
  check cannot announce a change that never happened, and a ticket that disappears or becomes invisible
  is flagged on its own row without interrupting the others or losing its last known status. A change is
  announced **once**: checks are serialised, so the timer and the "Check now" button cannot both report
  the same move, and the new status becomes the reference until it moves again.
- **The Jira status filter now has a search box, like the assignee one.** With a workflow carrying a
  dozen states, finding the one you wanted meant scanning the list. Searching hides rows without
  unticking anything, so a selection is never lost by filtering.
- **Check all / uncheck all on the Jira assignee and status filters.** With a dozen lines, clearing
  everything to keep one or two meant a dozen clicks. Both buttons ship together: uncheck-all on its own
  would be a one-way trip.
- **Ticking nobody in the Jira assignee filter now means "everyone".** An empty selection quietly fell
  back to `assignee = currentUser()`, so unticking every person handed you your own tickets — the
  opposite of what you asked for. It now applies no assignee constraint at all: every ticket the account
  can see, including those assigned to someone else or to nobody. The default, before you touch
  anything, is still your own tickets.
- **The Jira filters now sit on one line above the ticket detail.** Assignees, statuses and the field
  filter stacked three rows deep inside the narrow ticket column, pushing the list down before you had
  filtered anything, and squeezing their own labels. They are now chips on a single row spanning the full
  width above the detail panel, where there is room. The one you open floats over the page instead of shoving it, so
  neither the row nor the list ever moves; clicking outside closes it.
- **A generic field filter in the Jira tab.** Pick the **field** first — epic, type, priority, project,
  assignee, reporter, labels, components, fix versions — then one or more **values**, offered from what
  the loaded tickets actually contain, each with its ticket count. Both the field picker and every value
  list have their own search box; searching a value list **hides rows without unticking anything**, so a
  selection is never lost by filtering. Criteria combine as AND between fields and OR within a field, and
  a criterion with nothing ticked filters nothing — adding a field never empties the list on you. Your
  criteria are remembered.
- **Jira tickets now show their epic, and it opens Jira.** The list carries the epic key and title
  above each ticket's summary, the detail carries it among the metadata, and the search box matches on
  it — asking for "everything under that epic" is a routine need. In the detail panel the epic is a
  link that opens it in Jira in a new tab; in the list it stays plain information, since the whole card
  is the button that selects the ticket. The epic is read from Jira's `parent` field, keeping
  only parents that really are epics: a sub-task's parent is a story, and calling that an epic would be
  wrong. Localised type names (Epic, Épique, Épopée) are handled.
- **The Jira menu now carries a badge: your in-progress tickets.** "In progress" means Jira's *In
  Progress* status category, the only definition that survives across workflows, since status names are
  free-form per project. The count is cached server-side and refreshed by the watch timer, so showing
  it never costs a Jira call — and a status you change from inside the tool updates it at once, without
  waiting for the next check.
- **Stop fetching merge requests from a repository, without disabling it.** Some repositories are needed
  for git operations and coding sessions, but their merge requests are none of your business — and they
  kept filling the review queue. Settings → Repositories now carries a **fetch MRs** checkbox per
  repository, ticked by default. Unticked, "Fetch new MRs" skips that repository entirely; everything
  else about it keeps working. Unticking does **not** purge: merge requests already fetched, and their
  reports, stay where they are — you stop bringing in new ones, you do not lose the old ones. This is
  deliberately separate from **enabled**, which removes the repository from everywhere at once.

- **Asking the AI to fix a review now offers to resume the session that wrote the code.** The coding
  session behind a branch is looked up and its identifier pre-filled, so the agent picks up its own
  work instead of rediscovering a codebase it just wrote. It is a suggestion, not a rule: the link is
  inferred from the repository and the branch, which is not proof — a branch can have been taken over
  by hand — so the field stays editable, and clearing it starts a fresh session as before. Nothing is
  proposed when no coding session matches.
- **Activity — what you launched, and what finished while you were away.** Launch a few reviews and
  coding sessions, come back later, and finding out what is done meant opening every tab and reading
  every card. The log panel gained an **Activity** view: what ran, on what, how long it took, how it
  ended, with the date and time it finished — each line naming its object and leading to it in one click, with the log of any past job
  one more click away. What finished since your last visit is marked, and the count sits on the
  button so the information comes to you. Both the activity view and the queue are height-capped and
  scroll on their own, so opening them never pushes the log itself off the screen. Desktop notifications did not answer this: they live only
  in the server's memory and are deliberately not replayed on load, so anything that finished with
  the tab closed existed nowhere.
- **Multi-repo sessions: fold the project list, push everything, open every MR.** A session on
  several repositories can now **collapse its list of projects** — past a few repositories one
  session filled the screen and hid the others — and the folded state is remembered, so an automatic
  refresh does not reopen it under you. Two grouped actions appear when they have something to do:
  **Push all**, which pushes every committed-but-not-pushed branch in one job, and **Create all MRs**,
  which opens a merge request for each pushed project that has none. The bulk MR dialog asks for the
  options once — squash, delete source branch — and gives each merge request the session's commit
  message as its title, rather than asking for ten titles in a row. In both cases a project that
  fails does not stop the others, and the summary names the ones that did.
- **Run one project of a multi-repo session on its own.** Each project of a coding session now has
  its own **Run** button, and a session with several failures offers **Re-run failed projects**.
  Until now a session could only be re-run whole: on ten repositories where six had succeeded, that
  meant six AI calls to redo good work — and the agent going back over code you did not want touched
  again. A targeted pass also only reserves the repositories it touches, so two projects of the same
  session, on different repositories, can run side by side. Re-running everything is still one click
  away; nothing became implicit.
- **Check branch state — repair a session without spending an AI call.** When projects are stuck in
  *error* although their work is already committed, a button on the session re-reads the real state
  of each branch: if it carries commits its diff is regenerated and the project goes back to *commit
  ready* (or *pushed*), with the **Create MR** button back. Nothing is glossed over — a branch that
  really is empty stays in error, with its message. Re-running the session would fix the same thing,
  but at the cost of one AI call per repository, to redo work that is already done. The button only
  appears when at least one project is in error.

### Changed

- **AI Dev lists lead with what just finished running.** They were ordered by creation, so a session you
  launched minutes ago sat below one created last week and never run. Whatever is running now comes first,
  then the most recently executed. Execution is what counts: fixing a prompt, pushing a branch or tidying a
  session away no longer jumps it ahead of the one that actually just ran.

- **The verifier form now opens on demand.** Settings → Verifiers used to lead with the whole form — name,
  command list, covered repositories — which pushed the verifiers you came to look at off the screen. The
  list comes first now, and “Add a verifier” opens the form; so does “Edit”, already filled in. Saving or
  cancelling closes it again.

### Fixed

- **The inline comment box no longer runs off the side of the screen.** In the code explorer, the diff
  area is as wide as the file's longest line, and the comment editor stretched to match — so on a file with
  one long line, its “Send” button sat thousands of pixels to the right and you had to scroll sideways to
  post what you had just typed. The editor now sticks to the left edge of what you can see and sizes itself
  on its own content, whichever way you scroll. Existing comment threads got the same treatment: they were
  stretched to the same width and read as one endless line.

- **Saving an exploration again no longer resets its repositories.** Reopening a finished exploration and
  saving it — even without changing anything — sent every repository back to “to run” while the session
  itself still read “done”. Mergerie only rebuilds the project rows when their composition changes, but the
  comparison included the base branch, which the run *resolves* and writes back and which the form never
  sends. That branch is a result, not a choice, so it no longer takes part in the comparison. Genuinely
  changing the repositories still rebuilds them, as it should.

- **The base run is replayed every time, instead of being reused.** Mergerie used to cache it per set of
  commits — the base does not move while you iterate, so why pay for it twice? Because the commits are only
  half the story: restart a local service, apply a migration, reinstall a dependency, and the same commits
  give a different answer. The cache was wrong in both directions: a red base you had just fixed outside git
  stayed stuck, blocking the merge request on a "base already red" that was no longer true — and a green
  base that had since gone red made your branch take the blame for a failure that was not its doing. A
  verification now costs two runs; unticking "also run the base" still buys you one, at the price of a
  verdict flagged as non-causal.

- **Dropdown lists no longer spill out of their block.** Any list-with-search — “pick a local project” in a
  verifier, a branch, a git ref — now opens attached to its field and flips above it when there is no room
  below. It used to be clipped by whatever container it sat in, and the workaround for that reset the
  container's scroll position, so the list you were reading jumped back to the top and the menu ended up
  floating well under the block, detached from its field.

- **An “in place” verifier no longer refuses a directory that merely holds untracked files.** It asked for
  a directory with nothing at all in `git status`, which in practice meant almost none: a `.env.local`, a
  build folder, a scratch note were enough to be turned away. What has to block is a checkout that would
  lose work — untracked files are in no commit, so the detached checkout leaves them alone. They are now
  counted, reported by “Test the directory” and noted in the run log, since they are still there while the
  tests run. Modified *tracked* files still refuse the run: Mergerie never stashes your work for you.

- **The report stays put while you scroll the list of merge requests.** Under “Reviewed” and “Processed”,
  list and report shared a single page scrollbar: going down the list to pick another merge request
  carried the report off the screen, and you had to scroll back up to read it — though the whole point of
  the two columns is to look at both at once. Each column now keeps its own scrollbar, and reaching the
  bottom of the list no longer starts moving the page underneath.

- **“Top 5 — recent activity” now shows the time, not just the date.** It ranks repositories by how
  recently they were pushed to, and several of them usually share the same day — so the order looked
  arbitrary. The last-commit column of the projects table is unchanged: there, nothing depends on the order.

- **“Top 5 — recent activity” now ignores repositories you no longer follow.** A repository whose merge
  request fetching is switched off is one you have stopped watching; it had no business heading the list of
  what is moving, and the forge call it cost is exactly what turning that switch off was meant to avoid. It
  disappears from the ranking, and from the “last commit” column, until you follow it again — disabled
  repositories already behaved this way. The caption under the ranking also said “default branch”, which
  stopped being true when the ranking started looking at every branch.

- **A modal no longer takes your typing with it when you click beside it.** Two different mishaps looked
  the same. Selecting text in a field and releasing the mouse a few pixels outside it counts, for the
  browser, as a click on the backdrop — so a dialog you never meant to leave closed, and the prompt you had
  written was gone; the same went for dragging a textarea's resize handle. A click now only closes a modal
  if the mouse was *pressed* on the backdrop too. And a genuine click beside a dialog you have started
  filling in no longer discards it: the dialog gives a short pulse and reminds you that Escape or Cancel
  closes it. Untouched dialogs still close on a click beside them — opening one and changing your mind
  stays a quick gesture — and searching or filtering inside one does not count as filling it in.

- **Tell one AI Dev session from the next at a glance.** A session is a tall block — prompt, project list,
  the agent's questions, an error — and a one-pixel rule between two blocks that size gets lost in the
  whitespace: you could not see where one ended. The three lists now show real cards with air between them.
  The error box, which used to be rendered *beside* the card, sat between two sessions without saying which
  one it belonged to; it now lives inside its own.

- **“Top 5 — recent activity” now looks at every branch.** It only ever read the default branch, so a
  repository where the work lives on feature branches looked asleep for months while people pushed to it
  daily. GitLab is asked for commits across all refs; GitHub has no equivalent, so the repository's events
  — the only place a push outside the default branch shows up — are read instead, falling back to the
  default branch when they are unavailable or older than the 90 days GitHub keeps them.

- **Stop sending the same instructions twice when a session cannot be resumed.** Falling back to a fresh
  session re-injects the context the lost session was holding — which is right for a follow-up request, but
  a first run already carries the whole task. The prompt, review report included, was therefore sent twice
  in a single call.

- **Escape no longer leaves a button spinning forever.** Some dialogs hand back a promise — the one that
  asks which verifier to run, for instance. Closing them with Escape hid the dialog without settling that
  promise, so the button that opened it stayed in its loading state indefinitely.

- **Say when a requested agent session could not be resumed.** An agent session belongs to the directory
  it was created in, and Mergerie works in its own clone — so an identifier taken from your own checkout,
  or from a session opened by hand, is never found there. The work already restarted from a fresh session
  with the context re-injected, but the substitution was only visible in a log line that scrolls away: the
  card now says it, and the field warns as soon as you paste something.

- **“Merge” and “Create the MR” now show they are working.** Both call the forge, which takes a moment
  while the dialog stays on screen; with no indicator the button looked inert and invited a second click.



- **Hiding a status now narrows the search instead of sifting an extract.** Jira caps a search at a
  hundred tickets; unticking a status only removed it from those hundred, so tickets you expected to
  surface never did. The exclusion is part of the query now, like projects and sprints. Custom workflow
  statuses were already handled — the colour follows the status *category*, not its name — and a status
  stays on offer once hidden, so you can put it back.
- **The status filter now lists your workflow's statuses, not just the ones on screen.** A status that
  exists but happens to be on none of the fetched tickets was simply not offered. The statuses of the
  projects concerned are loaded alongside — the selected ones, or those of the tickets shown. Not the
  whole instance: that would add dozens of unrelated entries, and the endpoint for it requires
  administering Jira, which most accounts cannot.

- **The Jira ticket list no longer changes width with the tickets in it.** A long title stretched the
  left column from 360 to 610 pixels, so filtering made the whole layout jump. A flex item refuses by
  default to go below the width of its own content; the column now holds its size, and a long title wraps
  onto the next line instead of being cut — it is what tells you whether to open the ticket, so hiding
  half of it meant hovering to read it.
- **The "watch a ticket" key box looks like the rest of the tool.** It was the one unstyled browser
  input among styled controls. It now has the same treatment as the other fields, in a fixed-width
  font — you type a reference there, not a sentence.

- **Filtering by project no longer makes tickets vanish.** Narrow to your own tickets, pick the project,
  then drop the assignee filter, and the tickets you were looking at disappeared instead of being joined
  by their colleagues'. Jira caps a search at a hundred results ordered by last update: with no assignee
  constraint those hundred come from the whole instance, and your project's tickets can be nowhere in
  them — the project filter was then sifting an extract, not the project. The selected projects are now
  part of the query Jira answers. And whenever a list is capped, the counter says so ("100 of 340 shown")
  instead of letting it look complete.

- **A Jira ticket's title no longer shares a line with the buttons above it.** A global `header` rule
  written for the app's own header applied to *every* `<header>`, including the one in the ticket detail:
  its title and chips were laid out beside the action buttons instead of below them. The rule is now
  scoped to the app header.
- **The ticket key in the watched list opens Jira.** It was plain text, while every other key in the tool
  is a way to get to the ticket.
- **Confirmation messages are no longer written in red.** Every toast used the error colour, so
  "Repository updated" looked exactly like a failure — the one thing a confirmation must not do. A
  success now carries a discreet green edge and reads in the normal text colour; an error keeps its
  full red border and red text, and still stays on screen until you dismiss it. The louder of the two
  is the one that needs you.
- **A Jira refusal now says what Jira actually refused.** Errors surfaced as a bare "Jira 400 Bad
  Request": the response body, where Jira explains itself ("The JQL query is unbounded", "Field 'x' does
  not exist"), was thrown away. Its messages are now part of the error you see.
- **Asking for every assignee no longer breaks the search.** With nobody ticked and done tickets included
  there was no constraint left at all, and Jira Cloud rejects an unbounded query. The search is now bounded
  to the last year of activity in that one case — invisible in practice, since the list is sorted by last
  update and capped at a hundred results.
- **Creating a coding session no longer fails with "t is not a function".** Any validation problem —
  a missing branch name, the same project picked twice, an unknown project — produced that message
  instead of the real one, because a callback parameter shadowed the server's translation function.
  The four messages now say what is actually wrong. The same shadowing existed in fourteen other
  places, all waiting to bite the same way; they are renamed, and a new check (`npm run check`) fails
  the build if the name `t` is ever bound to anything but the translation again.
- **Demo mode applies Jira status changes for real.** Picking a transition answered "ok" and changed
  nothing: the list reloaded on the old status, and the menu counter never moved. A demo that accepts an
  action without reflecting it teaches the opposite of what the tool does.
- **Demo mode can finally open the code viewer.** "View diff" — on a merge request as well as on a
  session project — failed every time in demo mode: the viewer goes through a real git clone, and the
  demo repositories point at a forge that does not exist. Anyone discovering the tool hit an error on
  one of its most central buttons. Demo mode now serves a coherent fictional repository: real unified
  diffs, a browsable file tree, per-file diffs, and file contents. As everywhere else, a path outside
  the tree is still refused — a demo must not teach the wrong reflex.
- **"Fetch new MRs" no longer fails in demo mode.** The button sits at the top of the home screen, and
  pressing it in the demo produced one red "GitLab token not configured" card per repository — the
  first thing a newcomer saw. A scan now legitimately reports what is already there, without going
  near the network.
- **Stop now really stops the agent.** The button did what it promised everywhere except where you
  press it: queued jobs were cancelled and git steps were interrupted, but the agent itself — the
  long phase, and the reason one presses Stop at all — kept running to its fifteen-minute timeout,
  still writing into the clone and still spending tokens. Its process was never registered with the
  cancellation machinery, so the stop flag was raised with nothing to kill. It is registered now,
  like the git and copilot paths already were.
- **The red Docker badge no longer counts containers you stopped yourself.** A container that
  exited cleanly — you stopped it, or a job finished its work — was counted as red alongside
  crash-looping ones, so the alarm rang every single day; an alarm that always rings stops being
  read. Only what is actually wrong is counted now: *restarting* / *dead*, plus containers that
  exited **with an error**. Clean stops stay visible in the tooltip, just not in the number, and a
  container whose exit code cannot be read is left out — one does not cry wolf on a guess. The
  state filter gained a matching **Exited with an error** entry, next to the existing *Stopped
  (exited)* which still covers both.
- **Re-running a session whose work was already committed no longer reports a failure.** When a
  project failed *after* its commit — a refused push, for instance — re-running it sent the AI over
  code that was already written. It changed nothing, and "nothing to commit" was read as "the AI
  replied instead of coding": the project went back to *error*, with no diff and no **Create MR**
  button, although the work was there and ready. The branch is now inspected before concluding — if
  it already carries the work, the session picks up where it was, diff and MR button included. A
  branch that really is empty still gets the explicit message, with the AI's own answer in it.
- **The agent could fail with "no stdin data received in 3s".** Every agent process was started with
  an open standard input that nobody ever wrote to or closed, so the CLI waited for data, warned
  about it, and that warning ended up masking the real reason in the failure message — when it did
  not make the process exit outright. Standard input is now closed on launch, which is exactly the
  `< /dev/null` the CLI itself suggests.
- **Relaunching a failed session left its error badges on screen.** The previous failure was only
  cleared when the job actually started, so between the click and the start — minutes, behind a busy
  queue — the card still read *error* and nothing told you the click had been taken. Asking for the
  work again clears the failure right away, on the session and on each of its projects, and the list
  refreshes without waiting for the next poll. Same for off-repo sessions.
- **A job finishing next to another one refreshed nothing.** Since several jobs can run at once, the
  end-of-queue refresh never fired while any other job was still running, so a card kept its old
  state — stale error badge included. Lists now refresh as soon as the object they show stops being
  worked on.

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
