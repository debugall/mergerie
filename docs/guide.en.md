# Mergerie — Full guide

> ↩ Back to [README.md](../README.md) · 🇫🇷 [Guide (français)](./guide.fr.md)

This guide covers every tab, advanced configuration, enterprise TLS, local clones, data & backups and the
security model. For a quick start, stay on the [README](../README.md).

> **Convention.** Mergerie supports **GitLab and GitHub**. Throughout this document, **“MR”** means either
> a GitLab *merge request* or a GitHub *pull request*: the screens, the actions and the guarantees
> described are the same. The rare forge-specific differences are called out explicitly.

## The tabs in detail

Nine tabs, in a **left sidebar**, grouped by family — the core, what I have to do, my machine and its
links, the meta:
**Reviews** · **AI Dev** — **Notes** · **Jira** — **Git** · **Docker** · **Links** — **Stats** · **Settings**.
The bar **collapses to icons** from a button at the foot of the column (the choice is remembered), and
collapses on its own below 1100 px wide.
Badges show **work waiting**, not totals (MRs to review, sessions not yet run). The **Reviews** tab carries
two: the blue one counts merge requests **to review**, the orange one counts **reports scored under 7/10
that still await a decision**. The second tells you which to read first; it only counts the *Reviewed*
stage, so marking a merge request as done brings it back down — a counter that never goes down soon stops
being looked at.
The **Notes** tab carries two as well: the **red** one counts what presses — todos **overdue** or at **high
priority** —, the **blue** one the rest of the todos to do. Their sum is the number of open todos; hovering
the red one says what it is made of, because it does not read off the “High” badges alone: a normal todo
whose due date has passed asks just as much, and lateness is exactly what gets forgotten.

### Reviews
The three stages of one merge request, behind a segmented filter — **To review · Reviewed · Done** — with a
shared search (title, author, project, ticket).

- `Fetch new MRs` queries the forge and fills the list (filtered by pattern). An optional **automatic
  refresh** does it for you (see Settings). Repositories whose **fetch MRs** box is unticked (Settings →
  Repositories) are skipped by this search: the merge requests already fetched stay in the queue, only new
  ones stop coming in. Not to be confused with **enabled**, which removes the repository from everywhere.
- `Review N MRs` runs the AI review over the whole queue; past 5, a confirmation reminds you that each MR
  costs one AI call. `Review` handles a single MR.
- **Review with or without an explanation.** By default a review produces **two things**: the report
  (findings + score) and a **teaching explanation** (a second AI call, Explanation tab). You can skip it to
  go faster and **spend fewer tokens**: **Settings → General → “Generate the teaching explanation”** sets
  the default, and the **small ▾ menu next to `Review`** lets you **override it for one MR**
  (`Review + explanation` / `Review without explanation`). If the explanation is missing, a
  **`Generate the explanation`** button on the report produces it on demand (a single AI call, without
  re-running the review or creating a new version).
- `View diff` opens the MR's diff **before any review**, in the full-screen viewer (tree, inline diff,
  navigation) — the repository is cloned on demand if needed. The left panel becomes a **decision panel**:
  if the MR is trivial, `Dismiss without review`; otherwise `Review`. The point is to **not spend an AI
  call** on an obvious MR.
- `Let the AI code it` opens a coding session **pre-filled** on the MR's branch (working branch = source
  branch, starting branch = target branch).
- `Linked projects` (under `Context`): other repositories plus a branch that the AI reads **read-only**
  during the review, to flag whether the MR's changes **might affect them** (API signatures, contracts,
  schemas…). Mounted under `ai-dev-tools-internal/linked/`, reset afterwards. Each linked project adds
  time and token cost — pick them deliberately.
- `Context` attaches to an MR anything that helps judge it — ticket content, a specification, a business
  rule, an excerpt of a conversation — as text and/or a **screenshot** (paste with Ctrl+V). If **Jira** is
  configured (URL + email + API token, Settings → Jira), the ticket's **summary + description** are
  **fetched automatically at discovery** and pre-fill the context — the nominal case is **zero clicks**.
  What you type by hand stays a **separate addition** (never overwritten), and a **Refresh** button
  re-fetches the ticket on demand. All of it goes into the review prompt alongside the diff, and the button
  carries a ✓ once a context is saved.
- **Merging opens a confirmation with its options.** Before merging, a dialog restates the MR and its
  target branch, and offers **Squash** (fold the commits into one) and **Delete the source branch after
  merging**. Both boxes are pre-ticked from what was chosen when the MR was created.
- **Creating an MR** opens the same family of dialog: pre-filled title, and the same two options. GitLab
  records them at creation time; **GitHub cannot express them at creation** — Mergerie then remembers them
  and applies them at merge, which the dialog says.
- `Merge` merges the MR **directly, without a review** — for a trivial MR: you confirm, and if the merge
  really happens the MR leaves the queue (marked done). Also available in the decision panel of
  `View diff`, which is precisely where triviality is judged.
- `Dismiss without review` takes an MR out of the queue, with a few seconds to **undo**.
- Reviews stack up in a **sequential queue**; a **live log panel** shows the commands, the output and the
  progress, with a **Stop** button (which also empties the queue — the confirmation says so), a **stopwatch**
  since the start and, once a rhythm is established, an **estimate of the time left** (it goes quiet rather
  than lie when the pace drifts).
- **See the queue and run jobs in parallel.** The log panel lists what is waiting and offers to **promote a
  job to run alongside** the current one (up to **3 at a time**) when it touches **no repository or folder**
  in common with what is already running — a collision is refused, not arbitrated: two agents in the same
  clone would corrupt it. Each promoted job gets **its own tab** in the panel, with **its own Stop button**;
  the tab stays after the job ends, so you can re-read the output. An **interrupted** job can be **re-run**
  from the queue.
- **Edit your own comment.** A comment posted from Mergerie — **inline** in the explorer or **general** on
  the MR — can be **rewritten** without going through the forge. Yours only: a colleague's are read-only.
- **Full or incremental re-review.** `Re-run the review` does a **full** review (the whole diff). When the
  branch has **moved since the last review** (a *stale* MR), a `Re-run (delta)` button appears: the
  **incremental re-review** only reads **what changed** since the last reviewed SHA
  (`reviewed_sha..current_sha`) and supplies the **previous report as context** — the AI produces a
  **complete, up-to-date report** (score included) while reading far **less diff** (so fewer tokens). It
  falls back to a full review automatically when there is no usable delta (a force-push, say). Re-running a
  review **resumes the same agent session** as the previous one: the AI remembers its analysis and focuses
  on what changed.
- **⚡ Converge — the autonomous quality loop.** A report's `Converge` button starts an **autonomous loop**:
  review → **AI fix** applied to the code (commit + **push** on the branch) → **incremental re-review** of
  the delta → and round again **until the score threshold** (8/10 by default) **or the pass ceiling**
  (3 by default). You push a mediocre MR, you come back later: it has gone from 5.8 to 8.4 in a few
  iterations, with **the whole history versioned** (v1 → v2 → v3, scores, findings resolved and appeared,
  each fix commit readable). **Guard rails**: it stops if the score **drops or stalls**, the pass ceiling is
  strict, and there is **never an automatic merge** — the loop *prepares*, **you** review and merge (the
  review and the fix come from the same model: a score reached autonomously is not a score validated by a
  human). Threshold and ceiling are set globally (Settings → General) and **can be overridden at launch**. A
  **notification** tells you when it ends (“Convergence finished: 8.4/10 in 3 passes”). If the “the AI may
  ask questions” option is on and the AI hesitates during a pass, the loop **pauses** (notification) instead
  of guessing: you answer, then you start Converge again — which **resumes the same session**.
- **Modification requests are kept.** The `Ask the AI for a change` section lists the requests already made
  on this report, **with their date**, and a button opens **the report each one produced** (the matching
  version). You can therefore find what was asked to arrive at a given report, instead of reconstructing it
  from memory.
- On a report: **regenerate** the report, **comment** on the MR, **merge**, **re-run the review**, **mark
  done**, **delete the report** (the MR goes back to “to review”), and above all **Have the AI fix the
  code** — which opens a coding session pre-filled with the report injected into the prompt, so you can
  adjust before launching. If the branch came from a **coding session**, its **session id is pre-filled**:
  the AI picks up the thread of its own work instead of rediscovering code it just wrote. It is a
  suggestion, not a rule — the link is inferred from the repository and the branch, which is not proof:
  clearing the field starts from a fresh session. Sessions opened from an MR offer **Create without
  running** alongside **Create and run**, to prepare now and execute later.
- **Every review pass is kept.** Re-running a review or regenerating a report no longer overwrites the
  previous one: a **version selector** appears in the report from the second pass on
  (`v2 — current · 20/07 14:30 · 7.8/10`) and lets you **re-read an earlier review**, with a banner
  reminding you it is read-only.
- **Resolution tracking** between two passes: from the second review on, a banner shows the findings
  **resolved · persistent · new** and how the score moved (`score 6.4 → 7.8`). A finding is only called
  “resolved” if the line concerned **actually changed** between the two versions of the code (checked
  through git); otherwise it is marked “gone” — the AI may simply not have reported it again. The findings
  come from a structured block the AI emits alongside the report (invisible when reading); **your review
  prompt template is not modified**, the instruction is added on the fly. The Stats tab turns this into
  a **resolution rate per project**.
- An MR that is no longer open on the forge carries the **merged** badge; the Merge button disappears.
- **Filter by score colour.** Under *Reviewed* and *Done*, three checkboxes above the list — green
  (≥ 7/10), amber (4 to 6.9), red (< 4) — **combine**: “show me the red and the amber ones” is two clicks,
  and each carries the number of merge requests it will bring up. The choice is remembered between visits;
  unticking the last box brings everything back, rather than leaving an empty list with no way out. The
  summary on the right follows the filter. The *To review* stage has no such boxes: an MR only returns
  there once its report has been deleted, so there is no score left to filter on.
- **List and report scroll independently.** Going down the list to pick another merge request no longer
  carries the report off the screen — you look at both together.

### ⛶ Open the code (full-screen explorer)
Project tree plus the file shown **in full with the diff in place**, syntax highlighting, a **mini-map** of
the changes, navigation between modifications, collapsible panels. **Inline comments** per line and
**replies** to threads, synchronised with the forge — and **editable** as long as they are yours.

### AI Dev
A **search** at the top of the list (prompt, project, branch, folder) filters the sessions of the current
sub-tab — useful as soon as they pile up. It resets when you switch sub-tab, so as not to contradict the
counters, which show totals.

The lists put **what just finished running at the top** — and above everything, what is running right now.
It is the **execution** end date that decides, not the last modification: fixing a prompt, pushing a branch
or tidying a session does not lift it above the one that just ran. A session that was never run sits at its
creation date.

Two sub-tabs. In both cases a session covers **one or several projects**, each with its own branch, and its
creation date is shown. The **repository is picked from the keyboard** (a selector with search), like the
branches — which matters when the list of repositories is long.

**Tidying finished sessions.** A finished session can be **hidden** without being deleted; a
**“Show hidden sessions”** checkbox (whose state is remembered) brings them back, and a counter reminds you
how many are filtered out. This applies to coding, out-of-repo coding and exploration alike. In the list, a
long prompt is **folded to three lines** with a **“Show more”** that unrolls it.

