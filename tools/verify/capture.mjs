// node capture.mjs <url> [--out file.png] [--dpr 2] [--width 800] [--height 900] [--timeout 60]
//
// Opens a page in headless Chrome through the DevTools protocol, waits until document.title is "ready", and
// optionally saves a screenshot. Waiting in real time matters: --virtual-time-budget runs ahead of Web Workers,
// so a plain `chrome --screenshot` catches the tool before its thumbnails exist.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [url, ...args] = process.argv.slice(2);
const option = (name, fallback) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : fallback);
const out = option('out');
const timeout = Number(option('timeout', 60)) * 1000;

function findChrome() {
  const candidates = [
    process.env.CHROME,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
  const found = candidates.find(path => path && existsSync(path));
  if (!found) throw new Error('Chrome not found; set the CHROME environment variable to its path');
  return found;
}

const profile = mkdtempSync(join(tmpdir(), 'capture-'));
const port = 9500 + Math.floor(Math.random() * 400);
const chrome = spawn(findChrome(), [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', `--remote-debugging-port=${port}`,
  `--force-device-scale-factor=${option('dpr', '1')}`, `--window-size=${option('width', '800')},${option('height', '900')}`,
  `--user-data-dir=${profile}`, 'about:blank',
], { stdio: 'ignore' });

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function connect() {
  for (let i = 0; i < 100; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const page = targets.find(t => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(100);
  }
  throw new Error('Chrome did not start');
}

const socket = new WebSocket(await connect());
await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }));
let lastId = 0;
const pending = new Map();
socket.addEventListener('message', event => {
  const message = JSON.parse(event.data);
  if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
    console.error('console error:', message.params.args.map(arg => arg.value ?? arg.description).join(' '));
  }
  pending.get(message.id)?.(message.result);
  pending.delete(message.id);
});
const send = (method, params = {}) => new Promise(resolve => {
  pending.set(++lastId, resolve);
  socket.send(JSON.stringify({ id: lastId, method, params }));
});

let status = 0;
try {
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.navigate', { url });
  const deadline = Date.now() + timeout;
  let title = '';
  while (Date.now() < deadline) {
    title = (await send('Runtime.evaluate', { expression: 'document.title' })).result.value;
    if (title === 'ready' || title.startsWith('error')) break;
    await sleep(100);
  }
  if (title !== 'ready') {
    console.error(`page did not become ready (title: ${title || 'empty'})`);
    status = 1;
  } else if (out) {
    await sleep(300);
    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(out, Buffer.from(data, 'base64'));
  }
} finally {
  socket.close();
  if (chrome.exitCode === null) {
    await new Promise(resolve => {
      chrome.once('exit', resolve);
      chrome.kill();
    });
  }
  // On Windows, antivirus or Chrome's helper processes can lock the profile for seconds after Chrome exits.
  // A leftover temporary folder is harmless, so it shouldn't fail the capture.
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  } catch {}
}
process.exit(status);
