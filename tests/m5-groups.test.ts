import test from 'node:test';
import assert from 'node:assert/strict';
import { groupRelatedObjections } from '../packages/core/src/objection-groups.ts';
import type { DebateObjection } from '../packages/core/src/debate.ts';

function point(id: string, author: DebateObjection['author'], claim: string, criticism: string,
  kind: DebateObjection['kind'] = 'substantive'): DebateObjection {
  return { id, author, target: 'claude', round: 1, claim, criticism,
    kind, severity: 'high', evidence: [], resolution: 'unresolved', authorStatus: 'open' };
}
const complaint = 'Source permission is required before commercial use of copyrighted forum post content';
const reason = 'Public accessibility alone does not provide rights to redistribute and commercially process the content';
test('M5 groups obvious duplicate source objections but preserves every author and original ID', () => {
  const data = [
    point('a1','codex',complaint,reason),
    point('a2','gemini',complaint,reason),
    point('a3','codex','Pricing elasticity requires evidence','A user signup cannot prove willingness to pay or a buyer budget'),
  ];
  const grouped = groupRelatedObjections(data);
  assert.equal(grouped.length, 2);
  const matching = grouped.find(g => g.objectionIds.length === 2);
  assert.deepEqual(matching?.objectionIds, ['a1','a2']);
  assert.equal(matching?.authorCount,2);
  assert.equal(new Set(grouped.flatMap(g => g.objectionIds)).size,3);
  assert.deepEqual(groupRelatedObjections([...data].reverse()),grouped);
});
test('M5 refuses to merge parsing failures or resolved evidence into unrelated concern groups', () => {
  const a=point('a1','codex',complaint,reason);
  const b=point('a2','gemini',complaint,reason,'parsing_failure');
  const c=point('a3','claude',complaint,reason);
  c.authorStatus='confirmed_resolved';
  const output=groupRelatedObjections([a,b,c]);
  assert.equal(output.length,2);
  assert.ok(output.every(g=>g.objectionIds.length===1));
  assert.equal(output.flatMap(g=>g.objectionIds).includes('a3'),false);
});
test('M5 avoids merging two different underlying integration failure modes', () => {
  const data=[
    point('x1','codex','Shopify to NetSuite API export permission blocks reconciliation','The NetSuite token scope rejects customer address fields'),
    point('x2','gemini','Shopify to NetSuite API export permission blocks reconciliation','The Shopify webhook retry configuration loses order update events'),
  ];
  const groups=groupRelatedObjections(data);
  assert.equal(groups.length,2);
});
