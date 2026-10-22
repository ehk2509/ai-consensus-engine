import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgentProcess, AgentExecutionError } from '../apps/api/src/process.ts';
import { extractResponse } from '../apps/api/src/providers.ts';

const node = process.execPath;

test('sends arbitrary user input through stdin without a shell', async () => {
  const data = 'idea with && ; $(touch /tmp/should-not-be-created)';
  const response = await runAgentProcess({ executable: node, args: ['-e', 'process.stdin.setEncoding("utf8"); let s=""; process.stdin.on("data",x=>s+=x); process.stdin.on("end",()=>process.stdout.write(s))'], stdin: data, timeoutMs: 3000 });
  assert.equal(response, data);
});

test('returns a safe error for missing executable', async () => {
  await assert.rejects(runAgentProcess({ executable: 'ace-nonexistent-cli-00000', args: [], stdin: 'hello', timeoutMs: 1000 }), (error: unknown) => error instanceof AgentExecutionError && /not installed/.test(error.message));
});

test('terminates commands that exceed timeout', async () => {
  await assert.rejects(runAgentProcess({ executable: node, args: ['-e', 'setInterval(()=>{},1000)'], stdin: '', timeoutMs: 150 }), (error: unknown) => error instanceof AgentExecutionError && /timed out/.test(error.message));
});

test('rejects excessive output instead of collecting unbounded data', async () => {
  await assert.rejects(runAgentProcess({ executable: node, args: ['-e', 'process.stdout.write("x".repeat(900000))'], stdin: '', timeoutMs: 3000 }), (error: unknown) => error instanceof AgentExecutionError && /safety limit/.test(error.message));
});

test('parses provider output without accepting CLI error objects', () => {
  assert.equal(extractResponse('codex', '  proposal  '), '  proposal  ');
  assert.equal(extractResponse('claude', JSON.stringify({ result: 'a response' })), 'a response');
  assert.equal(extractResponse('gemini', JSON.stringify({ response: 'another response' })), 'another response');
  assert.throws(() => extractResponse('gemini', JSON.stringify({ error: { code: 403 } })), AgentExecutionError);
  assert.throws(() => extractResponse('claude', 'not json'), AgentExecutionError);
});
