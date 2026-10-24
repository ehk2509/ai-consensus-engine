import { createHash } from 'node:crypto';
import type { DebateObjection } from './debate.ts';

export interface ObjectionGroup {
  id: string;
  /** Every original ID is retained; grouping never changes the objection ledger. */
  objectionIds: string[];
  representativeClaim: string;
  authorCount: number;
  severity: DebateObjection['severity'];
}
const normalizedWords = (value: string): Set<string> => new Set(
  value.toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(' ').filter(word => word.length > 2 && !new Set([
      'the','and','for','with','that','this','from','would','should','are','not',
      'but','will','into','does','can','have','has','than','was','its','their',
    ]).has(word)),
);
function nearDuplicate(left: DebateObjection, right: DebateObjection): boolean {
  if (left.kind === 'parsing_failure' || right.kind === 'parsing_failure') return false;
  const a = normalizedWords(left.claim + ' ' + left.criticism);
  const b = normalizedWords(right.claim + ' ' + right.criticism);
  if (a.size < 5 || b.size < 5) return false;
  const overlap = [...a].filter(token => b.has(token)).length;
  const union = new Set([...a, ...b]).size;
  // Intentionally very conservative: a false merge hides an independent objection.
  return overlap / union >= 0.85;
}
export function groupRelatedObjections(objections: readonly DebateObjection[]): ObjectionGroup[] {
  const groups: DebateObjection[][] = [];
  for (const objection of [...objections].sort((a, b) => a.id.localeCompare(b.id))) {
    if (objection.authorStatus === 'confirmed_resolved' || objection.authorStatus === 'superseded') continue;
    const match = groups.find(group => group.every(other => nearDuplicate(other, objection)));
    if (match) match.push(objection);
    else groups.push([objection]);
  }
  return groups.map(group => ({
    id: createHash('sha256').update(group.map(item => item.id).join('|')).digest('hex'),
    objectionIds: group.map(item => item.id),
    representativeClaim: group[0]!.claim,
    authorCount: new Set(group.map(item => item.author)).size,
    severity: group.some(item => item.severity === 'high' || item.severity === 'unspecified') ? 'high'
      : group.some(item => item.severity === 'medium') ? 'medium' : 'low',
  }));
}
