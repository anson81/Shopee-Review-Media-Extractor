/**
 * Guards the four declarations the picker's layout actually depends on.
 *
 * WHY THIS TEST EXISTS.
 *
 * The thumbnail grid collapsed twice — 139 tiles squeezed into rows 14px tall,
 * with no scrollbar, so every picture became a coloured line. Two fixes aimed
 * at Shopee's stylesheet, and both missed, because the cause was here:
 *
 *   1. The grid is a flex child with a definite height. Auto rows are then
 *      sized to fit THAT height, not their contents, and .srme-tile cannot
 *      object because overflow:hidden switches off a grid item's automatic
 *      minimum size. align-content:start plus grid-auto-rows:max-content is
 *      what lets the rows be as tall as the tiles and the grid scroll.
 *
 *   2. The square used padding-top:100%. A percentage padding resolves to
 *      ZERO while the browser computes an intrinsic height, so the grid
 *      measured each tile as just its caption. aspect-ratio does not have
 *      that problem.
 *
 * None of this is visible in a diff — the properties look interchangeable and
 * are not. The real proof is tools/picker-harness.html, which reproduces the
 * picker on a blank page and can be measured; this test is the cheap guard
 * that stops the declarations being "tidied away" between those runs.
 *
 *   node tools/test-picker-layout.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

/**
 * Comments are stripped before anything is matched.
 *
 * The first version of this file scanned the raw text and failed on its own
 * documentation: the comment explaining why padding-top:100% is wrong counts
 * as an occurrence of padding-top:100%. A guard that cannot tell code from
 * prose punishes explaining yourself, which is the opposite of the point.
 */
function code(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => {
      let quote = null;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (quote) {
          if (c === '\\') i++;
          else if (c === quote) quote = null;
        } else if (c === '"' || c === "'" || c === '`') {
          quote = c;
        } else if (c === '/' && line[i + 1] === '/') {
          return line.slice(0, i);
        }
      }
      return line;
    })
    .join('\n');
}

const js = code(fs.readFileSync(path.join(ROOT, 'content/picker.js'), 'utf8'));
const css = code(fs.readFileSync(path.join(ROOT, 'content/picker.css'), 'utf8'));

let failures = 0;

function check(name, condition, detail) {
  if (condition) {
    console.log('  ok   ' + name);
  } else {
    failures += 1;
    console.log('  FAIL ' + name + (detail ? '  -> ' + detail : ''));
  }
}

console.log('grid row sizing');
check("picker.js forces align-content:start", /'align-content':\s*'start'/.test(js));
check("picker.js forces grid-auto-rows:max-content",
  /'grid-auto-rows':\s*'max-content'/.test(js));
check('picker.css agrees on align-content', /align-content:\s*start/.test(css));
check('picker.css agrees on grid-auto-rows', /grid-auto-rows:\s*max-content/.test(css));

console.log('the square');
check('picker.js sizes the media box with aspect-ratio',
  /'aspect-ratio':\s*'1 \/ 1'/.test(js));
check('picker.css sizes the media box with aspect-ratio',
  /aspect-ratio:\s*1\s*\/\s*1/.test(css));

// The specific thing that failed. padding-top:100% on the media box is not a
// stylistic choice, it is the bug — it measures as zero and the row collapses.
check('nothing sizes the media box with percentage padding again',
  !/padding-top:\s*100%/.test(css) && !/'padding-top':\s*'100%'/.test(js),
  'padding-top:100% is back');

console.log('the picture fills the box');
check('the thumbnail is positioned inside the media box',
  /'object-fit':\s*'contain'/.test(js));
check('tiles are big enough to recognise', /Math\.max\(180/.test(js),
  'the 180px floor is gone');

console.log('');
if (failures) {
  console.log(failures + ' failure(s)');
  process.exit(1);
}
console.log('the picker layout contract holds');
