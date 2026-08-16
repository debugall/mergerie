# Changelog

All notable changes to Mergerie are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Entries are written **for the people who use the tool**, not copied from commit messages: what changed for
them, and why it matters. Changes land under **Unreleased** as they are merged into `develop`; when
`develop` is merged into `main` and tagged, that section becomes the released version.

## [Unreleased]

### Added

- **A verifier can now start by itself on every new merge request.** Tick `Run on every new
  merge request of the covered repositories` and the battery runs at discovery, without a
  click — which is the whole point: verifying required noticing the merge request first. Only
  new merge requests trigger it, since a known one is seen again at every sync. At most five
  verifications per discovery round, because fifteen functional batteries would saturate the
  machine for an hour and block the queue shared with reviews; beyond that the merge requests
  keep their `Verify` button and the server log says what did not start. Verifications of the
  same repository queue up instead of being refused — they never run together, but none is
  silently lost.

- **`See the verifiers' results` on a merge request.** The button opens the details of every
  verifier that ran on it: verdict, tested commits, broken tests, and the command-by-command
  breakdown with exit codes and output. It shows up as soon as a result exists, not only when
  something is red — "it is green, but what exactly ran?" is a fair question, especially now
  that a battery can start without you seeing it. A stale result says so, and each red block
  carries its own `Fix (AI session)` button, because a single button at the bottom would not
  say which report it fixes.

- **“The AI may ask me questions” now covers out-of-repo coding and exploration.** The option
  only existed for coding inside a repository, yet an exploration hesitates the same way — and
  out of a repository it matters most, since the agent works in place, with no branch and no
  commit to re-read. In all three flavours the session now goes into waiting, shows its
  questions on its card, and resumes in the same agent session once answered. An exploration
  asks once for all its repositories, which share one session; out of a repository each folder
  has its own questions, and answering one does not make the others work again. While a question
  stands nothing has been done: no summary is saved, no file is touched. The todo raised for an
  out-of-repo session carries its own kind, so it cannot be confused with — or closed by — a
  repository session that happens to have the same number.

- **A verifier can be duplicated.** Covering ten repositories with the same command save one
  detail meant retyping everything — or worse, editing the existing one while believing you were
  creating another. `Duplicate` reopens the form filled with the original's commands, timeout,
  options and covered repositories, but **without its id**: saving creates a new verifier instead
  of overwriting the one you started from. The name cannot be copied as-is — they are unique, and
  the save would fail after you had adjusted everything — so "X (copy)" is proposed, then
  "(copy 2)", with the field selected because renaming is the first thing you do.

- **Standing instructions, added to every coding session.** *Settings → AI sessions* holds a free
  text field appended to the prompt of every coding session — in a repository and out of one, on
  the first run as on every follow-up. It is what you repeat every time: the language of
  comments, a command to run before committing, something not to do; copying it into each prompt
  works right up to the day you forget, and that is always the one you re-read three hours later.
  It comes after the task and before the questions block, it is re-read on every prompt so a
  change applies to the very next session, and an empty field adds nothing — not even an orphan
  heading. Exploration is left out: it produces no code.

- **A session stopped on a question raises its own todo, and answering closes it.** When the AI
  interrupts itself to ask something, the queue is free, nothing will restart, and the desktop
  notification was dismissed long ago — so a high-priority todo is created, naming the session
  and the projects concerned, and it sits in Notes and in the morning brief until you answer.
  On a multi-repository session it only closes once no project is waiting any more. It stays an
  ordinary todo: the tool raises it and closes it, it does not take over what you did with it.

- **The morning brief counts the sessions waiting for a gesture.** How many were never run, how
  many are committed but not pushed, how many are pushed without a merge request — the work is
  done, only a click is missing. Numbers rather than lists, and a branch that already has an open
  merge request is not counted.

- **The Jenkins menu carries a badge: how many jobs ran today.** The question you ask walking
  past the tab is "did anything move this morning?", not "how many jobs exist". It is filled
  once at startup, like the Docker badge, then kept current by the tab's own refresh — Jenkins
  is not polled from the other tabs. Nothing ran today means no badge at all: a zero in a menu
  teaches nothing. A job that ran five times counts once, since the list only carries each job's
  last build; the tooltip says "jobs", not "runs".

- **Jenkins parameters that recur across jobs carry a colour, and can be filtered.** On a team
  installation the same three or four parameters come back from one job to the next; shown in
  each job's own order, the eye has to hunt for them on every line. From three jobs on, a
  parameter gets a tint derived from its name — so it never shifts as jobs come and go — and a
  dropdown above the list to filter on its values. A filter you do not need can be put away with
  a cross, its value cleared with it, and it comes back from the same window as hidden folders.
  Three rather than two: at two, a coincidence between two jobs would colour it for everyone.

- **The todo list can be arranged by hand, inside each priority.** Priority still comes first —
  it answers "what is pressing" — and your own order arranges what sits inside it: drag a row by
  its grip, or use the two arrows on each row, since dragging is neither announceable nor reliable
  with a keyboard or a finger. Reordering never crosses a priority boundary: the todo would spring
  back, and a gesture that does not land is worse than no gesture; changing group means changing
  the priority, which is an explicit gesture of its own. The order is saved, a new todo lands at
  the top of its group where you just typed it, and the due date keeps feeding the morning brief
  and the reminders. Existing lists keep the exact order they had, and done and archived todos
  keep their chronological order — you do not arrange your drawer.

