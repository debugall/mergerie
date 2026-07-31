# Roadmap

Where Mergerie is heading. This list is about **direction, not dates** — items are roughly ordered by
priority, and priorities shift with feedback. Contributions toward any of these are welcome; see
[CONTRIBUTING.md](./CONTRIBUTING.md).

## Forge support

- ✅ **GitHub support** — done. The full workflow (review, comments, merge, coding sessions, convergence,
  Git tab) works on GitHub pull requests, and GitLab and GitHub repositories can be used side by side.
- **Bitbucket support** — same workflow for Bitbucket pull requests, so a mixed-forge organization can use a
  single cockpit. The forge dispatcher (`src/forge.js`) is the extension point.

## Orchestrated multi-repo releases

Drive a release across several repositories from a single Jira ticket: **tag** each repo, generate a
**changelog** from the ticket, open the release **MR**, and attach the **review note** — one coordinated
operation instead of a manual repo-by-repo chore.

## Deployment piloting and observability

- **Trigger and watch CI pipelines** (GitLab CI, GitHub Actions) from within Mergerie, without leaving the cockpit.
- **See what version runs where** — a clear view of which build is deployed on each environment, so "is my
  fix live?" is answered at a glance.

## Objective convergence anchors

Make the autonomous convergence loop exit on **objective signals**, not only the AI's own score: wire
**lint / typecheck / tests** in as loop exit criteria, so a session converges when the code actually passes
the project's own gates — not merely when the model is satisfied with it.
