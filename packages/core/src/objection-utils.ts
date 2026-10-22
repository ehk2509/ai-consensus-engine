import type { DebateObjection } from './debate.ts';

type Item = Record<string, unknown>;
export interface CritiqueDecode {
  records: Item[];
  errors: string[];
  /** True when the complete returned JSON could not be parsed. */
  unparseable: boolean;
}
function object(value: unknown): value is Item {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function unwrap(raw: string): string {
  return raw.trim().replace(/^\s*```(?:json)?\s*\n?/i, '').replace(/\n?\s*```\s*$/, '');
}
/** Recover only COMPLETE JSON objects from the objections array of a malformed payload.
 * Never guess incomplete object fields. Even after recovery, a parsing-failure sentinel is required.
 */
function recoverObjects(raw: string): Item[] {
  const found = /"objections"\s*:\s*\[/g.exec(raw);
  if (!found) return [];
  const start = found.index + found[0].length;
  const recovered: Item[] = [];
  let depth = 0, begin = -1, quoted = false, escaped = false;
  for (let i = start; i < raw.length && recovered.length < 32; i++) {
    const char = raw[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') { quoted = true; continue; }
    if (char === '{') { if (depth++ === 0) begin = i; continue; }
    if (char === '}') {
      if (depth > 0 && --depth === 0 && begin >= 0) {
        try {
          const item: unknown = JSON.parse(raw.slice(begin, i + 1));
          if (object(item)) recovered.push(item);
        } catch { /* A malformed object stays unresolved via the sentinel. */ }
        begin = -1;
      }
      continue;
    }
    if (char === ']' && depth === 0) break;
  }
  return recovered;
}
export function decodeCritique(raw: string): CritiqueDecode {
  const unwrapped = unwrap(raw);
  let parsed: unknown;
  try { parsed = JSON.parse(unwrapped); }
  catch {
    return { records: recoverObjects(unwrapped), errors: ['Critique JSON could not be parsed completely; some evidence may be missing.'], unparseable: true };
  }
  if (!object(parsed) || !Array.isArray(parsed.objections)) {
    return { records: [], errors: ['Critique must contain a structured objections array.'], unparseable: true };
  }
  const errors: string[] = [];
  if (parsed.objections.length > 32) errors.push('More than 32 objections were returned; excess records require review.');
  const records = parsed.objections.slice(0, 32).filter((value: unknown): value is Item => {
    if (!object(value) || typeof value.claim !== 'string' || !value.claim.trim() ||
        typeof value.criticism !== 'string' || !value.criticism.trim()) {
      errors.push('A malformed structured objection could not be accepted.');
      return false;
    }
    return true;
  });
  return { records, errors, unparseable: false };
}
function short(text: string, limit: number): string {
  return text.length <= limit ? text : text.slice(0, limit) + ' [excerpt]';
}
export interface ContextPack {
  text: string;
  includedIds: string[];
  omittedIds: string[];
  omittedCriticalIds: string[];
}
const critical = (o: DebateObjection) => o.severity === 'high' || o.severity === 'unspecified';
/** JSON stays parseable: NEVER truncate the serialized JSON text in the middle of an objection. */
export function packObjections(
  objections: readonly DebateObjection[], maxChars: number,
): ContextPack {
  const prioritized = [...objections].sort((a, b) =>
    Number(critical(b) && b.authorStatus !== 'confirmed_resolved' && b.authorStatus !== 'superseded') -
    Number(critical(a) && a.authorStatus !== 'confirmed_resolved' && a.authorStatus !== 'superseded') ||
    Number(critical(b)) - Number(critical(a)) ||
    b.round - a.round || a.id.localeCompare(b.id));
  const records: Item[] = [], includedIds: string[] = [], omittedIds: string[] = [], omittedCriticalIds: string[] = [];
  for (const o of prioritized) {
    const item = {
      id: o.id, round: o.round, author: o.author, target: o.target, severity: o.severity,
      kind: o.kind ?? 'substantive', claim: short(o.claim, 340),
      criticism: short(o.criticism, 520), resolution: o.resolution,
      authorStatus: o.authorStatus ?? 'open',
    };
    if (JSON.stringify([...records, item]).length <= maxChars) {
      records.push(item); includedIds.push(o.id);
    } else {
      omittedIds.push(o.id);
      if (critical(o) && o.authorStatus !== 'confirmed_resolved' && o.authorStatus !== 'superseded') omittedCriticalIds.push(o.id);
    }
  }
  return { text: JSON.stringify(records), includedIds, omittedIds, omittedCriticalIds };
}