**Create now, run later.** All three session types offer **`Create without running`** next to
**`Create and run`**: you prepare the prompt and the targets, and launch when you want.

**Resume an existing agent session.** An **optional “session identifier”** field at creation time (coding,
out-of-repo, exploration) makes the AI work **inside that session** instead of opening a new one — so it
keeps all the context it has already built. Filled in, it also enables the **“Resume in terminal”** button.
The field can be edited afterwards too.

**Enrich from a Jira ticket (optional).** If Jira is configured (Settings → Jira), the dialog offers a
**ticket number** field with a **Fetch** button: the ticket's **title + description** are pulled through the
Jira API and **added at the top of the prompt** as a context block — visible and **editable** before you
launch. The number is **pre-filled** if the working branch already contains a key (e.g.
`feature/PROJ-1234-…`). Available for coding **and** exploration.

- **Coding** — the AI modifies the code. For each project: a working branch, and an optional **starting
  branch** (a dropdown with search; empty = the repository's default branch). The prompt is applied to each
  project, sequentially — **one failing project does not stop the others**. Each project then carries its
  own actions: **Diff · Push · Create MR · Merge**. **`Diff`** opens the **same full-screen explorer as the
  merge requests** — the whole project tree in the middle, the entire file with the changes in place on the
  right (navigation from one change to the next, mini-map) — with, on the left, the **AI's report** instead
  of the review report. So you read what the AI says it did *and* what it actually wrote, side by side, in
  the context of the whole file rather than in a raw patch. A compact **stage trail** (pills
  **created → commit → push → MR**) on each row tells you at a glance where the project stands — handy on a
  multi-project session.
  `Request a fix` runs the AI again on the existing branches, **resuming the same session**: the AI keeps
  all the context of the work already produced (likewise for a re-run of the session). On a multi-repository
  session, **each project carries its own button**: a remark almost never applies to all five repositories
  (“use AbortController here instead” means nothing elsewhere), and sending it to the whole session costs
  one AI call per repository to redo work that was already fine. The button on the card itself still
  addresses everyone. An **exploration** answers as a single whole: it does not narrow down to one
  repository.
  When coding ends, **`AI output`** shows what the agent says it did (like an exploration's answer) — useful
  to understand its work, or **when nothing changed**: if the prompt was incomplete and the AI **answered
  instead of coding** (e.g. “give me the file name”), its answer is **surfaced directly** in the project's
  error rather than an opaque “no change”. On the other hand, if the branch **already carries the work** —
  the case of a re-run after a failure that happened *after* the commit, a rejected push say — the absence
  of new changes is **not** an error: the session goes back to its “commit ready” state, with the diff and
  the MR creation button.
- **Activity — what you launched, and what finished.** The log panel exposes an **Activity** view: what ran,
  on what, for how long, and how it ended. Each row **names its object** and takes you there in one click; a
  button reopens the **log of a past job**. What has finished since your last visit is marked, and the count
  appears on the button. Desktop notifications did not answer that question: they only live in the server's
  memory and are deliberately not replayed on load — so anything that finished with the tab closed existed
  nowhere.
- **The project list opens folded.** Past a few repositories, a session filled the whole screen and hid the
  others — which are exactly what you came to look at. A “Show the N projects” unfolds it, and the state is
  **remembered per session**: otherwise the automatic refresh would close it again every second and a half
  during a job. Applies to all three families (coding, out-of-repo coding, exploration).
- **Push all · Create all MRs.** Two grouped actions, which only appear when they have something to do (the
  number concerned is in the label). **Push all** pushes, in a single job, every branch that is committed
  but not yet pushed. **Create all MRs** opens a merge request for each pushed project that has none: the
  dialog asks for the options **once** — squash, delete the source branch — and each MR reuses the
  **session's commit message** as its title, rather than demanding ten titles in a row. In both cases a
  failing project does not stop the others, and the summary names the ones that failed.
- **Run one project at a time.** On a multi-repository session, each project carries its own **Run** button,
  and a session with several failures offers **Re-run failed projects**. Previously a session could only be
  re-run as a block: on ten repositories of which six had succeeded, that cost six AI calls to redo good
  work, and sent the agent back over code you no longer wanted touched. A targeted pass **only reserves its
  own repositories**, so two projects of the same session on distinct repositories can run in parallel.
  Re-running the whole session is still one click away — nothing became implicit.
- **Check branch state — repair without spending an AI call.** When projects stayed in error although their
  work is already committed, a button on the session **re-reads the real state of each branch**: if it
  carries commits, the diff is regenerated and the project goes back to “commit ready” (or “pushed”), MR
  creation button included. Nothing is faked — a genuinely empty branch stays in error, with its message.
  Re-running the session would repair the same thing, but at the cost of **one AI call per repository** to
  redo work already done. The button only appears if at least one project is in error, and the operation
  goes through the job queue: touching a clone while an agent is writing in it would corrupt it.
- **Export an answer.** The full-screen view of an agent's output (as of an exploration's answer) carries an
  **Export** button: **HTML**, **Word (.docx)** or **PDF**. The HTML is a **self-contained** document —
  embedded styles, no external resource: it reads offline and can be sent as is. The `.docx` is a real Word
  document (headings, lists, tables, code blocks), built without installing anything. The **PDF** goes
  through the browser's print dialog, where you pick “Save as PDF”: the rendering is the one you have in
  front of you, and Mergerie does not ship a 300 MB rendering engine for one button. In all three cases the
  document carries its title and its date: a file that gets forwarded loses its name long before its
  content.
- **Every iteration is kept.** A session iterates (launch, `Request a fix`, answers to questions,
  convergence passes): each pass keeps **the prompt actually sent** and **the matching AI output**. An
  **iteration selector** appears at the top of `AI output` from the second pass on (“Iteration 2 · fix
  requested · 29/07 00:42”) and lets you re-read any of them. Re-reading an answer without knowing which
  request it answered teaches nothing: the two are therefore shown together. Applies to **out-of-repo
  coding** too, folder by folder.
- **⌨️ Resume the session in a terminal.** Every project of a coding session (repository **or** out-of-repo),
  and the reviews too, exposes a **“Resume in terminal”** button that copies the **ready-to-paste command**:
  a `cd` to the right folder plus the agent launched with the **session identifier** (claude
  `--resume <id>`, copilot `COPILOT_HOME=… --continue`). You pick the AI's conversation up yourself, with
  all its context, where the app left it.
- **🙋 The AI can ask you a question.** A **per-session** option (checkbox, off by default): if the AI hits a
  structural decision it cannot settle (an architecture choice, an ambiguity, a clash of conventions), it
  **stops and asks you** instead of guessing. The session goes **into waiting** (the queue frees up, a
  notification warns you); you answer from the card — **offered choices or free text** — and the AI
  **resumes the same session** where it stopped. As soon as you confirm, the form gives way to a
  **“resuming…”** (no more waiting without visual feedback). The option is **remembered** when you edit an
  existing session. Resuming was first validated by a test bench in *Settings → AI sessions*.
- **⚡ Converge from a session — *from prompt to converged MR*.** The `Converge` button (on the **new session
  dialog** and on an **existing session**) chains **the whole path** without intervention: the AI **codes**
  the task → **commit** → **push** → **creates the MR** (target = the starting branch) → then starts the
  **convergence loop** (review → fix → re-review) until the threshold. You write an intention, you come
  back: an **open, tested, scored and converged MR** is waiting — all that is left is to read it and merge.
  **Multi-project**: each project gives its MR, converged in turn, in series (one failure does not stop the
  others). **Idempotent**: a session already coded is not coded again, an MR already open is converged
  directly. Same guard rails as “Converge” on an MR — and **never an automatic merge**.
- **Out-of-repo coding** — the AI carries out the prompt **directly in local folders**, **in place** and
  **without git**: no branch, no commit, no push. Handy for folders that are not repositories of a forge
  (scripts, experiments, a local mono-repo…). The working folder is no longer **typed in**: you pick a
  **local directory** (declared in *Settings → Repositories*) then **the project or projects** it contains —
  the path follows, and a hand-typed path is a typo you only discover halfway through the run. The form
  (projects + prompt) lives in **the same dialog as coding** — so you can also **attach screenshots**
  (button or Ctrl+V) to enrich the prompt. The same prompt is applied to **each folder**, one after another
  — a failing folder does not stop the others, and the status is shown per folder. As with repository
  coding, each folder exposes **`AI output`** — what the agent says it did, useful when the folder has not
  moved (incomplete prompt, the AI answered instead of coding) — and the session offers
  **`Request a fix`**: a fresh pass over the same folders that **resumes each one's session**, so the AI
  keeps all the context of what it has just produced. An out-of-repo session is **editable** afterwards
  (prompt, folders, session identifier), like a repository session. ⚠ **No safety net**: the agent modifies
  the files in place, without a backup; on a git repository you can review and undo yourself (`git diff` /
  `git checkout`), on a non-git folder there is **no undo** — a warning says so. (Dedicated sub-tab, between
  *Coding* and *Exploration*.)
- **Exploration** — **read-only**: you ask a question about one or several projects, the AI explores the
  code and writes **a single synthesis answer** saved as `.md`, readable at any time through `View answer`.
  No diff, no merge. A **follow-up question resumes the same agent session** — as for coding — instead of
  re-injecting its previous answer: the AI remembers its exploration instead of re-reading a summary of it.
  The repositories are reset afterwards: **no modification survives**. Each exploration also exposes
  **“Resume in terminal”** so you can continue the conversation yourself. **Every question is kept**: a
  follow-up question overwrites the answer file, but the pass is archived — `View answer` offers an
  **iteration selector** that replays each question with the answer it got.

### Notes
The sticky notes and the notepad tab of everyday work, **inside the tool** — so **anchored** to what it
tracks (merge requests, tickets) and **inside the backup**. Three sub-tabs: **Today** (the brief),
**Todos**, **Pages**. Nothing goes to the AI or to a forge: everything lives in the local database, and
this tab **spends no tokens at all**.

#### Today — the morning brief
Seven sections, **ordered action-first**: what calls for a gesture before what merely informs. Each is
**hidden when empty** — a screen showing seven headings, six of them subtitled “nothing”, teaches you that
nothing happened, which was not the question. Every line reaches its object in one click.

1. **Reminders** — due dates that have passed and today's, with the “done” checkbox and the snooze buttons
   **right there**: that is the whole point of a brief, acting without changing screen.
2. **Today's todos** — the **high priorities with no date** and the ones due today. High-without-a-date is
   there because “important but with no deadline” is exactly what gets lost: nothing ever surfaces it on
   its own. A todo already listed under *Reminders* does not appear twice.
3. **Sessions waiting for an answer** — the sessions where the AI asked a question. They are the costliest
   to forget: the session is blocked, the queue is free, and nothing restarts without you.
4. **Failed verifications** — the last red verdict per batch or per MR. **Stale** verdicts are left out:
   the branch has moved, the verdict covers code that is no longer there, and showing it would send you to
   fix a problem that may already be fixed.
5. **MRs to review** — the ones that **arrived since yesterday**, not the whole queue (which has its own
   tab and its own badge).
6. **Dormant MRs** — reviewed more than **N days** ago (adjustable, 5 by default) and still open: the work
   is done, the decision is missing.
7. **Activity since yesterday** — one line, three numbers. Deliberately poor: it is context, not a task;
   the detail lives in *Stats*.

Everything is computed **in SQL, with no AI and no network**: the brief appears instantly, before the first
coffee, and costs nothing. A summary written by an agent was tempting; it would have charged one call every
morning to rephrase facts that already read fine.

**Landing.** On the **first opening of the day**, the app opens here rather than on the tab you left. Once
per calendar day, never twice — otherwise every page reload would drag back to the brief someone who was
reading a report. Switch it off in *Settings → General*.

#### Todos
A flat list, sorted **by priority then by due date**; the ones without a date come after those that have
one, otherwise the more numerous no-date todos would push what is due today to the bottom.

- **Inline add** at the top of the list: you type, Enter, it exists — normal priority, no date. Sorting
  comes afterwards.
- **Binary status**: to do / done. No “in progress”: a workstation todo gets ticked, it is not steered.
- **Priority** high / normal / low. Normal shows no badge — flagging it would be noise.
- **Due date = reminder**: a single date, serving both. It is shown **relatively** (“tomorrow 9 am”,
  “in 3 days”), and **in red only once it has passed**: a due date ahead is not an alarm.
- **Snooze** in one click: **+1 h** or **tomorrow 9 am**. “Tomorrow 9 am” means 9 am **on the clock**, not
  “in 24 hours” — a daylight-saving change must not shift the appointment.
- **Optional link** to a merge request, a ticket or a repository: the line becomes clickable.
- **Nothing is deleted.** A finished todo stays **struck through for seven days** — you want to see what
  you did this week — then moves to **Archived**, where it stays readable. Reopening it takes it out of the
  drawer. A *Delete* button exists, but ticking “done” is the normal gesture.
- Three filters: **To do · Done · Archived**.
- The **menu** carries the count: red for what presses (overdue or high priority), blue for the rest to do.

#### Quick capture — the `n` key
From **any tab**, `n` opens a small dialog: one field, **Enter** creates the todo, **Esc** cancels. A
*“+ details”* link unfolds priority, due date and note when that is useful. After creation, a discreet
toast — **and no navigation**: you were in the middle of something else. If capture cost more than two
seconds, you would go back to the sticky note. The key is ignored while the cursor is in an input.

#### Pages
**Flat** note pages: no folders, no hierarchy. On the left the list (**pinned first**, then most recently
modified) with a **search covering the title AND the content** — the word you are after is often in the
body. On the right the editable title, then **the editor and the Markdown preview side by side** (the same
renderer as the review reports, hence the same escaping).

- **Autosave** as you type, with a one-second delay and a discreet “Saved” indicator. Saving on every
  character would mean one request per letter; saving only on close would lose the work of a page left
  open.
- **Pin** keeps a page at the top of the list.
- **Export** downloads the page as `.md`, under a name **slugified** from the title.
- **Delete** asks for confirmation — it is the only irreversible action of the tab.

#### Autolink — `!214` and `PROJ-720` become links
What you write in a note are the identifiers of everyday work. They become clickable **at render time**
(pages, todo notes); **storage stays plain text** — you re-read your notes elsewhere, and an exported `.md`
must not carry HTML.

- `!214` → the merge request. **One repository** carries that number: direct link. **Several**: a link to
  *Reviews* with the search pre-filled, showing the candidates — we do not guess, and a wrong link is worse
  than a link that asks you to choose. **None**: the text stays text, no dead link.
  Resolved are the merge requests still **open**, plus those that moved in the **last six months**:
  past that, a closed MR is no longer a reference you write in a note, and re-reading the whole
  table on every visit to the tab would cost a lot for three references.
- `PROJ-720` → the ticket, **if Jira is configured**.
- A **pasted URL** becomes clickable (new tab). **`http`/`https` only**: a note is text you paste without
  re-reading it, and a link you build has no business being able to run anything — `javascript:` and the
  like stay text. Sentence-ending punctuation stays outside, and a reference **inside a URL** is not
  transformed again (pasting a Jira link does not build a second link inside the first).
- Nothing is transformed **inside a code block**: `!42` in a shell snippet is code.
- The content is **escaped first**, the autolink applies **afterwards** and only injects tags it builds
  itself. No fragment of a note can become markup.

#### “Add to the todos”, from an MR or a ticket
A button on the **detail of a merge request** and on that of a **Jira ticket** opens the quick capture
**pre-filled**: proposed title (`Follow !214 — <title>`), link set, normal priority, no date — all of it
still editable. If an open todo **already** follows that object, the button becomes **“See the todo”**:
creating a silent duplicate would be the surest way to make the list useless within a week.

#### Reminders
The channel is the existing **desktop notifications**, with its own **“Reminders”** category (on by
default, *Settings → Notifications*).

- A due date reached gives **one** notification, **once** — and **snoozing makes it ring again**: without
  that, pushing back an already-notified reminder would silence it for good.
- The notification is marked as sent **after it is displayed**, not when the list is read: a notification
  that fails (permission denied, tab closed in between) must not consume the only chance to warn you.
- **Catch-up at startup**: if several reminders are overdue when the page loads, they give **a single
  grouped notification** (“3 reminders waiting”) — ten pop-ups at startup get dismissed unread.
- ⚠ **A limit worth knowing**: reminders are sent by the browser. The **Mergerie tab therefore has to be
  open somewhere**. A reminder that falls due while everything is closed is not lost — it goes out on the
  next load, in the catch-up.
- The snooze buttons live **in the interface**, not in the notification: notification actions would require
  a service worker, which is out of scope.

The notes, the todos and their history live in the **database of the data folder**: they are therefore
covered by the **backup** (*Settings → General*), just like the review reports.

### Jira
Two sub-tabs: **My tickets** and **Watched**. The menu carries a **badge** = the number of tickets
**in progress that are assigned to you** (status category *In Progress*, the only definition that survives
across workflows, since state names are free from one project to the next). It is fed by a counter
**cached server-side** and refreshed by the watcher: showing it does not cost a Jira call every time you
walk past.

#### My tickets
**The Jira tickets**, fetched automatically when you open the menu. By **default only yours** are shown, but
a **filter by person** lets you **tick other assignees** to see their tickets too (the list of people = the
recent assignees; **you ticked by default**, a **persisted** choice). A **list → detail** layout:
- The **list** (on the left, with search) shows each ticket as a compact card: key, the **epic** it belongs
  to when there is one, summary, **status** (a dot coloured by category: to do / in progress / done), type,
  priority, update date. **The search covers the epic too** — “show me the tickets of that epic” is a common
  ask. In the list the epic stays a piece of **information** — the whole card selects the ticket; it is
  **in the detail** that it becomes a **link** to Jira, opened in a new tab. The epic is read from Jira's
  `parent` field, keeping only the parents that really are one: a sub-task's parent is a story, and
  announcing it as an epic would be a contradiction. Tickets that are **done** are left out by default — an
  **“Include done”** checkbox brings them back. A **filter by status** (collapsible, checkboxes, a
  **persisted** choice) additionally lets you show only the statuses you want. It adapts to the **custom
  statuses** of your workflows, and the colour follows the status *category* (to do / in progress / done),
  not its name. The list is not limited to the displayed tickets: the statuses of the **workflow of the
  projects concerned** are loaded as well, otherwise a real status absent from the page would not be
  filterable. We query the selected projects, failing that the ones of the displayed tickets — asking for
  every status of the instance would give dozens of unrelated entries, and the endpoint that allows it
  requires administering Jira. Unticked statuses are excluded **by Jira**, not afterwards — otherwise we
  would be sorting a capped excerpt. A status already seen stays on offer even once excluded, without which
  you could no longer tick it back. A **Sprints** filter appears as soon as your tickets carry one. The
  sprint is a **custom** field whose identifier changes from one instance to another: the tool spots it by
  its Jira **schema marker**, which is language-independent — a field named “Iteration” is recognised as
  such. The selection is applied **by Jira** (`sprint IN (…)`), like the projects, so as not to sort a
  capped excerpt. Sprints already seen stay on offer once a sprint is chosen, otherwise you could not tick
  a second one. The **current sprint sits at the top of the list** and is flagged as such — it is the one
  you are after nine times out of ten, and the date alone does not tell it apart from a future sprint. Then
  come the others by **descending date**; a sprint with no known date (Jira does not always give one for a
  future sprint) comes after those that have one. The **Assignees** and **Statuses** filters each have
  their own **search** — which **hides** rows without unticking anything — and **Check all / Uncheck all** —
  handy to empty everything then keep only one or two rows. On the assignees, **ticking nobody does not
  filter**: the list then takes **every** ticket the account can see, including those assigned to someone
  else or to no one. By default, as long as you have touched nothing, only **your** tickets are loaded.
- **Filters by field, generic.** The three filters — Assignees, Statuses and **Filters** — are chips lined up
  **above the detail panel**; the one you open floats over the page, so neither the row nor the list moves,
  and a click outside closes it. The **Filters** panel lets you choose the **field** first (epic, type,
  priority, project, assignee, reporter, labels, components, fix versions) then **one or more values**. The
  **Project** criterion is an exception: it is applied **by Jira**, not afterwards. Jira caps a search at a
  hundred tickets sorted by update date; filtering browser-side would therefore filter only an excerpt, and
  the tickets of the wanted project could sit outside that excerpt — they disappeared instead of appearing.
  When the list is capped, the counter says so (“100 of 340 shown”). The values on offer are the ones
  **actually present** in the loaded tickets, with the number of tickets for each — offering a value that
  brings back nothing helps nobody. The field picker and each value list have their own **search**; the
  values' one **hides rows without unticking anything**, so a selection is never lost by hiding. Several
  criteria combine with **AND** between fields and **OR** inside a field (“bugs *and* tasks, from this
  epic”). A criterion with no value ticked filters nothing: adding a field therefore never empties the list.
  The criteria are **persisted**.
- The **detail** (on the right) shows the **content** (the Jira description converted from ADF into readable
  Markdown), every **metadata** field (status, type, priority, assignee, reporter, project, dates, due date,
  labels, components, fix versions), **all the comments** (author, date, body in Markdown) and the
  **attachments** — **downloaded on demand** through a **server proxy** that fetches the file with the token
  (a direct link would fail, since the Jira API requires auth). Plus an **Open in Jira** link.
- **Code blocks stay code blocks.** A technical ticket often puts a template inside a Jira **table** — a
  label on the left, JSON on the right. A Markdown table holds one line per cell: the code ended up
  flattened there, its indentation crushed and uncopyable. Such tables are therefore **unfolded** — each
  row becomes the label then its block, rows separated by a rule. You lose the grid, which was only a
  layout; you keep the content, which is what you came to copy. Ordinary data tables stay tables — and
  nothing in them is wrongly promoted to a title: only a row whose cells are **all** headers becomes one.
  A table with no header therefore keeps its first row, and a key/value table (header in the first
  **column**) keeps its first pair, the key in bold for want of a Markdown equivalent.
- **`Let the AI code it` from the ticket.** The button at the head of the detail opens the **coding session
  dialog already filled in**: the ticket's content (title + description) is placed at the top of the prompt,
  the commit message and the **branch name** (`feature/PROJ-1421-…`) are proposed from the key and the
  summary, and the ticket number is filled in. All that is left is to pick the repository and to spell out
  your request under the context — the cursor is already there. The session is **not launched
  automatically**: you read it over first.
- **Change the ticket's state**: a selector in the header lists the **allowed transitions** (what Jira lets
  *you* do on this ticket); picking one **applies the transition** and refreshes the status (detail + list).
  Nothing is offered if you do not have the rights.
