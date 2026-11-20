// 只读 headless worker 共用的进程、材料和事件生命周期。协议、权限和启动方式由各工具适配器决定。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DISCUSS_SCHEMA, REVIEW_SCHEMA } from '../config.mjs';
import { MAX_REVIEW_CHARS, reviewPatchText } from '../review-scope.mjs';
import { announceBoard, cancelSource, isCancelled, newRunDir } from '../records.mjs';
import { eventWriter, finishDiscussion, reportWithRepair, runLimits, spawnCli, startRun, validateSchema } from '../runner.mjs';
import { binCommand, die, filesOutside, focusFiles, killTree, M, pathCommand, readAttachments } from '../util.mjs';
import { D, modelLabel } from '../format.mjs';
import { defaultMaxParallel } from './parallel.mjs';

export function headlessCommand(agent, name) {
  return agent.bin ? binCommand(path.resolve(agent.bin)) : pathCommand(name);
}

export function workspacePrompt(ctx, files, schema) {
  const { cwd, brief, reviewTarget: target, reviewScope: scope } = ctx;
  if (ctx.kind !== 'review') return `${brief}${focusFiles(files)}\n\n${M.opencodeDiscussFooter(cwd, schema)}\n`;
  const opening = { files: M.reviewPromptFiles, claims: M.reviewPromptClaims }[target];
  const parts = [opening ? opening(cwd) : scope ? M.opencodeReviewPrompt(cwd, scope.description) : M.reviewPromptPlain(cwd), brief, focusFiles(files).trim()];
  if (scope?.target === 'diff') {
    const material = reviewPatchText(scope, { budget: MAX_REVIEW_CHARS, readsFiles: true });
    if (material.tooLarge) die((scope.kind === 'commit' ? M.reviewCommitTooLarge : M.reviewTooLarge)(material.chars, MAX_REVIEW_CHARS));
    parts.push(M.reviewMaterial(material.fileList, material.patch, material.fence, material.note));
  }
  return [...parts.filter(Boolean), M.reviewFooter(target), M.reviewSchemaFooter(schema)].join('\n\n');
}

// DSH 的 shell job 会另建进程组。终止前记录组外的后代，升级到 KILL 时用启动时间核对 PID。
function processTable() {
  const r = spawnSync('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,lstart='], { encoding: 'utf8', timeout: 1000 });
  return (r.stdout ?? '').split('\n').flatMap((line) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S.*?)\s*$/.exec(line);
    return m ? [{ pid: Number(m[1]), parent: Number(m[2]), group: Number(m[3]), started: m[4] }] : [];
  });
}

function detachedChildren(pid) {
  const table = processTable(), seen = new Set([pid]), queue = [pid], outside = [];
  for (let i = 0; i < queue.length; i++) for (const child of table) {
    if (child.parent !== queue[i] || seen.has(child.pid)) continue;
    seen.add(child.pid);
    queue.push(child.pid);
    if (child.group !== pid) outside.push(child);
  }
  return outside;
}

function signalPid(pid, signal) {
  try { process.kill(pid, signal); } catch { /* 已退出 */ }
}

