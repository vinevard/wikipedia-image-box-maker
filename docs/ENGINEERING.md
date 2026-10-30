# Engineering

Technical reference for the Wikipedia image box maker. The README covers usage; this document covers how the output
is produced, the browser and server behaviour it depends on, how it is verified, and what is still wrong.

## Overview

The tool produces a PNG that should be indistinguishable from a screenshot of a Wikipedia image box taken on the
user's own machine. Both the desktop skin (Vector 2022) and the mobile skin (Minerva) are supported, in the Light and
Night themes, at the three text sizes of the Appearance menu, and in left-to-right and right-to-left wikis.

"Indistinguishable" is measured, not judged by eye. A comparison script screenshots real figures on live Wikipedia
and diffs them against the tool's output (see [Comparison with Wikipedia](#comparison-with-wikipedia)). Every
technique below was adopted because it removed a measured difference.

Constraints:

- Static files only. No build step and no server-side code. The page also works from `file://`.
- No dependencies. The thumbnail pipeline, caption parser and canvas renderer are written for this project.
- No MediaWiki code is copied, because MediaWiki is GPL and this project is MIT. CSS is rewritten with its own
  selectors, and the enlarge icon is a new drawing.

## Architecture

`style.css` reimplements the Vector 2022 and Minerva thumbnail CSS, `thumbnail.js` holds the resize, sharpen and
encode pipeline, and `app.js` holds everything else: state, input, the thumbnail cache, preview rendering, export and
settings persistence.

Data flow:

1. An image arrives from the file picker, a drop, a paste or a dropped URL. It is decoded with an `<img>` and its
   pixels are read once into an `ImageData`.
