function enlargeIconUrl(boxes) {
  return 'data:image/svg+xml,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="11" viewBox="0 0 15 11">' +
    '<g fill="#fff" stroke="#000" stroke-width="0.733333">' +
    boxes.map(d => `<path d="${d}"/>`).join('') +
    '</g></svg>'
  );
}
// The mirrored boxes are drawn from the mirrored corner in the mirrored direction; any other order changes
// the anti-aliasing.
const ENLARGE_ICONS = {
  ltr: enlargeIconUrl(['M4.573267 1.367667h8.059333v5.807267h-8.059333z', 'M2.3674 5.036533h4.3582v3.596267h-4.3582z']),
  rtl: enlargeIconUrl(['M10.426733 1.367667h-8.059333v5.807267h8.059333z', 'M12.6326 5.036533h-4.3582v3.596267h4.3582z']),
};
const enlargeIcons = {};
for (const [direction, url] of Object.entries(ENLARGE_ICONS)) {
  document.documentElement.style.setProperty(`--enlarge-icon-${direction}`, `url("${url}")`);
  enlargeIcons[direction] = new Image();
  enlargeIcons[direction].src = url;
}

const $ = id => document.getElementById(id);
const ui = {
  drop: $('drop'), file: $('file'), caption: $('caption'), width: $('width'), widthRange: $('widthRange'),
  site: $('site'), phoneWidth: $('phoneWidth'), textSize: $('textSize'), theme: $('theme'), direction: $('direction'),
  showIcon: $('showIcon'), scale: $('scale'), smoothing: $('smoothing'),
  randomize: $('randomize'), padBase: $('padBase'), padVariation: $('padVariation'), autoRandomize: $('autoRandomize'),
  download: $('download'), copy: $('copy'), status: $('status'),
  shot: $('shot'), page: $('page'), thumb: $('thumb'), thumbLink: $('thumbLink'), thumbCaption: $('thumbCaption'),
};
const PADDING_SIDES = ['top', 'right', 'bottom', 'left'];
const paddingInputs = ['padTop', 'padRight', 'padBottom', 'padLeft'].map($);
const PHONE_SIDE_MARGIN = 16;
const PLACEHOLDER_ASPECT = 0.75;
const THUMBNAIL_DELAY_MS = 200;
const STATUS_TIMEOUT_MS = 2500;
const FILE_NAME_SLUG_LENGTH = 60;
const CAPTION_MARKUP = /\[\[([^\]|]+)(?:\|([^\]]*))?\]\]|'''(.+?)'''|''(.+?)''/g;

let source = null;
let loadId = 0;
const retiredSourceUrls = [];
// File width → { controller, ready: promise of the file, file: the file once ready }, for the current source only.
const thumbnailCache = new Map();
let shownThumbnails = null;
let thumbnailTimer = 0;
let renderedImageKey = '';
let runningExports = 0;
let currentStatus = null;

function parseCaption(text) {
  const fragment = document.createDocumentFragment();
  let last = 0;
  for (const match of text.matchAll(CAPTION_MARKUP)) {
    fragment.append(text.slice(last, match.index), captionElement(match));
    last = match.index + match[0].length;
  }
  fragment.append(text.slice(last));
  return fragment;
}

function captionElement([, target, label, bold, italic]) {
  if (target !== undefined) {
    const link = document.createElement('a');
    link.textContent = label ?? target;
    link.title = target;
    return link;
  }
  const element = document.createElement(bold !== undefined ? 'b' : 'i');
  element.append(parseCaption(bold ?? italic));
  return element;
}

function imageWidth() {
  const { value, defaultValue, min, max } = ui.width;
  return Math.min(Number(max), Math.max(Number(min), Math.round(Number(value === '' ? defaultValue : value))));
}

function imageHeight(source, width) {
  const height = source ? width * source.image.naturalHeight / source.image.naturalWidth : width * PLACEHOLDER_ASPECT;
  return Math.max(1, Math.round(height));
}

// Wikipedia's thumbnail server rounds an exact half down, while the page's height attribute rounds it up, so a
// 2272×1704 photo gets a 250×187 file in a 250×188 img.
function thumbnailFileHeight(source, width) {
  return Math.max(1, Math.ceil(width * source.image.naturalHeight / source.image.naturalWidth - 0.5));
}

