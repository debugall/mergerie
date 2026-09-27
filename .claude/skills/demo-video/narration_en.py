# -*- coding: utf-8 -*-
"""Guided-tour narration — English.

One entry per step, in the order of `parcours.mjs`: the Nth string is read during the Nth
step. ADDING A STEP HERE WITHOUT ADDING ONE IN `parcours.mjs` (or the reverse) shifts
everything after it — the two files are counted, and the script stops if the counts differ.

Written for SOMEONE DISCOVERING THE TOOL: every screen opens with the problem it solves, then
shows the gesture. The text accompanies the cursor — it describes what is on screen when the
cursor gets there. It is rewritten for the voice by `prononciation.py` — write correct
spelling here, never a phonetic one.
"""

NARRATION = [
    (
        "You know the day: merge requests piling up, tickets to move forward, five repositories, and an AI that can code but that nobody dares to leave alone. Mergerie is a local cockpit that fixes that. The AI reviews, codes, tests and prepares. You decide, and you merge. Everything runs on your machine, with the agent you already use. Eleven tabs on the left; the badges only show what is waiting for you. "
    ),
    (
        "Let's start with what lands every day: a merge request to review. Each card gives the essentials at a glance: the number, the title, the project, the author, the branches, and links to the ticket and to GitLab or GitHub. "
    ),
    (
        "A search field filters by title, author, project or ticket. You will find one everywhere in the tool: on an active repository, lists get long fast. "
    ),
    (
        "The queue sorts the way you want: smallest first, oldest first, lowest score, blockers on top. And when the order is not the usual one, the control says so, so you always know what you are reading by. "
    ),
    (
        "Review is the key gesture. The AI reads the diff, checks it against your team's rules, and returns a scored report. The small arrow offers two variants: the review alone, or the review with a teaching explanation of the change. "
    ),
    (
        "Before spending a call, you can read the code yourself. "
    ),
    (
        "The diff opens inside the tool, file by file. You decide on your own whether this merge request deserves a full review, or whether a glance is enough. "
    ),
    (
        "Context is what makes the review truly relevant: giving the AI what it cannot guess. "
    ),
    (
        "The ticket text, a specification, a business rule, a screenshot, the related projects and branches. All of it goes into the review instructions. An AI that knows the intent reviews better than one that guesses. "
    ),
    (
        "And when the queue is long, one button reviews everything. Jobs run one after another, three in parallel at most, and two jobs that would touch the same repository are refused rather than stepping on each other. "
    ),
    (
        "Fetch new MRs asks your forges and brings back what has appeared since last time. "
    ),
    (
        "The card's menu holds the rest: dismiss a trivial merge request without a review, merge it directly, or have the AI code from it. "
    ),
    (
        "And here is a detail that changes everything: when an agent has mapped a subject, the merge requests touching its files carry its map. You know what ground you are stepping on before even opening the diff. "
    ),
    (
        "On to the merge requests already reviewed. "
    ),
    (
        "When you come back to the tool, the right panel sums up what moved since your last visit, and tells you which reports to look at first. "
    ),
    (
        "On the left, each report carries its score out of ten, and a marker if the branch has moved since: a stale report does not read like a current one. Let's open one. "
    ),
    (
        "The report always has the same structure: a summary, the findings with file, line and severity, what is good, and an overall score. In thirty seconds, you know whether you can merge. "
    ),
    (
        "Each finding carries a file and a line. Turn into drafts converts them, in one gesture, into remarks placed on the diff, ready to re-read. Nothing has left for the forge yet. "
    ),
    (
        "And what cannot be placed is said: a finding about a line the branch did not touch has no anchor in the diff. Those are set aside, and counted. The tool never cheats about what it did. "
    ),
    (
        "The second tab is the teaching explanation: what the merge request does and why. Ideal for taking over a change you did not write. Copy grabs the whole report as Markdown. "
    ),
    (
        "Open the code launches your editor on the local repository, already on the right branch. Context reopens this merge request's folder, to complete it before another pass. "
    ),
    (
        "Re-run the review does everything again. But if the branch has moved, the re-run becomes a delta re-run: the AI only re-reads what changed. Fewer tokens, and no duplicate remarks. "
    ),
    (
        "Mark done files the merge request away without merging it. Merge merges it, with confirmation. "
    ),
    (
        "The menu holds the rarer gestures: publish the report on the merge request, file a finding into the todos, delete the report. "
    ),
    (
        "Further down, you can ask for a change to the report in plain language: dig into this point, make it shorter. The AI regenerates it with that instruction. "
    ),
    (
        "Just below, you can simply ask a question: why is this point blocking? What would happen if we did not fix it? "
    ),
    (
        "The answer is added under the report, and the report does not move: neither its text nor its score. Asking for an explanation must never cost you the report you are reading. "
    ),
    (
        "And if a notes page mentions this merge request, it is cited here. The link works both ways: the note leads to the merge request, the merge request finds the note. "
    ),
    (
        "Further below, the merge request's comments, pulled from the forge. You read the exchanges, you reply, and the reply goes to GitLab or GitHub without leaving the tool. "
    ),
    (
        "Have the AI fix the code opens a development session on the branch, with the report's findings as the instruction. The AI fixes what it found itself. "
    ),
    (
        "And Converge is the full loop. "
    ),
    (
        "The AI fixes, commits, pushes, re-reviews itself, and starts again until it reaches the target score or the pass ceiling. A merge request that goes from five to eight on its own, with the whole history kept. The warning is clear: every pass pushes a commit, but never a merge. Merging is you. "
    ),
    (
        "The third segment, Done, keeps track of what is finished. "
    ),
    (
        "A review is an opinion. This badge is a fact: verified, or so many broken tests. It comes from a verifier, that is, your own tests, really run on the branch's commits. "
    ),
    (
        "The report says which commits the verdict covers, which tests broke, and the sequence of commands. And Mergerie also replayed the suite on the target branch before your changes: a test that was already red before is never blamed on the branch. "
    ),
    (
        "When the failure really comes from the branch, a button opens a fix session, with the broken tests and the tested commits already in the prompt. "
    ),
    (
        "Verify launches from the list, and also on a merge request already reviewed: the AI's opinion and the tests' fact complete each other. "
    ),
    (
        "A confirmation announces what will run: which verifier, which commands, in which repository, with what timeout. Running commands on your machine deserves a screen, not a silent click. "
    ),
    (
        "And for changes that only hold together, you tick several merge requests from different repositories and verify them at once: the verdict applies to all of them. "
    ),
    (
        "A verifier can also start on its own as soon as a merge request appears. This button shows the result of each one that ran: the verdict, the tested commits, the broken tests named one by one. "
    ),
    (
        "And the sequence of commands, with their exit codes. You do not just know it is green: you know what ran. "
    ),
    (
        "On a diff, a remark can wait. These comments stay local, re-readable and editable. Nothing has left yet. "
    ),
    (
        "When the review is done, one button sends them all. The author gets one notification instead of ten, and a remark you would have dropped three files later never leaves. "
    ),
    (
        "And if the batch no longer fits, Delete all clears it in one go. The confirmation says how many remarks go, and which ones. "
    ),
    (
        "On to the AI Dev tab. Here the AI writes the code, and this is where Mergerie really changes the day. "
    ),
    (
        "Four families of sessions: coding on git repositories, off-repo coding on a plain folder, exploration that reads the code without changing anything, and the free question, with no repository at all. "
    ),
    (
        "Let's create a coding session. "
    ),
    (
        "You pick one or several repositories, with search, the branch to create or reuse, and the base branch. Several repositories is the case that hurts by hand: here, it is one session. "
    ),
    (
        "Then you describe the task in plain language, like to a colleague. You can attach a screenshot, and set the commit message. "
    ),
    (
        "Two options change the behaviour: auto-push, which pushes the branch as soon as the work is done, and permission for the AI to ask questions when it hesitates, rather than guessing. "
    ),
    (
        "A session can also borrow an agent's profile: its role, its scope of repositories, its tools and skills, without typing any of it again. "
    ),
    (
        "And here is the choice that saves money: the binary. You declare several agents in the settings, for instance your usual Claude and a local model running on your machine. For a simple task, you pick the local model: zero tokens spent. "
    ),
    (
        "Plan first is the safety net before coding: the first pass touches nothing, the AI reads the repository and proposes a plan. You read it, have it corrected, and it only codes once you have approved. "
    ),
    (
        "At the bottom, the main button creates the session and launches it. A checkbox chains straight into convergence, and the button next to it creates the session without running it, to launch whenever you want. "
    ),
    (
        "A window being filled in can be set aside: the dash tucks it into the menu, with what you had written. "
    ),
    (
        "One click brings it back: fields filled, cursor where you left it. "
    ),
    (
        "Here is a session working on four repositories at once. Each project shows its state, its branch and its progress. A failing project never stops the others: its error stays on its line. "
    ),
    (
        "A session with several projects shows up folded: past a few repositories, one session would fill the whole screen. One click unfolds it, and the choice is remembered. "
    ),
    (
        "Each project has its own actions: re-run it alone, without replaying the others. "
    ),
    (
        "Send it a follow-up, review its merge request, or merge it. And when several projects are ready at the same time, grouped buttons do the gesture for all of them: push all, create all the merge requests. "
    ),
    (
        "On the right, the actions of the whole session: re-run it, chain it with convergence, and, if some projects failed, replay only those. "
    ),
    (
        "A session duplicates: the form opens pre-filled, and saving creates a new session instead of overwriting the old one. "
    ),
    (
        "A session keeps all its iterations: the launch, then each follow-up, with the request that produced it. You can always find out why the AI did what it did. "
    ),
    (
        "And each iteration carries its own diff. By the third follow-up, the three lines you just asked for were lost among two hundred: this button shows only what that pass changed. "
    ),
    (
        "This session ran on the local model: the badge says so. The choice holds for the whole session, follow-ups included. "
    ),
    (
        "And here is a session in plan mode. The AI read the repository and returned its plan. It has not coded anything yet, and the line waits for your go. "
    ),
    (
        "Read the plan opens it. And instead of a follow-up, you get a feedback field: keep the API as is, no migration. Regenerate sends your feedback to the same session, which rewrites the whole plan, still without coding. As many rounds as needed. "
    ),
    (
        "And when everything is right, Approve and code: the same session resumes, carries out the plan, and commits. You validated the what before letting go of the how. "
    ),
    (
        "Here is the other case: the AI preferred to ask. It asks its questions with the options it sees in the repository, and waits. "
    ),
    (
        "You answer, and the session resumes exactly where it stopped. "
    ),
    (
        "Resume in terminal reopens the same agent session in a real terminal, with all its history. When it is faster by hand, you carry on by hand. "
    ),
    (
        "Off-repo coding does the same on a plain folder, with no git, no branch and no merge request. A standalone script, a notes folder. "
    ),
    (
        "Exploration changes nothing: you ask a question about the code, you read the answer, you follow up with another question. It is the mode for understanding before touching. "
    ),
    (
        "The free question touches no repository at all: a question to the AI, the answer kept, and its iterations. "
    ),
    (
        "These groupings are named and kept: a batch can then be re-verified with a single button. "
    ),
    (
        "The Agents tab. An agent is a reusable session profile: a role, a scope of repositories, tools, skills, an output, and sometimes a schedule. "
    ),
    (
        "Each card says what the agent is for and what it works on: every active repository, or only the ones it was given. "
    ),
    (
        "Ask launches it on a subject. Its output can be a report, a notes page rewritten on every run, or even another agent. "
    ),
    (
        "This one starts on its own, every Monday at seven. An agent that starts with nobody around must have a turn limit: without it, the schedule is refused. "
    ),
    (
        "A domain agent keeps knowledge: the map of its subject, versioned. Where this code lives, through which mechanism, how it is tested. "
    ),
    (
        "And that map ages. The tool counts the commits that touched its paths since the last mapping, and flags the ones that no longer exist. Documentation that knows it is stale. "
    ),
    (
        "Update re-runs the mapping on what moved, rather than redoing everything. "
    ),
    (
        "A new version does not impose itself: it waits to be re-read and approved. Wrong knowledge costs more than empty knowledge. "
    ),
    (
        "The second sub-tab lists what the disk offers: the skills and subagents found in the cloned repositories and in your home. Read-only: the disk decides. "
    ),
    (
        "The Notes tab is the one the tool opens on: the first screen of the day. "
    ),
    (
        "The morning brief gathers what calls for a gesture: dormant merge requests, red verifications, sessions waiting for an answer. You no longer search, it is gathered. Each line is clickable, and a cross files it away. "
    ),
    (
        "It also counts the development sessions waiting: never launched, not pushed, without a merge request. The work is done, only a click is missing. "
    ),
    (
        "The brief also says what the watch saw while you were away: a container down, a Jenkins build finished, an automatic ceiling reached. "
    ),
    (
        "And what the agents did on their own, with what they produced. "
    ),
    (
        "Copy for the daily turns it into text ready to paste into the morning meeting. "
    ),
    (
        "Todos sort by priority, then in the order you give them. They tick in place. "
    ),
    (
        "This one was placed by the tool: a session stopped to ask a question. The notification was closed long ago; the todo stays in sight. Answering closes it. "
    ),
    (
        "A todo can be pushed back an hour or to tomorrow morning, and keeps the link to what created it: a merge request, a ticket, a container. "
    ),
    (
        "Pages are free Markdown notes, searchable. "
    ),
    (
        "A ticket key or a merge request number written in the text becomes a link to the matching screen, without pasting anything. "
    ),
    (
        "The Links tab answers a mundane, painful question: where is the address of this service, in this environment? "
    ),
    (
        "A grid: services as rows, environments as columns. A cell can hold several named addresses. "
    ),
    (
        "You filter by environment, by service, by tag, and the grid stays readable without ever scrolling sideways. "
    ),
    (
        "Pasting an address is enough: the tool reads the URL, recognises the service and the environment, and suggests the label. "
    ),
    (
        "The search goes through everything, and the command palette searches the same base: a link, a merge request, a ticket, a todo. "
    ),
    (
        "The Statistics tab answers a single question: is quality going up? "
    ),
    (
        "The score distribution and the weekly average show the trend. At the top, the forge's recent activity, project by project. "
    ),
    (
        "The per-project table ranks the worst scores first, with the resolution rate: how many findings were actually fixed. "
    ),
    (
        "The token cost is shown as an admitted lower bound: the agent's internal work is not counted, and the tool says so rather than pretending. "
    ),
    (
        "Git operations are counted too, with their failure rate, and findings that come back from one review to the next are grouped: that is where you see what deserves a rule rather than one more remark. "
    ),
    (
        "The Git tab applies the same operation to several repositories at the same time. What you did repository by repository, in a terminal, you do here in one go. "
    ),
    (
        "Eight tools. The first creates or deletes branches and tags on a selection of repositories. "
    ),
    (
        "Repositories filter by search, and so do branches: an active repository has hundreds of them. "
    ),
    (
        "Nothing runs without a line-by-line preview: you see exactly what will be done, repository by repository, before confirming. "
    ),
    (
        "The second merges one branch into another, and when there is a conflict, it is resolved here, file by file, without leaving the tool. "
    ),
    (
        "Navigation puts every local repository on a given branch, in one go. "
    ),
    (
        "Git commands run the same command everywhere: a palette of common commands is provided, and you can write your own. "
    ),
    (
        "The branch explorer compares the state of branches across repositories: what is ahead, behind, or missing. "
    ),
    (
        "Compare puts two repositories side by side, branch by branch or tag by tag, even without a common history. "
    ),
    (
        "Find a ref looks for a tag or a branch in every active repository and says which ones have it. "
    ),
    (
        "And the history keeps track of every operation: every branch or tag deletion stays restorable. "
    ),
    (
        "The Docker tab shows the real state of your compose projects. "
    ),
    (
        "Each service shows its state, and above all its configuration drift: what the compose file asks for, compared with what is really running, variable by variable. Here, the pool size went from ten to twenty-five. Sensitive values are masked. "
    ),
    (
        "The search and the state filter separate running containers, those stopped cleanly, and those that really failed. The red badge only counts the last ones. "
    ),
    (
        "Each compose project comes up and down from the tool. "
    ),
    (
        "Containers started outside compose have their own tab. Reconstruct command finds the docker run that created them: precious for a container started by hand six months ago. "
    ),
    (
        "Logs are read container by container, with a keyword search. "
    ),
    (
        "And the Actions tab applies recreate, build, restart or stop to a selection of services, with the same preview as everywhere else. "
    ),
    (
        "The Jenkins tab shows jobs and can launch them, without leaving the tool. Nothing is polled continuously: the screen asks, you ask Jenkins. "
    ),
    (
        "Each row answers four questions: which job, in what state, when last, and launched by whom, on which branch. "
    ),
    (
        "With which parameters, too. A parameter that comes back from one job to the next carries a colour derived from its name: the eye goes down the column without reading. "
    ),
    (
        "Folders tick at the top of the list, and the ones you never use tuck away out of the bar. "
    ),
    (
        "You filter on a parameter's value: what went to prod? The field suggests the values it has seen, without locking you in. "
    ),
    (
        "A job's sheet fits in three blocks. First the launch parameters: the proposed values are the job's own. "
    ),
    (
        "Then the history, with under each row the parameters of that run: two green runs from the same afternoon only differ there. "
    ),
    (
        "And on the right the detail of the one you choose: when, how long, by whom, on which branch. "
    ),
    (
        "Reuse fills the form with that run's values, without launching anything. Re-run, right next to it, starts at once, with confirmation. "
    ),
    (
        "The menu carries the number of jobs today, and the failures in red. A launch followed from the tool is watched until it ends: the notification arrives when the build finishes. "
    ),
    (
        "The Jira tab automatically fetches the tickets assigned to you. "
    ),
    (
        "You filter by ticket or by person, and read the description, the comments and the attachments without leaving the tool. "
    ),
    (
        "Under the ticket, what Mergerie knows about it: the merge requests that mention it, their state, and the development sessions it triggered. From ticket to code, everything is linked. "
    ),
    (
        "The status changes from here, and Let the AI code it opens a session already filled with the ticket's content. One ticket, one click, one branch moving forward. "
    ),
    (
        "Watched tickets are the ones whose status you want to see change without going to look: the tool re-reads them regularly, and the morning brief says so. "
    ),
    (
        "What remains is the settings, in eleven tabs. "
    ),
    (
        "General holds the theme, light, dark or following the system, the language, French or English, and the display density. "
    ),
    (
        "Repositories are added in bulk from a GitLab group or a GitHub organisation. Each repository keeps its own branch pattern, and can be disabled without being deleted. "
    ),
    (
        "Targeted review rules add instructions on a ticket, a file path, a project. A rule about migrations only applies to migrations. "
    ),
    (
        "A verifier duplicates: the form opens pre-filled and saving creates a copy. "
    ),
    (
        "Ticked, it starts on its own on every new merge request of the repositories it covers, with a ceiling per discovery round. "
    ),
    (
        "A verifier is declared here: a name, and the list of commands to run. No script to write, no format to respect. "
    ),
    (
        "Commands are ordered: install before test. Mergerie finds the names of broken tests in a JUnit report or in the TAP that many tools already emit. "
    ),
    (
        "What is left is to say which repositories this verifier can test, and where: in a throwaway copy, or in your own working directory, with your consent, and always put back on the branch where it found you. "
    ),
    (
        "Standing instructions are added to the prompt of every coding session: the language of comments, a command to run before committing. "
    ),
    (
        "And here are the agent binaries. The first one is the default. Below it, as many others as you want, each complete: binary, arguments, environment variables, backend. Here, a Claude Code wired to a local Ollama model. "
    ),
    (
        "Each one tests with a button, and Use as default swaps the roles. Reviews, conflict resolutions, agents: everything that did not choose goes through the default. The rest, you decide session by session. "
    ),
    (
        "The same tab holds the daily limits, the secure or free mode, and the sandbox test. "
    ),
    (
        "The Git tab carries the forge address, the access token and the clone directory, with a button that tests the connection. "
    ),
    (
        "And notifications warn when a job ends, with a score threshold below which you want to be alerted. The background watch adds to it: a finished build, a container going down. "
    ),
    (
        "At the bottom of the screen, a bar follows jobs live: what is running, the tokens consumed, and a log that unfolds. Its Activity view lists what was launched and what finished, with a link to the object concerned. "
    ),
    (
        "Control K opens the palette: it searches everywhere at once, links, merge requests, tickets, notes, todos, and surfaces first what you open often. "
    ),
    (
        "The question mark key shows every shortcut. "
    ),
    (
        "And everything you have just seen also exists in the light theme. Mergerie is open source, runs on your machine, with your agent. The AI prepares, you merge. "
    ),
]
