/**
 * The diagnostics report is only worth having if it is true and safe to send.
 *
 * WHY THIS TEST EXISTS.
 *
 * This report is written to be forwarded - pasted into a chat, sent on to
 * whoever is fixing the problem. Two things must hold every time, and neither
 * is visible by reading the output once and deciding it looks fine:
 *
 *   1. It must not carry the person's name out of their home directory. Paths
 *      are the one genuinely personal thing a run record holds, and they are
 *      never what a bug turns on.
 *   2. It must keep the facts that bugs HAVE turned on: which other extensions
 *      touched downloads, where each file was asked to go, and what the error
 *      said. A report that omits those is worse than no report, because it
 *      looks like an answer.
 *
 * The builder is pure and takes its clock as an argument, so all of that is
 * checkable here rather than by copying text out of a real browser and reading
 * it by eye.
 *
 *   node tools/test-diagnostics.js
 */
'use strict';

const D = require('../lib/diagnostics.js');

const B = String.fromCharCode(92); // backslash, so no escaping games below

let failures = 0;

function check(name, condition, detail) {
  if (condition) {
    console.log('  ok   ' + name);
  } else {
    failures += 1;
    console.log('  FAIL ' + name + (detail ? '  -> ' + detail : ''));
  }
}

const NOW = 1755740000000;

console.log('masking');

const winPath = 'C:' + B + 'Users' + B + 'QFM Zaty' + B + 'Downloads' + B + 'r.csv';
const winWant = 'C:' + B + 'Users' + B + '<you>' + B + 'Downloads' + B + 'r.csv';
check('masks a Windows home directory', D.maskPaths(winPath) === winWant, D.maskPaths(winPath));

check('masks a macOS home directory',
  D.maskPaths('/Users/anson/Downloads/r.csv') === '/Users/<you>/Downloads/r.csv',
  D.maskPaths('/Users/anson/Downloads/r.csv'));

check('masks a Linux home directory',
  D.maskPaths('/home/anson/Downloads/r.csv') === '/home/<you>/Downloads/r.csv',
  D.maskPaths('/home/anson/Downloads/r.csv'));

// The folder structure IS the diagnostic content. Masking that away would make
// the report useless for exactly the bug it was built for.
const deep = 'C:' + B + 'Users' + B + 'Someone' + B + 'Downloads' + B +
  'Shopee daily report' + B + '2026-08-18' + B + 'run-1' + B + 'a.csv';
check('keeps the folder structure below home',
  D.maskPaths(deep).indexOf('Shopee daily report' + B + '2026-08-18' + B + 'run-1') !== -1,
  D.maskPaths(deep));

const shared = 'D:' + B + 'shared' + B + 'reports' + B + 'a.csv';
check('leaves a path with no home directory alone', D.maskPaths(shared) === shared);

check('survives a non-string', D.maskPaths(null) === '' && D.maskPaths(undefined) === '');

console.log('report');

const report = D.buildReport({
  now: NOW,
  extension: { name: 'Test Downloader', version: '9.9.9', id: 'abcdef' },
  browser: 'Chrome/140.0.0.0',
  platform: 'Windows',
  folder: {
    chosen: true,
    name: 'C:' + B + 'Users' + B + 'QFM Zaty' + B + 'Reports',
    extensionFolderGranted: true
  },
  updateSource: { owner: 'anson81', repo: 'Test', branch: 'main' },
  updateInfo: { latest: '9.9.9', checkedAt: NOW - 3600000 },
  otherExtensions: [
    { id: 'jggnfimmbbnephljomfeopfamkfmmbck', count: 4, lastAt: NOW - 120000 }
  ],
  history: [
    {
      at: NOW - 600000,
      folder: 'C:' + B + 'Users' + B + 'QFM Zaty' + B + 'Downloads' + B + 'Shopee daily report',
      runFolder: '2026-08-18/run-1',
      error: '',
      reports: [
        { id: 'r1', name: 'Ads GMV MAX', status: 'ok', filename: 'gmv.csv' },
        {
          id: 'r2',
          name: 'Stock',
          status: 'failed',
          filename: '',
          error: 'timed out at C:' + B + 'Users' + B + 'QFM Zaty' + B + 'x'
        }
      ]
    }
  ]
});

check('names the extension and version',
  report.indexOf('Test Downloader') !== -1 && report.indexOf('9.9.9') !== -1);

check('reports the browser and system',
  report.indexOf('Chrome/140.0.0.0') !== -1 && report.indexOf('Windows') !== -1);

