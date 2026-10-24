# AI Consensus Engine

**One idea. Multiple intelligences. A better-informed decision.**

Local-first, multi-provider brainstorming and structured AI deliberation powered by your installed **OpenAI Codex**, **Claude Code**, and **Gemini through Antigravity** CLI sessions.

> **Current release: M5.5 — complete synthesis integrity and auditable objection coverage (v0.5.5).** The council supports independent proposals, multi-round critique, a traceable synthesis, independent voting, bounded negotiation, and explicit checkpoint-safe recovery. Agreement is never fabricated when ballots fail or critical concerns remain. Unlimited applies to the *overall session*, not provider accounts or individual CLI timeouts.

## Quick start

Requires Node.js **22.12+** and at least two authenticated CLI providers. Authenticate your local `codex`, `claude` and `agy` executables independently. Gemini uses the locally authenticated Antigravity CLI instead of the standard Gemini CLI.

```bash
npm ci
npm run dev
# Open http://127.0.0.1:5173
```

Select **Multi-round debate**, pick two or three agents, enter an idea and choose 1–3 rounds (default 1). **Execution budget is Unlimited by default**; uncheck *Unlimited calls and session duration* to enter your own Max calls and Minutes. The UI enables independent consensus voting and one negotiation cycle by default. **M5.4 adds a 10-minute synthesis CLI timeout by default** (configurable 30 seconds to 30 minutes) and an opt-out, journaled fallback to another selected provider if synthesis fails. Unlimited removes overall caps, not individual CLI timeouts. For a quick side-by-side response without further agent calls, switch to **Independent proposals**. Remote Vite development is deliberately disabled: proxying the unauthenticated API through a public Vite listener would expose privileged operations.

## Documentation

- [Execution budget](docs/EXECUTION_BUDGET.md) — unlimited defaults, finite custom limits, API compatibility, quota safeguards, examples and troubleshooting
- [Safe resume and recovery](docs/RECOVERY.md) — preserving checkpoints, explicit call retries, deadline differences and HTTP 409 recovery errors

## How M2 debates work

1. **Independent proposals** — each selected provider answers the original idea without seeing peer responses.
2. **Peer critiques** — each successful provider reviews every other successful proposal separately. It must identify strengths, risky assumptions, and concrete improvements.
3. **Rebuttals** — each provider sees criticism targeting its own proposal and responds point by point.
4. **Full revisions** — each provider improves its proposal while preserving unresolved disagreements.
5. **Optional additional rounds** — the latest successfully revised proposal is used as the next round's input.

Each targeted critique requests structured JSON objections, with stable IDs and rebuttal resolutions (accepted, partially accepted, rejected, unresolved). Unparseable answers are kept as explicit unstructured/unresolved objections, never converted to assumed agreement.

Critiques for one provider are deliberately serialized to avoid launching multiple concurrent sessions under that same CLI account; different providers can work in parallel. When a provider fails, the session keeps successful results and does not invent missing replies. If fewer than two initial proposals succeed, no debate is attempted. **Unanimity is neither calculated nor asserted in M2.**

**Usage:** with three providers, a single round normally needs up to 15 debate calls (3 proposals, 6 targeted critiques, 3 rebuttals, 3 revisions); two rounds up to 27, three up to 39. Consensus synthesis and voting require more calls, and negotiation/clarification/sign-off can add further calls. **New runs have no overall model-call or duration cap by default.** Disable Unlimited to set 2–10,000 maximum model calls and 1–10,080 total minutes (UI limits). Provider-level timeouts, account quotas and potential charges still apply in unlimited mode. Cancel an active session using the UI or API. Read [Execution budget](docs/EXECUTION_BUDGET.md) before starting expensive runs.

## API

The Fastify API listens on `127.0.0.1:8787`. Its actual server entrypoint requires a local API token (automatically generated and saved to `.ace-data/api-token` when `ACE_API_TOKEN` is unset). The UI exchanges the token for a 12-hour HttpOnly cookie. Do not expose the server to a network.

