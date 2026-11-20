import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { discussion, report, review } from '../fixtures/reports.mjs';

export async function worker(tool, project) {
  const args = process.argv.slice(2);
  if (args[0] === '--version') { console.log(`${tool} fake-version`); return; }
  const value = (flag) => args[args.indexOf(flag) + 1];
  const dsh = tool === 'dsh', prior = args.includes(dsh ? '--session-id' : '--resume');
  const id = dsh ? 'session-foreman' : 'sess_foreman';
  let prompt = '';
  const executing = dsh && value('--permission-mode') === 'workspace-write';
  const probe = 'Reply with the single word OK.';
  if (dsh) {
    assert.equal(process.cwd(), fs.realpathSync(project));
    assert.equal(args[0], 'headless');
    assert.equal(args.at(-1), '-');
    assert.ok(args.includes('--json'));
    assert.equal(value('--approval-policy'), 'never');
    assert.ok(!args.includes('--add-dir'));
    for await (const text of process.stdin) prompt += text.toString();
    assert.equal(value('--permission-mode'), /DSH uses workspace-write|DSH 使用 workspace-write|files_changed/.test(prompt) ? 'workspace-write' : 'read-only');
  } else {
    assert.notEqual(process.cwd(), fs.realpathSync(project));
    assert.equal(value('--cwd'), process.cwd());
    assert.equal(value('--mode'), 'build');
    assert.equal(value('--workflow-mode'), 'disabled');
    assert.match(value('--disallowed-tools'), /\bBash\b.*\bRead\b.*\bWrite\b/);
    assert.equal(value('--output-format'), 'stream-json');
    const config = JSON.parse(fs.readFileSync('zcode.json'));
    assert.equal(config.features.mcp, false);
    assert.equal(config.hooks.enabled, false);
    assert.equal(config.plugins.enabled, false);
    assert.equal(process.env.ZCODE_STORAGE_DIR, path.join(process.env.HOME, 'storage'));
    assert.throws(() => fs.writeFileSync(path.join(project, 'sandbox-escape.txt'), 'not allowed'), { code: 'EPERM' });
    assert.throws(() => fs.symlinkSync(project, 'project-link') || fs.writeFileSync('project-link/sandbox-escape.txt', 'not allowed'), { code: 'EPERM' });
    fs.rmSync('project-link', { force: true });
    prompt = value('--prompt');
  }
  const emit = (ev) => console.log(JSON.stringify(ev));
  const returned = prompt.includes('switch-session') ? 'wrong-session' : id;
  if (prior) assert.equal(value(dsh ? '--session-id' : '--resume'), id);
  if (prompt.includes('resume-marker') || prompt.includes('repair-only')) assert.ok(prior);
  if (prompt.includes('material-marker')) assert.match(prompt, /\+after\b|1\s+after\b/);
  if (prompt.includes('no-terminal')) { console.log('CLI noise'); return; }
  emit({ type: dsh ? 'session' : 'turn.started', sessionId: returned });
  if (prompt.includes('hang-worker')) {
    // Another process in the same process group ignores SIGTERM. The adapter must escalate.
    const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 30000);"], { stdio: 'inherit' });
    const detached = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 30000);"], { detached: true, stdio: 'ignore' });
    console.error(`worker-child:${child.pid},${detached.pid}`);
    await new Promise(() => setInterval(() => {}, 30000));
    return;
  }
  const fail = prompt.includes('failed-with-zero');
  if (executing && prompt.includes('write-marker')) {
    fs.writeFileSync('marker.txt', 'DSH wrote this\n');
    emit({ type: 'tool_call', callId: 'write-1', tool: 'write', input: { file_path: 'marker.txt' } });
    emit({ type: 'tool_result', callId: 'write-1', status: 'completed', result: 'Created file' });
  }
  const text = prompt === probe ? 'OK'
    : prompt.includes('first-invalid') ? (executing ? JSON.stringify({ ...report, files_changed: null }) : 'Not a structured report')
    : JSON.stringify(executing ? report : prompt.includes('material-marker') ? review : discussion);
  if (dsh) {
    emit({ type: 'tool_call', callId: 'read-1', tool: 'read_file', input: { path: 'source.txt' } });
    emit({ type: 'tool_result', callId: 'read-1', status: 'completed', result: 'file contents' });
    emit({ type: 'status', phase: 'step_end', usage: { inputTokens: 20, outputTokens: 10, cacheReadTokens: 7 } });
    emit({ type: 'text', text });
    emit({ type: 'final', sessionId: returned, reason: { kind: fail ? 'error' : 'completed' }, text });
  } else {
    if (fail) emit({ type: 'turn.failed', sessionId: returned, payload: { message: 'provider error' } });
    // Some builds do not end the last line with a newline.
    process.stdout.write(JSON.stringify({ type: 'result', sessionId: returned, projection: { status: 'idle' }, response: text }));
  }
}