// The whole point of the exercise.
check('names the other extension that touched downloads',
  report.indexOf('jggnfimmbbnephljomfeopfamkfmmbck') !== -1);

check('counts that extension downloads', report.indexOf('4 download(s)') !== -1);

check('keeps a per-report failure and its message',
  report.indexOf('failed') !== -1 && report.indexOf('timed out') !== -1);

check('keeps the successful report filename', report.indexOf('gmv.csv') !== -1);

// The sibling extensions spell a report record differently. One builder has to
// read both, or the SiteGiant report silently comes out as a list of '?'.
const twinShaped = D.buildReport({
  now: NOW,
  extension: { name: 'Twin', version: '1.0.0' },
  history: [{
    at: NOW - 60000,
    folder: '/home/anson/SiteGiant',
    reports: [{
      id: 'orders',
      label: 'Orders with products',
      status: 'failed',
      message: 'SiteGiant never produced the export',
      counts: { created: 3, updated: 4, unchanged: 5 }
    }]
  }]
});
check('reads the label/message shape too',
  twinShaped.indexOf('Orders with products') !== -1 &&
  twinShaped.indexOf('SiteGiant never produced the export') !== -1,
  twinShaped);
// The message already carries the counts in SiteGiant's records, so printing
// both put the same three numbers on two consecutive lines.
check('does not print the counts twice when the message already says them',
  twinShaped.split('3 new').length - 1 <= 1,
  twinShaped);

const countsOnly = D.buildReport({
  now: NOW,
  extension: { name: 'Twin', version: '1.0.0' },
  history: [{
    at: NOW - 60000,
    reports: [{ id: 'x', label: 'Orders', status: 'done',
      counts: { created: 3, updated: 4, unchanged: 5 } }]
  }]
});
check('still reports the counts when nothing else says them',
  countsOnly.indexOf('3 new, 4 updated, 5 unchanged') !== -1,
  countsOnly);

// A missing timestamp is not evidence that nothing ever happened. The first
// live report said "(never)" about a check that had plainly just run, because
// this extension stamps it `at` rather than `checkedAt`.
const stamped = D.buildReport({
  now: NOW,
  extension: { name: 'X', version: '1.0.0' },
  updateInfo: { latest: '1.0.0', at: NOW - 3600000 }
});
check('reads the other spelling of the update timestamp',
  stamped.indexOf('1 h ago') !== -1 && stamped.indexOf('(never)') === -1,
  stamped);

const unstamped = D.buildReport({
  now: NOW,
  extension: { name: 'X', version: '1.0.0' },
  updateInfo: { latest: '1.0.0' }
});
check('an unstamped check says not recorded, never "never"',
  unstamped.indexOf('not recorded by this extension') !== -1 &&
  unstamped.indexOf('(never)') === -1,
  unstamped);

// Two of the three extensions have no reports-folder feature at all. Saying
// "no" sends someone looking for a setting that does not exist.
const noFolderFeature = D.buildReport({
  now: NOW,
  extension: { name: 'X', version: '1.0.0' },
  folder: { chosen: null }
});
check('a missing folder FEATURE is not reported as an unset folder',
  noFolderFeature.indexOf('not offered by this extension') !== -1,
  noFolderFeature);

// The section that exists because the report guessed once and was wrong.
const decided = D.buildReport({
  now: NOW,
  extension: { name: 'X', version: '1.0.0' },
  decisions: [
    { at: NOW - 1000, name: 'parentskudetail.xlsx',
      reason: 'abstained: no shopee host in url/finalUrl/referrer' },
    { at: NOW - 2000, name: 'download.csv', byExt: 'abc123',
      reason: 'abstained: started by another extension' }
  ]
});
check('the report says why the listener abstained',
  decided.indexOf('no shopee host') !== -1 &&
  decided.indexOf('what the filename listener decided') !== -1,
  decided);
check('and names the extension when one started the download',
  decided.indexOf('started by extension abc123') !== -1);
check('no decisions recorded means the section is left out entirely',
  D.buildReport({ now: NOW, extension: { name: 'X', version: '1.0.0' } })
    .indexOf('what the filename listener decided') === -1);
check('masks the home directory in that shape as well',
  twinShaped.indexOf('/home/<you>/SiteGiant') !== -1 &&
  twinShaped.indexOf('/home/anson') === -1);

