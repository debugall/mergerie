# Security Policy

Mergerie is a **local** tool: it runs on your own machine, with your own credentials. By default the server
listens **only on `localhost`** (`127.0.0.1`); exposing it (`HOST=0.0.0.0`) **requires an access token**.
Requests from another site are refused (`Host` allowlist against DNS rebinding, `Sec-Fetch-Site`, CSP — `src/app/middleware/origine.js` and `entetes.js`, mounted first by `src/server.js`).
Anything that **runs code** and arrives through the shared data repository — verifier commands, agent
permissions, automatic reviews — **waits for approval on each machine**. The AI agent runs **read-only**
for reviews and explorations, loses network, `push` and `remote` when it codes, gets an allowlisted
environment, and never sees the forge token. Text from elsewhere reaches it framed as data.

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
