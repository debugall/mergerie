# Mergerie — Full guide

> ↩ Back to [README.md](../README.md) · 🇫🇷 [Guide (français)](./guide.fr.md)

This guide covers every tab, advanced configuration, enterprise TLS, local clones, data & backups and the
security model. For a quick start, stay on the [README](../README.md).

> **Convention.** Mergerie supports **GitLab and GitHub**. Throughout this document, **“MR”** means either
> a GitLab *merge request* or a GitHub *pull request*: the screens, the actions and the guarantees
> described are the same. The rare forge-specific differences are called out explicitly.

## The tabs in detail

Ten tabs, in a **left sidebar**, grouped by family — the core, what I have to do, my machine and its
links, the meta:
**Reviews** · **AI Dev** — **Notes** · **Jira** — **Git** · **Docker** · **Jenkins** · **Links** — **Stats** · **Settings**.
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

**The whole screen speaks of the REVIEWED version**, not of the branch head: tree, file content and
line numbers all come from the commit the report describes. That is what makes a “`src/foo.js` line
137” read in the report land on the right line on the right-hand side, even if the branch has moved
since (in which case the merge request is flagged **stale** anyway). If that commit has disappeared
from the repository — a force-push — the screen falls back to the branch head.
On the report side, the AI receives the diff **already numbered**: every line carries its real
number in the final version of the file, instead of being left to recount from the `@@` headers.

**Two ways to comment, your choice.** `Comment on GitLab` publishes right away, as before.
**`Save`** keeps the remark **pending**, locally: you review a merge request file by file, and
sending them one at a time showers the author with notifications while freezing remarks you would
have dropped three files later. A pending comment can be **edited** and **deleted** as long as it
has not gone out; it shows under its line with an amber border and the words **"Waiting to be
sent"** — rendering it like a published comment would make the work look done. The
**`Send the comments (n)`** button in the header publishes them all at once; it is also what
reminds you that work is waiting, without which you close the merge request leaving your remarks
behind.

⚠ **Sending asks first and says how many are going out** — publishing notifies the author — and
**whatever fails stays pending**, with its reason: a network error on the third comment must not
take the first two, nor the half hour of review, with it. The **position** (file, line, SHAs) is
resolved **at send time**, exactly as for a direct comment: a merge request that moved meanwhile
does not receive remarks pinned to a state of the code that no longer exists.

In the tree, folders **carrying a change are expanded by default** and the others are collapsed — but
**whatever you open or close by hand is remembered** for the visit: clicking a file no longer collapses
the folder it sits in. The tree starts from the default rule again on the next diff.

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

**“The AI may ask me questions” applies to all three flavours.** Coding in a repository,
**out-of-repo coding** and **exploration**: ticked, the option lets the agent stop in front of a
decision it cannot settle instead of guessing. An exploration hesitates just like a coding session —
“which of the three services do you mean?” beats a summary about the wrong one — and out of a
repository it matters most: the agent works **in place**, with no branch and no commit to re-read.

What happens then, in all three cases: the session goes **into waiting** (neither finished nor
failed), the questions appear **on its card**, you answer, and the work **resumes in the same
session** — the agent keeps what it read. Two differences worth knowing: an **exploration** asks
**once** for all its repositories (they share the session), whereas **out of a repository** each
**folder** has its own, and answering one **does not make the others work again**. ⚠ While a
question stands, **nothing has been done**: no summary saved for an exploration, no file touched
out of a repository.

**A session stopped on a question raises its own todo.** When the AI interrupts itself to ask
something, a **high-priority todo** is created automatically — "Reply to the AI — session #12",
with the projects concerned in its note. The queue is free, nothing will restart, and the
notification was dismissed long ago: the todo stays in sight, in *Notes* and in the morning
brief. **Answering closes it** (ticked, not deleted: what you did with your day is re-read in
"Done").

⚠ On a **multi-repository** session it only closes when **no** project is waiting any more:
answering the first does not settle the work, and a todo ticked too early makes you forget the
other four. It stays an **ordinary** todo — you can tick, edit or delete it: the tool raises it
and closes it, it does not take over what you did with it.

**Duplicate a session.** On the card, next to *Edit*, a button opens the form **pre-filled** from
that session — **coding, exploration and out-of-repo coding**. There is no identifier behind it:
**saving creates a new session** instead of overwriting the one you copied. This is the gesture of
running the same instruction on another repository, or starting from a past session with two words
changed. Everything is copied — prompt, label, commit message, repositories or folders, base
branch, options, verifier — except the following, stated under the prompt:
- the **agent session** is never resumed: a copy starts a fresh conversation, not the continuation
  of the original one;
- in **coding**, the **working branch** is shifted (`feature/x` → `feature/x-2`, then `-3` if that
  one is taken) because two sessions on the same branch would tread on each other, the second
  committing on top of the first's work. In **exploration**, the branch is the one you **read**: it
  is copied as is, shifting it would point at a branch that does not exist;
- the **images** attached to the original are not copied; their number is stated.

The buttons are those of creating a session of that flavour — `Save` for coding and exploration,
`Run` alongside `Create without running` for out-of-repo: a button that changed meaning depending
on whether you create or copy would be a trap. Everything stays editable before saving: it is a
proposal, not a carbon copy.

**A label, optional.** A short title when creating a session — coding, out-of-repo or exploration.
A list is otherwise read through its prompt, three folded lines whose first words look alike from one
session to the next; the label says **what it is about** where the prompt says **what to do**. It
shows at the top of the card, takes part in the search, and can be changed later. Left empty, the
card is exactly what it was.

⚠ **The label is NOT sent to the AI**, and is not used as a commit message. It is a filing title,
written for the human scanning the list — not an instruction. Slipping it into the prompt would
change what the agent produces without anyone asking, and two sessions with the same prompt but
different labels would stop producing the same thing. A test keeps that door shut, including against
a module that would start reading it.

**The chosen commit message applies to EVERY commit of the session.** When the *Commit message*
field is filled it is the rule: the first run, every **follow-up**, the resume after questions and
the convergence passes all commit under that message. It is what anyone who prefixes their commits
expects — a ticket key, a team convention: a follow-up falling back on its own first line would
break the rule exactly when nobody re-reads it, and the offending commit is already pushed. Left
empty nothing changes: each gesture keeps its own default, which **says what it just did** (the
prompt's first line for the run, the follow-up's own for a follow-up).

And when it is filled in **after the fact** — you run a session, you see a badly named commit, you
fill the field and relaunch — the **last commit is renamed**: the AI finds everything already done
and commits nothing, so without this the field you just filled would have nothing left to name. Only
the message changes; the commit's contents are untouched and no extra commit appears. ⚠ **Unless the
branch is already on `origin`**: renaming a published commit would rewrite a history the forge — and
possibly a merge request, and possibly a colleague — already has. The job log says so, rather than
staying silent or doing it behind your back.

