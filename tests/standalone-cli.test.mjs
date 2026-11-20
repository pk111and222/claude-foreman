import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sandbox, write, read, json, output, failed, stopBoard, MESSAGES, ROOT } from './helpers.mjs';

const entry = path.join(ROOT, 'bin/foreman.mjs');
const cli = (h, args, options) => h.start(entry, args, options).done;
const health = async (url) => (await fetch(new URL('health', url))).json();
const seed = (h, id, at = new Date().toISOString()) => write(path.join(h.home, '.claude/projects/demo', `${id}.jsonl`),
  JSON.stringify({ type: 'user', timestamp: at, cwd: h.cwd, message: { content: 'Recorded without a running Claude process' } }) + '\n');

// 只有 Node，连现成的 Foreman 配置都没有；手动运行不触发调度初始化。
test('独立 CLI 无插件配置也能打开全局页；链接和 JSON 模式不弹浏览器', async (t) => {
  const h = sandbox(t, { config: false });
  h.env.FOREMAN_TEST_OPEN = path.join(h.home, 'opened');
  assert.match((await cli(h, ['board', '--help'])).stdout, /foreman board --replay/);
  assert.equal((await cli(h, ['board', '--url', '--json'])).code, 2);
  assert.equal((await cli(h, ['board', '--wat'])).code, 2);
  assert.equal((await cli(h, ['board', '--stop'])).stdout.trim(), MESSAGES.zh.boardNotRunning);
  assert.equal(fs.existsSync(h.runs), false);
  try {
    const live = output(await cli(h, ['board', '--json']));
    assert.equal(live.started, true);
    const page = new URL(live.url);
    assert.equal(page.hostname, '127.0.0.1');
    assert.equal(page.searchParams.get('s'), null, '不继承终端里的 Claude 会话 ID');
    assert.equal((await fetch(page)).status, 200);
    const sessions = async () => (await (await fetch(new URL('sessions', page))).json()).sessions;
    assert.deepEqual(await sessions(), []);
    assert.equal((await cli(h, ['board', '--url'])).stdout, `${live.url}\n`);
    assert.equal(fs.existsSync(h.env.FOREMAN_TEST_OPEN), false);
    assert.equal(fs.existsSync(h.userConfig), false);
    assert.deepEqual(fs.readdirSync(h.runs), ['board.lock.json']);
    assert.equal(h.calls().length, 0);
    const opened = await cli(h, ['board', '--session', 'existing-session']);
    assert.equal(opened.code, 0, opened.stderr);
    assert.equal(read(h.env.FOREMAN_TEST_OPEN), `${live.url}&s=existing-session\n`);
    assert.equal(opened.stdout, read(h.env.FOREMAN_TEST_OPEN));
    const unavailable = await cli(h, ['board'], { env: { FOREMAN_TEST_OPEN: path.join(h.home, 'missing-dir', 'open') } });
    assert.equal(unavailable.code, 0);
    assert.equal(unavailable.stdout.trim(), live.url);
    assert.match(unavailable.stderr, /没能自动打开浏览器/);
    assert.equal((await health(live.url)).ok, true);
  } finally { await stopBoard(h); }
});

test('与插件双向复用直播服务，显式打开不改 web 开关，回放另起进程', async (t) => {
  const h = sandbox(t), lockFile = path.join(h.runs, 'board.lock.json');
  const at = new Date().toISOString(), current = 'recorded-session';
  seed(h, current, at);
  const meta = write(path.join(h.runs, '20261120-111111-abcd', 'meta.json'), {
    id: '20261120-111111-abcd', claude_session: current, group: 'demo', status: 'done', started_at: at, ended_at: at,
  });
  const config = h.config();
  config.dispatch.watch.web = false; h.config(config);
  const before = read(h.userConfig);
  let replayUrl;
  try {
    assert.equal(output(await h.bridge(['board'])).enabled, false);
    const manual = output(await cli(h, ['board', '--json']));
    assert.equal(manual.started, true);
    assert.equal(read(h.userConfig), before);
    const pid = (await health(manual.url)).pid;
    assert.equal(output(await h.bridge(['board'])).enabled, false);
    const snapshot = await (await fetch(new URL(`snapshot?s=${current}`, manual.url))).json();
    assert.ok(snapshot.runs.some((run) => run.id === '20261120-111111-abcd'));
    const replay = output(await cli(h, ['board', '--replay', 'demo', '--speed', '2', '--json']));
    replayUrl = replay.url;
    assert.deepEqual(replay.replay, { target: 'demo', sessions: 1 });
    assert.notEqual((await health(replayUrl)).pid, pid);
    assert.equal(json(lockFile).pid, pid);
    config.dispatch.watch.web = true; h.config(config);
    assert.deepEqual(output(await h.bridge(['board'])), { ...manual, started: false, url: `${manual.url}&s=test-session` });
    assert.deepEqual(output(await cli(h, ['board', '--stop', '--json'])), { stopped: true, pid });
    assert.equal((await health(replayUrl)).ok, true);
    assert.equal(json(meta).status, 'done');

    const [plugin, standalone] = await Promise.all([h.bridge(['board']), cli(h, ['board', '--json'])]).then((results) => results.map((r) => output(r)));
    assert.equal(Number(plugin.started) + Number(standalone.started), 1);
    assert.equal(plugin.url, `${standalone.url}&s=test-session`);
    assert.equal((await health(plugin.url)).pid, json(lockFile).pid);
  } finally {
    if (replayUrl) await fetch(new URL('shutdown', replayUrl), { method: 'POST' }).catch(() => {});
    await stopBoard(h);
  }
});

