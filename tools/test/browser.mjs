// Starts headless Chrome and drives its one page through the DevTools protocol.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findChrome } from '../chrome.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function launch() {
  const profile = mkdtempSync(join(tmpdir(), 'test-'));
  const chrome = spawn(findChrome(), [
    '--headless=new', '--disable-gpu', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: 'ignore' });

  // With port 0, Chrome picks a free port and writes it to this file.
  const portFile = join(profile, 'DevToolsActivePort');
  let page;
  for (let i = 0; i < 200 && !page; i++) {
    await sleep(100);
    if (!existsSync(portFile)) continue;
    const port = readFileSync(portFile, 'utf8').split('\n')[0];
    try {
      page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(target => target.type === 'page');
    } catch {}
  }
  if (!page) throw new Error('Chrome did not start');

  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }));
  let lastId = 0;
  const pending = new Map();
  const listeners = new Set();
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (!message.id) return listeners.forEach(listener => listener(message));
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
  });

  const send = (method, params = {}) => new Promise((resolve, reject) => {
    pending.set(++lastId, { resolve, reject });
    socket.send(JSON.stringify({ id: lastId, method, params }));
  });

  const on = (method, listener) => listeners.add(message => { if (message.method === method) listener(message.params); });

  const next = method => new Promise(resolve => {
    const listener = message => {
      if (message.method !== method) return;
      listeners.delete(listener);
      resolve(message.params);
    };
    listeners.add(listener);
  });

  async function evaluate(expression) {
    const { result, exceptionDetails } = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return result.value;
  }

  async function close() {
    socket.close();
    await new Promise(resolve => {
      chrome.once('exit', resolve);
      chrome.kill();
    });
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    } catch {}
  }

  return { send, on, next, evaluate, close };
}
