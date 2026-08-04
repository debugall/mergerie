# -*- coding: utf-8 -*-
"""Narration de la visite guidée — English.

Une entrée par étape, dans l'ordre du parcours de `parcours.mjs` : la Nième chaîne est lue
pendant la Nième étape. AJOUTER UNE ÉTAPE ICI SANS EN AJOUTER UNE DANS `parcours.mjs`
(ou l'inverse) décale tout ce qui suit — les deux fichiers se comptent, et le script
s'arrête net si le compte ne tombe pas juste.

Le texte est écrit pour ACCOMPAGNER le geste : il décrit ce qui est à l'écran au moment où
le curseur y arrive. Il est ensuite réécrit pour la voix par `prononciation.py` — écrire
l'orthographe correcte ici, jamais une graphie phonétique.
"""

NARRATION = [
    (
        'This is Mergerie, a local AI-assisted development cockpit. Seven tabs across the top: merge request reviews, coding sessions, statistics, git, Docker, Jira and settings. The badges flag work that is waiting, never decorative totals. '
    ),
    (
        'We start with the merge requests to handle. Each card carries the essentials: the number, the title, the project, the author and the date, then the branches involved and links to the ticket and to the forge. '
    ),
    (
        'A search box filters on title, author, project or ticket. You will find one everywhere in the tool: on an active repository, lists grow long fast. '
    ),
    (
        'The Review button runs the AI analysis on this merge request. The small arrow beside it offers two variants: review on its own, or review together with a teaching explanation of the change. '
    ),
    (
        'Before spending a call, View diff lets you read the code. '
    ),
    (
        'The diff opens inside the tool: file by file, with additions and removals. You decide for yourself whether the merge request deserves a full review. '
    ),
    (
        'The Context button is for giving the AI what it cannot guess. '
    ),
    (
        'You paste the ticket text, a specification or a business rule, you can attach a screenshot, and declare the linked projects and branches. All of it is added to the review instructions. '
    ),
    (
        'At the top, Review the 6 MRs handles the whole queue at once. Jobs are chained, at most three in parallel, and two jobs that would touch the same repository are refused rather than allowed to collide. '
    ),
    (
        'Fetch new MRs queries GitLab and GitHub and brings back whatever appeared since last time. '
    ),
    (
        'On each card, Classify without review takes a trivial merge request out of the queue, Merge merges it directly, and Let the AI code opens a coding session from this merge request. '
    ),
    (
        'Let us move to the merge requests that have already been reviewed. '
    ),
    (
        'When you come back to the tool, the right-hand panel sums up what moved since your last visit, and suggests which reports to look at first. '
    ),
    (
        'The list on the left shows the score given to each one, from zero to ten, and flags reports that went stale because the branch moved since. Let us open one. '
    ),
    (
        'Every report follows the same structure: a summary, the findings with their exact location in the code and their severity, what is good, and an overall score. '
    ),
    (
        'The second tab holds the teaching explanation: what the merge request does and why, so you can pick up a change you did not write. The Copy button takes the whole report as Markdown. '
    ),
    (
        'Above them, Open the code launches your editor on the local repository, on the right branch. Context reopens the context folder for this merge request, to complete it before another pass. '
    ),
    (
        'Re-run the review does everything again. Re-run delta only re-reads what changed since the last pass: far cheaper, and what you want most of the time. '
    ),
    (
        'Mark as done files the merge request away without merging it, Merge merges it, and Delete report starts over from scratch. '
    ),
    (
        'Further down, you can ask for a change to the report in plain language: dig into this point, make it shorter. The AI regenerates the report with that instruction. '
    ),
    (
        'Below that, the merge request comments are pulled from the forge. You read the thread, you reply, and the reply is posted to GitLab or GitHub without leaving the tool. '
    ),
    (
        'Let the AI fix the code opens a coding session on the merge request branch, with the findings from the report as its instructions. '
    ),
    (
        'And Converge starts the autonomous loop. '
    ),
    (
        'The AI fixes, commits, pushes, re-reads itself, and repeats until the score target or the pass ceiling. The warning is explicit: every pass pushes a commit onto the shared branch, but never a merge. You are the one who reviews and merges at the end. '
    ),
    (
        'The third segment, Done, keeps track of what is finished. '
    ),
    (
        'A review gives an opinion. Next to it, a badge gives a fact: verified, or so many tests broken. It comes from a verifier, that is, from your own tests, run against the commits of the branch. '
    ),
    (
        'The report says which commits the verdict covers, which tests broke, with their message, and what the commands did. Mergerie also replayed the suite on the target branch, before your changes: a test that was already red is therefore never blamed on the branch. '
    ),
    (
        'When the failure is down to the branch, one button opens a fixing session, with the broken tests and the tested commits already in the prompt. '
    ),
    (
        'Verify runs from the list, and from a merge request that has already been reviewed too: the opinion and the fact do not exclude each other. '
    ),
    (
        'A confirmation says what is about to run: which verifier, which commands, in which repository and with what time limit. Running commands on your machine deserves a screen, not a silent click. '
    ),
    (
        'And for changes that only hold together as a set, you tick several merge requests from different repositories and verify them in one go: the verdict then applies to all of them. '
    ),
    (
        'Now the AI Dev tab, where the AI writes the code. '
    ),
    (
        'Three families of sessions: coding on git repositories, coding outside a repository on a plain folder of your machine, and exploration, which answers a question about the code without changing anything. '
    ),
    (
        'Let us create a coding session. '
    ),
    (
        'You pick one or several repositories — with a search box, of course — the branch to create or reuse, and the branch to start from. '
    ),
    (
        'Then you describe the task in plain language. You can attach a screenshot, and set the commit message. '
    ),
    (
        'Two options change the behaviour: auto-push, which pushes the branch as soon as the work is done, and permission for the AI to ask questions when it hesitates. Below, a field lets you resume an existing agent session instead of opening a fresh one. '
    ),
    (
        'Save prepares the session, Converge chains it straight into the review loop. '
    ),
    (
        'Here is a session spanning four repositories at once. Each project shows its state, its branch and its progress. A failing project never interrupts the others — its error stays on its own row. '
    ),
    (
        'A session covering several projects shows its list folded: past a few repositories a single session would fill the screen and hide the others. One click unfolds it, and the choice is remembered. '
    ),
    (
        'Each project has its own actions: run it alone, without replaying the other nine, and push its branch. '
    ),
    (
        'And create its merge request. As soon as several projects are ready, two grouped buttons appear: push for all, and create all the merge requests. '
    ),
    (
        'On the right, the actions for the whole session. Re-run failed projects replays only what did not go through. '
    ),
    (
        'Check branch state is for when a session stopped in error although the work was already committed: the tool re-reads the repositories, recognises what is done, and gives you back the push and merge request buttons. Without spending a single AI call. '
    ),
    (
        'Here is the other case: the AI chose to ask. It puts its questions with the options it can see in the repository, and waits. '
    ),
    (
        'You answer, and the session picks up exactly where it stopped. '
    ),
    (
        'Resume in terminal reopens that same agent session in a real terminal, with all of its history: you carry on by hand when that is quicker. '
    ),
    (
        'Coding outside a repository does the same on a plain folder, with no git, no branch and no merge request. Handy for a standalone script or a folder of notes. '
    ),
    (
        'Exploration changes nothing at all: you ask a question about the code, you read the answer, you follow up. This is the mode to use to understand before touching anything. '
    ),
    (
        'These groups can be named and kept: a batch is then re-verified with a single button. '
    ),
    (
        'The Statistics tab answers one simple question: is quality going up? '
    ),
    (
        'The score distribution and the weekly average show the trend. Above them, recent forge activity, project by project. '
    ),
    (
        'The per-project table puts the worst scores first, with the resolution rate: how many findings were actually fixed. '
    ),
    (
        "And the token cost is shown as a deliberate lower bound: the agent's internal work is not counted, and the tool says so rather than pretending. "
    ),
    (
        'The Git tab applies the same operation to several repositories at once. '
    ),
    (
        'Six tools. The first creates or deletes branches and tags across a selection of repositories. '
    ),
    (
        'Repositories are filtered by search, and so are branches — an active repository has hundreds of them, a raw list would be unusable. '
    ),
    (
        'Nothing runs without a line-by-line preview: you see exactly what is about to happen, repository by repository, before you confirm. '
    ),
    (
        'Navigation puts your local repositories on a given branch, all at once, from a directory holding all the clones. '
    ),
    (
        'Git commands run the same command everywhere — a palette of common commands is provided, and you can write your own. '
    ),
    (
        'The branch explorer compares branch state across repositories: what is ahead, behind, or missing. '
    ),
    (
        'Find a ref looks for a tag or a branch across every active repository and tells you which ones have it. '
    ),
    (
        'Finally, the history keeps a record of every operation, and every branch or tag deletion stays restorable. '
    ),
    (
        'The Docker tab shows the real state of your compose projects. '
    ),
    (
        'Each service shows its state, and above all its configuration drift: what the compose file asks for, compared with what is actually running, variable by variable. Here the pool size went from ten to twenty-five. Sensitive values, on the other hand, are masked. '
    ),
    (
        'The search box and the state filter clearly separate running containers, those that exited cleanly, and those that genuinely failed. The red badge on the tab counts only the last group. '
    ),
    (
        'Each compose project can be brought up and taken down from the tool. '
    ),
    (
        'Containers started outside compose get their own tab. Rebuild the command recovers the docker run that created them — priceless for a container started by hand six months ago. '
    ),
    (
        'Logs are read container by container, with a keyword search. '
    ),
    (
        'And the Actions tab applies recreate, build, restart or stop to a selection of services, with the same preview as everywhere else. '
    ),
    (
        'The Jira tab automatically pulls the tickets assigned to you. '
    ),
    (
        'You filter by ticket or by person, and read the description, the comments and the attachments without leaving the tool. '
    ),
    (
        "The status can be changed from here, and Let the AI code opens a coding session already filled in with the ticket's content. "
    ),
    (
        'That leaves the settings, spread across eight tabs. '
    ),
    (
        'General holds the theme — light, dark, or following the system — the language, French or English, and the display density. '
    ),
    (
        'Repositories are added in bulk from a GitLab group or a GitHub organisation. Each repository keeps its own branch pattern, and can be disabled without being removed. '
    ),
    (
        'Project-specific review rules add targeted instructions: on a ticket, on a file path, on a project. A rule about migrations applies only to migrations. '
    ),
    (
        'A verifier is declared here, in two families. A list of commands, replayed in each targeted repository, with nothing to write. Or your own script, which receives every repository at once and returns a verdict in the expected format. '
    ),
    (
        'The commands are ordered: install before testing. They run without a shell, in the prepared repository. Mergerie recovers the names of the broken tests from a JUnit report if you declare one, otherwise from the TAP that many tools already emit, and failing that it names the command rather than inventing a number of tests. '
    ),
    (
        'What remains is to say which repositories this verifier knows how to test, and where. In a throwaway copy made for the occasion, or in your own working directory — in which case Mergerie asks for your consent, refuses outright if you have uncommitted changes, and always puts you back on the branch where it found you. '
    ),
    (
        'A dedicated tab sets the AI agent in use, its binary, its timeouts and its limits. '
    ),
    (
        'The Git tab carries the forge URL, the access token and the clone directory, with a button that tests the connection before you go any further. '
    ),
    (
        'And notifications warn you when a job finishes, with a score threshold below which you want to be alerted. '
    ),
    (
        'At the bottom of the screen, a bar follows jobs live: what is running, the tokens spent, and a log that unfolds. That log holds an Activity view, listing what was launched and what finished, with a link that takes you straight back to the object concerned. '
    ),
    (
        'Control K opens a command palette: you type a fragment and jump to a tab, a merge request or a session. '
    ),
    (
        'The question mark key shows every keyboard shortcut. '
    ),
    (
        'And everything you have just seen exists in dark theme too. The AI prepares, you are the one who merges. '
    ),
]
