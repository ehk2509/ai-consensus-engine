<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import type { BrainstormResult, ProviderId } from '../../../packages/core/src/types.ts';
import type { DebateEntry, DebatePhase, DebateSession, DebateStatus } from '../../../packages/core/src/debate.ts';

type Mode = 'debate' | 'independent';
type SessionSummary = { id: string; prompt: string; providers: ProviderId[]; maxRounds: number; createdAt: string; updatedAt: string; status: DebateStatus; round: number };
const labels: Record<ProviderId, string> = { codex: 'Codex · OpenAI', claude: 'Claude Code', gemini: 'Gemini · Antigravity' };
const phases: DebatePhase[] = ['proposal', 'critique', 'rebuttal', 'revision'];
const phaseTitles: Record<DebatePhase, string> = { proposal: 'Independent proposals', critique: 'Peer critiques', rebuttal: 'Rebuttals', revision: 'Revised proposals', synthesis: 'Shared draft', vote: 'Independent voting' };
const options: ProviderId[] = ['codex', 'claude', 'gemini'];
const selected = ref<ProviderId[]>([...options]);
const mode = ref<Mode>('debate');
const prompt = ref('');
const maxRounds = ref(1);
const maxCalls = ref(40);
const maxDurationMinutes = ref(15);
const consensusEnabled = ref(true);
const quorum = ref<'unanimous' | 'two_thirds'>('unanimous');
const blockCritical = ref(true);
const pending = ref(false);
const result = ref<BrainstormResult | null>(null);
const debate = ref<DebateSession | null>(null);
const history = ref<SessionSummary[]>([]);
const error = ref('');
const connection = ref('');
const detected = ref<Partial<Record<ProviderId, boolean>>>({});
const activeProposal = ref<ProviderId | null>(null);
const visiblePhase = ref<DebatePhase | 'all'>('all');
const visibleRound = ref(-1);
let stream: EventSource | null = null;
let currentSessionId: string | null = null;
let requestGeneration = 0;

const valid = computed(() => prompt.value.trim().length >= 10 && prompt.value.length <= 12000 &&
  selected.value.length >= (mode.value === 'debate' ? 2 : 1));
const shownEntries = computed(() => (debate.value?.entries ?? []).filter((entry) =>
  (visiblePhase.value === 'all' || entry.phase === visiblePhase.value) &&
  (visibleRound.value === -1 || entry.round === visibleRound.value)));
const completed = computed(() => Boolean(debate.value && !['queued', 'running'].includes(debate.value.status)));
const completedCount = computed(() => debate.value?.entries.filter((entry) => entry.status === 'fulfilled').length ?? 0);
const estimatedCalls = computed(() => selected.value.length + maxRounds.value * (selected.value.length * (selected.value.length - 1) + 2 * selected.value.length) + (consensusEnabled.value ? selected.value.length + 1 : 0));