- **Inline comments can now wait.** Next to "Comment on GitLab", which still publishes right
  away, a `Save` button keeps the remark pending and local: you review a merge request file by
  file, and sending one at a time showers the author with notifications while freezing remarks
  you would have dropped three files later. Pending comments show under their line in amber, can
  be edited and deleted, and a header button sends them all at once — asking first, and saying
  how many are about to be published. Whatever fails stays pending with its reason, so a network
  error on the third comment does not take the first two with it, and positions are resolved at
  send time so a merge request that moved meanwhile is not annotated on code that no longer
  exists.

- **A job's history shows what each run went out with, in the same colours as the list.** Two
  green lines from the same afternoon are told apart by their parameters, and nothing else:
  reading them meant clicking each run in turn. Every line now carries its parameters as
  name/value pills under it, tinted from the parameter's **name** — so `ENV` has the same colour
  in a job's history as it has in the job list, and the eye follows a column down without
  reading. In a history every parameter comes back on every line, so they are all tinted.

- **Find the run you are thinking of, then start from its values.** "When did this last go to
  production, and with which version?" is the question you ask in front of a deployment job's
  history. Each parameter the history carries gets a filter above it, and a `Reuse` button on
  every matching run fills the launch form with that run's values — without sending anything,
  because the reason to start from an old run is usually to change one thing. The filters
  **suggest** the values they have seen rather than restricting you to them: the values on
  screen are only those of the runs loaded, and a value that does not appear is still perfectly
  valid, so it can be typed. And filtering does not stop at the ten runs shown: the first time
  you filter, the job's history is fetched deeper, once, so a run from six weeks ago is found
  instead of answering "no matching run" about something that did happen. A value that no
  longer exists among the job's choices is added back and flagged rather than silently dropped —
  a field quietly left on something else would launch with a value nobody chose.

- **`Run again` on a Jenkins job, with the same parameters.** In the list it reuses the last
  run's values; in the job's page every run in the history has its own button and reuses that
  run's values — what you want after reading the console of a failed build. The confirmation
  shows the values about to be sent, because "run again" says nothing if you cannot see with
  what, and it counts the secret parameters that cannot be sent back: Jenkins will fall back to
  their defaults rather than the job going out silently amputated.

- **Jenkins parameters whose values are computed now come through.** Git Parameter (a repo's
  branches and tags), Extended Choice, Active Choices: these plugins do not declare their
  options, they compute them while rendering their own page, so no API request will ever return
  them. Mergerie now reads Jenkins' build form for the parameters the API said nothing about —
  what the API declares still wins — and a multiple choice stays multiple, sent comma-separated
  as those plugins expect. When the page cannot answer either, the field stays empty and says
  so, as before.

- **The Jenkins tab refreshes itself, tells you when your own job is done, and opens each run
  side by side.** The list refreshes every 30 seconds — only while the tab is open and the
  window visible, with a checkbox to turn it off and the choice remembered — and a background
  refresh never blinks the list nor wipes it when the network hiccups. A desktop notification
  fires when a job **you** started from Mergerie finishes, with its verdict; the team's nightly
  builds stay silent, because being told about those is how you end up turning notifications
  off. A job's page is now two columns: the run history on the left, each run keeping its
  Console button, and on the right the run you select — when, how long, by whom, on which
  branch, and with which parameters and values. Every line, and every run, carries a link that
  opens it in Jenkins in a new tab.

- **The Jenkins list shows the parameters the last run went out with.** Up to three per line,
  the rest counted and spelled out in the tooltip. They cost nothing: they already came with
  the list, in the same request. Password parameters are left out — Jenkins returns an
  encrypted form and a secret does not belong in a list — and so are empty values.

- **Jenkins folders you never use can be put away.** A cross on a folder's checkbox takes it
  out of the filter list — unticking says "not now", hiding says "not my subject" — and its
  jobs go with it, since a job you cannot filter has no business being in the list. The hidden
  ones stay listed in small type underneath, and one click brings back the one you want; their
  ticked state is kept meanwhile. Remembered across sessions, like the rest of the filter.

- **The Jenkins list now reads by freshness, and says who ran what.** Jobs are sorted from the
  latest run to the oldest — in a list of three hundred, what just ran is what you came for —
  with the never-run ones at the end. Each line carries the date of the last build, its number,
  who started it (or what did: the scheduler, a push, an upstream job) and the branch or tag
  that was built. Folders moved to the top as a filter: one checkbox each with its job count,
  its own search, and the choice is remembered. It stores the folders you *unticked*, so a
  folder your team creates tomorrow shows up on its own.

- **Jenkins behind a corporate certificate.** An internal server is almost always served by a
  certificate a freshly installed Node does not know, and Node's own message — *unable to get
  local issuer certificate* — names neither the cause nor the cure. `JENKINS_CA_CERT` pins your
  internal CA (the clean way) and `JENKINS_INSECURE_TLS=1` skips the check while troubleshooting,
  for Jenkins only, exactly like the GitLab and GitHub settings. The error now names both
  variables, and so does the Settings → Jenkins page.

