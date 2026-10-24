# M5.5 — Complete synthesis integrity and audit coverage

A live v0.5.4 council showed a new failure pattern: the facilitator completed synthesis but generated a draft longer than the engine's 18,000-character frozen-proposal limit. The previous engine **silently cut the proposal mid-table**, appended `[Context truncated]`, signed the shortened text with a draft SHA-256 and sent it to all three voters. Correct conditional votes could not inspect the missing tail.

## Guarantees for new runs

- No model-generated proposal is silently clipped and frozen. Initial synthesis and negotiated re-synthesis reject a draft longer than 18,000 characters or containing known `[Context truncated]` / `[Truncated for context or display...]` markers. Affected journaled calls are marked rejected, with safe fallback only to a selected provider and subject to quota, timeouts and budgets.
- Targeted M5 revisions are similarly rejected if oversized or explicitly truncated, rather than creating incomplete inputs for revised consensus.
- Model synthesis instructions aim for under 14,000 characters and a complete conclusion. They instruct the model not to reconstruct an enormous per-ID objection table inside the draft.
- The decision record always includes a **deterministic complete objection register** with every stored objection's ID, round, author, target, severity, parsing-failure kind and current author status, independently of what the facilitator wrote. This does not turn excerpts into full original critiques or claim that any objection was resolved.
- The report now explicitly states how many negotiation cycles were requested and attempted. A parsing-failure sentinel is deliberately not silently negotiated away, even when negotiation was requested.

## Interpreting the recorded result

A vote of `conditional` is **not** `accept`. A draft-specific author confirmation of an individual substantive objection may legitimately coexist with a conditional overall vote; it does not imply consensus or implementation correctness. Unparseable critique evidence remains an open record, and the original provider response must be reviewed; never invent the missing criticism.

The output status `disputed`, `blocked`, or `incomplete` may therefore be correct even when all three models voted and most objections have ID-specific author signoffs.

## Historical sessions

SHA-256-frozen old drafts, their ballots, and signoffs are **immutable**. Upgrading to M5.5 does not silently rewrite a draft that was previously shortened. For a previous `disputed` final record with `[Context truncated]`, start a new debate after updating the app. A running/unsettled session is only eligible for `/resume` under the existing exact-call journal and deadline rules.

This release **does not** repair a critique JSON record that the provider itself ended before completing. That is a separate evidence-integrity problem. Using a truncated or unparseable critique as proof of resolution would be unsafe.

## Verification

The regression suite simulates oversized structured synthesis, explicit truncation markers, complete rejection when no provider produces a valid draft, oversized M5 revisions and exact per-ID objection coverage. CI also runs the existing crash, recovery, TypeScript, API and frontend checks. Real authenticated three-CLI evaluation remains a separate smoke test and may incur provider usage.

Note: a provider might submit an apparently coherent JSON proposal that omits substantive issues without any truncation marker. This patch cannot prove semantic completeness; independent voting and original-author objection gates remain necessary.