function markdown(content: string): string {
  return DOMPurify.sanitize(marked.parse(content, { async: false }) as string);
}
function formatTime(timestamp: string): string {
  return new Date(timestamp).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
function duration(ms: number) { return (ms / 1000).toFixed(1) + 's'; }
function stageLabel(entry: DebateEntry): string {
  return entry.phase === 'critique' && entry.target
    ? labels[entry.provider] + ' → ' + labels[entry.target]
    : labels[entry.provider];
}
function closeStream() { stream?.close(); stream = null; }
async function refreshHistory() {
  try {
    const response = await fetch('/api/debates', { cache: 'no-store' });
    if (!response.ok) return;
    const body = await response.json() as { sessions: SessionSummary[] };
    history.value = body.sessions;
  } catch { /* The UI remains usable when history cannot be loaded. */ }
}

async function loadSession(id: string) {
  const generation = requestGeneration;
  try {
    const response = await fetch('/api/debates/' + encodeURIComponent(id), { cache: 'no-store' });
    if (!response.ok) throw new Error('Could not retrieve debate session.');
    const incoming = await response.json() as DebateSession;
    if (currentSessionId !== id || generation !== requestGeneration) return;
    if (debate.value?.id !== id || incoming.events.length >= debate.value.events.length) debate.value = incoming;
    if (!['running', 'queued'].includes(incoming.status)) {
      pending.value = false;
      connection.value = '';
      closeStream();
      void refreshHistory();
    }
  } catch (cause) {
    if (currentSessionId === id) error.value = cause instanceof Error ? cause.message : 'Could not load session.';
  }
}
function subscribe(id: string) {
  closeStream();
  if (typeof EventSource === 'undefined') {
    connection.value = 'Live updates are unavailable in this browser. Reload this session to view its progress.';
    return;
  }
  stream = new EventSource('/api/debates/' + encodeURIComponent(id) + '/events');
  stream.addEventListener('update', () => {
    connection.value = '';
    void loadSession(id);
  });
  stream.onerror = () => {
    if (currentSessionId === id && !completed.value) connection.value = 'Live connection interrupted; reconnecting automatically…';
  };
}
async function openHistory(id: string) {
  requestGeneration += 1;
  currentSessionId = id;
  closeStream();
  error.value = '';
  result.value = null;
  debate.value = null;
  mode.value = 'debate';
  pending.value = false;
  await loadSession(id);
  const restored = debate.value as DebateSession | null;
  if (restored && ['queued', 'running'].includes(restored.status)) {
    pending.value = true;
    subscribe(id);
  }
}
async function cancelDebate() {
  if (!debate.value || !pending.value) return;
  try {
    const response = await fetch('/api/debates/' + encodeURIComponent(debate.value.id) + '/cancel', { method: 'POST' });
    if (!response.ok) throw new Error('Unable to request cancellation.');
    connection.value = 'Cancellation requested. Stopping active CLI processes…';
  } catch (cause) { error.value = cause instanceof Error ? cause.message : 'Unable to cancel debate.'; }
}
async function submit() {
  if (pending.value || !valid.value) return;
  requestGeneration += 1;
  currentSessionId = null;
  closeStream();
  error.value = '';
  connection.value = '';
  debate.value = null;
  result.value = null;
  visiblePhase.value = 'all';
  visibleRound.value = -1;
  activeProposal.value = null;
  pending.value = true;
  try {
    const isDebate = mode.value === 'debate';
    const response = await fetch(isDebate ? '/api/debates' : '/api/brainstorms', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: prompt.value.trim(), providers: selected.value, ...(isDebate ? { maxRounds: maxRounds.value, maxCalls: maxCalls.value, maxDurationMs: maxDurationMinutes.value * 60000, consensus: consensusEnabled.value, quorum: quorum.value, blockCritical: blockCritical.value } : {}) }),
    });
    const body: unknown = await response.json();
    if (!response.ok) {
      const message = typeof body === 'object' && body && 'error' in body && typeof body.error === 'string' ? body.error : 'Request failed.';
      throw new Error(message);
    }
    if (isDebate) {
      const { id } = body as { id: string };
      currentSessionId = id;
      await loadSession(id);
      if (!completed.value) subscribe(id);
      void refreshHistory();
    } else {
      result.value = body as BrainstormResult;
      pending.value = false;
    }
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Unable to connect to API.';
    pending.value = false;
  }
}
onMounted(async () => {
  void refreshHistory();
  try {
    const response = await fetch('/api/providers');
    if (!response.ok) return;
    const data = await response.json() as { providers: Array<{ id: ProviderId; installed: boolean }> };
    detected.value = Object.fromEntries(data.providers.map(({ id, installed }) => [id, installed]));
  } catch { /* CLI information is optional. */ }
});
onBeforeUnmount(closeStream);
</script>

