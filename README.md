<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="public/images/wordmark-dark.svg" />
    <img src="public/images/wordmark.svg" alt="Mergerie" width="320" />
  </picture>
</h1>

[![CI](https://github.com/debugall/mergerie/actions/workflows/ci.yml/badge.svg)](https://github.com/debugall/mergerie/actions/workflows/ci.yml)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](./LICENSE)

**From prompt to merge — a local AI dev cockpit for GitLab and GitHub.**

*Mergerie* (pronounced *mer-zhuh-REE*) is a local, single-user web app that turns an AI agent CLI into a
review-and-ship workstation for your GitLab and GitHub projects.

Everything runs **on your machine** — a Node + SQLite server and a web UI, nothing sent anywhere except the
services **you** configure. It drives your **existing Claude or Copilot subscription** through their own CLI
(`claude` / `copilot`), so there are no extra API keys or tokens to buy. The AI **prepares** the work — review,
corrections, autonomous convergence — and **you** merge.

![demo](docs/demo.gif)

## Quick start

Requires **Node 22.9+**.

```bash
npm install
npm start          # http://localhost:4319
```

**`npm run demo` — see it live in 30 seconds, no config, no tokens.** It seeds a realistic fake database
(reviews, scores, resolution tracking, token cost, AI sessions, and a browsable fictional repository behind
"View diff") into an isolated `data-demo/`, then launches the tool on it in dry-run — no forge connection,
no token required.

```bash
npm run demo       # http://localhost:4319
```

> Throughout the docs, **"MR"** means either a GitLab *merge request* or a GitHub *pull request* — the
> screens and actions are identical.

## What it does

Seven tabs, each one line:

- **Reviews** — AI-scored, versioned reviews of GitLab merge requests **and GitHub pull requests**; incremental re-reviews; an autonomous **convergence loop** (review → fix → re-review until the score threshold).
- **AI Dev** — automated coding sessions (the AI codes, commits, pushes, opens the MR), off-repo coding (with the AI's report back and follow-up fix requests), and read-only code exploration — *from prompt to converged MR* in one click. Finished sessions can be tidied away without being deleted.
- **Statistics** — MR funnel, score trends, per-project resolution rate, token cost.
- **Git** — multi-repo branch/tag/command operations across both forges, branch explorer and ref finder, **restorable** deletions, always with a preview.
- **Docker** — compose project health and `.env` drift, batch actions, live multi-container logs, error badges in the menu.
- **Jira** — your assigned tickets fetched automatically, full detail with attachments, status changes and comments.
- **Settings** — GitLab / GitHub / Jira connections, repositories (each one can opt out of MR fetching while staying usable for git and coding sessions), review rules, prompt templates, theme and language.

Everywhere: `Ctrl`/`Cmd` + `K` opens a command palette (jump to a tab, a merge request, a session by
name), `j` / `k` walk the current list, `?` lists every shortcut. The tool reopens on the tab and
review stage you left, and the report panel opens on what changed since your last visit.

## Learn more

- 🗺️ **[Roadmap](./ROADMAP.md)** — what's next (Bitbucket support, orchestrated releases, deployment piloting).
- 📖 **Full documentation** — English version coming soon. For now: **[Guide complet (🇫🇷 French)](./docs/guide.fr.md)**.
- 🧭 **Architecture** — modules, data model, pipelines: **[PLAN.md (🇫🇷 French)](./PLAN.md)**.
- 🇫🇷 **Version française :** **[README.fr.md](./README.fr.md)**.
- 📜 **[Changelog](./CHANGELOG.md)** — what changed, release by release.
- 🔒 **[Security](./SECURITY.md)** — trust model and how to report a vulnerability.
- 🤝 **[Contributing](./CONTRIBUTING.md)** — how to run it in dev and open a merge request.
- 🦊 **Development happens on [GitLab](https://gitlab.com/amady/mergerie)** — merge requests are opened there
  and **reviewed by Mergerie itself**. This GitHub repository is a synchronized mirror; issues are welcome here.

## License

**GNU AGPL-3.0-only** — see [LICENSE](./LICENSE). You may use, modify and redistribute the code, but any
modified version **made available over a network** (SaaS included) must publish its source under the same
license.
