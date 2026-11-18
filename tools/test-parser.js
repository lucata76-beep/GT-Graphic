/* Test del parser sui programmi di esempio. Esecuzione: node tools/test-parser.js */
'use strict';
const fs = require('fs');
const path = require('path');

require(path.join(__dirname, '..', 'assets', 'js', 'parser.js'));
const P = globalThis.GTParser;

let failures = 0;
function check(cond, label, detail) {
  if (cond) {
    console.log('  OK   ' + label + (detail ? ' -> ' + detail : ''));
  } else {
    failures++;
    console.log('  FAIL ' + label + (detail ? ' -> ' + detail : ''));
  }
}

function analyze(name) {
  const file = path.join(__dirname, '..', 'samples', name);
  const text = fs.readFileSync(file, 'utf8');
  const prog = P.parse(text);
  console.log('\n== ' + name + ' ==');
  console.log('  righe:', prog.lines, '| blocchi:', prog.blocks, '| segmenti:', prog.stats.segments);
  console.log('  G00:', prog.stats.byType[0], 'G01:', prog.stats.byType[1], 'G02:', prog.stats.byType[2], 'G03:', prog.stats.byType[3]);
  console.log('  lunghezza:', prog.stats.total.toFixed(2), 'mm | taglio:', prog.stats.cut.toFixed(2), 'mm | rapidi:', prog.stats.rapid.toFixed(2), 'mm');
  console.log('  tempo stimato:', (prog.stats.time / 60).toFixed(2), 'min');
  console.log('  bounds:', JSON.stringify(prog.bounds));
  console.log('  avvisi:', prog.warnings.length);
  prog.warnings.forEach(w => console.log('    - riga ' + w.line + ': ' + w.message));
  return prog;
}

const demo = analyze('DEMO_PART.nc');
check(demo.stats.segments > 50, 'DEMO: almeno 50 segmenti', demo.stats.segments);
check(demo.stats.byType[0] > 0 && demo.stats.byType[1] > 0 && demo.stats.byType[2] > 0 && demo.stats.byType[3] > 0, 'DEMO: tutti i tipi G00-G03 presenti');
check(demo.warnings.length === 0, 'DEMO: nessun avviso', demo.warnings.length);
check(Math.abs(demo.bounds.minX - (-18)) < 0.001, 'DEMO: minX = -18', demo.bounds.minX);
check(Math.abs(demo.bounds.maxX - 158) < 0.001, 'DEMO: maxX = 158', demo.bounds.maxX);
check(Math.abs(demo.bounds.minZ - (-14)) < 0.001, 'DEMO: minZ = -14', demo.bounds.minZ);

const fullCircle = demo.segments.filter(s => s.type === 3 && Math.abs(Math.abs(s.sweep) - Math.PI * 2) < 1e-6);
check(fullCircle.length >= 4, 'DEMO: archi a 360 gradi (elica + finitura)', fullCircle.length);

const helical = demo.segments.filter(s => s.type === 3 && Math.abs(s.z1 - s.z0) > 0.1);
check(helical.length >= 1, 'DEMO: arco elicoidale con variazione Z', helical.length);

const sg = analyze('SG1-1');
check(sg.stats.segments > 30, 'SG1-1: almeno 30 segmenti', sg.stats.segments);
check(sg.warnings.length === 0, 'SG1-1: nessun avviso', sg.warnings.length);
check(sg.segments.some(s => s.plane === 18 && s.type === 3), 'SG1-1: arco G18/G03 presente');
check(sg.segments.some(s => s.plane === 19 && s.type === 3), 'SG1-1: arco G19/G03 presente');
check(sg.segments.some(s => s.block.indexOf('G91') >= 0), 'SG1-1: blocco G91 presente');

const ft = analyze('FT1-2');
check(ft.unit === 'in', 'FT1-2: unita G20 = in', ft.unit);
check(Math.abs(ft.bounds.maxX - 4.5 * 25.4) < 0.01, 'FT1-2: maxX convertito in mm', ft.bounds.maxX);
check(Math.abs(ft.bounds.maxY - 3.5 * 25.4) < 0.01, 'FT1-2: maxY convertito in mm', ft.bounds.maxY);
check(ft.warnings.length === 0, 'FT1-2: nessun avviso', ft.warnings.length);

// Test mirati su arco R con segno negativo e arco > 180
const rTest = P.parse([
  'G21 G90 G17',
  'G00 X0 Y0 Z0',
  'G02 X10 Y0 R5',
  'G03 X0 Y0 R-5'
].join('\n'));
check(rTest.stats.segments === 2, 'R: due archi generati', rTest.stats.segments);
check(Math.abs(Math.abs(rTest.segments[0].sweep) - Math.PI) < 1e-6, 'R positivo: semicerchio', rTest.segments[0].sweep);
check(Math.abs(Math.abs(rTest.segments[1].sweep) - Math.PI) < 1e-6, 'R negativo: semicerchio', rTest.segments[1].sweep);

const micron = P.parse(['G21 G90', 'G00 X0 Y0', 'G01 X45250 Y10000'].join('\n'), { micronNoDecimal: true });
check(Math.abs(micron.segments[0].x1 - 45.25) < 1e-9, 'Micron: X45250 = 45.250 mm', micron.segments[0].x1);

const comments = P.parse(['%', 'O0001 (test)', 'N10 G21 G90 G17', 'N20 G00 X0 Y0 (rapido)', 'N30 G01 X10 Y0 ; linea', 'M30', '%'].join('\n'));
check(comments.stats.segments === 1, 'Commenti/percento: un solo segmento', comments.stats.segments);
check(comments.segments[0].line === 5, 'Commenti: numero riga conservato', comments.segments[0].line);

const inc = P.parse(['G21 G90', 'G00 X10 Y10', 'G91', 'G01 X5 Y-3', 'G90 G01 X0 Y0'].join('\n'));
check(Math.abs(inc.segments[1].x1 - 15) < 1e-9 && Math.abs(inc.segments[1].y1 - 7) < 1e-9, 'G91: quote incrementali', inc.segments[1].x1 + ',' + inc.segments[1].y1);

console.log('\n=========================================');
if (failures) {
  console.log('TEST FALLITI: ' + failures);
  process.exit(1);
}
console.log('TUTTI I TEST PARSER SUPERATI');
