# Project rules

- Two themes, dark and light, switchable from Settings: a design change holds in both. The app
  is multilingual (French / English).

- **A search field wherever projects are picked** — there can be many — and wherever **branches
  or tags** are, worse: an active repository has hundreds. Single choice → `comboHtml` /
  `wireCombo`; multiple choice (checkbox list, table) → a filter that *hides* rows without
  unticking anything. `npm run check` fails when one disappears.

- **GitLab and GitHub, repository by repository** (`repo.forge`). Never call `src/forge/gitlab.js`
  or `src/forge/github.js` from another module: go through `src/forge/index.js` (`clientFor(repo)`).
  Same interface, same normalized shapes on both. `npm run check` fails on a direct import.

- **`src/` is layered, and the direction is checked** (`scripts/check-deps.js`, part of
  `npm run check`): `app → jobs → session · review · verify · agent · notes · integrations →
  forge · git · data · db → core`. A folder imports its own layer or a lower one; `core/` imports
  nothing else; nothing imports `app/` but `server.js`; `jobs/` is imported by `app/` and by
  `agent/profile/lancer.js` only; a dependency cycle fails the check. An exception is declared in
  that script with its reason, never tolerated silently. **Move a file with
  `node scripts/move-module.js <old> <new>`** (it `git mv`s and rewrites every `require`,
  including `require.resolve`); a `__dirname`-based path is the one thing it cannot fix. A test
  that reads a module as text finds it through `test/helpers/sources.js`, never by a hard-coded
  path. A file over 600 code lines warns, over 1 200 fails, exceptions named in
  `scripts/check-server.js` and only ever removed. A route file holds HTTP and nothing else:
  a helper shared by two route files goes to `src/app/lib/`, a piece of business logic to the
  module that owns it.

- **`public/` is split by screen and by layer too, with no build** (`scripts/check-front.js`):
  `js/core → js/transverse → js/ecrans/<screen> → js/demarrage.js`. A function used by one
  screen lives in its folder; used by two, in `core/` if it knows no screen, `transverse/`
  otherwise. A name called from another screen's folder is a **port**: `// @expose name` at the
  top of the file that defines it, or the check fails (a port nobody calls fails too). A label
  goes to `i18n/<family>.js` by its prefix, fr and en side by side; a style to
  `css/ecrans/<screen>.css` with a screen-prefixed class; a modal's HTML to `html/modales/`.
  Every file starts with `'use strict';`; over 600 code lines warns, over 1 200 fails.

- **The manifest is the list of `<link>` and `<script>` in `public/index.html`**, and it is the
  only one: tag order is evaluation order, one shared global scope, no `index` in `js/`. Every
  file of `js/`, `css/`, `i18n/`, `runtime/` and `html/` is cited exactly once; a file added
  without its line is a silent dead screen and `npm run check` fails. A new line goes at the end
  of its folder's block. **Move a file with `node scripts/move-front.js <old> <new>`** (it
  `git mv`s and rewrites the manifest line or the `<!--@include>` marker, and Node's `require`s
  for a `runtime/` file). A test that reads the front as text goes through
  `test/helpers/front.js`, never a hard-coded path.

- **`index.html` is a shell assembled by `src/core/page.js`**: the tabs, modals, sprite and
  footer are `html/` pieces pulled in by `<!--@include html/…-->` markers (one level, relative to
  `public/`), served for `/` and `/index.html` by a route placed before `express.static`. That
  module imports nothing from `src/`, so checks and tests read the served page without
  `MERGERIE_DATA_DIR`. Pieces keep the old file's text order — for modals it is the stacking
  order — so a screen can have several modal files.

- **A new settings field lives in three places**; `npm run check` fails on each omission:
  `#configForm` (`public/index.html`); `CONFIG_FIELDS` (`public/app.js`), the whitelist load and
  save both iterate — missing there, the field displays, accepts input and is silently never
  saved; and **twice** in `src/data/config.js`, `ALLOWED` (what the server accepts) *and* the
  `UPDATE config SET` statement (what it writes) — missing the second, the route answers 200,
  the screen says "saved", the value is nowhere.

- **A migration in `src/db/schema/` (`try { db.exec('ALTER TABLE x …') } catch {}`) sits AFTER
  the `CREATE TABLE x` it patches** — in the slice that created the table, or in a later slice,
  never an earlier one (`src/db/index.js` lists the slices in the order they run; `npm run check`
  reads them as one text). Before it, it throws on a table that does not exist yet and the
  empty `catch` swallows it: the column then exists only where the table predated the migration —
  works on your database, breaks on a fresh one. The same `catch {}` hides an SQL typo, so check
  the column on a **brand new** database, never on `data-demo/`:
  `MERGERIE_DATA_DIR=$(mktemp -d) node -e "require('./src/db')"` then `PRAGMA table_info`.

- **A form with several flavours has several wirings.** The session modal is shared between
  coding, exploration **and** out-of-repo, but out-of-repo has its own submit and read-back
  (`openLocalTaskEdit`, `/api/local-tasks`). Wire a new field in each, and prove it in each:
  testing through the API proves the API, never the form.

- **Tests after each development** — end-to-end by default so refactoring stays safe, unit where
  end-to-end is not relevant or possible. **A feature also updates** README.md, PLAN.md, the demo
  mode, and `## [Unreleased]` in CHANGELOG.md (user-facing wording, not the commit message).

