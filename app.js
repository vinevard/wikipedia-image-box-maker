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
const settingsForm = $('settings');
const ui = {
  drop: $('drop'), file: $('file'), caption: $('caption'),
  width: $('width'), widthRange: $('widthRange'), widthReset: $('widthReset'),
  site: $('site'), phoneWidth: $('phoneWidth'), direction: $('direction'),
  textSize: settingsForm.elements.textSize, theme: settingsForm.elements.theme,
  showIcon: $('showIcon'), scale: $('scale'), smoothing: $('smoothing'),
  whiteSpace: $('whiteSpace'), whiteSpaceOptions: $('whiteSpaceOptions'),
  randomize: $('randomize'), padBase: $('padBase'), padVariation: $('padVariation'), autoRandomize: $('autoRandomize'),
  download: $('download'), copy: $('copy'), reset: $('resetSettings'), status: $('status'),
  shot: $('shot'), previewScale: $('previewScale'), page: $('page'), thumb: $('thumb'), thumbLink: $('thumbLink'), thumbCaption: $('thumbCaption'),
};
const PADDING_SIDES = ['top', 'right', 'bottom', 'left'];
const paddingInputs = ['padTop', 'padRight', 'padBottom', 'padLeft'].map($);
const PHONE_SIDE_MARGIN = 16;
const PLACEHOLDER_ASPECT = 0.75;
const THUMBNAIL_DELAY_MS = 200;
const STATUS_TIMEOUT_MS = 2500;
const SHOT_OUTLINE = 1;
// Matches the single-column layout in style.css.
const narrowScreen = matchMedia('(max-width: 760px)');
const FILE_NAME_SLUG_LENGTH = 60;
// Sub-pixel text has fringes of 150 levels or more; grey text, 2 at most.
const SUBPIXEL_FRINGE = 24;
const SUBPIXEL_FRINGE_PIXELS = 10;
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
// Set by a tap on a preview that was shrunk to fit.
let previewFullSize = false;

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
  if (!ui.whiteSpace.checked) return [0, 0, 0, 0];
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
  span.textContent = touchScreen ? 'Tap to choose an image' : `Choose an image, drop one here, or paste with ${PASTE_KEY}`;
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
  ui.textSize[0].closest('.field').hidden = mobile;
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
  // Hidden without display: none, so the text below does not move while the slider is dragged.
  ui.widthReset.style.visibility = width === Number(ui.width.defaultValue) ? 'hidden' : '';
  ui.thumb.classList.toggle('no-icon', !ui.showIcon.checked);
  ui.thumbCaption.replaceChildren(parseCaption(ui.caption.value));
  ui.whiteSpaceOptions.hidden = !ui.whiteSpace.checked;
  ui.shot.style.padding = padding().map(p => p / scale + 'px').join(' ');
  fitPreview();
  updateActions();
}

// The export lays out its own copy and sets its own zoom on it, so scaling the preview does not change the
// download. Only the caption's font size is read from the preview, by unzoomedCaptionFontSize.
function fitPreview() {
  ui.shot.style.zoom = '';
  const frame = ui.shot.parentElement;
  const style = getComputedStyle(frame);
  const room = frame.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - 2 * SHOT_OUTLINE;
  const fit = narrowScreen.matches ? Math.min(1, room / ui.shot.getBoundingClientRect().width) : 1;
  if (fit < 1 && !previewFullSize) ui.shot.style.zoom = fit;
  ui.shot.classList.toggle('zoomable', fit < 1 && !!source);
  ui.previewScale.hidden = fit === 1;
  let note = `Shown at ${Math.floor(fit * 100)}% to fit your screen.`;
  if (previewFullSize) note = 'Shown at full size. Scroll sideways to see all of it, or tap the preview to fit it to your screen.';
  else if (source) note += ' Tap the preview to see it at full size. The download keeps its full size.';
  ui.previewScale.textContent = note;
  // A preview taller than the window would hide its own bottom and buttons if it stayed in place.
  const preview = frame.parentElement;
  preview.classList.toggle('sticky', preview.offsetHeight <= innerHeight);
}