- **Post a comment**: a field at the bottom of the comments section — the text is converted to **ADF** (the
  format of Jira Cloud comments) server-side, and the new comment is appended to the thread without
  reloading everything.
- **Images are shown directly**: image attachments get a **fixed-width preview**, and images **embedded in
  the description or a comment** are rendered **inline** where they appear (resolved through the proxy). A
  **click opens the image large** (lightbox; Esc or a click outside closes it). Other files stay as
  downloadable “chips”.
- If Jira is not configured, a message points at **Settings → Jira** (URL + email + API token).

#### Watched
**Follow a ticket without it being assigned to you** — the common case: a ticket held by someone else blocks
yours, and you want to know **when it moves**, not to think about it three times a day.

- You add a ticket by its **key** (`PROJ-1421`) from this sub-tab, or with the **Watch** button at the head
  of a ticket's detail. The key is validated before any call: it never reaches the raw JQL.
- **The current state is recorded when you add it.** Without that, the first check would compare against
  nothing and announce a change that never happened.
- **Say why you are watching it.** An optional field next to the key — “blocks the billing migration”, “tell
  Sofia as soon as it is in review”. Three months later, a key and a summary no longer recall the reason. It
  is shown under the ticket's title and can be **corrected at any time** through the pencil on its row:
  going through remove/re-add would lose the date it was added and the last known state, and would trigger a
  false notification on the next pass. Clearing it is a legitimate choice — you do not keep a stale
  reminder. The field holds **several lines** (a reason rarely fits on one): Enter starts a new line,
  **Ctrl/Cmd + Enter** saves, Esc closes without changing anything.
