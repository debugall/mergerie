# Mergerie

[![CI](https://github.com/debugall/mergerie/actions/workflows/ci.yml/badge.svg)](https://github.com/debugall/mergerie/actions/workflows/ci.yml)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](./LICENSE)

**From prompt to merge — a local AI dev cockpit for GitLab.**

*Mergerie* (pronounced *mer-zhuh-REE*) is a local, single-user web app that turns an AI agent CLI into a
review-and-ship workstation for your GitLab projects.

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
(reviews, scores, resolution tracking, token cost, AI sessions) into an isolated `data-demo/`, then launches
the tool on it in dry-run — no GitLab connection, no token required.

```bash
npm run demo       # http://localhost:4319
```

## What it does

Seven tabs, each one line:

- **Reviews** — AI-scored, versioned MR reviews; incremental re-reviews; an autonomous **convergence loop** (review → fix → re-review until the score threshold).
- **AI Dev** — automated coding sessions (the AI codes, commits, pushes, opens the MR), off-repo coding, and read-only code exploration — *from prompt to converged MR* in one click.
- **Statistics** — MR funnel, score trends, per-project resolution rate, token cost.
- **Git** — multi-repo branch/tag/command operations, branch explorer and ref finder, **restorable** deletions, always with a preview.
- **Docker** — compose project health and `.env` drift, batch actions, live multi-container logs, error badges in the menu.
- **Jira** — your assigned tickets fetched automatically, full detail with attachments, status changes and comments.
- **Settings** — GitLab / Jira connections, repositories, review rules, prompt templates, theme and language.

## Learn more

- 🗺️ **[Roadmap](./ROADMAP.md)** — what's next (GitHub & Bitbucket support, orchestrated releases, deployment piloting).
- 📖 **Full documentation** — English version coming soon. For now: **[Guide complet (🇫🇷 French)](./docs/guide.fr.md)**.
- 🧭 **Architecture** — modules, data model, pipelines: **[PLAN.md (🇫🇷 French)](./PLAN.md)**.
- 🇫🇷 **Version française :** **[README.fr.md](./README.fr.md)**.
- 🔒 **[Security](./SECURITY.md)** — trust model and how to report a vulnerability.
- 🤝 **[Contributing](./CONTRIBUTING.md)** — how to run it in dev and open a merge request.
- 🦊 **Development happens on [GitLab](https://gitlab.com/amady/mergerie)** — merge requests are opened there
  and **reviewed by Mergerie itself**. This GitHub repository is a synchronized mirror; issues are welcome here.

## License

**GNU AGPL-3.0-only** — see [LICENSE](./LICENSE). You may use, modify and redistribute the code, but any
modified version **made available over a network** (SaaS included) must publish its source under the same
license.