2. For the current display width, `app.js` selects the 1x and 2x file widths that Wikipedia would serve
   ([File widths](#file-widths)). Each file is produced by `thumbnail.js` in a worker and cached by width. A width
   change aborts work for files that are no longer needed.
3. The preview is an `<img>` with `src` and `srcset` set to those files, inside markup that matches Wikipedia's
   `figure` structure.
4. On export, a hidden copy of the preview is laid out at the download scale. The renderer reads its geometry and
   paints frame, photo, caption and icon onto a canvas, which is encoded as PNG for download or the clipboard.

## Preview

Desktop markup is a `figure` with `display: table` and a `figcaption` with `display: table-caption;
caption-side: bottom`. The figure draws the top and side borders and the caption draws the side and bottom borders,
which is how Vector produces one continuous frame. `.page` stands in for the article body and restores `content-box`
sizing, because the table layout is sized from it.

The image has `max-width: calc(100% - 8px)`, which copies Wikipedia's responsive rule. At fractional browser zoom
levels such as 157.5%, borders round down to one device pixel, the inner width of the frame becomes smaller than the
image, and this rule shrinks the image the same way Wikipedia does.

Minerva drops the frame and icon, uses a 13px grey caption, and limits the image to the phone's content width
(`phoneWidth - 2 × 16px`).

On viewports 760px wide or narrower, the preview is scaled with CSS `zoom` to fit the screen, and a tap toggles full
size. This zoom never reaches the export. The export builds its own copy and reads the caption font size with the
preview zoom removed ([Pixel density](#pixel-density)).

## Thumbnail pipeline

Wikipedia never serves the original file in an article. The page references a 1x and a 2x thumbnail in `srcset`, and
a screenshot shows whichever of those the browser chose. The tool regenerates those files from the original.

### File widths

Thumbnails exist only at fixed widths: 20, 40, 60, 120, 250, 330, 500, 960, 1280, 1920 and 3840px. The browser scales
the chosen file to the figure width.

- The 1x file is the smallest fixed width at least as wide as the figure.
- The 2x file is the smallest fixed width at least twice the figure width.
- If the original is narrower than the selected width, the original is used. Nothing is upscaled.

A 300px figure therefore loads a 330px file, and a 150px figure loads 250px and 330px files. These rules were derived
from about 1,400 figures in saved article pages.

### File heights

The page rounds the `height` attribute to the nearest integer, while the thumbnail server rounds an exact x.5 height
down. A 2272×1704 photo at 250px gets `height="188"` in the HTML and a 250×187 file. Because the image style is
`height: auto`, the loaded file's height wins, and that half pixel moves the caption by one device pixel. A
three-line caption that was one pixel off exposed this.

### Resize and sharpen

A grid search over resampling filters and sharpening parameters, scored against Wikipedia's thumbnails of the same
originals, selected:

- Lanczos3 in sRGB (not linear light), on premultiplied alpha so transparent pixels do not bleed into edges.
- An unsharp mask with sigma 1.0 and amount 0.7.

Together with the encoding below, this reduced the mean squared error from 82 to 46. Very large sources are first box
reduced by an integer factor, keeping the intermediate at least 6× the target width. This is much faster and matched
Wikipedia as well as or better than a single Lanczos pass.

### Encoding

The quantization tables of Wikipedia's JPEG thumbnails match quality 87 with 4:2:0 chroma subsampling. JPEG originals
are encoded with `canvas.toBlob('image/jpeg', 0.87)`, and other formats produce PNG thumbnails. The quality value is
mapped to quantization tables by the browser's encoder, and the tables that Safari produces have not been checked.

### Worker

Chrome refuses to start a worker from a script file on `file://`. The worker source is therefore built at runtime
from `thumbnail.js`'s own functions with `String()` and loaded from a Blob URL. Those functions must be
self-contained. A missing helper shows up as a console error and a fallback to the main thread.

## Export

### Layout source

html2canvas and SVG `foreignObject` both re-lay out text with their own engines, which is close to the browser's
layout but not identical. The export uses the browser's own layout instead:

- Box edges and the image rectangle come from `getBoundingClientRect()`.
- Each word's position comes from `Range.getClientRects()`, so line breaks, kerning and bidirectional reordering are
  the browser's. A word with more than one rectangle, split by a line break or a direction change, is drawn character
  by character.
- The enlarge icon's size, position and filter come from `getComputedStyle(link, '::after')`.

Canvas runs its own bidi algorithm on each `fillText` call, so `ctx.direction` is set from the text's element. Without
this, punctuation in a Hebrew caption lands at the wrong end of the word.

The export depends on standardized CSS `zoom` semantics, where rects inside a zoomed element are reported in zoomed
coordinates. This is the behaviour in Chrome 128+, Firefox 126+ and WebKit (verified in WebKit 27.2). Browsers
without `zoom` support are limited to 1x downloads.

### Pixel density

A 2x download must match a screenshot from a 2x screen, which an upscaled 1x layout does not. Font hinting differs by
size, borders snap to device pixels, and line breaks can move.

The export clones the preview, sets `zoom` on the clone equal to the download scale, and reads its layout. Dividing
the rects by the zoom gives CSS-pixel geometry that is then painted at the scale. On a 1x screen, `zoom: 2` produces
exactly the layout of a 2x screen, and the comparisons with Wikipedia run in this configuration.

The zoom has to be an integer. `zoom = scale / devicePixelRatio` also yields the target device-pixel ratio, but on
most screens it is fractional or below 1, and border widths are then rounded differently. At zoom 0.667, for example,
Chrome reports a 1px border as 1.5px, and a 2x download from a 3x phone comes out 4px wider and taller than one from
a 1x screen. With `zoom = scale`, measured on Windows:

| Engine | Pixel ratios with byte-identical downloads (1x, 2x and 3x) |
| --- | --- |
| Chrome 156 | 1, 1.25, 1.5, 1.6, 2, 2.625, 3 |
| Firefox 157 | 1, 1.25, 1.5, 1.6, 2, 2.625, 3 |
| WebKit 27.2 | 1 and 2. At 3, only the 2x download. |

The remaining WebKit cases are 1 to 4px smaller than the 1x reference. Fractional ratios come from OS display
scaling and browser zoom. On Linux, caption pixels differ between pixel ratios while the frame, photo, icon and
overall size do not, which is consistent with glyphs being snapped to the device-pixel grid.

Firefox rounds the caption's `88.4%` font size after applying `zoom`, whereas a denser screen rounds it before. The
clone therefore takes the computed font size from the preview, with the preview's own fit-to-screen zoom
temporarily removed.

### Drawing

- The frame is drawn in whole device pixels, so it stays sharp when the caption height is fractional.
- The photo is drawn from the 1x file for a 1x download and from the 2x file otherwise, as a browser's `srcset`
  choice would be.
- The Night theme sets photos to 80% brightness and inverts the icon. Safari supports canvas `filter` only behind a
  flag, so both filters are applied to the pixel data directly.
- The canvas is opaque when sub-pixel text is selected and transparent for grayscale text
  ([Text smoothing](#text-smoothing)), and is filled with the page background in both cases.

### Browser workarounds

- Chrome: if the export loads the 2x file under the preview's URL, Chrome shows the cached 2x file in the preview,
  also on a 1x screen, which a real visitor's browser would not. The export decodes its file through a separate
  object URL.
- Firefox: `img.decode()` rejects for an image that ever had a `srcset` attribute, even after removal. The export
  uses a new `<img>`.
- Clipboard: some browsers accept only resolved data in a `ClipboardItem` and write the literal text
  `[object Promise]` when given a promise. A startup probe detects this. Elsewhere the item gets a promise, which
  keeps the write inside the click's user activation even when the export is slow.

### Enlarge icon

MediaWiki draws the icon in an 11×15 viewBox and displays it at 15×11. The distortion narrows the icon and clips part
of one box. Freehand redrawings never matched until this was understood. The replacement drawing uses fractional
coordinates that reproduce the same result. It matched pixel for pixel only once its boxes were paths rather than
`<rect>` elements. The right-to-left variant matched only once each box started from the mirrored corner and ran in
the mirrored direction.

### Output

The PNG is not tagged with a colour profile. Wide-gamut sources are converted to sRGB by the canvas. File names are
derived from the caption, NFC-normalized, keep letters from any script, and are cut at a word boundary within 60
code points.

## Text smoothing

Canvas text gets coloured sub-pixel anti-aliasing only on an opaque canvas. A page cannot read the pixels of its own
text, so a canvas probe stands in for the page. At startup the tool draws a sample caption on an opaque canvas with
the box's font, size and colours. It counts pixels whose colour channels differ by more than 24 levels. Sub-pixel
text produces differences of 150 levels or more, while grey text such as `#202122` produces 1 or 2. Ten or more such
pixels make sub-pixel the default. With none, the setting is hidden, because the export could not produce it.

Measured agreement between the probe and real page text:

| Environment | Canvas | Page |
| --- | --- | --- |
| Chrome, Windows, ClearType on, at 1x, 1.5x and 2x | Sub-pixel | Sub-pixel |
| Firefox headless, Windows | Sub-pixel | Grayscale |

A headed Firefox window, Windows with ClearType off, macOS and mobile have not been measured.

## Platform support

The box intentionally uses the platform's `sans-serif` font, its text smoothing and its image decoder, so that a
download looks like a screenshot from that machine. Arial on Windows and Helvetica on macOS are both correct results.

Other platform handling:

- Touch screens (`(hover: none) and (pointer: coarse)`) get tap instructions instead of drop and paste instructions.
- macOS shows ⌘V instead of Ctrl+V.
- `.shot` sets `forced-color-adjust: none` and `text-size-adjust: 100%`, so Windows contrast themes and mobile text
  inflation cannot change the colours and font sizes that the export reads.
- Minimum versions come from CSS `zoom` (Firefox 126), `float: inline-end` (Chrome 118) and `Array.prototype.findLast`
  (Safari 15.4).

Not verified on a device: Safari on macOS and iOS, and Android. Expected risks there are iOS canvas size and memory
limits for large photos, Safari's JPEG encoder, and `<a download>` behaviour on iOS.

## Settings

Settings and the caption are stored in `localStorage` under `wikipedia-image-box-maker-settings`. Only values that
differ from the form defaults are stored, with `version: 2`, so that a changed default reaches users who never set
that value. Version 1 stored every value. On load, a version 1 record has its `smoothing` value dropped, because the
default for that setting changed after version 1. Unknown values fall back to the defaults, and all storage access is
wrapped so that blocked storage only disables persistence.

Only user input events save. Values set from script are not saved, which keeps `tools/verify/hook.js` from leaving
state behind between comparison runs. Any new control that sets values programmatically must call `saveSettings()`.

## Verification

### Comparison with Wikipedia

`tools/verify/compare.py` runs the figures listed in `cases.json`:

1. Download the article and the original file from Commons.
2. Strip the article down to the figure, set text size and theme through the Appearance menu classes, and take a 2x
   screenshot in headless Chrome. A page whose Wikipedia stylesheet failed to load is treated as an error and
   retried.
3. Load the tool with the same original, caption, width and settings, and take a 2x download from a 1x page.
4. Crop both to the box and diff. Frame and caption pixels are counted separately from photo pixels.
5. Compare the tool's 1x and 2x thumbnail files with Wikipedia's.

The nine figures cover 150px, 250px and 300px boxes, an animated GIF, all three text sizes, the Night theme, the
mobile skin and a right-to-left wiki.

`--check` re-downloads the articles and exits non-zero if any figure fails one of these thresholds:

| Check | Fails when |
| --- | --- |
| Box size | Any dimension differs |
| Frame and caption | More than 1% of pixels differ by more than 40 levels |
| Photo | MSE above 1000. Not applied to animated images, whose captured frame is not deterministic. |

The "Wikipedia check" workflow runs `--check` weekly on `windows-latest` and uploads the image pairs as the
`comparison` artifact. It does not run on Linux, where text rasterization differs by 3 to 5% of frame and caption
pixels on every figure while photo results are identical.

### Accuracy

Results for the nine figures, 2x screenshot against 2x download from a 1x page:

| Item | Result |
| --- | --- |
| Box size | Identical in all nine figures |
| Frame and caption | At most 0.21% of pixels differ by more than 40 levels. Four figures have no such pixel, one has one. |
| Photo | MSE 0 to 23 in seven figures. 340 and 479 in the other two, almost entirely on fine edges. |

The remaining frame and caption differences are glyph-edge anti-aliasing. At 1x, the live preview's frame and caption
are identical to a real figure in Chrome and Firefox.

### Browser tests

`tools/test/ui.test.mjs` drives the page in headless Chrome over the DevTools protocol with real mouse, touch,
keyboard and drag events. It needs no network. It covers input handling, file naming, settings persistence and
migration, the width controls, preview fitting and sticky positioning, contrast themes, and pixel-ratio
independence of downloads. The pixel-ratio test compares exact pixels for downloads without a caption, but only
dimensions for downloads with a caption, because of the Linux glyph positioning described above.

## Deployment

GitHub Pages is deployed by the "Test and deploy" workflow on each push to `main`:

1. The `test` job runs the browser tests on `ubuntu-latest`. A failure stops the deploy. Pull requests run this job
   only.
2. The `deploy` job copies the published files into `_site` and replaces each `?v=` query in `index.html` with the
   first 10 hex digits of that file's SHA-256.

Pages sends `Cache-Control: max-age=600`, so without these query strings a new `index.html` could run against a
cached script from the previous deploy. The repository copy of `index.html` uses `?v=dev`. A test checks that every
local file referenced by `index.html` is in the deploy step's copy list.

## Known issues

### 1x thumbnails of large reductions

At a reduction of about 4.5×, such as the 500px file of a 2272px photo, the tool's files are close to Wikipedia's. At
about 9×, such as the 250px file of the same photo, they are not, and a plain Lanczos3 resize shows the same gap.
Wikipedia's pipeline has a step the tool does not reproduce. A likely candidate is libvips shrinking JPEGs in the DCT
domain during decode, before resampling. The default download is 2x and uses the 2x file, so this mainly affects 1x
downloads and the preview on 1x screens.

### Sharpness

The tool's photos have 5 to 10% less edge energy than Wikipedia's. Blurring both images removes almost all of the
difference, which points at sharpening strength rather than geometry. The sharpening parameters were fitted on two
photos only. The nine originals cached in `tools/verify/out/cache/` would be a better tuning set.

### Other

- WebKit downloads at fractional pixel ratios are 1 to 4px smaller than the reference ([Pixel density](#pixel-density)).
- The sub-pixel probe is a proxy and has only been validated in Chrome on Windows ([Text smoothing](#text-smoothing)).
- The weekly comparison is only valid on Windows.

## Development

Requirements: Node 22+ and Chrome for the tests, plus Python 3.9+ with Pillow for the comparisons. Set `CHROME` if
Chrome is not in a standard location.

```
node --test tools/test/ui.test.mjs           browser tests
python tools/verify/compare.py               compare all figures with live Wikipedia
python tools/verify/compare.py well haymakers  compare some figures
python tools/verify/compare.py --check       re-download the articles and fail on a mismatch
python tools/verify/compare.py --docs        also copy the image pairs into docs/compare/
```

The comparison caches downloads in `tools/verify/out/cache/`, waits 4 seconds between requests to Wikipedia, and
writes `tools/verify/out/report.json` plus each image pair and the tool's thumbnail files to `tools/verify/out/`.

Run the comparison before and after any change to the box, and check that no result gets worse.