- A **server timer** re-checks every watched ticket at the rhythm set in **Settings → Jira** (*Check watched
  tickets every* N minutes; **0 = off**). On every **state change**, a **desktop notification** gives the
  old and the new state — `To do → In progress` — and a click brings you back here. The type can be switched
  off in **Settings → Notifications**.
- **The ticket reads right here.** Clicking a row of the list opens the ticket **on the right**, as under
  *My tickets*: description, metadata, comments, attachments — and the same actions (change the state,
  comment, *Let the AI code it*). It is the same panel, not a copy: watching a ticket without being able to
  read it forced you to open Jira for three lines of description. The card's own controls (remove, correct
  the reason) keep their own effect, and each sub-tab keeps **its** selection.
- **`Check now`** triggers the very same code as the timer, immediately: what the button shows is therefore
  exactly what the watcher does.
- A ticket that was **deleted or became invisible** (rights lost) is reported **on its row**, without
  interrupting the check of the others, and **without erasing** the last known state.

### Git
Operations across **several repositories at once**, and branch exploration.

- **Actions** — `Create a branch` · `Create a tag` · `Delete branches` · `Delete tags`. You only **type** a
  name to create; to delete, you **pick from the list** of existing refs — the default branch and protected
  refs are not even in it. The repository is chosen through a **field with search** (as everywhere a project
  is picked), which matters when the list is long — **and so is the ref**: an active repository has hundreds
  of branches and tags. A single choice goes through a selector with search; a multiple choice (checkboxes,
  the explorer's table) gets a filter that **hides rows without unticking anything** — you tick, you filter
  something else, you tick again, then you delete in one go.
- **Nothing runs without a preview.** The preview lists each row (project × ref) and its expected outcome:
  *will run · already exists — skipped · protected ref · default branch · not found*. “Already exists” is
  not an error: the operation is **idempotent**, you can run it again. Each actionable row also shows **the
  matching command**: the one **actually executed** (the safety `git fetch`), the **git equivalent** of the
  write — given so you can understand it, since the write goes through the API and not the CLI — and the
  underlying **API call**.
- **Deletions are restorable.** Before every deletion, the tool **pulls the objects into its local clone**,
  then records the SHA. The **History** tab then offers `Restore` — and it works **even after the forge's
  garbage collector has run**, since it is the local clone that acts as the safety net, not the server.
- **Navigate** — checks out **several projects on your machine** (not the tool's clones: your own
  repositories) on the branch of your choice, in one gesture. You pick a **local directory** — a folder
  holding one subfolder per git project, declared in *Settings → Repositories* — then, row by row, a
  **project** and its **remote branch**, both with search as you type. The **current branch** is shown next
  to the selector: without it you choose blind, not knowing whether the operation changes anything at all. A
  `git fetch` precedes the branch list and the checkout, and the local branch is then aligned
  **fast-forward only** (a diverged history is reported, never overwritten). **Nothing is discarded**: if a
  repository has pending changes, the checkout is done anyway and the summary **lists the affected files** —
  a count would not let you check what you are carrying from one branch to the other. A failure (missing
  branch, refused checkout) is **isolated**: it does not stop the other projects, and its reason is shown.
- **Git commands** — runs **the same git command at the root of several local projects** at once. You pick a
  **local directory**, **tick the projects** (search + “check all”), then type a git command **or** take it
  from a **palette** (managed in *Settings → Git*). A three-step flow: **Preview** (the exact command + the
  list of targeted projects) → **Run** → **each project's output** appears, with its exit code. **Git only**,
  **without a shell** (the metacharacters `; | > &` are never interpreted) **and** with a **refusal of
  dangerous git options**: the flags that allow running an arbitrary command or escaping the folder (`-c`,
  `--upload-pack`, `--receive-pack`, `--exec`, `-C`, `--git-dir`, the `ext::` transport…) are blocked, and
  the command must start with a subcommand. A failing project is **isolated**; the others still run.
- **Branch explorer** — per project, one row per branch with its columns: `↑ahead ↓behind` versus the
  default branch, its **branch of origin**, the **branch it was merged into** and its **last commit**.
  Sorted **by last-commit date, most recent first**. From a branch, **`Create MR`** opens an MR between it
  and its source (the inferred origin, otherwise the default branch) — the same title popup as in AI Dev,
  offered only when the branch has commits ahead. Ticking branches then `Delete selection` opens the
  pre-filled preview. You can also **explore several repositories at once** (each result in a collapsible
  block, **folded** and marked with a chevron that rotates — repositories are analysed **one after
  another**, and each block says where it stands (*waiting*, then *analysing* with its spinner, then its
  branch count). A clone can take a minute: the button spins meanwhile, and a repository that fails
  **opens its block** to show why instead of leaving it shut. The **tag list** shows the date, the **branch(es) that carry the tag** and the author of the
  pointed commit — with a `Tag author` button that reads the **real *tagger*** of an annotated tag in the
  local clone (neither forge API exposes it).
- **Find a ref** — you type a tag **or** branch name (free text) and the tool says, **across every active
  repository** (GitLab and GitHub alike), which ones have it: type, commit + link to the forge, date, the
  branch(es) carrying the tag, the author — with the same `Tag author` button. An unreachable repository is
  reported separately, never confused with “absent”.

> ⚠️ **A branch's origin is an inference, not a fact.** Git records nowhere which branch a branch was
> created from. The tool infers it (`merge-base`), except when a merge request attests to it — the only
> certain case. An inferred origin is shown **in italics with its confidence** (*likely* / *ambiguous*),
> never as a fact.

### Docker
Two sub-views, like Coding/Exploration in AI Dev.

- **Compose** — the **local directories** (Settings → Repositories) are scanned for `compose.yaml` /
  `docker-compose.yml` files; each file becomes a **compose project** with its services. The list is
  **sorted by recent activity** (the project whose container was recreated most recently comes first) and a
  **filter at the top** lets you **tick/untick the projects to show** — a **persisted** choice.
- **Finding a container: search + state filter.** Above the list, a **search** field (service name,
  container name or project name) and a **“Show only”** selector — *Running · Not running (all) ·
  **Stopped (exited)** · **Created, never started** · **Not started (no container)** · **Exited with an
  error** · Unhealthy · Restarting · Drifted* — narrow the display **service by service**. “Not running”
  covered three situations that Docker distinguishes and that call for different gestures: a container that
  **ran then stopped** wants a restart, a container **created but never started** often signals a launch
  failure, and **no container at all** calls for an `up`. The umbrella *Not running (all)* stays, so as not
  to break filters that were already saved. A project none of whose services match **disappears entirely**
  (an empty card would suggest a project with no service); on a partially filtered project, a note reminds
  you how many services are hidden. Both settings are **persisted** and apply **live**, without calling
  Docker again — they are the same state labels as the *Actions* sub-tab. **Progressive display**, to stay
  fast even with many containers: the **project list appears immediately** (scan + a single `docker ps -a`),
  then each project's detail (drift, states) **fills in card by card** as it arrives; server-side, the
  `docker inspect` / `compose config` calls run **in parallel** instead of one by one.
- **Every container's state stands out clearly**: a coloured dot (**● Running** green, **exited/dead** red,
  **paused/restarting** amber, **not started** dotted), at the head of each service.
- **`.env` drift, compared on the actual vs the expected — never on hashes.** The expected comes from
  `docker compose config` (Compose resolves `${VAR}`, the `env_file`s and the overrides itself — we
  **never** parse `.env` files by hand), the actual from the container's `docker inspect`. The diff gives a
  **badge per service**: *in sync* · *config drift* · *image drift* · *compose changed* · *not created*. The
  badge **names names**: “`DB_POOL_SIZE` changed (10 → 25), `FEATURE_X` added” tells you whether the restart
  is urgent or cosmetic. The **values of variables with a sensitive name** (`*TOKEN*`, `*SECRET*`,
  `*PASSWORD*`…) are **masked** — “changed” without showing the old one or the new one.
- **Actions** — **Stop** / Restart / Pull / **Build** (`up -d --build`: rebuilds the image then recreates the
  container — to apply a Dockerfile change) / **Recreate** (the `--force-recreate` targeted at the drifted
  services — the action that follows from the badge), per service and per project, with a **streamed log**
  in the bottom panel and the **state refreshed automatically** at the end. A `down` **first lists what will
  be stopped** and **never touches the volumes** (no `-v`). These actions are also available **in batches**
  through the *Actions* sub-tab (choose the action → tick the containers concerned → confirm).
- **Makefile** — if a `Makefile` sits next to the compose file, its **commands** (targets) are listed with
  their description (`target: ## desc`). An **instant search** filters the list; a **Run** button launches
  `make <target>` in the folder (streamed log). Only a target **actually present** in the file is run.
- **Non-compose** — the containers with no compose project. **Stop** for those running; before any `rm`,
  their **full `docker inspect` is saved** (a restore safety net) and a **`Rebuild the command`** button
  turns the inspect into a readable `docker run` — the same spirit as restorable branch deletions.
- **Logs** — a **live tail of several containers at once** (picked with checkboxes, with search), over the
  **last X lines**. Each container has its **colour**; the stream **scrolls automatically**, with a
  **Pause / Resume scroll** button (scrolling back up pauses, coming back to the bottom re-enables it — like
  a terminal).
  - **Filters, persisted**: you can **exclude** words that pollute the view (each word is a “chip” you can
    **disable without removing** or **bring back** in one click), and **only show** the lines containing
    certain words. The filters are **remembered** (no need to retype them every time) and apply **live**,
    without restarting the stream.
  - **Readable text, colours on demand.** An application in a container colours its output, `docker logs`
    relays those escape bytes as they are, and a browser is not a terminal: every line arrived buried under
    `[34mdebug[39m`. Lines are shown **as plain text by default** — which is also the lightest rendering
    when the stream bursts — and a **“Show colours”** checkbox, next to *Wrap lines*, restores what the
    application meant to say. The choice is remembered, ticking it **replays what is already on screen**
    without restarting the stream, and the filters keep working on the bare text either way. **Background**
    colours are deliberately ignored: they assume a terminal whose contrast you control, not a light theme
    and a dark one. An accented character landing on a network packet boundary is no longer cut in two.
  - **Browser-friendly**: an **SSE** stream (one `docker logs -f` per container, killed on close), a
    **bounded buffer** in memory, DOM insertions **grouped by frame** (no reflow line by line) and a
    **capped number of displayed lines** — it stays smooth even on bursting logs. A **Clear** button and
    optional **line wrapping**.
- **Actions** — an **action-first** flow: you choose **one action** (Recreate / Restart / Start / Stop /
  Pull), the list of **containers concerned** appears (filtered by the action: *up* → stopped,
  *restart/stop* → running, *recreate/pull* → all), you **tick** the ones you want and **confirm**. A
  **state filter** narrows the list further — *Drifted*, *Unhealthy*, *Restarting*, *Running*, *Not running
  (all)* — along with a **search** by name. Confirming groups the services **by project** and runs one
  `docker compose` per project (one failure does not stop the others).
- **Health badges on the Docker tab**: the **number of containers in error** — *restarting*, *dead*, and
  those that **exited with an error** (a non-zero exit code) — in **red**. A container stopped **cleanly**
  (code 0: you stopped it yourself, or a job finished its work) does not count: counting it in red set the
  alarm off every day, and an alarm that always rings stops being read. It is still named in the tooltip. An
  unreadable exit code stays out of the alarm — we do not cry wolf on a guess. Plus the **number of
  unhealthy containers** in **orange**, right in the menu — visible at startup and refreshed
  **automatically every 30 s** (and every time the tab is opened) — so a container flipping to *restarting*
  shows up in the menu title **even when you are not on the Docker tab**. The poll is light (a single
  `docker ps -a`) and pauses when the browser tab is hidden.
- If the **Docker daemon is unreachable** (Docker Desktop off, socket missing) or if the **CLI is not in the
  server's PATH**, an **actionable** message explains it (pointing at `DOCKER_BIN` in the `.env` if needed)
  — like the certificate / token errors.

### Links
Work links have a **structure** a browser's bookmarks cannot express: the same service exists in
local, dev, staging and production. A folder tree scatters it across four places; a **grid** shows
it at once — services as rows, environments as columns.

Two shapes, because there are two realities. Whatever has no environment dimension (Confluence, a
doc, a tool) stays a **free link**, flat, found by its tags.

#### The grid
- **Rows are services**, pinned first then alphabetical. Each row carries the name, its **tags**,
  and the **linked Mergerie repository** when there is one.
- **Columns are environments**, in the order you give them, each with its own header **colour**
  (production in red invites a second thought before clicking).
- **A cell is one URL, written out.** We could have guessed the staging address from the dev one by
  swapping a piece of domain; that is exactly the magic that one day sends you to the wrong
  environment without a word. An empty cell shows a `+`: you paste the address **in the cell**,
  Enter confirms, Esc cancels — no dialog to paste a URL. Clearing the field clears the cell.
- **Filter by tag** above the grid: a service often belongs to two families at once (*backend* and
  *payment*), which a folder tree would force it to choose between.
- Only **`http` or `https`** addresses are accepted, here as everywhere in this tab: these links
  open in one click from the application.

#### Free links
A flat list under the grid: label, URL, tags. Instant search, add and edit in place. This is where
imported bookmarks land.

**Turning them into a service.** Tick several links, then `Turn into a service`: one row per link,
one environment to pick for each. The mapping is **explicit** — guessing “dev” from a URL
containing `-dev` would work nine times out of ten, and the tenth would put a production address in
the development column.

#### The palette — `Ctrl`/`Cmd` + `K`, or the `o` key
The search field in the header opens the **global palette**, which searches **everything at once**:
the grid's cells (“kibana staging”), free links, merge requests (by number or by words of the
title), watched tickets, note pages, open todos, and navigation actions. Enter opens — an external
link in a new tab, an internal object in its own place.