// 同一轮只认一个会话和一条终止记录；退出 0 本身不是协议成功。
function invoke(spec, launch, { session, prompt, deadline, stallMin = 0, dir, onSession = () => {}, event = () => {} }) {
  return new Promise((resolve) => {
    const errors = [], questions = [], messages = [], tools = new Map();
    let status, sessionId, terminal = false, last = '', usage = null, commands = 0, activity = Date.now(), stderr = '';
    let killTimer, child, outsideGroup = [], identityError = false;
    const fail = (error) => { if (typeof error === 'string' && error && errors.length < 20) errors.push(error.slice(0, 2000)); };
    const log = (file, text) => { if (dir) fs.appendFileSync(path.join(dir, file), text); };
    const setSession = (id) => {
      if (typeof id !== 'string' || !id || ((session || sessionId) && id !== (session || sessionId))) {
        identityError = true;
        fail(M.headlessSessionMismatch(spec.label));
        return;
      }
      if (!sessionId) { sessionId = id; onSession(id); }
    };
    const stream = {
      session: setSession, fail,
      complete(id, text) {
        if (terminal || typeof text !== 'string') { fail(M.headlessProtocol(spec.label)); return; }
        setSession(id);
        terminal = true;
        last = text;
      },
      message(text, type = 'agent_message') {
        if (typeof text !== 'string' || !text) return;
        if (type === 'agent_message') messages.push(text);
        event({ type: 'item.completed', item: { type, text } });
      },
      usage(sample) {
        if (!sample) return;
        usage ??= {};
        for (const [key, n] of Object.entries(sample)) if (Number.isFinite(n) && n >= 0) usage[key] = (usage[key] ?? 0) + n;
        event({ type: 'step.usage', usage: sample });
      },
      tool(id, name, input) {
        if (typeof id !== 'string' || !id || typeof name !== 'string' || tools.has(id)) return;
        const shell = ['bash', 'shell', 'exec'].includes(name.toLowerCase());
        const category = shell ? 'shell' : /^(read|read_file)$/i.test(name) ? 'read' : /^(grep|glob)$/i.test(name) ? 'search' : 'tool';
        const item = { id, type: 'command_execution', category, tool: name,
          command: (shell && typeof input?.command === 'string' ? input.command : name).slice(0, 1000) };
        if (shell) commands++;
        tools.set(id, item);
        event({ type: 'item.started', item });
      },
      toolResult(id, error, output, code) {
        const item = tools.get(id);
        if (!item) return;
        tools.delete(id);
        event({ type: 'item.completed', item: { ...item, exit_code: error ? 1 : item.category === 'shell' ? code ?? 0 : 0, aggregated_output: typeof output === 'string' ? output.slice(0, 2000) : '' } });
      },
    };
    const force = () => {
      if (!child?.pid || process.platform === 'win32') return;
      signalPid(-child.pid, 'SIGKILL');
      if (!outsideGroup.length) return;
      const current = new Map(processTable().map((proc) => [proc.pid, proc.started]));
      for (const proc of outsideGroup) if (current.get(proc.pid) === proc.started) signalPid(proc.pid, 'SIGKILL');
    };
    const stop = (why) => {
      if (status) return;
      status = why;
      if (child?.pid) {
        if (process.platform !== 'win32') outsideGroup = detachedChildren(child.pid);
        killTree(child.pid);
        for (const proc of outsideGroup) signalPid(proc.pid, 'SIGTERM');
        killTimer = setTimeout(force, 1500);
      }
    };
    if (dir && isCancelled(dir)) return resolve({ status: 'cancelled', errors, questions, messages });
    if (Date.now() >= deadline) return resolve({ status: 'timeout', errors, questions, messages });
    let options;
    try {
      options = launch(prompt, session);
      child = spawnCli(options.file, options.args, { cwd: options.cwd, env: options.env, detached: process.platform !== 'win32',
        windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }, {
        busy: () => tools.size > 0,
        onInput(line, min) { questions.push({ source: 'terminal_prompt', question: line }); fail(M.inputWaitDetected(min, line)); stop('needs_input'); },
      });
    } catch (err) { return resolve({ status: 'failed', errors: [err.message], questions, messages }); }
    const onLine = (line) => {
      let ev;
      try { ev = JSON.parse(line); } catch { return; }
      if (!ev || typeof ev.type !== 'string') return;
      spec.translate(ev, stream);
    };
    let pending = '';
    child.stdout.on('data', (text) => {
      activity = Date.now();
      log(`${spec.name}.jsonl`, text);
      const lines = (pending + text).split('\n');
      pending = lines.pop();
      for (const line of lines) onLine(line);
    });
    child.stderr.on('data', (text) => { log('stderr.log', text); stderr = (stderr + text).slice(-2000); });
    child.stdin.on('error', (err) => { if (err.code !== 'EPIPE') fail(err.message); });
    child.on('error', (err) => fail(err.message));
    child.stdin.end(options.input);
    const timer = setInterval(() => {
      if (dir && isCancelled(dir)) stop('cancelled');
      else if (Date.now() >= deadline) stop('timeout');
      else if (stallMin && !tools.size && Date.now() - activity >= stallMin * 60000) stop('stalled');
    }, 200);
    // Launcher 被信号中断时也要清理独立进程组，而不只在 `foreman cancel` 时清理。
    const onSignal = () => stop('cancelled');
    process.on('SIGTERM', onSignal);
    process.on('SIGINT', onSignal);
    child.on('close', (code, signal) => {
      clearInterval(timer);
      if (killTimer) { clearTimeout(killTimer); force(); }
      process.off('SIGTERM', onSignal);
      process.off('SIGINT', onSignal);
      if (pending) onLine(pending);
      if (dir && isCancelled(dir)) status = 'cancelled';
      if (!status) {
        if (code !== 0 && !errors.length) fail(M.exitCode(code ?? signal, stderr.trim(), spec.label));
        if (code === 0 && !terminal && !errors.length) fail(M.headlessProtocol(spec.label));
        status = code === 0 && terminal && !errors.length ? 'done' : 'failed';
      }
      resolve({ status, errors, questions, messages, commands, usage, sessionId: identityError ? null : sessionId, invalidSession: identityError, last });
    });
  });
}