function padding() {
  return paddingInputs.map(input => Math.max(0, Math.round(Number(input.value)) || 0));
}

// Wikipedia only renders thumbnails at these widths and lets the browser scale the file to the display width.
const THUMBNAIL_STEPS = [20, 40, 60, 120, 250, 330, 500, 960, 1280, 1920, 3840];

function thumbnailFileWidth(displayWidth) {
  return THUMBNAIL_STEPS.find(step => step >= displayWidth) ?? displayWidth;
}

function thumbnailFileWidths(displayWidth) {
  return [displayWidth, displayWidth * 2].map(thumbnailFileWidth);
}

function sameWidths(a, b) {
  return a.every((width, i) => width === b[i]);
}

function imageFiles(width) {
  if (shownThumbnails && sameWidths(shownThumbnails.fileWidths, thumbnailFileWidths(width))) {
    return { src: shownThumbnails.oneX.url, srcset: `${shownThumbnails.twoX.url} 2x` };
  }
  return { src: source.image.src };
}

function thumbImage(width, height, { src, srcset }) {
  const img = document.createElement('img');
  img.className = 'thumb-image';
  img.alt = '';
  img.width = width;
  img.height = height;
  img.src = src;
  if (srcset) img.srcset = srcset;
  return img;
}

function placeholder(width, height) {
  const span = document.createElement('span');
  span.className = 'thumb-image placeholder';
  span.textContent = 'No image yet';
  span.style.width = width + 'px';
  span.style.height = height + 'px';
  return span;
}

function renderImage(width, height) {
  const files = source && imageFiles(width);
  const key = JSON.stringify([width, height, files]);
  if (key === renderedImageKey) return;
  renderedImageKey = key;
  ui.thumbLink.replaceChildren(files ? thumbImage(width, height, files) : placeholder(width, height));
}

function showSiteSettings(mobile) {
  ui.phoneWidth.closest('.field').hidden = !mobile;
  ui.textSize.closest('.field').hidden = mobile;
  ui.showIcon.closest('.check').hidden = mobile;
}

function updateActions() {
  ui.download.disabled = ui.copy.disabled = !source || runningExports > 0;
}

function render() {
  const width = imageWidth();
  const scale = Number(ui.scale.value);
  const mobile = ui.site.value === 'mobile';

  showSiteSettings(mobile);
  ui.page.classList.toggle('mobile', mobile);
  ui.page.style.fontSize = mobile ? '' : ui.textSize.value + 'px';
  ui.page.style.maxWidth = mobile ? ui.phoneWidth.value - 2 * PHONE_SIDE_MARGIN + 'px' : '';
  ui.shot.classList.toggle('night', ui.theme.value === 'night');
  ui.page.dir = ui.direction.value;
  renderImage(width, imageHeight(source, width));
  ui.thumb.classList.toggle('no-icon', !ui.showIcon.checked);
  ui.thumbCaption.replaceChildren(parseCaption(ui.caption.value));
  ui.shot.style.padding = padding().map(p => p / scale + 'px').join(' ');
  updateActions();
}

// Hand-cropped screenshots usually have less space above the box than below it. Squaring a random number keeps
// the full range but pulls the top towards its minimum and the bottom towards its maximum.
function randomSpread(side) {
  const skewed = 2 * Math.random() ** 2 - 1;
  if (side === 'top') return skewed;
  if (side === 'bottom') return -skewed;
  return Math.random() * 2 - 1;
}

function randomizePadding() {
  const base = Math.max(0, Number(ui.padBase.value) || 0);
  const variation = Math.max(0, Number(ui.padVariation.value) || 0) / 100;
  paddingInputs.forEach((input, i) => {
    input.value = Math.max(0, Math.round(base * (1 + randomSpread(PADDING_SIDES[i]) * variation)));
  });
  render();
}

function showStatus(message) {
  const status = { message };
  currentStatus = status;
  ui.status.textContent = message;
  return status;
}

function clearStatus(status) {
  if (status === currentStatus) showStatus('');
}

function setStatus(message) {
  const status = showStatus(message);
  if (message) setTimeout(() => clearStatus(status), STATUS_TIMEOUT_MS);
}

function isShown(file) {
  return file === shownThumbnails?.oneX || file === shownThumbnails?.twoX;
}

