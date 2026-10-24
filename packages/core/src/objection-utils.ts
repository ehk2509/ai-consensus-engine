import type { DebateObjection } from './debate.ts';

type Item = Record<string, unknown>;
export type CritiqueParseStatus = 'complete' | 'embedded_json' | 'incomplete' | 'invalid';
export interface CritiqueDecode {
  records: Item[];
  errors: string[];
  /** True when the complete returned JSON could not be parsed. */
  unparseable: boolean;
  /** Exact classification of the original provider response, before UI shortening. */
  status: CritiqueParseStatus;
}
function object(value: unknown): value is Item {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function unwrap(raw: string): string {
  return raw.trim().replace(/^\s*```(?:json)?\s*\n?/i, '').replace(/\n?\s*```\s*$/, '');
}
function validateObjections(value: unknown): { records: Item[]; errors: string[] } | null {
  if (!object(value) || !Array.isArray(value.objections)) return null;
  const errors: string[] = [];
  const records = value.objections.filter((item: unknown): item is Item => {
    if (!object(item) || typeof item.claim !== 'string' || !item.claim.trim() ||
        typeof item.criticism !== 'string' || !item.criticism.trim()) {
      errors.push('A malformed structured objection could not be accepted.');
      return false;
    }
    return true;
  });
  return { records, errors };
}
/** Find closed JSON objects without mistaking braces or quotes inside strings for structure.
 * A model may wrap otherwise valid JSON in a short explanation or Markdown fence.
 */
function completeJsonObjectAt(text: string, begin: number): { end: number; json: string } | null {
  let depth = 0, quoted = false, escaped = false;
  for (let i = begin; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) return { end: i + 1, json: text.slice(begin, i + 1) };
  }
  return null;
}
function embeddedCritique(raw: string): { records: Item[]; errors: string[] } | null {
  // Move past rejected complete objects; do not mistake example JSON for the critique.
  let offset = 0;
  while (offset < raw.length) {
    const start = raw.indexOf('{', offset);
    if (start < 0) break;
    const found = completeJsonObjectAt(raw, start);
    if (!found) { offset = start + 1; continue; }
    try {
      const parsed: unknown = JSON.parse(found.json);
      const validated = validateObjections(parsed);
      if (validated) return validated;
    } catch { /* Ignore incidental JSON-looking text. */ }
    offset = found.end;
  }
  return null;
}
/** Recover COMPLETE objection objects from an unfinished objections array.
 * Never reconstruct an unfinished object or invent claim/criticism text.
 */
function recoverObjects(raw: string): Item[] {
  const found = /"objections"\s*:\s*\[/.exec(raw);
  if (!found) return [];
  const start = found.index + found[0].length;
  const recovered: Item[] = [];
  let depth = 0, begin = -1, quoted = false, escaped = false;
  for (let i = start; i < raw.length; i++) {
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
        } catch { /* An invalid object must not be treated as a real objection. */ }
        begin = -1;
      }
      continue;
    }
    if (char === ']' && depth === 0) break;
  }
  return recovered;
}
function likelyIncompleteJson(raw: string): boolean {
  const begin = raw.indexOf('{');
  if (begin < 0) return false;
  // No closing balanced object means the provider returned an unfinished JSON root.
  return !completeJsonObjectAt(raw, begin);
}
export function decodeCritique(raw: string): CritiqueDecode {
  const unwrapped = unwrap(raw);
  try {
    const parsed: unknown = JSON.parse(unwrapped);
    const validated = validateObjections(parsed);
    if (!validated) return { records: [], errors: ['Critique must contain a structured objections array.'],
      unparseable: true, status: 'invalid' };
    return { ...validated, unparseable: false, status: 'complete' };
  } catch { /* Try a complete JSON object embedded in commentary. */ }
  const embedded = embeddedCritique(unwrapped);
  if (embedded) return { ...embedded, unparseable: false, status: 'embedded_json' };
  const recovered = validateObjections({ objections: recoverObjects(unwrapped) })!;
  const incomplete = likelyIncompleteJson(unwrapped);
  const reason = incomplete
    ? 'Provider response ended before its critique JSON object was complete.'
    : 'Provider returned malformed critique JSON.';
  return {
    records: recovered.records,
    errors: [reason + ' Fully formed objections were retained; unfinished content remains unverified.',
      ...recovered.errors],
    unparseable: true,
    status: incomplete ? 'incomplete' : 'invalid',
  };
}
export interface ContextPack {
  text: string;
  includedIds: string[];
  omittedIds: string[];
  omittedCriticalIds: string[];
}
export const isOpenCriticalObjection = (o: DebateObjection): boolean =>
  (o.severity === 'high' || o.severity === 'unspecified') &&
  (o.kind === 'parsing_failure' || (o.authorStatus !== 'confirmed_resolved' && o.authorStatus !== 'superseded'));

/** Lossless shared ledger: every record and every text field is transmitted exactly.
 * Historical maxChars arguments are accepted for compatibility, but never drop
 * objections or shorten their evidence. If a provider cannot accept the payload,
 * its call must fail visibly rather than silently evaluate an incomplete ledger.
 */
export function packObjections(
  objections: readonly DebateObjection[], _maxChars?: number,
): ContextPack {
  const ordered = [...objections].sort((a, b) =>
    a.round - b.round || a.id.localeCompare(b.id));
  const records = ordered.map(o => ({
    id: o.id, round: o.round, author: o.author, target: o.target,
    severity: o.severity, kind: o.kind ?? 'substantive',
    claim: o.claim, criticism: o.criticism, evidence: o.evidence,
    suggestedChange: o.suggestedChange, response: o.response,
    resolution: o.resolution, authorStatus: o.authorStatus ?? 'open',
    sourceEntryId: o.sourceEntryId,
  }));
  return { text: JSON.stringify(records), includedIds: ordered.map(o => o.id),
    omittedIds: [], omittedCriticalIds: [] };
}
