import test from 'node:test';
import assert from 'node:assert/strict';
import { createDebateSession, executeDebate, validateDebateRequest } from '../packages/core/src/debate.ts';
import type { AgentAdapter, ProviderId } from '../packages/core/src/types.ts';

const providers: ProviderId[] = ['codex', 'claude'];
const proposal = 'Long proposal body: ' + 'P'.repeat(36000);
const synthesized = 'Independent synthesis: ' + 'S'.repeat(58000);
const critique = JSON.stringify({ strengths: ['Complete diagnosis'], objections:
  Array.from({ length: 36 }, (_, i) => ({
    claim: 'Detailed claim #' + i + ' ' + 'C'.repeat(420),
    criticism: 'Complete explanation ' + i + ' ' + 'X'.repeat(500),
    evidence: Array.from({ length: 8 }, (_, j) => 'Source ' + j + ': ' + 'E'.repeat(75)),
    severity: 'medium', suggestedChange: 'Make this verifiable ' + 'M'.repeat(250),
  })) });
const voteConcerns = Array.from({ length: 22 }, (_, i) => 'Concern #' + i + ': ' + 'V'.repeat(950));

test('M5.6 preserves above-threshold raw replies, 36 critiques per source, full prompt context and complete journals', async () => {
  const prompts: string[] = [];
  const req = validateDebateRequest({
    prompt: 'Audit an evidence-heavy full-length plan without truncating source material.',
    providers, maxRounds: 1, unlimitedBudget: true, consensus: true, negotiationCycles: 0,
  });
  const session = createDebateSession(req);
  const adapters = new Map<string, AgentAdapter>(providers.map(id => [id, {
    id, propose: async (prompt: string): Promise<string> => {
      prompts.push(prompt);
      if (prompt.includes('Stage: CRITIQUE')) {
        assert.ok(prompt.includes(proposal));
        return critique;
      }
      if (prompt.includes('Stage: REBUTTAL')) {
        const match = /<objections_with_stable_ids>\n([^]*?)\n<\/objections_with_stable_ids>/.exec(prompt);
        assert.ok(match);
        const own = JSON.parse(match[1]!) as Array<{id:string,claim:string,evidence:string[]}>;
        assert.equal(own.length, 36);
        assert.equal(own[0]!.evidence.length, 8);
        return JSON.stringify({ responses: own.map(o => ({
          objectionId: o.id, resolution: 'accepted', reason: 'Reviewed fully: ' + 'R'.repeat(3200),
        })) });
      }
      if (prompt.includes('Stage: REVISE')) {
        assert.ok(prompt.includes('R'.repeat(3200)));
        assert.ok(prompt.includes('X'.repeat(500)));
        return proposal;
      }
      if (prompt.includes('Stage: CONSENSUS DRAFT')) {
        const match = /<shared_objections_excerpted>\n([^]*?)\n<\/shared_objections_excerpted>/.exec(prompt);
        assert.ok(match);
        const shared = JSON.parse(match[1]!) as Array<{id:string,criticism:string,evidence:string[]}>;
        assert.equal(shared.length, 72);
        assert.ok(shared.every(o => o.criticism.length > 500 && o.evidence.length === 8));
        assert.ok(match[1]!.length > 56000);
        return JSON.stringify({ proposal: synthesized,
          assumptions: Array.from({length: 16}, (_, i) => 'A'+i),
          evidence: Array.from({length: 16},(_,i) => ({claim:'Evidence claim '+i,source:'S'+i})),
        });
      }
      if (prompt.includes('Stage: INDEPENDENT CONSENSUS VOTE')) {
        assert.ok(prompt.includes(synthesized));
        return JSON.stringify({ verdict: 'conditional', rationale: 'More validation required',
          concerns: voteConcerns, resolvedObjectionIds: [], supersessions: [],
        });
      }
      return proposal;
    },
  }]));
  await executeDebate(session, adapters, async () => {});
  assert.equal(session.status, 'completed');
  assert.equal(session.objections.length, 72);
  assert.ok(session.entries.filter(e => e.phase === 'proposal').every(e => e.content === proposal));
  assert.ok(session.entries.filter(e => e.phase === 'critique').every(e => e.content === critique && e.content.length > 25000));
  assert.ok(session.objections.every(o => o.claim.length > 420 && o.criticism.length > 500 && o.evidence.length === 8));
  assert.ok(session.objections.every(o => o.response === 'Reviewed fully: ' + 'R'.repeat(3200)));
  assert.equal(session.consensus?.status, 'disputed');
  assert.equal(session.consensus?.draft?.proposal, synthesized);
  assert.equal(session.consensus?.draft?.assumptions.length, 16);
  assert.equal(session.consensus?.draft?.evidence.length, 16);
  assert.equal(session.consensus?.objectionCoverage?.included, 72);
  assert.equal(session.consensus?.objectionCoverage?.omitted, 0);
  assert.equal(session.consensus?.objectionCoverage?.excerpted, false);
  const synthesis = session.consensus?.callJournal?.find(c => c.stage === 'synthesis');
  assert.ok(synthesis?.rawResponse && synthesis.rawResponse.length > 40000 && synthesis.status === 'fulfilled');
  assert.equal(JSON.parse(synthesis.rawResponse).proposal, synthesized);
  assert.ok(session.consensus?.votes.every(v => v.concerns.length === voteConcerns.length));
  assert.ok(session.consensus?.callJournal?.filter(c => c.stage === 'vote').every(c => (c.rawResponse?.length ?? 0) > 15000));
  const report = session.consensus?.reportMarkdown ?? '';
  assert.ok(report.includes(synthesized));
  assert.ok(report.includes('E'.repeat(75)));
  assert.ok(report.includes('R'.repeat(3200)));
  assert.ok(report.includes('X'.repeat(500)));
  assert.ok(prompts.length > 0);
});

test('raw provider-length constraints reject explicitly, but complete structured content is never silently sliced', () => {
  const req = validateDebateRequest({
    prompt: 'P'.repeat(1000000), providers, consensus: true, maxRounds: 1,
  });
  assert.equal(req.prompt.length, 1000000);
  assert.throws(() => validateDebateRequest({
    prompt: 'P'.repeat(1000001), providers, maxRounds: 1,
  }), /1,000,000/);
});
