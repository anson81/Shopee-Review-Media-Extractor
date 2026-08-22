/**
 * Guards what an offscreen document is actually allowed to call.
 *
 * Chrome's own words, on the offscreen API page:
 *
 *   "The runtime API is the only extensions API supported by offscreen
 *    documents."
 *
 * Everything else — downloads, storage, tabs, scripting — is undefined in
 * there. Not restricted, not silently ignored: undefined. `chrome.downloads`
 * is a missing property, so the call site throws a TypeError that reads
 * nothing like a permissions problem:
 *
 *   Cannot read properties of undefined (reading 'download')
 *
 * That is not hypothetical either. v1.2.1 moved the downloads fallback INTO
 * this document on the reasoning that "offscreen documents are extension
 * contexts, so the downloads permission applies here just as it does there" —
 * true about permissions, false about APIs. The primary path writes into the
 * chosen folder and never reaches the fallback, so on a machine with a working
 * folder handle the bug is invisible. It waited until 22 August 2026 for a
 * Linux laptop whose folder permission had lapsed, and ate a 162-item run.
 *
 * The rule is: offscreen code may call chrome.runtime and nothing else.
 * Anything else the document needs done, it asks the service worker to do.
 *
 *   node tools/test-offscreen-apis.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OFFSCREEN_HTML = path.join(ROOT, 'offscreen', 'offscreen.html');

/** The one API Chrome supports in an offscreen document. */
const ALLOWED = new Set(['runtime']);

let failures = 0;

function check(name, condition, detail) {
  if (condition) {
    console.log('  ok   ' + name);
  } else {
    failures += 1;
    console.log('  FAIL ' + name + (detail ? '  -> ' + detail : ''));
  }
}

/**
 * Lines of a file with comments removed.
 *
 * A blunt scan would forbid EXPLAINING the rule, and the explanation is most
 * of what stops someone undoing it — this very file names chrome.downloads
 * half a dozen times above. So prose may name an API; code may not.
 *
 * Same approach as tools/test-no-filename-listener.js, and deliberately a
 * copy rather than a shared module: these tests are plain node against the
 * source with nothing to install, and a guard that depends on another file is
 * a guard that can be disabled by editing that other file.
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

    s = s.replace(/\/\*[\s\S]*?\*\//g, ' ');
    const open = s.indexOf('/*');
    if (open !== -1) {
      inBlock = true;
      s = s.slice(0, open);
    }

    s = s.replace(/<!--[\s\S]*?-->/g, ' ');
    if (s.includes('<!--')) s = s.slice(0, s.indexOf('<!--'));

    let quote = null;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (quote) {
        if (c === '\\') i++;
        else if (c === quote) quote = null;
      } else if (c === '"' || c === "'" || c === '`') {
        quote = c;
      } else if (c === '/' && s[i + 1] === '/') {
        s = s.slice(0, i);
        break;
      }
    }

    if (s.trim()) out.push(s);
  }

  return out;
}

/**
 * Collapse the ways an API can be reached without writing chrome.name.
 *
 * `chrome['down' + 'loads'].download(...)` is a real call, and a dot-only
 * scan never sees it. Joining adjacent string literals, dropping quotes and
 * rewriting bracket access as dot access turns every spelling back into the
 * same identifier.
 */
function normalise(code) {
  return code
    .replace(/(['"`])\s*\+\s*(['"`])/g, '')
    .replace(/['"`]/g, '')
    .replace(/\[\s*([A-Za-z_$][\w$]*)\s*\]/g, '.$1');
}

/** Every chrome.<api> named by the code in `text`, in order. */
function apisUsed(text) {
  const found = [];
  for (const line of codeLines(text)) {
    const re = /\bchrome\s*\.\s*([A-Za-z_$][\w$]*)/g;
    let m;
    while ((m = re.exec(normalise(line)))) found.push(m[1]);
  }
  return found;
}

/**
 * The scripts the offscreen document actually loads.
 *
 * Read from the HTML rather than hardcoded: a second script file added later
 * runs under exactly the same restriction, and a guard that only knows about
 * offscreen.js would wave it through.
 */
function offscreenScripts() {
  const html = fs.readFileSync(OFFSCREEN_HTML, 'utf8');
  const out = [];
  const re = /<script\b[^>]*\bsrc\s*=\s*['"]([^'"]+)['"]/gi;
  let m;
  while ((m = re.exec(html))) out.push(path.resolve(path.dirname(OFFSCREEN_HTML), m[1]));
  return out;
}

console.log('the document');
const scripts = offscreenScripts();
check('offscreen.html loads at least one script', scripts.length > 0);
check('every script it loads exists',
  scripts.every((f) => fs.existsSync(f)),
  scripts.filter((f) => !fs.existsSync(f)).join(', '));

// An inline <script> would run under the same rule and never be scanned. MV3's
// CSP forbids one anyway; this says so out loud, so the guard cannot be
// stepped around by moving code into the page.
const htmlApis = apisUsed(fs.readFileSync(OFFSCREEN_HTML, 'utf8'));
check('offscreen.html has no inline script calling chrome.*',
  htmlApis.length === 0,
  htmlApis.join(', '));

console.log('');
console.log('the code it loads');
for (const file of scripts.filter((f) => fs.existsSync(f))) {
  const used = apisUsed(fs.readFileSync(file, 'utf8'));
  const banned = [...new Set(used.filter((api) => !ALLOWED.has(api)))];
  check(path.relative(ROOT, file) + ' calls only chrome.runtime',
    banned.length === 0,
    banned.length
      ? 'undefined in an offscreen document: ' + banned.map((a) => 'chrome.' + a).join(', ')
      : '');
}

// A guard that has quietly stopped looking passes exactly as loudly as one
// that works, so it is made to prove itself on the spellings it must catch.
console.log('');
console.log('the guard itself');
check('catches a plain call',
  apisUsed('const id = await chrome.downloads.download({ url });').includes('downloads'));
check('catches bracket access',
  apisUsed("chrome['downloads'].download({ url });").includes('downloads'));
check('catches a concatenated name',
  apisUsed("chrome['down' + 'loads'].download({ url });").includes('downloads'));
check('still allows chrome.runtime',
  apisUsed('chrome.runtime.onMessage.addListener(fn);')
    .every((api) => ALLOWED.has(api)));
check('still ignores a block comment',
  apisUsed('/* chrome.downloads.download is not available here */').length === 0);
check('still ignores a line comment',
  apisUsed('// chrome.storage.local would throw').length === 0);
check('a // inside a string does not hide the rest of the line',
  apisUsed('const u = "http://x"; chrome.tabs.query({});').includes('tabs'));

console.log('');
if (failures) {
  console.log(failures + ' failure(s)');
  process.exit(1);
}
console.log('the offscreen document calls only the API Chrome gives it');
