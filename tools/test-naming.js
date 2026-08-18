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
const assigned = N.assignPaths(dupes, N.STYLES.PAGE_REVIEW_TYPE, 'shop_product');
const paths = assigned.map((x) => x.path);
check('gives every colliding item a distinct path',
  new Set(paths).size === paths.length, paths.join(' | '));
check('the first keeps the clean name',
  paths[0] === 'shop_product/reviews/page01_r01_img1.jpg', paths[0]);
check('later ones get a numeric suffix',
  paths[1].endsWith('_2.jpg') && paths[2].endsWith('_3.jpg'), paths.join(' | '));
check('all paths sit under the root folder',
  paths.every((p) => p.startsWith('shop_product/')));

// Case-insensitive filesystems are the trap: two names differing only in case
// are one file on Windows, and the archive would quietly lose one.
const caseClash = N.assignPaths([
  { kind: 'image', source: 'variant', label: 'Blue', mediaIndex: 1, url: 'a.jpg' },
  { kind: 'image', source: 'variant', label: 'blue', mediaIndex: 1, url: 'b.jpg' }
], N.STYLES.PAGE_REVIEW_TYPE, 'shop');
check('treats names differing only by case as colliding',
  caseClash[0].path.toLowerCase() !== caseClash[1].path.toLowerCase(),
  caseClash.map((x) => x.path).join(' | '));

check('sequential numbering stays unique across a big run',
  (() => {
    const many = Array.from({ length: 250 }, () => (
      { kind: 'image', source: 'review', page: 1, reviewIndex: 1, mediaIndex: 1, url: 'x.jpg' }
    ));
    const out = N.assignPaths(many, N.STYLES.SEQUENTIAL, 'shop');
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
  N.zipName('s'.repeat(200), 'p'.repeat(200)).length <= 124);
check('root folder matches the zip name without the extension',
  N.zipName('My Shop', 'My Product') === N.rootFolderName('My Shop', 'My Product') + '.zip');

console.log('');
if (failures) {
  console.log(failures + ' failure(s)');
  process.exit(1);
}
console.log('all naming tests passed');
