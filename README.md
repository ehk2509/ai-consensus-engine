# AI Consensus Engine

**One idea. Multiple intelligences. A better-informed decision.**

A local-first multi-AI brainstorming application that gathers independently reasoned proposals from OpenAI Codex, Claude Code, and Gemini (via the Antigravity CLI).

> **Current milestone: M1 foundation.** Independent proposals only. Cross-review, rebuttals, voting and consensus are **not yet implemented**.

## Setup

Requires **Node.js 22.12+** plus the CLIs you plan to use. Install and authenticate **codex**, **claude**, and **agy** (Antigravity CLI) using each provider's official instructions. Gemini CLI no longer supports Google OAuth login, so Gemini is reached through Antigravity: run `agy` once interactively to sign in. Existing consumer subscriptions do not necessarily include separate API access. Each CLI uses its own local authentication state and usage limits.

1. Install dependencies: `npm install`
2. Launch the UI and local API: `npm run dev`
3. Open http://127.0.0.1:5173
4. Enter an idea, choose your providers, and run your first independent brainstorm.

To run checks: `npm test`, `npm run typecheck`, `npm run build`.

## API

API listens **only on 127.0.0.1:8787**.

- `GET /api/health`: status and version
- `GET /api/providers`: CLI installation probes; these **do not verify authentication**
- `POST /api/brainstorms`: parallel initial proposals

Example:

```bash
curl -sS http://127.0.0.1:8787/api/brainstorms \
  -H 'content-type: application/json' \
  -d '{"prompt":"Evaluate an AI startup idea and its biggest risks.","providers":["codex","claude","gemini"]}'
```

The response includes a run ID, timestamps, per-provider responses or sanitized errors, and status `completed`, `partial`, or `failed`. Only one brainstorm can execute per API process at a time.

## Project structure

- `apps/web`: Vue 3 / Vite interface
- `apps/api`: Fastify API and local CLI process adapters
- `packages/core`: provider contracts and parallel coordinator
- `tests`: Node built-in test runner (validation, parallelism, error handling, process safety)
- `.github/workflows/ci.yml`: tests, typecheck and build

## Security limitations (M1)

- Local development only: **do not expose the unauthenticated API to the internet**. The remote frontend command has been disabled because Vite's /api proxy could otherwise make local endpoints accessible over the network.
- CLI processes are launched without a shell from empty temporary directories; prompts are piped over stdin.
- Codex is requested to run with a read-only sandbox, Claude built-in/MCP tools are disabled, and Gemini runs through Antigravity in plan mode with its terminal sandbox enabled.
- These settings are **not a hardened isolation boundary**: local CLI extensions, hooks and user configuration can still introduce side effects. Do not run untrusted CLI configurations. Do not give sensitive ideas to untrusted providers.
- The app does not request, copy or store CLI account tokens. Providers can still consume subscription quotas or incur charges.
- Individual provider failures and timeouts are returned as sanitized errors, not raw stderr.

## Roadmap

- **M1** — Independent provider integration and parallel proposals, local UI, safety guards, tests.
- **M2** — Critique, rebuttal and revision rounds, durable session state, live debate events.
- **M3** — Consensus votes, unresolved objections, synthesis reports and evidence.
- **M4** — Authentication, durable workers, API adapters, cost control, production hardening and benchmarks.

The main product goal is **a defensible, traceable conclusion, not forced unanimity**.