// The one that would quietly ruin this: a name leaking through any field at all.
check('NO home directory name anywhere in the report',
  report.indexOf('QFM Zaty') === -1,
  report.split('\n').filter(function (l) { return l.indexOf('QFM Zaty') !== -1; }).join(' | '));

check('masked the folder rather than dropping it',
  report.indexOf('<you>') !== -1 && report.indexOf('Shopee daily report') !== -1);

console.log('degraded input');

// A worker woken with nothing in storage must still produce something a person
// can act on: "there is no history" is an answer to the question being asked.
const empty = D.buildReport({ now: NOW, extension: { name: 'X', version: '1.0.0' } });
check('an empty report still builds', typeof empty === 'string' && empty.length > 0);
check('says plainly that no runs were recorded', empty.indexOf('no runs recorded') !== -1);
check('says plainly that no other extensions were seen', empty.indexOf('none seen') !== -1);

check('builds from nothing at all without throwing', (function () {
  try { D.buildReport(); D.buildReport({}); return true; } catch (e) { return false; }
})());

// "None seen" is evidence; "not collected" is the absence of it. Reporting the
// second as the first would send whoever reads this looking somewhere else
// entirely - the Review Media Extractor registers no filename listener at all,
// by design, so it has nothing to say here and must say so in those words.
const notCollected = D.buildReport({
  now: NOW,
  extension: { name: 'X', version: '1.0.0' },
  otherExtensions: null,
  history: null
});
check('an explicit null says not collected, not none',
  notCollected.indexOf('not collected') !== -1 &&
  notCollected.indexOf('none seen') === -1,
  notCollected);
check('an explicit null history says not kept, not none recorded',
  notCollected.indexOf('not kept') !== -1 &&
  notCollected.indexOf('no runs recorded') === -1);
check('a MISSING key still means empty, not not-collected',
  empty.indexOf('none seen') !== -1 && empty.indexOf('not collected') === -1);

console.log('wiring');

// A button that does nothing fails silently and looks fine, which is the worst
// shape a bug can take on a page someone only opens when already in trouble.
// These four files have to agree, and each of them is easy to edit alone.
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const html = read('options/options.html');
const optsJs = read('options/options.js');
const optsCss = read('options/options.css');
const bg = read('background/background.js');

// Checked by behaviour rather than by spelling: these three extensions grew up
// separately and reach for elements differently - `el.x` in one, `$('x')` in
// another. A guard that insisted on one house style would fail on a repo that
// is perfectly wired, and teach everyone to ignore it.
check('the page has the button', html.indexOf('id="copy-diagnostics"') !== -1);
check('the page has somewhere to show the report', html.indexOf('id="diagnostics"') !== -1);
check('options.js reaches for the button', optsJs.indexOf("'copy-diagnostics'") !== -1);
check('the button is actually wired to a click',
  optsJs.indexOf("addEventListener('click', copyDiagnostics)") !== -1);
check('the click asks the worker for the report',
  optsJs.indexOf("'getDiagnostics'") !== -1);
check('the worker answers that message', bg.indexOf("case 'getDiagnostics'") !== -1);
check('the worker loads the builder', bg.indexOf('lib/diagnostics.js') !== -1);
check('the report is shown, not only copied',
  optsJs.indexOf('textContent = res.report') !== -1);
check('there is a fallback when the clipboard refuses',
  optsJs.indexOf('clipboard') !== -1 && optsJs.indexOf('select the text below') !== -1);
check('the preview is styled', optsCss.indexOf('.diagnostics') !== -1);

// The sightings are the reason this exists - but only two of these three
// extensions have a filename listener at all. The third must NOT have one, and
// asserting that it records sightings would be asserting that it broke its own
// rule. So the rule adapts to the file: whichever way this repo is built, the
// report has to tell the truth about it.
const hasListener = bg.indexOf('onDeterminingFilename.addListener') !== -1;

if (hasListener) {
  check('the filename listener records other extensions',
    bg.indexOf('noteOtherDownloader') !== -1);
  check('the report is given the sightings, not null',
    bg.indexOf('otherExtensions: Array.from(otherDownloaders') !== -1);
} else {
  check('no listener, so the report says not collected rather than none',
    bg.indexOf('otherExtensions: null') !== -1,
    'this extension registers no filename listener, so it cannot honestly report "none seen"');
}

console.log('');
if (failures) {
  console.log(failures + ' failure(s)');
  process.exit(1);
}
console.log('the report keeps the facts, drops the name, and the button is wired');
