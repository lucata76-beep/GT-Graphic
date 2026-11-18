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

  /* ------------------------------------------------------------------
   * Custom Macro B: tokenizer, espressioni e funzioni
   * ------------------------------------------------------------------ */
  var MACRO_MAX_STEPS = 50000;
  var MACRO_MAX_SEGMENTS = 50000;
  var MACRO_EPS = 1e-7;

  var MACRO_KEYS = { GOTO: 1, IF: 1, THEN: 1, WHILE: 1, DO: 1, END: 1 };
  var MACRO_FUNCS = {
    ABS: 1, ACOS: 1, ASIN: 1, ATAN: 1, COS: 1, EXP: 1, FIX: 1,
    FUP: 1, LN: 1, ROUND: 1, SIN: 1, SQRT: 1, TAN: 1
  };
  var MACRO_CMP = { EQ: 1, NE: 1, GT: 1, GE: 1, LT: 1, LE: 1 };
  var MACRO_LOGIC = { AND: 1, OR: 1, XOR: 1 };
  var MACRO_NAMES = Object.keys(MACRO_KEYS)
    .concat(Object.keys(MACRO_FUNCS), Object.keys(MACRO_CMP), Object.keys(MACRO_LOGIC), ['MOD'])
    .sort(function (a, b) { return b.length - a.length; });

  function tokenizeMacro(code) {
    var tokens = [];
    var s = String(code == null ? '' : code).toUpperCase();
    var i = 0;
    while (i < s.length) {
      var c = s.charAt(i);
      if (c === ' ' || c === '\t') { i++; continue; }

      if (c === '#') {
        var vj = i + 1;
        while (vj < s.length && s.charAt(vj) >= '0' && s.charAt(vj) <= '9') vj++;
        if (vj === i + 1) { i++; continue; }
        tokens.push({ type: 'VAR', value: parseInt(s.slice(i + 1, vj), 10) });
        i = vj;
        continue;
      }

      if ((c >= '0' && c <= '9') || c === '.') {
        var nj = i;
        var dot = false;
        while (nj < s.length) {
          var nc = s.charAt(nj);
          if (nc >= '0' && nc <= '9') { nj++; continue; }
          if (nc === '.' && !dot) { dot = true; nj++; continue; }
          break;
        }
        var ntext = s.slice(i, nj);
        var nval = parseFloat(ntext);
        if (isFinite(nval)) tokens.push({ type: 'NUM', value: nval, text: ntext });
        i = nj;
        continue;
      }

      if (c >= 'A' && c <= 'Z') {
        var wj = i;
        while (wj < s.length && s.charAt(wj) >= 'A' && s.charAt(wj) <= 'Z') wj++;
        var word = s.slice(i, wj);
        var matched = null;
        for (var k = 0; k < MACRO_NAMES.length; k++) {
          if (word.indexOf(MACRO_NAMES[k]) === 0) { matched = MACRO_NAMES[k]; break; }
        }
        if (matched) {
          var mt = MACRO_KEYS[matched] ? 'KEY'
            : MACRO_FUNCS[matched] ? 'FUNC'
              : MACRO_CMP[matched] ? 'CMP'
                : MACRO_LOGIC[matched] ? 'LOGIC' : 'OP';
          tokens.push({ type: mt, value: matched });
          i += matched.length;
        } else {
          tokens.push({ type: 'WORD', value: word.charAt(0) });
          i += 1;
        }
        continue;
      }

      if ('+-*/[]=,'.indexOf(c) >= 0) {
        tokens.push({ type: 'OP', value: c });
        i++;
        continue;
      }
      i++;
    }
    return tokens;
  }

  function macroEq(a, b) {
    return Math.abs(a - b) <= MACRO_EPS;
  }

  function macroFunc(name, v, v2) {
    switch (name) {
      case 'ABS': return Math.abs(v);
      case 'SIN': return Math.sin(v * Math.PI / 180);
      case 'COS': return Math.cos(v * Math.PI / 180);
      case 'TAN': return Math.tan(v * Math.PI / 180);
      case 'ASIN': return Math.asin(Math.max(-1, Math.min(1, v))) * 180 / Math.PI;
      case 'ACOS': return Math.acos(Math.max(-1, Math.min(1, v))) * 180 / Math.PI;
      case 'ATAN':
        if (v2 !== undefined) return Math.atan2(v, v2) * 180 / Math.PI;
        return Math.atan(v) * 180 / Math.PI;
      case 'SQRT':
        if (v < 0) throw new Error('SQRT di un numero negativo');
        return Math.sqrt(v);
      case 'ROUND': return v < 0 ? -Math.round(-v) : Math.round(v);
      case 'FIX': return Math.floor(v);
      case 'FUP': return Math.ceil(v);
      case 'LN':
        if (v <= 0) throw new Error('LN di un numero non positivo');
        return Math.log(v);
      case 'EXP': return Math.exp(v);
      default: throw new Error('funzione macro sconosciuta ' + name);
    }
  }

  function macroNum(v) {
    if (!isFinite(v)) return '0';
    var s = v.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
    if (s === '-0' || s === '') s = '0';
    if (s.indexOf('.') < 0) s += '.0';
    return s;
  }

  function MacroExpr(tokens, start, vars) {
    this.tokens = tokens;
    this.pos = start;
    this.vars = vars;
  }

  MacroExpr.prototype.peek = function () { return this.tokens[this.pos] || null; };
  MacroExpr.prototype.next = function () { return this.tokens[this.pos++] || null; };
  MacroExpr.prototype.matchOp = function (v) {
    var t = this.peek();
    if (t && t.type === 'OP' && t.value === v) { this.pos++; return true; }
    return false;
  };
  MacroExpr.prototype.expectOp = function (v) {
    if (!this.matchOp(v)) throw new Error('atteso "' + v + '"');
  };

  MacroExpr.prototype.parseValue = function () {
    var start = this.pos;
    var value = this.parseOr();
    var end = this.pos;
    if (end === start) throw new Error('espressione vuota');
    var literal = false;
    var literalText = '';
    if (end - start === 1 && this.tokens[start].type === 'NUM') {
      literal = true;
      literalText = this.tokens[start].text;
    } else if (end - start === 2 &&
      this.tokens[start].type === 'OP' &&
      (this.tokens[start].value === '+' || this.tokens[start].value === '-') &&
      this.tokens[start + 1].type === 'NUM') {
      literal = true;
      literalText = this.tokens[start].value + this.tokens[start + 1].text;
    }
    if (!isFinite(value)) throw new Error('risultato non finito');
    return { value: value, pos: end, literal: literal, literalText: literalText };
  };

  MacroExpr.prototype.parseOr = function () {
    var v = this.parseXor();
    while (this.peek() && this.peek().type === 'LOGIC' && this.peek().value === 'OR') {
      this.pos++;
      v = (v | 0) | (this.parseXor() | 0);
    }
    return v;
  };

  MacroExpr.prototype.parseXor = function () {
    var v = this.parseAnd();
    while (this.peek() && this.peek().type === 'LOGIC' && this.peek().value === 'XOR') {
      this.pos++;
      v = (v | 0) ^ (this.parseAnd() | 0);
    }
    return v;
  };

  MacroExpr.prototype.parseAnd = function () {
    var v = this.parseCmp();
    while (this.peek() && this.peek().type === 'LOGIC' && this.peek().value === 'AND') {
      this.pos++;
      v = (v | 0) & (this.parseCmp() | 0);
    }
    return v;
  };

  MacroExpr.prototype.parseCmp = function () {
    var v = this.parseAdd();
    while (this.peek() && this.peek().type === 'CMP') {
      var op = this.next().value;
      var r = this.parseAdd();
      if (op === 'EQ') v = macroEq(v, r) ? 1 : 0;
      else if (op === 'NE') v = macroEq(v, r) ? 0 : 1;
      else if (op === 'GT') v = v > r ? 1 : 0;
      else if (op === 'GE') v = v >= r ? 1 : 0;
      else if (op === 'LT') v = v < r ? 1 : 0;
      else if (op === 'LE') v = v <= r ? 1 : 0;
    }
    return v;
  };

  MacroExpr.prototype.parseAdd = function () {
    var v = this.parseMul();
    while (this.peek() && this.peek().type === 'OP' &&
      (this.peek().value === '+' || this.peek().value === '-')) {
      var op = this.next().value;
      var r = this.parseMul();
      v = op === '+' ? v + r : v - r;
    }
    return v;
  };

  MacroExpr.prototype.parseMul = function () {
    var v = this.parseUnary();
    while (this.peek() && this.peek().type === 'OP' &&
      (this.peek().value === '*' || this.peek().value === '/' || this.peek().value === 'MOD')) {
      var op = this.next().value;
      var r = this.parseUnary();
      if (op === '*') v = v * r;
      else if (op === '/') {
        if (Math.abs(r) < 1e-15) throw new Error('divisione per zero');
        v = v / r;
      } else {
        if (Math.abs(r) < 1e-15) throw new Error('MOD per zero');
        v = v % r;
      }
    }
    return v;
  };

  MacroExpr.prototype.parseUnary = function () {
    if (this.peek() && this.peek().type === 'OP' &&
      (this.peek().value === '+' || this.peek().value === '-')) {
      var op = this.next().value;
      var v = this.parseUnary();
      return op === '-' ? -v : v;
    }
    return this.parsePrimary();
  };

  MacroExpr.prototype.parsePrimary = function () {
    var t = this.peek();
    if (!t) throw new Error('espressione incompleta');
    if (t.type === 'NUM') { this.pos++; return t.value; }
    if (t.type === 'VAR') {
      this.pos++;
      var val = this.vars[t.value];
      return isFinite(val) ? val : 0;
    }
    if (t.type === 'OP' && t.value === '[') {
      this.pos++;
      var v = this.parseOr();
      this.expectOp(']');
      return v;
    }
    if (t.type === 'FUNC') {
      this.pos++;
      var name = t.value;
      this.expectOp('[');
      var arg = this.parseOr();
      this.expectOp(']');
      if (name === 'ATAN' && this.peek() && this.peek().type === 'OP' && this.peek().value === '/') {
        var save = this.pos;
        this.pos++;
        if (this.peek() && this.peek().type === 'OP' && this.peek().value === '[') {
          this.pos++;
          var arg2 = this.parseOr();
          this.expectOp(']');
          return macroFunc(name, arg, arg2);
        }
        this.pos = save;
      }
      return macroFunc(name, arg);
    }
    throw new Error('token inatteso "' + (t.value || t.type) + '"');
  };

  function resolveMacroWords(tokens, vars) {
    var out = [];
    var i = 0;
    while (i < tokens.length) {
      var t = tokens[i];
      if (t.type !== 'WORD') { i++; continue; }
      var letter = t.value;
      i++;
      if (i >= tokens.length || tokens[i].type === 'WORD' || tokens[i].type === 'KEY' ||
          tokens[i].type === 'LOGIC' || tokens[i].type === 'CMP' ||
          (tokens[i].type === 'OP' && tokens[i].value !== '[' && tokens[i].value !== '+' && tokens[i].value !== '-')) {
        out.push(letter);
        continue;
      }
      var res = new MacroExpr(tokens, i, vars).parseValue();
      i = res.pos;
      var text;
      if (letter === 'N' || letter === 'M' || letter === 'O') {
        text = String(Math.round(res.value));
      } else if (letter === 'G') {
        text = Math.abs(res.value - Math.round(res.value)) > 1e-9
          ? macroNum(res.value)
          : String(Math.round(res.value));
      } else if (res.literal) {
        text = res.literalText;
      } else {
        text = macroNum(res.value);
      }
      out.push(letter + text);
    }
    return out.join(' ');
  }

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
    var spindle = 0;          // rpm
    var tool = null;          // numero utensile
    var cutter = 40;          // G40/G41/G42
    var toolLength = 49;      // G43/G44/G49
    var workOffset = 54;      // G54-G59
    var feedMode = 94;        // G94/G95
    var mRecent = [];
    var programName = null;
    var blockCount = 0;
    var vars = Object.create(null);
    var labels = Object.create(null);
    var activeN = null;
    var macroSteps = 0;
    var macroJumps = 0;
    var macroLimit = false;
    var maxMacroSteps = opts.maxMacroSteps || MACRO_MAX_STEPS;
    var maxMacroSegments = opts.maxSegments || MACRO_MAX_SEGMENTS;
    var steps = [];
    var varEvents = [];
    var currentVarChanges = [];
    var currentM = [];
    var currentKind = 'misc';
    var currentJump = null;
    var currentMeaningful = false;
    var lastSegIndex = null;
    var MAX_VAR_HISTORY = 2000;

    function warn(lineNo, block, message) {
      var key = message;
      if (warned[key]) return;
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
      seg.index = segments.length;
      lastSegIndex = seg.index;
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

    function setVar(name, value) {
      var old = vars[name];
      if (typeof old === 'undefined') old = 0;
      vars[name] = value;
      currentVarChanges.push({ name: name, value: value, old: old });
    }

    function activeG() {
      var all = [
        'G' + motion,
        'G' + planeNum,
        unitName === 'in' ? 'G20' : 'G21',
        absolute ? 'G90' : 'G91',
        'G' + cutter,
        'G' + toolLength,
        'G' + workOffset,
        'G' + feedMode
      ];
      var out = [];
      for (var i = 0; i < all.length; i++) {
        if (out.indexOf(all[i]) < 0) out.push(all[i]);
      }
      return out;
    }

    function pushStep(lineNo, block, nLabel, kind, jump) {
      var st = {
        index: steps.length,
        line: lineNo,
        block: block,
        n: nLabel || activeN,
        kind: kind || currentKind,
        jump: (jump === undefined || jump === null) ? null : jump,
        g: activeG(),
        m: currentM.slice(),
        mRecent: mRecent.slice(-6),
        f: feed,
        s: spindle,
        t: tool,
        x: x, y: y, z: z,
        segIndex: lastSegIndex,
        segCount: segments.length,
        varChanges: currentVarChanges.slice()
      };
      steps.push(st);
      for (var i = 0; i < currentVarChanges.length; i++) {
        var ch = currentVarChanges[i];
        varEvents.push({ name: ch.name, value: ch.value, old: ch.old, step: st.index, line: lineNo });
      }
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

    function macroValue(tokens, pos, lineNo, rawBlock) {
      try {
        return new MacroExpr(tokens, pos, vars).parseValue();
      } catch (err) {
        warn(lineNo, rawBlock, 'Macro: ' + (err && err.message ? err.message : String(err)));
        return null;
      }
    }

    function readGotoTarget(tokens, pos, lineNo, rawBlock) {
      if (tokens[pos] && tokens[pos].type === 'WORD' && tokens[pos].value === 'N') pos++;
      var res = macroValue(tokens, pos, lineNo, rawBlock);
      if (!res) return null;
      return Math.round(res.value);
    }

    function executeResolvedBlock(code, lineNo, rawBlock, nLabel) {
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
      if (tokens.length) currentMeaningful = true;

      var suppress = false;
      for (var ti = 0; ti < tokens.length; ti++) {
        var tok = tokens[ti];
        if (tok.letter !== 'G') continue;
        var g = tok.value;
        var gi = Math.round(g);
        if (Math.abs(g - gi) > 1e-9) continue;

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
          warn(lineNo, rawBlock, 'G' + gi + ' (ritorno a zero macchina) non viene tracciato.');
          suppress = true;
        } else if (gi === 52) {
          if ((words.X && Math.abs(words.X.value) > 1e-12) ||
              (words.Y && Math.abs(words.Y.value) > 1e-12) ||
              (words.Z && Math.abs(words.Z.value) > 1e-12)) {
            warn(lineNo, rawBlock, 'G52 (offset locale) non applicato: il percorso usa le coordinate del programma.');
          }
          suppress = true;
        } else if (gi === 53) {
          warn(lineNo, rawBlock, 'G53 (coordinate macchina) non viene tracciato.');
          suppress = true;
        } else if (gi === 92) {
          warn(lineNo, rawBlock, 'G92 (preset coordinate) non viene applicato al tracciamento.');
          suppress = true;
        } else if (gi === 68) {
          warn(lineNo, rawBlock, 'G68 (rotazione sistema) non viene applicata al tracciamento.');
          suppress = true;
        } else if (gi === 40 || gi === 41 || gi === 42) {
          cutter = gi;
          if (gi === 41 || gi === 42) {
            warn(lineNo, rawBlock, 'Compensazione utensile G41/G42 non applicata: viene tracciato il percorso programmato.');
          }
        } else if (gi === 43 || gi === 44 || gi === 49) {
          toolLength = gi;
        } else if (gi === 94 || gi === 95) {
          feedMode = gi;
        } else if (gi >= 54 && gi <= 59) {
          workOffset = gi;
        } else if (gi >= 73 && gi <= 89 && gi !== 80) {
          warn(lineNo, rawBlock, 'Ciclo fisso G' + gi + ' non supportato: la geometria del ciclo non viene tracciata.');
          suppress = true;
        }
      }

      if (words.F) {
        feed = words.F.value * unitScale;
      }

      for (var wi = 0; wi < tokens.length; wi++) {
        var wt = tokens[wi];
        if (wt.letter === 'S') {
          spindle = wt.value;
        } else if (wt.letter === 'T') {
          tool = Math.round(wt.value);
        } else if (wt.letter === 'M') {
          var mc = Math.round(wt.value);
          currentM.push(mc);
          if (mRecent.indexOf(mc) < 0) {
            mRecent.push(mc);
            if (mRecent.length > 8) mRecent.shift();
          }
        }
      }

      if (words.O && programName === null) {
        programName = 'O' + Math.round(words.O.value);
      }

      var stop = false;
      for (var mi = 0; mi < tokens.length; mi++) {
        if (tokens[mi].letter === 'M' &&
            (Math.round(tokens[mi].value) === 30 || Math.round(tokens[mi].value) === 2)) {
          stop = true;
        }
      }

      var ax = axisValue('X', words);
      var ay = axisValue('Y', words);
      var az = axisValue('Z', words);
      var hasAxis = ax !== null || ay !== null || az !== null;
      currentKind = stop ? 'stop' : ((hasAxis && !suppress) ? 'motion' : 'misc');

      if (suppress) return stop;
      if (!hasAxis) return stop;

      var nx = ax === null ? x : (absolute ? ax : x + ax);
      var ny = ay === null ? y : (absolute ? ay : y + ay);
      var nz = az === null ? z : (absolute ? az : z + az);

      var meta = {
        line: lineNo,
        n: words.N ? 'N' + Math.round(words.N.value) : nLabel,
        block: rawBlock,
        feed: feed
      };

      if (motion === 0 || motion === 1) {
        addLine(motion, nx, ny, nz, meta);
      } else {
        addArc(motion, nx, ny, nz, words, meta);
      }

      x = nx; y = ny; z = nz;
      return stop;
    }

    function handleIf(tokens, lineNo, rawBlock) {
      var condRes = macroValue(tokens, 1, lineNo, rawBlock);
      if (!condRes) return null;
      var pos = condRes.pos;
      var truth = condRes.value !== 0;
      var next = tokens[pos];

      if (next && next.type === 'KEY' && next.value === 'GOTO') {
        var target = readGotoTarget(tokens, pos + 1, lineNo, rawBlock);
        if (target === null || !truth) return null;
        if (labels[target] === undefined) {
          warn(lineNo, rawBlock, 'GOTO a etichetta N' + target + ' inesistente: esecuzione interrotta.');
          return { stop: true };
        }
        return { jump: labels[target], target: target };
      }

      if (next && next.type === 'KEY' && next.value === 'THEN') {
        if (!truth) return null;
        pos++;
        if (tokens[pos] && tokens[pos].type === 'VAR' &&
            tokens[pos + 1] && tokens[pos + 1].type === 'OP' && tokens[pos + 1].value === '=') {
          var varNo = tokens[pos].value;
          var valRes = macroValue(tokens, pos + 2, lineNo, rawBlock);
          if (valRes) setVar(varNo, valRes.value);
          return null;
        }
        var rest = resolveMacroWords(tokens.slice(pos), vars);
        if (rest) {
          var stop = executeResolvedBlock(rest, lineNo, rawBlock, activeN);
          if (stop) return { stop: true };
        }
        return null;
      }

      warn(lineNo, rawBlock, 'IF senza GOTO o THEN: blocco ignorato.');
      return null;
    }

    // ------------------------------------------------------------------
    // Pre-scan etichette N e ciclo di esecuzione con salti macro
    // ------------------------------------------------------------------
    for (var li = 0; li < lines.length; li++) {
      var lraw = lines[li];
      var ltrim = lraw.trim();
      if (!ltrim || ltrim.charAt(0) === '%' || ltrim.charAt(0) === '/') continue;
      var lcode = stripComments(ltrim).toUpperCase().trim();
      var lm = /^N\s*(\d+)/.exec(lcode);
      if (lm) {
        var ln = parseInt(lm[1], 10);
        if (labels[ln] !== undefined) {
          warn(li + 1, ltrim, 'Etichetta N' + ln + ' duplicata: usata la prima occorrenza.');
        } else {
          labels[ln] = li;
        }
      }
    }

    var pc = 0;
    while (pc < lines.length) {
      var rawLine = lines[pc];
      var trimmed = rawLine.trim();
      if (!trimmed) { pc++; continue; }
      if (trimmed.charAt(0) === '%') { pc++; continue; }
      if (trimmed.charAt(0) === '/') { pc++; continue; }

      var lineNo = pc + 1;
      var code = stripComments(trimmed).toUpperCase().trim();
      if (!code) { pc++; continue; }

      var labelMatch = /^N\s*(\d+)/.exec(code);
      if (labelMatch) {
        activeN = 'N' + parseInt(labelMatch[1], 10);
        code = code.slice(labelMatch[0].length).trim();
        if (!code) { blockCount++; pc++; continue; }
      }

      blockCount++;
      macroSteps++;
      if (macroSteps > maxMacroSteps) {
        warn(lineNo, trimmed, 'Limite di ' + maxMacroSteps + ' blocchi eseguiti: possibile loop macro infinito.');
        macroLimit = true;
        break;
      }

      currentVarChanges = [];
      currentM = [];
      currentKind = 'misc';
      currentJump = null;
      currentMeaningful = false;
      lastSegIndex = null;

      var tokens;
      try {
        tokens = tokenizeMacro(code);
      } catch (err) {
        warn(lineNo, trimmed, 'Macro: ' + (err && err.message ? err.message : String(err)));
        pc++;
        continue;
      }
      if (!tokens.length) { pc++; continue; }

      try {
        if (tokens[0].type === 'KEY' && tokens[0].value === 'IF') {
          currentMeaningful = true;
          var ifRes = handleIf(tokens, lineNo, trimmed);
          if (ifRes && ifRes.stop) {
            pushStep(lineNo, trimmed, activeN, 'stop', null);
            break;
          }
          if (ifRes && ifRes.jump !== undefined) {
            currentJump = ifRes.target || null;
            pushStep(lineNo, trimmed, activeN, 'if', currentJump);
            pc = ifRes.jump;
            macroJumps++;
          } else {
            pushStep(lineNo, trimmed, activeN, 'if', null);
            pc++;
          }
          continue;
        }

        if (tokens[0].type === 'KEY' && tokens[0].value === 'GOTO') {
          currentMeaningful = true;
          var target = readGotoTarget(tokens, 1, lineNo, trimmed);
          if (target === null) {
            pushStep(lineNo, trimmed, activeN, 'goto', null);
            pc++;
            continue;
          }
          if (labels[target] === undefined) {
            warn(lineNo, trimmed, 'GOTO a etichetta N' + target + ' inesistente: esecuzione interrotta.');
            pushStep(lineNo, trimmed, activeN, 'goto', target);
            break;
          }
          currentJump = target;
          pushStep(lineNo, trimmed, activeN, 'goto', target);
          pc = labels[target];
          macroJumps++;
          continue;
        }

        if (tokens[0].type === 'VAR' &&
            tokens[1] && tokens[1].type === 'OP' && tokens[1].value === '=') {
          currentMeaningful = true;
          var apos = 0;
          while (apos < tokens.length &&
            tokens[apos].type === 'VAR' &&
            tokens[apos + 1] && tokens[apos + 1].type === 'OP' && tokens[apos + 1].value === '=') {
            var varNo = tokens[apos].value;
            var valRes = macroValue(tokens, apos + 2, lineNo, trimmed);
            if (!valRes) { apos = tokens.length; break; }
            setVar(varNo, valRes.value);
            apos = valRes.pos;
          }
          var assignStop = false;
          if (apos < tokens.length) {
            var restCode = resolveMacroWords(tokens.slice(apos), vars);
            if (restCode) {
              var stopAssign = executeResolvedBlock(restCode, lineNo, trimmed, activeN);
              if (stopAssign) assignStop = true;
            }
          }
          pushStep(lineNo, trimmed, activeN, assignStop ? 'stop' : 'macro', null);
          if (assignStop) break;
          pc++;
          continue;
        }

        if (tokens[0].type === 'KEY' &&
            (tokens[0].value === 'WHILE' || tokens[0].value === 'DO' || tokens[0].value === 'END')) {
          currentMeaningful = true;
          warn(lineNo, trimmed, 'WHILE/DO/END non supportati: blocco ignorato.');
          pushStep(lineNo, trimmed, activeN, 'unsupported', null);
          pc++;
          continue;
        }

        var resolved = resolveMacroWords(tokens, vars);
        if (resolved) {
          var stopBlock = executeResolvedBlock(resolved, lineNo, trimmed, activeN);
          if (currentMeaningful) {
            pushStep(lineNo, trimmed, activeN, stopBlock ? 'stop' : currentKind, null);
          }
          if (stopBlock) break;
        }
        pc++;
      } catch (err) {
        warn(lineNo, trimmed, 'Macro: ' + (err && err.message ? err.message : String(err)));
        if (currentMeaningful) pushStep(lineNo, trimmed, activeN, 'error', null);
        pc++;
      }

      if (segments.length >= maxMacroSegments) {
        warn(lineNo, trimmed, 'Limite di ' + maxMacroSegments + ' segmenti raggiunto: esecuzione interrotta.');
        macroLimit = true;
        break;
      }
    }

    var variableInfo = {};
    for (var ve = 0; ve < varEvents.length; ve++) {
      var ev = varEvents[ve];
      var info = variableInfo[ev.name];
      if (!info) {
        info = variableInfo[ev.name] = {
          name: ev.name,
          initial: ev.value,
          current: ev.value,
          assignments: 0,
          firstLine: ev.line,
          lastLine: ev.line,
          values: [],
          truncated: false
        };
      }
      info.assignments++;
      info.lastLine = ev.line;
      info.current = ev.value;
      if (info.values.length >= MAX_VAR_HISTORY) {
        info.values.shift();
        info.truncated = true;
      }
      info.values.push({ step: ev.step, value: ev.value, line: ev.line });
    }
    Object.keys(variableInfo).forEach(function (name) {
      var info = variableInfo[name];
      var distinct = {};
      for (var vi = 0; vi < info.values.length; vi++) {
        distinct[String(info.values[vi].value)] = 1;
      }
      info.distinct = Object.keys(distinct).length;
      info.kind = info.distinct > 1 ? (info.assignments > 2 ? 'cycle' : 'var') : 'fixed';
      info.final = vars[name];
      if (info.values.length) info.initial = info.values[0].value;
    });

    if (!isFinite(bounds.minX)) bounds = null;

    return {
      name: programName,
      unit: unitName,
      lines: lines.length,
      blocks: blockCount,
      segments: segments,
      steps: steps,
      byType: byType,
      stats: stats,
      bounds: bounds,
      warnings: warnings,
      macros: {
        variables: vars,
        variableInfo: variableInfo,
        steps: macroSteps,
        stepCount: steps.length,
        jumps: macroJumps,
        labels: Object.keys(labels).length,
        limitReached: macroLimit
      },
      finalPosition: { x: x, y: y, z: z }
    };
  }

  root.GTParser = {
    version: '1.3.0',
    parse: parse,
    PLANES: PLANES,
    fmtNum: fmtNum
  };
})(typeof window !== 'undefined' ? window : globalThis);