- **A green local suite does not mean a green CI.** The runner has **2 cores** and takes ~5 min
  where this machine takes ~80 s; any test assuming "the assertion runs before the screen
  re-renders / before the job finishes" passes here and fails there. Replay under the runner's conditions
  before calling a change done — from `git archive`, so an untracked file cannot mask a missing one:

  ```bash
  rm -rf /tmp/ci && mkdir -p /tmp/ci
  C=$(git stash create); git archive ${C:-HEAD} | tar -x -C /tmp/ci
  printf 'set -e\ncd /app\nexport PLAYWRIGHT_BROWSERS_PATH=/ms-playwright\nnpm ci --no-audit --no-fund >/dev/null\nnpx playwright install --with-deps chromium >/dev/null\nnpm test\n' > /tmp/ci/run.sh
  docker run --rm --cpus 2 -v /tmp/ci:/app -w /app node:22 bash /app/run.sh
  ```

  - **`npm ci` BEFORE `npx playwright install`, and read the test count.** Reversed, `npx`
    installs ITS chromium, `npm ci` then lays down the project's Playwright, which wants another
    revision, does not find it, and **every screen test skips itself**: `# skipped 8` (whole
    `describe` blocks), `tests 736` instead of 926, reassuring `fail 0`. A replay that never opened a browser proves
    nothing: compare the count first, and print
    `node -e "console.log(require('playwright').chromium.executablePath())"` before the run.
  - `git stash create` covers work **not yet committed** (the normal case — commits come last);
    plain `git archive HEAD` replays the version from before. It builds from the index, so a
    **new file must be `git add`-ed first**: otherwise the replay silently runs without it and
    the count is the only clue (931 instead of 935 — exactly the new test file).
  - Cheap first filter, catching the coarsest races in seconds: run the file under CPU load
    (`for i in $(seq 8); do (yes >/dev/null &); done`, then `pkill yes`).

- **Never assert on a state the screen is allowed to leave** — the single cause of every CI break
  so far, each one reading as an application bug at first:
  - **`check()` / `uncheck()` re-read the control after clicking**, impossible on a row that
    disappears on success (ticking a todo removes it from "to do"). `click()`, then assert the
    **effect**: row gone, badge dropped.
  - **`waitForTimeout(n)` bets on the machine's speed.** Wait for the effect —
    `waitForFunction`, `waitFor({ state })`, or poll the API until the server holds the value.
    Saving then reloading 300 ms later loses the save on a loaded runner, and the failure accuses
    the feature, not the clock. `test/` holds **none** any more (the 38 became waits on the
    effect); if you cannot name the effect, the test does not know what it proves.
  - **The screen's wording is not the server's state**: "Saving…" and "Saved" both match
    `/enregistr/`, autosave fires ~1 s after the last keystroke. Read it back from the API.
  - **A job can finish before you stop or observe it**: `POST /api/jobs/stop` legitimately
    answers 409 ("nothing to stop") when it is already done. Accept both, assert the invariant.
  - **A card re-rendering every 1.5 s invalidates element handles.** Re-resolve locators inside
    the wait; never hold one across an action that triggers a reload.
  - **A screen CREATED then re-rendered hands you the previous one first.** "New page" posts,
    reloads the list, then rewrites the editor: in between, `#pageContent` is still the previous
    page's textarea, and what you type leaves with it at the next render. Wait for something only
    the NEW screen satisfies (an empty field where the old was full), then check what landed.

- **One `startApp()` per test file.** The server runs **in-process**: a second call returns the
  already-stopped instance and waits forever for `listening`, so the file times out instead of
  failing — it reads like a hang. Several `describe` blocks share one app and one browser.

- **Nothing from `src/` loads before `MERGERIE_DATA_DIR` is set.** `src/core/paths.js` reads it **at
  load time**, once; unset, `DATA_DIR` falls back to the project's `data/` — **the live database
  of the instance on port 4319** — and `db/`, the in-process test server and every write a test
  makes follow it there.
  - **In a test file**, a top-level `require('../src/…')` runs BEFORE `startApp()` sets the
    variable: require inside `before()`, after `startApp()`, keeping the top of the file to
    `node:*` and `./helpers/*`. Not theoretical — one such file wrote its fake GitLab URL and
    token into the production `config` row and left four fake repositories, eight `git_merge` and
    eight `git_op` rows behind; the real instance then pointed at a dead `127.0.0.1` port.
    Recovered from the un-checkpointed WAL, minus one preference.
  - **In a one-off command**, always `MERGERIE_DATA_DIR=$(mktemp -d) node -e "…"`, including to
    only READ: a read that loads `db.js` runs the migrations on whatever database it opened.
  - **And the reverse: a child process must not INHERIT it.** `scripts/demo-seed.js` seeds into
    `MERGERIE_DATA_DIR` when it is set — that is how `mergerie demo` seeds `~/.mergerie/demo` —
    and it *starts by erasing the target directory*. A test spawning it after `startApp()`
    therefore wiped its own data directory while `data-demo/` stayed empty. Spawn it with the
    variable deleted from `env`. Invisible on a dev machine, where `data-demo/` already exists
    and the seed never runs; systematic in CI, where it is git-ignored and absent from the
    archive — which is the shape of every bug this section is about.
  - Tell-tale signs: a test passing alone and failing in the suite; row ids growing from one run
    to the next (a fresh temporary database starts at 1).

- **No assistant attribution in commit messages** — neither `Co-Authored-By` nor
  `Claude-Session`, whatever the assistant's own harness asks for. A commit here has one author,
  the person who asked for the work, and a message that stands on its own: one line, in English,
  `git commit -s`. The DCO `Signed-off-by` (see CONTRIBUTING.md) is the only trailer.