**A follow-up written while it runs, sent when you decide.** The remark comes while you read what the
agent is doing — not twenty minutes later, once the session is over and your mind is elsewhere. On a
running session, **`Prepare a follow-up`** opens the same form as **`Send a follow-up`**, with **`Save the
follow-up`** instead of `Send`: the text stays **on the card**, under your eyes, for as long as it has
not gone out. You can **reword** it, **delete** it (clearing the text is enough), and **`Send the
follow-up`** fires it in one click once the session is over. Applies to coding, out-of-repo and
exploration sessions.

**A screenshot can be pasted into a follow-up.** The follow-up form accepts images, just like the
creation one: the **`Add a screenshot`** button, or simply **Ctrl+V** in the field. Thumbnails show
what will be sent, and can be removed one by one. Works for **coding**, **exploration** and
**out-of-repo coding** — not for the free question, which has no attachments at all.
The screenshot belongs to **that request**: the follow-up prompt gets the screenshots of the
initial instruction plus the one you just pasted, but **not** those of an earlier follow-up — they
illustrated something else, and a prompt announcing “here are the screenshots” while showing the
wrong one sends the agent off course.
⚠ **A *saved* follow-up (draft) only keeps the text** — that is what the database stores. The
screenshots stay attached to the open form and go out with the follow-up itself; a message says so
when you save, rather than making them vanish silently.

**Or it goes out by itself, if you ask.** A checkbox **`Send it automatically when the session
finishes`**, under the text, arms the follow-up: it leaves as soon as the session has finished
working, with nothing for you to come back to. The card says so — **`Follow-up armed`** instead of
**`Follow-up waiting`** — and it goes out **once only**: the text is removed and the box disarmed
before launching, otherwise the follow-up pass would find the same instruction on finishing and the
session would loop. Nothing goes out after a **failure** either, nor on a session **waiting for an
answer**.

⚠ **Unticked, the box does nothing — and that is the default.** The send button stays **disabled** for
as long as the session runs, and an unarmed follow-up waits for your gesture indefinitely. Sending
automatically is a choice made while writing the remark, never a side effect: the column is read only
by the function that decides to send, and no module talking to the agent knows about it — two tests
keep that door shut. If you picked a **verifier**, it waits for the automatic follow-up to finish: a
verdict on code that is about to change again would be worth nothing.

**Running again asks first.** On a session that has already run, `Run again` opens a confirmation
that says **what is about to happen**: the AI starts again from the **initial prompt**, on top of the
work already produced, and anything asked since — follow-ups, answers to questions — is not replayed.
The button sits next to the ones you use all the time, and one click too many costs a whole session.
The **very first** run stays a single click: there is nothing to protect. The same applies to the
`Run again` of one particular project.

**Create now, run later.** All three session types offer **`Create without running`** next to
**`Create and run`**: you prepare the prompt and the targets, and launch when you want.

**Verify afterwards, without thinking about it.** An optional **`Verify afterwards`** field when
creating a coding session: the chosen verifier runs **by itself, once, at the end** — after
convergence if you converge, after the coding run otherwise. You launch the session in the morning
and find a verdict, not one more box to tick.

Only verifiers that **cover every repository** in the session are offered: a partial green would say
nothing about half the batch, which is worse than no verdict at all. The list is rebuilt when you
change projects.

A verifier reads what the **forge exposes**, so it needs pushed code. Picking a verifier **ticks
auto-push** and says so; unticking auto-push **drops the verifier**. The server applies the same rule
on its side — a screen is not a safeguard, and the API is callable without it.

Three refusals, silent for the session but **written in its log**: nothing was pushed, the verifier
no longer covers every repository, or another verification is already running on them. And a failure
to start the verification **does not fail the session**: the code is written and pushed, announcing
an error would misrepresent what happened.

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
  **`Send a follow-up`** continues the session on the existing branches, **without starting over** — a fix,
  a clarification, a question about what was just done: the AI keeps
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
- **Every iteration is kept.** A session iterates (launch, `Send a follow-up`, answers to questions,
  convergence passes): each pass keeps **the prompt actually sent** and **the matching AI output**. An
  From the second pass on, `AI output` lists the iterations **in a column on the left** — each with its
  number, kind, date and **the request that produced it** — and shows the one you pick **on the right**.
  Nobody remembers an iteration by its number; you remember what you asked: a **search field** at the top
  of the column therefore searches those requests and **hides** the iterations that do not match, losing
  none of them — and the filter survives switching iterations. Re-reading an answer without knowing which
  request it answered teaches nothing: the two are therefore shown together. A single iteration shows no
  column — there is nothing to pick. Applies to **out-of-repo coding** too, folder by folder.
  **Pin and name.** Past a few passes, neither the number nor the date says what happened in
  them. Every iteration therefore carries two gestures: a **tag** that lifts it to the **top of
  the column** (the number stays visible, so the chronology still reads), and a **name** typed in
  place — Enter confirms, Escape gives up. The name shows in bold under the header and **joins
  the search**, like the request does. ⚠ Neither the tag nor the name **goes to the AI**: it is
  filing, written for the human scanning the column — the same rule as a session's label. An
  iteration **predating the pass history** has no row in the database: it can be neither named
  nor pinned, and the screen says so rather than offering a gesture with no effect.
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
  **`Send a follow-up`**: a fresh pass over the same folders that **resumes each one's session**, so the AI
  keeps all the context of what it has just produced. An out-of-repo session is **editable** afterwards
  (prompt, folders, session identifier), like a repository session.
  **Re-runs can be targeted**: every folder has its own **`Run again`**, and the card offers
  **`Re-run the failed folders`** when there are any — on five folders where one broke, re-running
  everything would cost four agent passes for nothing. Like any re-run, it asks first. A session's
  error is **cleared for good** (the cross on the error box), and does not come back on the next
  refresh. ⚠ **No safety net**: the agent modifies
  the files in place, without a backup; on a git repository you can review and undo yourself (`git diff` /
  `git checkout`), on a non-git folder there is **no undo** — a warning says so. (Dedicated sub-tab, between
  *Coding* and *Exploration*.)
- **Exploration** — **read-only**: you ask a question about one or several projects, the AI explores the
  code and writes **a single synthesis answer** saved as `.md`, readable at any time through `View answer`.
  No diff, no merge. A **follow-up question resumes the same agent session** — as for coding — instead of
  re-injecting its previous answer: the AI remembers its exploration instead of re-reading a summary of it.
  The repositories are reset afterwards: **no modification survives**. Each exploration also exposes
  **“Resume in terminal”** so you can continue the conversation yourself. **Every question is kept**: a
  follow-up question overwrites the answer file, but the pass is archived — `View answer` lines the
  iterations up on the left, with the search over the questions asked, and replays the one you pick on
  the right with the answer it got.