function isCached(file) {
  return [...thumbnailCache.values()].some(entry => entry.file === file);
}

function releaseIfUnused(file) {
  if (file.owned && !isShown(file) && !isCached(file)) URL.revokeObjectURL(file.url);
}

function setShownThumbnails(thumbnails) {
  const previous = shownThumbnails;
  shownThumbnails = thumbnails;
  if (previous) [previous.oneX, previous.twoX].forEach(releaseIfUnused);
}

function startThumbnail(fileWidth) {
  const controller = new AbortController();
  const entry = { controller, file: null };
  entry.ready = makeThumbnail(source, fileWidth, thumbnailFileHeight(source, fileWidth), controller.signal)
    .then(file => (entry.file = file));
  entry.ready.catch(() => {
    if (thumbnailCache.get(fileWidth) === entry) thumbnailCache.delete(fileWidth);
  });
  thumbnailCache.set(fileWidth, entry);
  return entry;
}

function dropThumbnail(fileWidth) {
  const entry = thumbnailCache.get(fileWidth);
  thumbnailCache.delete(fileWidth);
  entry.controller.abort();
  entry.ready.then(releaseIfUnused, () => {});
}

function keepOnlyThumbnails(fileWidths) {
  for (const fileWidth of thumbnailCache.keys()) {
    if (!fileWidths.includes(fileWidth)) dropThumbnail(fileWidth);
  }
}

function clearThumbnailCache() {
  keepOnlyThumbnails([]);
}

async function thumbnailsFor(width) {
  const fileWidths = thumbnailFileWidths(width);
  keepOnlyThumbnails(fileWidths);
  const preparing = fileWidths.every(w => thumbnailCache.has(w)) ? null : showStatus('Preparing thumbnail…');
  const entries = fileWidths.map(w => thumbnailCache.get(w) ?? startThumbnail(w));
  try {
    const [oneX, twoX] = await Promise.all(entries.map(entry => entry.ready));
    return { fileWidths, entries, oneX, twoX };
  } catch (error) {
    if (error.name !== 'AbortError') setStatus('Could not make the thumbnail.');
    throw error;
  } finally {
    if (preparing) clearStatus(preparing);
  }
}

// The cache only holds the current source's files, so matching its entries also means matching the source.
function isCurrent(thumbnails) {
  return thumbnailFileWidths(imageWidth()).every((fileWidth, i) => thumbnailCache.get(fileWidth) === thumbnails.entries[i]);
}

async function showThumbnails() {
  clearTimeout(thumbnailTimer);
  const thumbnails = await thumbnailsFor(imageWidth());
  if (isCurrent(thumbnails)) {
    setShownThumbnails(thumbnails);
    render();
  }
  return thumbnails;
}

// Failures are already reported in the status line by thumbnailsFor.
function showThumbnailsInBackground() {
  showThumbnails().catch(() => {});
}

function scheduleThumbnails() {
  clearTimeout(thumbnailTimer);
  if (source) thumbnailTimer = setTimeout(showThumbnailsInBackground, THUMBNAIL_DELAY_MS);
}

function readPixels(image) {
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0);
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

function revokeRetiredSourceUrls() {
  if (runningExports) return;
  for (const url of retiredSourceUrls.splice(0)) URL.revokeObjectURL(url);
}

function useSource(newSource) {
  const previousUrl = source?.image.src;
  source = newSource;
  setShownThumbnails(null);
  clearThumbnailCache();
  setStatus('');
  if (ui.autoRandomize.checked) randomizePadding();
  else render();
  showThumbnailsInBackground();
  if (previousUrl) {
    retiredSourceUrls.push(previousUrl);
    revokeRetiredSourceUrls();
  }
}

function showLoadedFile(name) {
  const fileName = document.createElement('strong');
  fileName.textContent = name;
  ui.drop.replaceChildren(fileName, ' is loaded. Choose another, drop one here, or paste with Ctrl+V');
  ui.drop.classList.add('loaded');
}

async function loadFile(file) {
  if (!file || !file.type.startsWith('image/')) return;
  const id = ++loadId;
  const url = URL.createObjectURL(file);
  try {
    const image = await loadImage(url);
    if (id === loadId) {
      showLoadedFile(file.name);
      return useSource({ image, pixels: readPixels(image), type: file.type });
    }
  } catch {
    if (id === loadId) setStatus('Could not read that image.');
  }
  URL.revokeObjectURL(url);
}

