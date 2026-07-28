# Project rules

- When making design changes, keep in mind there is a dark mode and a light mode, configurable from the Settings menu.

- In every list where projects are selected, make sure there is a search field — the number of projects can be high.

- Keep in mind the app is multilingual (French / English).

- The app supports **both GitLab and GitHub**, repository by repository (`repo.forge`). Never call `src/gitlab.js` or `src/github.js` directly from other modules: always go through `src/forge.js` (`clientFor(repo)`). Both clients expose the same interface and the same normalized shapes.

- When adding a field to the settings form (`#configForm` in `public/index.html`), **always add it to `CONFIG_FIELDS` in `public/app.js` too**. Loading and saving both iterate over that whitelist: a field missing from it displays, accepts input and is silently never saved. `npm run check` fails when this is forgotten.

- After each development, add tests. Prefer end-to-end tests so refactoring stays easy without regressions; where end-to-end is not relevant/possible, add unit tests.

- When you add features, remember to update README.md, PLAN.md, the demo mode, and add an entry under `## [Unreleased]` in CHANGELOG.md (user-facing wording, not the commit message).