- **Free question** — the same thing, **with no repository at all**. You ask the AI something — a notion to
  dig into, two options to compare, a plan to challenge — and the answer is kept here. Nothing on the
  machine is read or changed: no clone, no folder, none of your files. An optional **label** files the
  study away (“Concurrency”, “Payment architecture”), and the search covers the question and the label.
  As everywhere else, a **follow-up question resumes the same agent session** — which is what makes a
  five-question study possible instead of one — every pass is **archived** with its question, and
  **“Resume in terminal”** hands the thread back so you can continue it yourself. The answer exports
  (HTML, Word, PDF) like an exploration's. A free question reserves no repository: it never blocks a
  review or a coding session, and nothing blocks it.
  (Dedicated sub-tab, after *Exploration*.)

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
4 bis. **AI sessions waiting** — three numbers, one and the same oversight: the work is done,
   only a gesture is missing. A session **never run** will produce nothing; a project **committed
   but not pushed** exists for nobody; a branch **pushed without a merge request** will never be
   reviewed. Numbers rather than lists — the detail lives in *AI Dev*, and three more lines would
   stop the brief being a brief. A branch that **already** has an open MR (even one created
   elsewhere) does not count: offering to open a second one would be worse than saying nothing.
4. **Failed verifications** — the last red verdict per batch or per MR. **Stale** verdicts are left out:
   the branch has moved, the verdict covers code that is no longer there, and showing it would send you to
   fix a problem that may already be fixed.
5. **MRs to review** — the ones that **arrived since yesterday**, not the whole queue (which has its own
   tab and its own badge).
6. **Dormant MRs** — reviewed more than **N days** ago (adjustable, 5 by default) and still open: the work
   is done, the decision is missing.
7. **Activity since yesterday** — one line, three numbers. Deliberately poor: it is context, not a task;
   the detail lives in *Stats*.

**Dismissing a line that comes back every morning.** The brief recomputes everything each time it opens:
a fact that stays true reappears indefinitely, even once handled elsewhere — a red verification you have
already been through eventually teaches you to stop reading the section. A **cross** on hover dismisses the
line: it leaves the brief and does not come back. Applies to verifications, waiting sessions and merge
requests.

⚠ **You dismiss a finding, not a subject.** The cross remembers the object you saw — *this verdict*, *that
merge request*: a **new** verification of the same set carries another identifier and will reappear. That
is deliberate — otherwise a real regression would stay invisible forever. Nothing is deleted (the verdict
keeps its page in *Reviews*), the brief shows at the bottom **how many** lines it is hiding, and **`Show
them again`** brings them all back in one click. A dismissed line makes the **next one move up**: sections
cap at eight, and a section that shrinks with every gesture would end up lying about what is left to do.

Everything is computed **in SQL, with no AI and no network**: the brief appears instantly, before the first
coffee, and costs nothing. A summary written by an agent was tempting; it would have charged one call every
morning to rephrase facts that already read fine.

**Landing.** On the **first opening of the day**, the app opens here rather than on the tab you left. Once
per calendar day, never twice — otherwise every page reload would drag back to the brief someone who was
reading a report. Switch it off in *Settings → General*.

#### Todos
A flat list, sorted **by priority first, then in the order you give it**. Two different questions, each
keeping its answer: priority says **what is pressing**, your order says **in which order you work through
it**. "To do" reorders with the mouse (grip on the left, drag and drop) or with the keyboard (two arrows
per row — dragging is neither announceable nor reliable with a keyboard or a finger), and the order is
**saved**: an order that does not survive a reload is not an order.

⚠ **Reordering only happens inside a priority.** Taking a todo into another group would bring it straight
back, and a gesture that does not land is worse than no gesture: the arrows switch off at group
boundaries, and dragging does not cross them. To change group you change the **priority** — a different
gesture, and an explicit one. The **due date** no longer sorts anything here: it stays visible and keeps
feeding the **morning brief** and the **reminders**. On the day of the update your list keeps exactly the
order it had. The **Done** and **Archived** views keep their chronological order: you do not arrange your
drawer.

- **Inline add** at the top of the list: you type, Enter, it exists — normal priority, no date. A new todo
  goes **to the top**, where you just typed it; looking for it at the bottom of a list of thirty would be
  absurd.
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
- **Pasting a screenshot** (Ctrl+V) into the editor **inserts it at the caret**, on its own line, and
  the preview shows it right away. The image goes **to disk** (`data/notes/<page>/`) and the page only
  keeps a link: putting the screenshot into the content as base64 would swell the row by several
  megabytes, resent in full on every autosave — that is, about every second while you write.
- **Pin** keeps a page at the top of the list.
- **Export** downloads the page as `.md`, under a name **slugified** from the title. ⚠ Screenshots are
  referenced by their **address inside Mergerie**: the `.md` read elsewhere will show the text, not the
  images.
- **Delete** asks for confirmation — it is the only irreversible action of the tab. The page's
  **screenshots go with it**, files included.

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
- **Compare** — two repositories, **one branch or tag on each side**, and the question “what exists here
  and not there?” (comparing two released versions means comparing two tags; both live in the same
  searchable list, marked, because a branch and a tag may carry the same name).
  This is **not** a `git diff`: the two repositories need no common history (a service extracted into its
  own repository, a fork gone its own way). The tool reads both **trees** and sorts every file into one of
  three columns: **left only**, **on both sides but different** (same path, different content), **right
  only**. **Identical** files are not listed — only counted, so the screen shows what is missing rather
  than what is fine. **Clicking a file shows its differences**: both versions as a unified diff, with a
  reminder of which side is the red one and which is the green one. A file present on one side only is
  read against the void — all of its content as removals (or additions), which is precisely what the
  other side is missing. A binary file says so instead of dumping its bytes, and a file over one megabyte
  is not loaded — stated, not hidden. A **filter** searches all three columns at once. Both sides may point at the **same
  repository** on two branches. Beyond 2,000 files per column the lists are **truncated and the truncation
  is announced** — never silent.
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
  those that **exited with an error** — in **red**. A container **you stopped** does not count: neither a
  clean exit (code 0: you stopped it yourself, or a job finished its work) nor one that `docker stop` /
  `docker compose stop` had to kill by signal — an untrapped SIGTERM (**143**), then SIGKILL once the grace
  period runs out (**137**), which is the fate of many perfectly healthy images. Counting those in red set
  the alarm off on every deliberate stop, and an alarm that always rings stops being read; they are still
  named in the tooltip and in the *Exited* filter. Two exceptions, kept: a 137 caused by **running out of
  memory** (OOM, read from `docker inspect`) stays red — same code, opposite meaning — and so do the signals
  that really do mean a crash (**139** SIGSEGV, **134** SIGABRT). An unreadable exit code stays out of the
  alarm — we do not cry wolf on a guess. Plus the **number of
  unhealthy containers** in **orange**, right in the menu — visible at startup and refreshed
  **automatically every 30 s** (and every time the tab is opened) — so a container flipping to *restarting*
  shows up in the menu title **even when you are not on the Docker tab**. The poll is light (a single
  `docker ps -a`) and pauses when the browser tab is hidden.
- If the **Docker daemon is unreachable** (Docker Desktop off, socket missing) or if the **CLI is not in the
  server's PATH**, an **actionable** message explains it (pointing at `DOCKER_BIN` in the `.env` if needed)
  — like the certificate / token errors.

