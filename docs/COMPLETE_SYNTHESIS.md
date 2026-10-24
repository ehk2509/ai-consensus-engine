# M5.5–M5.6 — Complete synthesis integrity and lossless evidence

A live v0.5.4 council showed a new failure pattern: the facilitator completed synthesis but generated a draft longer than the engine's 18,000-character frozen-proposal limit. The previous engine **silently cut the proposal mid-table**, appended `[Context truncated]`, signed the shortened text with a draft SHA-256 and sent it to all three voters. Correct conditional votes could not inspect the missing tail.

## Guarantees for new runs

- **M5.6:** Complete model-generated proposals are preserved without an application length ceiling. Initial synthesis and negotiated re-synthesis reject only malformed/incomplete content or known upstream truncation markers (such as `[Context truncated]`), not valid long drafts. Invalid calls remain journaled and fallback stays restricted to selected providers.
- M5 targeted revisions, independent votes and follow-ups preserve complete successful model responses. An incomplete response is rejected, not silently cut.
- Model synthesis instructions require complete sections and a conclusion with no artificial character target. The per-ID objection register is generated deterministically, without duplicating it unnecessarily in model prose.
- The decision record includes a **complete deterministic objection register** with every stored objection's ID, round, author, target, severity, claim, criticism, evidence, suggested change, reply, parsing status, source entry and author status. The shared context also includes complete stored fields. Neither reconstructs text that a provider never returned.
- The report now explicitly states how many negotiation cycles were requested and attempted. A parsing-failure sentinel is deliberately not silently negotiated away, even when negotiation was requested.

## Interpreting the recorded result

A vote of `conditional` is **not** `accept`. A draft-specific author confirmation of an individual substantive objection may legitimately coexist with a conditional overall vote; it does not imply consensus or implementation correctness. Unparseable critique evidence remains an open record, and the original provider response must be reviewed; never invent the missing criticism.

The output status `disputed`, `blocked`, or `incomplete` may therefore be correct even when all three models voted and most objections have ID-specific author signoffs.

## Historical sessions

SHA-256-frozen old drafts, their ballots, and signoffs are **immutable**. Upgrading to M5.6 does not silently rewrite a draft that was previously shortened. For a previous `disputed` final record with `[Context truncated]`, start a new debate after updating the app. A running/unsettled session is only eligible for `/resume` under the existing exact-call journal and deadline rules.

This release **does not** repair a critique JSON record that the provider itself ended before completing. That is a separate evidence-integrity problem. Using a truncated or unparseable critique as proof of resolution would be unsafe.

## Verification

The regression suite simulates long structured synthesis with no length-based rejection, incomplete-provider truncation markers, long M5 revisions, complete raw journals, full objection context and exact per-ID coverage. CI also runs the existing crash, recovery, TypeScript, API and frontend checks. Real authenticated three-CLI evaluation remains a separate smoke test and may incur provider usage.

Note: a provider might submit an apparently coherent JSON proposal that omits substantive issues without any truncation marker. This patch cannot prove semantic completeness; independent voting and original-author objection gates remain necessary.

## Resource and provider limits

There is **no silent application-level shortening** of successfully returned provider content. New prompts are accepted up to 1,000,000 characters; larger request bodies fail explicitly. Provider subprocess stdout still has an **8 MiB safety limit**: an over-limit result is rejected rather than partially used. Each selected model also has its own context window, output limits, quotas and execution timeouts. The council cannot override provider-owned restrictions or reconstruct missing bytes from interrupted output. Large full-context sessions can consume substantially more tokens and disk space.
