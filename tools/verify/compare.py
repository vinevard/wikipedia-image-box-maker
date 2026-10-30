"""Compare the tool against live Wikipedia, figure by figure.

For each case in cases.json this fetches the article and the original image, screenshots the real figure at 2x in
headless Chrome, makes the same figure with the tool (a 2x download from a 1x page), and diffs the two.

    python tools/verify/compare.py               all cases
    python tools/verify/compare.py well haymakers some of them
    python tools/verify/compare.py --docs        also copy the pairs into docs/compare/
    python tools/verify/compare.py --check       fetch the articles again, and fail if a figure no longer matches

Needs Python 3.9+ with Pillow, Node 22+ and Chrome. Downloads are cached in tools/verify/out/cache/.
"""
import html
import json
import os
import random
import re
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

from PIL import Image, ImageChops

import serve

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
OUT = os.path.join(HERE, "out")
CACHE = os.path.join(OUT, "cache")
PORT = 8800
BASE = f"http://127.0.0.1:{PORT}"

USER_AGENT = "wikipedia-image-box-maker-verify/1.0 (https://github.com/vinevard/wikipedia-image-box-maker)"
MOBILE_USER_AGENT = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36 " + USER_AGENT
REQUEST_GAP = 4
PHONE_WIDTH = 390
BACKGROUND = {"day": (255, 255, 255), "night": (16, 20, 24)}
FONT_SIZE_CLASS = {14: 0, 16: 1, 20: 2}
NOTICEABLE = 40
# --check fails above these. The worst figures are at 0.21% and 480, so a change in how Wikipedia draws the box
# shows up here, and the normal differences in anti-aliasing and sharpening do not.
CHECK_FRAME_CAPTION_PERCENT = 1.0
CHECK_PHOTO_MSE = 1000

last_request = 0.0


def fetch(url, mobile=False):
    global last_request
    for _ in range(4):
        time.sleep(max(0.0, last_request + REQUEST_GAP - time.time()))
        last_request = time.time()
        request = urllib.request.Request(url, headers={"User-Agent": MOBILE_USER_AGENT if mobile else USER_AGENT})
        try:
            return urllib.request.urlopen(request, timeout=60).read()
        except urllib.error.HTTPError as error:
            if error.code != 429:
                raise
            time.sleep(60)
    raise RuntimeError(f"still rate limited: {url}")


def cached(name, url, mobile=False):
    path = os.path.join(CACHE, name)
    if not os.path.exists(path):
        data = fetch(url, mobile)
        with open(path, "wb") as f:
            f.write(data)
    return path


def article_url(case):
    host = "en.m.wikipedia.org" if case.get("site") == "mobile" else f"{case['wiki']}.wikipedia.org"
    return f"https://{host}/wiki/{urllib.parse.quote(case['article'])}"


def caption_markup(caption_html):
    """Turns a figcaption's HTML into the tool's [[link]] / ''italic'' / '''bold''' markup."""
    def link(match):
        title = re.search(r'title="([^"]*)"', match.group(1))
        text = html.unescape(re.sub(r"<[^>]+>", "", match.group(2)))
        title = html.unescape(title.group(1)) if title else text
        return f"[[{text}]]" if title == text else f"[[{title}|{text}]]"

    text = re.sub(r"<sup[^>]*>.*?</sup>", "", caption_html, flags=re.S)
    text = re.sub(r"<a\b([^>]*)>(.*?)</a>", link, text, flags=re.S)
    text = re.sub(r"<i\b[^>]*>(.*?)</i>", r"''\1''", text, flags=re.S)
    text = re.sub(r"<b\b[^>]*>(.*?)</b>", r"'''\1'''", text, flags=re.S)
    return html.unescape(re.sub(r"<[^>]+>", "", text)).strip()


def find_figure(page, file_name):
    for figure in re.findall(r"<figure[^>]*>.*?</figure>", page, re.S):
        if "mw:File/Thumb" in figure and ":" + file_name in urllib.parse.unquote(html.unescape(figure)):
            return figure
    raise LookupError(f"no thumbnail figure for {file_name}")


def figure_details(figure):
    img = re.search(r"<img[^>]*>", figure).group(0)
    srcset = re.search(r'srcset="([^"]*)"', img)
    return {
        "width": int(re.search(r'\swidth="(\d+)"', img).group(1)),
        "caption": caption_markup(re.search(r"<figcaption[^>]*>(.*?)</figcaption>", figure, re.S).group(1)),
        "src": "https:" + html.unescape(re.search(r'\ssrc="([^"]*)"', img).group(1)),
        "src2x": "https:" + html.unescape(srcset.group(1).rsplit(" ", 1)[0]) if srcset else None,
    }


