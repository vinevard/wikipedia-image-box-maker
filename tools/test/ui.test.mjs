// node --test tools/test/ui.test.mjs
//
// Drives the tool in headless Chrome with real clicks, taps, typing and drops. Needs Node 22+ and Chrome.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { launch } from './browser.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg' };
const DESKTOP = { width: 1106, height: 900, mobile: false };
const PHONE = { width: 390, height: 844, mobile: true };
const SETTINGS_KEY = 'wikipedia-image-box-maker-settings';

const server = createServer((request, response) => {
  const path = normalize(decodeURIComponent(new URL(request.url, 'http://x').pathname)).replace(/^[/\\]+/, '');
  try {
    const body = readFileSync(join(ROOT, path || 'index.html'));
    response.writeHead(200, { 'Content-Type': TYPES[extname(path || '.html')] ?? 'application/octet-stream' });
    response.end(body);
  } catch {
    response.writeHead(404).end();
  }
});
let base;
let browser;
let send;
let evaluate;
const errors = [];
let fileChoosers = 0;

before(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await launch();
  ({ send, evaluate } = browser);
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.setInterceptFileChooserDialog', { enabled: true });
  browser.on('Runtime.exceptionThrown', ({ exceptionDetails }) => errors.push(exceptionDetails.exception?.description));
  browser.on('Page.fileChooserOpened', () => fileChoosers++);
});

after(async () => {
  await browser?.close();
  server.close();
});

async function open(screen = DESKTOP, { keepStorage = false, pixelRatio = 1 } = {}) {
  const { width, height, mobile } = screen;
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: pixelRatio, mobile });
  await send('Emulation.setTouchEmulationEnabled', { enabled: mobile, maxTouchPoints: mobile ? 5 : 1 });
  await send('Emulation.setEmulatedMedia', {
    features: mobile ? [{ name: 'hover', value: 'none' }, { name: 'pointer', value: 'coarse' }] : [],
  });
  if (!keepStorage) await send('Storage.clearDataForOrigin', { origin: base, storageTypes: 'local_storage' });
  const loaded = browser.next('Page.loadEventFired');
  await send('Page.navigate', { url: base + '/index.html' });
  await loaded;
}

