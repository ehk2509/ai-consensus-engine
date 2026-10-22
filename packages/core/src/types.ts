export const PROVIDER_IDS = ['codex', 'claude', 'gemini'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export interface AgentInvocationOptions {
  /** Upper bound for this specific turn. The session-wide deadline still takes precedence. */
  timeoutMs?: number;
}

export interface AgentAdapter {
  id: ProviderId;
  propose(prompt: string, signal?: AbortSignal, options?: AgentInvocationOptions): Promise<string>;
}

export type ProposalResult =
  | { provider: ProviderId; status: 'fulfilled'; content: string; durationMs: number }
  | { provider: ProviderId; status: 'rejected'; error: string; durationMs: number };

export interface BrainstormResult {
  runId: string;
  prompt: string;
  startedAt: string;
  finishedAt: string;
  proposals: ProposalResult[];
  status: 'completed' | 'partial' | 'failed';
}

export interface BrainstormRequest {
  prompt: string;
  providers: ProviderId[];
}
