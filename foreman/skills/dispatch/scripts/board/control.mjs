// 看板进程的生命周期：插件与独立 CLI 共用，配置和输出由调用方决定。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { M, pidExists, sleep } from '../util.mjs';
import { removeLock } from './lock.mjs';
import { BOARD_PROTOCOL, boardAddressValid, boardUrl } from './protocol.mjs';

const boardDir = path.dirname(fileURLToPath(import.meta.url));
const failWith = (message) => { throw new Error(message); };

export async function controlBoard(o, { runsRoot, configFile, enabled = true, session = null }) {
  if (o.session !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(o.session)) failWith(M.badArg(`--session ${o.session}`));
  if (o.stop && o.replay != null) failWith(M.badArg('--replay'));
  // 关掉的时候不看 dispatch.watch.web：服务可能是开着的时候启动的
  if (!enabled && !o.stop) {
    return { enabled: false, message: M.boardOff };
  }
  if (o.replay != null) {
    const { createInterface } = await import('node:readline');
    const args = [path.join(boardDir, 'server.mjs'), `--replay=${o.replay}`, '--runs', runsRoot, '--config', configFile, '--idle-min', '10'];
    for (const key of ['speed', 'maxgap']) if (o[key] != null) args.push(`--${key}=${o[key]}`);
    let child, reply;
    try {
      fs.mkdirSync(runsRoot, { recursive: true });
      // 工作目录放在记录目录：Windows 上进程的当前目录删不掉，放在插件目录里会卡住插件的卸载和更新
      child = spawn(process.execPath, args, { cwd: runsRoot, detached: true, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      reply = await new Promise((resolve) => {
        const lines = createInterface({ input: child.stdout });
        const finish = (value) => { clearTimeout(timer); lines.close(); child.stdout.destroy(); child.unref(); resolve(value); };
        const timer = setTimeout(() => finish({ error: 'timed out after 120 seconds' }), 120000);
        child.once('error', (error) => finish({ error: error.message }));
        child.once('close', (code) => finish({ error: `exit code ${code}` }));
        lines.once('line', (line) => {
          try { finish(JSON.parse(line)); } catch { finish({ error: 'invalid startup response' }); }
        });
      });
    } catch (error) { child?.kill(); failWith(M.boardStartFailed(error.message)); }
    if (reply.error) {
      child.kill();
      if (reply.code === 'NOT_FOUND') failWith(M.boardReplayNotFound(o.replay));
      if (reply.code === 'REPLAY_TOO_LARGE') failWith(M.boardReplayTooLarge((reply.bytes / 1024 ** 2).toFixed(1), (reply.limit / 1024 ** 2).toFixed(1)));
      failWith(M.boardStartFailed(reply.error));
    }
    try {
      const response = await fetch(new URL('health', reply.url), { redirect: 'error', signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      return { enabled: true, url: reply.url, started: true, replay: { target: o.replay, sessions: data.sessions } };
    } catch (error) { child.kill(); failWith(M.boardStartFailed(error.message)); }
  }
  const lockFile = path.join(runsRoot, 'board.lock.json'), errFile = path.join(runsRoot, 'board.err');
  let reason = 'health check failed';
  // 只采信这次启动的子进程写下的 board.err（按 pid 认），别的尝试留下的不算
  const fail = (fallback, childPid) => {
    let message = fallback;
    try {
      const err = JSON.parse(fs.readFileSync(errFile, 'utf8'));
      if (childPid && err.pid === childPid && err.error) message = err.error;
    } catch { /* 没有这次的服务端错误时用退出原因 */ }
    failWith(M.boardStartFailed(message));
  };
  const reclaim = (raw) => { try { removeLock(lockFile, raw); } catch (error) { fail(error.message); } };
  const liveBoard = async (timeout = 1000) => {
    let raw, lock;
    try { raw = fs.readFileSync(lockFile, 'utf8'); lock = JSON.parse(raw); }
    catch (error) { reason = error.message; return { state: 'absent' }; }
    if (!Number.isInteger(lock?.pid) || lock.pid <= 0 || !pidExists(lock.pid)) return { state: 'absent' };
    try {
      if (boardAddressValid(lock)) {
        const response = await fetch(`http://127.0.0.1:${lock.port}/${lock.token}/health`, { redirect: 'error', signal: AbortSignal.timeout(timeout) });
        const health = await response.json();
        if (response.ok && health?.ok === true && health.pid === lock.pid) {
          if (health.v !== BOARD_PROTOCOL) return { state: 'incompatible', version: health.v };
          return { state: 'ready', lock, raw };
        }
        reason = 'health check failed';
      }
    } catch (error) {
      reason = error.message;
      if (error.cause?.code === 'ECONNREFUSED') return { state: 'absent' };
    }
    return { state: 'wait', lock, raw };
  };
  // 关掉 liveBoard 确认过的服务，等它退出后回收锁。先凭令牌请它自己退出（server.mjs 的 shutdown），
  // 旧版服务没有这个接口、或者请求没成功时才按 pid 结束。成功返回 null；没关掉返回 { reason }：结束进程时的报错，等不到退出时为 null
  const stopServer = async ({ lock: { pid, port, token }, raw }) => {
    let kill = true;
    try { kill = !(await fetch(`http://127.0.0.1:${port}/${token}/shutdown`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000) })).ok; }
    // 连接被拒说明服务已经退出，这个 pid 可能已经给了别的程序，不能再结束它；超时（服务正忙）照旧按 pid 结束
    catch (error) { kill = error.cause?.code !== 'ECONNREFUSED'; }
    if (kill) {
      try { process.kill(pid); } catch (error) { if (error.code !== 'ESRCH') return { reason: error.message }; }
    }
    // POSIX 上旧服务正忙时信号要等同步读取结束才处理，和接管一样最多等 15 秒；
    // Windows 上 kill 是强制结束，旧服务来不及自己删锁，所以只等进程退出，锁由这里回收
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline && pidExists(pid)) await sleep(100);
    if (pidExists(pid)) return { reason: null };
    reclaim(raw);
    return null;
  };
  // 锁里的服务在但一时没回应（同步读大记录时会这样）：最多等 15 秒
  const settle = async () => {
    const deadline = Date.now() + 15000;
    let found = await liveBoard(5000);
    while (found.state === 'wait' && Date.now() < deadline) {
      await sleep(100);
      found = await liveBoard(Math.max(1, Math.min(1000, deadline - Date.now())));
    }
    return found;
  };
  if (o.stop) {
    const found = await settle();
    if (found.state === 'incompatible') failWith(M.boardIncompatible(found.version));
    if (found.state === 'absent') return { stopped: false, message: M.boardNotRunning };
    // 进程在但健康检查对不上：可能是进程号被别的程序复用了，不能结束它
    if (found.state === 'wait') failWith(M.boardStopUnverified(found.lock.pid));
    const failure = await stopServer(found);
    if (failure) failWith(M.boardStopFailed(found.lock.pid, failure.reason));
    return { stopped: true, pid: found.lock.pid };
  }
  let found = await settle();
  if (found.state === 'incompatible') failWith(M.boardIncompatible(found.version));
  // 等了 15 秒还没回应就接管；原来的服务恢复后发现锁不是自己的会自行退出
  if (found.state === 'wait') reclaim(found.raw);
  let lock = found.state === 'ready' ? found.lock : null;
  let started = false;
  if (!lock) {
    let spawnError, exited, child;
    try {
      fs.mkdirSync(runsRoot, { recursive: true });
      fs.rmSync(errFile, { force: true });
      // Windows 上必须脱离调用方控制台，否则后续命令的 Ctrl+C 会把看板一起停掉。工作目录不放在插件目录里（同回放服务）。
      child = spawn(process.execPath, [path.join(boardDir, 'server.mjs'), '--runs', runsRoot, '--config', configFile, '--idle-min', '30'], {
        cwd: runsRoot, detached: true, stdio: 'ignore', windowsHide: true,
      });
      child.once('error', (error) => { spawnError = error; });
      child.once('exit', (code) => { exited = `exit code ${code}`; });
      child.unref();
    } catch (error) { fail(error.message); }
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      found = await liveBoard(Math.max(1, Math.min(1000, deadline - Date.now())));
      if (found.state === 'incompatible') failWith(M.boardIncompatible(found.version));
      lock = found.state === 'ready' ? found.lock : null;
      if (lock) break;
      if (spawnError || exited) fail(spawnError?.message || exited, child.pid);
      await sleep(Math.max(0, Math.min(100, deadline - Date.now())));
    }
    if (!lock) fail(reason, child.pid);
    started = lock.pid === child.pid;
  }
  return { enabled: true, url: boardUrl(lock, o.session ?? session), started };
}