async function center(selector) {
  return JSON.parse(await evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    element.scrollIntoView({ block: 'center' });
    const r = element.getBoundingClientRect();
    return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
  })()`));
}

async function click(selector) {
  const { x, y } = await center(selector);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
  }
}

async function tap(selector) {
  const { x, y } = await center(selector);
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

async function type(selector, text) {
  await evaluate(`(element => { element.focus(); element.select(); })(document.querySelector(${JSON.stringify(selector)}))`);
  await send('Input.insertText', { text });
}

// A gradient image of the given size, loaded the way a chosen file is.
async function loadImage(width, height) {
  await evaluate(`(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = ${width};
    canvas.height = ${height};
    const ctx = canvas.getContext('2d');
    const gradient = ctx.createLinearGradient(0, 0, ${width}, ${height});
    gradient.addColorStop(0, '#4a8');
    gradient.addColorStop(1, '#a48');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, ${width}, ${height});
    const blob = await new Promise(resolve => canvas.toBlob(resolve));
    await loadFile(new File([blob], 'test.png', { type: 'image/png' }));
    await currentThumbnails();
  })()`);
}

async function setWidth(width) {
  await evaluate(`(async () => {
    ui.width.value = ui.widthRange.value = '${width}';
    render();
    await currentThumbnails();
  })()`);
}

const exportImage = scale => evaluate(`(async () => (await toCanvas(${scale})).toDataURL())()`);
const stored = async () => JSON.parse(await evaluate(`localStorage.getItem('${SETTINGS_KEY}')`));

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(expression, timeout = 10000) {
  for (const end = Date.now() + timeout; Date.now() < end;) {
    if (await evaluate(expression)) return;
    await wait(100);
  }
  assert.fail(`timed out waiting for ${expression}`);
}

test('with no image, the buttons are off and the status says why', async () => {
  await open();
  assert.equal(await evaluate('ui.download.disabled && ui.copy.disabled'), true);
  assert.equal(await evaluate('ui.status.textContent'), 'Choose an image first.');
  await loadImage(800, 600);
  assert.equal(await evaluate('ui.download.disabled'), false);
  assert.equal(await evaluate('ui.status.textContent'), '');
});

test('the empty preview opens the file chooser on desktops and phones', async () => {
  await open();
  assert.equal(await evaluate(`document.querySelector('.placeholder').textContent`),
    'Choose an image, drop one here, or paste with Ctrl+V');
  fileChoosers = 0;
  await click('.placeholder');
  await wait(300);
  assert.equal(fileChoosers, 1);

  await open(PHONE);
  assert.equal(await evaluate(`document.querySelector('.placeholder').textContent`), 'Tap to choose an image');
  fileChoosers = 0;
  await tap('.placeholder');
  await wait(300);
  assert.equal(fileChoosers, 1);

  await loadImage(800, 600);
  fileChoosers = 0;
  await tap('.thumb-image');
  await wait(300);
  assert.equal(fileChoosers, 0);
});

test('the picker names the paste keys of the computer', async () => {
  await open();
  assert.match(await evaluate('ui.drop.textContent'), /paste with Ctrl\+V/);
  const { userAgent } = await send('Browser.getVersion');
  await send('Emulation.setUserAgentOverride', { userAgent, platform: 'MacIntel', userAgentMetadata: {
    platform: 'macOS', platformVersion: '15.0.0', architecture: 'arm', model: '', mobile: false } });
  try {
    await open();
    assert.match(await evaluate('ui.drop.textContent'), /paste with ⌘V/);
    assert.match(await evaluate(`document.querySelector('.placeholder').textContent`), /paste with ⌘V/);
  } finally {
    await send('Emulation.setUserAgentOverride', { userAgent, platform: '' });
  }
});

test('a file that is not an image, or cannot be read, gets a message', async () => {
  await open();
  for (const type of ['text/plain', '']) {
    await evaluate(`loadFile(new File(['x'], 'notes', { type: '${type}' }))`);
    assert.match(await evaluate('ui.status.textContent'), /^That file is not an image\./);
  }
  await evaluate(`loadFile(new File(['not really'], 'photo.heic', { type: 'image/heic' }))`);
  await until(`ui.status.textContent.startsWith('Could not read that image.')`);
  assert.equal(await evaluate('source'), null);
});

test('a contrast theme does not change the download', async () => {
  await open();
  await loadImage(800, 600);
  await evaluate(`paddingInputs.forEach(input => { input.value = '10'; })`);
  const normal = await exportImage(2);
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'forced-colors', value: 'active' }] });
  try {
    assert.equal(await evaluate(`matchMedia('(forced-colors: active)').matches`), true);
    assert.equal(await exportImage(2), normal);
  } finally {
    await send('Emulation.setEmulatedMedia', { features: [] });
  }
});

test('file names keep letters of any script and end at a word', async () => {
  await open();
  const names = await evaluate(`[
    'An old-fashioned water well in [[Utajärvi]], Finland',
    'באר מים מסורתית',
    'Bad: chars / * ? < > | here',
    'An old-fashioned water well in the countryside of Utajärvi, Finland',
    '🙂',
  ].map(caption => { ui.caption.value = caption; render(); return fileName(); })`);
  assert.deepEqual(names, [
    'an-old-fashioned-water-well-in-utajärvi-finland.png',
    'באר-מים-מסורתית.png',
    'bad-chars-here.png',
    'an-old-fashioned-water-well-in-the-countryside-of-utajärvi.png',
    'wikipedia-image.png',
  ]);
});

test('a typed white space value turns off random white space and stays', async () => {
  await open();
  await loadImage(800, 600);
  assert.equal(await evaluate('ui.autoRandomize.checked'), true);
  await type('#padTop', '25');
  assert.equal(await evaluate('ui.autoRandomize.checked'), false);
  await loadImage(400, 300);
  assert.equal(await evaluate('paddingInputs[0].value'), '25');
});

test('only changed settings are saved, and Reset settings keeps the caption', async () => {
  await open();
  await type('#caption', 'My [[caption]]');
  await click('input[name=theme][value=night]');
  const saved = await stored();
  assert.equal(saved.version, 2);
  assert.equal(saved.caption, 'My [[caption]]');
  assert.equal(saved.theme, 'night');
  for (const name of ['site', 'width', 'textSize', 'direction', 'showIcon', 'scale']) assert.equal(name in saved, false, name);

  await click('#resetSettings');
  assert.equal(await evaluate('ui.theme.value'), 'day');
  assert.equal(await evaluate('ui.caption.value'), 'My [[caption]]');
  assert.deepEqual(await stored(), { version: 2, caption: 'My [[caption]]' });
});

test('settings saved by version 1 load, except Text smoothing', async () => {
  await open();
  await evaluate(`localStorage.setItem('${SETTINGS_KEY}', JSON.stringify({ caption: 'Old', theme: 'night', width: '300',
    direction: 'rtl', smoothing: 'grayscale', autoRandomize: true }))`);
  await open(DESKTOP, { keepStorage: true });
  assert.equal(await evaluate('ui.caption.value'), 'Old');
  assert.equal(await evaluate('ui.theme.value'), 'night');
  assert.equal(await evaluate('ui.width.value'), '300');
  assert.equal(await evaluate('ui.smoothing.value === defaultOf(ui.smoothing)'), true);
  // A saved right-to-left choice keeps More options open, so it is not hidden.
  assert.equal(await evaluate(`ui.direction.value + ' ' + ui.direction.closest('details').open`), 'rtl true');
});

test('Text smoothing is offered only where the export can make sub-pixel text', async () => {
  await open();
  const supported = await evaluate('subpixelTextSupported()');
  assert.equal(await evaluate(`ui.smoothing.closest('.field').hidden`), !supported);
  assert.equal(await evaluate('defaultOf(ui.smoothing)'), supported ? 'subpixel' : 'grayscale');
});

test('the width reset link shows only away from 250px', async () => {
  await open();
  const hidden = () => evaluate(`ui.widthReset.style.visibility === 'hidden'`);
  assert.equal(await hidden(), true);
  await type('#width', '400');
  await evaluate('ui.width.blur()');
  assert.equal(await hidden(), false);
  await click('#widthReset');
  assert.equal(await evaluate('ui.width.value + ui.widthRange.value'), '250250');
  assert.equal(await hidden(), true);
  assert.equal(await evaluate('document.activeElement === ui.widthRange'), true);
});

test('on a phone, a wide box fits the screen and a tap shows it at full size', async () => {
  await open(PHONE);
  await loadImage(1600, 1200);
  await setWidth(600);
  const zoom = () => evaluate('Number(ui.shot.style.zoom || 1)');
  assert.ok(await zoom() < 1);
  assert.match(await evaluate('ui.previewScale.textContent'), /Tap the preview to see it at full size/);
  const fitted = await exportImage(2);

  await tap('#shot');
  assert.equal(await zoom(), 1);
  assert.match(await evaluate('ui.previewScale.textContent'), /^Shown at full size/);
  assert.equal(await exportImage(2), fitted);
  // Only the box scrolls sideways. The buttons stay where they are.
  const buttonLeft = 'Math.round(ui.download.getBoundingClientRect().left)';
  const before = await evaluate(buttonLeft);
  await evaluate('ui.shot.parentElement.scrollLeft = 200');
  assert.ok(await evaluate('ui.shot.parentElement.scrollLeft') > 0);
  assert.equal(await evaluate(buttonLeft), before);

  await tap('#shot');
  assert.ok(await zoom() < 1);
});

test('a download is the same from screens of any pixel ratio', async () => {
  const downloads = async pixelRatio => {
    await open(PHONE, { pixelRatio });
    await loadImage(1600, 1200);
    await evaluate(`paddingInputs.forEach(input => { input.value = '10'; }); ui.smoothing.value = 'grayscale'`);
    await setWidth(300);
    return [await exportImage(1), await exportImage(2), await exportImage(3)];
  };
  const reference = await downloads(1);
  for (const pixelRatio of [1.5, 2.625, 3]) {
    assert.deepEqual(await downloads(pixelRatio), reference, `pixel ratio ${pixelRatio}`);
  }
});

test('on a desktop, the preview stays in view when it fits the window', async () => {
  await open();
  await loadImage(1600, 1200);
  await evaluate('scrollTo(0, document.body.scrollHeight)');
  assert.ok(await evaluate('scrollY') > 0);
  assert.equal(await evaluate(`Math.round(document.querySelector('.preview').getBoundingClientRect().top)`), 0);
  assert.ok(await evaluate('ui.download.getBoundingClientRect().bottom < innerHeight'));

  // A box taller than the window scrolls with the page, so its bottom can be reached.
  await setWidth(600);
  await loadImage(800, 1600);
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.preview')).position`), 'static');
});

