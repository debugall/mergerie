# Security Policy

Mergerie is a **local, single-user** tool: it runs on your own machine, with your own credentials, and by
default the server listens **only on `localhost`** (`127.0.0.1`). The full trust model — AI agent permissions
(« yolo » mode), secret handling, no-shell execution, anti-injection guards, XSS handling, restorable
destructive operations — is documented in the
**[detailed security section of the guide](./docs/guide.fr.md#sécurité)** (French for now).

**Voice dictation** is off by default and, once on, sends audio only where the provider you picked
sends it — the screen says which before you choose. With the recommended **local** engine
(whisper.cpp) the audio goes from the browser to the server on `localhost`, then to the engine bound
to `127.0.0.1`: it is never written to disk nor logged, and its WAV header is validated before any
relay. The engine is spawned **without a shell**, with a minimal environment carrying **no token**,
and the install button only runs the repository's own script, at a fixed path, with a model taken
from a closed list.

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