- `GET /api/health` — health (public)
- `POST /api/auth/login`, `GET /api/auth/status` — authenticate using a local token
- `GET /api/metrics` — authenticated queue depth and worker counters
- `GET /api/providers` — binary presence only (not account authentication)
- `POST /api/brainstorms` — backwards-compatible M1 independent proposals
- `POST /api/debates` — create an async M2 session, returns HTTP 202 with `id`
- `GET /api/debates` — recent local sessions
- `GET /api/debates/:id` — full timeline and stage outputs
- `GET /api/debates/:id/events` — server-sent live update notifications with increasing sequence IDs
- `POST /api/debates/:id/cancel` — cancel active or queued debate
- `POST /api/debates/:id/resume` — explicit recovery, with acknowledged retry IDs for uncertain calls
- `GET /api/debates/:id/report` — download recorded M3 decision report as Markdown (409 when absent)

Example:

```bash
curl -sS http://127.0.0.1:8787/api/debates \
  -H 'content-type: application/json' \
  -d '{"prompt":"Evaluate an AI startup factory idea and its risks.","providers":["codex","claude","gemini"],"maxRounds":1}'
```

Poll `GET /api/debates/<returned id>`, or subscribe to the SSE endpoint and refetch the session on each `update` event.

## M3 voting, safety and consensus rules

Turn on **Generate independent consensus votes** (enabled by default in the Vue interface). The `POST /api/debates` API keeps backwards-compatible M2 behavior unless `"consensus":true` is supplied. Set `"quorum":"unanimous"` (default) or `"quorum":"two_thirds"`, and `"blockCritical":true` (default). Each complete debate generates one frozen shared draft, then every selected model independently votes `accept`, `conditional`, or `reject`. Only strict `accept` ballots with empty concerns, valid structured fields, and no contradictions count toward quorum. Missing or malformed votes yield `incomplete`, never consensus. The synthesis facilitator rotates by session and its self-authored acceptance **cannot substitute for sufficient independent non-author acceptance**; the self-authored vote is labeled in the report.

High-severity and unstructured objections from **every debate round** remain open until their original authors confirm resolution in a valid accept ballot or explicitly supersede them with a newer authored objection. A target model's self-reported rebuttal is not proof of resolution. A malformed nonempty critique list becomes an unresolved objection instead of disappearing. With the critical gate disabled, unresolved concerns remain visible and downloadable but do not block the selected voting policy. Outcomes are `unanimous`, `qualified`, `disputed`, `blocked`, `incomplete` or `not_assessed`. All dissent and objection IDs remain visible.

With three models and one round, the debate plus initial synthesis/voting normally takes **19 calls** (15 debate + 1 draft + 3 ballots). Three rounds alone can require 39 calls before voting, which **unlimited mode permits**. A **custom finite** budget that cannot accommodate synthesis or voting may yield `not_assessed`; additional negotiation, clarification and sign-off calls must also fit within the configured budget. Limits are never silently increased.

Every session keeps separate `debateStatus`, live execution `status` and `consensus.status` fields. The session JSON also retains bounded raw model ballots and facilitator output, SHA-256 hashes of the frozen draft and prompts, and provenance `model:unreported` when the CLI does not expose a trustworthy model label. These are **local plaintext records**, so protect the data folder.

Evidence claims in a generated draft are recorded as **unverified**. The app does not independently browse, validate references or treat multiple-model agreement as factual truth. A final Markdown decision record is created for **every consensus attempt**, including missing votes, invalid drafts, cancellation, and insufficient budget. The report records unresolved critical concerns, gate policy, facilitator self-vote and dissent; downloadable from `GET /api/debates/:id/report` (409 if unavailable).

## M5.5 complete synthesis integrity

The system no longer freezes or sends a clipped model-authored synthesis to voters. A fully parseable JSON draft that exceeds 18,000 characters, or contains a truncation sentinel, is rejected and journaled; selected-provider fallback can attempt a new complete draft. M5 targeted revisions and negotiated re-syntheses have the same integrity check. To reduce avoidable failures, facilitator instructions request concise, complete decisions rather than a very long per-ID ledger. The downloaded decision report independently lists **all recorded objection IDs and statuses directly from persisted structured data**, separating the ledger from model-written synthesis prose. This confirms recorded-ID coverage, **not** that truncated original critique evidence is recoverable or that any objection is resolved.

