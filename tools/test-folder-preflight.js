/**
 * Guards the rule that a run refuses to start without somewhere to put it.
 *
 * WHY.
 *
 * Chrome's onDeterminingFilename is browser-wide, and the final word goes to
 * the most recently installed extension that answers. suggest() with no
 * arguments is an ANSWER, not silence: it tells Chrome to use the tentative
 * name it invented from the URL. This extension's archive goes out as a blob:
 * URL, whose tentative name is the blob's own UUID — so a stranger's polite
 * "no opinion" turned the P50 laptop's export into
 * cc18a2ea-6761-4a14-945b-be74e5b4c2eb.zip in plain Downloads on 22 October
 * 2026, the folder lost along with the name.
 *
 * That contest was fought for three weeks across the two sibling extensions
 * and cannot be won: the winner changes whenever anything else on the machine
 * updates itself. The Shopee Report Downloader left it in v1.19.0 and writes
 * its files itself. The folder writer here IS that — the only hole was the
 * quiet fallback that re-entered the contest whenever no folder was chosen.
 *
 * So the rule is: with saveVia on 'folder', no usable folder means no run,
 * decided BEFORE anything is fetched. Someone who deliberately picks
 * "Through Chrome downloads" in Options has read the trade and is not stopped.
 *
 * This is a wiring check, in the style of tools/test-diagnostics.js: it reads
 * the source rather than booting a service worker, because background.js
 * starts with importScripts and node has no such thing. It cannot prove the
 * preflight WORKS. It proves nobody has quietly removed it, which is how this
 * whole class of bug has come back every time.
 *
 *   node tools/test-folder-preflight.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

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
 * Comments stripped, because this file EXPLAINS the preflight at length and
 * so does background.js. A scan that counts prose passes happily against code
 * that no longer does anything — which it did, on the first run of this very
 * test: "runExport calls it" went green on the words "see folderReady()" in a
 * comment while the call itself had been replaced.
 */
function codeOnly(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split(/\r?\n/)
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

/** Just one function's body, so a later one's call cannot stand in for it. */
function bodyOf(code, signature) {
  const start = code.indexOf(signature);
  if (start === -1) return '';
  const next = code.slice(start + signature.length).search(/\n(?:async )?function \w+\(/);
  return next === -1 ? code.slice(start) : code.slice(start, start + signature.length + next);
}

const bg = codeOnly(read('background/background.js'));
const off = codeOnly(read('offscreen/offscreen.js'));
const popup = codeOnly(read('popup/popup.js'));

console.log('the writer can be asked');
check('offscreen.js answers a check action', /action === 'check'/.test(off));
check('and that answer reads the real permission',
  /checkFolder[\s\S]{0,400}queryPermission/.test(off));
check('a missing handle is no-folder, not an error',
  /if \(!root\) return \{ ok: false, reason: 'no-folder' \}/.test(off));

console.log('');
console.log('the run asks before it fetches');
check('background.js has a folderReady preflight', /async function folderReady\(/.test(bg));

const run = bodyOf(bg, 'async function runExport(');
check('runExport was found to scan', run.length > 0);
check('runExport calls it', /folderReady\(/.test(run));

// The whole point is the ORDER. A preflight that runs after the fetch loop
// would pass every other check here and still cost a four-hundred-file run.
const calledAt = run.indexOf('folderReady(');
const fetchAt = run.indexOf("setPhase('fetching'");
check('and calls it BEFORE the fetch phase starts',
  calledAt !== -1 && fetchAt !== -1 && calledAt < fetchAt,
  'folderReady at ' + calledAt + ', fetching at ' + fetchAt);

check('a failed preflight stops the run rather than carrying on',
  /folder\?\.ok[\s\S]{0,600}throw new Error/.test(run));

// The deliberate choice stays available — this guard is about the SILENT
// fallback, not about taking the option away from someone who read the page.
check("an explicit 'downloads' choice skips the preflight",
  /saveVia !== 'downloads'[\s\S]{0,200}folderReady/.test(run));

console.log('');
console.log('the popup says so before the picker opens');
check('popup asks canSave', /type: 'canSave'/.test(popup));
check('background answers canSave', /case 'canSave'/.test(bg));
check('and the popup stops instead of starting a run',
  /canSave[\s\S]{0,500}return;/.test(popup));

console.log('');
console.log('nothing still promises the old behaviour');
const optionsHtml = read('options/options.html');
check('Options does not still say a folder is optional',
  !/Without one,\s*\n?\s*it asks Chrome to save the file/.test(optionsHtml));

console.log('');
if (failures) {
  console.log(failures + ' failure(s)');
  process.exit(1);
}
console.log('no folder, no run — the naming contest is not entered by accident');
