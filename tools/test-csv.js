/**
 * Checks reviews.csv survives the things buyers actually write.
 *
 * Escaping is verified by parsing the output back with an independent
 * RFC 4180 reader written here, rather than by comparing against the strings
 * the writer produced — a writer and a matching reader can agree with each
 * other and both be wrong.
 *
 *   node tools/test-csv.js
 */
'use strict';

const { escapeField, build, buildReviewsCsv, REVIEW_HEADERS } = require('../lib/csv.js');

let failures = 0;

function check(name, condition, detail) {
  if (condition) {
    console.log('  ok   ' + name);
  } else {
    failures += 1;
    console.log('  FAIL ' + name + (detail ? '  -> ' + detail : ''));
  }
}

// Expected values are assembled from named pieces rather than written as
// escaped literals: a CSV assertion full of backslashes is unreadable, and an
// unreadable assertion is one nobody checks.
const QUOTE = '"';
const TICK = "'";
const quoted = (inner) => QUOTE + inner + QUOTE;

/**
 * A deliberately literal RFC 4180 parser. Not clever, not fast; its whole
 * job is to be obviously correct so a disagreement means the writer is wrong.
 */
function parseCsv(text) {
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);

  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];

    if (inQuotes) {
      if (c === QUOTE) {
        if (text[i + 1] === QUOTE) { field += QUOTE; i++; }
        else inQuotes = false;
      } else field += c;
      continue;
    }

    if (c === QUOTE) { inQuotes = true; continue; }
    if (c === ',') { row.push(field); field = ''; continue; }
    if (c === '\r' && text[i + 1] === '\n') {
      row.push(field); rows.push(row); field = ''; row = []; i++;
      continue;
    }
    field += c;
  }

  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

console.log('field escaping');
check('leaves a plain field alone', escapeField('hello') === 'hello');
check('quotes a field with a comma', escapeField('a,b') === quoted('a,b'));
check('doubles inner quotes',
  escapeField('say ' + QUOTE + 'hi' + QUOTE) ===
  quoted('say ' + QUOTE + QUOTE + 'hi' + QUOTE + QUOTE));
check('quotes a field with a newline', escapeField('one\ntwo') === quoted('one\ntwo'));
check('quotes a field with edge whitespace', escapeField(' pad ') === quoted(' pad '));
check('renders null as empty', escapeField(null) === '');
check('normalises CRLF inside a field', escapeField('a\r\nb') === quoted('a\nb'));

console.log('spreadsheet formula defusing');
check('defuses a leading = and quotes it',
  escapeField('=1+1') === quoted(TICK + '=1+1'), escapeField('=1+1'));
check('defuses a leading +', escapeField('+A1,B2') === quoted(TICK + '+A1,B2'));
check('defuses past leading whitespace',
  escapeField(' =cmd') === quoted(TICK + ' =cmd'), escapeField(' =cmd'));
check('defuses a leading @', escapeField('@SUM') === quoted(TICK + '@SUM'));
check('leaves a minus mid-text alone', escapeField('well-made') === 'well-made');

console.log('round trip through an independent reader');
const nasty = [
  ['1', '1', '2026-07-14', '5', 'ahmad', 'Blue, Large', 'Good, very good', 'a.jpg; b.jpg'],
  ['1', '2', '2026-07-15', '4', 'siti', 'Merah', 'Line one\nLine two', 'c.jpg'],
  ['2', '1', '2026-07-16', '5', '陈先生', '藍色', 'He said ' + QUOTE + 'perfect' + QUOTE, 'd.mp4'],
  ['2', '2', '2026-07-17', '3', 'ผู้ใช้', '', '=SUM(A1:A9) looks odd', 'e.jpg']
];
const doc = build(REVIEW_HEADERS, nasty);
const parsed = parseCsv(doc);

check('starts with a UTF-8 BOM', doc.charCodeAt(0) === 0xFEFF);
check('uses CRLF between records', doc.includes('\r\n'));
check('has a header plus every row', parsed.length === nasty.length + 1,
  parsed.length + ' rows');
check('header round-trips', parsed[0].join('|') === REVIEW_HEADERS.join('|'),
  parsed[0].join('|'));

let mismatches = 0;
nasty.forEach((expected, r) => {
  const got = parsed[r + 1] || [];
  expected.forEach((cell, c) => {
    // The formula defuser intentionally alters this one; compare accordingly.
    const want = /^[\t\r ]*[=+\-@]/.test(cell) ? TICK + cell : cell;
    if (got[c] !== want) {
      mismatches += 1;
      console.log('       row ' + r + ' col ' + c + ': ' +
        JSON.stringify(got[c]) + ' != ' + JSON.stringify(want));
    }
  });
});
check('every cell round-trips exactly', mismatches === 0, mismatches + ' bad cells');

console.log('reviews.csv shape');
const csv = buildReviewsCsv([
  { page: 1, reviewIndex: 3, date: '2026-07-14', stars: 5, buyer: 'ahmad',
    variant: 'Blue', comment: 'nice', files: ['page01_r03_img1.jpg', 'page01_r03_img2.jpg'] }
]);
const back = parseCsv(csv);
check('emits one row per review', back.length === 2, back.length + ' rows');
check('joins filenames into one cell',
  back[1][7] === 'page01_r03_img1.jpg; page01_r03_img2.jpg', back[1][7]);
check('keeps columns in the documented order',
  back[0][0] === 'page' && back[0][6] === 'comment' && back[0][7] === 'files');

const empty = parseCsv(buildReviewsCsv([]));
check('a review-free export still writes a header', empty.length === 1, empty.length + ' rows');

console.log('');
if (failures) {
  console.log(failures + ' failure(s)');
  process.exit(1);
}
console.log('all csv tests passed');