- **Fuzzy search**, accent- and case-insensitive — `generation` finds “Génération du rapport”, and
  the other way round. You abbreviate **by words**: `kib pre` finds “Kibana · preprod”, each word
  you type having to appear *whole* somewhere in the target. Dropping a letter inside a word
  (`kbana`) finds nothing, and that is deliberate: allowing gapped words all the way down into the
  database would push more than half the rows past the ranking, which would then have nothing left
  to sort with. The ranking itself favours what **starts** a word — `api` brings up “api-core”
  ahead of “rapid”, which holds the same letters.
- **Ranked by frecency**: what you open *often* **and** *recently* comes up. A plain counter would
  keep whatever you hammered last month at the top forever; a plain date would lose what you have
  opened every day for a year.
- The palette queries the **server**: it therefore sees everything, including what the current tab
  has not loaded — searching for a merge request from Docker works. Filtering happens **in the database**, not
  over a slice of it: a merge request three hundred older ones down is as findable as a fresh one.
  Only the *answer* is capped — at twelve rows, which is what a dropdown can show.

#### Contextual links on merge requests
When a service is linked to a repository, the **detail of that repository's merge requests** carries
a row of buttons: the service's grid URLs (“Open · dev”), then its **contextual links**.

A contextual link is a **template** with variables, resolved when you click:

| variable | resolves to |
|---|---|
| `{env}` | the environment (one button per environment that has a URL) |
| `{branch}` | the merge request's source branch |
| `{mr_iid}` | the merge request number |
| `{service}` | the service's name |

Example: `https://kibana-{env}.corp/app/logs?q={service}%20{branch}` opens the logs of *that*
branch, on the environment you want, without retyping anything.

- **An unknown variable is refused as you type it**, and the message says which ones exist: a typo
  should show up while you write it, not produce a broken URL three weeks later.
- **Every substituted value is URL-encoded**: a branch named `feat/x?y=1` does not build a surprise
  URL with an extra parameter.
- A variable **with no value in this context** leaves the button visible but **greyed out**, with
  its reason on hover. Hiding it would suggest it does not exist; a URL with holes would land on an
  error page.
- A template **without `{env}`** gives a **single** button: it does not depend on the environment,
  and offering one per column would hand you the same address N times.

#### Importing Chrome bookmarks
*Chrome → Bookmarks → Bookmark manager → ⋮ → Export bookmarks*, then `Import from Chrome`.

- **Preview first**: the folder tree as it was in the browser, each link tickable. Nothing is
  created until you confirm — the same spirit as the mandatory preview of git operations.
- Everything ticked arrives as **free links**, **tagged by its folder path**
  (`Work/Kibana` → `work`, `kibana`).
- **Replayable**: re-importing the same file after adding three bookmarks does not duplicate the
  other hundred — a URL already known is skipped, and the number skipped is announced (silence
  would read as a failure).
- The file is **never executed or rendered**: it is parsed, and only `http(s)` addresses come out —
  a `javascript:` bookmark is ignored. Size capped at 5 MB.
- Turning them into services comes **afterwards**, by hand (see above).

#### Health check — off by default, behind two switches
These requests are the **only** ones this tab sends outward, and they go to addresses you typed in.
Hence two switches, not one:

1. **Globally**, in *Settings → General*, with its interval (5 min by default, 1 min minimum).
2. **Per environment**, in the environment's dialog. **Production is out by default**: sending
   automatic traffic at a production service is not a decision a tool makes on your behalf.

How it works: a `HEAD` (falling back to `GET` on a 405, so a matter of method is not read as
“unreachable”), 5 s of patience, redirects followed (3 at most), **no response body read**. 2xx-3xx
→ reachable, anything else → unreachable. The cycle is **sequential**: twenty services × four
environments fired at once is eighty simultaneous connections leaving a workstation.

⚠ **Two limits worth knowing.** Checks only go out **while a Mergerie tab is open** — no phantom
traffic at night. And the result is a **last known state**, not a history: the question asked is
“is it up right now?”.

Display: a dot on the cell (green, red, grey), with the HTTP code, the latency and the time on
hover; and the number of unreachable links as a **red badge** on the Links entry of the menu.
**No desktop notification**: a service going down at night would produce dozens.

### Stats
An MR funnel, a distribution of the scores, the **weekly evolution of the average score** (“is quality
improving?”), weekly activity, a table per project (with the **resolution rate**, a **trend** ▲/▼ and the
**last commit** — date, author, link to the commit on its forge), a **Top 5 of the repositories with the
most recent activity** (last commit with **date AND time** — several repositories push on the same day, and
without the time the ranking looks arbitrary —, author, link; repositories whose MR fetching is unticked are
excluded from it, as are inactive repositories: we no longer follow them), a **token cost** (a pie chart per
call type + the **average cost per reviewed MR**), a summary of the sessions. Commit activity is fetched
**live from each repository's forge, across all branches** (loaded separately, best-effort: nothing breaks
if a forge is unreachable).

**Project activity — last 6 months.** Answers “which repositories are alive, which are asleep”. **One
horizontal bar per tracked repository** (active AND MR fetching ticked), ordered from the longest to the
shortest, with the **name in full on the left** and the total on the right. The chart has a **fixed height
and scrolls**: twenty repositories read fine without pushing the rest of the page away, and without any name
being truncated — in columns, each got only 65 px and all of them ended up cut.

The length is the number of **active days** — the days on which at least one commit landed — and not the
number of commits. A working day means the same thing everywhere, whereas a commit count mostly measures
*style*: squashing or not changes the count fortyfold for the same work, and one inflated repository would
crush all the others. The measure is also **bounded** (about twenty working days a month), so it is
genuinely comparable from one repository to the next. The commits stay available on hover.

- The bar is **stacked by month**, **one colour per month**, oldest on the left to most recent on the right
  — time reads in the reading direction, and the legend under the chart gives the mapping. The hues follow a
  cold → warm sequence rather than a rainbow: months follow one another, and the order must stay readable
  even without looking at the legend. The length gives the volume, the distribution says whether the
  activity is **recent or old** — two hundred commits concentrated five months ago do not describe the same
  project as two hundred steady commits.
- The **current month** is not over: it is marked with an asterisk in the legend, so you do not read a drop
  where there is only a month in progress.
- A repository with no commit at all over the **last two months** gets its bar **desaturated** and its name
  in grey italics — desaturated rather than flattened to plain grey, so you can still read *when* it
  stopped, which is often the question you are asking in front of it. It stays in the list — that is exactly
  what you came to see — but it does not get confused with a merely quiet project. One empty month happens
  to everyone; two draw a slope.
- **Hovering a bar** gives the detail: active days and commits month by month, distinct contributors of the
  busiest month, and the reason when the repository is unreachable.