test('读取同一用户的配置路径、记录目录覆盖变量和旧记录，不写新配置或搬目录', async (t) => {
  const h = sandbox(t, { config: false });
  const workerOptions = { env: { FOREMAN_CONFIG: 'custom.json' } };
  const custom = h.write('custom.json', { dispatch: { runs_dir: 'configured' } });
  const legacy = path.join(h.home, '.claude', 'codex-runs');
  write(path.join(legacy, 'unchanged'), 'legacy');
  for (const [root, options] of [
    [path.join(h.cwd, 'configured'), workerOptions],
    [path.join(h.cwd, 'env-runs'), { env: { ...workerOptions.env, FOREMAN_RUNS_DIR: 'env-runs' } }],
    [legacy, {}],
  ]) {
    try {
      const started = output(await cli(h, ['board', '--json'], options));
      assert.equal(json(path.join(root, 'board.lock.json')).pid, (await health(started.url)).pid);
      assert.equal(fs.existsSync(h.runs), false);
      assert.equal(fs.existsSync(h.userConfig), false);
    } finally { await stopBoard({ runs: root }); }
  }
  assert.equal(read(path.join(legacy, 'unchanged')), 'legacy');
  assert.deepEqual(json(custom), { dispatch: { runs_dir: 'configured' } });
});

// npm test supplies npm_execpath. Direct node --test still runs all source-level tests above.
const npm = process.env.npm_execpath;
test('npm 打包并离线安装后，foreman 命令不依赖源码检出或 Claude 插件安装', { skip: !npm || !fs.existsSync(npm) }, async (t) => {
  const h = sandbox(t, { config: false });
  const cache = path.join(h.home, 'npm-cache'), prefix = path.join(h.home, 'install');
  const npmArgs = ['--cache', cache, '--offline', '--ignore-scripts'];
  const runNpm = (args, cwd) => h.start(npm, [...args, ...npmArgs], { cwd, timeout: 30000 }).done;
  const packed = output(await runNpm(['pack', '--json', '--pack-destination', h.home], ROOT));
  const { filename, files } = packed[0];
  assert.ok(files.some(({ path: name }) => name.endsWith('/board/index.html')));
  assert.ok(!files.some(({ path: name }) => name.startsWith('foreman-en/') || name.endsWith('/scripts/cli.mjs')));
  const installed = await runNpm(['install', '--global', '--prefix', prefix, '--no-audit', '--no-fund', path.join(h.home, filename)], h.cwd);
  assert.equal(installed.code, 0, installed.stderr);
  const env = { ...h.env, PATH: [path.dirname(process.execPath), h.env.PATH].join(path.delimiter), CLAUDE_CODE_SESSION_ID: '' };
  const invoke = (args) => process.platform === 'win32'
    ? h.start(path.join(prefix, 'node_modules', '@pk111and222/foreman-cli/bin/foreman.mjs'), args, { env }).done.then(output)
    : promisify(execFile)(path.join(prefix, 'bin/foreman'), args, { cwd: h.cwd, env, timeout: 20000 }).then(({ stdout }) => JSON.parse(stdout));
  try {
    const live = await invoke(['board', '--json']);
    assert.equal(live.started, true);
    assert.equal((await fetch(live.url)).status, 200);
    assert.equal(fs.existsSync(h.userConfig), false);
    assert.equal((await invoke(['board', '--stop', '--json'])).stopped, true);
  } finally { await stopBoard(h); }
});