ui.drop.addEventListener('click', () => ui.file.click());
ui.drop.addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    ui.file.click();
  }
});
ui.file.addEventListener('change', () => loadFile(ui.file.files[0]));
const fileDragHandlers = {
  dragenter: () => ui.drop.classList.add('over'),
  dragover: () => ui.drop.classList.add('over'),
  dragleave: e => { if (!e.relatedTarget) ui.drop.classList.remove('over'); },
  drop: e => {
    ui.drop.classList.remove('over');
    loadFile(e.dataTransfer.files[0]);
  },
};
for (const [type, handle] of Object.entries(fileDragHandlers)) {
  document.addEventListener(type, e => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    handle(e);
  });
}
document.addEventListener('paste', e => {
  const item = [...e.clipboardData.items].find(i => i.type.startsWith('image/'));
  if (item) loadFile(item.getAsFile());
});

for (const input of [ui.caption, ...paddingInputs]) input.addEventListener('input', render);
for (const input of [ui.site, ui.phoneWidth, ui.showIcon, ui.textSize, ui.theme, ui.direction, ui.scale]) {
  input.addEventListener('change', render);
}
function syncWidth(e) {
  (e.target === ui.width ? ui.widthRange : ui.width).value = e.target.value;
  render();
  scheduleThumbnails();
}
ui.width.addEventListener('input', syncWidth);
ui.widthRange.addEventListener('input', syncWidth);
ui.randomize.addEventListener('click', randomizePadding);

// Safari only supports canvas filters behind a flag, so the CSS filters the preview uses are applied by hand.
function colorFilter(filter) {
  const [, name, amount] = filter.match(/^(invert|brightness)\((.+)\)$/) ?? [];
  if (name === 'invert') return v => v + (255 - 2 * v) * Number(amount);
  if (name === 'brightness') return v => v * Number(amount);
  return null;
}

function filterPixels(ctx, x, y, width, height, filter) {
  const pixels = ctx.getImageData(x, y, width, height);
  for (let i = 0; i < pixels.data.length; i += 4) {
    for (let c = 0; c < 3; c++) pixels.data[i + c] = filter(pixels.data[i + c]);
  }
  ctx.putImageData(pixels, x, y);
}

function filteredCopy(image, width, height, filter) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0, width, height);
  filterPixels(ctx, 0, 0, width, height, filter);
  return canvas;
}