- **A Jenkins tab: see where your jobs stand, and run them.** Every job your account can see,
  grouped by folder, with a search (a company installation lines up hundreds) and a filter for
  what is failing, unstable or running. A job's page shows its parameters and its last ten
  builds, and each build's console opens in one click, scrolled to where the error is. Running
  always asks first and names the job — it deploys on a shared machine and cannot be cancelled
  from here — and a parameterised job opens its page instead of starting, so the values you are
  about to send are values you have seen. Nothing is polled: the screen asks when you open the
  tab or hit Refresh. The connection (URL, user, API token) lives in a new **Settings → Jenkins**
  tab, with a test that returns the account name the server sees.

- **A brief line can be dismissed for good.** The morning brief recomputes everything each time it
  opens, so a fact that stays true comes back every day — a failed verification you have already
  been through reappears indefinitely and eventually teaches you to skip the section. A cross on
  hover dismisses the line: verifications, waiting sessions and merge requests. It dismisses the
  *finding*, not the subject — a new verification of the same set reappears, because a real
  regression must never stay invisible. Nothing is deleted, the brief says how many lines it hides,
  and one button shows them all again. A dismissed line makes the next one move up, so a section
  never shrinks below what is really left to do.

- **Running a session again now asks first.** `Run again` sends the **initial prompt** once more:
  the agent starts from the beginning, on top of work already produced, and anything asked since —
  follow-ups, answers to questions — is not replayed. The button sits next to the ones you use all
  the time, and one click too many costs a whole session. The confirmation says what is about to
  happen rather than just "are you sure?", and the very first run stays a single click.

- **A follow-up can be written while a session is running, and sent when you decide — or by
  itself.** The remark comes while you read what the agent is doing, not twenty minutes later — so
  you write it there and then, and it waits on the card. You can reword it as long as it has not gone
  out, delete it, and send it in one click once the session is over. A checkbox, **`Send it
  automatically when the session finishes`**, arms it instead: the card then reads *Follow-up armed*
  and the session chains the follow-up on its own. Unticked — the default — nothing sends it for you.
  Armed or not, it goes out **once**: the text is consumed before launching, so a session cannot loop
  on its own follow-up, and nothing goes out after a failure or while the agent is waiting for an
  answer. A verifier chosen for the session waits for the automatic follow-up before rendering its
  verdict. Applies to coding, out-of-repo and exploration sessions.

- **A session can carry a short label.** Coding, out-of-repo and exploration sessions take an
  optional title at creation: a list is otherwise read through its prompt, three folded lines whose
  first words look alike from one session to the next. The label says what a session is about where
  the prompt says what to do; it heads the card, joins the search, and can be changed later. It is
  never sent to the AI and never used as a commit message — it is a filing title, and a test keeps
  that door shut. Out-of-repo sessions have their own form wiring, so a browser test covers all
  three families rather than one.

- **A coding session can carry a verifier, and runs it by itself when it is done.** Picking one in
  the session form makes it run once at the end — after convergence if you converge, after the coding
  run otherwise — so you launch in the morning and find a verdict rather than one more box to tick.
  Only verifiers covering every repository of the session are offered. A verifier reads what the
  forge exposes, so it needs pushed code: picking one ticks auto-push and says why, and unticking
  auto-push drops the verifier — the server applies the same rule, not just the screen. Nothing
  pushed, coverage lost or another verification already running are refusals written in the
  session's log; none of them fails the session, whose code is written either way.

- **A Links tab — the work links your bookmarks cannot structure.** The same service exists in local, dev,
  staging and production; a folder tree scatters it across four places. A **grid** shows it at once —
  services as rows, environments as columns, one URL per cell. That URL is written out, never guessed from
  another by swapping a piece of domain: that kind of magic eventually sends you to the wrong environment
  without a word. An empty cell takes the address in place, no dialog. Whatever has no environment
  dimension — Confluence, a doc, a tool — stays a **free link**, found by tag.
  - **A global palette** on `Ctrl`/`Cmd`+`K` or the `o` key, and a search field in the header so it can be
    found without knowing the shortcut. It searches everything at once: grid cells, free links, merge
    requests, watched tickets, note pages, open todos and navigation actions. Fuzzy by subsequence
    (`kib pre` finds “Kibana · preprod”) and ranked by **frecency** — what you open often *and* recently.
  - **Contextual buttons on merge requests** when a service is linked to a repository: its grid URLs, plus
    **templates** with `{env}`, `{branch}`, `{mr_iid}` and `{service}` resolved on click. Unknown variables
    are refused as you type them, every substituted value is URL-encoded, and a variable with no value here
    leaves the button greyed with its reason rather than a URL with holes.
  - **Chrome bookmarks import**, preview first: the folder tree as it was, each link tickable, tagged by its
    folder path. Replayable — re-importing the same file does not duplicate what is already there. The file
    is parsed, never executed.

- **The navigation moved into a left sidebar.** At nine entries a horizontal bar was out of room — “AI Dev”
  already wrapped onto two lines. Vertically each entry gets its own row, its badges fit, and the tenth
  costs nothing. The bar collapses to icons from a button at the foot of the column, remembers the choice,
  and collapses on its own below 1100 px. The header space this freed now carries the palette's search
  field, which had the opposite problem: being invisible unless you knew the shortcut.
  The README's animation was re-recorded on the new shell, and the settings that turn the recording
  into that GIF now live in `scripts/demo-gif.sh` (`npm run demo:gif`) instead of having to be worked
  out again each time.


