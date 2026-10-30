# Wikipedia image box maker

Make an image and a caption look like a screenshot of a Wikipedia image box.

[Use it in your browser](https://vinevard.github.io/wikipedia-image-box-maker/).

| Wikipedia | Image box maker |
| :---: | :---: |
| <img src="compare/well-wikipedia.png" width="268" alt="Screenshot of a real Wikipedia image box"> | <img src="compare/well-tool.png" width="268" alt="The same image box from this tool"> |

The left image is a screenshot of the [Well](https://en.wikipedia.org/wiki/Well) article. The right image is from
this tool, with the same photo and caption.

<img src="screenshot.png" width="720" alt="The settings and the live preview of the image box maker">

## Settings

| Setting | Options |
| --- | --- |
| Caption | Text with links, italic and bold. Refer to [Caption markup](#caption-markup). |
| Site | Desktop, or mobile at a phone width that you select |
| Image width | 50px to 600px. The Wikipedia default is 250px. |
| Text size | Small, Standard or Large, as in the Wikipedia Appearance menu |
| Theme | Light or Dark. The Dark theme makes the photo darker, as on Wikipedia. |
| Direction | Left-to-right, or right-to-left as in the Hebrew, Arabic and Persian Wikipedias |
| Enlarge icon | On or off |
| White space | Off, a value for each side, or random values. The default is 10px plus or minus 50%. The top usually gets less space than the bottom. |
| Download size | 1x, 2x or 3x. The result does not change with the pixel density of your screen. |
| Text smoothing | Grayscale, or sub-pixel as in Windows screenshots. The default is sub-pixel if your browser can make sub-pixel text. |

To load an image, choose a file, drop a file, or paste an image. You can also drag an image from a Wikipedia page.
Then the tool uses the original file from Wikimedia, not the smaller copy on the page. Most other sites do not let the
tool read their images. For these images, save the image first.

Transparent areas of an image show white, as on Wikipedia.

The browser keeps the settings and the caption for your next visit. It does not keep the image. To go back to the
default settings, click "Reset settings". The caption does not change.

### Caption markup

| Markup | Result |
| --- | --- |
| `[[Utajärvi]]` | A link with the text "Utajärvi" |
| `[[Point Danger Light\|Point Danger lighthouse]]` | A link with the text "Point Danger lighthouse" |
| `''italic''` | *italic* |
| `'''bold'''` | **bold** |

You can put markup in markup, for example `''[[Haymakers (painting)|Haymakers]]''`.

## Comparisons

In each pair, the left image is a 2x screenshot of a figure on Wikipedia. The right image is a 2x download from this
tool. The two images use the same original file, caption and settings. `tools/verify/compare.py` makes all of these
images.

<table>
<tr><th>Wikipedia</th><th>Image box maker</th></tr>
<tr><td><img src="compare/barn-raising-wikipedia.png" width="322" alt="Wikipedia: barn raising"></td><td><img src="compare/barn-raising-tool.png" width="322" alt="Tool: barn raising"></td></tr>
<tr><td colspan="2">A 300px figure. The original is smaller than the 2x thumbnail, thus the two images use the original.</td></tr>
<tr><td><img src="compare/lighthouse-wikipedia.png" width="174" alt="Wikipedia: Point Danger lighthouse"></td><td><img src="compare/lighthouse-tool.png" width="174" alt="Tool: Point Danger lighthouse"></td></tr>
<tr><td colspan="2">A tall image at 150px</td></tr>
<tr><td><img src="compare/cornell-box-wikipedia.png" width="321" alt="Wikipedia: Cornell box"></td><td><img src="compare/cornell-box-tool.png" width="321" alt="Tool: Cornell box"></td></tr>
<tr><td colspan="2">A square image from an animated GIF. The tool uses the first frame.</td></tr>
<tr><td><img src="compare/haymakers-wikipedia.png" width="268" alt="Wikipedia: Haymakers by George Stubbs"></td><td><img src="compare/haymakers-tool.png" width="268" alt="Tool: Haymakers by George Stubbs"></td></tr>
<tr><td colspan="2">Standard text size, and an italic link</td></tr>
<tr><td><img src="compare/carnegie-library-wikipedia.png" width="272" alt="Wikipedia: Carnegie library in Pittsburgh"></td><td><img src="compare/carnegie-library-tool.png" width="272" alt="Tool: Carnegie library in Pittsburgh"></td></tr>
<tr><td colspan="2">Large text size, and a caption with three lines</td></tr>
<tr><td><img src="compare/rooftop-farm-wikipedia.png" width="272" alt="Wikipedia: rooftop farm, Dark theme"></td><td><img src="compare/rooftop-farm-tool.png" width="272" alt="Tool: rooftop farm, Dark theme"></td></tr>
<tr><td colspan="2">Dark theme</td></tr>
<tr><td><img src="compare/allotment-wikipedia.png" width="262" alt="Wikipedia mobile site: allotment garden"></td><td><img src="compare/allotment-tool.png" width="262" alt="Tool: allotment garden, mobile site"></td></tr>
<tr><td colspan="2">The mobile site on a 390px phone</td></tr>
<tr><td><img src="compare/community-garden-he-wikipedia.png" width="270" alt="Hebrew Wikipedia: community garden"></td><td><img src="compare/community-garden-he-tool.png" width="270" alt="Tool: community garden, right-to-left"></td></tr>
<tr><td colspan="2">Right-to-left, from the Hebrew Wikipedia</td></tr>
</table>

## How it works

- The preview is HTML and CSS with the dimensions of the Wikipedia thumbnail. On desktop, these are from the Vector
  2022 skin. On mobile, they are from the Minerva skin.
- The export reads the layout of the preview from the browser: the box edges, the image position and the position of
  each word. Then it draws these items on a canvas.
- For a 2x or 3x download, the tool makes a hidden copy of the preview at that pixel density. Thus the result is the
  same as a screenshot from a high-density screen.
- Wikipedia does not show the original image file. Its thumbnail server makes a 1x file and a 2x file at fixed
  widths. This tool makes the two files with the same procedure: a Lanczos3 resize, an unsharp mask, and JPEG
  encoding at quality 87. It does not make a file larger than the original.

### Accuracy

The results compare the nine pairs above with the live Wikipedia figures.

| Item | Result |
| --- | --- |
| Box size | Identical in all nine pairs |
| Frame and caption | A maximum of 0.21% of pixels are different. In five pairs, a maximum of one pixel is different. |
| Frame and caption of the preview at 1x | Identical in Chrome and Firefox |
| Photo | Small differences on fine edges. You cannot see them at normal size. |

## Notes for engineers

The tool must copy some unusual browser and server behaviour. [ENGINEERING.md](ENGINEERING.md) gives the full list,
the measurements and the open problems. Some examples:

- The MediaWiki enlarge icon has an 11×15 drawing area, but Wikipedia shows it at 15×11. This distortion gives the
  icon its shape.
- CSS `zoom` multiplies with `devicePixelRatio`. A hidden copy with `zoom: 2 / devicePixelRatio` has the same layout
  as on a 2x screen. Thus a 1x screen can make an exact 2x download.
- The Wikipedia thumbnail server rounds a height of x.5 down. The `height` attribute in the page rounds it up. With
  `height: auto`, this half pixel sets the height of the box.
- Chrome can show a cached 2x `srcset` file on a 1x screen. This occurs when the page loaded the same URL before.
- Canvas text gets coloured sub-pixel anti-aliasing only on an opaque canvas.

## Limitations

- The photo is not bit-identical to the Wikipedia thumbnail. The difference is largest in the 1x files of large
  photos. Refer to [Open problems](ENGINEERING.md#open-problems).
- The box uses the sans-serif font of your system, as Wikipedia does. Thus a download from Windows looks like a
  Windows screenshot.
- A photo of 12 megapixels or more takes approximately one second to process.

## Changes to the box

Run `python tools/verify/compare.py` before and after you change the box. Make sure that no result becomes worse.

## Credits

The example images in `docs/` are not part of the MIT license. Each image is from Wikimedia Commons, and is in the
public domain or has the CC0 license. The captions are from the Wikipedia articles in the table, under
[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).

| Image | Author | License | Article |
| --- | --- | --- | --- |
| [Old-fashioned well in Finland](https://commons.wikimedia.org/wiki/File:Old-fashioned_well_in_Finland.JPG) | SeppVei | Public domain | [Well](https://en.wikipedia.org/wiki/Well) |
| [Barn raising, DeKalb County](https://commons.wikimedia.org/wiki/File:Barn_Raising_DeKalb_County_IN.jpg) | J.E. Curtis | Public domain | [Barn raising](https://en.wikipedia.org/wiki/Barn_raising) |
| [Point Danger lighthouse](https://commons.wikimedia.org/wiki/File:Point_Danger_lighthouse.jpg) | Eertman at Dutch Wikipedia | Public domain | [Lighthouse](https://en.wikipedia.org/wiki/Lighthouse) |
| [Cornell box, with and without radiosity](https://commons.wikimedia.org/wiki/File:BMRT_-_Cornell_box,_with_and_without_radiosity.gif) | Morn | CC0 | [Radiosity (computer graphics)](https://en.wikipedia.org/wiki/Radiosity_(computer_graphics)) |
| [Haymaking](https://commons.wikimedia.org/wiki/File:George_Stubbs_-_Haymaking_-_WGA21948.jpg) | George Stubbs | Public domain | [Hay](https://en.wikipedia.org/wiki/Hay) |
| [Carnegie Library, South Side branch](https://commons.wikimedia.org/wiki/File:Carnegie_Library_Pittsburgh_SSide_branch_early_days.jpg) | Unknown | Public domain | [Carnegie library](https://en.wikipedia.org/wiki/Carnegie_library) |
| [Farm above Atré Ebisu](https://commons.wikimedia.org/wiki/File:Farm_above_Atr%C3%A9_Ebisu.jpg) | Syced | CC0 | [Community gardening](https://en.wikipedia.org/wiki/Community_gardening) |
| [Kauswagan Allotment Garden](https://commons.wikimedia.org/wiki/File:Kauswagan_Allotment_Garden.JPG) | Rjholmer at English Wikipedia | Public domain | [Allotment (gardening)](https://en.wikipedia.org/wiki/Allotment_(gardening)) |
| [Herbal patch, Lippensgoed-Bulskampveld](https://commons.wikimedia.org/wiki/File:HerbalPatch_Lippensgoed_Bulskampveld.jpg) | KVDP | Public domain | [גינה קהילתית](https://he.wikipedia.org/wiki/גינה_קהילתית) (Hebrew Wikipedia) |

## License

MIT. Refer to [LICENSE](../LICENSE).

This project is not related to the Wikimedia Foundation. Wikipedia is a trademark of the Wikimedia Foundation.
