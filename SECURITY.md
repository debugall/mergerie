# Security Policy

Mergerie is a **local** tool: it runs on your own machine, with your own credentials. By default the server
listens **only on `localhost`** (`127.0.0.1`); exposing it (`HOST=0.0.0.0`) **requires an access token**.
Requests from another site are refused (`Host` allowlist against DNS rebinding, `Sec-Fetch-Site`, CSP —
`src/app/middleware/origine.js` and `entetes.js`, mounted first by `src/server.js`). On `localhost`, a
second, purely local token (`src/app/middleware/jeton-local.js`, mounted right after) closes the same API
to any process on the machine that isn't the browser it was served to — an agent's own shell, a verifier
command, a script run by a dependency under test.
Anything that **runs code** and arrives through the shared data repository — verifier commands, agent
permissions, automatic reviews — **waits for approval on each machine**; the sync itself runs with the same
hardened git calls as a code clone. The AI agent runs **read-only** for reviews and explorations (or is
refused outright rather than assumed restricted, on a backend that cannot prove it), and when it codes runs
under a CLI-level sandbox — verified by a real test call before it is ever relied on, never a checkbox — or
else a command allowlist; it never sees the forge token. Text from elsewhere reaches it framed as data, and
every protocol block the agent emits (findings, questions, the repository it names, the agent it proposes)
carries the nonce of the run that asked for it, so a crafted piece of text can't forge one.

The full trust model — access, approval, agent permissions and their limits, prompt injection, verifiers,
secrets, no-shell execution, targeted guards, served files, destructive operations — is documented in the
**[security section of the guide](./docs/guide.en.md#security)** (also
**[in French](./docs/guide.fr.md#sécurité)**).

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.** Public disclosure before a fix puts every
user at risk.

Instead, report it **privately** by email to **`security@mergerie.dev`**. Include, if you can:

- a description of the vulnerability and its impact;
- the steps to reproduce it (a minimal proof of concept helps);
- the affected version or commit.

We aim to acknowledge your report within **72 hours** (indicative, not contractual) and will keep you posted
as we investigate and prepare a fix. Once a fix is available, we're happy to credit you in the release notes
unless you prefer to stay anonymous.

Thank you for helping keep Mergerie and its users safe.