Historical frozen drafts and model ballots remain immutable. To benefit from these gates after a previously clipped report, start a **new** debate; a parser-integrity sentinel remains a blocker until separately investigated. See [Complete synthesis integrity](docs/COMPLETE_SYNTHESIS.md).

## M5.4 synthesis reliability and fallback

For new council runs, `synthesisTimeoutMs` defaults to **600000** (10 minutes; valid range 30000–1800000 ms) and `synthesisFallback` defaults to **true**. Both options are available in the Vue consensus panel and `POST /api/debates`. A failed initial or M5 negotiated synthesis, provider timeout, or invalid structured draft can trigger a new attempt by the next **selected** provider. Attempts are recorded individually with UUID, provider, error and applied timeout; a previous failed/uncertain CLI call is **never silently reissued**. At most one initial synthesis attempt per selected model occurs without operator-authorized retries. Fallbacks consume extra calls and provider quota, and all results remain marked unverified.

If no valid initial draft is produced, the report remains **incomplete** and records the original objections and failed calls. A failed M5 negotiated synthesis retains the earlier draft and ballots as history without falsely using them to ratify the revised proposal. To resume an already failed run, open it in History → **Resume from verified checkpoint**, select one rejected synthesis call if all providers have been tried, and acknowledge possible duplicate billing. An unfinished M5 negotiated cycle can likewise resume with one authorized rejected re-synthesis UUID; successfully completed revisions are not repeated. If an untouched fallback provider exists, resume can attempt it without repeating any earlier failed CLI call. The original finite deadline/call limit still applies, even after upgrading to M5.4. See [Synthesis reliability](docs/SYNTHESIS_RELIABILITY.md) for the exact recovery cases and safe live smoke checklist.

## Data and restart behavior

Snapshots are atomically persisted after each stage and each agent response, by default under `.ace-data/debates/<uuid>.json`, which is gitignored. Override storage with `ACE_DATA_DIR=/private/path`. Session files contain the original idea, proposals, structured objections, critiques, rebuttals and revisions **in plain text**; protect this folder if your ideas are confidential.

A restart preserves completed checkpoints. **M5.2 recovery** can resume eligible interrupted debate, synthesis, independent voting and negotiation stages without rerunning successful calls; possibly executed failed/uncertain CLI calls require explicit operator authorization by exact call ID. A session in Unlimited mode has **no overall execution deadline**, while an existing custom-limited session keeps its original deadline and call usage. Cancellation and finite-budget exhaustion preserve a partial timeline. Terminal decisions remain immutable; legacy sessions missing safe journals can return HTTP 409. See [Safe resume and recovery](docs/RECOVERY.md). Only one worker process may own the data directory.

## Limits and security

- Prompts are sent via stdin, never shell-interpolated. The CLI accounts and auth tokens are not copied into the app.
- CLI processes run in empty temporary directories with best-effort read-only / plan-mode limitations. User-configured CLI hooks, extensions and tools may still have side effects; **this is not a hardened sandbox**.
- Provider material is delimited and explicitly labeled untrusted. This mitigates but cannot eliminate prompt injection.
- Incoming user prompts are limited to 12,000 characters. Outputs stored for each turn are capped at 25,000 characters and peer context is further bounded; trimming is labeled.
- CLI invocation limits apply **regardless of the overall budget mode**. Proposal/critique/rebuttal turns have a 150-second cap; revisions receive 180/210/240 seconds for rounds 1/2/3; synthesis and ballots receive their own bounded timeouts. In finite mode each per-call timeout is further reduced by the remaining session deadline; unlimited mode has no session-wide deadline. Provider output is bounded at 8 MiB of raw stdout; per-turn stored text remains capped at 25,000 characters. Verbose stderr is drained safely. High round counts may consume substantial provider quota, and failed calls are not silently retried.
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
- **M2:** Cross-review, rebuttals, revisions, history and live progress — merged
- **M3:** Explicit voting, traceable evidence claims, dissent and qualified consensus reports — merged
- **M4–M4.2:** Durable local execution, authenticated queue, parser resilience, objection integrity and verified coverage — merged
- **M5–M5.1:** Targeted negotiation, frozen revised drafts, independent re-voting, draft-specific sign-offs and reliability hardening — merged
- **M5.2:** Checkpoint-safe debate and consensus resume with explicit uncertain-call authorization — merged
- **M5.3:** Unlimited session execution budget by default, with opt-in custom call/time caps — merged
- **M5.4:** Configurable synthesis timeouts, journaled provider fallback and exact failed-synthesis recovery — merged
- **M5.5 (current):** No silent truncated frozen drafts, fail-closed synthesis validation, deterministic objection register — merged

