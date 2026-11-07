/**
 * The release script itself, run against a throwaway copy of this extension.
 *
 * WHY THIS TEST EXISTS.
 *
 * Releases used to need tools/make-release.ps1, i.e. PowerShell, so the Linux
 * P50 could fix an extension but not ship the fix. tools/make-release.js runs
 * anywhere Node does. CI runs this on Windows, Linux and macOS, so "the release
 * script works on every machine" is checked, not assumed.
 *
 * It never touches the real manifest.json or update.json: everything happens
 * in a temporary copy that is deleted afterwards.
 *
 *   node tools/test-make-release.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { release, listShippedFiles, readConfig } = require('./make-release.js');

const ROOT = path.resolve(__dirname, '..');
let failures = 0;

function check(name, condition, detail) {
  if (condition) console.log('  ok   ' + name);
  else { failures += 1; console.log('  FAIL ' + name + (detail ? '  -> ' + detail : '')); }
}

function refuses(fn) {
  try { fn(); return false; } catch (e) { return !!e.releaseError; }
}

function copyRepo() {
  const dst = fs.mkdtempSync(path.join(os.tmpdir(), 'make-release-test-'));
  (function copy(src, to) {
    for (const e of fs.readdirSync(src, { withFileTypes: true })) {
      if (e.name === '.git' || e.name === 'node_modules') continue;
      const s = path.join(src, e.name);
      const d = path.join(to, e.name);
      if (e.isDirectory()) { fs.mkdirSync(d); copy(s, d); } else if (e.isFile()) fs.copyFileSync(s, d);
    }
  })(ROOT, dst);
  return dst;
}

function quiet(fn) {
  const log = console.log;
  console.log = () => {};
  try { return fn(); } finally { console.log = log; }
}

const tmp = copyRepo();
try {
  const read = (f) => fs.readFileSync(path.join(tmp, f), 'utf8');
  const manifestBefore = read('manifest.json');
  const updateBefore = read('update.json');
  const current = JSON.parse(manifestBefore).version;
  const [a, b, c] = current.split('.').map(Number);
  const next = a + '.' + b + '.' + (c + 1);

  console.log('refusals');
  check('refuses a version that is not three numbers',
    refuses(() => quiet(() => release({ version: '1.2', notes: ['x'], skipTests: true }, tmp))));
  check('refuses a release with no notes',
    refuses(() => quiet(() => release({ version: next, notes: [], skipTests: true }, tmp))));
  check('refuses the version already in manifest.json',
    refuses(() => quiet(() => release({ version: current, notes: ['x'], skipTests: true }, tmp))));
  check('refuses a lower version',
    refuses(() => quiet(() => release({ version: '0.0.1', notes: ['x'], skipTests: true }, tmp))));
  check('refusals wrote nothing',
    read('manifest.json') === manifestBefore && read('update.json') === updateBefore);

  console.log('dry run');
  quiet(() => release({ version: next, notes: ['Test note'], dryRun: true, skipTests: true }, tmp));
  check('dry run wrote nothing',
    read('manifest.json') === manifestBefore && read('update.json') === updateBefore);

  console.log('missing file');
  const sw = (JSON.parse(manifestBefore).background || {}).service_worker;
  if (sw && fs.existsSync(path.join(tmp, sw))) {
    const hidden = path.join(tmp, sw + '.hidden');
    fs.renameSync(path.join(tmp, sw), hidden);
    check('refuses when a file manifest.json needs is missing',
      refuses(() => quiet(() => release({ version: next, notes: ['x'], skipTests: true }, tmp))));
    fs.renameSync(hidden, path.join(tmp, sw));
  }

  console.log('a real release, in the copy');
  quiet(() => release({ version: next, notes: ['First note', 'Second note'], skipTests: true }, tmp));
  const m = JSON.parse(read('manifest.json'));
  const u = JSON.parse(read('update.json'));
  check('manifest.json now says ' + next, m.version === next, m.version);
  check('only the version line changed in manifest.json',
    read('manifest.json') === manifestBefore.replace(/("version"\s*:\s*)"[^"]*"/, '$1"' + next + '"'));
  check('update.json version matches', u.version === next, u.version);
  const prevNotes = JSON.parse(updateBefore).notes || [];
  const keep = readConfig(tmp).notes === 'prepend';
  check('update.json notes are an array, new ones first',
    Array.isArray(u.notes) && u.notes[0] === 'First note' && u.notes[1] === 'Second note');
  check(keep ? 'the earlier notes are kept below them (release-config.json says prepend)'
             : 'only this release\'s notes are listed (no release-config.json, or replace)',
    keep ? JSON.stringify(u.notes.slice(2)) === JSON.stringify(prevNotes) : u.notes.length === 2,
    u.notes.length + ' notes');
  check('update.json files are exactly what is on disk',
    JSON.stringify(u.files) === JSON.stringify(listShippedFiles(tmp)));
  check('developer notes are not shipped',
    !u.files.some((f) => /^(CLAUDE\.md|CLAUDE\.local\.md|MIGRATION_HANDOFF\.md)$/.test(f) || /^(tools|docs)\//.test(f)));
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('');
if (failures) { console.log(failures + ' failure(s)'); process.exit(1); }
console.log('make-release.js works on this machine, and the real files were not touched');
