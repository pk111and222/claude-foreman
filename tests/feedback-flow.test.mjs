import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { sandbox, hostArgs, output, failed, taskArgs, poll, write, read, MESSAGES } from './helpers.mjs';

const M = MESSAGES.zh;
const cancel = (h, id) => h.bridge(['cancel', '--run', id]).then(output);
const current = (h, id) => h.bridge(['await-health', '--check', '--run', id]).then(output).then(({ runs }) => runs[0]);

test('人工反馈打断受影响的执行，保留已有改动，并向同一会话发增量返工说明', async (t) => {
  const h = sandbox(t);
  h.initGit();
  const gate = path.join(h.home, 'old-gate');
  const s = h.scenario({ calls: [
    { session_id: 'feedback-session', steps: [{ files: { 'source.txt': 'usable work\n' } }, { wait_for: gate }] },
    { session_id: 'feedback-session', files: { 'source.txt': 'usable work\nfixed behavior\n' } },
  ] });
  const handle = h.startBridge(taskArgs(h, 'run', ['--group', 'manual-fix', '--scope', 'source.txt']), { env: s.env });
  const old = await h.running((meta) => meta.session_id === 'feedback-session');
  const source = path.join(h.cwd, 'source.txt');
  await poll(() => read(source) === 'usable work\n', '旧轮次已写下可保留的改动');
  const resume = ['resume', '--run', old.id, '--reason', 'rework', '--level', 'complex', '--brief', '-'];
  failed(await h.bridge(resume), M.resumeParentRunning(old.id));
  assert.equal(s.calls().length, 1);

  assert.equal((await cancel(h, old.id)).status, 'cancelled');
  assert.equal(output(await handle.done, 1).status, 'cancelled');
  assert.equal(read(source), 'usable work\n');
  const input = 'Keep the working implementation; correct the in-scope behavior exposed by manual testing.';
  const fixed = output(await h.bridge(resume, { env: s.env, input }));
  const meta = h.records().find((run) => run.id === fixed.run_id);
  assert.equal(fixed.status, 'done');
  assert.equal(meta.parent, old.id);
  assert.equal(meta.resume_reason, 'rework');
  assert.equal(meta.group, 'manual-fix');
  assert.deepEqual(meta.scope, ['source.txt']);
  assert.deepEqual(s.calls().at(-1).args.slice(-2), ['feedback-session', '-']);
  assert.ok(s.calls().at(-1).stdin.includes(input));
  assert.equal(read(source), 'usable work\nfixed behavior\n');
});

test('旧候选的审查可以单独取消，独立审查照常完成且不重复启动', async (t) => {
  const h = sandbox(t);
  const base = h.initGit();
  const frozen = path.join(h.home, 'separate-review');
  h.git(['worktree', 'add', '--quiet', '--detach', frozen, base]);
  h.write('source.txt', 'obsolete candidate\n');
  write(path.join(frozen, 'source.txt'), 'independent candidate\n');
  const start = async (group, cwd) => {
    const plan = output(await h.bridge(['plan', '--cwd', cwd, '--module', 'review', '--cell', 'normal', '--group', group, '--target', 'diff', '--seat', 'codex']));
    output(await h.bridge(hostArgs(h, plan)));
    const gate = path.join(h.home, `${group}-gate`), s = h.scenario({ steps: [{ wait_for: gate }] }, group);
    const handle = h.startBridge(['review', '--plan', plan.plan_id, '--seat', '1', '--brief', '-'], { env: s.env });
    const started = await poll(async () => {
      if (handle.child.exitCode !== null) assert.fail((await handle.done).stderr || 'review exited before the test opened its gate');
      return s.calls().length === 1 && h.records().find((m) => m.group === group && m.status === 'running');
    }, `${group} 审查已经启动`);
    return { handle, id: started.id, gate, s };
  };
  const old = await start('obsolete-review', h.cwd);
  const independent = await start('independent-review', frozen);
  assert.equal((await cancel(h, old.id)).status, 'cancelled');
  assert.equal(output(await old.handle.done, 1).status, 'cancelled');
  assert.equal((await current(h, old.id)).state, 'failed');
  assert.equal((await current(h, independent.id)).state, 'running');

  write(independent.gate, 'go');
  assert.equal(output(await independent.handle.done).stale, false);
  assert.equal((await current(h, independent.id)).state, 'ok');
  assert.deepEqual(await cancel(h, independent.id), { run_id: independent.id, ok: false, status: 'done', note: M.cancelAlreadyEnded });
  assert.equal(old.s.calls().length, 1);
  assert.equal(independent.s.calls().length, 1);
});
