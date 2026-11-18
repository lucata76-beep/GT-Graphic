/* Genera assets/js/demo.js da samples/DEMO_PART.nc (sorgente unico). */
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const nc = fs.readFileSync(path.join(root, 'samples', 'DEMO_PART.nc'), 'utf8')
  .replace(/\r\n?/g, '\n')
  .replace(/\n+$/, '');
const lines = nc.split('\n');

const body = lines.map(function (l) { return '    ' + JSON.stringify(l); }).join(',\n');

const out = [
  '/*!',
  ' * GT-Graphic - Programma dimostrativo integrato.',
  ' * FILE GENERATO da samples/DEMO_PART.nc tramite tools/build-demo.js',
  ' * Non modificare a mano: aggiornare il .nc e rigenerare.',
  ' * Contiene G00, G01, G02, G03, eliche, piani G18/G19 e un blocco G91.',
  ' */',
  '(function (root) {',
  "  'use strict';",
  '',
  "  var DEMO_NAME = 'DEMO_PART.nc';",
  '',
  '  var DEMO_TEXT = [',
  body,
  "  ].join('\\n');",
  '',
  '  root.GT_DEMO = {',
  '    name: DEMO_NAME,',
  '    text: DEMO_TEXT',
  '  };',
  "})(typeof window !== 'undefined' ? window : globalThis);",
  ''
].join('\n');

fs.writeFileSync(path.join(root, 'assets', 'js', 'demo.js'), out, 'utf8');
console.log('demo.js generato da samples/DEMO_PART.nc (' + lines.length + ' righe)');