function drawCaptionText(ctx, caption, toBoxRect) {
  const walker = document.createTreeWalker(caption, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  ctx.textAlign = 'left';
  for (let node; (node = walker.nextNode());) {
    const style = getComputedStyle(node.parentElement);
    ctx.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    ctx.fillStyle = style.color;
    // Canvas runs its own bidi on each word; the element's direction puts neutral characters such as
    // punctuation where the page put them.
    ctx.direction = style.direction;
    // A text rect's top is the top of the font's ascent.
    const ascent = ctx.measureText('Hg').fontBoundingBoxAscent;
    const drawRun = (start, end) => {
      range.setStart(node, start);
      range.setEnd(node, end);
      const rects = range.getClientRects();
      if (rects.length === 1 || end - start === 1) {
        const r = toBoxRect(rects[0]);
        ctx.fillText(node.data.slice(start, end), r.x, r.y + ascent);
      } else {
        // The word was split by a line wrap or a bidi run, so each character is placed on its own.
        for (let i = start; i < end; i++) drawRun(i, i + 1);
      }
    };
    for (const word of node.data.matchAll(/\S+/g)) drawRun(word.index, word.index + word[0].length);
  }
}

// A fresh element, because Firefox rejects decode() for an image that ever had a srcset, even after removing it.
function exportImage(img, url) {
  const copy = document.createElement('img');
  for (const { name, value } of img.attributes) {
    if (name !== 'src' && name !== 'srcset') copy.setAttribute(name, value);
  }
  copy.src = url;
  return copy;
}

// A hidden copy of the preview. zoom multiplies with devicePixelRatio, so with zoom = scale / devicePixelRatio
// the browser lays it out, fonts and pixel snapping included, as it would on a screen whose ratio is the scale.
function exportLayout(zoom, imageUrl) {
  const shot = ui.shot.cloneNode(true);
  for (const element of [shot, ...shot.querySelectorAll('[id]')]) element.removeAttribute('id');
  shot.classList.add('export-layout');
  shot.style.zoom = zoom;
  // A denser screen rounds the caption's 88.4% font size before scaling it, but Firefox's zoom rounds after,
  // so the copy keeps the preview's already rounded size.
  shot.querySelector('.thumb-caption').style.fontSize = getComputedStyle(ui.thumbCaption).fontSize;
  // With height: auto the box is sized from whichever file is loaded (the 2x file can be half a pixel shorter).
  const img = shot.querySelector('img');
  img.replaceWith(exportImage(img, imageUrl));
  ui.shot.after(shot);
  return shot;
}

// showThumbnails can settle for a width or image that has changed since; only current files may be exported.
async function currentThumbnails() {
  for (;;) {
    try {
      const thumbnails = await showThumbnails();
      if (isCurrent(thumbnails)) return thumbnails;
    } catch (error) {
      if (error.name !== 'AbortError') throw error;
    }
  }
}

// Repaints the preview onto a canvas using the browser's own layout, so the PNG matches a real screenshot.
async function paintExport(scale) {
  await document.fonts.ready;
  await Promise.all(Object.values(enlargeIcons).map(icon => icon.decode()));
  const thumbnails = await currentThumbnails();

  // Same choice the browser makes from srcset: a 1x screen gets the 1x file, anything denser the 2x file.
  const file = scale === 1 ? thumbnails.oneX : thumbnails.twoX;
  // A private URL for the same file keeps it out of the cache entry for its srcset URL. Chrome would otherwise
  // show a cached 2x file even on a 1x screen, which a Wikipedia visitor's browser wouldn't.
  const imageUrl = file.owned ? URL.createObjectURL(file.blob) : file.url;
  const zoom = scale / devicePixelRatio;
  const shot = exportLayout(zoom, imageUrl);
  try {
    await shot.querySelector('img').decode();
    return drawExport(scale, zoom, shot);
  } finally {
    shot.remove();
    if (file.owned) URL.revokeObjectURL(imageUrl);
  }
}

async function toCanvas(scale) {
  runningExports++;
  updateActions();
  try {
    return await paintExport(scale);
  } finally {
    runningExports--;
    updateActions();
    revokeRetiredSourceUrls();
  }
}

// The browser paints images on whole device pixels, even when their layout height is fractional.
function snapToPixels(rect, scale) {
  const snap = v => Math.round(v * scale) / scale;
  return { x: snap(rect.x), y: snap(rect.y), w: snap(rect.x + rect.w) - snap(rect.x), h: snap(rect.y + rect.h) - snap(rect.y) };
}

// Drawn in whole device pixels so the frame stays crisp when the caption's height is fractional.
function drawFrame(ctx, figure, frame, scale) {
  const style = getComputedStyle(figure);
  const inset = parseFloat(style.borderTopWidth) * scale;
  if (!inset) return;
  ctx.fillStyle = style.borderTopColor;
  ctx.fillRect(frame.x, frame.y, frame.w, frame.h);
  ctx.fillStyle = style.backgroundColor;
  ctx.fillRect(frame.x + inset, frame.y + inset, frame.w - 2 * inset, frame.h - 2 * inset);
}

function drawPhoto(ctx, img, imageRect, scale, frame) {
  const style = getComputedStyle(img);
  const border = parseFloat(style.borderTopWidth);
  if (border) {
    ctx.fillStyle = style.borderTopColor;
    ctx.fillRect(imageRect.x, imageRect.y, imageRect.w, imageRect.h);
  }
  const inner = [imageRect.x + border, imageRect.y + border, imageRect.w - 2 * border, imageRect.h - 2 * border];
  ctx.fillStyle = style.backgroundColor;
  ctx.fillRect(...inner);
  ctx.drawImage(img, ...inner);
  const filter = colorFilter(style.filter);
  if (filter) {
    // getImageData ignores the canvas transform, so the image rect is converted to device pixels here.
    const device = v => Math.round(v * scale);
    filterPixels(ctx, frame.x + device(imageRect.x), frame.y + device(imageRect.y), device(imageRect.w), device(imageRect.h), filter);
  }
}

function drawEnlargeIcon(ctx, link, toBoxRect, scale) {
  const iconStyle = getComputedStyle(link, '::after');
  if (iconStyle.content === 'none') return;
  const linkRect = toBoxRect(link.getBoundingClientRect());
  const w = parseFloat(iconStyle.width);
  const h = parseFloat(iconStyle.height);
  const filter = colorFilter(iconStyle.filter);
  const icon = enlargeIcons[iconStyle.direction];
  ctx.drawImage(filter ? filteredCopy(icon, w * scale, h * scale, filter) : icon,
    linkRect.x + parseFloat(iconStyle.left), linkRect.y + parseFloat(iconStyle.top), w, h);
}

function drawExport(scale, zoom, shot) {
  const [figure, link, img, caption] = ['.thumb', '.thumb-link', '.thumb-image', '.thumb-caption'].map(s => shot.querySelector(s));
  const box = figure.getBoundingClientRect();
  const toBoxRect = r => ({ x: (r.left - box.left) / zoom, y: (r.top - box.top) / zoom, w: r.width / zoom, h: r.height / zoom });
  const [top, right, bottom, left] = padding();
  const size = toBoxRect(box);
  const frame = { x: left, y: top, w: Math.round(size.w * scale), h: Math.round(size.h * scale) };

  const canvas = document.createElement('canvas');
  canvas.width = left + frame.w + right;
  canvas.height = top + frame.h + bottom;
  // Browsers only smooth canvas text with coloured sub-pixels when the canvas is opaque.
  const ctx = canvas.getContext('2d', { alpha: ui.smoothing.value === 'grayscale' });
  ctx.fillStyle = getComputedStyle(shot).backgroundColor;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  drawFrame(ctx, figure, frame, scale);
  ctx.translate(left, top);
  ctx.scale(scale, scale);
  drawPhoto(ctx, img, snapToPixels(toBoxRect(img.getBoundingClientRect()), scale), scale, frame);
  drawEnlargeIcon(ctx, link, toBoxRect, scale);
  drawCaptionText(ctx, caption, toBoxRect);
  return canvas;
}

function subpixelTextSupported() {
  const ctx = document.createElement('canvas').getContext('2d', { alpha: false });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, 40, 30);
  ctx.fillStyle = '#000';
  ctx.font = '20px sans-serif';
  ctx.fillText('x', 5, 20);
  const { data } = ctx.getImageData(0, 0, 40, 30);
  return data.some((value, i) => i % 4 === 0 && (value !== data[i + 1] || value !== data[i + 2]));
}

