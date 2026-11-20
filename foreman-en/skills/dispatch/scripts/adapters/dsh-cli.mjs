// DeepSeek 官方 dsh headless，不通过 dsh-tui 的版本兼容层。
import { headlessAdapter, workspacePrompt } from './headless-cli.mjs';
import { M } from '../util.mjs';

export default headlessAdapter({
  name: 'dsh', label: 'DSH CLI', readsCode: true, isolation: 'tools', sandbox: 'read-only', prompt: workspacePrompt,
  prepare: ({ command: { file, pre }, cwd }) => (prompt, session) => ({ file, cwd, input: prompt,
    args: [...pre, 'headless', '--json', '--permission-mode', 'read-only', '--approval-policy', 'never',
      ...(session ? ['--session-id', session] : []), '-'] }),
  translate(ev, out) {
    switch (ev.type) {
      case 'session': out.session(ev.sessionId); break;
      case 'text': out.message(ev.text); break;
      case 'thinking': out.message(ev.text, 'reasoning'); break;
      case 'tool_call': out.tool(ev.callId, ev.tool, ev.input); break;
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