<template>
  <main class="shell">
    <div class="eyebrow">MULTI-MODEL THINKING STUDIO · M3</div>
    <header>
      <div><h1>AI Consensus <span>Engine</span></h1><p>One idea. Multiple intelligences. A better-informed decision.</p></div>
      <span class="phase">03 / CONSENSUS COUNCIL</span>
    </header>
    <div class="app-layout">
      <div class="workspace">
        <section class="panel compose">
          <div class="section-top"><h2>Start a session</h2><span>Local AI council</span></div>
          <div class="mode-select" role="group" aria-label="Session mode">
            <button type="button" :class="{ active: mode === 'debate' }" :disabled="pending" @click="mode = 'debate'">Multi-round debate</button>
            <button type="button" :class="{ active: mode === 'independent' }" :disabled="pending" @click="mode = 'independent'">Independent proposals</button>
          </div>
          <label for="prompt">Your idea or question</label>
          <textarea id="prompt" v-model="prompt" maxlength="12000" :disabled="pending" placeholder="Describe a product idea, technical decision, or subject the council should challenge and improve…" />
          <div class="row small"><span>Minimum 10 characters</span><span>{{ prompt.length.toLocaleString() }} / 12,000</span></div>
          <div class="separate" />
          <h3>Select your council <span class="muted">({{ mode === 'debate' ? 'at least 2' : 'at least 1' }})</span></h3>
          <div class="providers">
            <label v-for="provider in options" :key="provider" class="provider" :class="{ selected: selected.includes(provider) }">
              <input v-model="selected" type="checkbox" :value="provider" :disabled="pending" />
              <span class="provider-icon">{{ provider === 'codex' ? '◎' : provider === 'claude' ? '✳' : '◇' }}</span>
              <span>{{ labels[provider] }}<small class="provider-status">{{ detected[provider] === true ? 'Detected' : detected[provider] === false ? 'CLI missing' : 'Checking CLI…' }}</small></span>
              <span class="check">{{ selected.includes(provider) ? '✓' : '+' }}</span>
            </label>
          </div>
          <div v-if="mode === 'debate'" class="round-config">
            <div><strong>Debate rounds</strong><p class="muted">Each round: peer critiques, rebuttals, then revised proposals. Higher values mean more CLI calls.</p></div>
            <select v-model.number="maxRounds" :disabled="pending" aria-label="Maximum debate rounds">
              <option :value="1">1 round</option><option :value="2">2 rounds</option><option :value="3">3 rounds</option>
            </select>
          </div>
          <div v-if="mode === 'debate'" class="round-config">
          <div><strong>Execution budget</strong><p class="muted">Never exceed this many model calls or minutes. Default one-round three-agent debate needs up to 15 calls.</p></div>
          <div class="budget-controls"><label>Max calls <select v-model.number="maxCalls" :disabled="pending"><option v-for="n in [8, 15, 27, 39, 40]" :key="n" :value="n">{{ n }}</option></select></label><label>Minutes <select v-model.number="maxDurationMinutes" :disabled="pending"><option v-for="n in [3, 5, 10, 15, 30]" :key="n" :value="n">{{ n }}</option></select></label></div>
        </div>
        <div v-if="mode === 'debate'" class="consensus-config">
          <label class="consensus-toggle"><input v-model="consensusEnabled" type="checkbox" :disabled="pending" /> Generate independent consensus votes and final report</label>
          <div v-if="consensusEnabled" class="consensus-options">
            <label>Acceptance policy
              <select v-model="quorum" :disabled="pending" aria-label="Voting policy"><option value="unanimous">Unanimous</option><option value="two_thirds">At least two-thirds</option></select>
            </label>
            <label class="consensus-toggle"><input v-model="blockCritical" type="checkbox" :disabled="pending" /> Block unresolved critical objections</label>
          </div>
          <p class="muted">Approximate maximum: {{ estimatedCalls }} model calls for selected providers and rounds. Voting never implies facts have been verified.</p>
          <p v-if="estimatedCalls > maxCalls" class="warning" role="status">The configured {{ maxCalls }}-call budget may prevent consensus voting. Reduce rounds or turn off voting.</p>
        </div>
        <div class="row footer-row"><span class="muted">Local accounts · Traceable objections, independent votes, no forced agreement.</span><button :disabled="!valid || pending" @click="submit">{{ pending ? 'Council is working…' : mode === 'debate' ? 'Start debate →' : 'Generate perspectives →' }}</button></div>
          <p v-if="error" class="error" role="alert">{{ error }}</p>
          <p v-if="connection" class="warning" role="status">{{ connection }}</p>
          <button v-if="pending && debate" class="cancel-action" type="button" @click="cancelDebate">Cancel current debate</button>
        </section>
        <section v-if="debate" class="results" aria-live="polite">
          <div class="section-top"><h2>Debate timeline</h2><span>{{ debate.id.slice(0, 8) }} · {{ debate.status.toUpperCase() }}</span></div>
          <div class="panel status-panel">
            <div class="row"><strong>{{ completed ? 'Session finished' : 'Council deliberating' }}</strong><span class="pill" :class="debate.status === 'completed' ? 'fulfilled' : debate.status === 'running' ? 'working' : 'rejected'">{{ debate.status.toUpperCase() }}</span></div>
            <p class="muted">Round {{ debate.round }} / {{ debate.request.maxRounds }} · {{ completedCount }} successful debate steps · {{ debate.calls ?? 0 }}/{{ debate.request.maxCalls ?? 40 }} calls</p>
            <p class="muted">Debate result: <strong>{{ debate.debateStatus ?? (completed ? debate.status : 'running') }}</strong> · Consensus: <strong>{{ debate.consensus?.status ?? 'not requested' }}</strong></p>
            <div class="progress-track"><div class="progress-fill" :style="{ width: (completed ? 100 : Math.min(99, (debate.events.filter((event) => event.type === 'stage').length / (1 + debate.request.maxRounds * 3 + (debate.request.consensus ? 2 : 0))) * 100)) + '%' }" /></div>
            <p v-if="debate.phase" class="current-step">Current stage: {{ phaseTitles[debate.phase] }}</p>
            <p v-if="debate.error" class="warning">{{ debate.error }}</p>
          </div>
          <div class="filter-bar" aria-label="Filter debate records">
            <button v-for="filter in ['all', ...phases] as const" :key="filter" type="button" :class="{ active: visiblePhase === filter }" @click="visiblePhase = filter">{{ filter === 'all' ? 'All stages' : phaseTitles[filter] }}</button>
          </div>
          <div class="filter-bar" aria-label="Filter debate rounds">
            <button type="button" :class="{ active: visibleRound === -1 }" @click="visibleRound = -1">All rounds</button>
            <button v-for="round in [0, ...Array.from({ length: debate.request.maxRounds }, (_, index) => index + 1)]" :key="round" type="button" :class="{ active: visibleRound === round }" @click="visibleRound = round">{{ round === 0 ? 'Initial' : 'Round ' + round }}</button>
          </div>
          <p v-if="shownEntries.length === 0" class="muted">No responses for this stage yet.</p>
          <article v-for="entry in shownEntries" :key="entry.id" class="panel timeline-entry">
            <div class="entry-top">
              <div><span class="phase-name">{{ phaseTitles[entry.phase] }} · {{ entry.round === 0 ? 'initial' : 'round ' + entry.round }}</span><h3>{{ stageLabel(entry) }}</h3></div>
              <span class="pill" :class="entry.status === 'fulfilled' ? 'fulfilled' : 'rejected'">{{ entry.status }}</span>
            </div>
            <details :open="entry.phase === 'proposal' || entry.phase === 'revision'">
              <summary>{{ entry.status === 'fulfilled' ? 'Read response' : 'See outcome' }}</summary>
              <div v-if="entry.status === 'fulfilled'" class="markdown response" v-html="markdown(entry.content ?? '')" />
              <p v-else class="warning">{{ entry.error }}</p>
            </details>
            <small class="muted">{{ duration(entry.durationMs) }} · {{ formatTime(entry.createdAt) }}</small>
          </article>
          <section v-if="(debate.objections ?? []).length" class="objections-panel panel">
            <div class="section-top"><h2>Tracked objections</h2><span>{{ debate.objections.length }} records</span></div>
            <article v-for="objection in debate.objections" :key="objection.id" class="objection-item">
              <div class="row"><strong>{{ objection.claim }}</strong><span class="pill" :class="objection.resolution === 'accepted' || objection.resolution === 'partially_accepted' ? 'fulfilled' : 'working'">{{ objection.resolution }}</span></div>
              <p class="muted">Round {{ objection.round }} · {{ labels[objection.author] }} → {{ labels[objection.target] }} · Severity: {{ objection.severity }}</p>
              <p>{{ objection.criticism }}</p>
              <p v-if="objection.response"><strong>Rebuttal:</strong> {{ objection.response }}</p>
              <p class="muted">Author sign-off: {{ objection.authorStatus ?? 'open' }}<span v-if="objection.supersededBy"> · Superseded by {{ objection.supersededBy }}</span></p>
            </article>
          </section>
          <section v-if="debate.consensus" class="panel consensus-report">
            <div class="section-top">
              <h2>Consensus decision</h2>
              <span class="pill" :class="['unanimous', 'qualified'].includes(debate.consensus.status) ? 'fulfilled' : 'working'">{{ debate.consensus.status.replaceAll('_', ' ') }}</span>
            </div>
            <p class="muted">{{ debate.consensus.reason || 'The council is evaluating the shared draft.' }}</p>
            <p class="muted">Consensus records model judgments, not externally verified facts. The facilitator's self-authored vote is identified and cannot alone satisfy the non-author acceptance requirement.</p>
            <p class="muted">Quorum: {{ debate.consensus.policy.quorum.replace('_', '-') }} · Critical objection gate: {{ debate.consensus.policy.blockCritical ? 'Enabled' : 'Disabled' }} · {{ debate.consensus.votes.length }} ballots</p>
            <div v-if="debate.consensus.draft" class="draft-wrap">
              <div class="row"><strong>Frozen shared proposal</strong><span class="muted">Facilitator: {{ labels[debate.consensus.draft.author] }}</span></div>
              <p class="muted">Draft SHA-256: <code>{{ debate.consensus.draft.sha256 ?? 'unavailable' }}</code> · Model: {{ debate.consensus.draft.provenance?.model ?? 'unreported' }} · Local CLI adapter</p>
              <div class="markdown response" v-html="markdown(debate.consensus.draft.proposal)" />
            </div>
            <div v-if="debate.consensus.votes.length" class="voting-grid">
              <article v-for="vote in debate.consensus.votes" :key="vote.provider" class="vote-record">
                <div class="row"><strong>{{ labels[vote.provider] }}</strong><span class="pill" :class="vote.verdict === 'accept' ? 'fulfilled' : 'working'">{{ vote.verdict || 'invalid vote' }}</span></div>
                <p>{{ vote.rationale || vote.error }}</p>
                <p v-if="vote.concerns.length" class="muted">Concerns: {{ vote.concerns.join('; ') }}</p>
                <p class="muted">{{ vote.resolvedObjectionIds.length }} objections independently signed off · {{ vote.authoredDraft ? 'Draft author voting' : 'Non-author voting' }}</p>
                <details v-if="vote.rawResponse" class="vote-audit"><summary>Audit: raw ballot and provenance</summary><pre>{{ vote.rawResponse }}</pre><p class="muted">Model: {{ vote.provenance?.model ?? 'unreported' }} · Prompt hash: {{ vote.provenance?.promptSha256 ?? 'unavailable' }}</p></details>
              </article>
            </div>
            <div v-if="debate.consensus.unresolvedCriticalObjectionIds?.length" class="warning">
              {{ debate.consensus.unresolvedCriticalObjectionIds.length }} unresolved high-severity or unstructured objections across debate rounds.
              {{ debate.consensus.policy.blockCritical ? 'These currently block consensus.' : 'The gate is disabled: these are recorded but do not block the configured vote.' }}
            </div>
            <div v-if="debate.consensus.draft?.evidence.length" class="evidence-register">
              <h3>Evidence register — not independently verified</h3>
              <div v-for="evidence in debate.consensus.draft.evidence" :key="evidence.id" class="evidence-item"><strong>{{ evidence.id }}</strong> {{ evidence.claim }} <span class="muted">{{ evidence.source ? 'Reported source: ' + evidence.source : 'No source provided' }}</span></div>
            </div>
            <a v-if="debate.consensus.reportMarkdown" class="download-report" :href="'/api/debates/' + debate.id + '/report'">Download decision report (.md) ↗</a>
          </section>
          <div v-if="completed && !debate.consensus" class="final-note panel">
            <strong>Debate {{ debate.status }}</strong>
            <p>This run did not request consensus voting. M3 voting is optional for API clients and enabled by default in the UI.</p>
          </div>
        </section>
        <section v-if="result" class="results">
          <div class="section-top"><h2>Independent perspectives</h2><span>{{ result.status.toUpperCase() }} · {{ result.runId.slice(0, 8) }}</span></div>
          <div class="result-grid">
            <article v-for="proposal in result.proposals.filter((p) => activeProposal === null || p.provider === activeProposal)" :key="proposal.provider" class="panel result-card" :class="{ wide: activeProposal !== null }">
              <div class="row"><strong>{{ labels[proposal.provider] }}</strong><span class="pill" :class="proposal.status">{{ proposal.status === 'fulfilled' ? 'RESPONDED' : 'FAILED' }}</span></div>
              <button class="text-action" type="button" @click="activeProposal = activeProposal === proposal.provider ? null : proposal.provider">{{ activeProposal === proposal.provider ? 'Show all perspectives' : 'Expand to read' }}</button>
              <div v-if="proposal.status === 'fulfilled'" class="markdown response" v-html="markdown(proposal.content)" />
              <p v-else class="warning">{{ proposal.error }}</p>
              <small class="muted">{{ duration(proposal.durationMs) }}</small>
            </article>
          </div>
        </section>
      </div>
      <aside class="sidebar">
        <div class="panel history-panel">
          <div class="section-top"><h2>Debate history</h2><button class="refresh" type="button" @click="refreshHistory">↻</button></div>
          <p v-if="history.length === 0" class="muted">Your debate sessions will appear here and persist across server restarts.</p>
          <button v-for="item in history" :key="item.id" type="button" class="history-item" :class="{ chosen: debate?.id === item.id }" @click="openHistory(item.id)">
            <strong>{{ item.prompt }}</strong><span>{{ item.status }} · {{ formatTime(item.createdAt) }}</span>
          </button>
        </div>
        <p class="side-note">Debates are stored locally in <code>.ace-data/debates</code>. The app does not save your CLI account credentials.</p>
      </aside>
    </div>
    <footer>Local-first M3 · Independent voting and traceable consensus · Evidence claims remain unverified</footer>
  </main>
</template>
