import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgentProcess, AgentExecutionError } from '../apps/api/src/process.ts';
import { encodeAntigravityInput, extractResponse } from '../apps/api/src/providers.ts';

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
  await assert.rejects(runAgentProcess({ executable: node, args: ['-e', 'process.stdout.write("x".repeat(9*1024*1024))'], stdin: '', timeoutMs: 3000 }), (error: unknown) => error instanceof AgentExecutionError && /safety limit/.test(error.message));
});

test('parses provider output without accepting CLI error objects', () => {
  assert.equal(extractResponse('codex', '  proposal  '), '  proposal  ');
  assert.equal(extractResponse('claude', JSON.stringify({ result: 'a response' })), 'a response');
  const agy = (result: object) => [{ event: 'init' }, { event: 'step_update' }, { event: 'result', result }].map((e) => JSON.stringify(e)).join('\n');
  assert.equal(extractResponse('gemini', agy({ status: 'SUCCESS', response: 'another response\n' })), 'another response');
  assert.throws(() => extractResponse('gemini', agy({ status: 'ERROR', response: '', error: 'not logged in' })), AgentExecutionError);
  assert.throws(() => extractResponse('gemini', JSON.stringify({ event: 'init' })), AgentExecutionError);
  assert.throws(() => extractResponse('claude', 'not json'), AgentExecutionError);
});

test('encodes Antigravity stdin as a single stream-json user message', () => {
  const encoded = encodeAntigravityInput('line one\nline "two"');
  assert.equal(encoded.trimEnd().split('\n').length, 1);
  assert.deepEqual(JSON.parse(encoded), { event: 'user', message: { content: 'line one\nline "two"' } });
});

test('kills descendant processes when a CLI times out (POSIX)', { skip: process.platform === 'win32' }, async () => {
  const { mkdtemp, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'ace-tree-'));
  const sentinel = join(dir, 'unexpected-child-output');
  try {
    const grandchild = 'setTimeout(() => require("node:fs").writeFileSync(' + JSON.stringify(sentinel) + ', "orphan"), 850)';
    const parent = 'require("node:child_process").spawn(process.execPath, ["-e", ' + JSON.stringify(grandchild) + '], {stdio:"ignore"});setInterval(()=>{},1000)';
    await assert.rejects(runAgentProcess({ executable: node, args: ['-e', parent], stdin: '', timeoutMs: 250 }), AgentExecutionError);
    await new Promise((resolve) => setTimeout(resolve, 1050));
    await assert.rejects(readFile(sentinel, 'utf8'), { code: 'ENOENT' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('abort signal stops a subprocess before its timeout', async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 80);
  try {
    await assert.rejects(runAgentProcess({
      executable: node, args: ['-e', 'setInterval(()=>{},1000)'],
      stdin: '', timeoutMs: 2500, signal: controller.signal,
    }), (error: unknown) => error instanceof AgentExecutionError && /cancelled/.test(error.message));
  } finally { clearTimeout(timer); }
});

test('accepts normal long CLI output that exceeded the former 768 KiB limit', async () => {
  const response = await runAgentProcess({
    executable: node, args: ['-e', 'process.stdout.write("a".repeat(1024*1024))'],
    stdin: '', timeoutMs: 5000,
  });
  assert.equal(response.length, 1024*1024);
});

test('verbose stderr progress never kills an otherwise valid response', async () => {
  const response = await runAgentProcess({
    executable: node, args: ['-e', 'process.stderr.write("s".repeat(160*1024)); process.stdout.write("done")'],
    stdin: '', timeoutMs: 5000,
  });
  assert.equal(response, 'done');
});

test('nonpositive process timeouts are rejected before spawning a process', async () => {
  await assert.rejects(runAgentProcess({ executable: node, args: [], stdin: '', timeoutMs: 0 }),
    (error: unknown) => error instanceof AgentExecutionError && /Invalid provider timeout/.test(error.message));
});
