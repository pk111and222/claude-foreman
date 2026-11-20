// DeepSeek 官方 dsh headless，不通过 dsh-tui 的版本兼容层。
import { headlessAdapter, workspacePrompt } from './headless-cli.mjs';
import { focusFiles, M } from '../util.mjs';

export default headlessAdapter({
  name: 'dsh', label: 'DSH CLI', readsCode: true, isolation: 'tools', sandbox: 'read-only', runAccess: 'workspace-write',
  prompt(ctx, files, schema) {
    if (ctx.kind !== 'exec') return workspacePrompt(ctx, files, schema);
    return `${ctx.brief}${focusFiles(files)}\n\n${M.footer(ctx.cwd, [])}\n\n${M.dshRunFooter(schema)}\n`;
  },
  prepare: ({ command: { file, pre }, cwd, kind }) => (prompt, session) => ({ file, cwd, input: prompt,
    args: [...pre, 'headless', '--json', '--permission-mode', kind === 'exec' ? 'workspace-write' : 'read-only', '--approval-policy', 'never',
      ...(session ? ['--session-id', session] : []), '-'] }),
  translate(ev, out) {
    switch (ev.type) {
      case 'session': out.session(ev.sessionId); break;
      case 'text': out.message(ev.text); break;
      case 'thinking': out.message(ev.text, 'reasoning'); break;
      case 'tool_call': {
        const file = ['write', 'edit', 'str_replace_editor'].includes(ev.tool) && ev.input?.command !== 'view'
          ? ev.input?.file_path ?? ev.input?.path : null;
        out.tool(ev.callId, ev.tool, ev.input, typeof file === 'string' ? file : null);
        break;
      }
      case 'tool_result': {
        // DSH 的 bash 即使退出非零也可能是 completed；实际退出码在输出结尾。
        const code = /\[exit code: (\d+)\]\s*$/.exec(typeof ev.result === 'string' ? ev.result : '');
        out.toolResult(ev.callId, ev.status !== 'completed', ev.result, code ? Number(code[1]) : undefined);
        break;
      }
      case 'status': {
        const u = ev.usage;
        if (ev.phase === 'step_end' && Number.isFinite(u?.inputTokens) && Number.isFinite(u.outputTokens)) {
          out.usage({ input_tokens: u.inputTokens, output_tokens: u.outputTokens, cached_input_tokens: u.cacheReadTokens,
            cache_write_input_tokens: u.cacheWriteTokens, reasoning_output_tokens: u.reasoningTokens });
        }
        break;
      }
      case 'error': out.fail(ev.message || M.headlessProtocol('DSH CLI')); break;
      case 'final':
        if (ev.reason?.kind !== 'completed') out.fail(M.headlessProtocol('DSH CLI', ev.reason?.kind));
        out.complete(ev.sessionId, ev.text);
        break;
    }
  },
});
