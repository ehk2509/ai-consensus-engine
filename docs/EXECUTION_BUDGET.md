# Execution budget: unlimited by default

Applies to **AI Consensus Engine v0.5.3 (M5.3)**.

## Overview

Every **new multi-round debate** starts with **Unlimited calls and session duration** enabled. This is a session-wide policy: the application does not impose a total provider-call cap or an overall wall-clock deadline on a new unlimited debate.

Unlimited **does not mean free, unstoppable or unbounded per invocation**. The following protections still apply:

- Each external Codex, Claude Code or Antigravity CLI call has its own phase-aware timeout; a hung call cannot run indefinitely. Initial synthesis defaults to 600000 ms and is configurable per request from 30000 to 1800000 ms.
- Connected CLI accounts remain subject to their actual provider plans, availability, quotas and any resulting costs.
- Configured daily application quotas (if set), per-provider call metering, explicit manual Cancel and local worker isolation are unchanged.
- A debate runs **1–3 rounds** and negotiated consensus runs **0–2 extra cycles**. Unlimited does not create an infinite negotiation loop.
- Tool safety and the rules for retrying possibly billed external calls are unchanged.

For high-cost experiments, **opt into a finite budget** or configure daily quotas. No dollar-based spending guard is provided by the application.

## Configure the web interface