// Firefox rounds a zoomed font size differently, so the fit-to-screen zoom is taken off while reading it.
function unzoomedCaptionFontSize() {
  const zoom = ui.shot.style.zoom;
  ui.shot.style.zoom = '';
  const size = getComputedStyle(ui.thumbCaption).fontSize;
  ui.shot.style.zoom = zoom;
  return size;
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
  // Disabled buttons get no clicks, so the reason they are disabled stays in view instead.
  ui.status.textContent = message || (source ? '' : 'Choose an image first.');
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
  previewFullSize = false;
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

// Phones and tablets can't drop files or press Ctrl+V, so they get shorter instructions.
const touchScreen = matchMedia('(hover: none) and (pointer: coarse)').matches;
const PASTE_KEY = /mac/i.test(navigator.userAgentData?.platform ?? navigator.platform) ? '⌘V' : 'Ctrl+V';

function bold(text) {
  const element = document.createElement('strong');
  element.textContent = text;
  return element;
}

function showLoadedFile(name) {
  const instructions = touchScreen ? 'Tap to choose another.' : `Choose another, drop one here, or paste with ${PASTE_KEY}`;
  ui.drop.replaceChildren(bold(name), ' is loaded. ' + instructions);
  ui.drop.classList.add('loaded');
}

async function loadFile(file) {
  if (!file) return;
  if (!file.type.startsWith('image/')) return setStatus('That file is not an image. Choose a JPEG, PNG, GIF or WebP file.');
  const id = ++loadId;
  const url = URL.createObjectURL(file);
  try {
    const image = await loadImage(url);
    if (id === loadId) {
      showLoadedFile(file.name);
      return useSource({ image, pixels: readPixels(image), type: file.type });
    }
  } catch {
    if (id === loadId) setStatus('Could not read that image. Try a JPEG or PNG file.');
  }
  URL.revokeObjectURL(url);
}

// An image dragged from another page arrives as its URL. Wikimedia lets other sites read its images; most sites
// do not, and the error tells the user to save the image first.
function draggedImageUrl(dataTransfer) {
  const html = dataTransfer.getData('text/html');
  // Wikipedia wraps images in a link to the file page, so the image's own address is only in the HTML.
  const src = html && new DOMParser().parseFromString(html, 'text/html').querySelector('img')?.getAttribute('src');
  const url = src || dataTransfer.getData('text/uri-list').split(/\r?\n/).find(line => line && !line.startsWith('#'));
  return url?.startsWith('//') ? 'https:' + url : url;
}

// Wikipedia shows a resized copy. The tool resizes from the original, which is on upload.wikimedia.org at the
// same path without /thumb/ and the size prefix. Formats that browsers cannot show, such as SVG and TIFF, keep
// the copy.
function originalImageUrl(url) {
  const { hostname, pathname } = new URL(url);
  const match = pathname.match(/^(\/.+?)\/thumb(\/.+\.(?:jpe?g|png|gif|webp))\/[^/]+$/i);
  if (!match || !/^(upload|thumb)\.wikimedia\.org$/.test(hostname)) return url;
  return 'https://upload.wikimedia.org' + match[1] + match[2];
}

async function loadUrl(url) {
  if (!/^https?:/.test(url ?? '')) return;
  const id = ++loadId;
  showStatus('Loading the image…');
  try {
    const response = await fetch(originalImageUrl(url));
    const blob = await response.blob();
    if (!response.ok || !blob.type.startsWith('image/')) throw new Error();
    if (id !== loadId) return;
    const name = decodeURIComponent(new URL(response.url).pathname.split('/').pop());
    await loadFile(new File([blob], name, { type: blob.type }));
  } catch {
    if (id === loadId) setStatus('Could not load that image. Save it, then choose or drop the file.');
  }
}

ui.drop.addEventListener('click', () => ui.file.click());
ui.thumbLink.addEventListener('click', () => { if (!source) ui.file.click(); });
ui.shot.addEventListener('click', () => {
  if (!ui.shot.classList.contains('zoomable')) return;
  previewFullSize = !previewFullSize;
  fitPreview();
});
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
    if (e.dataTransfer.files.length) loadFile(e.dataTransfer.files[0]);
    else loadUrl(draggedImageUrl(e.dataTransfer));
  },
};
for (const [type, handle] of Object.entries(fileDragHandlers)) {
  document.addEventListener(type, e => {
    if (!e.dataTransfer.types.includes('Files') && !e.dataTransfer.types.includes('text/uri-list')) return;
    e.preventDefault();
    handle(e);
  });
}
document.addEventListener('paste', e => {
  const item = [...e.clipboardData.items].find(i => i.type.startsWith('image/'));
  if (item) loadFile(item.getAsFile());
});

