# Engineering notes

The goal of this project is a PNG that people cannot tell from a real screenshot of a Wikipedia image box. To get
this result, the project compares each change with live Wikipedia, pixel by pixel. These notes give the browser and
server behaviour that the comparisons found.

## Comparison procedure

`tools/verify/compare.py` uses a list of real figures from real articles (`cases.json`). For each figure, the script
does these steps:

1. It downloads the article, and the original image file from Wikimedia Commons.
2. It removes all of the article except the figure. It sets the text size and the theme with the classes that the
   Wikipedia Appearance menu uses. Then it makes a 2x screenshot in headless Chrome.
3. It opens the tool with the same original file, caption, width and settings. It makes a 2x download from a 1x
   page.
4. It crops the two images to the box and compares them. It counts the frame and caption pixels separately from the
   photo pixels.
5. It compares the 1x and 2x thumbnail files of the tool with the files from Wikipedia.

The figures include the default 250px box, a 150px box and a 300px box. They also include an animated GIF, the three
text sizes, the Dark theme, the mobile site and a right-to-left Wikipedia. To do the comparison yourself, refer to
[Run the comparisons](#run-the-comparisons).

## Export

Libraries such as html2canvas rasterize the DOM with their own text layout. SVG `foreignObject` has the same
problem. Their text layout is near to the layout of the browser, but it is not the same. Thus this tool uses the
layout from the browser.

The preview is HTML and CSS. The export reads the layout of the preview and draws it on a canvas:

- The box edges and the image rectangle come from `getBoundingClientRect()`.
- The position of each word comes from `Range.getClientRects()`. Thus line breaks, kerning and bidirectional text
  come from the browser.
- The size, position and filter of the enlarge icon come from `getComputedStyle(link, '::after')`.

If a word has more than one rectangle, a line break or a change of text direction divides the word. The tool then
draws each character of the word separately.

Canvas applies its own bidirectional algorithm to each string. Thus the tool sets `ctx.direction` from the element
of the text. Without this step, punctuation in a Hebrew caption moves to the wrong end of the word.

## A 2x download from a 1x screen

A 2x download must look like a screenshot from a 2x screen. A 1x layout that is scaled up is different. Fonts have
different hinting at different sizes. Borders align to device pixels. Line breaks can move.

The export makes a hidden copy of the preview with CSS `zoom = scale / devicePixelRatio`. Chrome multiplies `zoom`
and the device pixel ratio into one layout factor. Thus, on a 1x screen, a zoom of 2 gives the same layout and pixel
alignment as a 2x screen. The result is identical to an export from a real 2x screen.

Firefox rounds the `88.4%` font size of the caption after it applies the zoom. A screen with a higher pixel density
rounds the font size before. Thus the copy uses the rounded font size of the preview.

## Thumbnails

Wikipedia does not show the original file. Its thumbnail server makes smaller copies, and the page gives a 1x file
and a 2x file in `srcset`. A real screenshot shows these files. Thus the tool makes the same files.

### Encoding

The quantization tables of the Wikipedia thumbnails agree with JPEG quality 87 and 4:2:0 chroma subsampling.

### Resize

A grid search compared resampling filters and sharpening values with the Wikipedia thumbnails of the same originals.
The best result is Lanczos3 in sRGB (not in linear light), then an unsharp mask with sigma 1.0 and amount 0.7. With
the JPEG encoding, this procedure decreased the mean squared error from 82 to 46.

### File widths

Thumbnails are available only at fixed widths: 20, 40, 60, 120, 250, 330, 500, 960, 1280, 1920 and 3840px. The
browser scales the file to the width of the figure.

- The 1x file is the smallest fixed width that is equal to or larger than the figure width.
- The 2x file is the smallest fixed width that is equal to or larger than two times the figure width.
- If the original is narrower than the selected width, the page uses the original.

Thus a 300px figure loads a 330px file, and a 150px figure loads a 250px file and a 330px file. This rule comes from
approximately 1,400 figures in saved article pages.

### File heights

The page rounds the height in the `height` attribute to the nearest integer. The thumbnail server rounds a height of
exactly x.5 down. Thus a 2272×1704 photo at 250px gets `height="188"` in the HTML and a 250×187 file.

The style of the image is `height: auto`. Thus the browser uses the size of the loaded file, and the half pixel
changes the box height by one device pixel. A one-pixel difference in a box with a three-line caption showed this
rule.

### Worker

The resize runs in a Web Worker. Chrome does not start a worker from a script file on `file://`, and the tool must
work when you open `index.html` from a disk. Thus the tool makes the source of the worker from its own functions
with `String()`, and loads it from a Blob URL.

## Details that each changed a pixel

### Enlarge icon

MediaWiki draws the icon on an 11×15 area and shows it at 15×11. This distortion makes the icon narrower and cuts
off a part of one box. Drawings by eye did not agree until this cause was known.

MediaWiki has the GPL license and this project has the MIT license. Thus the icon in this tool is a new drawing. Its
fractional coordinates give the same distorted result. It agreed pixel for pixel only when its boxes were paths
instead of `<rect>` elements. The right-to-left icon agreed only when each box started from the mirrored corner and
went in the mirrored direction.

### Fractional zoom

At zoom levels such as 157.5%, borders round down to one device pixel. Thus the inner area of the frame becomes
narrower than the image. The Wikipedia `max-width` rule then makes the image a little smaller. The tool uses the same
rule, so the box agrees at all zoom levels.

### Cache for srcset files

If the export loads the 2x file with the URL of the preview, Chrome shows the cached 2x file in the preview. Chrome
does this also on a 1x screen. The browser of a real visitor does not show the 2x file. Thus the export decodes its
file through a different object URL.

### Image decode in Firefox

Firefox rejects `img.decode()` for an image that had a `srcset` attribute before, also after the attribute is
removed. Thus the export uses a new `<img>`.

### Sub-pixel text

Canvas text gets coloured sub-pixel anti-aliasing only on an opaque canvas. The "Sub-pixel" setting selects this
mode. The tool hides the setting in browsers that do not make sub-pixel text.

### Dark theme

The Wikipedia Night theme sets photos to 80% brightness and inverts the icon. Safari supports canvas filters only
with a flag. Thus the export applies the two filters to the pixels directly.

### Clipboard

Some browsers accept only finished data in a `ClipboardItem`. If such a browser gets a promise, it writes the text
"[object Promise]". The tool does a test for this at startup. In other browsers, the tool gives a promise. Thus the
clipboard write stays in the user activation of the click, also when the export is slow.

## Accuracy

The table gives the results for the nine figures in `cases.json`. Each result compares a 2x screenshot of the live
figure with a 2x download from the tool on a 1x page.

| Item | Result |
| --- | --- |
| Box size | Identical in all nine figures |
| Frame and caption | A maximum of 0.21% of pixels have a difference of more than 40 levels out of 255. In four figures, no pixel has this difference. In one figure, one pixel has it. |
| Photo | Mean squared error from 0 to 23 in seven figures. Errors of 340 and 479 in the other two figures, almost all on fine edges. |

The remaining frame and caption differences are in the anti-aliasing of the edges of some glyphs. At 1x, the frame
and caption of the live preview are identical to a real figure in Chrome and in Firefox.

## Open problems

### 1x thumbnails

For a reduction of approximately 4.5 times, the files from the tool are near to the Wikipedia files. An example is
the 500px file of a 2272px photo. For a reduction of approximately 9 times, the difference is large. An example is
the 250px file of the same photo. A standard Lanczos3 resize has the same difference. Thus the Wikipedia procedure
has a step that the tool does not copy.

A possible cause is libvips. Libvips can make a JPEG smaller during decoding, in the DCT domain, before it
resamples. The default 2x download uses the 2x file. Thus this problem has an effect mostly on 1x downloads, and on
the preview on 1x screens.

### Sharpness

The photos from the tool have 5 to 10% less edge energy than the Wikipedia photos. When you blur the two images,
almost all of the difference goes away. Thus the cause is the sharpening strength, not the geometry. The sharpening
values come from two photos. The nine originals in `tools/verify/out/cache/` are a better set for a new tuning.

## Run the comparisons

You need:

- Python 3.9 or later, with Pillow
- Node 22 or later
- Chrome. If Chrome is not in a standard location, set the `CHROME` environment variable to its path.

```
python tools/verify/compare.py                 all figures
python tools/verify/compare.py well haymakers  some figures
python tools/verify/compare.py --docs          all figures, and copy the image pairs into docs/compare/
```

The script keeps its downloads in `tools/verify/out/cache/`. It waits 4 seconds between requests to Wikipedia. It
writes the results to `tools/verify/out/report.json`, and writes each pair of images and the thumbnail files of the
tool to the same folder.
