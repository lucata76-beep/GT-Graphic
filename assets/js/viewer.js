/*!
 * GT-Graphic - Motore grafico 2D (Canvas)
 * -------------------------------------------------------------
 * Proiezione ortogonale tecnica: nessuna vista 3D, nessun WebGL.
 * - Griglia metrica adattiva ancorata all'origine attiva
 * - Assi X/Y/Z colorati secondo la vista
 * - Tracciati G00/G01/G02/G03 con stile dedicato
 * - Pan, zoom (rotellina, pulsanti, pinch), zoom finestra
 * - Hit test magnetico su vertici e centri arco
 * -------------------------------------------------------------
 */
(function (root) {
  'use strict';

  var AXES = {
    xy: { u: 'x', v: 'y', w: 'z', ul: 'X', vl: 'Y', wl: 'Z' },
    xz: { u: 'x', v: 'z', w: 'y', ul: 'X', vl: 'Z', wl: 'Y' },
    yz: { u: 'y', v: 'z', w: 'x', ul: 'Y', vl: 'Z', wl: 'X' }
  };

  var C = {
    bg: '#0b1016',
    bgTop: '#0e141c',
    gridMinor: 'rgba(148, 163, 184, 0.055)',
    gridMajor: 'rgba(148, 163, 184, 0.14)',
    gridLabel: 'rgba(148, 163, 184, 0.62)',
    axisX: '#e05a5a',
    axisY: '#4ade80',
    axisZ: '#60a5fa',
    g0: '#ff6b4a',
    g1: '#22d3ee',
    g2: '#fbbf24',
    g3: '#e879f9',
    white: '#f4f8fb',
    accent: '#22d3ee'
  };

  var S = {
    canvas: null,
    ctx: null,
    dpr: 1,
    W: 0,
    H: 0,
    view: 'xy',
    origin: { x: 0, y: 0, z: 0 },
    cam: { cx: 0, cy: 0, scale: 2 },
    files: [],
    colorMode: 'type',
    mode: 'pan',
    progress: null,
    selected: null,
    hover: null,
    box: null,
    cursor: { sx: 0, sy: 0, inside: false },
    index: [],
    indexDirty: true,
    indexView: '',
    raf: 0,
    cb: {},
    pointers: new Map(),
    drag: null,
    pinch: null
  };

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  function setCanvasCursor() {
    if (!S.canvas) return;
    if (S.drag && S.drag.type === 'pan') S.canvas.style.cursor = 'grabbing';
    else if (S.mode === 'pan') S.canvas.style.cursor = 'grab';
    else S.canvas.style.cursor = 'crosshair';
  }

  function requestRender() {
    if (S.raf) return;
    S.raf = requestAnimationFrame(function () {
      S.raf = 0;
      render();
    });
  }

  function resize() {
    if (!S.canvas) return;
    var rect = S.canvas.getBoundingClientRect();
    S.W = Math.max(1, Math.round(rect.width));
    S.H = Math.max(1, Math.round(rect.height));
    S.dpr = Math.min(3, Math.max(1, root.devicePixelRatio || 1));
    S.canvas.width = Math.round(S.W * S.dpr);
    S.canvas.height = Math.round(S.H * S.dpr);
    if (S.ctx) S.ctx.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
    requestRender();
  }

  function screenToWorld(sx, sy) {
    return {
      u: S.cam.cx + (sx - S.W / 2) / S.cam.scale,
      v: S.cam.cy - (sy - S.H / 2) / S.cam.scale
    };
  }

  function worldToScreen(u, v) {
    return {
      x: S.W / 2 + (u - S.cam.cx) * S.cam.scale,
      y: S.H / 2 - (v - S.cam.cy) * S.cam.scale
    };
  }

  function pointUV(p, A) {
    return {
      u: A.u === 'x' ? p.x : (A.u === 'y' ? p.y : p.z),
      v: A.v === 'x' ? p.x : (A.v === 'y' ? p.y : p.z)
    };
  }

  function axisColor(name) {
    return name === 'x' ? C.axisX : (name === 'y' ? C.axisY : C.axisZ);
  }

  function visibleBounds() {
    var A = AXES[S.view];
    var minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    var found = false;
    for (var i = 0; i < S.files.length; i++) {
      var f = S.files[i];
      if (!f.visible || !f.program || !f.program.bounds) continue;
      var b = f.program.bounds;
      var u0 = A.u === 'x' ? b.minX : (A.u === 'y' ? b.minY : b.minZ);
      var u1 = A.u === 'x' ? b.maxX : (A.u === 'y' ? b.maxY : b.maxZ);
      var v0 = A.v === 'x' ? b.minX : (A.v === 'y' ? b.minY : b.minZ);
      var v1 = A.v === 'x' ? b.maxX : (A.v === 'y' ? b.maxY : b.maxZ);
      if (u0 < minU) minU = u0;
      if (u1 > maxU) maxU = u1;
      if (v0 < minV) minV = v0;
      if (v1 > maxV) maxV = v1;
      found = true;
    }
    if (!found) return null;
    return { minU: minU, maxU: maxU, minV: minV, maxV: maxV };
  }

  function fit() {
    var b = visibleBounds();
    if (!b) {
      var A0 = AXES[S.view];
      S.cam.cx = A0.u === 'x' ? S.origin.x : (A0.u === 'y' ? S.origin.y : S.origin.z);
      S.cam.cy = A0.v === 'x' ? S.origin.x : (A0.v === 'y' ? S.origin.y : S.origin.z);
      S.cam.scale = 2;
    } else {
      var pad = Math.min(64, Math.max(28, Math.min(S.W, S.H) * 0.08));
      var bw = Math.max(b.maxU - b.minU, 1e-6);
      var bh = Math.max(b.maxV - b.minV, 1e-6);
      var s = Math.min((S.W - pad * 2) / bw, (S.H - pad * 2) / bh);
      if (!isFinite(s) || s <= 0) s = 2;
      S.cam.scale = clamp(s, 1e-5, 2e5);
      S.cam.cx = (b.minU + b.maxU) / 2;
      S.cam.cy = (b.minV + b.maxV) / 2;
    }
    if (S.cb.onZoom) S.cb.onZoom(S.cam.scale);
    requestRender();
  }

  function panBy(dxPx, dyPx) {
    S.cam.cx -= dxPx / S.cam.scale;
    S.cam.cy += dyPx / S.cam.scale;
    requestRender();
  }

  function zoomAt(factor, sx, sy) {
    if (sx == null || sy == null) { sx = S.W / 2; sy = S.H / 2; }
    var before = screenToWorld(sx, sy);
    var next = clamp(S.cam.scale * factor, 1e-5, 2e5);
    if (Math.abs(next - S.cam.scale) < 1e-12) return;
    S.cam.scale = next;
    var after = screenToWorld(sx, sy);
    S.cam.cx += before.u - after.u;
    S.cam.cy += before.v - after.v;
    if (S.cb.onZoom) S.cb.onZoom(S.cam.scale);
    requestRender();
  }

  function zoomToScreenRect(x0, y0, x1, y1) {
    var sx0 = Math.min(x0, x1), sx1 = Math.max(x0, x1);
    var sy0 = Math.min(y0, y1), sy1 = Math.max(y0, y1);
    if (sx1 - sx0 < 6 || sy1 - sy0 < 6) return;
    var a = screenToWorld(sx0, sy0);
    var b = screenToWorld(sx1, sy1);
    var u0 = Math.min(a.u, b.u), u1 = Math.max(a.u, b.u);
    var v0 = Math.min(a.v, b.v), v1 = Math.max(a.v, b.v);
    var bw = Math.max(u1 - u0, 1e-9), bh = Math.max(v1 - v0, 1e-9);
    var pad = 16;
    var s = Math.min((S.W - pad * 2) / bw, (S.H - pad * 2) / bh);
    S.cam.scale = clamp(s, 1e-5, 2e5);
    S.cam.cx = (u0 + u1) / 2;
    S.cam.cy = (v0 + v1) / 2;
    if (S.cb.onZoom) S.cb.onZoom(S.cam.scale);
    requestRender();
  }

  /* ------------------------------------------------------------------ */
  /* Griglia                                                             */
  /* ------------------------------------------------------------------ */
  function niceStep(minPx) {
    var raw = minPx / S.cam.scale;
    if (!isFinite(raw) || raw <= 0) return 1;
    var pow = Math.pow(10, Math.floor(Math.log10(raw)));
    var norm = raw / pow;
    var mult = norm <= 1 ? 1 : (norm <= 2 ? 2 : (norm <= 5 ? 5 : 10));
    return mult * pow;
  }

  function fmtGrid(v, step) {
    if (Math.abs(v) < step * 1e-6) v = 0;
    var dec = step >= 1 ? 0 : Math.min(4, Math.ceil(-Math.log10(step) - 1e-9));
    return v.toFixed(dec);
  }

  function drawGrid(ctx) {
    var A = AXES[S.view];
    var W = S.W, H = S.H, sc = S.cam.scale;
    var origin = S.origin;
    var step = niceStep(84);
    var minor = step / 5;

    var dLeft = S.cam.cx - origin[A.u] - (W / 2) / sc;
    var dRight = S.cam.cx - origin[A.u] + (W / 2) / sc;
    var dBottom = S.cam.cy - origin[A.v] - (H / 2) / sc;
    var dTop = S.cam.cy - origin[A.v] + (H / 2) / sc;

    ctx.lineWidth = 1;
    ctx.setLineDash([]);

    // Minori
    if (minor * sc >= 7) {
      ctx.beginPath();
      ctx.strokeStyle = C.gridMinor;
      var k0 = Math.floor(dLeft / minor), k1 = Math.ceil(dRight / minor);
      for (var k = k0; k <= k1; k++) {
        if (k % 5 === 0) continue;
        var u = origin[A.u] + k * minor;
        var sx = W / 2 + (u - S.cam.cx) * sc;
        if (sx < -1 || sx > W + 1) continue;
        ctx.moveTo(Math.round(sx) + 0.5, 0);
        ctx.lineTo(Math.round(sx) + 0.5, H);
      }
      var j0 = Math.floor(dBottom / minor), j1 = Math.ceil(dTop / minor);
      for (var j = j0; j <= j1; j++) {
        if (j % 5 === 0) continue;
        var v = origin[A.v] + j * minor;
        var sy = H / 2 - (v - S.cam.cy) * sc;
        if (sy < -1 || sy > H + 1) continue;
        ctx.moveTo(0, Math.round(sy) + 0.5);
        ctx.lineTo(W, Math.round(sy) + 0.5);
      }
      ctx.stroke();
    }

    // Maggiori + etichette
    ctx.beginPath();
    ctx.strokeStyle = C.gridMajor;
    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    ctx.fillStyle = C.gridLabel;
    ctx.textBaseline = 'alphabetic';

    var majorK0 = Math.floor(dLeft / step), majorK1 = Math.ceil(dRight / step);
    for (var mk = majorK0; mk <= majorK1; mk++) {
      var mu = origin[A.u] + mk * step;
      var msx = W / 2 + (mu - S.cam.cx) * sc;
      if (msx < -1 || msx > W + 1) continue;
      var x = Math.round(msx) + 0.5;
      ctx.moveTo(x, 0);
      ctx.lineTo(x, H);
      var label = fmtGrid(mk * step, step);
      var tw = ctx.measureText(label).width;
      if (msx - tw / 2 > 2 && msx + tw / 2 < W - 2) {
        ctx.fillText(label, msx - tw / 2, H - 7);
      }
    }
    var majorJ0 = Math.floor(dBottom / step), majorJ1 = Math.ceil(dTop / step);
    for (var mj = majorJ0; mj <= majorJ1; mj++) {
      var mv = origin[A.v] + mj * step;
      var msy = H / 2 - (mv - S.cam.cy) * sc;
      if (msy < -1 || msy > H + 1) continue;
      var y = Math.round(msy) + 0.5;
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
      var lab = fmtGrid(mj * step, step);
      if (msy > 12 && msy < H - 4) ctx.fillText(lab, 7, msy - 4);
    }
    ctx.stroke();

    // Assi del piano attivo (passanti per l'origine attiva)
    var axX = W / 2 + (origin[A.u] - S.cam.cx) * sc;
    var axY = H / 2 - (origin[A.v] - S.cam.cy) * sc;

    ctx.lineWidth = 1.4;
    if (axX >= 0 && axX <= W) {
      ctx.beginPath();
      ctx.strokeStyle = axisColor(A.v);
      ctx.globalAlpha = 0.55;
      ctx.moveTo(axX + 0.5, 0);
      ctx.lineTo(axX + 0.5, H);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    if (axY >= 0 && axY <= H) {
      ctx.beginPath();
      ctx.strokeStyle = axisColor(A.u);
      ctx.globalAlpha = 0.55;
      ctx.moveTo(0, axY + 0.5);
      ctx.lineTo(W, axY + 0.5);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Origine e compasso                                                  */
  /* ------------------------------------------------------------------ */
  function drawOrigin(ctx) {
    var A = AXES[S.view];
    var o = worldToScreen(S.origin[A.u], S.origin[A.v]);
    var W = S.W, H = S.H;

    if (o.x < -160 || o.x > W + 160 || o.y < -160 || o.y > H + 160) return;

    ctx.setLineDash([]);
    ctx.lineWidth = 1.4;
    ctx.strokeStyle = 'rgba(244,248,251,0.9)';
    ctx.fillStyle = C.bg;

    ctx.beginPath();
    ctx.arc(o.x, o.y, 6.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(o.x - 11, o.y); ctx.lineTo(o.x - 2, o.y);
    ctx.moveTo(o.x + 2, o.y); ctx.lineTo(o.x + 11, o.y);
    ctx.moveTo(o.x, o.y - 11); ctx.lineTo(o.x, o.y - 2);
    ctx.moveTo(o.x, o.y + 2); ctx.lineTo(o.x, o.y + 11);
    ctx.stroke();

    // Frecce assi positivi
    var len = 54;
    drawArrow(ctx, o.x, o.y, o.x + len, o.y, axisColor(A.u));
    drawArrow(ctx, o.x, o.y, o.x, o.y - len, axisColor(A.v));

    ctx.font = '600 11px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillStyle = axisColor(A.u);
    ctx.textAlign = 'left';
    ctx.fillText(A.ul, o.x + len + 4, o.y + 4);
    ctx.fillStyle = axisColor(A.v);
    ctx.fillText(A.vl, o.x - 4, o.y - len - 7);
    ctx.textAlign = 'left';

    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillStyle = 'rgba(244,248,251,0.65)';
    ctx.fillText('0,0', o.x + 10, o.y + 18);
  }

  function drawArrow(ctx, x0, y0, x1, y1, color) {
    var ang = Math.atan2(y1 - y0, x1 - x0);
    var head = 7;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x1 - head * Math.cos(ang - 0.42), y1 - head * Math.sin(ang - 0.42));
    ctx.lineTo(x1 - head * Math.cos(ang + 0.42), y1 - head * Math.sin(ang + 0.42));
    ctx.closePath();
    ctx.fill();
  }

  function drawCompass(ctx) {
    var A = AXES[S.view];
    var x = S.W - 46, y = S.H - 52;
    ctx.save();
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = 'rgba(13,19,26,0.72)';
    ctx.strokeStyle = 'rgba(148,163,184,0.22)';
    ctx.lineWidth = 1;
    roundRect(ctx, x - 26, y - 26, 52, 52, 8);
    ctx.fill();
    ctx.stroke();
    drawArrow(ctx, x, y, x + 17, y, axisColor(A.u));
    drawArrow(ctx, x, y, x, y - 17, axisColor(A.v));
    ctx.font = '600 9px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillStyle = axisColor(A.u);
    ctx.fillText(A.ul, x + 20, y + 3);
    ctx.fillStyle = axisColor(A.v);
    ctx.fillText(A.vl, x - 2, y - 21);
    ctx.restore();
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /* ------------------------------------------------------------------ */
  /* Tracciati                                                           */
  /* ------------------------------------------------------------------ */
  function styleFor(file, type) {
    if (S.colorMode === 'file') {
      return {
        color: file.color || C.g1,
        width: type === 0 ? 1.1 : (type === 2 || type === 3 ? 2.1 : 1.7),
        dash: type === 0 ? [6, 4] : [],
        alpha: 0.95
      };
    }
    var color = type === 0 ? C.g0 : (type === 1 ? C.g1 : (type === 2 ? C.g2 : C.g3));
    return {
      color: color,
      width: type === 0 ? 1.15 : (type === 2 || type === 3 ? 1.95 : 1.55),
      dash: type === 0 ? [6, 4] : [],
      alpha: type === 0 ? 0.92 : 1
    };
  }

  function drawToolpaths(ctx) {
    var A = AXES[S.view];
    var W = S.W, H = S.H, sc = S.cam.scale;
    var cx = S.cam.cx, cy = S.cam.cy;
    var hw = W / 2, hh = H / 2;
    var idxU = A.u === 'x' ? 0 : (A.u === 'y' ? 1 : 2);
    var idxV = A.v === 'x' ? 0 : (A.v === 'y' ? 1 : 2);
    var margin = 8 / sc;
    var uMin = cx - (W / 2) / sc - margin, uMax = cx + (W / 2) / sc + margin;
    var vMin = cy - (H / 2) / sc - margin, vMax = cy + (H / 2) / sc + margin;

    function inView(seg) {
      var b = seg.bounds;
      var bu0 = idxU === 0 ? b.minX : (idxU === 1 ? b.minY : b.minZ);
      var bu1 = idxU === 0 ? b.maxX : (idxU === 1 ? b.maxY : b.maxZ);
      var bv0 = idxV === 0 ? b.minX : (idxV === 1 ? b.minY : b.minZ);
      var bv1 = idxV === 0 ? b.maxX : (idxV === 1 ? b.maxY : b.maxZ);
      return !(bu1 < uMin || bu0 > uMax || bv1 < vMin || bv0 > vMax);
    }

    function strokeSegs(segs, st, fromIndex, toIndex) {
      ctx.beginPath();
      var drew = false;
      for (var si = 0; si < segs.length; si++) {
        var seg = segs[si];
        if (fromIndex !== null && seg.index < fromIndex) continue;
        if (toIndex !== null && seg.index >= toIndex) continue;
        if (!inView(seg)) continue;

        var p = seg.pts;
        var step = 3;
        if (sc < 0.35 && p.length > 90) step = 9;
        else if (sc < 1.2 && p.length > 90) step = 6;

        var pu = idxU === 0 ? p[0] : (idxU === 1 ? p[1] : p[2]);
        var pv = idxV === 0 ? p[0] : (idxV === 1 ? p[1] : p[2]);
        ctx.moveTo(hw + (pu - cx) * sc, hh - (pv - cy) * sc);
        for (var k = step; k < p.length; k += step) {
          var qu = idxU === 0 ? p[k] : (idxU === 1 ? p[k + 1] : p[k + 2]);
          var qv = idxV === 0 ? p[k] : (idxV === 1 ? p[k + 1] : p[k + 2]);
          ctx.lineTo(hw + (qu - cx) * sc, hh - (qv - cy) * sc);
        }
        var last = p.length - 3;
        var lu = idxU === 0 ? p[last] : (idxU === 1 ? p[last + 1] : p[last + 2]);
        var lv = idxV === 0 ? p[last] : (idxV === 1 ? p[last + 1] : p[last + 2]);
        ctx.lineTo(hw + (lu - cx) * sc, hh - (lv - cy) * sc);
        drew = true;
      }
      if (!drew) return;
      ctx.strokeStyle = st.color;
      ctx.lineWidth = st.width;
      ctx.globalAlpha = st.alpha;
      ctx.setLineDash(st.dash);
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.stroke();
    }

    for (var fi = 0; fi < S.files.length; fi++) {
      var f = S.files[fi];
      if (!f.visible || !f.program) continue;
      var prog = S.progress && S.progress.fileId === f.id ? S.progress : null;
      for (var t = 0; t < 4; t++) {
        var segs = f.program.byType[t];
        if (!segs || !segs.length) continue;
        var st = styleFor(f, t);
        if (!prog) {
          strokeSegs(segs, st, null, null);
          continue;
        }

        strokeSegs(segs, {
          color: st.color,
          width: 1,
          alpha: 0.17,
          dash: st.dash
        }, prog.count, null);

        strokeSegs(segs, st, 0, prog.count);

        if (prog.currentSegIndex !== null && prog.currentSegIndex !== undefined) {
          var cur = null;
          for (var qi = 0; qi < segs.length; qi++) {
            if (segs[qi].index === prog.currentSegIndex) { cur = segs[qi]; break; }
          }
          if (cur && inView(cur)) {
            strokeSegs([cur], {
              color: C.white,
              width: Math.max(2.4, st.width + 1.4),
              alpha: 1,
              dash: []
            }, null, null);
            var cp = cur.pts;
            var cl = cp.length - 3;
            var cu = idxU === 0 ? cp[cl] : (idxU === 1 ? cp[cl + 1] : cp[cl + 2]);
            var cv = idxV === 0 ? cp[cl] : (idxV === 1 ? cp[cl + 1] : cp[cl + 2]);
            ctx.beginPath();
            ctx.arc(hw + (cu - cx) * sc, hh - (cv - cy) * sc, 4, 0, Math.PI * 2);
            ctx.fillStyle = C.white;
            ctx.globalAlpha = 1;
            ctx.fill();
            ctx.beginPath();
            ctx.arc(hw + (cu - cx) * sc, hh - (cv - cy) * sc, 7, 0, Math.PI * 2);
            ctx.strokeStyle = 'rgba(244,248,251,0.45)';
            ctx.lineWidth = 1;
            ctx.stroke();
          }
        }
      }
    }
    ctx.globalAlpha = 1;
    ctx.setLineDash([]);
  }

  function drawSelection(ctx) {
    var sel = S.selected;
    if (!sel || !sel.seg) return;
    if (sel.file && sel.file.visible === false) return;
    var A = AXES[S.view];
    var idxU = A.u === 'x' ? 0 : (A.u === 'y' ? 1 : 2);
    var idxV = A.v === 'x' ? 0 : (A.v === 'y' ? 1 : 2);
    var seg = sel.seg;
    var p = seg.pts;
    var sc = S.cam.scale, cx = S.cam.cx, cy = S.cam.cy, hw = S.W / 2, hh = S.H / 2;

    ctx.save();
    ctx.beginPath();
    for (var k = 0; k < p.length; k += 3) {
      var u = idxU === 0 ? p[k] : (idxU === 1 ? p[k + 1] : p[k + 2]);
      var v = idxV === 0 ? p[k] : (idxV === 1 ? p[k + 1] : p[k + 2]);
      var sx = hw + (u - cx) * sc, sy = hh - (v - cy) * sc;
      if (k === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy);
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.28)';
    ctx.lineWidth = 7;
    ctx.lineJoin = 'round';
    ctx.stroke();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2.4;
    ctx.stroke();

    // estremi del segmento
    var ends = [{ x: seg.x0, y: seg.y0, z: seg.z0 }, { x: seg.x1, y: seg.y1, z: seg.z1 }];
    for (var e = 0; e < 2; e++) {
      var q = pointUV(ends[e], A);
      var s2 = worldToScreen(q.u, q.v);
      ctx.beginPath();
      ctx.arc(s2.x, s2.y, 3.2, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
    }
    ctx.restore();
  }

  function drawSnap(ctx) {
    var h = S.hover;
    if (!h || !h.point) return;
    var A = AXES[S.view];
    var q = pointUV(h.point, A);
    var s = worldToScreen(q.u, q.v);
    var W = S.W, H = S.H;
    if (s.x < -20 || s.x > W + 20 || s.y < -20 || s.y > H + 20) return;

    ctx.save();
    ctx.strokeStyle = h.kind === 'center' ? C.g3 : C.accent;
    ctx.lineWidth = 1.6;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(s.x, s.y, 10, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(s.x - 15, s.y); ctx.lineTo(s.x - 12, s.y);
    ctx.moveTo(s.x + 12, s.y); ctx.lineTo(s.x + 15, s.y);
    ctx.moveTo(s.x, s.y - 15); ctx.lineTo(s.x, s.y - 12);
    ctx.moveTo(s.x, s.y + 12); ctx.lineTo(s.x, s.y + 15);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(s.x, s.y, 2.4, 0, Math.PI * 2);
    ctx.fillStyle = ctx.strokeStyle;
    ctx.fill();

    // etichetta coordinate relative all'origine attiva
    var du = q.u - (A.u === 'x' ? S.origin.x : (A.u === 'y' ? S.origin.y : S.origin.z));
    var dv = q.v - (A.v === 'x' ? S.origin.x : (A.v === 'y' ? S.origin.y : S.origin.z));
    var txt = A.ul + ' ' + du.toFixed(3) + '  ' + A.vl + ' ' + dv.toFixed(3);
    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    var tw = ctx.measureText(txt).width;
    var bx = s.x + 16, by = s.y - 34;
    if (bx + tw + 12 > W) bx = s.x - tw - 28;
    if (by < 4) by = s.y + 18;
    ctx.fillStyle = 'rgba(10,16,22,0.88)';
    ctx.strokeStyle = 'rgba(34,211,238,0.45)';
    ctx.lineWidth = 1;
    roundRect(ctx, bx, by, tw + 12, 20, 5);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#dff7ff';
    ctx.fillText(txt, bx + 6, by + 14);
    ctx.restore();
  }

  function drawBox(ctx) {
    if (!S.box) return;
    var x0 = Math.min(S.box.x0, S.box.x1), x1 = Math.max(S.box.x0, S.box.x1);
    var y0 = Math.min(S.box.y0, S.box.y1), y1 = Math.max(S.box.y0, S.box.y1);
    ctx.save();
    ctx.fillStyle = 'rgba(34,211,238,0.08)';
    ctx.strokeStyle = 'rgba(34,211,238,0.9)';
    ctx.lineWidth = 1.2;
    ctx.setLineDash([5, 4]);
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    ctx.strokeRect(x0 + 0.5, y0 + 0.5, x1 - x0, y1 - y0);
    ctx.restore();
  }

  /* ------------------------------------------------------------------ */
  /* Render                                                              */
  /* ------------------------------------------------------------------ */
  function render() {
    if (!S.ctx) return;
    var ctx = S.ctx;
    var W = S.W, H = S.H;
    ctx.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    var grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, C.bgTop);
    grad.addColorStop(1, C.bg);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);

    drawGrid(ctx);
    drawOrigin(ctx);
    drawToolpaths(ctx);
    drawSelection(ctx);
    drawSnap(ctx);
    drawBox(ctx);
    drawCompass(ctx);
  }

  /* ------------------------------------------------------------------ */
  /* Hit test                                                            */
  /* ------------------------------------------------------------------ */
  function buildIndex() {
    var A = AXES[S.view];
    var arr = [];
    for (var fi = 0; fi < S.files.length; fi++) {
      var f = S.files[fi];
      if (!f.visible || !f.program) continue;
      var segs = f.program.segments;
      for (var i = 0; i < segs.length; i++) {
        var s = segs[i];
        var pu = A.u === 'x' ? s.x0 : (A.u === 'y' ? s.y0 : s.z0);
        var pv = A.v === 'x' ? s.x0 : (A.v === 'y' ? s.y0 : s.z0);
        arr.push({ u: pu, v: pv, x: s.x0, y: s.y0, z: s.z0, seg: s, file: f, kind: 'start' });
        if (s.type >= 2 && s.center) {
          var cu = A.u === 'x' ? s.center.x : (A.u === 'y' ? s.center.y : s.center.z);
          var cv = A.v === 'x' ? s.center.x : (A.v === 'y' ? s.center.y : s.center.z);
          arr.push({ u: cu, v: cv, x: s.center.x, y: s.center.y, z: s.center.z, seg: s, file: f, kind: 'center' });
        }
      }
      if (segs.length) {
        var last = segs[segs.length - 1];
        var lu = A.u === 'x' ? last.x1 : (A.u === 'y' ? last.y1 : last.z1);
        var lv = A.v === 'x' ? last.x1 : (A.v === 'y' ? last.y1 : last.z1);
        arr.push({ u: lu, v: lv, x: last.x1, y: last.y1, z: last.z1, seg: last, file: f, kind: 'end' });
      }
    }
    arr.sort(function (a, b) { return a.u - b.u; });
    S.index = arr;
    S.indexDirty = false;
    S.indexView = S.view;
  }

  function hitTest(sx, sy, tolPx) {
    if (S.indexDirty || S.indexView !== S.view) buildIndex();
    var arr = S.index;
    if (!arr.length) return null;
    var w = screenToWorld(sx, sy);
    var tol = (tolPx || 14) / S.cam.scale;
    var lo = 0, hi = arr.length;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      if (arr[mid].u < w.u - tol) lo = mid + 1; else hi = mid;
    }
    var best = null, bestD = Infinity;
    for (var i = lo; i < arr.length && arr[i].u <= w.u + tol; i++) {
      var p = arr[i];
      var dv = p.v - w.v;
      if (dv > tol || dv < -tol) continue;
      var du = p.u - w.u;
      var d2 = du * du + dv * dv;
      if (d2 < bestD) { bestD = d2; best = p; }
    }
    return best;
  }

  function selectAt(sx, sy, tolPx) {
    var hit = hitTest(sx, sy, tolPx);
    if (hit) {
      S.selected = {
        file: hit.file,
        seg: hit.seg,
        kind: hit.kind,
        point: { x: hit.x, y: hit.y, z: hit.z }
      };
      S.hover = S.selected;
    } else {
      S.selected = null;
      S.hover = null;
    }
    if (S.cb.onSelect) S.cb.onSelect(S.selected);
    requestRender();
    return S.selected;
  }

  function hoverAt(sx, sy, tolPx) {
    var hit = hitTest(sx, sy, tolPx || 14);
    var next = null;
    if (hit) {
      next = { file: hit.file, seg: hit.seg, kind: hit.kind, point: { x: hit.x, y: hit.y, z: hit.z } };
    }
    var changed = (!!next !== !!S.hover) ||
      (next && S.hover && (next.seg !== S.hover.seg || next.kind !== S.hover.kind || next.point.x !== S.hover.point.x || next.point.y !== S.hover.point.y || next.point.z !== S.hover.point.z));
    S.hover = next;
    if (changed) {
      requestRender();
      if (S.cb.onHover) S.cb.onHover(next);
    }
    return next;
  }

  function pickOriginAt(sx, sy) {
    var hit = hitTest(sx, sy, 26);
    var A = AXES[S.view];
    var p;
    if (hit) {
      p = { x: hit.x, y: hit.y, z: hit.z };
    } else {
      var w = screenToWorld(sx, sy);
      p = { x: 0, y: 0, z: 0 };
      p[A.u] = w.u;
      p[A.v] = w.v;
      p[A.w] = S.origin[A.w];
    }
    if (S.cb.onPickOrigin) S.cb.onPickOrigin(p, !!hit);
    return p;
  }

  /* ------------------------------------------------------------------ */
  /* Input                                                               */
  /* ------------------------------------------------------------------ */
  function localPos(e) {
    var r = S.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function onPointerDown(e) {
    if (e.pointerType === 'mouse' && e.button !== 0 && e.button !== 1 && e.button !== 2) return;
    var p = localPos(e);
    try { S.canvas.setPointerCapture(e.pointerId); } catch (err) { /* noop */ }
    S.pointers.set(e.pointerId, p);

    if (S.pointers.size === 2) {
      var pts = Array.from(S.pointers.values());
      var dx = pts[0].x - pts[1].x, dy = pts[0].y - pts[1].y;
      S.pinch = {
        dist: Math.max(1, Math.hypot(dx, dy)),
        scale: S.cam.scale,
        mid: { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 },
        world: screenToWorld((pts[0].x + pts[1].x) / 2, (pts[0].y + pts[1].y) / 2)
      };
      S.drag = null;
      S.box = null;
      return;
    }

    if (S.pointers.size > 2) return;

    var isPanButton = e.button === 1 || e.button === 2 || (e.button === 0 && S.mode === 'pan');
    if (isPanButton) {
      S.drag = { type: 'pan', x: p.x, y: p.y, cx: S.cam.cx, cy: S.cam.cy };
      setCanvasCursor();
      return;
    }
    if (e.button !== 0) return;

    if (S.mode === 'zoomwin') {
      S.drag = { type: 'box', x0: p.x, y0: p.y };
      S.box = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
      requestRender();
    } else if (S.mode === 'inspect') {
      selectAt(p.x, p.y, e.pointerType === 'touch' ? 26 : 16);
    } else if (S.mode === 'origin') {
      pickOriginAt(p.x, p.y);
    }
  }

  function onPointerMove(e) {
    var p = localPos(e);
    S.cursor = { sx: p.x, sy: p.y, inside: true };
    if (S.pointers.has(e.pointerId)) S.pointers.set(e.pointerId, p);

    if (S.pointers.size >= 2 && S.pinch) {
      var pts = Array.from(S.pointers.values()).slice(0, 2);
      var dx = pts[0].x - pts[1].x, dy = pts[0].y - pts[1].y;
      var dist = Math.max(1, Math.hypot(dx, dy));
      var mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
      S.cam.scale = clamp(S.pinch.scale * (dist / S.pinch.dist), 1e-5, 2e5);
      S.cam.cx = S.pinch.world.u - (mid.x - S.W / 2) / S.cam.scale;
      S.cam.cy = S.pinch.world.v + (mid.y - S.H / 2) / S.cam.scale;
      if (S.cb.onZoom) S.cb.onZoom(S.cam.scale);
      requestRender();
      emitCursor(p);
      return;
    }

    if (S.drag && S.drag.type === 'pan') {
      S.cam.cx = S.drag.cx - (p.x - S.drag.x) / S.cam.scale;
      S.cam.cy = S.drag.cy + (p.y - S.drag.y) / S.cam.scale;
      requestRender();
    } else if (S.drag && S.drag.type === 'box') {
      S.box = { x0: S.drag.x0, y0: S.drag.y0, x1: p.x, y1: p.y };
      requestRender();
    } else if (S.mode === 'inspect') {
      hoverAt(p.x, p.y, e.pointerType === 'touch' ? 26 : 14);
    }

    emitCursor(p);
  }

  function emitCursor(p) {
    if (!S.cb.onCursor) return;
    var w = screenToWorld(p.x, p.y);
    var A = AXES[S.view];
    S.cb.onCursor({
      inside: true,
      sx: p.x,
      sy: p.y,
      u: w.u,
      v: w.v,
      du: w.u - (A.u === 'x' ? S.origin.x : (A.u === 'y' ? S.origin.y : S.origin.z)),
      dv: w.v - (A.v === 'x' ? S.origin.x : (A.v === 'y' ? S.origin.y : S.origin.z))
    });
  }

  function onPointerUp(e) {
    var had = S.pointers.has(e.pointerId);
    S.pointers.delete(e.pointerId);
    if (S.pinch) {
      if (S.pointers.size < 2) S.pinch = null;
      S.drag = null;
      setCanvasCursor();
      return;
    }
    if (S.drag && S.drag.type === 'box' && S.box) {
      var b = S.box;
      S.box = null;
      if (Math.abs(b.x1 - b.x0) > 8 && Math.abs(b.y1 - b.y0) > 8) {
        zoomToScreenRect(b.x0, b.y0, b.x1, b.y1);
        if (S.cb.onBoxZoom) S.cb.onBoxZoom();
      } else {
        requestRender();
      }
    }
    S.drag = null;
    setCanvasCursor();
    if (had && S.cb.onPointerUp) S.cb.onPointerUp();
  }

  function onPointerCancel(e) {
    S.pointers.delete(e.pointerId);
    S.pinch = null;
    S.drag = null;
    S.box = null;
    setCanvasCursor();
    requestRender();
  }

  function onWheel(e) {
    e.preventDefault();
    var p = localPos(e);
    var factor = e.deltaY < 0 ? 1.14 : (e.deltaY > 0 ? 1 / 1.14 : 1);
    if (e.deltaMode === 1) factor = e.deltaY < 0 ? 1.2 : 1 / 1.2;
    zoomAt(factor, p.x, p.y);
  }

  function onPointerLeave() {
    S.cursor.inside = false;
    if (S.mode === 'inspect') {
      S.hover = null;
      requestRender();
      if (S.cb.onHover) S.cb.onHover(null);
    }
    if (S.cb.onCursor) S.cb.onCursor({ inside: false });
  }

  /* ------------------------------------------------------------------ */
  /* API                                                                 */
  /* ------------------------------------------------------------------ */
  function init(canvas, cb) {
    S.canvas = canvas;
    S.ctx = canvas.getContext('2d', { alpha: false });
    S.cb = cb || {};
    S.indexDirty = true;

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerCancel);
    canvas.addEventListener('pointerleave', onPointerLeave);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });

    if (root.ResizeObserver) {
      var ro = new ResizeObserver(function () { resize(); });
      ro.observe(canvas);
    } else {
      root.addEventListener('resize', resize);
    }
    resize();
    setCanvasCursor();
  }

  function setFiles(files) {
    S.files = files || [];
    S.indexDirty = true;
    requestRender();
  }

  function setView(view) {
    if (!AXES[view]) return;
    S.view = view;
    S.indexDirty = true;
    fit();
    if (S.cb.onView) S.cb.onView(view);
  }

  function setOrigin(o) {
    S.origin = { x: o.x, y: o.y, z: o.z };
    requestRender();
  }

  function setMode(mode) {
    S.mode = mode || 'pan';
    if (S.mode !== 'inspect') {
      S.hover = null;
      requestRender();
    }
    if (S.mode !== 'zoomwin') S.box = null;
    setCanvasCursor();
  }

  function setColorMode(mode) {
    S.colorMode = mode === 'file' ? 'file' : 'type';
    requestRender();
  }

  function clearSelection() {
    S.selected = null;
    S.hover = null;
    requestRender();
  }

  function refresh() {
    S.indexDirty = true;
    requestRender();
  }

  root.GTViewer = {
    init: init,
    setFiles: setFiles,
    setView: setView,
    setOrigin: setOrigin,
    setMode: setMode,
    setColorMode: setColorMode,
    clearSelection: clearSelection,
    refresh: refresh,
    fit: fit,
    panBy: panBy,
    zoomIn: function () { zoomAt(1.35); },
    zoomOut: function () { zoomAt(1 / 1.35); },
    zoomAt: zoomAt,
    getScale: function () { return S.cam.scale; },
    getView: function () { return S.view; },
    getAxes: function () { return AXES[S.view]; },
    getOrigin: function () { return { x: S.origin.x, y: S.origin.y, z: S.origin.z }; },
    getSelection: function () { return S.selected; },
    worldToScreen: function (x, y, z) {
      var A = AXES[S.view];
      var u = A.u === 'x' ? x : (A.u === 'y' ? y : z);
      var v = A.v === 'x' ? x : (A.v === 'y' ? y : z);
      return worldToScreen(u, v);
    },
    screenToWorld: function (sx, sy) {
      var w = screenToWorld(sx, sy);
      var A = AXES[S.view];
      var p = { x: 0, y: 0, z: 0 };
      p[A.u] = w.u;
      p[A.v] = w.v;
      p[A.w] = S.origin[A.w];
      return p;
    },
    setProgress: function (fileId, count, currentSegIndex) {
      if (!fileId) {
        S.progress = null;
      } else {
        S.progress = {
          fileId: fileId,
          count: Math.max(0, Math.round(Number(count) || 0)),
          currentSegIndex: (currentSegIndex === null || currentSegIndex === undefined)
            ? null : Math.round(Number(currentSegIndex))
        };
      }
      requestRender();
    },
    getProgress: function () { return S.progress; },
    resize: resize,
    render: render
  };
})(typeof window !== 'undefined' ? window : globalThis);