def commons_info(file_name):
    query = urllib.parse.urlencode({"action": "query", "format": "json", "prop": "imageinfo", "titles": "File:" + file_name,
                                    "iiprop": "url|size|extmetadata", "iiextmetadatafilter": "LicenseShortName|Artist"})
    page = next(iter(json.loads(fetch("https://commons.wikimedia.org/w/api.php?" + query))["query"]["pages"].values()))
    info = page["imageinfo"][0]
    meta = info["extmetadata"]
    artist = re.sub(r"<[^>]+>", "", meta.get("Artist", {}).get("value", ""))
    return {"url": info["url"], "page": info["descriptionurl"], "size": [info["width"], info["height"]],
            "license": meta.get("LicenseShortName", {}).get("value"),
            "artist": re.sub(r"\S+@\S+", "", artist).strip()}


def isolated_page(case, page):
    """Keeps only the chosen figure visible, in the requested text size and theme, and titles the page when settled."""
    theme = case.get("theme", "day")
    size = case.get("textSize", 14)
    host = re.match(r"https://[^/]+/", article_url(case)).group(0)
    page = page.replace("<head>", f'<head><base href="{host}">', 1)
    page = re.sub(r"vector-feature-custom-font-size-clientpref-\d", f"vector-feature-custom-font-size-clientpref-{FONT_SIZE_CLASS[size]}", page)
    page = page.replace("skin-theme-clientpref-day", f"skin-theme-clientpref-{theme}")
    # Mobile pages start with their sections collapsed, which hides most figures.
    page = page.replace("mf-expand-sections-clientpref-0", "mf-expand-sections-clientpref-1")
    page = page.replace('<script async="" src="/w/load.php', '<script data-disabled="" src="about:blank#')
    page = page.replace('loading="lazy"', 'loading="eager"')
    pin = "" if case.get("site") == "mobile" else "figure.style.cssText = 'float: none; margin: 0; position: fixed; left: 40px; top: 40px';"
    background = "#%02x%02x%02x" % BACKGROUND[theme]
    script = f"""<script>
addEventListener('load', () => {{
  // Wikipedia can refuse the stylesheet, for example to a busy shared server. The unstyled figure must not count as
  // a change to Wikipedia.
  if (!getComputedStyle(document.body).fontFamily.includes('sans-serif')) {{
    document.title = 'error: the Wikipedia stylesheet did not load';
    return;
  }}
  const figure = [...document.querySelectorAll('figure')].find(f => decodeURIComponent(f.innerHTML).includes({json.dumps(':' + case['file'])}));
  {pin}
  figure.classList.add('verify-keep');
  for (let el = figure.parentElement; el; el = el.parentElement) if (getComputedStyle(el).display === 'none') el.style.display = 'block';
  const style = document.createElement('style');
  style.textContent = 'body * {{ visibility: hidden !important; }} .verify-keep, .verify-keep * {{ visibility: visible !important; }} html, body {{ background: {background} !important; }}';
  document.head.append(style);
  figure.scrollIntoView({{ block: 'center' }});
  setTimeout(() => {{ document.title = 'ready'; }}, 1500 + Math.random() * 1500);
}});
</script></body>"""
    return page.replace("</body>", script, 1)


def phone_frame(src):
    return ("<!doctype html><html><head><meta charset='utf-8'><style>html, body { margin: 0; background: #fff; } "
            f"iframe {{ border: 0; display: block; width: {PHONE_WIDTH}px; height: 844px; }}</style></head><body>"
            f"<iframe src='{src}' onload=\"setTimeout(() => {{ const title = frames[0].document.title; "
            "document.title = title.startsWith('error') ? title : 'ready'; }, 2500)\"></iframe></body></html>")


def capture(url, out=None, dpr=2, width=800, height=900):
    command = ["node", os.path.join(HERE, "capture.mjs"), url, "--dpr", str(dpr), "--width", str(width), "--height", str(height)]
    if out:
        command += ["--out", out]
    subprocess.run(command, check=True, timeout=180)


def content_box(image, background):
    plain = Image.new("RGB", image.size, background)
    return ImageChops.difference(image, plain).convert("L").point(lambda v: 255 if v > 8 else 0).getbbox()


