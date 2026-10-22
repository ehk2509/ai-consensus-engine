<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { BrainstormResult, ProviderId } from '../../../packages/core/src/types.ts';

const providerLabels: Record<ProviderId, string> = { codex: 'Codex · OpenAI', claude: 'Claude Code', gemini: 'Gemini CLI' };
const options: ProviderId[] = ['codex', 'claude', 'gemini'];
const selected = ref<ProviderId[]>([...options]);
const prompt = ref('');
const pending = ref(false);
const result = ref<BrainstormResult | null>(null);
const error = ref('');
const detected = ref<Partial<Record<ProviderId, boolean>>>({});
onMounted(async () => {
  try {
    const response = await fetch('/api/providers');
    if (!response.ok) return;
    const data = await response.json() as { providers: Array<{ id: ProviderId; installed: boolean }> };
    detected.value = Object.fromEntries(data.providers.map(({ id, installed }) => [id, installed]));
  } catch { /* API status is also reflected by failed brainstorm submissions. */ }
});
const valid = computed(() => prompt.value.trim().length >= 10 && prompt.value.length <= 12000 && selected.value.length > 0);

async function submit() {
  if (pending.value || !valid.value) return;
  error.value = '';
  result.value = null;
  pending.value = true;
  try {
    const response = await fetch('/api/brainstorms', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: prompt.value, providers: selected.value }),
    });
    const body: unknown = await response.json();
    if (!response.ok) {
      const message = typeof body === 'object' && body && 'error' in body && typeof body.error === 'string' ? body.error : 'Request failed.';
      throw new Error(message);
    }
    result.value = body as BrainstormResult;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Unable to connect to API.';
  } finally { pending.value = false; }
}
</script>

<template>
  <main class="shell">
    <div class="eyebrow">MULTI-MODEL THINKING STUDIO · M1</div>
    <header>
      <div><h1>AI Consensus <span>Engine</span></h1><p>One idea. Multiple intelligences. A better-informed decision.</p></div>
      <span class="phase">01 / INDEPENDENT PROPOSALS</span>
    </header>
    <section class="panel compose">
      <div class="section-top"><h2>Start a brainstorm</h2><span>Step 1 of 3: Explore perspectives</span></div>
      <label for="prompt">Your idea or question</label>
      <textarea id="prompt" v-model="prompt" maxlength="12000" placeholder="Describe your idea, problem, or decision. The council will independently analyze it…" />
      <div class="row small"><span>Write at least 10 characters.</span><span>{{ prompt.length.toLocaleString() }} / 12,000</span></div>
      <div class="separate" />
      <h3>Select your council</h3>
      <div class="providers">
        <label v-for="provider in options" :key="provider" class="provider" :class="{ selected: selected.includes(provider) }">
          <input v-model="selected" type="checkbox" :value="provider" :disabled="pending" />
          <span class="provider-icon">{{ provider === 'codex' ? '◎' : provider === 'claude' ? '✳' : '◇' }}</span>
          <span>{{ providerLabels[provider] }}<small class="provider-status">{{ detected[provider] === true ? 'Detected' : detected[provider] === false ? 'CLI missing' : 'Checking CLI…' }}</small></span>
          <span class="check">{{ selected.includes(provider) ? '✓' : '+' }}</span>
        </label>
      </div>
      <div class="row footer-row"><span class="muted">Runs locally using your installed CLI accounts.</span><button :disabled="!valid || pending" @click="submit">{{ pending ? 'Consulting the council…' : 'Generate independent proposals →' }}</button></div>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
    </section>
    <section v-if="result" class="results">
      <div class="section-top"><h2>Perspectives</h2><span>{{ result.status.toUpperCase() }} · {{ result.runId.slice(0, 8) }}</span></div>
      <p class="muted">These proposals are independent. Cross-review, rebuttals, and consensus voting arrive in M2–M3.</p>
      <div class="result-grid">
        <article v-for="proposal in result.proposals" :key="proposal.provider" class="panel result-card">
          <div class="row"><strong>{{ providerLabels[proposal.provider] }}</strong><span class="pill" :class="proposal.status">{{ proposal.status === 'fulfilled' ? 'RESPONDED' : 'FAILED' }}</span></div>
          <div class="response">{{ proposal.status === 'fulfilled' ? proposal.content : proposal.error }}</div>
          <small class="muted">{{ (proposal.durationMs / 1000).toFixed(1) }} seconds</small>
        </article>
      </div>
    </section>
    <footer>Local-first foundation · No account tokens stored by the application · Multi-round debate coming next</footer>
  </main>
</template>
