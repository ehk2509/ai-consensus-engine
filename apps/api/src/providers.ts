import type { AgentAdapter, ProviderId } from '../../../packages/core/src/types.ts';
import { runAgentProcess, AgentExecutionError } from './process.ts';

const INSTRUCTIONS = `You are participating in Round 1 of an independent multi-AI brainstorming session.\nOffer your own thoughtful, specific answer. Include assumptions, opportunities, constraints, and risks. Do not attempt to invent agreement with other models. Do not access external tools or modify files.\n\nUSER IDEA:\n`;

/** Antigravity (`agy`) print mode only reads stdin as stream-json, one NDJSON user message per turn. */
export function encodeAntigravityInput(text: string): string {
  return JSON.stringify({ event: 'user', message: { content: text } }) + '\n';
}

function extractAntigravityResponse(raw: string): string {
  let result: Record<string, unknown> | undefined;
  for (const line of raw.split('\n')) {
    let event: unknown;
    try { event = JSON.parse(line); } catch { continue; }
    if (event && typeof event === 'object' && (event as Record<string, unknown>).event === 'result') {
      result = (event as Record<string, unknown>).result as Record<string, unknown> | undefined;
    }
  }
  if (!result || typeof result !== 'object') throw new AgentExecutionError('Provider returned no result event.');
  if (result.status !== 'SUCCESS') throw new AgentExecutionError('Gemini (Antigravity) reported an execution error.');
  if (typeof result.response !== 'string' || !result.response.trim()) throw new AgentExecutionError('Provider returned no textual response.');
  return result.response.trim();
}

export function extractResponse(id: ProviderId, raw: string): string {
  if (id === 'codex') return raw;
  if (id === 'gemini') return extractAntigravityResponse(raw);
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { throw new AgentExecutionError('Provider returned invalid JSON.'); }
  if (!parsed || typeof parsed !== 'object') throw new AgentExecutionError('Provider returned invalid JSON.');
  const obj = parsed as Record<string, unknown>;
  if (id === 'claude' && obj.is_error === true) throw new AgentExecutionError('Claude reported an execution error.');
  const response = id === 'claude' ? obj.result : obj.response;
  if (typeof response !== 'string' || !response.trim()) throw new AgentExecutionError('Provider returned no textual response.');
  return response.trim();
}

export async function probeInstalledClis(): Promise<Array<{ id: ProviderId; installed: boolean }>> {
  const commands: Array<{ id: ProviderId; executable: string }> = [
    { id: 'codex', executable: 'codex' },
    { id: 'claude', executable: 'claude' },
    { id: 'gemini', executable: 'agy' },
  ];
  return Promise.all(commands.map(async ({ id, executable }) => {
    try {
      await runAgentProcess({ executable, args: ['--version'], stdin: '', timeoutMs: 4000 });
      return { id, installed: true };
    } catch { return { id, installed: false }; }
  }));
}

export function createAdapters(timeoutMs = 90000): Map<string, AgentAdapter> {
  const specifications: Record<ProviderId, { executable: string; args: string[]; encodeStdin?: (text: string) => string }> = {
    codex: { executable: 'codex', args: ['exec', '--ephemeral', '--sandbox', 'read-only', '--skip-git-repo-check', '-'] },
    claude: { executable: 'claude', args: ['-p', '--output-format', 'json', '--tools', '', '--disallowedTools', 'mcp__*', '--max-turns', '1'] },
    // Gemini CLI no longer accepts Google OAuth; Gemini is reached through the Antigravity CLI and its login.
    gemini: { executable: 'agy', args: ['--input-format', 'stream-json', '--output-format', 'stream-json', '--mode', 'plan', '--sandbox', '--disable-slash-commands', '-p='], encodeStdin: encodeAntigravityInput },
  };
  return new Map(Object.entries(specifications).map(([id, { encodeStdin, ...spec }]) => [id, {
    id: id as ProviderId,
    async propose(prompt: string): Promise<string> {
      const text = INSTRUCTIONS + prompt;
      const raw = await runAgentProcess({ ...spec, stdin: encodeStdin ? encodeStdin(text) : text, timeoutMs });
      return extractResponse(id as ProviderId, raw);
    },
  }]));
}
