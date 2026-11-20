import { spawn } from 'node:child_process';
import fs from 'node:fs';

export async function openBrowser(url, { waitForExit = true } = {}) {
  // 只给测试用：记录地址，避免真的打开浏览器。
  if (process.env.FOREMAN_TEST_OPEN !== undefined) {
    fs.appendFileSync(process.env.FOREMAN_TEST_OPEN, `${url}\n`);
    return;
  }
  const [command, args] = process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  // 不经 shell，URL 原样传给系统。捕捉立即失败，但不要等浏览器窗口关闭。
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
    const timer = waitForExit ? setTimeout(resolve, 1500) : null;
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    if (!waitForExit) child.once('spawn', resolve);
    else child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${command}: ${signal || `exit code ${code}`}`));
    });
    child.unref();
  });
}
