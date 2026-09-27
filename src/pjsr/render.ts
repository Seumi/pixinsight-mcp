/**
 * render_view, render an open view (optionally cropped/downsampled/stretched) to PNG/JPEG.
 *
 * Verified API facts (probed live 2026-07-24):
 *  - Image.assign() honors the SOURCE's selectedRect → crop happens at copy time, no Crop process;
 *  - Image.render() → Bitmap; Bitmap.save(path[, quality]) writes by extension;
 *  - HistogramTransformation.H rows are [shadows, midtones, highlights, low, high]
 *    (rows 0-2 = R,G,B; row 3 = combined RGB/K);
 *  - View.stf rows are [midtones, shadows, highlights, low, high], midtone FIRST.
 *
 * stf modes:
 *  - "auto": PI's documented autostretch (linked): c0 = med + (-2.8)·1.4826·MAD,
 *    m = mtf(0.25, med − c0), computed on the FULL image so crops share the full-field
 *    stretch. DEGENERATE-MEDIAN CLAMP: a stars-only layer has median≈0, and the naive
 *    formula maps noise to 0.25 (a live-observed blowout). The criterion is RELATIVE
 *    (verified live: linear master med/1.4826MAD ≈ 4.8, star layer ≈ 0.7): if
 *    med < 2·1.4826·MAD the image is mostly empty, fall back to a gentle fixed MTF
 *    (c0=0, m=0.01) and warn. Never judge a star layer on "auto".
 *  - "view": apply the view's own STF (what the GUI shows). Identity STF → warns + asis.
 *  - "asis": no transform (correct for post-stretch images).
 */