- **Clicking a bar** — the whole row, label included — opens the project over **12 months**: six months say
  *who* is moving, twelve say *in which direction*. A repository quiet for two months after ten sustained
  ones does not tell the same story as a repository dead for a year, and the overview cannot tell them
  apart. The window gives the total of days, commits and contributors, the **busiest month** and the **last
  activity** — two markers you would otherwise hunt for by eye on the chart.

What is **left out of the count**: bot commits (Dependabot, Renovate, GitHub Actions, Mergify). Without that
filter, an abandoned repository updated every week by a bot would keep a few active days a month and would
never be flagged asleep — the exact false positive this chart is meant to avoid. A human committing from a
forge's web interface, on the other hand, counts normally.

Repositories are queried **four at a time**: in series, twenty repositories add up their network round trips
and the first load takes tens of seconds; all at once, the forge answers with a refusal. Two views asking
for the same repository at the same moment (the overview and the detail window) share the same work instead
of paying for it twice.

The counts are **cached by month**: a closed month no longer changes, only the current month is refreshed
(at most once every half hour). Without that, six months of history would be re-paginated from the forge
every time the tab is opened. On GitLab the count covers **all branches**; on GitHub the **default branch**
only — listing them all there would cost dozens of calls per repository, and the screen says so rather than
letting you believe in a complete count. An unreachable repository keeps its bar, with the reason on hover.

Every chart displays **the question it answers**. The token total is a **lower bound** (the agent's internal
work is not counted).

### Settings
Sub-tabs: **Specific review rules** (criteria added to the prompt when the branch name contains a given
fragment **or when the diff touches a path** — a glob such as `**/migrations/**`, `*.sql`, which is more
precise; a rule on a path can carry a **“risk” badge** shown on the merge requests concerned, computed
**without AI** just from the diff's paths, to see at a glance which one to review first) · **Repositories**
(added one by one or in bulk **from GitLab** or **from GitHub** — each repository carries a forge badge, and
the same path can exist on both —, plus the **local directories** — a folder on your machine holding one
subfolder per git project, which feeds the *Git → Navigate* tab and *Out-of-repo coding*; the displayed
count “n git projects out of m folders” confirms at a glance that you pointed at the right level of the
tree) · **Notifications** (a dedicated sub-tab, see below) · **General** (light/dark/auto theme, language,
and a **danger zone** for a full reset) · **Git** (the **GitLab connection** — URL + access token, with
*Test the connection* —, the **GitHub connection** — URL (empty = github.com, otherwise GitHub Enterprise)
+ token, with *Test GitHub* —, the **clone folder**, and the **git command palette** of the *Git → Git
commands* tab: add/edit/delete commands as *name + fixed command*) · **Jira** (the **Jira connection** —
URL + email + API token, with a *Test Jira* button —; feeds the *Jira* tab and the enrichment of a session
from a ticket) · **Merge Request** (the review skill, automatic refresh, convergence, prompt templates) ·
**Verifiers** (your test scripts, and the repositories each of them can test — see *Objective verification*
below; the page shows **the list** first, and the form opens on *Add a verifier* or on *Edit*) ·
**AI sessions** (a technical test: two passes inside the same agent session — it memorises a marker then
recalls it on resume — to check that **session resuming** works with your CLI; it is the foundation of
context continuity between review, fixes and convergence).

### Desktop notifications
System notifications for the moments that **call for an action or close a wait** — not for atmosphere. On by
default: **the end of the review queue** (the batch, not each MR), **a review under a score threshold**
(“MR !142: 4.2/10”, adjustable threshold), **a job failure** (timeout, CLI, network), **a coding session
finished** and **the AI has asked a question** (a session is waiting for your answers to resume). Off by
default because they are informative: **a new MR discovered** and **an MR merged**. The notifications are
**persistent**: they stay on screen until you click or dismiss them, so you do not miss them. A **click on
the notification** brings you back to the right place (tab focus + opening the MR or the session concerned).
A **“silent mode” toggle** in the bottom bar cuts everything in one click. Fine-grained settings live in the
**Settings → Notifications** sub-tab, with the browser **permission status** (granted / denied / to be
asked) and a *Test* button — because a permission silently denied is the classic trap of this API.

### Language
The interface is in **French or English**, chosen in **Settings → General**. The preference is saved in the
database — and not only in the browser — because the server needs it: its error messages are shown as they
are in the interface.

The **reports produced by the AI follow the chosen language**, through the default prompt templates. A
prompt **you have customised is never overwritten** by a language change: only the templates left at their
default are realigned.

> Migration in progress: the shell of the interface, the notifications and the error messages are
> translated; the content of the cards and lists is still in French.
> Consistency check of the dictionary: `npm run i18n:check`.

### Everyday comfort
The tab, the sub-tab **and the Reviews stage are remembered** from one session to the next — and **nothing
else**: no search, no dialog, no open report, because a stale state is worse than a clean start ·
**keyboard shortcuts** (`1`-`8` for tabs, `/` search, `n` new todo, `r` fetch MRs, `l` logs, `?` help, `Esc` closes) · a
**dynamic favicon** during a job · error messages **translated into actions** (certificate, token, CLI not
found, timeout, network) · a **3-step onboarding** as long as the connection and the repositories are not
configured · every form field carries an **i icon** whose hover (or keyboard focus) explains what it is for.

- **Command palette — `Ctrl`/`Cmd` + `K`.** You type a fragment and jump wherever you want: a tab, a stage,
  a merge request, a session — the search covers what is already loaded, so it answers without calling the
  server. `?` shows the full list of shortcuts.
- **Browse the list from the keyboard**: `j` / `k` move down and up in the visible list, `Enter` opens, `Esc`
  releases. No focus outline appears until you have pressed a key.
- **The interface keeps still.** A refresh that changes nothing no longer rebuilds the list: the page does
  not blink while you read it. When a list really does load, its cards arrive in a cascade — once, on load,
  not on every character typed into a filter.
- **What is running is marked on the object that is running**: the merge request or the session concerned
  carries an animated outline, **one object at a time**. It freezes when the tab goes to the background and
  stays still if the system asks for reduced motion.
- **The log no longer eats the browser**: past a few thousand lines, the oldest are pruned and a banner says
  so.
- **The report panel opens on what has changed since your last visit** — arrivals, departures, and the one
  that has been waiting the longest. Three lines at most, and **nothing at all** when nothing has moved.
- The **“resume an existing agent session”** field does not behave the same depending on the backend. With
  **claude**, sessions are filed **per project directory** (`~/.claude/projects/…`): since Mergerie works in
  its own clone, an identifier taken from elsewhere — your own repository, a session opened by hand in a
  terminal — will not be found there. The work then restarts from a fresh session with the context
  re-injected, and the card says so. With **copilot**, the identifier is an isolated home path: it resumes
  from anywhere. The identifiers Mergerie offers (“Resume in terminal”, the session a branch came from) are
  always in the right directory.

- An **out-of-repo coding** session carries the **“AI output” button at session level**, not only on each
  folder: “what did the AI do?” is what you ask while looking at the card. When the session covers several
  folders, the view offers a selector to move from one to the next without closing.
- A session covering **several projects** (coding, exploration, or out-of-repo coding) shows its list
  **folded**, with a “Show the N projects” to unfold it. Past a few repositories, a single session otherwise
  filled the whole screen and hid the others — which are exactly what you came to look at. The folded state
  is remembered per session: it survives the automatic refreshes.
- **Reading a report survives a refresh**: the scroll position, the tab and the version you were reading are
  kept as long as the report itself has not changed.
- An **identity line that is too long** (project path, author, date) is truncated to the card's width: hover
  then shows the full text — the tooltip only appears if the text is really cut, and disappears when the
  window widens. The links to the **ticket** and to the **forge** have their own line, where they wrap
  instead of being cut.

## Objective verification (verifiers)

A review says *what it thinks* of the code. A **verifier** says **what happens when you run it**: it is
**your** test script, Mergerie prepares the repositories for it and reads its verdict. The two complement
each other — a 9/10 score on an MR whose integration tests break means nothing any more once you know it.

**What it changes in practice**: a badge on each merge request (`✓ verified`, `✗ 2 tests broken`,
`⚠ base red`, `⟳ stale`), and above all the ability to **verify together** merge requests from different
repositories that are only worth anything together — the front-end MR and the API one that only pass when
combined.

### Two families of verifiers

**Commands** — you give a list (`npm ci`, then `npm test`), Mergerie runs it in the prepared repository and
**the verdict comes from the exit codes**. Nothing to write, nothing to install. This is the common case,
and the right starting point.

The **order matters** — `npm ci` before `npm test` — and is corrected in one click: each row carries its
rank and two arrows to move it.

Such a verifier can **cover several repositories**. Be careful about what “cover” means: declaring a
repository only announces that this verifier **knows how to test it**. At run time, the list only runs in
the repositories **actually targeted by the verification** — launched on a single merge request, it only
touches that one's repository, even if the verifier covers five. On a batch, it is **replayed in each of
them**, one after the other, and the verdict is the **AND** — everything must pass. That is what you want
when several projects are tested the same way: a single verifier instead of an identical one per
repository. Inside a repository, the first failing command stops the following ones (they depend on it);
from one repository to the next we carry on, because they are independent and knowing that two are broken
beats stopping at the first.

When several repositories are tested, the failures are **prefixed with the repository**
(`grp/lib › cart › discount`): without that, two projects each having a test of the same name would be
indistinguishable — and the base/head comparison would confuse them.

**Script** — an executable of your own that commits to the JSON contract described below. More work, but it
receives **every targeted repository at once** and decides itself what to do with them: that is the shape of
a real **integration** test, where “commands” simply replays the same list in each. It also returns named
tests whatever way your suite expresses itself.

The two share everything else: git preparation, the double base/head run, badges, report, “Fix”.

#### What “commands” can say, and what it cannot

The list stops **at the first command that fails**: after a failed `npm ci`, the output of `npm test` is
just noise. The report then shows the sequence — which command, which code, how long, and its output.

That leaves the question of **test names**, which is what makes the verdict causal. Mergerie looks for them
in this order, never guessing:

1. **The JUnit report file**, if you declare one (the *JUnit report* field, a path relative to the
   repository — so it is read in each of them when several are tested). It is the pivot format:
   `pytest --junitxml`, `jest-junit`, `phpunit --log-junit`, Surefire, `go-junit-report`… The most reliable,
   and it does not suffer the log's truncation.
2. **TAP in the output**, recognised on its own — see below.
3. **Nothing.** Then it is the **command** that is blamed: the badge shows `✗ failed: npm test` instead of
   announcing a number of tests nobody knows. And since the delta's key becomes the command, a command
   already red on the base still gives `⚠ base red` — the regression stays honest.

In that last case, the report additionally shows **what is new compared to the base**: the lines present at
the head and absent from the base run. It costs nothing — both outputs already exist — and it often points
straight at the regression, including behind an opaque `make test`.

Finally, if the exit code and the test report **contradict each other** (exit 0 with red tests, or the
opposite), the verdict follows the exit code and the report reports the contradiction. It is almost always a
genuine defect of the test command, and hiding it would do you a disservice.

#### TAP: nothing to declare

Many runners write **TAP** as soon as their output is not a terminal — which is always the case here, since
Mergerie runs the commands through pipes. It is then recognised and parsed with no configuration at all:
`node --test`, mocha (`--reporter tap`), vitest (`--reporter=tap`), `pytest-tap`, prove…

The traps are handled: **sub-tests** are not counted twice (only the failing leaves are kept, with their
full name `suite › test`), a `# TODO` is an **expected** failure and does not count, a `# SKIP` is neither,
a `Bail out!` gives an error and not “zero failures”, and the **plan** (`1..43`) acts as a control: if the
output was truncated, the report says so instead of presenting a partial list as exhaustive.

The *Parse TAP* switch exists for the day an exotic output would trigger the detection by mistake.

#### `npm: command not found`

The commands' environment is **minimal** (`PATH`, `HOME`, `LANG`, `MERGERIE_VERIFY=1`, with no token at
all), and the `PATH` is the **server process**'s. Launched from a terminal where nvm is loaded, everything
works. Launched by a service or a desktop launcher, `npm` will not be found — that is what the
**Environment variables** field is for: one `KEY=value` per line, for instance a full `PATH`.