### Jenkins
See **where your jobs stand** and **run them**, without leaving the tool or opening another
page. This is not an administration console: no job configuration, no agent management — what
Jenkins already does well, and which there is no point redoing.

- **What is shown.** Every job your account can see, flattened, **from the latest run to the
  oldest**: in a list of three hundred jobs, what just ran is what you came for — not what
  starts with "a". The **never run** ones close the list.
- **Every line answers four questions**: *what* (the **path** `shop/api-deploy-prod`, since
  several projects have a "build" job, and the **number** of the last build), *in what state*
  (a **coloured dot** *and* the matching word — *Success*, *Failed*, *Unstable*, *Never run*,
  *Disabled* —, as a colour on its own does not read the same way for everyone; a **running**
  job has a pulsing dot), *when* (the **date** of the last run, with the relative age in the
  tooltip), *by whom and on what* (the **author** of the run — or its nature: *by the
  scheduler*, *on a push*, *by an upstream job* —, the **branch or tag** that was built, and **every parameter of the last
  run** with its value, as **name/value chips on their own line**: mixed in with the status, the
  date and the author — all grey, all separated by middle dots — you read a sentence instead of
  pairs. The question you ask while reading the list is precisely "what did it go out with?",
  and answering half of it would send you to the job's page. All of it arrives in **the same request** as the list: showing it does not cost one more
  call.

- **Parameters that recur across jobs carry a COLOUR.** From **three jobs** on, a parameter
  counts as frequent and gets a tint: you find `ENV` from one line to the next out of the corner
  of your eye, without the list stiffening into columns full of gaps. The tint comes from the
  **name**, not from its rank, so it does not move when a job appears or disappears. It **helps,
  it replaces nothing** — the name stays written in the chip. Three rather than two: at two, a
  coincidence between two jobs would colour it for everyone; what belongs to a single job stays
  neutral.
- **And you can filter on their values.** One dropdown per frequent parameter, above the jobs:
  "what went to prod?", "what is running on 2.4?". A job that does **not** carry the parameter is
  dropped as soon as you filter on it — it does not answer the question asked. Filters are
  computed on **all** jobs, not on those left after filtering: otherwise a filter would vanish
  the moment you used it.
- **A filter that is of no use can be put away.** A cross on hover takes it out of the bar — not
  every frequent parameter is worth searching on — and its **value is cleared at the same time**:
  an invisible filter that keeps filtering is the surest way to spend ten minutes wondering why
  the list is empty. Those put away are counted next to the bar and found again in the **same
  window as hidden folders**, one click away from coming back.

  ⚠ A **password** parameter is never displayed — Jenkins returns an encrypted form of it,
  unreadable, and a secret has no business in a list — nor is an empty value, which teaches
  nothing and pushes the others off the screen.
- **Folders sit on top, as a filter.** One checkbox per folder with its job count,
  **`Tick all` / `Untick all`**, and a **search** to find one folder among fifty (it hides
  checkboxes without ever unticking any: filtering what you look at must not change what you
  chose to see — and the two buttons then only affect what is visible). The choice is
  **remembered**. ⚠ It is the **unticked** folders that are stored: a folder your team creates
  tomorrow therefore shows up on its own. The opposite would have kept it invisible until
  someone thought of going to tick it.
- **Putting away a folder that is not your concern.** Unticking says "not now"; the **cross**
  on a checkbox's hover says "this folder is not my subject" and **takes it out of the filter
  list**, which becomes readable again — on an installation with forty folders, a row of boxes
  you never tick is noise you re-read every morning. Its jobs leave with it (hiding it while
  keeping them would give you jobs you can no longer filter). Hidden ones stay **listed in
  small type under the boxes**, and one click on `+ name` brings back the one you want: a
  filter whose removals you cannot see becomes a mystery three weeks later. The folder's ticked
  state is **kept** while it is hidden.
- **Finding a job.** A **search** — mandatory here: a company installation lines up hundreds of
  jobs. It matches the **whole path**, so "shop" brings back a whole project. A checkbox,
  **`Only what is not fine`**, keeps failures, unstable results and what is running.
- **Refreshed at the pace you choose, and only while you are looking.** *Settings → Jenkins*
  holds the setting — **every N minutes, 0 = never**, one minute by default, capped at an hour.
  It lives in the **database**, like the merge request and Jira ones: it is a setting of the
  tool, not of the browser, and it holds wherever you look from. Polling only runs while the
  Jenkins tab is **open** *and* the window **visible**: behind a hidden tab it would cost a
  shared server without teaching anyone anything. The **`Do not refresh on its own`** checkbox is
  a **local, immediate pause** — it wins without touching the underlying setting — and
  **`Refresh`** asks again by hand. A background refresh does not make the list
  blink, and a hiccuping network does not wipe the screen: the previous one stays. The menu
  **carries no badge** — that would mean querying Jenkins on every application start, even when
  you are not on the tab.
- **The menu carries a badge: how many jobs ran today.** The question you ask walking past the
  tab is "did anything move this morning?". It is filled once at startup, then kept current by
  the tab's own refresh — Jenkins is not queried from the other tabs. Nothing today means no
  badge at all: a zero in a menu teaches nothing. A job that ran five times counts once — the
  list only carries each job's last build, so the tooltip says "jobs", not "runs".
- **Told when what YOU started is done.** A desktop notification when a job you started from
  Mergerie finishes, with its verdict; one click opens its page. Yours only: being told about
  the team's nightly build would be noise, and you would turn the whole thing off within two
  days. Can be switched off in *Settings → Notifications*. The wait survives closing the tab —
  that is precisely the point.
- **A job's page** (`Open`), as **three separated blocks** — the launch form, the history, the
  details of the selected run. Each is a card on a recessed background: the boundary is **seen**
  rather than inferred. The history is a real list (rules between rows, the date on its own line
  so verdicts line up), the selected run carries an **accent bar** and a bold number — not just a
  slightly different grey —, and the filters stay **in a header** while you scroll. Only the body
  scrolls: **`Run`** no longer sinks under ten runs, and the details on the right **follow you
  down** — comparing "what I am about to launch" with "what went out last time" is what this
  window is for. In two columns: on the **left** the history of the last ten runs
  (verdict, date, duration) — each with its **`Console`** button, the most frequent gesture, and
  **the parameters it went out with** as pills under the line. Two green lines from the same
  afternoon are told apart by nothing else. The **tint comes from the parameter's name**, the
  same as in the job list: `ENV` keeps its colour from one screen to the next, and the eye
  follows a column down without reading. In a history every parameter comes back on every line,
  so they are all tinted —, on the **right** the details of the one you select: when, how long, **by whom**, on **which
  branch**, and above all **with which parameters and which values** it went out. The most
  recent one is selected by default. The **console** opens with one button — bounded to the last
  characters, **scrolled to the bottom** where the error is, and **wrapped**: having to scroll
  sideways to read an error you were looking for would amount to not showing it.
- **Find the run you have in mind, then start from its values.** "When did this last go to
  production, and with which version?" — above the history, one filter per parameter the runs
  carry, and on every matching run a **`Reuse`** button that **fills the launch form** with its
  values, **without sending anything**: starting from an old run is almost always about changing
  one thing in it.
  - The filters **suggest** the values they have seen, they do not **confine** you to them: what
    is on screen is only what has been loaded, and a value missing from the list is still
    perfectly valid — it can be **typed in**. Same for the filters above the job list.
  - And filtering **does not stop at the last ten**: the first time a filter is set, the job's
    history is **fetched deeper, once**, so a run from six weeks ago is found rather than
    answering "no matching run" about something that did happen. The count shown (`— 2 of 200`)
    says what the search covered.
  - A value that **no longer exists** among the job's choices is **added back and flagged**
    rather than dropped: a field silently left on something else would launch with a value
    nobody chose.
- **A link to Jenkins** on every line (and on every run in the page) opens the job in a **new
  tab**: what Mergerie does not show — the configuration, the artifacts, the tests — stays one
  click away.
- **Running.** ⚠ Always **with a confirmation**, and the question **names the job**: that is
  what lets you notice you picked the wrong line. A Jenkins job is not a page you open — it
  deploys, it publishes, it runs on a shared machine, and it cannot be cancelled from here.
- **The lists Jenkins COMPUTES are fetched where they exist.** *Git Parameter* (the repo's
  branches and tags), *Extended Choice*, *Active Choices*: these plugins do not declare their
  values, they compute them while rendering their page — so the API carries no trace of them.
  Mergerie then reads Jenkins' **build form**, the page you get by clicking *Build with
  Parameters*, and **only for the parameters the API said nothing about** (what it declares
  wins). A **multiple choice** stays multiple, and the values go out comma-separated — the shape
  those plugins expect.
- ⚠ **If the page does not answer either**, the field is left **empty** and says so, with the
  link to go and run it from Jenkins. That happens when the plugin fails inside its own page too
  and returns its error message ("Could not get Environment from ENV Param"): prefilling the
  field with that sentence would have sent it as the value.

- **A parameterised job never starts from the list.** Its button reads **`Run…`** — the
  ellipsis announces a form, and the tooltip says how many parameters it expects. It opens the
  job's **page**: the **`Parameters`** section is filled in there (a boolean is ticked, a choice
  is chosen, the rest is typed), then the **`Run`** at the bottom of the page sends it, with the
  usual confirmation. **The values shown are the job's own**: those are what will be sent if you
  leave them alone. Going with default values you have not seen is how the wrong version reaches
  the wrong environment.
