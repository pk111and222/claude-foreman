#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { M, die, notice } from '../foreman/skills/dispatch/scripts/util.mjs';

async function main([command, ...args]) {
  if (!command || command === '--help' || command === '-h') {
    console.log(M.boardCliUsage);
    return;
  }
  if (command !== 'board') die(`${M.badArg(command)}\n${M.boardCliUsage}`);
  const { values } = parseArgs({ args, options: {
    help: { type: 'boolean', short: 'h' }, url: { type: 'boolean' }, json: { type: 'boolean' }, stop: { type: 'boolean' },
    session: { type: 'string' }, replay: { type: 'string' }, speed: { type: 'string' }, maxgap: { type: 'string' },
  } });
  if (values.help) { console.log(M.boardCliUsage); return; }
  if (values.url && values.json) die(M.badArg('--url --json'));
  if (values.stop) for (const key of ['url', 'session', 'replay', 'speed', 'maxgap']) {
    if (values[key] !== undefined) die(M.badArg(`--stop --${key}`));
  }
  if (values.replay === '') die(M.missingValue('--replay'));
  if (values.session !== undefined && values.replay !== undefined) die(M.badArg('--session --replay'));
  if (values.replay === undefined) for (const key of ['speed', 'maxgap']) {
    if (values[key] !== undefined) die(M.badArg(`--${key}`));
  }

  const { readBoardPaths } = await import('../foreman/skills/dispatch/scripts/config.mjs');
  const { controlBoard } = await import('../foreman/skills/dispatch/scripts/board/control.mjs');
  // 不接收 Claude 的隐式会话 ID：从任何终端都默认打开全局看板。
  const result = await controlBoard(values, readBoardPaths());
  if (values.json) console.log(JSON.stringify(result, null, 2));
  else if (values.stop) console.log(result.stopped ? M.boardStopped : result.message);
  else {
    console.log(result.url);
    if (!values.url) {
      const { openBrowser } = await import('../foreman/skills/dispatch/scripts/board/browser.mjs');
      try { await openBrowser(result.url); }
      catch (error) { notice(M.boardBrowserFailed(error.message)); }
    }
  }
}

try { await main(process.argv.slice(2)); }
catch (error) { die(error.message); }
