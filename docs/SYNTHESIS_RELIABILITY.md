# M5.4 — Resilient synthesis and safe fallback

This release addresses real sessions in which a three-provider debate succeeds but the selected synthesis facilitator times out before returning a valid structured draft. Such a session remains **incomplete**, with all prior debate evidence and objections preserved. A fallback is **a new model call**, not a proof that consensus is factually correct.

## Configuration

The UI displays **Synthesis timeout (seconds)** and **Try another selected provider if synthesis fails** when independent consensus is enabled. The API accepts:

```json
{
  "prompt": "Evaluate an evidence-grounded startup idea and its risks",
  "providers": ["codex", "claude", "gemini"],
  "maxRounds": 1,
  "consensus": true,
  "negotiationCycles": 1,
  "unlimitedBudget": true,
  "synthesisTimeoutMs": 600000,
  "synthesisFallback": true
}
```

- `synthesisTimeoutMs` defaults to **600000 ms / 10 minutes**. Allowed range: 30000–1800000 ms. Unlike the overall Unlimited budget, **every individual provider call has a finite deadline**.
- `synthesisFallback` defaults to **true**. Set `false` for one attempted facilitator and a fail-closed incomplete outcome.
- If the initial facilitator fails, the system tries each other **selected** provider at most once per uninterrupted initial synthesis stage. Each invocation has a separate, durable UUID, error and timeout record. No original rejected or uncertain call is automatically retried.
- An invalid structured JSON proposal is rejected and logged rather than frozen or sent to ballots.
- Successful draft provenance records the **actual author** and SHA-256. Independent votes use the exact valid frozen draft and still respect the critical-objection gate.
- The same configured synthesis timeout also applies to negotiated M5 re-synthesis.
- In finite mode the original overall session deadline also constrains individual calls; fallback cannot bypass exhausted budgets. In Unlimited mode per-CLI limits, provider plan quotas, application daily quotas, and manual cancellation remain effective.

With N providers, failover adds **up to N−1 new model calls** during initial synthesis. For 3 providers, up to 2 additional calls and potentially 30 minutes of initial synthesis time with the default 10-minute limit. This is usage, not a guarantee of success or a billing estimate.

## Safe resume of no-draft sessions

A failed synthesis with no valid frozen draft remains resumable **only** if its write-ahead journal is sufficient and the original finite budget/deadline permits. Recovery always preserves prior successful debate stages.

1. In History, select the old incomplete debate and inspect its failed synthesis call journal.
2. Click **Resume from verified checkpoint**.
3. If at least one selected provider has never attempted synthesis and fallback is enabled, explicit resume can attempt that new provider without replaying the old failed call.
4. If every selected provider has already failed, authorize **one** rejected synthesis call by its exact UUID, select the duplicate-usage confirmation, and resume. Other rejected attempts remain in the audit and are not silently replayed.
5. For an **issued/uncertain** call that might still have consumed provider quota, select its exact ID and explicitly acknowledge possible duplicate charges before resuming. Missing original journals or conflicting downstream frozen draft state are rejected with HTTP 409.
6. Do not edit or delete the session JSON to bypass these gates. In particular, upgrading a historical capped run does not extend its original session deadline.

The API is `POST /api/debates/:id/resume`. It accepts `{"retryCallIds":["<exact-call-uuid>"],"acknowledgeMayRepeatCall":true}` or `{}` when no retry of a previously attempted call is required. A response of 202 means the job was **queued**, not that consensus was achieved. Poll the session/report for the final verdict.

## Verification

Unit and API regressions cover timeout forwarding, invalid JSON, fallback disabled, all-provider failure, single-authorized-retry recovery, resuming through an untried alternate model, and preservation of 24 unresolved critical objections. Existing M5.2 cases cover cold restart and zero-cost reconstruction with a completely consumed finite budget.

GitHub CI runs stub-provider tests, subprocess integration checks, typecheck and frontend build. It **does not** exercise a real authenticated Codex/Claude/Antigravity account. Before relying on the release in production, do a consented local smoke using your own authenticated CLIs, with sufficient provider quota. The existing `ACE_LIVE_SMOKE=I_ACCEPT_MODEL_USAGE npm run smoke:consensus` runs a normal consensus path; separately exercise a controlled initial synthesis failure on a local test environment to validate fallback and recovery. Do not artificially trigger paid provider calls without authorization.

Known boundaries: fallback is restricted to pre-approved **selected** providers, not an arbitrary external model. There are no infinite retries, no automatic fact checking, no hardened isolation of CLI-provided hooks, no guaranteed refund of timed-out calls, and no automatic increase of a historical finite session's deadline.
