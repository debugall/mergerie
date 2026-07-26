# Roadmap

Where Mergerie is heading. This list is about **direction, not dates** — items are roughly ordered by
priority, and priorities shift with feedback. Contributions toward any of these are welcome; see
[CONTRIBUTING.md](./CONTRIBUTING.md).

## Forge support beyond GitLab

- **GitHub support** — bring the full review / coding / convergence workflow to GitHub pull requests.
- **Bitbucket support** — same workflow for Bitbucket pull requests, so a mixed-forge organization can use a
  single cockpit.

## Orchestrated multi-repo releases

Drive a release across several repositories from a single Jira ticket: **tag** each repo, generate a
**changelog** from the ticket, open the release **MR**, and attach the **review note** — one coordinated
operation instead of a manual repo-by-repo chore.

## Deployment piloting and observability

- **Trigger and watch GitLab CI pipelines** from within Mergerie, without leaving the cockpit.
- **See what version runs where** — a clear view of which build is deployed on each environment, so "is my
  fix live?" is answered at a glance.

## Objective convergence anchors

Make the autonomous convergence loop exit on **objective signals**, not only the AI's own score: wire
**lint / typecheck / tests** in as loop exit criteria, so a session converges when the code actually passes
the project's own gates — not merely when the model is satisfied with it.