### How the roles are shared

**Mergerie does all the git.** Your script does no checkout and knows no branch: it receives directories
already positioned on the right commits and answers “do the tests pass”. That is what lets the same script
serve in a throwaway worktree as well as in your own working directory.

**Declarative coverage ≠ actual checkout.** In *Settings → Verifiers*, declaring a repository only says
“this script knows how to test that repository”. Only the repositories **actually targeted** by a
verification are prepared and passed to the script. The other covered repositories configured *in place* are
read **read-only** and appear as **context** in the report (with a ⚠ if they are off their default branch or
modified): a green obtained thanks to a neighbour left on an old branch must not go unnoticed.

### Two modes, repository by repository

- **worktree** (the default) — Mergerie creates a detached `git worktree` under `data/worktrees/`, removes
  it after the run, and collects the orphans at startup. Nothing you have on your machine is touched.
- **in place** — the run happens in **your** working directory. Useful when the test environment cannot be
  recreated (a local database, containers already warm, `node_modules` installed). Three guard rails, in
  this order: **explicit consent** to tick, the repository's **identity** checked (the directory's `origin`
  must be the repository's), and a **flat refusal if TRACKED files have been modified** — never an automatic
  `stash`. **Untracked** files do not block: they are in no commit, the detached checkout does not touch
  them and the restore leaves them where they are — requiring the opposite forbade *in place* mode to any
  directory carrying a `.env.local` or an artefacts folder, that is to say to almost all of them. They are
  counted and **noted in the run's log**: they stay there during the tests and may weigh on the result. (If
  one of them bears the name of a file of the branch under test, git refuses the checkout by itself: the
  verification fails instead of overwriting your file.) During the run, your directory is on a **detached
  commit**: do not develop on it. It is **put back on its original ref in every case**, including on a
  timeout or a job crash; if the restore fails, the report carries a **“Manual restore required”** banner —
  that never drowns in a log.

The directory is **picked** rather than typed: if you have declared *local directories* (Settings →
Repositories), a selector lists all their git projects — with search as you type, because a root commonly
holds dozens — and fills in the absolute path. A hand-typed path remains possible for a directory outside
any declared root, but it is a typo you only discover on the first run, and that costs the run.

The **“Test the directory”** button answers while the form is still in front of you: directory recognised,
current branch, and the two possible reservations — tracked modifications (which would get the run refused)
and untracked files (which do not block, but will be there during the tests).

### Script contract (v1) — the “script” family only

**Which file?** Any **executable** — the extension does not matter at all (`.sh`, `.py`, `.js`, a binary).
Two technical conditions: the **execute bit** (`chmod +x`), and a **shebang** (`#!/bin/sh`,
`#!/usr/bin/env python3`…) if it is a script, since it is launched directly and nothing guesses what to
interpret it with. The *Command* field expects an **absolute path**, not a command line: **no argument is
passed**, and pipes, redirections and variables would not be interpreted — options go inside the script.

The script is launched **without a shell**, once per run (`base` then `head`), with a **minimal
environment** (`PATH`, `HOME`, `LANG`, `MERGERIE_VERIFY=1`): **no token**, no Mergerie variable. Its `cwd`
is the first directory of the list. Its `stderr` is streamed into the job's log panel.

**Input** (JSON on stdin):

```json
{
  "version": 1,
  "verifier": "integ",
  "role": "head",
  "repos": [
    { "name": "group/webapp-front", "dir": "/abs/path", "sha": "a1b2c3…",
      "branch": "feat/PROJ-720", "mode": "worktree", "changed": true }
  ]
}
```

**Output**: the **last valid JSON line** of stdout.

```json
{
  "version": 1,
  "status": "pass",
  "total": 218,
  "failed": [
    { "test": "checkout › server total", "message": "expected 42, got 41", "log_excerpt": "…" }
  ],
  "duration_ms": 42000
}
```

The **exit code is indicative**: stdout is what counts (a script that exits 1 because tests failed has
delivered its verdict perfectly well). An unreadable, truncated or off-schema answer, on the other hand,
**never becomes a green**: it gives `⚠ verification in error`. Bounds: `failed` ≤ 50 entries, `log_excerpt`
≤ 4 kB each, the whole response ≤ 256 kB.

### Example A — worktree + an ephemeral docker compose

```sh
#!/bin/sh
# Integration verifier: a throwaway stack per run, destroyed whatever happens.
set -eu
INPUT=$(cat)
FRONT=$(printf '%s' "$INPUT" | jq -r '.repos[] | select(.name|endswith("webapp-front")) | .dir')
API=$(printf '%s' "$INPUT" | jq -r '.repos[] | select(.name|endswith("api-core")) | .dir')

PROJECT="mergerie-verify-$$"
trap 'docker compose -p "$PROJECT" down --remove-orphans >&2 || true' EXIT

docker compose -p "$PROJECT" --env-file ./integ.env \
  -f "$API/docker-compose.yml" -f "$FRONT/docker-compose.yml" up -d --build >&2

# The JUnit report is turned into a contract response. `total`/`failed` come from it.
if docker compose -p "$PROJECT" run --rm tests >/tmp/out-$$ 2>&1; then
  printf '{"version":1,"status":"pass","total":%s}\n' "$(grep -c '^ok ' /tmp/out-$$)"
else
  printf '{"version":1,"status":"fail","failed":%s}\n' "$(./junit2json.sh /tmp/out-$$)"
fi
```

Two points that matter: `-p` **isolates the compose project** (two runs do not tread on each other), and the
`trap EXIT` guarantees the stack is destroyed **even if the script is killed** on a timeout.

### Example B — in place + an HTTP adapter

When the suite already runs in a local orchestrator, the script only has to trigger it and **translate its
answer** into the contract:

```sh
#!/bin/sh
set -eu
cat >/dev/null            # the input is unused: the orchestrator already knows the folders
curl -sf --max-time 900 -X POST http://127.0.0.1:9099/run \
  | jq -c '{version:1,
            status: (if .failures == 0 then "pass" else "fail" end),
            total: .tests,
            failed: [.results[] | select(.ok|not)
                     | {test: .name, message: .message, log_excerpt: .output}][:50]}'
```

### `node_modules`, and why the base is sometimes red

**`node_modules` strategy.** A fresh worktree has no dependencies installed. Two answers: a **symlink** from
a shared cache (fast, but assumes the `lock` has not changed), or an **install** in the worktree (slow, but
faithful). The choice is yours — it lives in your script. An
`ln -s "$CACHE/node_modules" "$dir/node_modules"` does the job as long as you invalidate the cache when
`package-lock.json` changes.

**FAQ.**

- *Why is my base red?* The **base** run replays the same suite on the target branches, **before** your
  changes. If it already fails, the verdict is `⚠ base red` and **nothing is blamed on your branch** —
  which is the point. Unticking “Also run the base” removes that second run: the verdict still comes out,
  but it is no longer **causal**, and the report says so.
- *Is the base replayed every time?* **Yes**, even when no commit has moved. A cache keyed on the set of
  SHAs did exist and did save time; it assumed the **environment** had not moved either, which nothing lets
  you check — and it was wrong in both directions: a red base fixed outside git (a service restarted, a
  migration applied) stayed stuck and blocked the MR on a stale “base red”; conversely, a base green that
  had become false made your branch carry the blame for a failure that did not come from it. A verification
  therefore costs two runs — that is the price of a verdict that does not lie. To pay for only one, untick
  “Also run the base”: the verdict is then marked non-causal.
- *git does not work in my test container.* In a worktree, `.git` is a **pointer file** to the main
  repository, not a folder. Mount the clone (`data/clones/…`) in the container too, or do not call git from
  the tests.
- *“Manual restore required”.* The *in place* mode could not put your directory back on its branch: it
  stayed on a detached commit. The message says **which directory** and **which ref** to expect — a
  `git checkout <ref>` is enough once whatever was blocking is cleared.
- *The verdict is `⟳ stale`.* It covers commits that are no longer the branch's. It is **kept, not erased**
  (it is dated): run the verification again.

### Verify together, and fix

The **Verify** button is present on the merge requests to review **as well as on those already reviewed**
(in the list and in the report panel): a review is an opinion, a verdict is a fact, and the second keeps all
its value once the first has been given. A click opens a **confirmation** announcing what is going to run —
the commands or the script, the repository, the mode, the timeout — before launching anything. It appears
even when a single verifier covers the repository: running commands on your machine deserves a screen, not a
silent click.

In *Reviews*, tick several merge requests: the action bar offers **Verify together** and **Create a batch**
(a batch is named, persisted, and re-verifiable with one button from *AI Dev*). Two MRs from the **same
repository** are refused — we would not know which code was tested.

On a `✗` verdict, the report offers **“Fix (AI session)”**: a **single** coding session covering **all** the
repositories of the batch — not only the one where the test broke, because the cause of an integration
failure is often elsewhere. The prompt carries the facts (broken tests, messages, excerpts, tested commits)
and the working branches are **the MRs' own**: the push updates them in place. After the push, you run the
verification again by hand — no automatic chain.

### Two verifications at the same time?

It depends on what is running. A **single-repository** verification is contained in its directory: another
can start in parallel, as long as it does not target the **same repository** — re-running the same thing
would not give a second opinion, only a run that waits for the first to say the same thing.

A **multi-repository** verification, on the other hand, is an integration run: it brings up a complete
environment, often containers on fixed ports and databases. That one blocks everybody, and gets blocked by
everybody — two in parallel would return reds that teach nothing.

In both cases the refusal is immediate and says which of the two reasons applies.

**Dry-run mode**: it only concerns the AI agent. A verification **stays real** if it is configured. In
**demo mode**, on the other hand, no script is run at all: the verdict is simulated.

## Configuration (.env)

A `.env` file at the root is loaded automatically at startup.

