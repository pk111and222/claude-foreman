import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { sandbox, baseConfig, ROOT, write, plannedArgs, taskArgs, poll, MESSAGES } from './helpers.mjs';

const fixture = pathToFileURL(path.join(ROOT, 'tests', 'fake', 'headless.mjs')).href;
const setup = (t, name) => {
  const h = sandbox(t), cfg = baseConfig();
  const bin = write(path.join(h.home, `${name}.mjs`), `import { worker } from ${JSON.stringify(fixture)}; await worker(${JSON.stringify(name)}, ${JSON.stringify(h.cwd)});`);
  cfg.agents[name] = { type: `${name} cli`, bin };
  cfg.modules.default.discuss.complex = cfg.modules.default.review.complex = [{ agent: name }];
  cfg.modules.default.review.gap.complex = false;
  h.config(cfg);
  const args = (mode, ...extra) => plannedArgs(h, taskArgs(h, mode, ['--agent', name, ...extra]));
  h.run = (input, ...extra) => h.bridge(args('discuss', ...extra), { input });
  h.configured = cfg;
  h.args = args;
  return h;
};
const json = ({ stdout }) => JSON.parse(stdout);
const ok = (res) => { assert.equal(res.code, 0, res.stderr + res.stdout); return json(res); };
const mac = process.platform === 'darwin';

for (const tool of ['dsh', 'zcode']) {
  const opts = { skip: tool === 'zcode' && !mac };
  test(`${tool}: discuss, explicit resume, and same-session report repair`, opts, async (t) => {
    const h = setup(t, tool);
    const first = ok(await h.run('first-invalid'));
    assert.ok(first.report);
    assert.equal(first.readonly, tool === 'dsh' ? 'tools' : 'os');
    assert.equal(first.usage?.input_tokens ?? null, tool === 'dsh' ? 40 : null);
    const events = h.events(first.run_id);
    assert.ok(events.some(e => e.type === 'thread.started' && e.thread_id === first.session_id));
    assert.ok(events.some(e => e.type === 'item.completed' && e.item.type === 'agent_message'));
    const next = ok(await h.bridge(plannedArgs(h, ['resume', '--run', first.run_id, '--level', 'complex', '--brief', '-']), { input: 'resume-marker' }));
    assert.equal(next.session_id, first.session_id);
    assert.equal(next.parent, first.run_id);
    assert.ok(!fs.existsSync(path.join(h.cwd, 'sandbox-escape.txt')));
  });

  test(`${tool}: review is based on actual diff material and is not resumable`, opts, async (t) => {
    const h = setup(t, tool);
    h.initGit();
    h.write('source.txt', 'after\n');
    const result = ok(await h.bridge(h.args('review', '--uncommitted'), { input: 'material-marker' }));
    assert.ok(result.report);
    assert.equal(result.stale, false);
    assert.equal(result.review_target, 'diff');
    const reply = await h.bridge(['resume', '--run', result.run_id, '--level', 'complex', '--brief', '-']);
    assert.notEqual(reply.code, 0);
  });

  test(`${tool}: exit zero is not enough; failed or missing terminal events and mismatched sessions are errors`, opts, async (t) => {
    const h = setup(t, tool);
    for (const input of ['no-terminal', 'failed-with-zero']) {
      const result = await h.run(input);
      assert.notEqual(result.code, 0);
      assert.equal(json(result).status, 'failed');
    }
    const first = ok(await h.run('first round'));
    const result = await h.bridge(plannedArgs(h, ['resume', '--run', first.run_id, '--level', 'complex', '--brief', '-']), { input: 'switch-session' });
    assert.notEqual(result.code, 0);
    assert.equal(json(result).status, 'failed');
    assert.equal(json(result).session_id, null);
  });

  test(`${tool}: check and models report a CLI-managed default, no invented model catalogue`, opts, async (t) => {
    const h = setup(t, tool);
    const result = ok(await h.bridge(['check', '--agent', tool, '--cwd', h.cwd]));
    assert.equal(result.agents[tool].reply, 'OK');
    assert.equal(result.agents[tool].model, null);
    const catalog = ok(await h.bridge(['models']));
    assert.equal(catalog.tools[`${tool} cli`].cli_managed_model, true);
    assert.deepEqual(catalog.tools[`${tool} cli`].models, []);
  });

  test(`${tool}: cancel cleans up the worker process group, including a child ignoring TERM`, { skip: (!mac && tool === 'zcode') || process.platform === 'win32' }, async (t) => {
    const h = setup(t, tool);
    const task = h.startBridge(h.args('discuss'), { input: 'hang-worker' });
    const { id } = await h.running(m => m.mode === 'discuss' && m.agent === tool && m.session_id);
    const logfile = path.join(h.runs, id, 'stderr.log');
    const ids = await poll(() => /worker-child:(\d+),(\d+)/.exec(fs.readFileSync(logfile, 'utf8'))?.slice(1).map(Number), 'worker spawned both children');
    ok(await h.bridge(['cancel', '--run', id]));
    assert.equal(json(await task.done).status, 'cancelled');
    for (const pid of ids) await poll(() => { try { process.kill(pid, 0); return false; } catch (err) { return err.code === 'ESRCH'; } }, 'worker child exited');
  });
}

