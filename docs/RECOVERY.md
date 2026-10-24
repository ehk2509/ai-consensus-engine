# Safe resume and recovery

Applies to **M5.2+**, including the **v0.5.3 unlimited-budget policy** and **M5.4 initial-synthesis fallback and recovery**. Read [Execution budget](EXECUTION_BUDGET.md) for configuring budgets.

## What recovery does

The local worker persists a write-ahead record **before** an external CLI call. The record identifies a step/call and records whether a complete response was saved. After a process interruption, eligible sessions can continue from verified checkpoints:

- Reuse successful independent proposals, critiques, rebuttals and revisions.
- Restore a persisted synthesis and its frozen SHA-256.
- For a missing initial draft, safely use the next untouched selected synthesis provider or require just one explicitly authorized failed-synthesis retry when all providers have failed. Never erase the failed facilitator's journal.
- Reuse completed independent votes **only when their draft SHA-256 matches** the frozen synthesis.
- Restore completed targeted negotiations and re-votes without replaying already-fulfilled provider work.
- Reconstruct complete journaled responses when the provider result was saved but the parsed stage artifact had not yet been committed.

**No AI call is silently replayed** when its execution status is uncertain. Its provider may already have processed or billed it.

## How to resume from the UI

1. Select an incomplete or interrupted debate from **History**.
2. Find **Resume from verified checkpoint**.
3. The UI lists failed or uncertain calls by **provider, phase, status and exact UUID**.
4. Select each retry you intend to authorize. For an **uncertain** call, select the exact ID because it may already have consumed quota.
5. Check the explicit duplicate-usage acknowledgement if you selected any calls.
6. Click **Resume checkpoint**. Completed checkpoints are preserved, and only permissible outstanding work is scheduled.

If a run has **only never-issued** work and does not require any uncertain/rejected retry, it may resume without selecting IDs. A completed final consensus decision cannot be resumed to change its verdict; start a new debate.

## Resume API

`POST /api/debates/:id/resume` accepts:

```json
{
  "retryCallIds": ["00000000-0000-0000-0000-000000000001"],
  "acknowledgeMayRepeatCall": true
}
```

Replace the sample UUID with the **exact** failed or uncertain ID returned in the session or conflict response.

For never-issued stages with no required retry:

```json
{}
```

Expected responses:

- **202 Accepted:** recovery has been queued; poll `GET /api/debates/:id`.
- **409 Conflict:** recovery would be unsafe or ineligible. The body contains `error` and, when applicable, `uncertainCallIds`.
- **404 Not Found:** unknown session ID.
- **400 Bad Request:** invalid retry IDs or acknowledgement shape.

The server requires a local API token for these operations unless explicitly configured for isolated test execution.

## Unlimited vs finite sessions on restart

| Property | Unlimited new session | Custom-limited or historical finite session |
| --- | --- | --- |
| Session-wide call cap | None | Original `maxCalls` persists |
| Session-wide deadline | None | Original `executionDeadlineAt` persists |
| Completed checkpoints reused | Yes | Yes |
| Usage from earlier attempts counted | Yes | Yes |
| Retry of uncertain call requires exact authorization | Yes | Yes |
| External provider quotas and CLI timeouts | Still enforced | Still enforced |
| Original deadline can be extended on resume | Not applicable | **No** |

A **two-day-old unlimited session** may be eligible for resume if it has safe journaled checkpoints; age alone does not block it. An old finite session with an expired original deadline still returns **409**, even if a code upgrade made Unlimited the default for *new* sessions.

A fully saved synthesis/ballot set can be reconstructed with **zero additional provider calls** even if a finite call budget is exhausted. New calls or retries still require remaining finite capacity.

## Cases intentionally rejected

- An **issued/uncertain provider call** without its exact ID and explicit user acknowledgement.
- All selected synthesis providers already failed and no rejected synthesis UUID has been authorized for retry. One such authorization suffices (not all), but every earlier attempt remains in the audit.
- A failed critique or earlier step when successfully recorded later stages depend on it and would become inconsistent after replay.
- Legacy consensus runs without enough write-ahead information to distinguish saved results from possibly billed calls.
- A finite session with an expired deadline, or a requested retry beyond its remaining call cap.
- A final, already settled decision being reopened to silently change its original recorded outcome.
- Incompatible frozen draft hashes, missing journal evidence, or unavailable original source information needed for trustworthy replay.

Provider outputs above the journal replay threshold may not be reconstructable from the journal if the parsed result was not already saved. In that case an explicit retry or a fresh run may be required.

## Safe testing checklist

1. Create a new debate with two or three locally authenticated providers and a low-complexity prompt.
2. During a vote, intentionally interrupt the **application process** only in a controlled development environment.
3. Restart and inspect the session JSON and retry candidate list.
4. Verify that already-fulfilled provider calls were not reissued.
5. If a provider call's outcome is uncertain, verify the API returns 409 before explicit authorization.
6. Authorize its **exact ID**, retry it, then check that total call usage increments only for the new attempt and its frozen draft hash is unchanged.
7. Repeat with an unlimited session; verify there is **no synthetic overall deadline**. Repeat with a small finite cap; verify the original cap and deadline still bind.

CI verifies these behaviors using deterministic adapters and crash fixtures; M5.4 tests exercise failover, single-UUID retry, and the real-world no-draft timeout case. See [Synthesis reliability](SYNTHESIS_RELIABILITY.md). **A real authenticated multi-provider interruption/restart is a separate integration check** and may incur actual provider usage.

## Operational safeguards

- Keep `.ace-data` private; it contains plaintext session decisions, prompts, response data and local quota ledger files.
- Do not share the local API token or expose the API listener to a public network.
- Optionally set `ACE_DAILY_CALL_LIMIT` and per-provider daily caps to constrain overall external usage.
- A custom application-level Unlimited budget does not supersede external provider subscription limits, costs or per-call timeouts.
