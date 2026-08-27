# Project rules

- When making design changes, keep in mind there is a dark mode and a light mode, configurable from the Settings menu.

- In every list where projects are selected, make sure there is a search field — the number of projects can be high.

- Same rule for **branches and tags**, for the same reason in worse: an active repository has hundreds. A single choice uses `comboHtml`/`wireCombo`; a multiple choice (checkbox list, table) gets a filter that *hides* rows without unticking anything. `npm run check` fails when one of these search fields disappears.

- Keep in mind the app is multilingual (French / English).

- The app supports **both GitLab and GitHub**, repository by repository (`repo.forge`). Never call `src/gitlab.js` or `src/github.js` directly from other modules: always go through `src/forge.js` (`clientFor(repo)`). Both clients expose the same interface and the same normalized shapes.

- When adding a field to the settings form (`#configForm` in `public/index.html`), **always add it to `CONFIG_FIELDS` in `public/app.js` too**. Loading and saving both iterate over that whitelist: a field missing from it displays, accepts input and is silently never saved. `npm run check` fails when this is forgotten.

- The same field also has to be declared **twice in `src/config.js`**: in `ALLOWED` (what the server accepts) *and* in the `UPDATE config SET` statement (what it writes). Miss the second one and the route answers 200, the screen says "saved", and the value is nowhere. `npm run check` fails when a field is accepted but never written.

- A migration in `src/db.js` (`try { db.exec('ALTER TABLE x …') } catch {}`) must sit **after** the `CREATE TABLE x` it patches. Placed before, it throws on a table that does not exist yet and the empty `catch` swallows it — the column then exists only on databases where the table predated the migration. Everything works on your own database and breaks on a fresh one. The same `catch {}` hides a typo in the SQL: after adding a migration, check the column on a **brand new** database (`MERGERIE_DATA_DIR=$(mktemp -d) node -e "require('./src/db')"` then `PRAGMA table_info`), not on `data-demo/`.

- A form that exists in several flavours has several wirings. The session modal is shared between coding, exploration **and** out-of-repo, but the out-of-repo path has its **own** submit and its **own** read-back (`openLocalTaskEdit`, `/api/local-tasks`). Adding a field means wiring it in each one — and proving it in each one. Testing a field through the API proves the API, never the form.

- After each development, add tests. Prefer end-to-end tests so refactoring stays easy without regressions; where end-to-end is not relevant/possible, add unit tests.

- When you add features, remember to update README.md, PLAN.md, the demo mode, and add an entry under `## [Unreleased]` in CHANGELOG.md (user-facing wording, not the commit message).

- **A green local suite does not mean a green CI.** The GitHub runner has **2 cores**; this
  machine runs the whole suite in ~80 s where the runner takes ~5 min. Every test that assumes
  "the assertion runs before the screen re-renders / before the job finishes" passes here and
  fails there. Before declaring a change done, replay the suite **under the runner's
  conditions** — from `git archive HEAD`, so an untracked file cannot mask a missing one:

  ```bash
  rm -rf /tmp/ci && mkdir -p /tmp/ci && git archive HEAD | tar -x -C /tmp/ci
  printf 'set -e\ncd /app\nexport PLAYWRIGHT_BROWSERS_PATH=/ms-playwright\nnpm ci --no-audit --no-fund >/dev/null\nnpx playwright install --with-deps chromium >/dev/null\nnpm test\n' > /tmp/ci/run.sh
  docker run --rm --cpus 2 -v /tmp/ci:/app -w /app node:22 bash /app/run.sh
  ```

  **`npm ci` BEFORE `npx playwright install`, and read the test count.** The other way round,
  `npx` downloads some Playwright version and installs ITS chromium; `npm ci` then lays down the
  project's own, which looks for a different revision, does not find it, and **every screen test
  skips itself** — `# skipped 8` (whole `describe` blocks), `tests 736` instead of 926, and a big
  `fail 0`. A replay that "passes" without ever opening a browser proves nothing about what you
  came to check. So the test count is the first number to compare against the local suite, and
  `node -e "console.log(require('playwright').chromium.executablePath())"` in the script says it
  before anything runs.

  To replay work that is **not committed yet** (the normal case here, since commits come last),
  `git archive HEAD` archives the version from BEFORE and replays it for nothing: use
  `C=$(git stash create); git archive ${C:-HEAD}`, which makes a commit of the working tree
  without touching it.

  A cheaper first filter: run the file under CPU load (`for i in $(seq 8); do (yes >/dev/null &); done`,
  then `pkill yes`). It catches the coarsest races in seconds.

- **Never assert on a state the screen is allowed to leave.** This is the single cause of every
  CI break so far, and each one looked like an application bug at first read:
  - **`check()` / `uncheck()` re-read the control after clicking.** On a row that disappears on
    success (ticking a todo removes it from "to do"), the re-read can never succeed. Use
    `click()`, then assert the **effect** (the row is gone, the badge dropped).
  - **`waitForTimeout(n)` is a bet on the machine's speed.** Wait for the effect instead:
    `waitForFunction`, `waitFor({ state })`, or poll the API until the server holds the value.
    Saving then reloading 300 ms later loses the save on a loaded runner — and the failure
    then accuses the feature, not the clock.
  - **The screen's wording is not the server's state.** "Saving…" and "Saved" both match
    `/enregistr/`; autosave fires ~1 s after the last keystroke. To prove something was stored,
    read it back from the API, not from a label.
  - **A job can finish before you can stop or observe it.** `POST /api/jobs/stop` legitimately
    answers 409 ("nothing to stop") when the job is already done. Accept both outcomes and
    assert the invariant that actually matters.
  - **A card that re-renders every 1.5 s invalidates element handles.** Re-resolve locators
    inside the wait; never hold a handle across an action that triggers a reload.
  - **A screen that is CREATED then re-rendered hands you the previous one first.** "New page"
    posts, reloads the list, then rewrites the editor: between the two, `#pageContent` is still
    the *previous* page's textarea, and what you type there leaves with it at the next render.
    Waiting for the selector proves nothing — wait for something only the NEW screen satisfies
    (an empty field where the old one was full), then check what you typed actually landed.
  - `test/` holds **no `waitForTimeout` at all** any more — the 38 that existed were replaced
    by waits on the effect. Do not reintroduce one: if you cannot name the effect to wait for,
    the test does not know what it is proving.

- **One `startApp()` per test file.** The harness starts the server **in-process**: a second
  call in the same file returns the already-stopped instance and waits for a `listening` event
  that will never come — the file then times out instead of failing, which reads like a hang.
  Several `describe` blocks in one file must share the same app and the same browser.