| Variable | Default | Role |
|---|---|---|
| `PORT` | 4319 | server port |
| `HOST` | `127.0.0.1` | listening interface; `0.0.0.0` to expose on the network — see the **Security** section |
| `COPILOT_BIN` | `copilot` | the AI agent's binary (e.g. `claude`) |
| `COPILOT_ARGS` | — | args passed BEFORE `-p` (e.g. `--yolo`, `--dangerously-skip-permissions`) |
| `COPILOT_DRY_RUN` | 0 | `1` = force mock mode (no AI) |
| `COPILOT_TIMEOUT_MS` | 900000 | timeout of an AI call (15 min) |
| `GITLAB_CA_CERT` | — | path to a CA to pin (self-hosted GitLab) — **recommended** |
| `GITLAB_INSECURE_TLS` | 0 | `1` = skip the TLS check **for GitLab only** (troubleshooting) |
| `GITHUB_CA_CERT` | — | same for a **GitHub Enterprise** instance with an internal CA |
| `GITHUB_INSECURE_TLS` | 0 | `1` = skip the TLS check **for GitHub only** (troubleshooting) |
| `GIT_CLONE_SSH` | 0 | `1` = clone over SSH (your key) instead of HTTPS+token |
| `MERGERIE_DATA_DIR` | `data/` | isolated data folder (useful for tests) |

The AI agent must be able to **modify files** (“yolo” mode) for the coding sessions. Explorations, on the
other hand, are read-only: the repositories are reset after each pass.

## Self-hosted GitLab / GitHub Enterprise / corporate certificate

If the API fails with `UNABLE_TO_GET_ISSUER_CERT_LOCALLY` (an internal CA unknown to Node):
- **the clean way**: export the CA (the full chain up to the root) and point `GITLAB_CA_CERT=/path/ca.pem`
  at it (or `GITHUB_CA_CERT` for a GitHub Enterprise instance);
- **troubleshooting**: `GITLAB_INSECURE_TLS=1` / `GITHUB_INSECURE_TLS=1`.

The two settings are **independent**: pinning your internal GitLab's CA changes nothing for calls to
github.com. For the **clone**, `git` has its own store: either `GIT_CLONE_SSH=1` (an SSH key), or the
settings above are applied to git as well.

## Recording a presentation video (ready for YouTube)

```bash
npm i -D playwright && npx playwright install chromium   # once
npm run record:demo                                       # both languages, one after the other
npm run record:demo -- --lang=en                          # → demo-recordings/mergerie-demo-en.webm
npm run demo:gif                                          # → docs/demo.gif (the README one)
```

`scripts/record-demo.js` is self-contained: it launches the app in demo mode itself, waits for port 4319,
and drives a Chromium that records, in **1920×1080**, a **guided tour** with a **visible fake cursor**,
intro/outro **cards** and **explanatory captions** synchronised with each screen — then shuts everything
down cleanly (closing the context flushes the video). The route: *Reviews* → a scored report → the version
selector **v1 → v2 → v3** (a progression from **5.8 to 8.4**) → resolution tracking → *AI Dev* (a session
linked to its MR, a question asked by the AI) → *Notes* (morning brief, todos, pages) → *Jira* →
*Git* (the branch explorer) → *Links* (grid, health, global palette) → *Docker* (`.env` drift + live
logs) → *Stats* → the navigation column folding away. The `.webm` produced uploads straight to
YouTube.

**Both languages** are recorded one after the other against the same demo server, and the language is
set in **both** places the app reads it from — `localStorage` for the interface, and `config.language`
in the database for messages coming from the server. Setting only one yields an English video
punctuated with French sentences.

**Dropdowns are redrawn inside the page** for the duration of the recording. A native `<select>`'s list
is drawn by the operating system, outside the page: the camera films the page, so it never showed up.
You saw the cursor click, then the value change on its own — the least intelligible gesture in the
video. The stand-in is built from the element's real options; it is a recording device, living in
`scripts/record-demo.js` and nowhere else.

**The README's GIF** comes from the same recording: `npm run demo:gif`. Its settings (6 fps, 640 px,
64 colours, palette computed on the video) are tuned to stay under ~3.5 MB — a file GitHub reloads
on every visit to the landing page — without making the interface unreadable. They live in
`scripts/demo-gif.sh` rather than in a command to be rediscovered: working them out again costs half
an hour and yields a file twice too heavy.

## Dry-run mode (no AI)

`copilot`/`claude` missing or `COPILOT_DRY_RUN=1` → mock reports generated from the diff; the whole pipeline
stays testable.

```bash
COPILOT_DRY_RUN=1 npm start
npm run pipe        # smoke test of the pipeline on a synthetic repository
```

## Local clones

Each repository is cloned **only once**, into `<clone folder>/<project>`, and **reused** by every operation
(review, coding, exploration, the Git tab). On every pass the tool runs a `git fetch --prune` — it never
re-clones. The same clone is therefore shared, hence the internal exchange folder `ai-dev-tools-internal/`
added to `.git/info/exclude` so it is never committed.

Before a **coding session**, the worktree is **reset if it is dirty**: a previous session that was
interrupted can leave uncommitted files that would make the `checkout` fail. The cleanup only touches the
uncommitted — **commits already made are preserved**. Reviews only read a `git diff` and never depend on the
state of the worktree.

## Data & backup

All the state lives in **`data/`** (gitignored): `reviewer.db` (SQLite), `clones/`, `reviews/` (one folder
per MR, with **one report version per pass**: `review-v1.md`, `review-v2.md`…), `tickets/`, `tasks/` (diffs
per project and exploration answers).

### Backing up

**Settings → General → “Back up the data”** produces a dated `.zip` archive containing:

- **`reviewer.db`**, copied through SQLite's backup API and not with a `cp` — a file copy made during a
  write gives a corrupted database, which you only discover the day you try to restore it;
- **`reviews/`**, **`tasks/`** and **`tickets/`**: the reports, agent outputs and screenshots the database
  references by path. Backing up the database alone would leave dead references;
- a **`LISEZ-MOI.txt`** with the steps to restore — a backup you no longer know how to restore is worth
  nothing, and it is six months later that you open it.

The **clones and worktrees are excluded**: they come back with a `git clone`, and including them would
multiply the archive's size without saving anything irreplaceable. The archive is assembled in memory; past
256 MB it is refused, naming the file that tipped it over, rather than bringing the server down.

**Restoring** — with Mergerie stopped (the database must not be written during the copy): put the old
`data/` aside, unzip the archive in its place, restart. The missing clones are rebuilt on demand.

### Keeping the history

**Settings → General → “Keep the history”** (default **90 days**, `0` = no limit) deletes, past the delay:
the **job logs**, the **finished jobs** and the **activity feed**. The cleanup happens at startup then once
a day. Minimum 7 days — a shorter delay would erase the log of the job you are reading; and a job **in
progress** is never purged, however old it is.

Two things are **never** purged, deliberately: the **token cost** (`usage`), because it carries a cumulative
total that must not go down by itself, and the **agent iterations** (`agent_pass`), which already disappear
with their session and which the cards offer to re-read.

To run tests without touching your database: `MERGERIE_DATA_DIR=/tmp/my-test npm start`.

## Security

**Trust model.** The tool is **local and single-user**: it runs on *your* machine, with *your* access, and
performs powerful operations (git, Docker, an AI agent, reading and writing files). There is therefore **no
authentication** — the user of the machine **is** the user of the app. By default, **the server listens ONLY
on `localhost`** (`127.0.0.1`): it is therefore **not** reachable from the network. Exposing it is an
**explicit opt-in** through `HOST=0.0.0.0` — to be **reserved for a trusted network** (or put behind a
**reverse proxy with authentication**), never on an open network: the app has no auth and performs powerful
operations on your machine. No data is sent anywhere other than to the services **you** configure (your
GitLab, your GitHub, your Jira, your agent CLI).

**AI agent permissions (“yolo mode”).** The agent runs with its permission guard rails **disabled**
(“yolo”), because coding sessions require it: it must be able to create, modify and delete files without a
confirmation at every step. Its **nominal radius of action is the working clone** (`data/clones/…`), and the
guarantees are **structural** where possible: an exploration is read-only because the worktree is **reset in
a `finally`** afterwards, and a review only **reads a diff**. But during a **coding session**, the agent has
the **user's rights on the machine** — nothing technically stops it from acting outside the clone. That is
the **accepted trade-off** of a **local single-user** tool: to be known before use, and one more reason not
to expose the server.

**Verifiers.** Running a repository's tests **is running that repository's code**: the same level of trust
as the agent session, and the script executes with **your** rights on the machine. The command is an
**absolute path coming from the configuration** — never a file from the cloned repository —, it is launched
**without a shell**, with a **minimal environment containing no token**. The script's answer is treated as
**untrusted data**: schema validated, sizes bounded, systematic escaping on display. Worktrees are created
**under `data/` only**, and *in place* mode only writes in a directory of yours after **explicit consent**
(see *Objective verification*).

**Secrets.** The **GitLab PAT**, the **GitHub token** and the **Jira API token** are stored **locally**
(SQLite, `data/` is gitignored). The API and the UI **never** return them in clear: they are masked (`***`)
on read, and sending `***` on write **does not overwrite them**. The `.env` (which may carry environment
tokens) is gitignored too.

**Execution without a shell.** git, Docker and the agent are launched through `spawn` with an **array of
arguments**, **never a shell**: the metacharacters (`; | > & $()`) are therefore not interpreted — no shell
injection is possible from an input.

**Targeted anti-injection guard rails** (“without a shell” is not enough everywhere):
- **Git commands** — git **only**, and the git options that allow running an arbitrary command or escaping
  the folder are **refused** (`-c`, `--upload-pack`/`--receive-pack`/`--exec`, `-C`, `--git-dir`, the
  `ext::` transport…); the command must start with a **subcommand**.
- **Docker** — service/container names are validated (`validRef`) and separated by `--` (against
  *flag smuggling*); `down` **previews** and **never touches the volumes** (no `-v`).
- **Jira** — the `accountId` and `transitionId` are **validated** then quoted in the JQL (no JQL injection).
- **Local directories** — a project name is validated (no `..`, the path resolved and **confined under the
  declared root**): an input cannot make the tool act outside the allowed folders.

**XSS.** The rendering escapes everything that comes from elsewhere: `esc()` on every interpolated value,
and the Markdown converter (`mdToHtml`) **escapes the HTML** before applying an allow-list (bold, code,
tables…). Embedded Jira images are only rendered **inline** if their URL points at **our proxy** (no
injected external image). This matters because Jira descriptions and **comments can be written by other
people**.

**Jira attachments (download proxy).** The file is fetched server-side with the token: the `id` is
**numeric** and the URL is **built on the configured Jira base** (never supplied by the client) → no SSRF;
on the Jira→media redirect, **auth is stripped off-host** (the token does not leak); the size is **bounded**
(25 MB). An `image/svg+xml` (which can contain script) — and any non-raster type — is served as an
**`attachment`** (never `inline`), with **`X-Content-Type-Options: nosniff`** and
**`Content-Security-Policy: sandbox`**: opening an attachment cannot execute script on the app's origin.

**Destructive operations.** The strong-effect actions **warn before acting**: a mandatory preview of
multi-repository git operations, **restorable branch/tag deletions** (objects pulled into the local clone
before deletion), a Docker `down` in preview with volumes preserved, and **never an automatic merge** of an
MR.

**Enterprise TLS.** For a self-hosted GitLab or a GitHub Enterprise with an internal CA, supply
`GITLAB_CA_CERT` / `GITHUB_CA_CERT`. `GITLAB_INSECURE_TLS=1` / `GITHUB_INSECURE_TLS=1` **disables** the
certificate check: to be **reserved for a trusted internal network**.