1. Open the local UI at [http://127.0.0.1:5173](http://127.0.0.1:5173) after `npm run dev`.
2. Select **Multi-round debate** and choose your providers and rounds.
3. Find **Execution budget**; **Unlimited calls and session duration** is checked by default.
4. To enforce a session cap, **uncheck** Unlimited. Then edit:
   - **Max calls:** whole number from **2 to 10,000**.
   - **Minutes:** whole number from **1 to 10,080** (seven days).
5. Start the debate. Custom values stay in the form if you switch back to Unlimited and later return to custom limits; they are **not sent to the API** while Unlimited is enabled.

The UI shows `∞` for an unlimited session's call limit. The estimate of likely calls describes the workload, **not** a hidden cap. In finite mode, a warning appears if estimated debate plus follow-up calls may exceed your selected maximum. The warning is advisory, not a billing estimate.

The **Independent proposals** mode is a separate workflow; these execution-budget settings are for multi-round debates.

## API request semantics

Send JSON to `POST /api/debates`, authenticated with your local API token when required. A successful creation returns HTTP **202** and a session ID.

| JSON fields | Policy | Effective limits |
| --- | --- | --- |
| No `unlimitedBudget`, `maxCalls` or `maxDurationMs` | **Unlimited (default)** | No session-wide call or duration limit |
| `"unlimitedBudget": true`, no numeric limits | **Unlimited (explicit)** | No session-wide call or duration limit |
| `"unlimitedBudget": false` with `maxCalls` and/or `maxDurationMs` | **Finite** | Specified values; unspecified counterparts use historical defaults |
| One/both numeric limits and no `unlimitedBudget` | **Finite (legacy compatibility)** | Supplied limits; missing call cap defaults to **40**; missing duration defaults to **900,000 ms / 15 min** |
| `"unlimitedBudget": true` together with `maxCalls` or `maxDurationMs` | **Invalid** | HTTP **400** instead of silently ignoring a limit |

**API validation:** finite `maxCalls` must be a safe integer between **2 and 10,000**. Finite `maxDurationMs` must be an integer between **10,000 ms (10 seconds)** and **604,800,000 ms (7 days)**. The UI deliberately offers a minimum of one minute. `unlimitedBudget` must be a JSON boolean, not a string.

### Example: unlimited budget

```bash
TOKEN="$(cat .ace-data/api-token)"
curl -sS -X POST http://127.0.0.1:8787/api/debates \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "prompt": "Evaluate the architecture, risks and business potential of an AI research product.",
    "providers": ["codex", "claude", "gemini"],
    "maxRounds": 2,
    "consensus": true,
    "negotiationCycles": 1,
    "unlimitedBudget": true
  }'
```

You can also simply omit the three budget fields. `maxRounds` still has a default of 1, and the **API** defaults to `consensus: false`, unlike the web UI's default.

### Example: custom caps (80 calls, 60 minutes)

```bash
TOKEN="$(cat .ace-data/api-token)"
curl -sS -X POST http://127.0.0.1:8787/api/debates \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "prompt": "Evaluate the architecture, risks and business potential of an AI research product.",
    "providers": ["codex", "claude", "gemini"],
    "maxRounds": 2,
    "consensus": true,
    "negotiationCycles": 1,
    "unlimitedBudget": false,
    "maxCalls": 80,
    "maxDurationMs": 3600000
  }'
```

A finite session stops issuing new model calls when it reaches `maxCalls`; an expired wall-clock deadline can stop a running invocation. The resulting session may be `budget_exhausted` or show an incomplete/not-assessed consensus, rather than manufacturing acceptance.

## Estimating model usage

For **N selected providers** and **R debate rounds**, the normal debate workload (excluding failed/extra calls) is:

- Independent proposals: **N**.
- Each round: **N × (N − 1)** peer critiques + **N** rebuttals + **N** revised proposals.
- Initial synthesis and votes when `consensus: true`: **1 + N** (successful first attempt). With M5.4 `synthesisFallback:true`, initial synthesis can add up to **N−1** calls when previous providers fail.
- Each additional M5 negotiated cycle, if triggered: **2N + 1** provider calls.
- Contradiction clarification and original-author objection sign-offs may add calls as needed.

For **three providers and one round**, the debate alone usually takes up to **15 calls** and the first synthesis/votes bring that to **19**; an additional negotiation cycle can add **7** before clarification or sign-offs. For **three rounds**, the debate alone can take up to **39**.

These figures **do not predict token costs or guarantee success**; early failures or early acceptance can reduce actual calls. The app counts attempted external CLI calls, not tokens or provider bills.

## Optional daily quota safety net

A per-session unlimited budget is independent of application-level daily quota configuration:

```bash
# Example only: configure these in your own shell before launching.
export ACE_DAILY_CALL_LIMIT=120
export ACE_CODEX_DAILY_CALL_LIMIT=40
export ACE_CLAUDE_DAILY_CALL_LIMIT=40
export ACE_GEMINI_DAILY_CALL_LIMIT=40
npm run dev
```

These settings are optional and can stop new calls in **either** budget mode. A quota reservation is recorded before invoking a provider; it is not refunded after uncertainty, timeout, crash or cancellation, since an external call may already have run. If no daily quota is configured, these quota limits are unbounded, but calls are still metered.

## Session persistence, restart and migration

- The session's normalized `request.unlimitedBudget` is saved to its local JSON record.
- New unlimited sessions have no `executionDeadlineAt`; a cold restart does **not** synthesize one.
- In finite mode, `executionDeadlineAt` is calculated on first execution and remains fixed through downtime and manual approval. The call count is never reset on resume.
- Pre-v0.5.3 saved sessions containing explicit `maxCalls` or `maxDurationMs` **remain finite**. An old session cannot become unlimited simply by upgrading the app.
- Resume preserves completed model responses and frozen ballot hashes; failed or uncertain calls need explicit operator authorization before a repeat. See [Safe resume and recovery](RECOVERY.md).
- No mode overrides individual CLI timeouts, authenticated account restrictions or the user's Cancel request.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| UI still shows a 40-call cap | Update the app to v0.5.3 or newer; confirm the specific session's saved `request.unlimitedBudget`. Old finite sessions do not automatically change. |
| API says numeric budget conflicts with unlimited mode | Remove `maxCalls` and `maxDurationMs` or send `"unlimitedBudget": false`. |
| Session says `budget_exhausted` despite selecting Unlimited | Check whether the session was created before the change or whether a provider/daily quota was reached. A true new unlimited run has no **session-wide** budget. |
| One provider times out during Unlimited execution | Unlimited applies to the overall session, not the individual CLI subprocess. Inspect its recorded timeout, increase `synthesisTimeoutMs` for **new** sessions (30–1800 seconds), and enable selected-provider synthesis fallback. |
| A stopped session refuses resume (409) | Check exact uncertain/rejected call IDs, required acknowledgement, saved journal and whether it is a final decision. For a missing synthesis draft after all providers failed, only one explicit rejected-call retry is required. See [Recovery troubleshooting](RECOVERY.md) and [M5.4 synthesis reliability](SYNTHESIS_RELIABILITY.md). |

## Security and privacy

The API listens on loopback with local token authentication. Session JSON contains prompts, provider responses and objection histories in **local plaintext** in `.ace-data` by default, so use suitable filesystem permissions. Never publish provider auth tokens, local session files or API tokens.
