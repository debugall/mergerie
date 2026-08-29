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

- 🟡 **Trigger and watch CI pipelines** — done **for Jenkins** (1.2.0): a tab listing every job the account
  sees, its latest verdict, its run history parameter by parameter, and the run button. **GitLab CI and
  GitHub Actions are still to do**, and are the remaining half of this item.
- **See what version runs where** — a clear view of which build is deployed on each environment, so "is my
  fix live?" is answered at a glance.

## Objective convergence anchors

Make the autonomous convergence loop exit on **objective signals**, not only the AI's own score: wire
**lint / typecheck / tests** in as loop exit criteria, so a session converges when the code actually passes
the project's own gates — not merely when the model is satisfied with it.

Half of the ground is now covered: **verifiers** run the project's own commands and give a verdict that
owes nothing to the model, a coding session can carry one and run it when it is done, and a verifier can
fire by itself on every new merge request (1.2.0). Since 1.3.0 that verdict also **leaves the tool**: it
publishes as a comment on the merge request, mentions the people who need to know when it breaks, re-runs
when it goes stale, and can be asked of a **branch with no merge request at all**. What remains is the
wiring itself — making that verdict an **exit condition of the convergence loop**, instead of a check that
runs beside it.
