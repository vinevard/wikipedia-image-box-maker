// Loaded into the tool by serve.py's /verify.html. Sets every option from the query string, makes the download,
// and posts it (plus the 1x and 2x thumbnail files) back to the server. document.title tells capture.mjs when
// it's done.
(async () => {
  const params = new URLSearchParams(location.search);
  const set = (input, name) => { if (params.has(name)) input.value = params.get(name); };
  const post = (name, body) => fetch('/out/' + name, { method: 'POST', body });
  try {
    ui.autoRandomize.checked = false;
    params.get('pads').split(',').forEach((value, i) => { paddingInputs[i].value = value; });
    set(ui.width, 'width');
    set(ui.widthRange, 'width');
    set(ui.caption, 'caption');
    set(ui.site, 'site');
    set(ui.phoneWidth, 'phoneWidth');
    set(ui.textSize, 'textSize');
    set(ui.theme, 'theme');
    set(ui.direction, 'direction');
    set(ui.smoothing, 'smoothing');
    set(ui.scale, 'scale');

    const file = params.get('file');
    const blob = await (await fetch(file)).blob();
    await loadFile(new File([blob], file.split('/').pop(), { type: blob.type }));
    const thumbnails = await currentThumbnails();
    render();

    const out = params.get('out');
    await post(out, await toBlob(await toCanvas(Number(ui.scale.value)), 'image/png'));
    for (const [scale, thumbnail] of [['1x', thumbnails.oneX], ['2x', thumbnails.twoX]]) {
      if (thumbnail.owned) await post(`${out}.${scale}`, thumbnail.blob);
    }
    const describe = (thumbnail, width) => (thumbnail.owned ? width : 'original');
    await post(`${out}.json`, JSON.stringify({
      oneX: describe(thumbnails.oneX, thumbnails.fileWidths[0]),
      twoX: describe(thumbnails.twoX, thumbnails.fileWidths[1]),
    }));
    document.title = 'ready';
  } catch (error) {
    document.title = 'error: ' + error;
  }
})();
