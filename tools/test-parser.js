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

// ------------------------------------------------------------------
// Custom Macro B
// ------------------------------------------------------------------
const sformo = analyze('SFORMO_VAR');
check(sformo.stats.segments > 550 && sformo.stats.segments < 700, 'SFORMO: ciclo macro espanso (~604 segmenti)', sformo.stats.segments);
check(sformo.stats.byType[3] >= 60, 'SFORMO: 60 archi G03, uno per passata', sformo.stats.byType[3]);
check(Math.abs(sformo.bounds.minZ + 3) < 1e-6, 'SFORMO: profondita Z -3', sformo.bounds.minZ);
check(Math.abs(sformo.bounds.maxZ - 200) < 1e-6, 'SFORMO: Z massimo 200', sformo.bounds.maxZ);
check(Math.abs(sformo.finalPosition.z - 100) < 1e-6, 'SFORMO: G53 non sposta la posizione finale (Z100)', sformo.finalPosition.z);
check(Math.abs(sformo.macros.variables[800] + 3) < 1e-6, 'SFORMO: #800 = -3 dopo il ciclo', sformo.macros.variables[800]);
check(Math.abs(sformo.macros.variables[801] + 3) < 1e-6, 'SFORMO: #801 = -3', sformo.macros.variables[801]);
check(sformo.macros.variables[777] === 0, 'SFORMO: #777 azzerato a fine programma', sformo.macros.variables[777]);
check(sformo.macros.labels === 4, 'SFORMO: 4 etichette N', sformo.macros.labels);
check(sformo.segments.filter(s => s.n === 'N100').length >= 600, 'SFORMO: segmenti del loop marcati N100');
check(sformo.segments.some(s => s.block.indexOf('G41G1D#777') >= 0), 'SFORMO: blocco originale conservato');
check(!sformo.warnings.some(w => /Errore di parsing|Macro:/.test(w.message)), 'SFORMO: nessun errore macro');

const macroExpr = P.parse([
  'G21 G90',
  '#1=ABS[-5]',
  '#2=ROUND[1.5]',
  '#3=[90-30]/2',
  '#4=TAN[45]',
  '#5=SQRT[16]',
  'G0 X#1 Y#2',
  'G1 X#3 Y#4',
  'G1 X#5'
].join('\n'));
check(macroExpr.stats.segments === 3, 'MACRO: tre segmenti con variabili', macroExpr.stats.segments);
check(Math.abs(macroExpr.segments[0].x1 - 5) < 1e-9 && Math.abs(macroExpr.segments[0].y1 - 2) < 1e-9,
  'MACRO: ABS[-5]=5 e ROUND[1.5]=2', macroExpr.segments[0].x1 + ',' + macroExpr.segments[0].y1);
check(Math.abs(macroExpr.segments[1].x1 - 30) < 1e-9 && Math.abs(macroExpr.segments[1].y1 - 1) < 1e-9,
  'MACRO: [90-30]/2=30 e TAN[45]=1', macroExpr.segments[1].x1 + ',' + macroExpr.segments[1].y1);
check(Math.abs(macroExpr.segments[2].x1 - 4) < 1e-9, 'MACRO: SQRT[16]=4', macroExpr.segments[2].x1);

const ifTrue = P.parse([
  'G21 G90',
  '#1=3',
  'IF[#1EQ3]GOTO20',
  'G1 X99',
  'N20',
  'G1 X10'
].join('\n'));
check(ifTrue.stats.segments === 1 && Math.abs(ifTrue.segments[0].x1 - 10) < 1e-9,
  'MACRO: IF vero salta al blocco N20', ifTrue.stats.segments);

const ifFalse = P.parse([
  'G21 G90',
  '#1=2',
  'IF[#1EQ3]GOTO20',
  'G1 X10',
  'GOTO30',
  'N20',
  'G1 X99',
  'N30',
  'G1 X20'
].join('\n'));
check(ifFalse.stats.segments === 2 &&
  Math.abs(ifFalse.segments[0].x1 - 10) < 1e-9 &&
  Math.abs(ifFalse.segments[1].x1 - 20) < 1e-9,
  'MACRO: IF falso prosegue e GOTO salta N20', ifFalse.stats.segments);

const gotoTest = P.parse([
  'G21 G90',
  'GOTO20',
  'G1 X99',
  'N20',
  'G1 X10'
].join('\n'));
check(gotoTest.stats.segments === 1 && Math.abs(gotoTest.segments[0].x1 - 10) < 1e-9,
  'MACRO: GOTO incondizionato', gotoTest.stats.segments);

const loopTest = P.parse([
  'G21 G90',
  '#1=0',
  'N10',
  '#1=#1+0.05',
  'G1 X#1',
  'IF[#1EQ1.0]GOTO20',
  'GOTO10',
  'N20'
].join('\n'));
check(loopTest.stats.segments === 20, 'MACRO: 20 passate con EQ su float', loopTest.stats.segments);
check(Math.abs(loopTest.segments[19].x1 - 1) < 1e-9, 'MACRO: X finale 1.0', loopTest.segments[19].x1);

const toolTest = P.parse([
  'G21 G90',
  '#777=3',
  'T#777M6',
  'G43H#777Z200',
  'G41G1D#777X10Y0'
].join('\n'));
check(toolTest.stats.segments === 2, 'MACRO: T/H/D con variabili', toolTest.stats.segments);
check(toolTest.warnings.some(w => /G41/.test(w.message)), 'MACRO: avviso compensazione G41');

const missing = P.parse(['G21 G90', 'GOTO99', 'G1 X10'].join('\n'));
check(missing.stats.segments === 0, 'MACRO: GOTO inesistente non traccia', missing.stats.segments);
check(missing.warnings.some(w => /inesistente/.test(w.message)), 'MACRO: avviso GOTO inesistente');

const loopLimit = P.parse(['N10', 'GOTO10'].join('\n'), { maxMacroSteps: 100 });
check(loopLimit.macros.limitReached === true, 'MACRO: limite passi attivato');
check(loopLimit.warnings.some(w => /Limite/.test(w.message)), 'MACRO: avviso limite passi');

console.log('\n=========================================');
if (failures) {
  console.log('TEST FALLITI: ' + failures);
  process.exit(1);
}
console.log('TUTTI I TEST PARSER SUPERATI');
