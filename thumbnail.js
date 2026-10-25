// Tuned against Wikipedia's real 250px and 500px thumbnails of the same originals.
const SHARPEN_SIGMA = 1.0;
const SHARPEN_AMOUNT = 0.7;
const JPEG_QUALITY = 0.87;

function lanczos3(x) {
  x = Math.abs(x);
  if (x < 1e-8) return 1;
  if (x >= 3) return 0;
  const px = Math.PI * x;
  return 3 * Math.sin(px) * Math.sin(px / 3) / (px * px);
}

function resampleWeights(srcSize, dstSize) {
  const scale = srcSize / dstSize;
  const filterScale = Math.max(scale, 1);
  const radius = 3 * filterScale;
  const result = [];
  for (let i = 0; i < dstSize; i++) {
    const center = (i + 0.5) * scale;
    const first = Math.max(0, Math.floor(center - radius));
    const last = Math.min(srcSize - 1, Math.ceil(center + radius));
    const weights = [];
    let sum = 0;
    for (let j = first; j <= last; j++) {
      const w = lanczos3((j + 0.5 - center) / filterScale);
      weights.push(w);
      sum += w;
    }
    result.push({ first, weights: Float32Array.from(weights, w => w / sum) });
  }
  return result;
}

// Returns premultiplied RGBA (color × alpha, alpha 0-255) so transparent pixels don't bleed into edges.
function resize(imageData, width, height) {
  const { data, width: srcWidth, height: srcHeight } = imageData;
  const columns = resampleWeights(srcWidth, width);
  const rows = resampleWeights(srcHeight, height);

  const horizontal = new Float32Array(width * srcHeight * 4);
  for (let y = 0; y < srcHeight; y++) {
    const row = y * srcWidth;
    for (let x = 0; x < width; x++) {
      const { first, weights } = columns[x];
      let r = 0, g = 0, b = 0, a = 0;
      for (let k = 0, p = (row + first) * 4; k < weights.length; k++, p += 4) {
        const wa = weights[k] * data[p + 3];
        r += data[p] * wa;
        g += data[p + 1] * wa;
        b += data[p + 2] * wa;
        a += wa;
      }
      const out = (y * width + x) * 4;
      horizontal[out] = r;
      horizontal[out + 1] = g;
      horizontal[out + 2] = b;
      horizontal[out + 3] = a;
    }
  }

  const result = new Float32Array(width * height * 4);
  const stride = width * 4;
  for (let y = 0; y < height; y++) {
    const { first, weights } = rows[y];
    for (let x = 0; x < width; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let k = 0, p = first * stride + x * 4; k < weights.length; k++, p += stride) {
        const w = weights[k];
        r += horizontal[p] * w;
        g += horizontal[p + 1] * w;
        b += horizontal[p + 2] * w;
        a += horizontal[p + 3] * w;
      }
      const out = (y * width + x) * 4;
      result[out] = r;
      result[out + 1] = g;
      result[out + 2] = b;
      result[out + 3] = a;
    }
  }
  return result;
}

// Averages factor×factor blocks. Shrinking huge photos this way first makes the Lanczos pass far cheaper;
// keeping the intermediate at least 6× the target size matched Wikipedia's thumbnails as well or better.
function boxReduce(imageData, factor) {
  const { data, width: srcWidth, height: srcHeight } = imageData;
  const width = Math.floor(srcWidth / factor);
  const height = Math.floor(srcHeight / factor);
  const out = new ImageData(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let dy = 0; dy < factor; dy++) {
        for (let dx = 0, p = ((y * factor + dy) * srcWidth + x * factor) * 4; dx < factor; dx++, p += 4) {
          const alpha = data[p + 3];
          r += data[p] * alpha;
          g += data[p + 1] * alpha;
          b += data[p + 2] * alpha;
          a += alpha;
        }
      }
      const o = (y * width + x) * 4;
      if (a) {
        out.data[o] = r / a;
        out.data[o + 1] = g / a;
        out.data[o + 2] = b / a;
      }
      out.data[o + 3] = a / (factor * factor);
    }
  }
  return out;
}

function clampIndex(i, max) {
  return Math.min(max, Math.max(0, i));
}

function gaussianWeights(sigma) {
  const radius = Math.ceil(sigma * 3);
  const kernel = [];
  for (let i = -radius; i <= radius; i++) kernel.push(Math.exp(-(i * i) / (2 * sigma * sigma)));
  const total = kernel.reduce((a, b) => a + b);
  return kernel.map(k => k / total);
}

