# AI Consensus Engine

**One idea. Multiple intelligences. A better-informed decision.**

Local-first, multi-provider brainstorming and structured AI deliberation powered by your installed **OpenAI Codex**, **Claude Code**, and **Gemini through Antigravity** CLI sessions.

> **Current milestone: M2 — iterative debate, NOT final consensus.** M1's independent brainstorming remains available. M2 adds targeted peer critique, individual rebuttals, full revisions, local session history, and live updates. Consensus voting and consolidated verdicts will be delivered in M3.

## Quick start

Requires Node.js **22.12+** and at least two authenticated CLI providers. Authenticate your local `codex`, `claude` and `agy` executables independently. Gemini uses the locally authenticated Antigravity CLI instead of the standard Gemini CLI.

```bash
npm install
npm run dev
# Open http://127.0.0.1:5173
```

Select **Multi-round debate**, pick two or three agents, enter an idea and choose 1–3 rounds (default 1). For a quick side-by-side response without further agent calls, switch to **Independent proposals**. Remote Vite development is deliberately disabled: proxying the unauthenticated API through a public Vite listener would expose privileged operations.

## How M2 debates work

1. **Independent proposals** — each selected provider answers the original idea without seeing peer responses.
2. **Peer critiques** — each successful provider reviews every other successful proposal separately. It must identify strengths, risky assumptions, and concrete improvements.
3. **Rebuttals** — each provider sees criticism targeting its own proposal and responds point by point.
4. **Full revisions** — each provider improves its proposal while preserving unresolved disagreements.
5. **Optional additional rounds** — the latest successfully revised proposal is used as the next round's input.

Each targeted critique requests structured JSON objections, with stable IDs and rebuttal resolutions (accepted, partially accepted, rejected, unresolved). Unparseable answers are kept as explicit unstructured/unresolved objections, never converted to assumed agreement.

Critiques for one provider are deliberately serialized to avoid launching multiple concurrent sessions under that same CLI account; different providers can work in parallel. When a provider fails, the session keeps successful results and does not invent missing replies. If fewer than two initial proposals succeed, no debate is attempted. **Unanimity is neither calculated nor asserted in M2.**

**Usage:** with three providers, a single round makes up to 15 model calls (3 proposals, 6 targeted critiques, 3 rebuttals, 3 revisions). Two rounds can make up to 27 calls. Each call can consume account quota or incur costs depending on your CLI and provider terms. A debate defaults to a **40-call** and **15-minute** total budget, configurable up to 40 calls and 30 minutes; budget exhaustion is reported distinctly. Cancel an active session using the UI or API.

## API

The Fastify API listens on `127.0.0.1:8787` and is unauthenticated: do not expose it to the internet.

- `GET /api/health` — health
- `GET /api/providers` — binary presence only (not account authentication)
- `POST /api/brainstorms` — backwards-compatible M1 independent proposals
- `POST /api/debates` — create an async M2 session, returns HTTP 202 with `id`
- `GET /api/debates` — recent local sessions
- `GET /api/debates/:id` — full timeline and stage outputs
- `GET /api/debates/:id/events` — server-sent live update notifications with increasing sequence IDs
- `POST /api/debates/:id/cancel` — cancel current debate (202), or 409 if it already stopped

Example:

```bash
curl -sS http://127.0.0.1:8787/api/debates \
  -H 'content-type: application/json' \
  -d '{"prompt":"Evaluate an AI startup factory idea and its risks.","providers":["codex","claude","gemini"],"maxRounds":1}'
```

Poll `GET /api/debates/<returned id>`, or subscribe to the SSE endpoint and refetch the session on each `update` event.

## Data and restart behavior

Snapshots are atomically persisted after each stage and each agent response, by default under `.ace-data/debates/<uuid>.json`, which is gitignored. Override storage with `ACE_DATA_DIR=/private/path`. Session files contain the original idea, proposals, structured objections, critiques, rebuttals and revisions **in plain text**; protect this folder if your ideas are confidential.

A process restart during an unfinished session preserves completed responses but marks the old run **interrupted** when loaded. Cancelling or exceeding a time/call budget terminates active CLI process groups where supported and preserves the partial timeline. **Automatic execution resume and cancellation are M4 work, not M2 features.** In M2 only one session can execute at a time per API process.

## Limits and security

- Prompts are sent via stdin, never shell-interpolated. The CLI accounts and auth tokens are not copied into the app.
- CLI processes run in empty temporary directories with best-effort read-only / plan-mode limitations. User-configured CLI hooks, extensions and tools may still have side effects; **this is not a hardened sandbox**.
- Provider material is delimited and explicitly labeled untrusted. This mitigates but cannot eliminate prompt injection.
- Incoming user prompts are limited to 12,000 characters. Outputs stored for each turn are capped at 25,000 characters and peer context is further bounded; trimming is labeled.
- Execution limits are per CLI invocation and per complete debate; each round may take several minutes. Higher round counts greatly increase total calls and quota consumption.
- Responses are displayed as sanitized Markdown with DOMPurify. Raw provider stderr is never sent to clients.

## Development and CI

```bash
npm ci
npm test
npm run typecheck
npm run build
```

Tech stack: Fastify, Vue 3/Vite, TypeScript, Node test runner, local CLI adapters and atomic JSON session persistence. GitHub Actions runs tests, typecheck and build for PRs.

## Roadmap

- **M1:** Three independent providers, parallel proposals and local UI — implemented
- **M2:** Cross-review, rebuttals, revisions, history and live progress — implemented in this PR
- **M3:** Explicit voting, evidence, disagreements and qualified consensus reports
- **M4:** Production-grade authentication, cancellation/resume, durable worker queue, CLI isolation, API adapters, quotas and benchmarks

The goal is a **traceable, defensible decision**, not artificial agreement.