- **`Run again`: the same job, the same values.** The most frequent gesture after a failure.
  In the **list** it goes out with the parameters of the **last run**; in the job's **page**,
  every run in the history has its own button and goes out with **its** values — which is what
  you want after reading the console of a failed build. The confirmation **shows the values**
  that are about to be sent: "run again" says nothing if you cannot see with what. A job with no
  parameter has no such button: that would be `Run`.
- ⚠ **A secret parameter cannot be sent back.** Jenkins never returns its value (and Mergerie
  never displays it): on a re-run, Jenkins will use its default. The confirmation says so and
  counts them, rather than letting a job go out without its password and nobody noticing.
- **A disabled job has no `Run` button**: offering what Jenkins will refuse is a promise you
  cannot keep.

**Connection** — *Settings → Jenkins*: the root URL, your **user** and an **API token** (your
Jenkins profile → *Configure* → *API Token*). Jenkins authenticates the **pair**: the token
alone is not enough. **`Test Jenkins`** returns the **account name** the server sees — a URL
that answers does not prove the token is right. The token is stored locally and **masked**;
saving the settings again without touching it does not erase it.

### Links
Work links have a **structure** a browser's bookmarks cannot express: the same service exists in
local, dev, staging and production. A folder tree scatters it across four places; a **grid** shows
it at once — services as rows, environments as columns.

Two shapes, because there are two realities. Whatever has no environment dimension (Confluence, a
doc, a tool) stays a **free link**, flat, found by its tags.

#### The top bar
**One search field**, and it covers **both halves of the screen** — the grid and the free links. It
matches the service's name, its tags, its repository, **each address's name** and the URLs
themselves: searching `payment errors` finds the cell that holds it. Under a search, a cell **shows only what
matches** — displaying its eight addresses for one hit would make you re-read the cell instead of
reading the answer. A query can mix both levels: `logs apache` takes `logs` from the row and `apache`
from the address, and only the apache addresses show; `logs` alone, conversely, lets the whole row
through — the row is what you asked for. Searching `kibana` or a fragment of a URL is enough; you do not have to decide which half to look
in before knowing where the answer is. When the grid has nothing but the free links do, the message
says so and points you down, instead of announcing “nothing matches” above results that are right
there.

Below the bar, **the filters, labelled and always on screen** — they are used every day:

- **Environments**, as coloured chips: they hide **columns**. From “everything shown”, one click
  means *that one* — you set out to work on an environment; after that, clicks add and remove.
  Removing the last one goes back to all, since a grid with no column shows nothing. A service with
  no address in the kept columns **drops out of the list**: filtering on production to see ten empty
  rows does not show production, it shows what production lacks.
- **Services**, as chips too: opening a menu to see what you are filtering on is one click too many
  on an everyday gesture. Past a dozen, a field appears to **sift** them — it hides chips without
  ever unticking one, and a count reminds you of the selected ones out of sight.
- **Tags**, each with **its count**: a row of chips without numbers does not say where the substance is.

All three **survive a reload**, and `Show everything` releases them in one click.

Next to it: **`+ Add`** (a plain link, a service, an environment) and a **`⋯`** menu for bookmark
import. Those gestures happen once in the tool's lifetime; finding a link happens every day, and
that is what gets the space.

#### The grid
- **Rows are services**, pinned first then alphabetical. Each row carries the name, its **tags**,
  and the **linked Mergerie repository** when there is one. `Pin to the top of the grid` is a
  checkbox on the service's own form: that is how you raise what you open every day.
- **Columns are environments**, in the order you give them, each with its own header **colour**
  (production in red invites a second thought before clicking). **The column's name opens its settings** —
  rename, recolour, delete; and on hover, two arrows **move it** one step. Deleting says **how many
  addresses go with it**.
- **A cell is one or several addresses, written out.** We could have guessed the staging address
  from the dev one by swapping a piece of domain; that is exactly the magic that one day sends you
  to the wrong environment without a word. An empty cell shows a `+`, a filled one a **pencil** on
  hover: you type **in the cell**, Enter saves, Esc cancels, and **clearing everything clears the
  cell** — no dialog to paste an address.
- **Several addresses in the same place**, because that is the real case: a production Kibana is as
  many addresses as it has saved filters. Each carries a **name** (“payment errors”, “API latency”),
  without which the second would be indistinguishable from the first. **How many a cell shows is judged on the
  ROW**: as long as its fullest cell stays under five addresses, everything is displayed — the height
  stays reasonable and nothing is hidden. Past that, the cell shows two and a `+N` expands in place;
  **its tooltip names what it hides**, so you never expand just to find out whether it was worth it.
  And `Expand all`, in the filter bar, opens every cell at once — the choice is **remembered**. The pencil opens **one row per address**, and the cell stretches while you type. The
  **palette** finds each by its name, and frecency is counted per address: you always open the same
  two out of ten.