- **Back up your data in one click.** Settings → General now produces a dated `.zip` holding the database
  and every file it points at — reports, agent answers, context screenshots — plus a short note on how to
  restore it. The database is copied through SQLite's own backup API rather than a plain file copy, which
  would silently produce a corrupt file if a write happened mid-copy. Clones and worktrees are left out on
  purpose: a `git clone` brings them back, and including them would multiply the archive size for nothing.
  Until now the months of accumulated work — reports, verdicts, resolution tracking — lived in a single
  folder that no command could export.

- **History no longer grows forever.** Job logs, finished jobs and the activity feed are now trimmed past a
  configurable age (Settings → General, 90 days by default, `0` to keep everything). The cleanup runs at
  startup then once a day, never touches a job that is still running, and leaves two things alone on
  purpose: token costs, whose running total must not drop by itself, and agent iterations, which already
  disappear with their session.

- **An orange badge on Reviews counts the weak reports still waiting.** Next to the blue “to review”
  count, it shows how many reports scored **under 7/10** have not been dealt with yet — which ones to read
  first, rather than how many exist. It only counts the *Reviewed* stage, so marking a merge request as
  processed brings it down: a counter that never goes down stops being looked at.

- **See which projects are alive over the last six months.** A new chart in Statistics: one bar per tracked
  repository — a horizontal bar, longest first, with the name spelled out on the left. The chart has a fixed
  height and scrolls, so twenty repositories fit without pushing the rest of the page down and without a
  single name being cut off. The length is the number of **active days**, not commits: a working day means the same thing everywhere, whereas a commit
  count mostly measures whether you squash — the same work lands as one commit in one repository and forty
  in the next. Being bounded (about twenty working days a month), it also compares honestly across
  repositories. Commits and contributors are one hover away. Each bar is stacked by month, **one colour per
  month** with a legend underneath, oldest on the left to most recent on the right, so you can point at a
  month instead of counting segments. Clicking a project's name
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

- **Notes, todos, reminders — and a morning brief.** A new **Notes** tab replaces the sticky notes and the
  notepad tab of everyday work, with one difference that is the whole point: it lives inside Mergerie, so a
  note can point at what you actually track, and it travels in the backup.
  - **Today** opens the day: reminders due, today's todos, sessions where the AI is waiting for an answer,
    failed verifications, merge requests that arrived since yesterday, and those reviewed days ago but still
    open. Action-first, each section hidden when empty, every line clickable. It is computed entirely from
    the local database — **no AI call, no token, no network** — so it appears instantly. On the first opening
    of the day the app lands here rather than on the tab you left; once a day, and switchable off in
    Settings → General.
  - **Todos** with high/normal/low priority and an optional due date that doubles as a **desktop reminder**,
    snoozable by **+1 h** or **tomorrow 9 am**. Ticking one keeps it, struck through, for seven days, then
    files it under *Archived* — nothing is ever deleted behind your back.
  - **Pages** of free-form notes in Markdown, with live preview, autosave, pinning, search over title *and*
    content, and export to `.md`.
  - **`n` from anywhere** opens a one-field capture: type, Enter, done — no navigation, because you were in
    the middle of something else.
  - **`!214` and `PROJ-720` become links** wherever you write them. If a number exists on several
    repositories the link goes to a pre-filled search rather than guessing one; if it exists nowhere it stays
    plain text rather than becoming a dead link.
  - A **merge request** or a **Jira ticket** can be added to the todos in one click, pre-filled and linked —
    and if one already follows that object, the button says so instead of creating a silent duplicate.
  - The tab carries **two badges**: red for what presses — todos **overdue** or at **high priority** — and
    blue for the rest still to do, their sum being the number of open todos. Red does not read off the
    “High” badges alone: a normal todo whose due date passed three days ago asks just as much, and lateness
    is exactly what gets forgotten. Hovering says what the number is made of.

- **The full guide now exists in English.** Every tab, objective verification and its script contract,
  `.env` configuration, enterprise TLS, local clones, data & backup and the security model — the whole
  document, not a summary. Until now the only complete documentation was in French, which put anyone
  arriving from the mirror in front of eleven hundred lines they could not read. The two versions must keep
  the same section structure, and `npm run check` fails when they drift apart or when a link points at a
  heading that no longer exists.

### Changed

- **The Settings sub-tabs are ordered by the journey, and the first one is Git.** The old order
  told the story of the order in which features were written: the bar opened on "Specific review
  rules", whose contents apply to nothing as long as no repository is tracked and no token is
  set — while the onboarding was already sending its own first step to Git. It now reads
  connect (Git) → choose the code (Repositories) → tune the review (Merge Request, Rules,
  Verifiers) → tune the tool (Notifications, General) → the optional integrations (Jira,
  Jenkins) → the test bench. A fresh install therefore lands on the token without which nothing
  works, the last sub-tab you visited is still remembered (by name, so nobody is displaced), and
  three tooltips that had stopped being true were fixed along the way.

- **The "review skill" setting is gone: the skill is written in the prompt template.** A field
  of its own meant understanding that it fed a `{skill}` hole hidden inside a text you can
  rewrite anyway — and the template is exactly where you choose what you ask the AI. Existing
  installations are migrated: whatever skill was configured is copied into the templates, so
  nothing changes for anyone and no `{skill}` is left to be sent verbatim to the agent. A
  template that was never touched comes out identical to the default, so it keeps following the
  interface language.