Further work includes authenticated three-provider live smoke tests, hardened sandboxes, direct provider API integration, independent evidence verification and performance benchmarks. These remain separate features and are not claimed as implemented by M5.4.

The goal is a **traceable, defensible decision**, not artificial agreement.

## Provider integration validation

CI uses executable mock CLIs to validate real subprocess invocation, stdin framing, protocol parsing and all 15 three-model debate stages. The real accounts can only be exercised on your authenticated workstation. To explicitly authorize that final smoke (up to 15 provider calls), run:

```bash
ACE_LIVE_SMOKE=I_ACCEPT_MODEL_USAGE npm run smoke:live
```

Use this only when your authenticated CLIs have sufficient quota. The smoke persists a local session. No external-provider smoke has yet been run in CI.

## M3 local live smoke (opt-in)

M2 smoke remains `npm run smoke:live` (15 real CLI calls). To explicitly authorize a 19-call M3 flow with your authenticated CLI accounts, run:

```bash
ACE_LIVE_SMOKE=I_ACCEPT_MODEL_USAGE npm run smoke:consensus
```

CI uses deterministic stub models and CLI-process integration tests; it cannot verify your personal authenticated CLI accounts. Check session outcome, votes, objections and report after the live smoke.

## M3 correctness regression coverage

CI exercises persistent objections from prior rounds, malformed critique inputs, contradictory accept votes, missing ballot fields, author-confirmed resolutions and supersessions, non-author voting thresholds, disabled critical gate behavior, timeout/cancellation, persistence failure recovery, provenance, audit hashes, and failure reports. Tests use provider mocks; the authenticated live CLI flow must still be verified locally before merge.

## Long-session reliability

Earlier versions used a fixed **90-second** CLI timeout, a **768 KiB** process-stdout cap, and a **32 KiB** stderr cap; long third-round revisions could fail even when providers were functioning. The current version uses phase-aware per-call timeouts, a bounded **8 MiB** raw-response allowance, safe stderr draining, explicit brevity limits and shorter context excerpts. An optional **finite** session-wide deadline further constrains those calls; Unlimited mode has no such deadline. Historical session records remain auditable; M5.2 can resume eligible interrupted sessions from verified checkpoints, without silently replaying uncertain calls. See [Safe resume and recovery](docs/RECOVERY.md).

## M3.1 — Consensus reliability and objection integrity

The critique stage parses **the complete raw provider response before shortening display text**. Structured objections are stored individually with stable IDs and a link to their source entry. For damaged JSON, complete recoverable JSON objects are kept individually, and a separate `parsing_failure` objection records incomplete evidence; unparsable content is **not** treated as a resolved critique. The user-selected provider subprocess still has an 8-MiB raw stdout cap, so truncation by a provider before delivery cannot be repaired automatically.

The synthesis and vote contexts prioritize open high-severity objections using complete bounded JSON records rather than truncating one giant JSON string. Coverage manifests preserve omitted IDs. If important critical context is omitted, M3 returns `incomplete` instead of claiming unanimity.

When initial votes satisfy the policy but substantive critical objections lack author sign-off, M3 may run **one final resolution call per objection author**, subject to remaining call/time budgets. This requires exact IDs and explicit reasons; unparseable-evidence records cannot be cleared by a generic accept vote. Contradictory accept ballots trigger one separately logged clarification call, which may result in a conditional or rejected vote. No unlimited retry loops exist, and all follow-ups are recorded in the session and report.