test('an image dragged from another page loads from its address', async () => {
  await open();
  const drop = async items => {
    const { x, y } = await center('#drop');
    for (const kind of ['dragEnter', 'dragOver', 'drop']) {
      await send('Input.dispatchDragEvent', { type: kind, x, y, data: { items, dragOperationsMask: 1 } });
    }
  };
  // Wikipedia wraps its images in a link, so the image address is only in the HTML.
  await drop([
    { mimeType: 'text/html', data: `<a href="${base}/index.html"><img src="${base}/social.jpg"></a>` },
    { mimeType: 'text/uri-list', data: `${base}/index.html` },
  ]);
  await until('source?.image.naturalWidth === 1200');
  assert.match(await evaluate('ui.drop.textContent'), /social\.jpg is loaded/);

  await drop([{ mimeType: 'text/uri-list', data: `${base}/apple-touch-icon.png` }]);
  await until('source?.image.naturalWidth === 180');

  await drop([{ mimeType: 'text/uri-list', data: `${base}/index.html` }]);
  await until(`ui.status.textContent.startsWith('Could not load that image.')`);

  const originals = await evaluate(`[
    'https://thumb.wikimedia.org/wikipedia/commons/thumb/7/75/Old-fashioned_well_in_Finland.JPG/250px-Old-fashioned_well_in_Finland.JPG?utm_source=x',
    'https://upload.wikimedia.org/wikipedia/en/thumb/1/1a/Bar_(x).png/330px-Bar_(x).png',
    'https://upload.wikimedia.org/wikipedia/commons/thumb/1/1a/Map.svg/250px-Map.svg.png',
    'https://example.com/thumb/a.jpg/250px-a.jpg',
  ].map(originalImageUrl)`);
  assert.deepEqual(originals, [
    'https://upload.wikimedia.org/wikipedia/commons/7/75/Old-fashioned_well_in_Finland.JPG',
    'https://upload.wikimedia.org/wikipedia/en/1/1a/Bar_(x).png',
    'https://upload.wikimedia.org/wikipedia/commons/thumb/1/1a/Map.svg/250px-Map.svg.png',
    'https://example.com/thumb/a.jpg/250px-a.jpg',
  ]);
});

test('every file the page uses is published, and the link preview points at the site', async () => {
  const page = readFileSync(join(ROOT, 'index.html'), 'utf8');
  const deploy = readFileSync(join(ROOT, '.github', 'workflows', 'deploy.yml'), 'utf8');
  const published = deploy.match(/^\s*cp (.+) _site\/$/m)[1].split(' ');
  const local = [...page.matchAll(/(?:src|href)="([^"#:]+?)(?:\?[^"]*)?"/g)].map(match => match[1]);
  for (const file of local) assert.ok(published.includes(file), `${file} is not in the deploy step`);
  const site = 'https://vinevard.github.io/wikipedia-image-box-maker/';
  assert.match(page, new RegExp(`property="og:url" content="${site}"`));
  const image = page.match(/property="og:image" content="([^"]+)"/)[1];
  assert.ok(image.startsWith(site) && published.includes(image.slice(site.length)));
});

test('the page threw no errors', () => {
  assert.deepEqual(errors, []);
});