- **The commit message chosen for a session now applies to every one of its commits.** It was
  used by the first run only: a follow-up committed under its own first line, the resume after
  questions under a fixed sentence, and a convergence pass under the pass number. Anyone who
  prefixes commits with a ticket key or a team convention had the rule broken exactly where
  nobody re-reads it — the commit is already pushed. When the field is filled it is now the
  rule for the whole session; left empty, nothing changes and each gesture keeps its own
  default, which says what it just did.

- **A Jenkins job's page is three separated blocks instead of one flat sheet.** The launch form,
  the run history and the details of the selected run all sat on the same background, with the
  same gap between two zones as between two lines: it read as one column, not three subjects.
  Each is now a card of its own on a recessed background — the boundary is seen rather than
  inferred, in both themes. The history became a real list (rules between rows, no floating
  gaps, the date on its own line so verdicts line up), the selected run is marked by an accent
  bar and a bold number and not by a shade of grey alone, and the filters sit in a header that
  stays put while you scroll — filtering after ten lines no longer means scrolling back up.
  Only the body scrolls now, so `Run` stays reachable instead of sinking under the history, and
  the run details follow you down: comparing "what I am about to launch" with "what went out
  last time" is what this window is for.

- **The Jenkins refresh interval is now a setting.** *Settings → Jenkins* holds it — every N
  minutes, 0 = never, one minute by default and capped at an hour — instead of a hard-coded
  30 seconds, and it lives in the database like the merge request and Jira intervals rather than
  in one browser. It applies without reloading the page. The tab's "Do not refresh on its own"
  checkbox stays as a local, immediate pause that wins without touching the setting.

- **The Jenkins filter dropdowns look like the rest of the tab.** Raw browser selects belonged
  to neither the chips below nor the folder boxes above; each filter is now a pill — parameter
  name inside, value on the right, drawn chevron — and it tints when a value is picked, so an
  active filter is visible without reading it.

- **The Jenkins menu icon says which tab it is.** It used to be the play triangle — the very
  symbol on the tab's own "Run" buttons, which told you the tab could start something rather
  than what it was. It is now a pipeline: one stage feeding the next, which is what a Jenkins
  job is, and it cannot be mistaken for the git branch icon two rows above.

- **The parameters in the Jenkins list are readable.** They sit on their own line as
  name/value chips instead of trailing the status, the date and the author — all grey, all
  separated by middle dots, which read as a sentence rather than as pairs.

- **The Jenkins list spells out every parameter of the last run.** It used to show three and
  count the rest as `+2`, which sent you hovering or opening the job's page for the very
  question you were asking while reading the list. Lines wrap instead. Values longer than 60
  characters are still cut — three thousand characters in a list row is a wall, not information.

- **The Jenkins job search now matches what the line shows.** Not just the path: the branch or
  tag, who started the run, and the parameters it went out with. Searching `ENV=prod` and
  finding nothing while it is written on screen is the surest way to stop using a search field.

- **The Jenkins job page and build console are wider.** The history now sits next to the run
  details, and console lines of three hundred characters had nowhere to go in 900 px.

- **A Jenkins job that expects parameters now says so before you click.** Its button reads
  `Run…` and its tooltip gives the number of parameters, and the job's page explains that the
  values shown are the ones that will be sent. The behaviour had not changed — the button
  already opened the page instead of launching blind — but nothing announced it, so the page
  read as an information panel rather than the form it is.

- **The tab shortcuts now go up to ten.** With Jenkins the bar holds ten tabs, and there is no
  "10" key: the tenth is on `0`, as in a browser. Without it, adding a tab silently took its
  shortcut away from the last one — and the help sheet reads the real range from the bar.

- **`Request a fix` is now `Send a follow-up`.** The button was named after one of its uses, and
  people were using it for all the others: asking for changes, giving further instructions, asking
  what was done and why. One word now covers the whole cycle — *prepare a follow-up* while the
  session runs, *follow-up waiting* on the card, *send the follow-up* when you decide — and the
  tooltip says what actually happens: the session continues, the AI keeps all its context. The
  exploration button (`Follow-up question`) and the form's `Run iteration` / `Ask the question`
  follow suit.

- **The tabs are reordered into four pairs.** Their order used to be the order they were *added* in, not a
  designed one — which put Stats, the rarest tab and one of the three carrying no badge, in third place, and
  Notes second-to-last even though it holds the morning brief the app opens on. They now read
  **Reviews · AI Dev** (the core: review, produce), **Notes · Jira** (what I have to do: my todos, my
  tickets), **Git · Docker** (my machine: repositories, containers), **Stats · Settings** (the meta: measure,
  configure). At eight items a flat list gets counted rather than scanned; four pairs are remembered — and
  the number shortcuts become learnable along with them. The keys now follow the bar **read from the DOM**
  instead of a list copied beside it, which could silently drift so that `3` opened something other than the
  third tab. The command palette and the guide follow the same order.

- **The Statistics menu entry is now “Stats”, and the tagline sits on two lines.** With an eighth tab in
  the bar, the longest label was the one that could most afford to shrink — English already said “Stats”.
  The tagline under the product name no longer runs all the way to the navigation: it breaks where the
  sentence does, between what the AI prepares and what you merge.