for (const input of [ui.caption, ...paddingInputs]) input.addEventListener('input', render);
// A typed side value would be replaced by the next image.
for (const input of paddingInputs) input.addEventListener('input', () => { ui.autoRandomize.checked = false; });
for (const input of [ui.site, ui.phoneWidth, ui.showIcon, ui.whiteSpace, ...ui.textSize, ...ui.theme, ui.direction, ui.scale]) {
  input.addEventListener('change', render);
}
function syncWidth(e) {
  (e.target === ui.width ? ui.widthRange : ui.width).value = e.target.value;
  render();
  scheduleThumbnails();
}
ui.width.addEventListener('input', syncWidth);
ui.widthRange.addEventListener('input', syncWidth);
// Typing can go past the range or leave the box empty. When the typing ends, the box shows the width in use.
ui.width.addEventListener('change', () => {
  ui.width.value = ui.widthRange.value = imageWidth();
  render();
});
ui.widthReset.addEventListener('click', () => {
  ui.width.value = ui.widthRange.value = ui.width.defaultValue;
  render();
  scheduleThumbnails();
  saveSettings();
  // The link hides itself at 250px, so focus would be lost.
  ui.widthRange.focus();
});
ui.randomize.addEventListener('click', randomizePadding);
addEventListener('resize', fitPreview);

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

