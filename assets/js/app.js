/*!
 * GT-Graphic - Controller applicazione
 * Gestione file, pannelli, viste, origine, DRO, inspector, PWA.
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var PALETTE = ['#22d3ee', '#f59e0b', '#a78bfa', '#34d399', '#f472b6', '#60a5fa', '#facc15', '#fb7185'];
  var MOTION = {
    0: { code: 'G00', name: 'Posizionamento rapido' },
    1: { code: 'G01', name: 'Interpolazione lineare' },
    2: { code: 'G02', name: 'Arco orario (CW)' },
    3: { code: 'G03', name: 'Arco antiorario (CCW)' }
  };
  var MODE_LABEL = { pan: 'PAN', inspect: 'INTERROGA', zoomwin: 'ZOOM FINESTRA', origin: 'ORIGINE' };

  var state = {
    files: [],
    nextId: 1,
    origin: { x: 0, y: 0, z: 0 },
    mode: 'pan',
    tab: 'files',
    colorMode: 'type',
    pendingMode: 'open',
    busy: false
  };

  var toastTimer = 0;

  /* ------------------------------------------------------------------ */
  /* Utility                                                             */
  /* ------------------------------------------------------------------ */
  function fmt(v) {
    if (!isFinite(v)) return '--';
    var s = Number(v).toFixed(3);
    return s === '-0.000' ? '0.000' : s;
  }

  function fmtLen(mm) {
    if (!isFinite(mm)) return '--';
    if (Math.abs(mm) >= 1000) return (mm / 1000).toFixed(2) + ' m';
    return mm.toFixed(2) + ' mm';
  }

  function fmtNumInput(v) {
    var n = Number(v);
    if (!isFinite(n)) return '0';
    return String(Number(n.toFixed(4)));
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function icon(id, cls) {
    return '<svg class="ico' + (cls ? ' ' + cls : '') + '" aria-hidden="true"><use href="#' + id + '"/></svg>';
  }

  function delay(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  function isMobile() {
    return window.matchMedia('(max-width: 900px)').matches;
  }

  function toast(msg) {
    var el = $('toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, 3200);
  }

  function setLoading(on, text) {
    var el = $('loading');
    if (!el) return;
    el.classList.toggle('hidden', !on);
    if (text) {
      var span = el.querySelector('span');
      if (span) span.textContent = text;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Pannello                                                            */
  /* ------------------------------------------------------------------ */
  function openPanel() {
    var app = $('app');
    if (isMobile()) app.classList.add('panel-open');
    else app.classList.remove('panel-collapsed');
  }

  function closePanel() {
    var app = $('app');
    if (isMobile()) app.classList.remove('panel-open');
    else app.classList.add('panel-collapsed');
  }

  function togglePanel() {
    var app = $('app');
    if (isMobile()) app.classList.toggle('panel-open');
    else app.classList.toggle('panel-collapsed');
  }

  function showTab(tab, open) {
    state.tab = tab;
    var tabs = document.querySelectorAll('.tab');
    for (var i = 0; i < tabs.length; i++) {
      var on = tabs[i].getAttribute('data-tab') === tab;
      tabs[i].classList.toggle('active', on);
      tabs[i].setAttribute('aria-selected', on ? 'true' : 'false');
    }
    var pages = document.querySelectorAll('.panel-page');
    for (var j = 0; j < pages.length; j++) {
      pages[j].classList.toggle('active', pages[j].id === 'page-' + tab);
    }
    if (open !== false) openPanel();
  }

  /* ------------------------------------------------------------------ */
  /* Vista / DRO                                                         */
  /* ------------------------------------------------------------------ */
  function updateViewUI() {
    var view = GTViewer.getView();
    var A = GTViewer.getAxes();
    var buttons = document.querySelectorAll('.view-btn');
    for (var i = 0; i < buttons.length; i++) {
      var on = buttons[i].getAttribute('data-view') === view;
      buttons[i].classList.toggle('active', on);
      buttons[i].setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    $('badgeView').textContent = A.ul + '-' + A.vl;
    $('droLabel1').textContent = A.ul;
    $('droLabel2').textContent = A.vl;
    $('droLabel3').textContent = A.wl;
    $('droFoot').textContent = 'Vista ' + A.ul + '-' + A.vl + ' \u00b7 origine ' +
      fmtNumInput(state.origin.x) + ', ' + fmtNumInput(state.origin.y) + ', ' + fmtNumInput(state.origin.z);
    updateDroThird(GTViewer.getSelection());
    var cur = lastCursor;
    if (cur && cur.inside) {
      $('stCursor').textContent = A.ul + ' ' + fmt(cur.du) + '  ' + A.vl + ' ' + fmt(cur.dv);
    } else {
      $('stCursor').textContent = A.ul + ' -- \u00b7 ' + A.vl + ' --';
    }
  }

  var lastCursor = null;

  function onCursor(c) {
    lastCursor = c;
    var A = GTViewer.getAxes();
    if (!c || !c.inside) {
      $('stCursor').textContent = A.ul + ' -- \u00b7 ' + A.vl + ' --';
      return;
    }
    $('droVal1').textContent = fmt(c.du);
    $('droVal2').textContent = fmt(c.dv);
    $('stCursor').textContent = A.ul + ' ' + fmt(c.du) + '  ' + A.vl + ' ' + fmt(c.dv);
  }

  function updateDroThird(obj) {
    var A = GTViewer.getAxes();
    var p = null;
    if (obj && obj.point) p = obj.point;
    else if (obj && typeof obj.x === 'number') p = obj;
    var out = $('droVal3');
    if (!p) {
      out.textContent = '--';
      out.classList.add('dim');
      return;
    }
    var raw = A.w === 'x' ? p.x : (A.w === 'y' ? p.y : p.z);
    var off = A.w === 'x' ? state.origin.x : (A.w === 'y' ? state.origin.y : state.origin.z);
    out.textContent = fmt(raw - off);
    out.classList.remove('dim');
  }

  /* ------------------------------------------------------------------ */
  /* File                                                                */
  /* ------------------------------------------------------------------ */
  function totalSegments() {
    return state.files.reduce(function (n, f) { return n + (f.program ? f.program.stats.segments : 0); }, 0);
  }

  function totalLength() {
    return state.files.reduce(function (n, f) { return n + (f.program ? f.program.stats.total : 0); }, 0);
  }

  function nextColor() {
    var used = {};
    state.files.forEach(function (f) { used[f.color] = true; });
    for (var i = 0; i < PALETTE.length; i++) {
      if (!used[PALETTE[i]]) return PALETTE[i];
    }
    return PALETTE[state.files.length % PALETTE.length];
  }

  function readText(file) {
    return new Promise(function (resolve, reject) {
      if (!file) { reject(new Error('File non valido')); return; }
      if (typeof FileReader === 'undefined') {
        if (file.text) file.text().then(resolve, reject);
        else reject(new Error('FileReader non disponibile'));
        return;
      }
      var fr = new FileReader();
      fr.onload = function () { resolve(String(fr.result == null ? '' : fr.result)); };
      fr.onerror = function () { reject(fr.error || new Error('Errore di lettura')); };
      fr.readAsText(file);
    });
  }

  function handleFiles(fileList, mode) {
    if (state.busy) return;
    var files = Array.prototype.slice.call(fileList || []);
    if (!files.length) return;
    state.busy = true;
    setLoading(true, 'Lettura file\u2026');
    delay(30).then(function () {
      var entries = [];
      var chain = Promise.resolve();
      files.forEach(function (f) {
        chain = chain.then(function () {
          if (f.size > 25 * 1024 * 1024) {
            toast('File troppo grande (max 25 MB): ' + (f.name || 'senza nome'));
            return null;
          }
          return readText(f).then(function (text) {
            entries.push({ name: f.name || 'SENZA_NOME', text: text });
          }).catch(function () {
            toast('Impossibile leggere: ' + (f.name || 'file'));
          });
        });
      });
      return chain.then(function () {
        setLoading(true, 'Analisi G-Code\u2026');
        return delay(20);
      }).then(function () {
        commitEntries(entries, mode);
      }).catch(function (err) {
        toast('Errore: ' + (err && err.message ? err.message : err));
      }).then(function () {
        state.busy = false;
        setLoading(false);
      });
    });
  }

  function commitEntries(entries, mode) {
    if (!entries || !entries.length) {
      toast('Nessun file valido caricato');
      return;
    }
    if (mode === 'open') {
      state.files = [];
      GTViewer.clearSelection();
      renderInspector(null);
      updateChip(null);
    }
    var added = 0;
    var warnings = 0;
    var segments = 0;

    entries.forEach(function (entry) {
      if (entry.text.length > 25 * 1024 * 1024) {
        toast('Testo troppo grande: ' + entry.name);
        return;
      }
      var program;
      try {
        program = GTParser.parse(entry.text, { micronNoDecimal: !!($('optMicron') && $('optMicron').checked) });
      } catch (err) {
        toast('Parsing fallito: ' + entry.name);
        return;
      }
      var file = {
        id: state.nextId++,
        name: entry.name,
        color: nextColor(),
        visible: true,
        program: program,
        size: entry.text.length
      };
      state.files.push(file);
      added++;
      warnings += program.warnings.length;
      segments += program.stats.segments;
    });

    if (!added) {
      renderFiles();
      updateEmpty();
      updateStatus();
      return;
    }

    if (state.files.length > 1) {
      state.colorMode = 'file';
      GTViewer.setColorMode('file');
      updateColorModeUI();
    } else if (mode === 'open') {
      state.colorMode = 'type';
      GTViewer.setColorMode('type');
      updateColorModeUI();
    }

    GTViewer.setFiles(state.files);
    GTViewer.clearSelection();
    renderInspector(null);
    updateChip(null);
    updateDroThird(null);

    if (mode === 'open' || state.files.length === added) {
      GTViewer.fit();
    } else {
      GTViewer.refresh();
    }

    renderFiles();
    updateEmpty();
    updateStatus();
    updateViewUI();
    showTab('files', false);

    var msg = added === 1
      ? entries[0].name + ' \u00b7 ' + segments + ' segmenti'
      : added + ' file \u00b7 ' + segments + ' segmenti';
    if (warnings) msg += ' \u00b7 ' + warnings + ' avvisi';
    toast(msg);
  }

  function loadDemo() {
    if (state.busy) return;
    if (!window.GT_DEMO) { toast('Demo non disponibile'); return; }
    if (state.files.some(function (f) { return f.name === GT_DEMO.name; })) {
      toast('Programma demo già caricato');
      showTab('files');
      return;
    }
    var mode = state.files.length ? 'import' : 'open';
    if (mode === 'open') setOrigin({ x: 0, y: 0, z: 0 }, true);
    commitEntries([{ name: GT_DEMO.name, text: GT_DEMO.text }], mode);
  }

  function removeFile(id) {
    var removed = state.files.filter(function (f) { return f.id === id; })[0];
    state.files = state.files.filter(function (f) { return f.id !== id; });
    if (state.files.length <= 1 && state.colorMode === 'file') setColorMode('type');
    var sel = GTViewer.getSelection();
    if (sel && removed && sel.file.id === id) {
      GTViewer.clearSelection();
      renderInspector(null);
      updateChip(null);
      updateDroThird(null);
    }
    GTViewer.setFiles(state.files);
    GTViewer.refresh();
    if (!state.files.length) GTViewer.fit();
    renderFiles();
    updateEmpty();
    updateStatus();
    toast('Programma rimosso');
  }

  function toggleFile(id) {
    var f = state.files.filter(function (x) { return x.id === id; })[0];
    if (!f) return;
    f.visible = !f.visible;
    GTViewer.setFiles(state.files);
    GTViewer.refresh();
    var sel = GTViewer.getSelection();
    if (!f.visible && sel && sel.file.id === id) {
      GTViewer.clearSelection();
      renderInspector(null);
      updateChip(null);
      updateDroThird(null);
    }
    renderFiles();
  }

  function renderFiles() {
    var list = $('fileList');
    if (!list) return;
    list.innerHTML = '';

    if (!state.files.length) {
      var empty = document.createElement('div');
      empty.className = 'file-empty';
      empty.textContent = 'Nessun programma. Usa Apri oppure Carica demo.';
      list.appendChild(empty);
    }

    state.files.forEach(function (f) {
      var p = f.program;
      var row = document.createElement('div');
      row.className = 'file-row' + (f.visible ? '' : ' is-hidden');
      row.setAttribute('data-id', String(f.id));

      var warnHtml = '';
      if (p.warnings && p.warnings.length) {
        var items = p.warnings.slice(0, 8).map(function (w) {
          return '<li>Riga ' + w.line + ': ' + esc(w.message) + '</li>';
        }).join('');
        warnHtml = '<details class="file-warn"><summary>' + icon('i-warning') +
          p.warnings.length + ' avvis' + (p.warnings.length === 1 ? 'o' : 'i') +
          '</summary><ul class="warn-list">' + items + '</ul></details>';
      }

      var macroHtml = '';
      if (p.macros && p.macros.variables) {
        var macroVars = Object.keys(p.macros.variables).length;
        if (macroVars) {
          macroHtml = '<div class="file-tag" title="Custom Macro B interpretato">MACRO B \u00b7 ' +
            macroVars + ' var \u00b7 ' + p.macros.jumps + ' salti</div>';
        }
      }

      row.innerHTML =
        '<button type="button" class="file-eye" aria-label="Mostra o nascondi" title="Mostra/nascondi">' +
          icon(f.visible ? 'i-eye' : 'i-eye-off') +
        '</button>' +
        '<span class="file-swatch" style="background:' + f.color + '"></span>' +
        '<div class="file-meta">' +
          '<div class="file-name"></div>' +
          '<div class="file-sub">' + p.stats.segments + ' seg \u00b7 ' + fmtLen(p.stats.total) +
            ' \u00b7 ' + (p.stats.byType[2] + p.stats.byType[3]) + ' archi</div>' +
          macroHtml +
          warnHtml +
        '</div>' +
        '<button type="button" class="file-del" aria-label="Rimuovi file" title="Rimuovi">' +
          icon('i-trash') +
        '</button>';

      row.querySelector('.file-name').textContent = f.name;
      row.querySelector('.file-name').title = f.name;
      list.appendChild(row);
    });

    var segs = totalSegments();
    $('sumFiles').textContent = state.files.length;
    $('sumSegs').textContent = segs;
    $('sumLen').textContent = fmtLen(totalLength());
    $('sumLen').title = fmtLen(totalLength());
  }

  function updateColorModeUI() {
    var buttons = document.querySelectorAll('#colorMode button');
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].classList.toggle('active', buttons[i].getAttribute('data-mode') === state.colorMode);
    }
    var legend = $('legend');
    if (legend) legend.classList.toggle('is-file', state.colorMode === 'file');
    var legendMode = $('legendMode');
    if (legendMode) legendMode.textContent = state.colorMode === 'file' ? 'FILE' : 'TIPO';
  }

  function setColorMode(mode) {
    state.colorMode = mode === 'file' ? 'file' : 'type';
    GTViewer.setColorMode(state.colorMode);
    updateColorModeUI();
  }

  function updateEmpty() {
    $('emptyState').classList.toggle('hidden', state.files.length > 0);
  }

  function updateStatus() {
    var segs = totalSegments();
    $('stFiles').textContent = state.files.length + (state.files.length === 1 ? ' file' : ' file');
    $('stSegs').textContent = segs + ' segmenti';
    $('stScale').textContent = GTViewer.getScale().toFixed(2) + ' px/mm';
    $('stMode').textContent = MODE_LABEL[state.mode] || 'PAN';
  }

  /* ------------------------------------------------------------------ */
  /* Inspector                                                           */
  /* ------------------------------------------------------------------ */
  function renderInspector(sel) {
    var body = $('inspectBody');
    if (!body) return;
    if (!sel) {
      body.innerHTML =
        '<div class="inspect-empty">' +
          icon('i-inspect', 'big') +
          '<h3>Interroga punti</h3>' +
          '<p>Attiva <b>Interroga</b> e passa il mouse o tocca un vertice del percorso. ' +
          'Lo snap magnetico aggancia vertici e centri arco.</p>' +
        '</div>';
      return;
    }

    var seg = sel.seg;
    var file = sel.file;
    var p = sel.point;
    var A = GTViewer.getAxes();
    var info = MOTION[seg.type] || MOTION[1];
    var isArc = seg.type === 2 || seg.type === 3;
    var idx = file.program.segments.indexOf(seg);

    var delta = null;
    var refLabel = '\u0394 vertice prec.';
    if (sel.kind === 'start') {
      if (idx > 0) {
        var prev = file.program.segments[idx - 1];
        delta = Math.hypot(p.x - prev.x0, p.y - prev.y0, p.z - prev.z0);
      }
    } else if (sel.kind === 'end') {
      delta = Math.hypot(p.x - seg.x0, p.y - seg.y0, p.z - seg.z0);
      refLabel = '\u0394 dal punto iniziale';
    }

    var rows = '';
    rows += '<dt>Riga</dt><dd>' + seg.line + (seg.n ? ' \u00b7 ' + esc(seg.n) : '') + '</dd>';
    rows += '<dt>Lunghezza</dt><dd>' + fmtLen(seg.length) + '</dd>';
    if (delta !== null) rows += '<dt>' + refLabel + '</dt><dd>' + fmtLen(delta) + '</dd>';
    rows += '<dt>Feed</dt><dd>' + (seg.feed > 0 ? Math.round(seg.feed) + ' mm/min' : '--') + '</dd>';
    if (isArc) {
      rows += '<dt>Raggio</dt><dd>' + fmt(seg.radius) + ' mm</dd>';
      rows += '<dt>Piano</dt><dd>G' + seg.plane + ' ' + GTParser.PLANES[seg.plane].name + '</dd>';
      rows += '<dt>Ampiezza</dt><dd>' + (Math.abs(seg.sweep) * 180 / Math.PI).toFixed(1) + '\u00b0</dd>';
      rows += '<dt>Centro</dt><dd>X ' + fmt(seg.center.x - state.origin.x) + ' \u00b7 Y ' +
        fmt(seg.center.y - state.origin.y) + ' \u00b7 Z ' + fmt(seg.center.z - state.origin.z) + '</dd>';
    }
    if (sel.kind === 'center') {
      rows += '<dt>Tipo punto</dt><dd>Centro arco</dd>';
    }

    var html =
      '<div class="insp-head">' +
        '<span class="insp-dot" style="background:' + file.color + '"></span>' +
        '<span class="insp-file"></span>' +
        '<span class="insp-kind' + (sel.kind === 'center' ? ' center' : '') + '">' +
          (sel.kind === 'center' ? 'CENTRO ARCO' : info.code) +
        '</span>' +
      '</div>' +
      '<div class="insp-coords">' +
        '<div class="insp-coord"><label>X</label><output>' + fmt(p.x - state.origin.x) + '</output></div>' +
        '<div class="insp-coord"><label>Y</label><output>' + fmt(p.y - state.origin.y) + '</output></div>' +
        '<div class="insp-coord"><label>Z</label><output>' + fmt(p.z - state.origin.z) + '</output></div>' +
      '</div>' +
      '<div class="insp-motion"><b>' + info.code + '</b> \u00b7 ' + info.name +
        (isArc ? ' \u00b7 ' + (seg.cw ? 'orario' : 'antiorario') : '') + '</div>' +
      '<dl class="insp-table">' + rows + '</dl>' +
      '<div class="insp-block-label">Blocco G-Code originale</div>' +
      '<code class="insp-block"></code>' +
      '<div class="insp-actions">' +
        '<button type="button" class="btn btn-block" data-action="origin">' + icon('i-origin') +
          'Imposta origine su questo punto</button>' +
        '<button type="button" class="btn btn-block" data-action="clear">Deseleziona</button>' +
      '</div>';

    body.innerHTML = html;
    body.querySelector('.insp-file').textContent = file.name;
    body.querySelector('.insp-block').textContent = seg.block;
  }

  function updateChip(sel) {
    var chip = $('selChip');
    if (!chip) return;
    if (!sel) {
      chip.classList.add('hidden');
      return;
    }
    var p = sel.point;
    var info = MOTION[sel.seg.type] || MOTION[1];
    $('chipType').textContent = sel.kind === 'center' ? 'CENTRO' : info.code;
    $('chipCoords').textContent = 'X ' + fmt(p.x - state.origin.x) + ' \u00b7 Y ' +
      fmt(p.y - state.origin.y) + ' \u00b7 Z ' + fmt(p.z - state.origin.z);
    $('chipBlock').textContent = sel.seg.block;
    chip.classList.remove('hidden');
  }

  function clearSelection() {
    GTViewer.clearSelection();
    renderInspector(null);
    updateChip(null);
    updateDroThird(null);
  }

  function onSelect(sel) {
    renderInspector(sel);
    updateChip(sel);
    updateDroThird(sel);
    if (sel) {
      if (!isMobile()) {
        showTab('inspect');
        openPanel();
      }
    }
  }

  function onHover(h) {
    if (h) {
      updateDroThird(h);
      renderInspector(h);
      updateChip(h);
      return;
    }
    var sel = GTViewer.getSelection();
    updateDroThird(sel);
    renderInspector(sel);
    updateChip(sel);
  }

  /* ------------------------------------------------------------------ */
  /* Origine                                                             */
  /* ------------------------------------------------------------------ */
  function setOrigin(o, silent) {
    state.origin = {
      x: isFinite(o.x) ? Number(o.x) : 0,
      y: isFinite(o.y) ? Number(o.y) : 0,
      z: isFinite(o.z) ? Number(o.z) : 0
    };
    GTViewer.setOrigin(state.origin);
    updateOriginUI();
    updateViewUI();
    var sel = GTViewer.getSelection();
    if (sel) {
      renderInspector(sel);
      updateChip(sel);
    }
    if (!silent) toast('Origine impostata: X ' + fmt(state.origin.x) + ' \u00b7 Y ' +
      fmt(state.origin.y) + ' \u00b7 Z ' + fmt(state.origin.z));
  }

  function updateOriginUI() {
    $('orgX').textContent = fmt(state.origin.x);
    $('orgY').textContent = fmt(state.origin.y);
    $('orgZ').textContent = fmt(state.origin.z);
    var pairs = [['orgInputX', 'x'], ['orgInputY', 'y'], ['orgInputZ', 'z']];
    pairs.forEach(function (pair) {
      var el = $(pair[0]);
      if (el && document.activeElement !== el) el.value = fmtNumInput(state.origin[pair[1]]);
    });
  }

  function applyOriginInputs() {
    var x = parseFloat($('orgInputX').value.replace(',', '.'));
    var y = parseFloat($('orgInputY').value.replace(',', '.'));
    var z = parseFloat($('orgInputZ').value.replace(',', '.'));
    if (!isFinite(x) || !isFinite(y) || !isFinite(z)) {
      toast('Inserisci valori numerici validi per X, Y e Z');
      return;
    }
    setOrigin({ x: x, y: y, z: z });
  }

  function startOriginPick() {
    if (isMobile()) closePanel();
    setMode('origin');
    toast('Tocca un vertice del percorso per impostare la nuova origine');
  }

  function onPickOrigin(p, snapped) {
    setOrigin(p, true);
    setMode('pan');
    toast('Origine impostata su X ' + fmt(p.x) + ' \u00b7 Y ' + fmt(p.y) + ' \u00b7 Z ' + fmt(p.z) +
      (snapped ? ' (snap)' : ''));
  }

  /* ------------------------------------------------------------------ */
  /* Modalità                                                            */
  /* ------------------------------------------------------------------ */
  function setMode(mode) {
    state.mode = mode || 'pan';
    GTViewer.setMode(state.mode);
    $('btnPan').classList.toggle('active', state.mode === 'pan');
    $('btnPan').setAttribute('aria-pressed', state.mode === 'pan' ? 'true' : 'false');
    $('btnInspect').classList.toggle('active', state.mode === 'inspect');
    $('btnInspect').setAttribute('aria-pressed', state.mode === 'inspect' ? 'true' : 'false');
    $('btnZoomWin').classList.toggle('active', state.mode === 'zoomwin');
    $('btnZoomWin').setAttribute('aria-pressed', state.mode === 'zoomwin' ? 'true' : 'false');
    $('btnOrigin').classList.toggle('active', state.mode === 'origin');
    $('btnOrigin').setAttribute('aria-pressed', state.mode === 'origin' ? 'true' : 'false');
    $('badgeMode').textContent = MODE_LABEL[state.mode] || 'PAN';
    $('stMode').textContent = MODE_LABEL[state.mode] || 'PAN';
  }

  function setView(view) {
    GTViewer.setView(view);
    updateViewUI();
  }

  /* ------------------------------------------------------------------ */
  /* Sessione                                                            */
  /* ------------------------------------------------------------------ */
  function closeFiles() {
    state.files = [];
    setColorMode('type');
    GTViewer.setFiles([]);
    GTViewer.clearSelection();
    GTViewer.setMode('pan');
    setMode('pan');
    GTViewer.fit();
    renderFiles();
    updateEmpty();
    updateStatus();
    renderInspector(null);
    updateChip(null);
    updateDroThird(null);
    toast('Area grafica chiusa');
  }

  function exitSession() {
    state.files = [];
    state.colorMode = 'type';
    GTViewer.setColorMode('type');
    updateColorModeUI();
    GTViewer.setFiles([]);
    GTViewer.clearSelection();
    setOrigin({ x: 0, y: 0, z: 0 }, true);
    setMode('pan');
    GTViewer.setView('xy');
    GTViewer.fit();
    closePanel();
    renderFiles();
    updateEmpty();
    updateStatus();
    renderInspector(null);
    updateChip(null);
    updateDroThird(null);
    $('exitScreen').classList.remove('hidden');
  }

  function restartSession() {
    $('exitScreen').classList.add('hidden');
    state.files = [];
    state.origin = { x: 0, y: 0, z: 0 };
    GTViewer.setFiles([]);
    GTViewer.setOrigin(state.origin);
    GTViewer.clearSelection();
    GTViewer.setView('xy');
    GTViewer.fit();
    setMode('pan');
    setColorMode('type');
    updateOriginUI();
    updateViewUI();
    renderFiles();
    updateEmpty();
    updateStatus();
    renderInspector(null);
    updateChip(null);
    updateDroThird(null);
    showTab('files', false);
    toast('Sessione pronta');
  }

  /* ------------------------------------------------------------------ */
  /* Eventi                                                              */
  /* ------------------------------------------------------------------ */
  function bind() {
    $('btnOpen').addEventListener('click', function () { state.pendingMode = 'open'; $('fileInput').value = ''; $('fileInput').click(); });
    $('btnImport').addEventListener('click', function () { state.pendingMode = 'import'; $('fileInput').value = ''; $('fileInput').click(); });
    $('btnAddFile').addEventListener('click', function () {
      state.pendingMode = state.files.length ? 'import' : 'open';
      $('fileInput').value = '';
      $('fileInput').click();
    });
    $('btnEmptyOpen').addEventListener('click', function () { state.pendingMode = 'open'; $('fileInput').value = ''; $('fileInput').click(); });
    $('btnClose').addEventListener('click', closeFiles);
    $('btnExit').addEventListener('click', exitSession);
    $('btnRestart').addEventListener('click', restartSession);

    $('btnDemoTop').addEventListener('click', loadDemo);
    $('btnDemo').addEventListener('click', loadDemo);
    $('btnEmptyDemo').addEventListener('click', loadDemo);

    $('fileInput').addEventListener('change', function () {
      var files = Array.prototype.slice.call($('fileInput').files || []);
      var mode = state.pendingMode;
      handleFiles(files, mode);
      $('fileInput').value = '';
    });

    var viewButtons = document.querySelectorAll('.view-btn');
    for (var i = 0; i < viewButtons.length; i++) {
      (function (btn) {
        btn.addEventListener('click', function () { setView(btn.getAttribute('data-view')); });
      })(viewButtons[i]);
    }

    $('btnZoomIn').addEventListener('click', function () { GTViewer.zoomIn(); });
    $('btnZoomOut').addEventListener('click', function () { GTViewer.zoomOut(); });
    $('btnFit').addEventListener('click', function () { GTViewer.fit(); });
    $('btnZoomWin').addEventListener('click', function () {
      if (state.mode === 'zoomwin') { setMode('pan'); return; }
      if (isMobile()) closePanel();
      setMode('zoomwin');
      toast('Traccia un rettangolo sul disegno per ingrandire l\u2019area');
    });

    $('btnPan').addEventListener('click', function () { setMode('pan'); });
    $('btnInspect').addEventListener('click', function () {
      if (state.mode === 'inspect') { setMode('pan'); return; }
      setMode('inspect');
      if (!isMobile()) showTab('inspect');
      toast('Tocca o passa su un vertice per interrogarlo');
    });
    $('btnOrigin').addEventListener('click', function () {
      if (state.mode === 'origin') { setMode('pan'); return; }
      showTab('origin');
    });

    $('btnPanel').addEventListener('click', togglePanel);
    $('btnPanelClose').addEventListener('click', closePanel);

    var tabs = document.querySelectorAll('.tab');
    for (var t = 0; t < tabs.length; t++) {
      (function (tab) {
        tab.addEventListener('click', function () { showTab(tab.getAttribute('data-tab')); });
      })(tabs[t]);
    }

    $('btnHelp').addEventListener('click', function () { showTab('help'); });

    var colorButtons = document.querySelectorAll('#colorMode button');
    for (var c = 0; c < colorButtons.length; c++) {
      (function (btn) {
        btn.addEventListener('click', function () { setColorMode(btn.getAttribute('data-mode')); });
      })(colorButtons[c]);
    }

    $('fileList').addEventListener('click', function (e) {
      var row = e.target.closest ? e.target.closest('.file-row') : null;
      if (!row) return;
      var id = Number(row.getAttribute('data-id'));
      if (e.target.closest('.file-eye')) { toggleFile(id); return; }
      if (e.target.closest('.file-del')) { removeFile(id); return; }
    });

    $('btnApplyOrigin').addEventListener('click', applyOriginInputs);
    $('btnPickOrigin').addEventListener('click', startOriginPick);
    $('btnResetOrigin').addEventListener('click', function () {
      setOrigin({ x: 0, y: 0, z: 0 });
      setMode('pan');
    });
    ['orgInputX', 'orgInputY', 'orgInputZ'].forEach(function (id) {
      $(id).addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); applyOriginInputs(); }
      });
    });
    var signBtns = document.querySelectorAll('.sign-btn');
    for (var s = 0; s < signBtns.length; s++) {
      signBtns[s].addEventListener('click', function (e) {
        e.preventDefault();
        var input = $(this.getAttribute('data-target'));
        if (!input) return;
        var v = parseFloat(input.value.replace(',', '.'));
        if (!isFinite(v) || v === 0) return;
        input.value = fmtNumInput(-v);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
    }

    $('inspectBody').addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('[data-action]') : null;
      if (!btn) return;
      var action = btn.getAttribute('data-action');
      if (action === 'clear') { clearSelection(); return; }
      if (action === 'origin') {
        var sel = GTViewer.getSelection();
        if (sel) {
          setOrigin(sel.point, true);
          setMode('pan');
          toast('Origine impostata sul punto selezionato');
        }
      }
    });

    $('selChip').addEventListener('click', function () { showTab('inspect'); });

    document.addEventListener('keydown', onKeyDown);

    document.addEventListener('dragover', function (e) {
      e.preventDefault();
      document.body.classList.add('dragging');
    });
    document.addEventListener('dragleave', function (e) {
      if (e.relatedTarget === null) document.body.classList.remove('dragging');
    });
    document.addEventListener('drop', function (e) {
      e.preventDefault();
      document.body.classList.remove('dragging');
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
        handleFiles(e.dataTransfer.files, state.files.length ? 'import' : 'open');
      }
    });

    window.addEventListener('resize', function () {
      if (!isMobile()) $('app').classList.remove('panel-open');
      updateViewUI();
    });

    window.addEventListener('beforeunload', function () {
      // nessuna conferma: l'app e' stateless su disco
    });
  }

  function onKeyDown(e) {
    var t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;

    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      if (e.key.toLowerCase() === 'o') {
        e.preventDefault();
        state.pendingMode = 'open';
        $('fileInput').value = '';
        $('fileInput').click();
      }
      return;
    }
    if (e.altKey) return;

    switch (e.key) {
      case '1': setView('xy'); break;
      case '2': setView('xz'); break;
      case '3': setView('yz'); break;
      case 'f': case 'F': GTViewer.fit(); break;
      case '+': case '=': GTViewer.zoomIn(); break;
      case '-': case '_': GTViewer.zoomOut(); break;
      case 'p': case 'P': setMode('pan'); break;
      case 'i': case 'I':
        if (state.mode === 'inspect') setMode('pan');
        else { setMode('inspect'); if (!isMobile()) showTab('inspect'); }
        break;
      case 'z': case 'Z': closePanel(); setMode('zoomwin'); break;
      case 'o': case 'O': showTab('origin'); break;
      case 'Escape':
        if (state.mode !== 'pan') setMode('pan');
        else closePanel();
        break;
      case 'ArrowLeft': e.preventDefault(); GTViewer.panBy(60, 0); break;
      case 'ArrowRight': e.preventDefault(); GTViewer.panBy(-60, 0); break;
      case 'ArrowUp': e.preventDefault(); GTViewer.panBy(0, 60); break;
      case 'ArrowDown': e.preventDefault(); GTViewer.panBy(0, -60); break;
      default: break;
    }
  }

  /* ------------------------------------------------------------------ */
  /* PWA                                                                 */
  /* ------------------------------------------------------------------ */
  function registerSW() {
    if (!('serviceWorker' in navigator)) return;
    if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') return;
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function () { /* offline non disponibile */ });
    });
  }

  /* ------------------------------------------------------------------ */
  /* Init                                                                */
  /* ------------------------------------------------------------------ */
  function init() {
    GTViewer.init($('canvas'), {
      onSelect: onSelect,
      onHover: onHover,
      onCursor: onCursor,
      onPickOrigin: onPickOrigin,
      onBoxZoom: function () { setMode('pan'); toast('Zoom finestra applicato'); },
      onZoom: function (scale) {
        $('stScale').textContent = scale.toFixed(2) + ' px/mm';
      },
      onView: function () { updateViewUI(); }
    });

    bind();
    setMode('pan');
    updateViewUI();
    updateOriginUI();
    renderFiles();
    updateEmpty();
    updateStatus();
    renderInspector(null);
    updateChip(null);
    updateDroThird(null);
    updateColorModeUI();

    $('appVersion').textContent = 'v1.2.0';
    registerSW();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