- **The Links tab now leads with what you do every day.** Its top bar carried setup buttons only —
  new environment, new service, import — while finding a link, the daily gesture, had no place at
  all. A single search field takes that space and filters **both halves of the screen**,
  grid and free links together; `+ Add` and a `⋯` menu hold the rest. When the grid has nothing but
  the free links do, the message points down instead of claiming nothing matches. Creating a service
  now asks for its addresses, one row per environment, and scrolls to the new row rather than
  leaving you to find it. Columns can be reordered from their header, services pinned to the top,
  and the free-link checkboxes only appear when you ask to select.
  The `⋯` menu also carries **Delete every free link** — the escape hatch from a bad bookmark
  import, with a confirmation that states the count and says the grid is left alone.

- **A grid cell can hold several addresses, each with a name.** One cell was one URL, so writing a
  second one silently overwrote the first — which is wrong the moment a service exposes more than
  one view in the same place: a production Kibana is as many addresses as it has saved filters. Each
  now carries a name (“payment errors”, “API latency”), the pencil opens one row per address, and the
  palette finds each by its name. How many a cell shows is judged on the row: under five addresses
  everything is displayed, past that a `+N` expands in place and its tooltip names what it hides.
  `Expand all` opens every cell at once and is remembered. Existing cells are carried over untouched,
  as single unnamed addresses.

- **Filters for environments and services, labelled and always on screen.** Environments are chips
  that hide columns — one click means “that one”, and a service with no address in the kept columns
  drops out rather than showing an empty row. Services are chips as well — opening a menu to see
  what you filter on is one click too many — with a sifting field past a dozen of them. Tags now carry their count. All three survive a reload, and one button
  releases them.

- **A free link can be filed into a service — a new one or one that already exists.** Turning links
  into a service could only ever create one, so filing had to happen in a single sitting or not at
  all. Every free-link row now carries a `File` button, the picker offers the existing services with
  a search field, and `File everything into` sets one environment for all the rows at once.
  `Select all` ticks whatever the current filter left — sift, tick, file, repeat — and a link
  filtered out of sight leaves the selection rather than being filed silently.
  Addresses are appended to the cell instead of replacing it — two links filed into the same place
  both fit, where the previous code silently kept only the last — and the link's label becomes the
  address's name.

- **Bookmark import now builds the grid it finds in your tree.** A folder whose children carry
  environment names describes a grid, not filing — and flattening it into free links was strictly
  worse than what the browser already does. The preview builds the grid and shows it before creating
  anything, with a count per cell and a box to refuse it. Labels that repeat across environments
  become one row each (`bo`, `api`); labels specific to each environment become one row for the
  folder with named addresses (a Kibana and its saved queries). Two spellings of one environment
  merge into a single column, a numbered environment stays distinct, and a sub-folder below the
  environment becomes its own row. Nothing is guessed about your domain: the only clue is an
  environment name, from a wide French and English list.

- **An environment is edited and deleted from its own name.** Renaming, recolouring or removing a
  column sat behind a gear that only appeared on hover: the feature existed and nobody found it.
  The column's name is now the button, and deleting says how many addresses go with it. The free
  links open their first level of folders and no more, with `Expand all` / `Collapse all` for the
  two extremes — remembered across reloads — and a fold button on every folder that holds others.

- **An environment with no service could not be reached at all.** Its settings live in the grid's
  column header, and the header was not rendered until a service existed: a freshly created
  environment could be neither renamed nor deleted, and the screen announced “nothing matches this
  search” to someone who had searched for nothing. The table is now drawn as soon as there is one
  column, with a row saying why it is empty.

- **The search reaches the names of the addresses inside the grid**, not just service names and
  URLs — and a cell then shows only the addresses that match, so you read the answer instead of
  re-reading the cell. A query can mix both levels: `logs apache` takes one word from the row and
  the other from the address. The grid's columns also share the available width and shorten long addresses instead of
  pushing the table into a horizontal scroll.

- **A free link is filed into a folder as you create it.** The form offers the existing folders and
  accepts new ones — a slash creates the sub-folder on the way. The import preview also lets you
  rename a proposed row and merge several of them into one service, since the detection reads folder
  names and cannot know that two of them mean the same thing to you. The import dialog is wider, so
  a five-column grid can be read straight on.

- **Free links keep their full folder path.** Grouping on the last segment made `seres/prod` and
  `logs/prod` merge into a single “prod” group — the tool destroyed a structure the browser
  preserves. The list is now the real tree, at full depth.

- **Bookmark import no longer dumps everything in.** The preview is folded by folder, with a count
  and a checkbox per folder, and nothing is ticked: you unfold what you want and import twelve links
  instead of two hundred. The root folder no longer becomes a tag — present on every link, it
  filtered nothing while taking the first spot. Past a dozen, the free links group by folder.

- **The presentation video is recorded in both languages, and shows the new tabs.** `npm run record:demo`
  now produces a French and an English `.webm` rather than one French recording, and the tour takes in
  Notes, Links and the collapsing column alongside the screens it already covered. Dropdowns are redrawn
  inside the page while recording: a native list is painted by the operating system, outside the page the
  camera films, so it never appeared — you saw the cursor click and the value change on its own.

- **AI Dev lists lead with what just finished running.** They were ordered by creation, so a session you
  launched minutes ago sat below one created last week and never run. Whatever is running now comes first,
  then the most recently executed. Execution is what counts: fixing a prompt, pushing a branch or tidying a
  session away no longer jumps it ahead of the one that actually just ran.