def screenshot_margins(rng):
    """The tool's default white space (top, right, bottom, left): 10px give or take 50%, less above than below."""
    def spread(side):
        skewed = 2 * rng.random() ** 2 - 1
        return skewed if side == "top" else -skewed if side == "bottom" else rng.uniform(-1, 1)
    return [max(0, round(10 * (1 + 0.5 * spread(side)))) for side in ("top", "right", "bottom", "left")]


def capture_real(case, page_name, theme):
    mobile = case.get("site") == "mobile"
    url = f"{BASE}/tools/verify/out/{page_name}"
    if mobile:
        frame = f"frame-{case['slug']}.html"
        with open(os.path.join(OUT, frame), "w", encoding="utf-8") as f:
            f.write(phone_frame(url))
        url = f"{BASE}/tools/verify/out/{frame}"
    shot = os.path.join(OUT, f"shot-{case['slug']}.png")
    for attempt in range(3):
        try:
            capture(url, shot, width=600 if mobile else 800)
            break
        except subprocess.CalledProcessError:
            if attempt == 2:
                raise
            time.sleep(30)
    image = Image.open(shot).convert("RGB")
    return image, content_box(image, BACKGROUND[theme])


def make_with_tool(case, details, original, margins):
    params = {
        "file": f"tools/verify/out/cache/{os.path.basename(original)}", "width": details["width"], "caption": details["caption"],
        "site": case.get("site", "desktop"), "theme": case.get("theme", "day"), "direction": case.get("direction", "ltr"),
        "textSize": case.get("textSize", 14), "phoneWidth": PHONE_WIDTH, "smoothing": "subpixel",
        "pads": ",".join(map(str, margins)), "scale": 2, "out": f"{case['slug']}-tool.png",
    }
    capture(f"{BASE}/verify.html?{urllib.parse.urlencode(params)}", dpr=1, width=1100, height=1000)
    with open(os.path.join(OUT, f"{case['slug']}-tool.png.json")) as f:
        return json.load(f)


def photo_rect(case, details, original_size):
    """Where the photo sits inside the cropped 2x box: after the frame, margin and image border on desktop, at the
    top left on mobile, where wide images are capped at the phone's content column."""
    mobile = case.get("site") == "mobile"
    shown = min(details["width"], PHONE_WIDTH - 32) if mobile else details["width"]
    inset = 0 if mobile else 5
    height = round(shown * original_size[1] / original_size[0])
    return (2 * inset, 2 * inset, 2 * (inset + shown), 2 * (inset + height))


def mse(a, b):
    difference = ImageChops.difference(a.convert("L"), b.convert("L"))
    return sum(v * v for v in difference.getdata()) / (a.width * a.height)


def compare_boxes(real, tool, photo):
    if real.size != tool.size:
        return {"size_mismatch": [real.size, tool.size]}
    difference = ImageChops.difference(real, tool).convert("L")
    left, top, right, bottom = photo
    outside = [difference.getpixel((x, y)) for y in range(real.height) for x in range(real.width)
               if not (left - 3 <= x < right + 3 and top - 3 <= y < bottom + 3)]
    return {
        "frame_caption_pixels": len(outside),
        "frame_caption_noticeable": sum(1 for v in outside if v > NOTICEABLE),
        "photo_mse": round(mse(real.crop(photo), tool.crop(photo)), 1),
    }


def compare_thumbnails(case, details):
    """The tool's 1x and 2x files against the ones Wikipedia served for this figure, where both are thumbnails."""
    result = {}
    for scale, url in (("1x", details["src"]), ("2x", details["src2x"])):
        ours = os.path.join(OUT, f"{case['slug']}-tool.png.{scale}")
        if not url or "/thumb/" not in url or not os.path.exists(ours):
            continue
        theirs = Image.open(cached(f"{case['slug']}-wikipedia-{scale}{os.path.splitext(url.split('?')[0])[1]}", url)).convert("RGB")
        mine = Image.open(ours).convert("RGB")
        result[scale] = round(mse(theirs, mine), 1) if theirs.size == mine.size else f"size {mine.size} vs {theirs.size}"
    return result


