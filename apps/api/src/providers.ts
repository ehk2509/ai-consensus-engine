import type { AgentAdapter, ProviderId } from '../../../packages/core/src/types.ts';
import { runAgentProcess, AgentExecutionError } from './process.ts';

const INSTRUCTIONS = `You are participating in Round 1 of an independent multi-AI brainstorming session.\nOffer your own thoughtful, specific answer. Include assumptions, opportunities, constraints, and risks. Do not attempt to invent agreement with other models. Do not access external tools or modify files.\n\nUSER IDEA:\n`;

export function extractResponse(id: ProviderId, raw: string): string {
  if (id === 'codex') return raw;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { throw new AgentExecutionError('Provider returned invalid JSON.'); }
  if (!parsed || typeof parsed !== 'object') throw new AgentExecutionError('Provider returned invalid JSON.');
  const obj = parsed as Record<string, unknown>;
  if (id === 'claude' && obj.is_error === true) throw new AgentExecutionError('Claude reported an execution error.');
  if (id === 'gemini' && obj.error) throw new AgentExecutionError('Gemini reported an execution error.');
  const response = id === 'claude' ? obj.result : obj.response;
  if (typeof response !== 'string' || !response.trim()) throw new AgentExecutionError('Provider returned no textual response.');
  return response.trim();
}

export async function probeInstalledClis(): Promise<Array<{ id: ProviderId; installed: boolean }>> {
  const commands: Array<{ id: ProviderId; executable: string }> = [
    { id: 'codex', executable: 'codex' },
    { id: 'claude', executable: 'claude' },
    { id: 'gemini', executable: 'gemini' },
  ];
  return Promise.all(commands.map(async ({ id, executable }) => {
    try {
      await runAgentProcess({ executable, args: ['--version'], stdin: '', timeoutMs: 4000 });
      return { id, installed: true };
    } catch { return { id, installed: false }; }
  }));
}

export function createAdapters(timeoutMs = 90000): Map<string, AgentAdapter> {
  const specifications: Record<ProviderId, { executable: string; args: string[] }> = {
    codex: { executable: 'codex', args: ['exec', '--ephemeral', '--sandbox', 'read-only', '--skip-git-repo-check', '-'] },
    claude: { executable: 'claude', args: ['-p', '--output-format', 'json', '--tools', '', '--disallowedTools', 'mcp__*', '--max-turns', '1'] },
    gemini: { executable: 'gemini', args: ['-p', 'Respond thoughtfully to the user idea provided through stdin. Do not use tools.', '--output-format', 'json', '--approval-mode', 'default'] },
  };
  return new Map(Object.entries(specifications).map(([id, spec]) => [id, {
    id: id as ProviderId,
    async propose(prompt: string): Promise<string> {
      const raw = await runAgentProcess({ ...spec, stdin: INSTRUCTIONS + prompt, timeoutMs });
      return extractResponse(id as ProviderId, raw);
    },
  }]));
}
