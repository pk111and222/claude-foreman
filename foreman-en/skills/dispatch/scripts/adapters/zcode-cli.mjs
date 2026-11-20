// ZCode 首版只审传入材料：不用真实项目做 cwd，不读取桌面运行配置，不在缺少沙箱的平台降级。
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { foremanStateDir } from '../config.mjs';
import { reviewPatchText } from '../review-scope.mjs';
import { die, M } from '../util.mjs';
import { headlessAdapter } from './headless-cli.mjs';

export const ZCODE_PROMPT_BYTES = 96000; // --prompt 需要整个 UTF-8 文本作为一个 argv 元素。
const SANDBOX = '/usr/bin/sandbox-exec';
const PROFILE = '(version 1) (allow default) (deny file-write*) (allow file-write* (subpath (param "FOREMAN_STATE")) (literal "/dev/null"))';
const SETTINGS = { features: { mcp: false, subagent: false, memory: false, skill: false },
  memory: { use: false }, plugins: { enabled: false }, skills: { enabled: false }, hooks: { enabled: false } };
const DISALLOWED = ['Bash Shell Read Write Edit MultiEdit Glob Grep LS NotebookEdit WebFetch WebSearch',
  'Agent Task TaskOutput TaskStop Skill ToolSearch AskUserQuestion EnterPlanMode ExitPlanMode CreateWorkflow',
  'TodoRead TodoWrite ListSessions ReadSession CreateSession ForkSession SendToSession WaitSessions InterruptSession RenameSession ListModels'].join(' ');

export function zcodePrompt(ctx, files, schema) {
  const { brief, reviewTarget: target, reviewScope: scope } = ctx;
  const parts = [ctx.kind === 'review' ? M.apiReviewSystem(schema, target) : M.apiDiscussSystem(schema), brief];
  if (scope?.target === 'diff') {
    const material = reviewPatchText(scope, { budget: ZCODE_PROMPT_BYTES, readsFiles: false });
    parts.push(M.reviewMaterial(material.fileList, material.patch, material.fence, material.note));
  }
  if (files.length) parts.push(M.apiMaterials('', 0, files));
  return parts.filter(Boolean).join('\n\n');
}

function prepare({ command: { file, pre }, cwd }) {
  if (process.platform !== 'darwin' || !fs.existsSync(SANDBOX)) throw new Error(M.zcodeSandboxRequired);
  const project = fs.realpathSync(cwd);
  const base = path.join(foremanStateDir(), 'workers', 'zcode');
  // 不在项目中准备状态目录；先解析已存在的父目录，避免经过符号链接写进项目。
  let ancestor = base;
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  const pathIn = (root, filePath) => {
    const rel = path.relative(root.toLowerCase(), filePath.toLowerCase());
    return rel === '' || !rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel);
  };
  const physicalBase = path.join(fs.realpathSync(ancestor), path.relative(ancestor, base));
  if (pathIn(project, physicalBase)) throw new Error(M.zcodeStateOverlap);
  const key = createHash('sha256').update(JSON.stringify([project, file, pre])).digest('hex').slice(0, 24);
  const root = path.join(physicalBase, key);
  const workspace = path.join(root, 'workspace'), settings = path.join(root, '.zcode', 'cli'), tmp = path.join(root, 'tmp');
  if (pathIn(root, project)) throw new Error(M.zcodeStateOverlap);
  fs.mkdirSync(physicalBase, { recursive: true, mode: 0o700 });
  for (const dir of [root, workspace, path.join(root, '.zcode'), settings, tmp]) {
    try { fs.mkdirSync(dir, { mode: 0o700 }); } catch (err) { if (err.code !== 'EEXIST') throw err; }
    // 检查上一级再建下一级，不沿 worker 写过的符号链接走。
    if (!fs.lstatSync(dir).isDirectory() || fs.realpathSync(dir) !== dir) throw new Error(M.zcodeStateOverlap);
  }
  const env = Object.fromEntries(['PATH', 'LANG', 'LC_ALL', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS',
    'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ZCODE_HTTP_PROXY', 'ZCODE_NO_PROXY', 'ZCODE_PERSONAL_PROVIDER_CONFIG_FILE']
    .filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
  if (env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE && !path.isAbsolute(env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE)) throw new Error(M.zcodeProviderPath);
  const ensure = (name, text) => {
    try { fs.writeFileSync(name, text, { flag: 'wx', mode: 0o600 }); }
    catch (err) {
      if (err.code !== 'EEXIST' || !fs.lstatSync(name).isFile() || fs.readFileSync(name, 'utf8') !== text) throw new Error(M.zcodeStateOverlap);
    }
  };
  ensure(path.join(settings, 'config.json'), JSON.stringify(SETTINGS));
  // 不向上搜索 .env，也不给项目运行配置机会覆盖用户级禁用项。
  ensure(path.join(workspace, '.env'), '');
  ensure(path.join(workspace, 'zcode.json'), JSON.stringify(SETTINGS));
  Object.assign(env, { HOME: root, TMPDIR: tmp, ZCODE_DATA_BASE_DIR: root, ZCODE_STORAGE_DIR: path.join(root, 'storage'),
    ZCODE_SESSION_DB_PATH: path.join(root, 'sessions.sqlite'), ZCODE_LOG_DIR: path.join(root, 'logs'), ZCODE_DISABLE_UPDATE_CHECK: '1', NO_COLOR: '1' });
  return (prompt, session) => {
    const bytes = Buffer.byteLength(prompt);
    if (bytes > ZCODE_PROMPT_BYTES) throw new Error(M.zcodePromptLarge(bytes, ZCODE_PROMPT_BYTES));
    return { file: SANDBOX, cwd: workspace, env, args: ['-D', `FOREMAN_STATE=${root}`, '-p', PROFILE, file, ...pre,
      '--cwd', workspace, '--mode', 'build', '--workflow-mode', 'disabled', '--disallowed-tools', DISALLOWED,
      '--output-format', 'stream-json', '--no-color', ...(session ? ['--resume', session] : []), '--prompt', prompt] };
  };
}

export default headlessAdapter({
  name: 'zcode', label: 'ZCode CLI', readsCode: false, isolation: 'os', sandbox: 'read-only', missingFix: M.zcodeCliMissing,
  prompt(ctx, files, schema) {
    const prompt = zcodePrompt(ctx, files, schema), bytes = Buffer.byteLength(prompt);
    if (bytes > ZCODE_PROMPT_BYTES) die(M.zcodePromptLarge(bytes, ZCODE_PROMPT_BYTES));
    return prompt;
  },
  prepare,
  translate(ev, out) {
    if (ev.type === 'session.created' || ev.type === 'session.resumed' || ev.type === 'turn.started') out.session(ev.sessionId);
    else if (ev.type === 'turn.failed' || ev.type === 'error'
      || ev.type === 'turn.completed' && ['error', 'failed', 'aborted', 'interrupted'].includes(ev.payload?.resultType)) {
      const error = ev.payload?.message || ev.payload?.error?.message || ev.message;
      out.fail(typeof error === 'string' && error || M.headlessProtocol('ZCode CLI'));
    } else if (ev.type === 'result') {
      if (ev.isError || ['error', 'failed', 'aborted', 'cancelled', 'interrupted'].includes(ev.projection?.status)) out.fail(M.headlessProtocol('ZCode CLI', ev.projection?.status));
      out.complete(ev.sessionId, ev.response);
    }
  },
});