- **The verifier form now opens on demand.** Settings → Verifiers used to lead with the whole form — name,
  command list, covered repositories — which pushed the verifiers you came to look at off the screen. The
  list comes first now, and “Add a verifier” opens the form; so does “Edit”, already filled in. Saving or
  cancelling closes it again.

### Fixed

- **The demo no longer empties itself at midnight.** Jenkins demo data is dated relative to
  now, so past midnight the most recent run fell "yesterday" and the menu badge — which counts
  the jobs that ran *today* — hid itself. A demo that cannot produce the screen its own
  documentation describes is worse than no demo: the recording of the English presentation
  started at 23:50 and failed on that badge at 00:10. The most recent run is now kept on the
  right side of midnight, the others keep their real spacing, and the job list is rebuilt on
  each request so a demo server left open overnight does not serve yesterday's "today".

- **Pending review comments now show up in the demo.** They were seeded on files that the demo
  diff never contained, so they existed in the database and nowhere on screen. The seed and the
  viewer now read the same diff for a given merge request.

- **A running verification is now visible.** Clicking `Verify` on a merge request started a job
  and then showed nothing: the request answers in milliseconds while the work takes minutes, so
  the button's spinner was gone before the run even began. The button now reads `Verifying…`,
  spinner included and disabled — a second click cannot start the same verification again — and
  the card carries the same "in progress" marker a review uses. The state comes from the server,
  so it survives a tab change, a re-sorted list and a page reload, and it clears itself when the
  job ends. A review on the same merge request marks the card without spinning the `Verify`
  button: a spinner pointing at the wrong command is worth less than none.

- **A page open in another tab can no longer act on your behalf.** Listening on `localhost`
  protected nothing against this: your own browser is the one sending, and a plain form on any
  website goes out without a preflight — the routes that do not read their body ran as-is, which
  covers wiping every report, publishing your pending comments on a real merge request with your
  token, and launching an agent on your folders. Any request that writes while announcing a
  foreign origin is now refused, with a message that names the likely culprit. Reads are
  untouched, and so are requests with no origin at all — `curl` and your own scripts keep
  working, while a browser always sends one.

- **A brand-new install no longer loses its first coding session.** One migration sat before the
  `CREATE TABLE` it patches: on a fresh database it threw "no such table", the empty `catch`
  swallowed it, and the column only existed on databases where the table predated the migration.
  The first coding session ran the agent for minutes, then died on `no such column:
  session_note`, leaving the work uncommitted. The migration moved, and `npm run check` now
  verifies that every migration follows its `CREATE TABLE` — the rule was written down, it is
  now enforced.

- **A follow-up you did not push is no longer destroyed by the next pass.** Without auto-push —
  the default — a follow-up commits without pushing, so the local branch is the only place that
  commit exists. The next pass realigned on `origin/<branch>` as soon as the remote branch
  existed, and the log said "aligning". The local branch is now kept whenever it carries commits
  the remote does not have, and the log says how many. If both sides diverged the local still
  wins: a push refused for non-fast-forward is a failure you can see and repair, unlike an
  overwrite.

- **Everything the server writes now follows the interface language.** The interface had been
  translated for a long time; the server had not. An English user got English screens and then,
  the moment anything ran, a French job log and French error messages — precisely when you need
  to understand what is happening. The job logs, error messages and job boundary lines of the
  server modules now go through the dictionary, and a test runs the same session in both
  languages and fails if a single accented line comes back.

- **A commit message filled in after the fact is applied on the next run.** You launch a
  session, you see a badly named commit go by, you fill in the commit message field and
  relaunch — and nothing changed, because the AI finds the work already done and commits
  nothing, leaving the field with nothing to name. The last commit is now renamed instead: only
  the message changes, the commit's contents are untouched and no extra commit appears. Not when
  the branch is already on `origin` — renaming a published commit would rewrite a history the
  forge, a merge request and possibly a colleague already have; the job log says so rather than
  staying silent.

- **Reopening Mergerie on the Jenkins tab no longer lands on an empty tab.** The last tab you
  visited is restored at startup, and it was opened while the script was still being evaluated:
  the Jenkins tab reads state declared further down the same file, so it threw, the list stayed
  empty and an "unexpected error" appeared. The landing now happens once the script is fully
  loaded. The failure only showed up on the second reload of a day — the first goes through the
  morning brief, which lands later and therefore worked.

- **Open dropdown lists are readable in dark mode.** The list a `<select>` opens is drawn by the
  operating system, not by the page, and without a `color-scheme` declaration it was always
  painted light — light text on a white background. Every native control now follows the theme:
  dropdowns, scrollbars, date pickers.

- **A Jenkins field no longer shows up prefilled with a plugin error.** Dynamic parameters
  (Extended Choice, Active Choices) build their list from a script evaluated when the page is
  rendered; seen from the API that evaluation can fail, and the plugin returns its error
  message — *Could not get Environment from ENV Param* — where the list should be. It was taken
  for a value and prefilled the field, so a run would have sent that sentence to Jenkins. The
  field is now left empty, says why, and links to the job in Jenkins.