function blurRows(pixels, width, height, weights) {
  const radius = (weights.length - 1) / 2;
  const output = new Float32Array(pixels.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const out = (y * width + x) * 4;
      for (let k = -radius; k <= radius; k++) {
        const src = (y * width + clampIndex(x + k, width - 1)) * 4;
        const w = weights[k + radius];
        for (let c = 0; c < 4; c++) output[out + c] += pixels[src + c] * w;
      }
    }
  }
  return output;
}

// Writes the column blur at (x, y) into a Float32Array(4), which rounds each step like a full blurred buffer would.
function blurColumnAt(rowBlurred, width, height, weights, x, y, sum) {
  const radius = (weights.length - 1) / 2;
  sum.fill(0);
  for (let k = -radius; k <= radius; k++) {
    const src = (clampIndex(y + k, height - 1) * width + x) * 4;
    const w = weights[k + radius];
    for (let c = 0; c < 4; c++) sum[c] += rowBlurred[src + c] * w;
  }
}

function sharpenToImageData(pixels, width, height) {
  const weights = gaussianWeights(SHARPEN_SIGMA);
  const rowBlurred = blurRows(pixels, width, height, weights);
  const blurred = new Float32Array(4);
  const out = new ImageData(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      blurColumnAt(rowBlurred, width, height, weights, x, y, blurred);
      const alpha = Math.min(255, Math.max(0, pixels[i + 3] + SHARPEN_AMOUNT * (pixels[i + 3] - blurred[3])));
      for (let c = 0; c < 3; c++) {
        const v = pixels[i + c] + SHARPEN_AMOUNT * (pixels[i + c] - blurred[c]);
        // Dividing by the sharpened alpha converts premultiplied back to straight RGBA.
        out.data[i + c] = alpha ? v / alpha : 0;
      }
      out.data[i + 3] = alpha;
    }
  }
  return out;
}

function thumbnailPixels(pixels, width, height) {
  const factor = Math.floor(pixels.width / (width * 6));
  const input = factor >= 2 ? boxReduce(pixels, factor) : pixels;
  return sharpenToImageData(resize(input, width, height), width, height);
}

// Chrome refuses to start a worker from a script file on file://, so the worker is built from this file's own functions.
// They are serialized with String(), so they must stay self-contained: every helper and constant they use must be
// listed or declared here.
const thumbnailWorkerUrl = URL.createObjectURL(new Blob([[
  `const SHARPEN_SIGMA = ${SHARPEN_SIGMA}, SHARPEN_AMOUNT = ${SHARPEN_AMOUNT};`,
  ...[lanczos3, resampleWeights, resize, boxReduce, clampIndex, gaussianWeights, blurRows, blurColumnAt,
    sharpenToImageData, thumbnailPixels].map(String),
  'onmessage = ({ data }) => { const pixels = thumbnailPixels(data.pixels, data.width, data.height); postMessage(pixels, [pixels.data.buffer]); };',
].join('\n')], { type: 'text/javascript' }));

function thumbnailPixelsOnMainThread(pixels, width, height) {
  try {
    return Promise.resolve(thumbnailPixels(pixels, width, height));
  } catch (error) {
    return Promise.reject(error);
  }
}

function thumbnailPixelsOffMainThread(pixels, width, height, signal) {
  let worker;
  try {
    worker = new Worker(thumbnailWorkerUrl);
  } catch {
    return thumbnailPixelsOnMainThread(pixels, width, height);
  }
  return new Promise((resolve, reject) => {
    const stop = () => {
      worker.terminate();
      signal.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      stop();
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort);
    worker.onmessage = e => {
      stop();
      resolve(e.data);
    };
    worker.onerror = () => {
      stop();
      resolve(thumbnailPixelsOnMainThread(pixels, width, height));
    };
    worker.postMessage({ pixels, width, height });
  });
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = url;
  });
}

function toBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => canvas.toBlob(blob => {
    if (blob) resolve(blob);
    else reject(new Error(`The browser could not encode a ${canvas.width}×${canvas.height} ${type ?? 'image/png'} image.`));
  }, type, quality));
}

// Like Wikipedia, never upscale: a thumbnail at least as large as the original is the original.
async function makeThumbnail(source, width, height, signal) {
  if (width >= source.image.naturalWidth) return { url: source.image.src, owned: false };

  const pixels = await thumbnailPixelsOffMainThread(source.pixels, width, height, signal);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').putImageData(pixels, 0, 0);

  const type = source.type === 'image/jpeg' ? 'image/jpeg' : 'image/png';
  const blob = await toBlob(canvas, type, JPEG_QUALITY);
  return { url: URL.createObjectURL(blob), blob, owned: true };
}
