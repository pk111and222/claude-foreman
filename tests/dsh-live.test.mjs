import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { BRIDGE, write } from './helpers.mjs';
import { discussion, report } from './fixtures/reports.mjs';

// Optional: drives the installed DSH CLI against a loopback provider, without real credentials.
const exec = promisify(execFile);
const marker = 'Foreman DSH smoke test\n';
const shellQuote = (s) => `'${s.replaceAll("'", "'\\''")}'`;
const writeCall = (file_path, extra) => ({ name: 'write', input: { file_path, content: marker, ...extra } });
const bashCall = (file, extra) => ({ name: 'bash', input: { description: 'Write a test marker', command: `printf %s ${shellQuote(marker)} > ${shellQuote(file)}`, ...extra } });

function sendMessage(res, body, id, call, text) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const event = (type, fields) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
  event('message_start', { message: { id: `msg_${id}`, type: 'message', role: 'assistant', content: [], model: body.model,
    stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } });
  event('content_block_start', { index: 0, content_block: call ? { type: 'tool_use', id: `toolu_${id}`, name: call.name, input: {} } : { type: 'text', text: '' } });
  const delta = call ? { type: 'input_json_delta', partial_json: JSON.stringify(call.input) } : { type: 'text_delta', text };
  event('content_block_delta', { index: 0, delta });
  event('content_block_stop', { index: 0 });
  event('message_delta', { delta: { stop_reason: call ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 10 } });
  event('message_stop', {});
  res.end();
}

const enabled = process.env.FOREMAN_TEST_REAL_DSH === '1' && process.platform === 'darwin';
test('official DSH: Foreman hands-on and read-only modes enforce write boundaries', { skip: !enabled, timeout: 90000 }, async () => {
  // macOS permits writing select temp directories in workspace-write; probe outside them.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.homedir(), '.foreman-dsh-test-')));
  const cwd = path.join(root, 'project'), outside = path.join(root, 'outside');
  for (const dir of [cwd, outside]) fs.mkdirSync(dir);
  fs.symlinkSync(outside, path.join(cwd, 'outside-link'));
  const config = write(path.join(root, 'foreman.json'), {
    agents: { dsh: { type: 'dsh cli', run_access: 'workspace-write' } },
    dispatch: { watch: { terminal: false, web: false }, timeout_min: 0.75 },
    modules: { default: { run: { simple: [{ agent: 'dsh' }] }, discuss: { simple: [{ agent: 'dsh' }] } } },
  });
  let calls = [], final = '', next = 0, requests = 0;
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET') return res.end(JSON.stringify({ object: 'list', data: [{ id: 'deepseek-flash', object: 'model' }] }));
    let data = '';
    for await (const chunk of req) data += chunk;
    const body = JSON.parse(data);
    const names = (body.tools || []).map((t) => t.name);
    const workingTurn = names.includes('write') && names.includes('bash');
    sendMessage(res, body, ++requests, workingTurn ? calls[next++] : null, workingTurn ? final : 'OK');
  });
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const env = { PATH: process.env.PATH, HOME: root, LANG: 'en_US.UTF-8', DSH_HOME: path.join(root, 'dsh'),
      FOREMAN_CONFIG: config, FOREMAN_RUNS_DIR: path.join(root, 'runs'),
      DEEPSEEK_BASE_URL: `http://127.0.0.1:${server.address().port}`, DEEPSEEK_API_KEY: 'local-test-only' };
    const foreman = async (...args) => JSON.parse((await exec(process.execPath, [BRIDGE, ...args], { env, cwd, timeout: 60000 })).stdout);
    await exec('git', ['init', '-q'], { env, cwd });
    for (const [mode, schema] of [['run', report], ['discuss', discussion]]) {
      const writable = mode === 'run';
      const files = [`${mode}-write.txt`, `${mode}-bash.txt`, path.join(outside, `${mode}-write.txt`), path.join(outside, `${mode}-bash.txt`),
        `outside-link/${mode}-symlink-write.txt`, `outside-link/${mode}-symlink-bash.txt`,
        path.join(outside, `${mode}-escalated-write.txt`), path.join(outside, `${mode}-escalated-bash.txt`)];
      const wider = { sandbox_permissions: 'danger-full-access', justification: 'Test that approvals are never granted' };
      calls = [writeCall(files[0]), bashCall(files[1]), writeCall(files[2]), bashCall(files[3]), writeCall(files[4]), bashCall(files[5]),
        writeCall(files[6], wider), bashCall(files[7], wider)];
      final = JSON.stringify(schema);
      next = 0;
      const plan = await foreman('plan', '--cwd', cwd, '--module', mode, '--cell', 'simple', '--group', `dsh-smoke-${mode}`, '--seat', 'dsh');
      if (plan.host) await foreman('submit', '--plan', plan.plan_id, '--report', write(path.join(root, 'host.json'), discussion));
      const brief = write(path.join(root, 'brief.txt'), 'Follow the scripted tool calls for the Foreman sandbox test.');
      const result = await foreman(mode, '--plan', plan.plan_id, '--seat', '1', '--brief', brief,
        ...(writable ? ['--scope', files[0], '--scope', files[1]] : []));
      assert.equal(result.status, 'done');
      assert.equal(result.sandbox, writable ? 'workspace-write' : 'read-only');
      assert.ok(next > calls.length);
      const raw = fs.readFileSync(path.join(result.run_dir, 'dsh.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
      const results = raw.filter((e) => e.type === 'tool_result');
      assert.equal(results.length, calls.length);
      for (const index of writable ? [2, 4] : [0, 2, 4]) assert.equal(results[index].error?.code, 'FS_SANDBOX_DENIED');
      for (const index of writable ? [3, 5] : [1, 3, 5]) assert.match(results[index].result, /file access denied/);
      for (const result of results.slice(-2)) assert.match(result.error?.code || result.result, /SANDBOX_ESCALATION_(?:REJECTED|UNAVAILABLE)|(?:rejected escalating|approval.*unavailable)/i);
      if (writable) {
        for (const file of files.slice(0, 2)) {
          assert.equal(fs.readFileSync(path.join(cwd, file), 'utf8'), marker);
          assert.ok(result.changes.files.some((f) => f.path === file));
        }
      }
      for (const file of files.slice(writable ? 2 : 0)) assert.ok(!fs.existsSync(path.resolve(cwd, file)), `unexpected write: ${file}`);
    }
  } finally {
    server.closeAllConnections?.();
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