- **Jenkins choice parameters are dropdowns again.** The job request asked for a fixed list of
  fields, so anything a parameter plugin exposes under another name never arrived — a choice
  parameter fell back to a free-text field where you retyped, by hand, a value Jenkins already
  knew. Every field is now requested, and Extended Choice parameters (all options in one
  comma-separated string) are understood too.

- **A Jenkins build console no longer scrolls sideways.** Long lines — a command, a classpath —
  went off to the right, so reading the error you had opened the console for meant scrolling
  horizontally. Lines now wrap.

- **A confirmation no longer opens behind the window that asked for it.** Confirming an action
  started from another modal — running a Jenkins job from its page — put the question
  underneath, with its button unreachable. Confirmations now sit above other modals.

- **Error messages are no longer hidden behind a modal.** An error is most often raised from
  inside a modal — that is where forms get validated — and the message appeared underneath it: you
  saw a form refusing without ever being able to read why, and its `Copy` button was out of reach.
  Messages now sit above everything, including modals and the full-screen code explorer.

- **The code explorer's tree no longer closes under your fingers.** Clicking a file rebuilt the tree
  and recomputed which folders were open from a single rule — "expanded if it carries a change" — so a
  folder you had opened by hand collapsed at the very moment you opened one of its files. What you
  expand or collapse yourself is now remembered for the visit; the next diff starts fresh.

- **“Mark as handled” now moves the merge request out of the Reviewed list.** The button in the
  report refreshed the report and nothing else, so the card stayed in a list it no longer belonged
  to and the stage counter kept the old number until the next reload — the same gesture from the
  “To handle” queue already updated the list. “Reopen” brings it back the same way.

- **Importing bookmarks no longer leaves the Links tab saying it is empty.** The grid only looked at
  services and environments, so after an import it answered “no links yet” directly above the links
  that had just arrived — and offered to import them a second time. The two empty screens are now
  told apart: with nothing at all, importing is offered as the shortest path to a useful tool; with
  free links but no grid yet, the message explains what the grid is for and points at the links
  below.

- **A filled grid cell can be corrected again.** The Links tab let you type a URL into an empty cell,
  and then never again: a filled cell was only a link, and the service form held no address field.
  Fixing a typo meant deleting the whole service — losing its other URLs and its contextual links —
  and typing everything back. A pencil now appears on hover, the field opens pre-filled, and
  clearing it clears the cell, which is what the guide had been promising all along.

- **Collapsing the navigation column no longer empties the screen.** The collapse button lives in the
  column with the tabs, and the tab handler took it for one of them: clicking it deactivated every tab,
  blanked the content area, and stored “undefined” as the last tab visited — so the next reload showed
  nothing either. It now only listens to buttons that actually carry a tab.

- **A link pasted into a note is now clickable.** URLs written in a note page or a todo's note become links
  opening in a new tab — `http`/`https` only, since a note is text you paste without re-reading it and a
  link the tool builds has no business being able to run anything. Sentence-ending punctuation stays outside
  the link, and a reference contained in a URL is no longer transformed a second time: pasting a Jira link
  no longer built a ticket link inside the URL's own text.

- **The “say why” field of a watched ticket holds several lines.** A reason rarely fits on one — “blocks the
  billing migration — tell Sofia as soon as it is in review” already overflowed. Both the add field and the
  one on the card are now resizable text areas: Enter starts a new line, Ctrl/Cmd + Enter saves, Esc closes
  without changing anything. On the card the buttons moved below the field, which in a narrow column left
  barely a hundred pixels to write in. Line breaks are kept when the note is displayed back.


- **The branch explorer now says it is working.** Clicking “Analyse” could look like nothing happened:
  the loading skeleton sat inside blocks that open folded, and a clone can take a minute. Each repository
  now announces its state in its own header — *waiting*, then *analysing* with a spinner, then its branch
  count — so on several repositories you can see which one is being worked on, since they are handled one
  after another. The button spins too, and a repository that fails opens its block to show why rather than
  keeping the reason shut inside. Those blocks also regained a **chevron**: `display: flex` on their
  summary had removed the browser's native marker, so nothing said whether a block was folded or not.

- **A code template inside a Jira table is readable again.** Technical tickets routinely lay a template out
  as a table — a label on the left, JSON on the right. A Markdown table holds one line per cell, so the code
  arrived flattened onto a single line, its indentation collapsed by the HTML and impossible to copy. Tables
  whose cells carry a code block, a list or several paragraphs are now **unfolded**: each row becomes the
  label followed by its block, rows separated by a rule. Ordinary data tables are untouched — and a `|`
  inside a cell no longer opens a column of its own and shifts the whole row.

- **A Jira table with no header no longer loses its first row.** Markdown requires a header row; a Jira
  table does not. The first row was promoted to a title regardless — so a header-less table lost a line of
  data to the heading, and a key/value table (whose header is the first *column*, making its first row
  mixed) lost a whole pair. Only a row whose cells are all headers is treated as one now; otherwise an
  empty header is emitted, which the display hides rather than showing a blank grey band. Header cells
  outside the header row are rendered in bold, Markdown having no column header.

- **Markdown rendered outside a review report had no styling at all.** The Jira description and comments,
  the note-page preview and a todo's note all use a container that, it turned out, no CSS rule ever matched:
  code blocks had no background, no padding and no horizontal scroll, so a long line pushed out of the card
  instead of scrolling inside it. They now look like the code in a review report.

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