test('an unavailable zcode executable is not treated as a model catalogue failure', async (t) => {
  const h = sandbox(t), cfg = baseConfig();
  cfg.agents.zcode = { type: 'zcode cli', bin: path.join(h.home, 'nonexistent-zcode') };
  h.config(cfg);
  const catalog = ok(await h.bridge(['models']));
  assert.equal(catalog.tools['zcode cli'].error_code, 'ENOENT');
  const listing = await h.bridge(['models', '--format', 'md']);
  assert.ok(listing.stdout.includes(MESSAGES.zh.zcodeCliMissing));
  const probe = json(await h.bridge(['check', '--agent', 'zcode']));
  assert.equal(probe.agents.zcode.fix, MESSAGES.zh.zcodeCliMissing);
});

test('DSH rejects model overrides and write access', async (t) => {
  const h = setup(t, 'dsh');
  const override = await h.run('unused', '--model', 'not-the-cli-default');
  assert.notEqual(override.code, 0);
  assert.match(override.stderr, /--model/);
  h.configured.agents.dsh.run_access = 'shell';
  h.config(h.configured);
  const writeAccess = await h.bridge(['config', '--cwd', h.cwd]);
  assert.notEqual(writeAccess.code, 0);
  assert.match(writeAccess.stderr, /run_access/);
});

test('ZCode counts UTF-8 bytes before launching', { skip: !mac }, async (t) => {
  const h = setup(t, 'zcode');
  const result = await h.run('中文'.repeat(18000));
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /96000/);
  assert.equal(h.records().filter(r => r.agent === 'zcode').length, 0);
});

test('ZCode rejects oversized review materials when building the plan', async (t) => {
  const h = setup(t, 'zcode');
  h.initGit();
  h.write('source.txt', '中文'.repeat(15000) + '\n');
  const result = await h.bridge(['plan', '--cwd', h.cwd, '--module', 'review', '--cell', 'complex', '--group', 'huge-diff', '--seat', 'zcode', '--uncommitted']);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /96000/);
});

test('DSH timeouts are recorded as timeout, not a successful blank answer', async (t) => {
  const h = setup(t, 'dsh');
  const result = await h.run('hang-worker', '--timeout', '0.02');
  assert.notEqual(result.code, 0);
  assert.equal(json(result).status, 'timeout');
});

test('hook routes headless invocations through Foreman without blocking local diagnostics', async (t) => {
  const h = sandbox(t);
  for (const command of ['dsh headless --json -', 'dsh --profile headless "task"', 'zcode -p "task"', 'node /opt/zcode.cjs --prompt=hi']) {
    const result = await h.hook('guard-direct-calls.mjs', { tool_input: { command } });
    assert.equal(result.code, 2, command);
  }
  for (const command of ['dsh headless --help', 'dsh --version', 'zcode doctor --json']) {
    const result = await h.hook('guard-direct-calls.mjs', { tool_input: { command } });
    assert.equal(result.code, 0, command);
  }
});
