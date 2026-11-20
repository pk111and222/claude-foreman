import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { sandbox, output, failed, seedRun, write, poll, taskArgs, MESSAGES } from './helpers.mjs';

const health = (h, ...args) => h.bridge(['await-health', '--check', ...args]);

test('健康检查区分中断、缺报告和运行中，忽略旧尝试及其他会话', async (t) => {
  const h = sandbox(t), group = 'health';
  seedRun(h, 'old', { group, status: 'failed' });
  seedRun(h, 'retry', { group, parent: 'old' }, { status: 'done', report: { status: 'completed' } });
  seedRun(h, 'dead', { group, status: 'running', pid: 2147483647 });
  seedRun(h, 'no-report', { group }, { status: 'done' });
  seedRun(h, 'blocked', { group, status: 'needs_input' });
  seedRun(h, 'partial', { group }, { status: 'done', report: { status: 'partial' } });
  seedRun(h, 'stale', { group, module: 'review' }, { status: 'done', report: { verdict: 'no_issues' }, stale: true });
  seedRun(h, 'host', { group, participant: 'host' });
  seedRun(h, 'unrelated', { group, claude_session: 'other' });
  const active = seedRun(h, 'busy', { group, status: 'running', pid: process.pid }, null,
    [{ type: 'item.started', item: { id: 'build', type: 'command_execution', command: 'npm test' } }]);
  const old = new Date(Date.now() - 4 * 60_000);
  fs.utimesSync(path.join(active, 'events.jsonl'), old, old);
  const result = output(await health(h, '--group', group));
  assert.equal(result.done, false);
  assert.deepEqual(Object.fromEntries(result.runs.map((r) => [r.run_id, [r.status, r.state]])), {
    blocked: ['needs_input', 'blocked'], busy: ['running', 'running'], dead: ['interrupted', 'failed'],
    'no-report': ['done', 'no_valid_result'], partial: ['done', 'partial'], retry: ['done', 'ok'], stale: ['done', 'stale'],
  });
  assert.equal(result.runs.find((r) => r.run_id === 'busy').activity.command_running, true);
  assert.ok(result.runs.find((r) => r.run_id === 'busy').activity.idle_min >= 4);
  assert.equal(fs.existsSync(path.join(active, 'cancel')), false);
  assert.equal(output(await health(h, '--run', 'dead')).done, true);
});

test('健康检查不把同名其他会话、排队或空组算成完成', async (t) => {
  const h = sandbox(t), group = 'health';
  seedRun(h, 'unrelated', { group, claude_session: 'other' });
  assert.deepEqual(output(await health(h, '--group', group)), { done: false, runs: [], queued: [] });
  const at = new Date(Math.ceil(performance.timeOrigin)).toISOString();
  write(path.join(h.runs, '.state/queue/codex/1.json'), {
    sequence: 1, pid: process.pid, pid_started_at: at, queued_at: at, group, title: 'waiting', agent: 'codex', claude_session: 'test-session',
  });
  seedRun(h, 'available', { group }, { status: 'done', report: { status: 'completed' } });
  const result = output(await health(h, '--group', group));
  assert.equal(result.done, false);
  assert.equal(result.runs[0].state, 'ok');
  assert.deepEqual(result.queued, [{ agent: 'codex', title: 'waiting', position: 1, queued_at: at }]);
});

test('同组复杂工作包可并行开工，一个退出后仍能检查另一个', async (t) => {
  const h = sandbox(t), group = 'complex-batch';
  const packages = ['implementation', 'tests'].map((title) => {
    const gate = path.join(h.home, `${title}.gate`);
    const scenario = h.scenario({ steps: [{ wait_for: gate }] }, title);
    const run = h.startBridge(taskArgs(h, 'run', ['--group', group, '--scope', title, '--title', title, '--no-snapshot']), { env: scenario.env });
    return { title, gate, run };
  });
  await Promise.all(packages.map(({ title }) => h.running((m) => m.title === title)));
  assert.deepEqual(output(await health(h, '--group', group)).runs.map(({ state }) => state), ['running', 'running']);
  write(packages[0].gate, 'go');
  output(await packages[0].run.done);
  const check = output(await health(h, '--group', group));
  assert.equal(check.done, false);
  assert.deepEqual(Object.fromEntries(check.runs.map(({ title, state }) => [title, state])), { implementation: 'ok', tests: 'running' });
  write(packages[1].gate, 'go');
  output(await packages[1].run.done);
  assert.equal(output(await health(h, '--group', group)).done, true);
});

test('健康检查默认等三分钟，再读取该时刻的结果', async (t) => {
  const h = sandbox(t);
  const marker = h.write('timer-marker', '');
  const preload = h.write('clock.mjs', `import fs from 'node:fs';
const timer = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...args) => {
  if (ms !== 180_000) return timer(fn, ms, ...args);
  fs.writeFileSync(${JSON.stringify(marker)}, String(ms));
  const gate = setInterval(() => {
    if (fs.existsSync(${JSON.stringify(`${marker}.release`)})) { clearInterval(gate); fn(...args); }
  }, 10);
};`);
  const handle = h.startBridge(['await-health', '--run', 'late'], { env: { NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` } });
  await poll(() => fs.readFileSync(marker, 'utf8') === '180000', '三分钟计时器');
  assert.equal(handle.stdout, '');
  seedRun(h, 'late', {}, { status: 'done', report: { status: 'completed' } });
  write(`${marker}.release`, 'go');
  assert.equal(output(await handle.done).runs[0].state, 'ok');
  failed(await health(h, '--run', 'late', '--group', 'other'), MESSAGES.zh.awaitHealthTarget);
});