// A hidden copy of the preview, laid out with zoom = scale. A whole-number zoom gives the same layout on every
// screen. A zoom of scale / devicePixelRatio does not: below 1 or between whole numbers, browsers round border
// widths to a different number of pixels, and a 2x download from a 3x phone came out 4px too large.
function exportLayout(zoom, imageUrl) {
  const shot = ui.shot.cloneNode(true);
  for (const element of [shot, ...shot.querySelectorAll('[id]')]) element.removeAttribute('id');
  shot.classList.add('export-layout');
  shot.style.zoom = zoom;
  // A denser screen rounds the caption's 88.4% font size before scaling it, but Firefox's zoom rounds after,
  // so the copy keeps the preview's already rounded size.
  shot.querySelector('.thumb-caption').style.fontSize = unzoomedCaptionFontSize();
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
  const zoom = scale;
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

// Draws a caption the way the export does: same font, size and colours, on an opaque canvas. Some fonts and sizes
// never get sub-pixel text, and grey text such as #202122 differs by a level or two between channels anyway, so
// only clear colour fringes count.
function subpixelTextSupported() {
  const ctx = document.createElement('canvas').getContext('2d', { alpha: false });
  ctx.canvas.width = 200;
  ctx.canvas.height = 30;
  const caption = getComputedStyle(ui.thumbCaption);
  ctx.fillStyle = getComputedStyle(ui.thumb).backgroundColor;
  ctx.fillRect(0, 0, 200, 30);
  ctx.fillStyle = caption.color;
  ctx.font = `${caption.fontSize} ${caption.fontFamily}`;
  ctx.fillText('An example caption with a link', 4, 20);
  const { data } = ctx.getImageData(0, 0, 200, 30);
  let fringes = 0;
  for (let i = 0; i < data.length; i += 4) {
    const [r, g, b] = data.subarray(i, i + 3);
    if (Math.max(r, g, b) - Math.min(r, g, b) > SUBPIXEL_FRINGE) fringes++;
  }
  return fringes >= SUBPIXEL_FRINGE_PIXELS;
}

// Keeps letters of any script and cuts at a word boundary. Lengths count code points, so a cut can't split one.
function fileName() {
  const words = ui.thumbCaption.textContent.normalize('NFC').toLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu) || [];
  let slug = [...words[0] || ''].slice(0, FILE_NAME_SLUG_LENGTH).join('');
  for (const word of words.slice(1)) {
    if ([...slug].length + 1 + [...word].length > FILE_NAME_SLUG_LENGTH) break;
    slug += '-' + word;
  }
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

const SETTINGS_KEY = 'wikipedia-image-box-maker-settings';
// Form control names or ids. A radio group's name gives a RadioNodeList, whose value is the checked radio's.
const SAVED_SETTINGS = [
  'caption', 'site', 'phoneWidth', 'width', 'textSize', 'theme', 'direction', 'showIcon', 'whiteSpace',
  'padTop', 'padRight', 'padBottom', 'padLeft', 'padBase', 'padVariation', 'autoRandomize', 'scale', 'smoothing',
];

// Version 1 saved every setting, including the ones still at their defaults.
const SETTINGS_VERSION = 2;

function valueOf(control) {
  return control.type === 'checkbox' ? control.checked : control.value;
}

function defaultOf(control) {
  if (control.type === 'checkbox') return control.defaultChecked;
  if (control instanceof RadioNodeList) return [...control].find(radio => radio.defaultChecked)?.value ?? '';
  // Like form.reset(), the last option marked selected wins.
  if (control.tagName === 'SELECT') return ([...control.options].findLast(o => o.defaultSelected) ?? control.options[0]).value;
  return control.defaultValue;
}

// Only values that differ from the defaults are saved, so a changed default reaches users who never set it.
function saveSettings() {
  const settings = { version: SETTINGS_VERSION };
  for (const name of SAVED_SETTINGS) {
    const control = settingsForm.elements[name];
    if (valueOf(control) !== defaultOf(control)) settings[name] = valueOf(control);
  }
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {}
}

// Setting a RadioNodeList to a value that no radio has leaves it unchanged, but a select would show nothing.
function restoreControl(control, value) {
  if (control.type === 'checkbox') {
    if (typeof value === 'boolean') control.checked = value;
  } else if (typeof value === 'string' && (control.tagName !== 'SELECT' || [...control.options].some(o => o.value === value))) {
    control.value = value;
  }
}

function restoreSettings() {
  let settings;
  try {
    settings = JSON.parse(localStorage.getItem(SETTINGS_KEY));
  } catch {}
  if (settings && typeof settings === 'object') {
    // Text smoothing's default changed after version 1, which saved the old default for everyone.
    if (!settings.version) delete settings.smoothing;
    for (const name of SAVED_SETTINGS) restoreControl(settingsForm.elements[name], settings[name]);
  }
  ui.width.value = ui.widthRange.value = imageWidth();
}

// The caption is the user's content, not a setting, so it is kept.
function resetSettings() {
  const caption = ui.caption.value;
  settingsForm.reset();
  ui.caption.value = caption;
  saveSettings();
  randomizePadding();
  scheduleThumbnails();
}

// Only user edits are saved, so tools/verify/hook.js, which sets the controls from code, leaves no settings behind
// for the next case.
settingsForm.addEventListener('input', saveSettings);
settingsForm.addEventListener('change', saveSettings);
ui.randomize.addEventListener('click', saveSettings);
ui.reset.addEventListener('click', resetSettings);

if (touchScreen) ui.drop.replaceChildren(bold('Tap to choose an image'));
else ui.drop.replaceChildren(bold('Choose an image'), `, drop one here, or paste with ${PASTE_KEY}`);
// Where the browser can draw sub-pixel text, real screenshots from the same computer usually have it too.
if (subpixelTextSupported()) ui.smoothing.querySelector('[value=subpixel]').defaultSelected = true;
else ui.smoothing.closest('.field').hidden = true;
restoreSettings();
// Without CSS zoom, the export copy cannot be laid out at 2x or 3x.
if (!CSS.supports('zoom', '2')) {
  for (const option of ui.scale.options) option.disabled = option.value !== '1';
  ui.scale.value = '1';
}
ui.direction.closest('.more').open = ui.direction.value !== defaultOf(ui.direction);
if (ui.autoRandomize.checked) randomizePadding();
else render();
showStatus('');
