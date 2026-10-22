export const PROVIDER_IDS = ['codex', 'claude', 'gemini'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export interface AgentAdapter {
  id: ProviderId;
  propose(prompt: string): Promise<string>;
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
