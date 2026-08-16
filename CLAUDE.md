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