The `blocked_by_unparseable_evidence` verdict explicitly distinguishes parser/integrity problems from `blocked` decisions caused by actual substantive objections. Existing historical sessions are not rewritten. For a previous blocked session, launch a new run to benefit from the fixes and budget for possible follow-up calls (at most two additional calls per selected agent across clarification and final sign-off).

## M4 — Durable local execution and recovery (v0.4.0)

**Secure-by-default local server:** Starting `npm run dev` creates a cryptographically random local API token if `ACE_API_TOKEN` is absent. Read `.ace-data/api-token` and enter it in the web app's unlock screen. The token file has restricted owner-only permissions; never share or commit it. API clients can use `Authorization: Bearer <token>`. The browser uses a 12-hour HttpOnly, SameSite=Strict cookie. The server listens only on loopback; do not expose it publicly. User-configured CLI hooks and tools can still act with the account's privileges; these are not hardened VM sandboxes.

**Durable queue:** New debate requests are persisted before a single local worker starts them, and additional sessions queue instead of being rejected. After a restart, queued sessions automatically resume if they contain no unapproved uncertain calls and have not entered an unrecoverable consensus stage; previously authorized queued resumes may contain completed, reusable debate steps. A single-writer filesystem lease prevents concurrent server instances from using the same storage directory on one machine. The `/api/metrics` endpoint reports queue length, active worker status, aggregate outcome counters, and durable per-provider UTC-day call usage.

**Write-ahead call journal:** Every provider invocation first persists an `issued` entry and reserves a call-budget slot. If a process dies before recording the response, its status is uncertain: the provider may have processed and billed the call. `POST /api/debates/:id/resume` rejects an uncertain call until the operator explicitly provides `retryCallIds` and `acknowledgeMayRepeatCall:true`. Prior entries remain in the audit trail and consume their original call-budget reservations. Completed calls are never auto-replayed; previously completed stage records are reused.

**M4 historical limitation:** At v0.4.0, synthesis and votes could not be safely resumed. **M5.2 supersedes that restriction:** eligible journaled synthesis, ballots and negotiation checkpoints now support explicit safe recovery. Legacy unjournaled work still fails closed. The application does not provide multi-host/distributed execution, hardened CLI VM/container isolation, hosted provider API integration, or an external tracing backend.

### Daily provider call quotas

To cap usage across restarts, configure an integer `ACE_DAILY_CALL_LIMIT` and/or per-provider limits `ACE_CODEX_DAILY_CALL_LIMIT`, `ACE_CLAUDE_DAILY_CALL_LIMIT`, `ACE_GEMINI_DAILY_CALL_LIMIT`. A limit of zero disables new calls; unset limits are unbounded but still metered. Per-call reservations are persisted in owner-readable `.quota-YYYY-MM-DD.json` ledgers in the debate data directory **before each external CLI invocation**. Reservations are conservative and are not refunded after timeouts, cancellation or crashes because the remote provider may already have processed a request. Counters reflect attempted provider calls rather than tokens or dollars; CLI protocols do not expose reliable universal token/cost telemetry.

## M4 review hardening: failure safety and limits