export function headlessAdapter(spec) {
  const type = `${spec.name} cli`;
  const capabilities = { modes: ['discuss', 'review'], isolation: spec.isolation, reads_code: spec.readsCode, reads_images: false,
    native_schema: false, native_review: false, images: false, resume: true, command_start_events: spec.readsCode };
  const locate = (agent) => headlessCommand(agent, spec.name);
  const versionOf = (agent) => {
    const { file, pre } = locate(agent);
    const r = spawnSync(file, [...pre, '--version'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    return { version: r.status === 0 ? r.stdout.trim() : null,
      error: r.error?.message || (r.status === 0 ? null : r.stderr?.trim() || `exit ${r.status}`),
      ...(r.error?.code ? { error_code: r.error.code } : {}) };
  };
  return {
    type, capabilities, locate, channel: spec.label, defaultMaxParallel: defaultMaxParallel(type), readonlyLevel: () => spec.isolation,
    cliManagedModel: true, efforts: ['default'],
    validate(agent, key, check, text) {
      check(agent.bin == null || text(agent.bin) && path.isAbsolute(agent.bin), `${key}.bin`, M.headlessAbsoluteBin);
      check(agent.model == null, `${key}.model`, M.headlessManagedModel(spec.label));
      check(agent.run_access === undefined, `${key}.run_access`, M.headlessReadOnly(spec.label));
    },
    status: (agent) => ({ bin: agent.bin || spec.name }),
    catalog(agent) {
      const probe = versionOf(agent);
      return { ...probe, ok: !!probe.version, models: [], cli_managed_model: true };
    },
    async check(name, agent, efforts, catalog, modes, cwd) {
      const started = Date.now();
      const out = { ...versionOf(agent), ok: false, type, model: null, model_listed: null, reply: null, fix: null, efforts: [] };
      if (out.version) try {
        const launch = spec.prepare({ command: locate(agent), cwd });
        const result = await invoke(spec, launch, { prompt: 'Reply with the single word OK.', deadline: Date.now() + 120000 });
        out.reply = result.last?.trim().slice(0, 40) || null;
        out.ok = result.status === 'done' && /^OK[.!]?$/i.test(out.reply || '');
        if (!out.ok) out.error = result.errors.join('; ') || (result.status === 'done' ? M.headlessCheckReply(spec.label) : result.status);
      } catch (err) { out.error = err.message; }
      if (!out.ok) out.fix = out.error_code === 'ENOENT' && spec.missingFix ? spec.missingFix : M.headlessCheckFix(spec.label);
      return { ...out, seconds: Number(((Date.now() - started) / 1000).toFixed(1)) };
    },
    validateResume(parent) { if (!parent.meta.session_id) die(M.noSession(parent.id)); },
    async execute(ctx) {
      if (ctx.addDirs?.length) die(M.headlessNoAddDir(spec.label));
      const files = readAttachments(ctx.opts.file, ctx.cwd, !spec.readsCode);
      if (spec.readsCode) {
        const outside = filesOutside(files, [ctx.cwd]);
        if (outside.length) die(M.filesOutsideCwd(ctx.agentName, M.list(outside), false));
      }
      const schemaText = fs.readFileSync(ctx.kind === 'review' ? REVIEW_SCHEMA : DISCUSS_SCHEMA, 'utf8');
      const prompt = spec.prompt(ctx, files, schemaText);
      const launch = spec.prepare({ command: locate(ctx.agent), cwd: ctx.cwd });
      const { id, dir, release } = await newRunDir(ctx);
      const run = startRun({ ...ctx, id, dir, release, prompt, readonly: spec.isolation }, { modelShown: M.headlessDefaultModel, sandbox: spec.sandbox });
      fs.writeFileSync(path.join(dir, 'brief.md'), prompt);
      fs.writeFileSync(path.join(dir, `${spec.name}.jsonl`), '');
      fs.writeFileSync(path.join(dir, 'stderr.log'), '');
      process.stderr.write(`foreman: ${D.started(ctx.mode, modelLabel(run.meta), ctx.level, dir)}\n`);
      announceBoard(ctx.cfg, ctx.mode, modelLabel(run.meta), ctx.level);
      const emit = eventWriter(dir), { deadline, stallMin } = runLimits(ctx, run.started);
      const errors = [], warnings = [], notes = [], observed = { messages: [], questions: [] };
      let last = '', usage = null, commands = 0, next = prompt;
      const report = await reportWithRepair({ schema: JSON.parse(schemaText), validate: validateSchema, allowQuestion: ctx.kind !== 'review',
        onInvalid: () => warnings.push(M.reportInvalid(ctx.agentName, path.join(dir, 'last-message.txt'))),
        repair: (invalid) => { next = M.reportRepairPrompt(invalid.join('\n')); },
        request: async () => {
          const result = await invoke(spec, launch, { prompt: next, session: run.meta.session_id, deadline, stallMin, dir, event: emit,
            onSession(sid) {
              if (run.meta.session_id === sid) return;
              run.meta.session_id = sid;
              run.writeMeta();
              emit({ type: 'thread.started', thread_id: sid });
            },
          });
          if (result.invalidSession) run.meta.session_id = null;
          run.meta.status = result.status;
          errors.push(...result.errors);
          observed.messages.push(...result.messages);
          observed.questions.push(...result.questions);
          if (result.last !== undefined) last = result.last;
          commands += result.commands ?? 0;
          if (result.usage) {
            usage ??= {};
            for (const [key, n] of Object.entries(result.usage)) usage[key] = (usage[key] ?? 0) + n;
          }
          return result.status === 'done' ? { last, canRepair: !!result.sessionId } : null;
        },
      });
      if (run.meta.status === 'cancelled') errors.push(M.runCancelled(spec.label, cancelSource(dir) ?? 'signal'));
      if (run.meta.status === 'stalled') errors.push(M.stalled(stallMin));
      if (!observed.messages.length && last) emit({ type: 'item.completed', item: { type: 'agent_message', text: last } });
      fs.writeFileSync(path.join(dir, 'last-message.txt'), report ? JSON.stringify(report, null, 2) : last);
      return finishDiscussion(run, { usage, commands, errors, notes, warnings, report, last, files, observed, sandbox: spec.sandbox,
        changesNote: M.headlessNoChanges(spec.label) });
    },
  };
}
