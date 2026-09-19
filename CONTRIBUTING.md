# Contributing to Mergerie

Thanks for your interest in Mergerie! This guide says what kind of help the project takes, where to
send it, and how to run the project on your machine when you want to reproduce a bug or explore the
code.

## Code contributions are not accepted

Mergerie is written by **one maintainer**, and it stays that way on purpose: pull requests and merge
requests from outside are **not merged** — on GitHub they are **closed automatically** by a workflow,
with a pointer to this page; on GitLab, the merge requests you will see are the maintainer's own,
each one reviewed by Mergerie before it lands.

Why:

- **One rights holder.** Every line of the code belongs to the same author, which keeps the
  project free to evolve its licensing without asking anyone's permission — the AGPL stays, and a
  commercial licence can be offered next to it. Accepting outside code without a contributor
  agreement would close that door for good.
- **One voice in the code.** The project is small, documented in depth, and tested end to end. A
  single author keeps it that way at a lower cost than reviewing and maintaining code written by
  many hands.
- **Time.** Reviewing, discussing and carrying other people's changes is what costs a solo
  maintainer the most. That time goes into the product instead.

This may change one day — with a contributor licence agreement in place. Until then, please do
not open a pull request, and please **do not paste patches in an issue** either: a patch has an
author, and code written by someone else cannot be merged for the same reason. Describe the
fix in words — where the bug is and what should happen — and it will be written from scratch.

The code is **AGPL-3.0**, so forking is of course allowed: keep the licence, keep the notices, and
pick another name for what you ship.

## How to help

All of this is welcome, on **GitHub — [github.com/debugall/mergerie](https://github.com/debugall/mergerie)**,
in the **issues**:

- **Bug reports**, with the version you run (the `version` field of `package.json` from a clone,
  `npm ls -g mergerie` for a global install), the forge
  (GitLab or GitHub), the agent CLI (`claude` or `copilot`), and the steps to reproduce. A
  screenshot of the screen and the relevant lines of the server log go a long way.
- **Ideas and feedback** on the [Roadmap](./ROADMAP.md), or on anything the tool does that gets in
  your way. Saying *what* you are trying to do matters more than proposing *how* to build it.
- **Translation and documentation errors** — a wrong word in the French or English UI, a guide
  section that does not match the screen. Point at the string; it gets fixed.
- **Security issues** — see [SECURITY.md](./SECURITY.md); please do not open a public issue for
  those.

Development happens on **GitLab — [gitlab.com/amady/mergerie](https://gitlab.com/amady/mergerie)**,
the **source of truth**, where every change lands through a merge request reviewed by Mergerie
itself (we dogfood the tool on its own code). GitHub is a read-only **mirror**, kept in sync
automatically — the issues live there.

## Running in development

Useful to reproduce a bug precisely, or to read the code with the app running next to it.
Mergerie is a Node 22.9+ app (Express + better-sqlite3 + a vanilla-JS SPA). No build step.

```bash
npm install
npm start          # http://localhost:4319  (or `npm run dev` for auto-reload)
```

**Run without AI or a forge — dry-run mode.** You don't need an AI CLI, a GitLab or GitHub account, or any
token to run most of the app. Dry-run generates mock review reports from the diff, so the whole pipeline stays
exercisable:

```bash
COPILOT_DRY_RUN=1 npm start
```

To explore the whole UI with realistic seeded data and zero configuration, use the demo:

```bash
npm run demo       # isolated data-demo/, no forge connection, no token
```

Isolate your data directory when experimenting so you never touch a real database:

```bash
MERGERIE_DATA_DIR=/tmp/mergerie-dev npm start
```

To find your way around the codebase (modules, data model, pipelines), read **[PLAN.md](./PLAN.md)**
(French). The user-facing behavior of every tab is documented in the
**[full guide](./docs/guide.en.md)** (also in [French](./docs/guide.fr.md) — the two must keep the same
section structure, which `npm run check` enforces).

## Running the checks and the tests

The same gates the maintainer runs before every merge. Useful on a fork, and to confirm that a bug
you report is not already caught by the suite:

```bash
npm run check        # front-end + server guardrails, and i18n consistency
npm run i18n:check   # translation dictionary consistency (also part of `npm run check`)
```

```bash
npx playwright install chromium   # once: the browsers are downloaded separately from the package
npm test
```

**One prerequisite, and one that is no longer one.**

- The end-to-end UI suites drive a real Chromium. `npm ci` installs the `playwright` package but **not**
  the browsers, so without that first command those suites skip themselves — and say so, naming the
  command to run. A green run that skipped them proves nothing about the screen.
- The **voice-dictation suite needs neither a microphone nor a 1.6 GB model.** Chromium is launched
  with `--use-fake-device-for-media-stream` and `--use-file-for-fake-audio-capture`, fed by
  `test/fixtures/dictation/phrase-fr.wav` (a synthetic three-second file, versioned), and the server
  runs with `DICTATION_DRY_RUN=1`, which substitutes a simulated engine. That engine returns a
  scripted sentence **and the real duration of the WAV it received** — which is what proves, in test,
  that audio actually crossed the chain. What is *not* versioned is the reference recordings the
  measurement bench and the diagnostic sample want: system voices are not clearly redistributable, so
  `test/fixtures/dictation/README.md` explains how to record your own in three commands.
- A **git identity is not required**. The suites build real git repositories and run real commits, but
  each fixture repository carries its own local `user.name` / `user.email`
  (`poserIdentiteGit` in `test/helpers/app.js`). Nothing reads — or writes — your global git
  configuration, so a bare machine passes and yours is left untouched.

## How the code is kept

For the curious, and for anyone maintaining a fork — the rules the maintainer works by:

- The UI is **bilingual (French / English)** and supports **light and dark themes**; both must keep
  working when a string or a style changes.
- User-visible changes go in **[CHANGELOG.md](./CHANGELOG.md)**, under `## [Unreleased]`, in the
  `Added` / `Changed` / `Fixed` section that fits, written for the person who uses the tool — what
  changed and why it matters — not as a copy of the commit message.
- Mergerie talks to **two forges** (GitLab and GitHub). `src/forge/gitlab.js` and
  `src/forge/github.js` are never called directly from another module: everything goes through
  `src/forge/index.js` (`clientFor(repo)`). Both clients expose the same interface and return the
  same normalized shapes, and a feature that touches a forge is covered on both
  (`test/e2e-*.test.js` and `test/e2e-github.test.js`).
- `src/` is **layered by folder** — `app/` (HTTP only), `jobs/`, then `session/`, `review/`,
  `verify/`, `agent/`, `notes/`, `integrations/`, then `forge/`, `git/`, `data/`, `db/`, and
  `core/` at the bottom — and `npm run check` refuses an import that goes up, a dependency cycle,
  or a file that outgrows 1 200 lines of code. The map of every module is in
  [PLAN.md](./PLAN.md); a file moves with `node scripts/move-module.js`, which rewrites the
  `require`s for you.
- Every commit is **signed off** under the [Developer Certificate of Origin](./DCO) (`git commit -s`),
  certifying that its author wrote the change and has the right to submit it under the project's
  licence.
