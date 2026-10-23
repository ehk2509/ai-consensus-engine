import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { durableReplace } from './durable-json.ts';
import type { ProviderId } from '../../../packages/core/src/types.ts';
import { AgentExecutionError } from './process.ts';

export interface DailyQuotaLimits {
  total?: number;
  providers?: Partial<Record<ProviderId, number>>;
}
export interface DailyQuotaSnapshot {
  date: string;
  total: number;
  providers: Record<ProviderId, number>;
  limits: DailyQuotaLimits;
}
export function parseQuotaLimit(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 100000) {
    throw new Error('Daily call quota must be an integer between 0 and 100000.');
  }
  return n;
}
export function environmentQuotaLimits(env: NodeJS.ProcessEnv): DailyQuotaLimits {
  return {
    total: parseQuotaLimit(env.ACE_DAILY_CALL_LIMIT),
    providers: {
      codex: parseQuotaLimit(env.ACE_CODEX_DAILY_CALL_LIMIT),
      claude: parseQuotaLimit(env.ACE_CLAUDE_DAILY_CALL_LIMIT),
      gemini: parseQuotaLimit(env.ACE_GEMINI_DAILY_CALL_LIMIT),
    },
  };
}
export class DailyCallQuota {
  private chain: Promise<void> = Promise.resolve();
  private readonly directory: string;
  private readonly limits: DailyQuotaLimits;
  constructor(directory: string, limits: DailyQuotaLimits = {}) { this.directory = directory; this.limits = limits; }
  private date(): string { return new Date().toISOString().slice(0, 10); }
  private filename(date: string): string { return join(this.directory, '.quota-' + date + '.json'); }
  private async load(date: string): Promise<DailyQuotaSnapshot> {
    try {
      const value = JSON.parse(await readFile(this.filename(date), 'utf8')) as DailyQuotaSnapshot;
      if (value.date !== date || !Number.isInteger(value.total) || value.total < 0 ||
          !['codex', 'claude', 'gemini'].every(id => Number.isInteger(value.providers?.[id as ProviderId]) &&
            value.providers[id as ProviderId] >= 0)) throw new Error('Invalid durable quota ledger.');
      return { ...value, limits: this.limits };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return { date, total: 0, providers: { codex: 0, claude: 0, gemini: 0 }, limits: this.limits };
    }
  }
  /** Serialize reservations and persist each before any external provider is contacted.
   * Crashes conservatively retain reservations. Never refund a potentially billed call.
   */
  async reserve(provider: ProviderId): Promise<void> {
    const operation = this.chain.catch(() => {}).then(async () => {
      const date = this.date();
      const value = await this.load(date);
      if (this.limits.total !== undefined && value.total >= this.limits.total) {
        throw new AgentExecutionError('Daily total provider-call quota exhausted.');
      }
      if (this.limits.providers?.[provider] !== undefined &&
          value.providers[provider] >= this.limits.providers[provider]) {
        throw new AgentExecutionError('Daily ' + provider + ' call quota exhausted.');
      }
      value.total++;
      value.providers[provider]++;
      await durableReplace(this.filename(date), JSON.stringify(value));
    });
    this.chain = operation;
    await operation;
  }
  async snapshot(): Promise<DailyQuotaSnapshot> {
    await this.chain.catch(() => {});
    return this.load(this.date());
  }
}