function fileName() {
  const slug = ui.thumbCaption.textContent.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    .slice(0, FILE_NAME_SLUG_LENGTH);
  return (slug || 'wikipedia-image') + '.png';
}

async function exportBlob() {
  return toBlob(await toCanvas(Number(ui.scale.value)), 'image/png');
}

// A ClipboardItem that only takes finished data turns a promise into the text "[object Promise]", so this reads
// a promised value back once at startup.
let clipboardTakesPromises = true;
(async () => {
  const item = new ClipboardItem({ 'text/plain': Promise.resolve('ok') });
  return await (await item.getType('text/plain')).text() === 'ok';
})().then(takesPromises => { clipboardTakesPromises = takesPromises; }, () => { clipboardTakesPromises = false; });

ui.download.addEventListener('click', async () => {
  try {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(await exportBlob());
    link.download = fileName();
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  } catch {
    setStatus('Could not make the image.');
  }
});

ui.copy.addEventListener('click', async () => {
  if (!window.ClipboardItem || !navigator.clipboard?.write) return setStatus('Copying is not supported here. Use Download.');
  const blob = exportBlob();
  try {
    // Given the blob as a promise, the item is written within the click, so a slow export keeps its user activation.
    const item = new ClipboardItem({ 'image/png': clipboardTakesPromises ? blob : await blob });
    await navigator.clipboard.write([item]);
    setStatus('Copied to clipboard.');
  } catch {
    setStatus('Could not copy the image.');
  }
});

ui.smoothing.closest('.field').hidden = !subpixelTextSupported();
randomizePadding();
