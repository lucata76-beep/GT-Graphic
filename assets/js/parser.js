/*!
 * GT-Graphic - Parser G-Code ISO / FANUC
 * -------------------------------------------------------------
 * Interpreta un programma ISO (Fanuc 0i / 31i / Series 30i) e
 * produce una lista di segmenti geometrici 3D (X,Y,Z) con
 * metadati (riga, blocco originale, numero N, tipo movimento,
 * centro/raggio per gli archi, feed).
 *
 * Supporto:
 *  - G00 / G01 / G02 / G03 (modali)
 *  - Piani G17 (X-Y), G18 (Z-X), G19 (Y-Z)
 *  - Archi con centro incrementale I/J/K e con raggio R (+/-)
 *  - Quote assolute G90 / incrementali G91
 *  - Unita' G20 (inch) / G21 (mm) - conversione interna in mm
 *  - Eliche (variazione dell'asse fuori piano durante G02/G03)
 *  - Commenti (...) e ; , salto blocchi %, block delete /
 *  - File senza estensione: il parser lavora solo sul testo
 *
 * Il parser non lancia eccezioni: ogni blocco e' protetto e gli
 * errori vengono raccolti in program.warnings.
 * -------------------------------------------------------------
 */
(function (root) {
  'use strict';

  var TWO_PI = Math.PI * 2;

  /* Piani Fanuc.
   * a/b = assi del piano nell'ordine del sistema Fanuc:
   *   G17 -> X,Y   (normale +Z)
   *   G18 -> Z,X   (normale +Y)
   *   G19 -> Y,Z   (normale +X)
   * ai/bi = lettere dei centroidi incrementali relative ad a/b.
   */
  var PLANES = {
    17: { a: 'x', b: 'y', ai: 'i', bi: 'j', c: 'z', name: 'X-Y' },
    18: { a: 'z', b: 'x', ai: 'k', bi: 'i', c: 'y', name: 'Z-X' },
    19: { a: 'y', b: 'z', ai: 'j', bi: 'k', c: 'x', name: 'Y-Z' }
  };

  var WORD_RE = /([A-Z])\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+))/g;

  var RAPID_RATE = 20000; // mm/min, solo per stima tempo

  function stripComments(line) {
    // Commenti Fanuc tra parentesi (anche piu' blocchi sulla riga)
    var s = line.replace(/\([^)]*\)/g, ' ');
    // Commento da punto e virgola a fine riga
    var semi = s.indexOf(';');
    if (semi >= 0) s = s.slice(0, semi);
    return s;
  }

  function sweepFor(startAngle, endAngle, cw) {
    var d = ((endAngle - startAngle) % TWO_PI + TWO_PI) % TWO_PI; // [0, 2PI)
    if (cw) return d === 0 ? -TWO_PI : d - TWO_PI;
    return d === 0 ? TWO_PI : d;
  }

  function fmtNum(v) {
    if (!isFinite(v)) return '0';
    var s = v.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
    return s === '-0' ? '0' : s;
  }

  /**
   * @param {string} text contenuto del file
   * @param {object} [options] { micronNoDecimal:boolean }
   * @returns {object} programma
   */
  function parse(text, options) {
    var opts = Object.assign({ micronNoDecimal: false }, options || {});
    var src = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
    var lines = src.split('\n');

    var segments = [];
    var byType = { 0: [], 1: [], 2: [], 3: [] };
    var warnings = [];
    var warned = Object.create(null);

    var stats = {
      segments: 0,
      byType: { 0: 0, 1: 0, 2: 0, 3: 0 },
      length: { 0: 0, 1: 0, 2: 0, 3: 0 },
      total: 0,
      rapid: 0,
      cut: 0,
      time: 0,          // secondi stimati
      feedMin: Infinity,
      feedMax: 0
    };
    var bounds = {
      minX: Infinity, maxX: -Infinity,
      minY: Infinity, maxY: -Infinity,
      minZ: Infinity, maxZ: -Infinity
    };

    // Stato modale
    var x = 0, y = 0, z = 0;
    var motion = 0;
    var planeNum = 17;
    var absolute = true;
    var unitScale = 1;        // mm per unita' programma
    var unitName = 'mm';
    var feed = 0;             // mm/min
    var programName = null;
    var blockCount = 0;

    function warn(lineNo, block, message) {
      var key = message;
      if (warned[key] && warned[key].line !== lineNo) return;
      if (warnings.length >= 80) return;
      warned[key] = { line: lineNo };
      warnings.push({ line: lineNo, block: block, message: message });
    }

    function axisValue(letter, words) {
      var w = words[letter];
      if (!w) return null;
      var v = w.value;
      if (opts.micronNoDecimal && !w.hasDecimal) {
        // Fanuc: valore senza punto decimale = incremento minimo
        v = v / (unitScale === 25.4 ? 10000 : 1000);
      }
      return v * unitScale;
    }

    function offsetValue(letter, words) {
      // I/J/K/R: stessa regola delle quote
      return axisValue(letter, words);
    }

    function pushSegment(seg) {
      segments.push(seg);
      byType[seg.type].push(seg);
      stats.segments++;
      stats.byType[seg.type]++;
      stats.length[seg.type] += seg.length;
      stats.total += seg.length;
      if (seg.type === 0) stats.rapid += seg.length;
      else stats.cut += seg.length;

      if (seg.type !== 0 && seg.feed > 0) {
        stats.time += (seg.length / seg.feed) * 60;
        if (seg.feed < stats.feedMin) stats.feedMin = seg.feed;
        if (seg.feed > stats.feedMax) stats.feedMax = seg.feed;
      } else if (seg.type === 0) {
        stats.time += (seg.length / RAPID_RATE) * 60;
      }

      var b = seg.bounds;
      if (b.minX < bounds.minX) bounds.minX = b.minX;
      if (b.maxX > bounds.maxX) bounds.maxX = b.maxX;
      if (b.minY < bounds.minY) bounds.minY = b.minY;
      if (b.maxY > bounds.maxY) bounds.maxY = b.maxY;
      if (b.minZ < bounds.minZ) bounds.minZ = b.minZ;
      if (b.maxZ > bounds.maxZ) bounds.maxZ = b.maxZ;
    }

    function makeBounds(pts) {
      var b = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity };
      for (var i = 0; i < pts.length; i += 3) {
        var px = pts[i], py = pts[i + 1], pz = pts[i + 2];
        if (px < b.minX) b.minX = px;
        if (px > b.maxX) b.maxX = px;
        if (py < b.minY) b.minY = py;
        if (py > b.maxY) b.maxY = py;
        if (pz < b.minZ) b.minZ = pz;
        if (pz > b.maxZ) b.maxZ = pz;
      }
      return b;
    }

    function polylineLength(pts) {
      var len = 0;
      for (var i = 3; i < pts.length; i += 3) {
        var dx = pts[i] - pts[i - 3];
        var dy = pts[i + 1] - pts[i - 2];
        var dz = pts[i + 2] - pts[i - 1];
        len += Math.sqrt(dx * dx + dy * dy + dz * dz);
      }
      return len;
    }

    function addLine(type, nx, ny, nz, meta) {
      var dx = nx - x, dy = ny - y, dz = nz - z;
      var len = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (len < 1e-7) return null;
      var pts = new Float64Array(6);
      pts[0] = x; pts[1] = y; pts[2] = z;
      pts[3] = nx; pts[4] = ny; pts[5] = nz;
      var seg = {
        type: type,
        x0: x, y0: y, z0: z,
        x1: nx, y1: ny, z1: nz,
        pts: pts,
        length: len,
        line: meta.line,
        n: meta.n,
        block: meta.block,
        feed: meta.feed,
        plane: planeNum,
        bounds: makeBounds(pts)
      };
      pushSegment(seg);
      return seg;
    }

    function addArc(type, nx, ny, nz, words, meta) {
      var P = PLANES[planeNum];
      var start = { x: x, y: y, z: z };
      var end = { x: nx, y: ny, z: nz };
      var sa = start[P.a];
      var sb = start[P.b];
      var ea = end[P.a];
      var eb = end[P.b];

      var offA = offsetValue(P.ai.toUpperCase(), words);
      var offB = offsetValue(P.bi.toUpperCase(), words);
      var hasIJK = offA !== null || offB !== null;
      var R = offsetValue('R', words);

      var ca, cb, radius, sweep, startAngle, endAngle;

      if (hasIJK) {
        ca = sa + (offA || 0);
        cb = sb + (offB || 0);
        radius = Math.sqrt((sa - ca) * (sa - ca) + (sb - cb) * (sb - cb));
        if (!(radius > 1e-9)) {
          warn(meta.line, meta.block, 'Arco con raggio nullo: I/J/K non validi, blocco tracciato come G01.');
          return addLine(1, nx, ny, nz, meta);
        }
        startAngle = Math.atan2(sb - cb, sa - ca);
        endAngle = Math.atan2(eb - cb, ea - ca);
        sweep = sweepFor(startAngle, endAngle, type === 2);
      } else if (R !== null) {
        var dx = ea - sa, dy = eb - sb;
        var dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 1e-9) {
          warn(meta.line, meta.block, 'Arco con R e punto di arrivo coincidente: impossibile determinare il centro.');
          return null;
        }
        var rr = Math.abs(R);
        if (rr < dist / 2 - 1e-9) {
          warn(meta.line, meta.block, 'Raggio R troppo piccolo rispetto alla corda: valore corretto a meta\' corda.');
          rr = dist / 2;
        }
        var h = Math.sqrt(Math.max(0, rr * rr - (dist * dist) / 4));
        var mx = (sa + ea) / 2, my = (sb + eb) / 2;
        var ux = -dy / dist, uy = dx / dist;
        var cand = [
          { a: mx + ux * h, b: my + uy * h },
          { a: mx - ux * h, b: my - uy * h }
        ];
        var wantMajor = R < 0;
        var chosen = null;
        for (var ci = 0; ci < cand.length; ci++) {
          var c = cand[ci];
          var a0 = Math.atan2(sb - c.b, sa - c.a);
          var a1 = Math.atan2(eb - c.b, ea - c.a);
          var sw = sweepFor(a0, a1, type === 2);
          var major = Math.abs(sw) > Math.PI + 1e-7;
          if (major === wantMajor) {
            chosen = { c: c, s: a0, e: a1, sweep: sw };
            break;
          }
        }
        if (!chosen) {
          // Semicerchio esatto o caso ambiguo: prendi l'arco piu' corto/lungo
          var best = null;
          for (var cj = 0; cj < cand.length; cj++) {
            var cc = cand[cj];
            var b0 = Math.atan2(sb - cc.b, sa - cc.a);
            var b1 = Math.atan2(eb - cc.b, ea - cc.a);
            var sw2 = sweepFor(b0, b1, type === 2);
            if (!best || (wantMajor ? Math.abs(sw2) > Math.abs(best.sweep) : Math.abs(sw2) < Math.abs(best.sweep))) {
              best = { c: cc, s: b0, e: b1, sweep: sw2 };
            }
          }
          chosen = best;
        }
        ca = chosen.c.a;
        cb = chosen.c.b;
        radius = rr;
        startAngle = chosen.s;
        endAngle = chosen.e;
        sweep = chosen.sweep;
      } else {
        warn(meta.line, meta.block, 'Arco G0' + type + ' senza I/J/K o R: blocco tracciato come G01.');
        return addLine(1, nx, ny, nz, meta);
      }

      var rEnd = Math.sqrt((ea - ca) * (ea - ca) + (eb - cb) * (eb - cb));
      if (Math.abs(rEnd - radius) > Math.max(0.05, radius * 0.01)) {
        warn(meta.line, meta.block, 'Raggio di arrivo incoerente con il centro (' + fmtNum(rEnd) + ' vs ' + fmtNum(radius) + ' mm).');
      }

      // Campionamento con tolleranza di corda 0.01 mm
      var tol = 0.01;
      var stepAng = radius > tol ? 2 * Math.acos(Math.max(-1, 1 - tol / radius)) : Math.PI / 8;
      var n = Math.ceil(Math.abs(sweep) / stepAng);
      if (!isFinite(n) || n < 8) n = 8;
      if (n > 1440) n = 1440;

      var pts = new Float64Array((n + 1) * 3);
      var cStart = start[P.c];
      var cEnd = end[P.c];

      for (var k = 0; k <= n; k++) {
        var t = k / n;
        var ang = startAngle + sweep * t;
        var av = ca + radius * Math.cos(ang);
        var bv = cb + radius * Math.sin(ang);
        var cv = cStart + (cEnd - cStart) * t;
        var px, py, pz;
        if (planeNum === 17) { px = av; py = bv; pz = cv; }
        else if (planeNum === 18) { pz = av; px = bv; py = cv; }
        else { py = av; pz = bv; px = cv; }
        pts[k * 3] = px;
        pts[k * 3 + 1] = py;
        pts[k * 3 + 2] = pz;
      }
      // Ancoraggio esatto agli estremi
      pts[0] = x; pts[1] = y; pts[2] = z;
      pts[n * 3] = nx; pts[n * 3 + 1] = ny; pts[n * 3 + 2] = nz;

      var center = { x: 0, y: 0, z: 0 };
      if (planeNum === 17) { center.x = ca; center.y = cb; center.z = cStart; }
      else if (planeNum === 18) { center.z = ca; center.x = cb; center.y = cStart; }
      else { center.y = ca; center.z = cb; center.x = cStart; }

      var seg = {
        type: type,
        x0: x, y0: y, z0: z,
        x1: nx, y1: ny, z1: nz,
        pts: pts,
        length: polylineLength(pts),
        line: meta.line,
        n: meta.n,
        block: meta.block,
        feed: meta.feed,
        plane: planeNum,
        cw: type === 2,
        radius: radius,
        sweep: sweep,
        center: center,
        i: offA,
        j: offB,
        r: R,
        bounds: makeBounds(pts)
      };
      pushSegment(seg);
      return seg;
    }

    // ------------------------------------------------------------------
    // Ciclo sulle righe
    // ------------------------------------------------------------------
    for (var i = 0; i < lines.length; i++) {
      var rawLine = lines[i];
      var trimmed = rawLine.trim();
      if (!trimmed) continue;
      if (trimmed.charAt(0) === '%') continue;
      if (trimmed.charAt(0) === '/') continue; // block delete

      var lineNo = i + 1;
      var code = stripComments(trimmed).toUpperCase().trim();
      if (!code) continue;
      blockCount++;

      try {
        var words = Object.create(null);
        var tokens = [];
        var m;
        WORD_RE.lastIndex = 0;
        while ((m = WORD_RE.exec(code)) !== null) {
          var letter = m[1];
          var rawVal = m[2];
          var hasDecimal = rawVal.indexOf('.') >= 0;
          var value = parseFloat(rawVal);
          if (!isFinite(value)) continue;
          var token = { letter: letter, value: value, hasDecimal: hasDecimal };
          words[letter] = token;
          tokens.push(token);
        }

        // Codici G modali (applicati prima della geometria del blocco)
        for (var ti = 0; ti < tokens.length; ti++) {
          var tok = tokens[ti];
          if (tok.letter !== 'G') continue;
          var g = tok.value;
          var gi = Math.round(g);
          if (Math.abs(g - gi) > 1e-9) continue; // G90.1, G51.1 ... ignorati

          if (gi === 0 || gi === 1 || gi === 2 || gi === 3) {
            motion = gi;
          } else if (gi === 17 || gi === 18 || gi === 19) {
            planeNum = gi;
          } else if (gi === 20) {
            unitScale = 25.4;
            unitName = 'in';
          } else if (gi === 21) {
            unitScale = 1;
            unitName = 'mm';
          } else if (gi === 90) {
            absolute = true;
          } else if (gi === 91) {
            absolute = false;
          } else if (gi === 28 || gi === 30) {
            warn(lineNo, trimmed, 'G' + gi + ' (ritorno a zero macchina) non viene tracciato.');
          } else if (gi === 53) {
            warn(lineNo, trimmed, 'G53 (coordinate macchina) non viene tracciato.');
          } else if (gi === 92) {
            warn(lineNo, trimmed, 'G92 (preset coordinate) non viene applicato al tracciamento.');
          } else if (gi === 68) {
            warn(lineNo, trimmed, 'G68 (rotazione sistema) non viene applicata al tracciamento.');
          } else if (gi >= 73 && gi <= 89 && gi !== 80) {
            warn(lineNo, trimmed, 'Ciclo fisso G' + gi + ' non supportato: la geometria del ciclo non viene tracciata.');
          }
        }

        // Feed
        if (words.F) {
          var fRaw = words.F.value;
          feed = fRaw * unitScale;
        }

        // Nome programma (O1234)
        if (words.O && programName === null) {
          programName = 'O' + Math.round(words.O.value);
        }

        // Quote
        var ax = axisValue('X', words);
        var ay = axisValue('Y', words);
        var az = axisValue('Z', words);
        var hasAxis = ax !== null || ay !== null || az !== null;

        if (!hasAxis) continue;

        var nx = ax === null ? x : (absolute ? ax : x + ax);
        var ny = ay === null ? y : (absolute ? ay : y + ay);
        var nz = az === null ? z : (absolute ? az : z + az);

        var meta = {
          line: lineNo,
          n: words.N ? 'N' + Math.round(words.N.value) : null,
          block: trimmed,
          feed: feed
        };

        if (motion === 0 || motion === 1) {
          addLine(motion, nx, ny, nz, meta);
        } else {
          addArc(motion, nx, ny, nz, words, meta);
        }

        x = nx; y = ny; z = nz;
      } catch (err) {
        if (warnings.length < 80) {
          warnings.push({ line: lineNo, block: trimmed, message: 'Errore di parsing: ' + (err && err.message ? err.message : String(err)) });
        }
      }
    }

    if (!isFinite(bounds.minX)) bounds = null;

    return {
      name: programName,
      unit: unitName,
      lines: lines.length,
      blocks: blockCount,
      segments: segments,
      byType: byType,
      stats: stats,
      bounds: bounds,
      warnings: warnings,
      finalPosition: { x: x, y: y, z: z }
    };
  }

  root.GTParser = {
    version: '1.0.0',
    parse: parse,
    PLANES: PLANES,
    fmtNum: fmtNum
  };
})(typeof window !== 'undefined' ? window : globalThis);
