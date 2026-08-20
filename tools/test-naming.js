/**
 * Checks filenames are safe on Windows and never collide.
 *
 * A collision here does not throw — it silently overwrites one buyer's photo
 * with another's inside the archive — so the uniqueness checks matter more
 * than they look.
 *
 *   node tools/test-naming.js
 */
'use strict';

const N = require('../lib/naming.js');

let failures = 0;

function check(name, condition, detail) {
  if (condition) {
    console.log('  ok   ' + name);
  } else {
    failures += 1;
    console.log('  FAIL ' + name + (detail ? '  -> ' + detail : ''));
  }
}

/** Written as a loop, not a regex, so no control character appears in source. */
function hasControlChars(s) {
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) < 32) return true;
  }
  return false;
}

console.log('segment sanitising');
const ILLEGAL_SAMPLE = 'a<b>c:d"e/f\\g|h?i*j';
const cleaned = N.sanitizeSegment(ILLEGAL_SAMPLE, 'x');
check('removes every Windows-illegal character',
  !/[<>:"/\\|?*]/.test(cleaned), cleaned);

const withControls = 'a' + String.fromCharCode(9) + 'b' + String.fromCharCode(1) + 'c';
check('strips control characters',
  !hasControlChars(N.sanitizeSegment(withControls, 'x')),
  JSON.stringify(N.sanitizeSegment(withControls, 'x')));

check('collapses runs of whitespace', N.sanitizeSegment('a    b', 'x') === 'a b');
check('drops trailing dots and spaces',
  N.sanitizeSegment('name...  ', 'x') === 'name', N.sanitizeSegment('name...  ', 'x'));
check('never returns empty', N.sanitizeSegment('///', 'fallback') === 'fallback');
check('never returns empty for null', N.sanitizeSegment(null, 'fallback') === 'fallback');
check('escapes reserved device names', N.sanitizeSegment('CON', 'x') === '_CON');
check('escapes a reserved name with an extension',
  N.sanitizeSegment('nul.jpg', 'x') === '_nul.jpg', N.sanitizeSegment('nul.jpg', 'x'));
check('leaves a name merely containing one alone',
  N.sanitizeSegment('CONSOLE', 'x') === 'CONSOLE');
check('truncates a very long segment', N.sanitizeSegment('a'.repeat(300), 'x').length <= 80);
check('keeps non-Latin names intact', N.sanitizeSegment('陈先生 ผู้ใช้', 'x') === '陈先生 ผู้ใช้');

console.log('extensions');
check('reads a plain image extension',
  N.extensionFor({ url: 'https://cdn/x/a.jpg', kind: 'image' }) === 'jpg');
check('ignores the query string',
  N.extensionFor({ url: 'https://cdn/a.png?w=100', kind: 'image' }) === 'png');
check('defaults an extensionless image to jpg',
  N.extensionFor({ url: 'https://cdn/abc123def', kind: 'image' }) === 'jpg');
check('defaults an extensionless video to mp4',
  N.extensionFor({ url: 'https://cdn/abc123def', kind: 'video' }) === 'mp4');
check('rejects a path segment that only looks like an extension',
  N.extensionFor({ url: 'https://cdn/file.thing', kind: 'image' }) === 'jpg');

console.log('filename styles');
const review = {
  kind: 'image', source: 'review', page: 1, reviewIndex: 3, mediaIndex: 1,
  ctime: 1752451200, buyer: 'Ahmad Bin Ali'
};
check('page-review-type',
  N.baseName(review, N.STYLES.PAGE_REVIEW_TYPE, 1) === 'page01_r03_img1',
  N.baseName(review, N.STYLES.PAGE_REVIEW_TYPE, 1));
check('date-buyer lowercases and hyphenates the buyer',
  /^\d{4}-\d{2}-\d{2}_ahmad-bin-ali_img1$/.test(N.baseName(review, N.STYLES.DATE_BUYER, 1)),
  N.baseName(review, N.STYLES.DATE_BUYER, 1));
check('sequential ignores everything else',
  N.baseName(review, N.STYLES.SEQUENTIAL, 7) === '0007');
check('an undated review does not produce NaN',
  N.baseName(Object.assign({}, review, { ctime: null }), N.STYLES.DATE_BUYER, 1)
    .startsWith('undated'));
check('a video is tagged vid',
  N.baseName(Object.assign({}, review, { kind: 'video' }), N.STYLES.PAGE_REVIEW_TYPE, 1)
    === 'page01_r03_vid1');

console.log('folders');
check('review media goes to reviews/', N.folderFor({ source: 'review' }) === 'reviews');
check('description goes to description/',
  N.folderFor({ source: 'description' }) === 'description');
check('main images go to product/', N.folderFor({ source: 'main' }) === 'product');
check('variants go to product/', N.folderFor({ source: 'variant' }) === 'product');

console.log('path assignment and collisions');
const dupes = [
  { kind: 'image', source: 'review', page: 1, reviewIndex: 1, mediaIndex: 1, url: 'a.jpg' },
  { kind: 'image', source: 'review', page: 1, reviewIndex: 1, mediaIndex: 1, url: 'b.jpg' },
  { kind: 'image', source: 'review', page: 1, reviewIndex: 1, mediaIndex: 1, url: 'c.jpg' }
];
const assigned = N.assignPaths(dupes, N.STYLES.PAGE_REVIEW_TYPE);
const paths = assigned.map((x) => x.path);
check('gives every colliding item a distinct path',
  new Set(paths).size === paths.length, paths.join(' | '));
check('the first keeps the clean name',
  paths[0] === 'reviews/page01_r01_img1.jpg', paths[0]);
check('later ones get a numeric suffix',
  paths[1].endsWith('_2.jpg') && paths[2].endsWith('_3.jpg'), paths.join(' | '));

// The archive must NOT repeat the product name inside itself. Windows creates
// a folder named after the zip when extracting, so an inner copy put the same
// 100-character Shopee title in the path twice and Windows refused the
// extraction outright with "Destination Path Too Long".
check('nothing is nested under a product folder',
  paths.every((p) => p.split('/').length === 2), paths.join(' | '));
check('paths start at a known subfolder',
  paths.every((p) => /^(reviews|product|description)\//.test(p)), paths.join(' | '));

// Case-insensitive filesystems are the trap: two names differing only in case
// are one file on Windows, and the archive would quietly lose one.
const caseClash = N.assignPaths([
  { kind: 'image', source: 'variant', label: 'Blue', mediaIndex: 1, url: 'a.jpg' },
  { kind: 'image', source: 'variant', label: 'blue', mediaIndex: 1, url: 'b.jpg' }
], N.STYLES.PAGE_REVIEW_TYPE);
check('treats names differing only by case as colliding',
  caseClash[0].path.toLowerCase() !== caseClash[1].path.toLowerCase(),
  caseClash.map((x) => x.path).join(' | '));

check('sequential numbering stays unique across a big run',
  (() => {
    const many = Array.from({ length: 250 }, () => (
      { kind: 'image', source: 'review', page: 1, reviewIndex: 1, mediaIndex: 1, url: 'x.jpg' }
    ));
    const out = N.assignPaths(many, N.STYLES.SEQUENTIAL);
    return new Set(out.map((x) => x.path)).size === 250;
  })());

console.log('archive naming');
check('zip name ends in .zip', N.zipName('My Shop', 'My Product').endsWith('.zip'));
check('zip name has no spaces',
  !/\s/.test(N.zipName('My Shop', 'My Product')), N.zipName('My Shop', 'My Product'));
check('zip name survives a hostile shop name',
  !/[<>:"/\\|?*]/.test(N.zipName('Shop/Name*', 'Prod?')),
  N.zipName('Shop/Name*', 'Prod?'));
check('a very long pair is truncated',
  N.zipName('s'.repeat(200), 'p'.repeat(200)).length <= 75,
  String(N.zipName('s'.repeat(200), 'p'.repeat(200)).length));

/*
 * WINDOWS MAX_PATH, END TO END.
 *
 * A real export failed to extract: "The file name(s) would be too long for the
 * destination folder." A Shopee title is a keyword list, not a name —
 *
 *   QFM Melody Batwing Knitwear Top (#3299) | Oversize Modest Blouse Muslimah
 *   Baju Knit Long Sleeve
 *
 * — and it was being spent twice, once in the folder Windows creates on
 * extraction and again in a root folder inside the archive.
 *
 * So the whole extracted path is reconstructed here, exactly as Windows builds
 * it, and checked against the real 260 limit. Testing the pieces separately is
 * what let this ship.
 */
console.log('windows MAX_PATH, end to end');
const longShop = 'Super Duper Gadget Emporium Malaysia Official Store';
const longProduct =
  'QFM Melody Batwing Knitwear Top (#3299) | Oversize Modest Blouse Muslimah Baju Knit Long Sleeve';

const zip = N.zipName(longShop, longProduct);
const worst = N.assignPaths(
  Array.from({ length: 3 }, () => ({
    kind: 'image', source: 'review', page: 99, reviewIndex: 99, mediaIndex: 9,
    ctime: 1752451200, buyer: 'a-very-long-buyer-name-indeed', url: 'a.jpg'
  })),
  N.STYLES.DATE_BUYER
);

// Exactly what Windows ends up with: the seller's folder, our dated folder,
// the folder Explorer creates from the zip's name, then the archive contents.
const WINDOWS_PREFIX = 'C:\\Users\\QFM Zaty\\Documents\\';
const extracted = worst.map((w) =>
  WINDOWS_PREFIX + 'Shopee Review Media\\2026-08-20\\' +
  zip.replace(/\.zip$/, '') + '\\' + w.path.replace(/\//g, '\\'));

const longest = Math.max(...extracted.map((p) => p.length));
check('a worst-case extracted path stays under Windows MAX_PATH',
  longest < 260, longest + ' chars: ' + extracted[0]);
check('the product name appears only once in the path',
  extracted[0].split('Batwing').length - 1 <= 1, extracted[0]);

console.log('astral characters');
// slice() cuts UTF-16 code units, so truncation could split an emoji and
// leave a lone surrogate, which becomes U+FFFD in the archive path. Shopee
// shop names carry emoji constantly.
const emojiName = 'shop'.repeat(19) + '👍👍👍';
const cut = N.sanitizeSegment(emojiName, 'x');
check('truncation never leaves a lone surrogate',
  !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(cut) &&
  !/(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(cut),
  JSON.stringify(cut.slice(-4)));

console.log('length limits');
const wide = N.assignPaths(
  Array.from({ length: 3 }, () => ({
    kind: 'image', source: 'variant', label: 'L'.repeat(200), mediaIndex: 1, url: 'a.jpg'
  })),
  N.STYLES.PAGE_REVIEW_TYPE
);
check('a collision suffix cannot push a segment back over the cap',
  wide.every((w) => w.path.split('/').pop().length <= 90),
  wide.map((w) => w.path.split('/').pop().length).join(', '));
check('the whole in-archive path leaves room for an extract folder',
  wide.every((w) => w.path.length <= 90),
  'longest ' + Math.max(...wide.map((w) => w.path.length)));

console.log('more reserved device names');
check('CONIN$ is escaped', N.sanitizeSegment('CONIN$', 'x') === '_CONIN$');
check('CONOUT$ is escaped', N.sanitizeSegment('conout$', 'x') === '_conout$');
check('COM with a superscript digit is escaped',
  N.sanitizeSegment('COM¹', 'x') === '_COM¹', N.sanitizeSegment('COM¹', 'x'));

console.log('');
if (failures) {
  console.log(failures + ' failure(s)');
  process.exit(1);
}
console.log('all naming tests passed');