- **OS lock:** a native advisory lock is retained by a helper process tied to the server's stdin pipe (POSIX `flock`, Windows PowerShell FileStream exclusive handle). Kernel cleanup on process death avoids unsafe stale-PID unlinking; do not place the data directory on unsupported network filesystems. Only one owner can start on the same host/storage volume.
- **Immutable deadline for custom-limited sessions:** In finite mode, `executionDeadlineAt` is assigned before the first stage and preserved across resumes. Queued time before execution does not count; time spent running, offline, or awaiting approval **does** count. **Unlimited sessions do not receive an overall execution deadline.** Per-CLI timeouts and explicit cancellation still apply.
- **Unbounded recovery scan:** startup examines queued session files and recovers authorized queued work containing completed steps. It still refuses unapproved uncertain calls. Crash-interrupted consensus stages use M5.2 journals and frozen checkpoints; unjournaled or unsafe recovery fails closed.
- **Process death:** each spawned CLI has a dedicated independent parent-death watchdog that terminates its POSIX process group (or Windows taskkill tree) if the API process unexpectedly disappears. This mitigates orphaned CLIs but is not the same as a hardened cgroup, job object, VM, or container boundary; there is a brief guardian-startup race and CLI descendants that deliberately detach into different process groups may escape. Use OS-level cgroups/job objects for high-assurance containment.
- **Disk durability:** session/usage snapshots use temporary files, explicit file sync, atomic replacement and POSIX directory-metadata sync before acknowledging writes. Disk firmware, exotic filesystems, and Windows directory sync behavior are not covered by this guarantee.
- **Authentication:** production `makeApp()` construction fails without a token; test code must explicitly opt into `allowUnauthenticatedForTests`. This reduces the risk that a new server entrypoint accidentally disables protection.

## M4.1 — Critique JSON resilience (v0.4.1)

A critique parser-failure objection indicates that the **original provider response** was incomplete, malformed or did not satisfy the required JSON shape. The text shown in a parsing-failure objection is now explicitly identified as a **display-only preview** with the original character count, not as the input the parser analyzed. The earlier "[Truncated for context or display]" suffix came from shortening this preview; it did not prove that the parser truncated the provider output.

The critique prompt now requires one compact, complete JSON object (maximum four concise objections, bounded fields, no commentary), instead of allowing a Markdown fallback the parser cannot read. The parser also accepts a complete JSON object wrapped in fences or explanatory text, salvages complete individual objection objects from incomplete JSON, and rejects malformed partial objection fields. A remaining incomplete objection still creates a distinct `parsing_failure` record and prevents unsupported consensus; **no AI text is guessed or silently repaired**. Critique timeline entries now include parsing status, complete source character count and number of recovered objections.

This improvement applies to **new debates only**. Historical decisions and past parsing-failure records are not rewritten. If a CLI returns genuinely unfinished JSON before its own output budget, the system cannot reconstruct missing claims without a new model call; this patch intentionally does not perform hidden retries or spend extra CLI quota.

## M4.2 — Pre-M5 consensus coverage and objection ledger integrity

The previous decision report disclosed 63 omitted objections (13 critical), while an independent vote reported zero omissions: synthesis previously saw a global 16k-character objection excerpt, but voters saw only their author-owned subset. This made the two omission counts incomparable and the generated explanation misleading.

**Shared context:** Every synthesis and every independent ballot in a new session now receives the *same immutable, compact global objection ledger*, bounded to 56,000 characters. Open critical objections are prioritized, and each record is clearly an **excerpt**, not the full source criticism. All full objection texts and provenance stay in the local session JSON. The decision report and UI disclose a verified shared context hash, number of included objections, number omitted, and IDs of any critical omissions. If even one open critical excerpt cannot fit, the engine immediately marks the run **incomplete**, saving synthesis/voting model calls rather than asking a model to decide from missing critical evidence. Noncritical omission is still reported; noncritical excerpts are not misrepresented as full evidence.

**Partial original-author signoff:** When a valid independent vote explicitly marks a specific authored objection ID as fixed, that ID can be closed even if the agent's overall verdict remains `conditional` or `reject`. This never converts a dissenting ballot to acceptance and cannot close any parser-integrity sentinel. Unconfirmed records remain open, and no model verdict implies fact verification. This is an evidence-accounting fix, not M5's proposed negotiation/re-vote system.

**Existing reports are immutable.** The historical debate remains disputed with its original omitted/context errors; rerun the same idea with the new version to exercise full shared context. Model prompt lengths and hence token usage can increase for large debates. The shared excerpt cap is conservative; exceptionally large objection ledgers still fail closed rather than silently dropping critical material.

## M5 — Intelligent Consensus Negotiation (v0.5.0)