export function renderScript(
  viewId: string,
  outputPath: string,
  stf: "auto" | "asis" | "view",
  rect?: [number, number, number, number],
  downsample?: number,
  quality?: number
): string {
  const id = JSON.stringify(viewId);
  const out = JSON.stringify(outputPath);
  const rectJs = rect ? JSON.stringify(rect) : "null";
  const ds = downsample && downsample > 1 ? Math.trunc(downsample) : 0;
  // Default 100: these are deliverables and review artifacts, not web assets.
  const q = quality && quality > 0 ? Math.min(100, Math.trunc(quality)) : 100;
  return `(function(){
  var sig = function(x){ return (typeof x === "number" && isFinite(x)) ? Number(x.toPrecision(6)) : x; };
  var v = View.viewById(${id});
  if (!v || v.isNull) return JSON.stringify({error: "Image not found: " + ${id}});
  var src = v.image;
  var warnings = [];
  var mode = ${JSON.stringify(stf)};
  var mtf = function(m, x){ if (x <= 0) return 0; if (x >= 1) return 1; return ((m - 1)*x)/(((2*m - 1)*x) - m); };

  var tw = null;
  try {
    // 选区栈保留矩形、通道和范围裁剪等完整状态；统计与无 rect 的复制均从完整图开始。
    src.pushSelections();
    try {
      src.resetSelections();
      // Stretch parameters from the FULL image (crops share the full-field stretch).
      var htRows = null; // [[c0,m,c1] per HT row index]
      if (mode === "auto") {
        var meds = [], mads = [];
        var nch = Math.min(src.numberOfChannels, 3);
        for (var c = 0; c < nch; ++c) {
          src.selectedChannel = c;
          meds.push(src.median()); mads.push(src.MAD());
        }
        src.resetSelections();
        var med = 0, mad = 0;
        for (var c = 0; c < nch; ++c) { med += meds[c]/nch; mad += mads[c]/nch; }
        if (med < 2*1.4826*mad) {
          warnings.push("degenerate-median (med " + sig(med) + " < 2x1.4826xMAD " + sig(1.4826*mad) + ", mostly-empty layer): autostretch clamped to gentle fixed MTF - prefer stf:'asis' or render the recombined view; never judge a star layer on 'auto'");
          htRows = { 3: [0, 0.01, 1] };
        } else {
          var c0 = Math.max(0, Math.min(1, med - 2.8*1.4826*mad));
          var m = mtf(0.25, med - c0);
          htRows = { 3: [c0, m, 1] };
        }
      } else if (mode === "view") {
        var s = v.stf; // rows [m, c0, c1, r0, r1]
        var identity = true;
        for (var c = 0; c < 3; ++c)
          if (Math.abs(s[c][0] - 0.5) > 1e-6 || Math.abs(s[c][1]) > 1e-6 || Math.abs(s[c][2] - 1) > 1e-6) identity = false;
        if (identity) {
          warnings.push("view has no STF set - rendering as-is");
        } else {
          htRows = { 0: [s[0][1], s[0][0], s[0][2]], 1: [s[1][1], s[1][0], s[1][2]], 2: [s[2][1], s[2][0], s[2][2]] };
        }
      }

      // assign 仅裁剪临时副本；复制结束或失败时均恢复源选区。
      var r = ${rectJs};
      var x0 = 0, y0 = 0, x1 = src.width, y1 = src.height;
      if (r) {
        x0 = Math.max(0, Math.min(src.width - 1, Math.round(r[0])));
        y0 = Math.max(0, Math.min(src.height - 1, Math.round(r[1])));
        x1 = Math.max(x0 + 1, Math.min(src.width, Math.round(r[2])));
        y1 = Math.max(y0 + 1, Math.min(src.height, Math.round(r[3])));
      }
      var tmpId = "mcp_render_tmp", suffix = 0;
      while (!ImageWindow.windowById(tmpId).isNull)
        tmpId = "mcp_render_tmp_" + (++suffix);
      tw = new ImageWindow(x1 - x0, y1 - y0, src.numberOfChannels, 32, true, src.isColor, tmpId);
      if (tw.isNull) throw new Error("Failed to create render window");
      var tv = tw.mainView;
      tv.beginProcess();
      try {
        if (r) src.selectedRect = new Rect(x0, y0, x1, y1);
        tv.image.assign(src);
      } finally {
        tv.endProcess();
      }
    } finally {
      src.popSelections();
    }

    if (htRows) {
      var P = new HistogramTransformation;
      var H = [[0,0.5,1,0,1],[0,0.5,1,0,1],[0,0.5,1,0,1],[0,0.5,1,0,1],[0,0.5,1,0,1]];
      for (var row in htRows) {
        var t = htRows[row];
        H[row|0] = [t[0], t[1], t[2], 0, 1];
      }
      P.H = H;
      if (P.executeOn(tv, false) === false) throw new Error("HistogramTransformation failed");
    }
    var dsf = ${ds};
    if (dsf > 1) {
      var IR = new IntegerResample;
      IR.zoomFactor = -dsf;
      if (IR.executeOn(tv, false) === false) throw new Error("IntegerResample failed");
    }
    var bmp = tv.image.render();
    if (bmp.save(${out}, ${q}) === false) throw new Error("Failed to save rendered image: " + ${out});
    var ow = tv.image.width, oh = tv.image.height;
  } finally {
    // 仅关闭本次创建的窗口，不通过 ID 查找并关闭其他窗口。
    if (tw && !tw.isNull) tw.forceClose();
  }
  return JSON.stringify({ viewId: ${id}, path: ${out}, width: ow, height: oh,
    stfMode: mode, stfApplied: !!htRows,
    stretch: htRows ? htRows : null,
    sourceRect: [x0, y0, x1, y1], downsample: ${ds} || 1,
    warnings: warnings });
})()`;
}

/** Tiny helper: image dimensions + color flag (used by render_critic_pack for crop layout). */
export function dimsScript(viewId: string): string {
  const id = JSON.stringify(viewId);
  return `(function(){
  var v = View.viewById(${id});
  if (!v || v.isNull) return JSON.stringify({error: "Image not found: " + ${id}});
  var img = v.image;
  return JSON.stringify({ viewId: ${id}, width: img.width, height: img.height, isColor: img.isColor, channels: img.numberOfChannels });
})()`;
}
