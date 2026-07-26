# Contributing to Mergerie

Thanks for your interest in improving Mergerie! This guide covers where development happens, how to run the
project in development, what to work on, and the requirements for opening a merge request.

## Where development happens

Mergerie lives in two public places:

- **GitLab — [gitlab.com/amady/mergerie](https://gitlab.com/amady/mergerie)** — the **source of truth**.
  All changes land here through **merge requests**, reviewed by Mergerie itself (we dogfood the tool on its
  own code). To contribute code, fork on GitLab and open an MR.
- **GitHub — [github.com/debugall/mergerie](https://github.com/debugall/mergerie)** — a read-only **mirror**,
  kept in sync automatically. **Issues and discussions are welcome here.**

If you open a pull request on GitHub instead, it won't be merged there: a maintainer will push your branch to
GitLab, open the merge request, and let Mergerie review it — your authorship and DCO sign-off are preserved,
and you'll get the MR link.

## Running in development

Mergerie is a Node 22.9+ app (Express + better-sqlite3 + a vanilla-JS SPA). No build step.

```bash
npm install
npm start          # http://localhost:4319  (or `npm run dev` for auto-reload)
```

**Develop without AI or a forge — dry-run mode.** You don't need an AI CLI, a GitLab or GitHub account, or any
token to work on most of the app. Dry-run generates mock review reports from the diff, so the whole pipeline stays
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
**[full guide](./docs/guide.fr.md)** (French).

## Before you open a pull request

Two checks are **mandatory** and must pass:

```bash
npm run check        # front-end guardrails + i18n consistency
npm run i18n:check   # translation dictionary consistency (also part of `npm run check`)
```

Please also run the test suite and **add tests for your change** (end-to-end where possible, unit tests
otherwise):

```bash
npm test
```

The UI is **bilingual (French / English)** and supports **light and dark themes** — keep both working when
you touch strings or styles.

Mergerie talks to **two forges** (GitLab and GitHub). Never call `src/gitlab.js` or `src/github.js` directly
from another module: go through `src/forge.js` (`clientFor(repo)`). Both clients expose the same interface
and return the same normalized shapes, so callers stay forge-agnostic. A feature that touches a forge should
be covered on both (`test/e2e-*.test.js` and `test/e2e-github.test.js`).

## What to work on

See the **[Roadmap](./ROADMAP.md)** for the direction the project is heading. Good contributions:

- fit one of the roadmap milestones, or
- fix a bug, improve accessibility, tighten security, or improve a translation.

For anything larger or that changes the product's scope, please **open an issue first** to discuss it before
investing time — it saves everyone a wasted PR.

## Sign your commits (DCO)

Mergerie uses the [Developer Certificate of Origin](./DCO). By signing off on a commit, you certify that you
wrote the change (or have the right to submit it) under the project's license.

**Every commit must be signed off.** Add the `Signed-off-by` line automatically with the `-s` flag:

```bash
git commit -s -m "Your message"
```

This appends a line like:

```
Signed-off-by: Your Name <your.email@example.com>
```

The name and email must be real and match your `git config user.name` / `user.email`. Pull requests with
unsigned commits will be asked to sign off before merging.