**Opt-in bounded negotiated cycles.** Set `negotiationCycles` to `0` (API compatibility default), `1`, or `2` on a debate with `consensus:true`. The UI defaults to 1 cycle. After the initial frozen synthesis and independent votes, a disputed or substantively blocked outcome may initiate targeted revisions by each selected model; a neutral facilitator then creates a *new frozen synthesis*, and all agents cast *new independent votes tied to its SHA-256*. The older draft, ballots and objection IDs remain available as audit history. No vote carries over to a changed draft. Model calls always count toward usage; session-wide call/time limits apply **only when a custom finite budget is selected**.

**Bounded negotiation and honest abstention.** One cycle requires `2 * providers + 1` additional calls. In **finite** mode, a cycle that cannot fit the remaining budget is skipped and the prior verdict remains. Unlimited mode removes only the session-wide call/time ceiling; negotiation still runs at most two cycles. A failed targeted revision/synthesis preserves the prior frozen draft and votes without claiming consensus. A re-vote failure cannot be filled from the original vote. Cycles stop on consensus, exhausted budgets or unverified critical context. Parsing-failure sentinels and omitted critical context prevent negotiated acceptance rather than being 'fixed' by a persuasive rewrite. The original objection authors must explicitly sign off individual critical objection IDs; a new draft alone does not close them.

**Security:** The M5 additional provider calls use the same authenticated local CLI worker, per-provider timeouts and quota controls; finite session budgets apply only when enabled. Each M5 invocation is journaled as `issued` before execution and recorded as fulfilled/rejected. Consensus-stage crash recovery still fails closed and will never auto-replay an uncertain call. This is an in-process local-first negotiation workflow, not a distributed execution system.

The debate report includes an M5 negotiation audit with original/follow-up vote outcomes and original/revised SHA-256 values. Old M4 runs and their reports are not rewritten.

### M5 traceable grouping and decision matrix

The engine deterministically groups only near-identical open substantive objections (high overlap of claim and criticism terms, Jaccard threshold 0.85). This is a conservative **textual similarity heuristic**, not embedding-based semantic equivalence. Parsing-integrity failures are never grouped with substantive objections, and confirmed/superseded objections are excluded from this advisory view. **No ID, criticism, author status or severity is removed or auto-resolved by grouping**; the full global ledger remains authoritative.

Negotiated synthesis can optionally include an auditable `decisions` array containing explicit issue, choice, rationale, referenced exact objection IDs and remaining uncertainties. Only known IDs are retained; the decisions are model-generated suggestions, never factual verification or original-author sign-off. The UI and Markdown report show this decision matrix and the independent ballots for each revised draft.

### M5.1 — Consensus-correctness stabilization

- **Draft-specific objection sign-off:** An original-author confirmation is recorded against the exact frozen draft SHA-256. On a changed draft, it is reopened by default and must be explicitly reconfirmed. Prior confirmations remain in append-only `authorSignoffs` history. Only complete independent ballot sets can mutate author-signoff status.
- **Accurate cycle outcomes:** Negotiation cycles distinguish `completed`, `skipped`, `failed`, `partial` (invalid new ballots), and `interrupted` (cancelled or deadline exhausted). Earlier votes remain historical, not current quorum evidence.
- **Budget reservations:** A cycle requires room for 2N+1 provider calls, up to N contradictory-ballot clarifications, and one original-author confirmation call per currently open critical-objection author. Unused reservations are not charged; all actual calls remain metered.
- **Re-vote parity:** New frozen-draft votes receive the same bounded contradiction clarification as the original voting phase; M5 clarification calls are journaled.
- **Targeted negotiation:** Per-provider action plans rank unresolved critical concerns, especially authored objections. The full shared objection ledger remains available; advisory duplicate groups never collapse source IDs or imply semantic identity. Vector/embedding semantic retrieval remains a future quality experiment, not an automatic objection-resolution mechanism.

**Frozen-draft identity:** M5.1 hashes the complete voted-on draft (author, proposal, assumptions, and evidence claims), rather than only its Markdown proposal. Changing source/evidence claims or assumptions without changing the prose still requires a new vote and original-author reconfirmation. Historical reports remain immutable.

## M5.2 — Explicit, checkpoint-safe debate and consensus recovery