def run_case(case):
    slug = case["slug"]
    theme = case.get("theme", "day")
    if "--check" in sys.argv and os.path.exists(os.path.join(CACHE, f"{slug}.html")):
        os.remove(os.path.join(CACHE, f"{slug}.html"))
    page = open(cached(f"{slug}.html", article_url(case), case.get("site") == "mobile"), encoding="utf-8").read()
    details = figure_details(find_figure(page, case["file"]))
    info = commons_info(case["file"])
    original = cached(f"{slug}-original{os.path.splitext(case['file'])[1].lower()}", info["url"])

    page_name = f"real-{slug}.html"
    with open(os.path.join(OUT, page_name), "w", encoding="utf-8") as f:
        f.write(isolated_page(case, page))

    # Both sides get the same white space, so each pair of images has the same size.
    margins = screenshot_margins(random.Random(slug))
    files = make_with_tool(case, details, original, margins)
    tool = Image.open(os.path.join(OUT, f"{slug}-tool.png")).convert("RGB")
    tool_box = tool.crop(content_box(tool, BACKGROUND[theme]))
    photo = photo_rect(case, details, info["size"])

    # An animated image shows whichever frame was playing; keep the capture closest to the tool's first frame.
    best = None
    for _ in range(12 if case.get("animated") else 1):
        shot, box = capture_real(case, page_name, theme)
        real_box = shot.crop(box)
        score = mse(real_box.crop(photo), tool_box.crop(photo)) if real_box.size == tool_box.size else float("inf")
        if best is None or score < best[0]:
            best = (score, shot, box)
    _, shot, box = best
    # Crop the real figure at the same offsets as the tool's download. These are the margins on desktop, but on
    # mobile the tool measures them from the layout box, which ends below the last line of the caption.
    tool_content = content_box(tool, BACKGROUND[theme])
    left, top = tool_content[0], tool_content[1]
    right, bottom = tool.width - tool_content[2], tool.height - tool_content[3]
    real = shot.crop((box[0] - left, box[1] - top, box[2] + right, box[3] + bottom))
    real.save(os.path.join(OUT, f"{slug}-wikipedia.png"), optimize=True)
    tool.save(os.path.join(OUT, f"{slug}-tool.png"), optimize=True)

    result = compare_boxes(shot.crop(box), tool_box, photo)
    result.update(caption=details["caption"], width=details["width"], files=files, thumbnail_mse=compare_thumbnails(case, details),
                  license=info["license"], artist=info["artist"], commons=info["page"], article=article_url(case).replace("en.m.", "en."))
    return result


def summary_line(slug, result):
    if "size_mismatch" in result:
        return f"{slug:22s} box size differs: wikipedia {result['size_mismatch'][0]}, tool {result['size_mismatch'][1]}"
    share = 100 * result["frame_caption_noticeable"] / result["frame_caption_pixels"]
    return (f"{slug:22s} frame and caption: {result['frame_caption_noticeable']:4d} of {result['frame_caption_pixels']:6d} pixels "
            f"differ noticeably ({share:.2f}%) | photo MSE {result['photo_mse']:7.1f} | thumbnail MSE {result['thumbnail_mse']}")


def check_failure(result):
    if "size_mismatch" in result:
        return "the box size differs"
    share = 100 * result["frame_caption_noticeable"] / result["frame_caption_pixels"]
    if share > CHECK_FRAME_CAPTION_PERCENT:
        return f"{share:.2f}% of frame and caption pixels differ, more than {CHECK_FRAME_CAPTION_PERCENT}%"
    if result["photo_mse"] > CHECK_PHOTO_MSE:
        return f"photo MSE is {result['photo_mse']}, more than {CHECK_PHOTO_MSE}"
    return None


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    os.makedirs(CACHE, exist_ok=True)
    threading.Thread(target=serve.serve, args=(PORT,), daemon=True).start()
    with open(os.path.join(HERE, "cases.json"), encoding="utf-8") as f:
        cases = [c for c in json.load(f) if not args or c["slug"] in args]
    report_path = os.path.join(OUT, "report.json")
    report = json.load(open(report_path, encoding="utf-8")) if os.path.exists(report_path) else {}
    for case in cases:
        report[case["slug"]] = run_case(case)
        print(summary_line(case["slug"], report[case["slug"]]), flush=True)
        with open(report_path, "w", encoding="utf-8") as f:
            json.dump(report, f, ensure_ascii=False, indent=1)
    if "--check" in sys.argv:
        failures = [(case["slug"], check_failure(report[case["slug"]])) for case in cases]
        failures = [(slug, reason) for slug, reason in failures if reason]
        for slug, reason in failures:
            print(f"FAIL {slug}: {reason}")
        if failures:
            sys.exit(1)
    if "--docs" in sys.argv:
        docs = os.path.join(ROOT, "docs", "compare")
        os.makedirs(docs, exist_ok=True)
        for case in cases:
            for side in ("wikipedia", "tool"):
                name = f"{case['slug']}-{side}.png"
                with open(os.path.join(OUT, name), "rb") as src, open(os.path.join(docs, name), "wb") as dst:
                    dst.write(src.read())


if __name__ == "__main__":
    main()
