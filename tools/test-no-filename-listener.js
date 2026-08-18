/**
 * Guards the one rule this extension must never break.
 *
 * chrome.downloads.onDeterminingFilename is browser-wide: every extension
 * holding the downloads permission is asked about every download, and Chrome
 * gives the final say to the most recently installed one that answers. A
 * listener here that so much as says "no opinion" would override whichever
 * sibling did have an opinion, and their exports would start arriving as
 * download.zip again.
 *
 * That is not hypothetical. It is exactly what SiteGiant Downloader and Shopee
 * Report Downloader did to each other through August 2026, and this extension
 * is the third one on the same machine.
 *
 * So the rule is: never register the listener, at all. A rule that is only
 * written down gets broken by someone fixing something else in a hurry, which
 * is why it is also a test.
 *
 *   node tools/test-no-filename-listener.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SKIP_DIRS = new Set(['.git', 'node_modules', 'docs', 'tools']);
const CODE = /\.(js|html)$/i;

const FORBIDDEN = 'onDeterminingFilename';

let failures = 0;

function check(name, condition, detail) {
  if (condition) {
    console.log('  ok   ' + name);
  } else {
    failures += 1;
    console.log('  FAIL ' + name + (detail ? '  -> ' + detail : ''));
  }
}

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      out.push(...walk(path.join(dir, entry.name)));
    } else if (CODE.test(entry.name)) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

/**
 * Lines of a file with comments removed.
 *
 * A blunt substring ban would forbid EXPLAINING the rule, and the explanation
 * is most of what stops someone undoing it. So prose may name the API; code
 * may not.
 *
 * This tracks block comments and skips whole-line comments. It does not
 * understand a comment marker inside a string literal, which would make it
 * over-strict rather than lax — it would report a line nobody meant to hide.
 * For a one-token ban that is the right way to be wrong.
 */
function codeLines(text) {
  const out = [];
  let inBlock = false;

  for (const line of text.split(/\r?\n/)) {
    let s = line;

    if (inBlock) {
      const end = s.indexOf('*/');
      if (end === -1) continue;
      s = s.slice(end + 2);
      inBlock = false;
    }

    // Strip any complete /* ... */ runs, then an unterminated one.
    s = s.replace(/\/\*[\s\S]*?\*\//g, ' ');
    const open = s.indexOf('/*');
    if (open !== -1) {
      inBlock = true;
      s = s.slice(0, open);
    }

    // HTML comments, for the .html files.
    s = s.replace(/<!--[\s\S]*?-->/g, ' ');
    if (s.includes('<!--')) s = s.slice(0, s.indexOf('<!--'));

    const lineComment = s.indexOf('//');
    if (lineComment !== -1) s = s.slice(0, lineComment);

    if (s.trim()) out.push(s);
  }

  return out;
}

console.log('shipped code');
const files = walk(ROOT);
check('found files to scan', files.length > 0, files.length + ' files');

const offenders = files.filter((f) =>
  codeLines(fs.readFileSync(f, 'utf8')).some((l) => l.includes(FORBIDDEN)));
check('no shipped code references ' + FORBIDDEN,
  offenders.length === 0,
  offenders.map((f) => path.relative(ROOT, f)).join(', '));

// Proves the scanner can still see a real registration — a guard that has
// quietly stopped looking passes just as loudly as one that works.
const decoy = [
  '/* mentions ' + FORBIDDEN + ' harmlessly */',
  '// and ' + FORBIDDEN + ' again',
  'chrome.downloads.' + FORBIDDEN + '.addListener(fn);'
].join('\n');
check('the scanner ignores comments but catches code',
  codeLines(decoy).length === 1 && codeLines(decoy)[0].includes(FORBIDDEN));

console.log('manifest');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));

// The permission itself is legitimate — the fallback path needs it when no
// folder has been chosen. What must never appear is the listener.
check('declares the downloads permission for the fallback',
  (manifest.permissions || []).includes('downloads'));

check('declares offscreen, which the primary path needs',
  (manifest.permissions || []).includes('offscreen'));

console.log('');
if (failures) {
  console.log(failures + ' failure(s)');
  process.exit(1);
}
console.log('the filename listener is absent, as it must be');