Sessions persist provider-call intentions **before** invoking external CLI accounts, including initial consensus synthesis, independent ballots, and negotiated revisions/re-votes. **Finite sessions** preserve their original wall-clock deadline and call cap; **unlimited sessions** have no session-wide deadline or maximum call count. Previous actual call consumption is never reset. Successful proposals, complete votes, and frozen decision hashes are retained. A journal entry with unknown/failed provider outcome **cannot automatically replay**. The operator must provide its exact call ID and accept possible duplicate CLI charges.

### Resume API

`POST /api/debates/:id/resume` with JSON `{"retryCallIds":["<exact failed/uncertain call UUID>"],"acknowledgeMayRepeatCall":true}` only if such calls need retry. A 409 includes uncertainty IDs where applicable. The web interface shows exact call IDs and checkboxes for operator authorization. Pending, never-issued stages can resume with `{}`. Finished final decisions remain immutable.

**Partial debate:** a failed/skipped stage can be retried explicitly only when no successful downstream evidence depends on it. Completed peer steps retain their identifiers and outputs; successful final-revision retries can proceed to consensus without restarting the entire debate. Retries that would invalidate rebuttals or later revisions are rejected and require a new run.

**Consensus:** a complete saved synthesis or an independent ballot bound to the current frozen draft is reused. Durable response journals bridge crashes between a provider response and writing its parsed artifact. Invalid or potentially invoked calls require explicit authorization. An interrupted M5 cycle uses its saved revisions, candidate draft and vote records instead of restarting from zero.

**Safety boundaries:** Older consensus sessions without sufficient write-ahead journals cannot be reconstructed; they return 409 rather than risking duplicate calls. **Finite** deadlines cannot be extended; older **finite** sessions missing a persisted deadline derive a conservative one from creation time. Call budgets and provider quota still count all retried calls. Rejected upstream work with successful downstream dependencies is not silently rewritten. Interrupted execution remains auditable in the local session JSON; neither external model correctness nor commercial usage rights are independently verified.

## M5.3 — Unlimited execution budget by default

**Full configuration and migration guide:** [Execution budget — defaults, UI, API and safe usage](docs/EXECUTION_BUDGET.md). **Recovery details:** [Safe resume and recovery](docs/RECOVERY.md).

New multi-model debates use **unlimited execution budget** by default. This removes the session-wide maximum model-call count and wall-clock deadline, allowing the configured debate rounds and negotiated consensus stages to complete without the previous 40-call / 15-minute default. It **does not** remove the individual provider invocation timeouts, provider subscription quotas, charges, the fixed round count, negotiation cycle limits, or the user-controlled Cancel action.

### Configuring a custom budget

In the web UI, **Execution budget → Unlimited calls and session duration** is enabled by default. Turn it off to set a numerical **Max calls** (2–10,000) and **Minutes** (1–10,080, i.e., seven days). The controls remain user-editable, not just a preset dropdown. A warning appears when the requested call limit is below estimated debate, voting, and follow-up calls.

API examples:

```json
{"prompt":"Compare two implementation plans…","providers":["codex","claude","gemini"],"maxRounds":1,"consensus":true,"unlimitedBudget":true}
```

or, for a limited execution:

```json
{"prompt":"Compare two implementation plans…","providers":["codex","claude","gemini"],"maxRounds":1,"consensus":true,"unlimitedBudget":false,"maxCalls":80,"maxDurationMs":3600000}
```

For compatibility, API requests that **explicitly provide** `maxCalls` or `maxDurationMs` without `unlimitedBudget` continue to use finite budgets (missing counterpart falls back to 40 calls / 15 minutes). When the flag and both limits are omitted, new runs are unlimited. Passing numeric limits with `unlimitedBudget:true` is rejected as ambiguous rather than silently ignored.

**Resume:** An unlimited session has no execution deadline; it still reuses completed checkpoints, requires explicit authorization for uncertain or rejected external calls, and never resets already recorded usage. Existing stored limited sessions remain limited to their original cap and deadline. The UI shows `∞` instead of a misleading hard call limit.
