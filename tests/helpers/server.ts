import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

export async function startTestServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devdeck-test-'));
  const reserved = net.createServer();
  await new Promise<void>((resolve) => reserved.listen(0, '127.0.0.1', resolve));
  const port = (reserved.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => reserved.close(() => resolve()));
  const url = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server.ts'], {
    cwd: path.resolve(import.meta.dirname, '../..'), windowsHide: true,
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), DEVDECK_DATA_DIR: dir, DEVDECK_AUTOSTART: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (data) => { output += data; });
  child.stderr.on('data', (data) => { output += data; });
  const stopped = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await stopped;
    // Only the directory created by this fixture can be removed.
    if (path.dirname(dir) !== path.resolve(os.tmpdir()) || !path.basename(dir).startsWith('devdeck-test-')) throw new Error('Unsafe fixture cleanup');
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  };
  try {
    for (let tries = 0; tries < 100; tries++) {
      if (child.exitCode !== null) throw new Error(`Test server exited: ${output}`);
      try {
        const response = await fetch(`${url}/api/setup-state`, { signal: AbortSignal.timeout(500) });
        if (response.ok) return { url, port, dir, child, stop, output: () => output };
      } catch {}
      await delay(100);
    }
    throw new Error(`Test server did not start: ${output}`);
  } catch (error) { await stop(); throw error; }
}