- **Filter by tag** above the grid: a service often belongs to two families at once (*backend* and
  *payment*), which a folder tree would force it to choose between.
- Only **`http` or `https`** addresses are accepted, here as everywhere in this tab: these links
  open in one click from the application.

**Creating a service means setting its addresses too.** The form lists **one row per environment**,
all optional. Saving used to produce an empty row you then had to find in the grid to fill cell by
cell; a service now comes into being usable, and the screen **scrolls to its row** and highlights it
for a second — an alphabetical grid drops it anywhere.

#### Free links
A list under the grid: label, URL, tags, **folder**. Add and edit in place, and the search at the top
filters them along with everything else. This is where imported bookmarks land.

The **Folder** field offers the existing folders **and accepts new ones** — picking from a list would
forbid creating one, a bare field would make you retype a path you already have. A slash creates the
sub-folder on the way (`doc/oncall/2026`), and intermediate levels are offered even when no link sits
directly in them. Leaving it empty files the link at the root.

Past a dozen, it **groups by folder**, reproducing **the tree as it was in the browser** — full
path, depth included — with a count for each. Grouping on the last segment alone made `seres/prod`
and `logs/prod` merge into a single “prod”: the tool was destroying a structure the browser
preserves. **The first level is open, the ones below are not**: expanding
five levels gives back the flat list you were trying to leave, collapsing everything makes you open
ten folders to find one link. `Expand all` and `Collapse all` say explicitly one or the other;
clicking the active one again returns to the first level, and the choice is remembered. Every folder
that holds others carries **its own** fold button, to open or close that branch without touching the
rest — a glance, not a preference: that one is not remembered. Under a search or a tag it goes back to flat: the filter IS the
arrangement, and two levels of sorting at once hide what you just asked for.

**Wiping the list.** The `⋯` menu carries `Delete every free link` — the escape hatch from a bad
import: you dump two hundred in, realise it was not what you wanted, and taking them back one by one
would be two hundred confirmations. The confirmation **states the count** (“delete all links?” does
not say whether there are three or two hundred) and reminds you that **the grid is left alone**. The
button does not appear when there is nothing to delete.

**Filing them into a service.** This is the gesture that follows an import: two hundred addresses
arrive flat and have to be filed. Every row carries a `File` button; to handle several at once,
`Select` reveals the checkboxes — they are not there permanently, the operation is rare and everyday
noise is expensive. `Select all` then ticks **whatever the filter left**: you sift (“confluence”),
tick everything, file, and start again. A link ticked and then filtered out of sight **leaves the
selection** — otherwise it would go along with the others without anything saying so.

Either way, the same dialog:

- **An existing service or a new one**, your choice, in a searchable picker. Only being able to
  create forced you to file everything in one go; you can now file three links today and two more
  tomorrow, into the same service.
- **An environment**, with a `File everything into` that sets the same one on every row — redoing it
  row by row across twelve links is exactly what makes people give up. The mapping stays
  **explicit**: guessing “dev” from a URL containing `-dev` would work nine times out of ten, and the
  tenth would put a production address in the development column.
- **The link's label becomes the address's name.** “payment errors” filed into Kibana × production
  keeps its name — that is exactly what tells one address from another in the same place, and it was
  already written.

Addresses are **appended** to the cell, they do not replace it; two links filed into the same place
both fit. The free link then disappears: keeping it would make two entries for the same address.

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

**The import reads your tree.** A folder whose children carry environment names (`dev`, `staging`,
`preprod`, `prod`…) is not describing filing: it is describing a **grid**. The preview builds it and
shows it to you **before creating anything** — a table with the number of addresses per cell. You
refuse it by unticking a box, and everything comes back as free links.

Two gestures are available there, because the detection reads folder names and cannot know
everything: **renaming a row** in place (a folder's name is not always the one you would give the
service), and **merging several rows into one service** — tick them, click `Merge into one service`,
and their cells join environment by environment, each address keeping its name.

Two shapes, told apart by one measurement: *do the labels repeat from one environment to the next?*

- **They repeat** — `bo`, `bp`, `po`, `api` in each of your five environments: that is the same
  thing seen in five places, so **one row per label**.
- **They do not repeat** — a Kibana and its saved queries, specific to each environment: **one row
  for the folder**, and the labels become the addresses' names.

Three details that avoid absurd grids: two spellings of one environment (`pprod` and `preprod`) give
**a single column**; a numbered environment (`recette2`) stays distinct; and a sub-folder **below**
the environment becomes its own row (`logs/prod/keycloak` → a `logs · keycloak` service), without
which one cell would hold twenty-four addresses. Columns are ordered along the deployment chain, not
along the file.

Nothing is guessed about your domain: the only clue looked for is an **environment name**, from a
deliberately wide list in French and English. A neighbouring folder that is not one
(`seres/keycloak`) is left alone and its links stay free.

**The rest of the preview is folded by folder, and nothing is ticked.** One folder per row, with its count and
its checkbox; you unfold the one you want, tick it, and import twelve links instead of two hundred.
Choosing what comes in costs ten seconds; sorting out what came in costs half an hour. The **browsers' root folders**
(“Bookmarks bar”, “Other bookmarks”, “Barre de favoris”…) **do not become tags**: present on every
single link, they filtered nothing while taking the first spot ahead of the ones that say something.
It is a list of known names, not “whatever folder comes first” — an export may well start with a
real folder, and dropping it would erase the only filing information there was.

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
Sub-tabs, **in the order of the journey** — connect, choose the code, tune the review, tune the
tool, the optional integrations, the test bench:

**Git** (the **GitLab connection** — URL + access token, with
*Test the connection* —, the **GitHub connection** — URL (empty = github.com, otherwise GitHub Enterprise)
+ token, with *Test GitHub* —, the **clone folder**, and the **git command palette** of the *Git → Git
commands* tab: add/edit/delete commands as *name + fixed command*). It comes **first**, and it is the one
that opens on a fresh install: without a token no other setting is worth anything ·
**Repositories**
(added one by one or in bulk **from GitLab** or **from GitHub** — each repository carries a forge badge, and
the same path can exist on both —, plus the **local directories** — a folder on your machine holding one
subfolder per git project, which feeds the *Git → Navigate* tab and *Out-of-repo coding*; the displayed
count “n git projects out of m folders” confirms at a glance that you pointed at the right level of the
tree) ·
**Merge Request** (automatic refresh, convergence, prompt templates — the review **skill** is written in the template) ·
**Specific review rules** (criteria added to the prompt when the branch name contains a given
fragment **or when the diff touches a path** — a glob such as `**/migrations/**`, `*.sql`, which is more
precise; a rule on a path can carry a **“risk” badge** shown on the merge requests concerned, computed
**without AI** just from the diff's paths, to see at a glance which one to review first) ·
**Verifiers** (your test commands, and the repositories each of them can test — see *Objective verification*
below; the page shows **the list** first, and the form opens on *Add a verifier*, *Edit* or
**`Duplicate`** — the latter reopens it **prefilled** with no id, so saving **creates** instead of
overwriting the original, with a free name proposed ("X (copy)", since names are unique) and the
field selected: renaming is the first gesture) ·
**Notifications** (a dedicated sub-tab, see below) ·
**General** (light/dark/auto theme, language, density, morning brief, data retention, backup,
and a **danger zone** for a full reset) ·
**Jira** (the **Jira connection** —
URL + email + API token, with a *Test Jira* button —; feeds the *Jira* tab and the enrichment of a session
from a ticket) ·
**Jenkins** (URL, user and API token, with a test button, and the jobs' **refresh interval**) ·
**AI sessions** (the **standing instructions**, see below, and a technical test: two passes inside the
same agent session — it memorises a marker then
recalls it on resume — to check that **session resuming** works with your CLI; it is the foundation of
context continuity between review, fixes and convergence).

The first three are what you fill in to get started; **Rules** and **Verifiers** complete the review; the
rest is tuned when the need arises. The **last sub-tab you visited is remembered** — you come back to
Settings to finish what you were doing there.

#### Standing instructions
*Settings → AI sessions.* Free text **appended to the prompt of every coding session** — in a
repository **and** out of one, on the first run **as on every follow-up**. It is what you repeat every
time: the language of comments, a command to run before committing, something not to do. Copying it
into every prompt works until the day you forget — and that is always the one you re-read three
hours later.

It comes **after the task** (what to do first, how to do it next) and **before** the questions block,
which stays the last word. It is **re-read on every prompt**: an instruction added now applies to the
session started right after, without restarting the tool. An **empty field adds nothing** — not even
an orphan section heading. ⚠ It does **not** apply to exploration, which produces no code.

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
**keyboard shortcuts** (`1`-`9` then `0` for the ten tabs, `/` search, `n` new todo, `r` fetch MRs, `l` logs, `?` help, `Esc` closes) · a
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
**your** test commands, Mergerie prepares the repositories for them and reads their verdict. The two complement
each other — a 9/10 score on an MR whose integration tests break means nothing any more once you know it.

**What it changes in practice**: a badge on each merge request (`✓ verified`, `✗ 2 tests broken`,
`⚠ base red`, `⟳ stale`), and above all the ability to **verify together** merge requests from different
repositories that are only worth anything together — the front-end MR and the API one that only pass when
combined.

### What a verifier is

You give a **list of commands** (`npm ci`, then `npm test`), Mergerie runs it in the prepared repository and
**the verdict comes from the exit codes**. Nothing to write, nothing to install.

> A second family existed up to 1.2: an **executable** committing to a JSON contract. It has been removed —
> it asked you to write and maintain a program to get what three lines of commands give. A verifier of that
> family still on file stays visible in the settings, marked as such, and **refuses to run**: rewrite it as
> a list of commands, then delete it.

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

#### What a verifier can say, and what it cannot

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

**Mergerie does all the git.** Your commands do no checkout and know no branch: they run in directories
already positioned on the right commits and answer “do the tests pass”. That is what lets the same list
serve in a throwaway worktree as well as in your own working directory.

**Declarative coverage ≠ actual checkout.** In *Settings → Verifiers*, declaring a repository only says
“this verifier knows how to test that repository”. Only the repositories **actually targeted** by a
verification are prepared. The other covered repositories configured *in place* are
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

### `node_modules`, and why the base is sometimes red

**`node_modules` strategy.** A fresh worktree has no dependencies installed. Two answers: a **symlink** from
a shared cache (fast, but assumes the `lock` has not changed), or an **install** in the worktree (slow, but
faithful). The choice is yours — it lives in your commands. An
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
the commands, the repository, the mode, the timeout — before launching anything. It appears
even when a single verifier covers the repository: running commands on your machine deserves a screen, not a
silent click.

**A battery that starts by itself.** A checkbox **`Run on every new merge request of the covered
repositories`** on a verifier: as soon as a merge request appears at discovery, **all** the
automatic verifiers covering its repository start, with no click. Only a **new** merge request
triggers them — a known one is seen again at every sync, and re-running it every time would keep
the battery running on everyone forever.

**Re-running when the verdict goes stale.** A second checkbox, **`Re-run when a verified merge
request gets new commits`**: a green given on commits that are no longer the latest is worth
nothing. It is SEPARATE from the first one because it is a different appetite — on a branch that
moves ten times a day, that is ten batteries. Unticked, the badge simply says “stale” and you
re-run it yourself.

⚠ **Five verifications at most per discovery run**, and that cap is a **setting**
(*Settings → Merge Request*). On a Monday morning discovery can bring back fifteen merge requests;
fifteen functional batteries saturate the machine for an hour and block the queue shared with
reviews. Beyond that, the merge requests keep their **`Verify`** button and the **server log says
what did not start** — a silent cap would read as “everything was verified”. `0` means “no limit”,
a choice that should be made on purpose. Verifications of the same repository **queue up** instead
of being refused: they will never run at the same time, but none is lost.

### Publishing the verdict on the merge request

Two paths, and they do not blur into one.

**By hand, after reading it.** From the report, **`Publish as a comment`** opens the **pre-filled**
body — exactly the one automatic publication would send — in an **editable** field. A confirmation
**names the merge request** before sending, and once published the screen says so (date,
recipients) instead of offering the button again as if nothing had happened: that is what stops
the same verdict being posted twice on someone's merge request. If publishing fails, **the text
stays on screen** — you never lose what you have just written.

**By itself**, if the `Publish the verdict as a comment` box is ticked on the verifier — **as
long as the base run is green**. It is the base that gives the verdict its meaning:

| Base | Head | Published? |
|---|---|---|
| green | red | **yes** — “it passed before, this branch breaks it” |
| green | green | **yes** — “verified, and it holds”: on a merge request you are about to review, a written green beats a badge you have to go and find |
| red | — | no — it is not this branch's doing; writing it on ITS merge request would blame it for what someone else broke |
| absent | — | no — without a base run we do not KNOW whether it was already red, and publishing would assert what we have not checked |

The **server log says why** nothing went out: silence reads as “published”. Unticked by default:
writing on other people's work is a decision. Publishing **by hand** stays available in every
case — there, a human decides, with the text in front of them.

**The comment template** can be edited (it appears under the box). What each field produces:

| Field | What it produces |
|---|---|
| `{verdict}` | the verdict line, with the verifier's name — `**integ**: ✗ 2 test(s) broken by this branch`. On a branch verification, “by this branch” disappears |
| `{tests}` | the broken tests, one per line, with their message when the output gives one. Cut past twenty, and it says so. **Empty when everything passes** |
| `{commandes}` | the commands that failed, with their exit code (prefixed with the repository when there are several). It answers what `{tests}` leaves open when the output **names** the tests: which ones broke, yes — but which command did. Empty when nothing failed |
| `{commits}` | the commits actually tested: one per repository, `repository · branch @ sha`. That is what makes the verdict checkable |
| `{mentions}` | the people declared on the verifier (*People to ping when it breaks*), **only on a red verdict**. Empty on a green one |
| `{verificateur}` | the verifier's name alone — useful if you write your own verdict sentence |
| `{date}` | the date the comment is **published** (`17/08/2026`), not the date of the run |
| `{heure}` | the time it is published (`14:12`) |

**Pinging someone.** The *People to ping when it breaks* field takes **handles** (`@amady @bruno`)
or a **group** (`@my-team`, which ages better than a list of people), written as is wherever you
put `{mentions}`. The **forge** resolves the mention and sends the mail — Mergerie only writes it.
Two things to know: it must be the handle, not the numeric id (GitLab does not resolve `@42`), and
you will not be notified of **your own** mentions, since the comment is posted with your token.
Nothing is mentioned on a green verdict: pinging someone to say all is well is the surest way to
end up in a mail filter.

Everything else is written as is, and an unknown field **stays visible** rather than disappearing:
a typo should show in the preview, not turn into a hole in the comment. An empty block leaves no
extra blank line. Under the field, **“See an example comment”** shows YOUR template rendered on
sample data — composed by the same engine as the real comment, otherwise the preview would end up
lying. Left empty, the default template is used, and it then benefits from later improvements.

### Verifying a branch, with no merge request

Back from holiday, several merge requests have been merged: the question is no longer “what does
this branch break?” but **“is `develop` still green?”**. The **`Verify a branch`** button lives in
the **Git** tab and on every verifier's card. One row per covered repository, each on its **default
branch**, picked from a searchable selector — an active repository lines up hundreds of them. The
last branch verified is remembered.

Two things change meaning, and the tool deduces both from the absence of a merge request:

- **the causal double run switches off** — on an integration branch, the branch IS the base;
  leaving it on would run the battery twice to compare `develop` with `develop`;
- **attribution disappears**: nothing is “broken by this branch”, what is red is red. The report
  and the comment word it differently.

There is no merge request card to carry the badge: the result lives in the verification history
and in the **morning brief**, where the line reads “repository · branch”.

**Seeing what ran, even when it is green.** A **`See the verifiers' results`** button on the merge
request opens the details of **each** verifier that ran on it — verdict, tested commits, broken
tests, and the **command by command** breakdown with exit codes and output. It appears as soon as a
result exists, not only in red: “it is green, but what exactly ran?” is a fair question, especially
when you did not see the run start. A **stale** result (the merge request's SHA moved since) says
so. Each red block keeps its own **`Fix (AI session)`** button — with several reports, a single
button at the bottom would not say which one it fixes.

**While it runs, you can see it.** A verification takes minutes: the button turns into
**`Verifying…`** with its spinner, disabled — so a second click cannot start the same one again — and
the card carries the **"in progress" marker** (the pulsing bar), the same one a review uses. The state
comes from the **server**, not from the page: it survives a tab change, a re-sort of the list and a
reload, and it clears itself at the end, the list refreshing to show the verdict. ⚠ A review on the
same merge request does mark the card, but does **not** spin the *Verify* button: a spinner pointing at
the wrong command would be worth less than no spinner at all.

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
**demo mode**, on the other hand, no command is run at all: the verdict is simulated.

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
| `JENKINS_CA_CERT` | — | same for an **internal Jenkins** behind a corporate certificate |
| `JENKINS_INSECURE_TLS` | 0 | `1` = skip the TLS check **for Jenkins only** (troubleshooting) |
| `GIT_CLONE_SSH` | 0 | `1` = clone over SSH (your key) instead of HTTPS+token |
| `MERGERIE_DATA_DIR` | `data/` | isolated data folder (useful for tests) |

The AI agent must be able to **modify files** (“yolo” mode) for the coding sessions. Explorations, on the
other hand, are read-only: the repositories are reset after each pass.

## Self-hosted GitLab / GitHub Enterprise / internal Jenkins / corporate certificate

If the API fails with `UNABLE_TO_GET_ISSUER_CERT_LOCALLY` or `unable to get local issuer certificate`
(an internal CA unknown to Node):
- **the clean way**: export the CA (the full chain up to the root) and point `GITLAB_CA_CERT=/path/ca.pem`
  at it (or `GITHUB_CA_CERT` for a GitHub Enterprise instance, `JENKINS_CA_CERT` for an internal Jenkins);
- **troubleshooting**: `GITLAB_INSECURE_TLS=1` / `GITHUB_INSECURE_TLS=1` / `JENKINS_INSECURE_TLS=1`.

This is the common case with **Jenkins**: an internal server is almost always served by a certificate a
freshly installed Node does not know. The Jenkins tab's message names both variables directly — the
pinned CA first, disabling the check second.

The three settings are **independent**: pinning your internal GitLab's CA changes nothing for calls to
github.com or to your Jenkins. For the **clone**, `git` has its own store: either `GIT_CLONE_SSH=1` (an SSH key), or the
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

**A page open in another tab cannot act on your behalf.** Listening on `localhost` protects nothing here:
it is **your** browser that sends, and any website can make it post to Mergerie — a plain form goes out
**without a preflight**, and the routes that do not read their body would run as-is (wipe every report,
publish your pending comments on a real merge request with your token, launch an agent on your folders).
The code is public, so the list of routes is no secret. **Any request that writes and announces a foreign
origin is therefore refused** (403), with a message that names the likely culprit. What is **not** refused:
reads (they change nothing, and the response stays unreadable to the third-party page) and requests with
**no** origin — `curl`, a script of yours, the *Commands* tab: a browser always sends one.

**AI agent permissions (“yolo mode”).** The agent runs with its permission guard rails **disabled**
(“yolo”), because coding sessions require it: it must be able to create, modify and delete files without a
confirmation at every step. Its **nominal radius of action is the working clone** (`data/clones/…`), and the
guarantees are **structural** where possible: an exploration is read-only because the worktree is **reset in
a `finally`** afterwards, and a review only **reads a diff**. But during a **coding session**, the agent has
the **user's rights on the machine** — nothing technically stops it from acting outside the clone. That is
the **accepted trade-off** of a **local single-user** tool: to be known before use, and one more reason not
to expose the server.

**Verifiers.** Running a repository's tests **is running that repository's code**: the same level of trust
as the agent session, and the commands execute with **your** rights on the machine. Each command comes
**from the configuration** — never from a file of the cloned repository —, it is launched **without a
shell**, with a **minimal environment containing no token**. Their output is treated as **untrusted data**:
sizes bounded, systematic escaping on display. Worktrees are created
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

**Enterprise TLS.** For a self-hosted GitLab, a GitHub Enterprise or an internal Jenkins with an
internal CA, supply `GITLAB_CA_CERT` / `GITHUB_CA_CERT` / `JENKINS_CA_CERT`. The matching
`*_INSECURE_TLS=1` **disables** the certificate check for that service only: to be **reserved for a
trusted internal network**.
