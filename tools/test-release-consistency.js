/**
 * The two ways a good fix never reaches the machines that need it.
 *
 * WHY THIS TEST EXISTS.
 *
 * Neither extension installs itself from the Chrome Web Store. Each one polls
 * update.json on the GitHub branch, compares its `version` against the running
 * manifest, and — if it is higher — downloads every path in its `files` list
 * and writes them into its own folder. Both halves of that have failed
 * silently, and silence is the whole problem: the extension keeps working, on
 * the old code, reporting success.
 *
 *   1. update.json and manifest.json disagree on the version.
 *      checkUpdate() only ever reads update.json, so if the code is bumped and
 *      update.json is not, no machine is ever offered the update. Nothing is
 *      broken, nothing is logged, the fix simply never arrives. The August
 *      2026 filename bug was fixed twice while PCs still ran the broken build.
 *
 *   2. A shipped file is missing from `files`.
 *      The installer downloads exactly that list. A file left out is never
 *      delivered, so the folder ends up holding new code beside old — which
 *      loads happily and misbehaves in ways the version number flatly
 *      contradicts. options.js already guards the interrupted-download case
 *      with the same reasoning; this guards the forgot-to-list case, which no
 *      amount of care at install time can see.
 *
 * Both are invariants BETWEEN files, so no unit test of any one file can catch
 * them. They are checked here, and in CI on every push.
 *
 *   node tools/test-release-consistency.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// Not shipped: the repo's own scaffolding and anything written for a human
// rather than for Chrome. If a directory here ever starts holding runtime
// code, this list is the thing to change.
const SKIP_DIRS = new Set(['.git', '.github', 'node_modules', 'tools', 'docs']);

// Written for whoever works on this repo, not for Chrome. It must not go into
// `files` — the installer would write it onto every machine for no reason.
const SKIP_FILES = new Set(['CLAUDE.md']);

// What the installer can meaningfully write. README.md is included because it
// is already listed in every update.json — the rule is "what ships is listed",
// not "what Chrome parses is listed".
const SHIPPED = /\.(js|html|css|json|png|md)$/i;

let failures = 0;

function check(name, condition, detail) {
  if (condition) {
    console.log('  ok   ' + name);
  } else {
    failures += 1;
    console.log('  FAIL ' + name + (detail ? '  -> ' + detail : ''));
  }
}

function walk(dir, rel) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const here = rel ? rel + '/' + entry.name : entry.name;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      out.push(...walk(path.join(dir, entry.name), here));
    } else if (SHIPPED.test(entry.name)) {
      out.push(here);
    }
  }
  return out;
}

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const update = JSON.parse(fs.readFileSync(path.join(ROOT, 'update.json'), 'utf8'));

console.log('version');

check('manifest.json version is three numbers',
  /^\d+\.\d+\.\d+$/.test(manifest.version || ''),
  manifest.version);

// THE ONE THAT MATTERS. checkUpdate() compares update.json's version against
// the running manifest's, so these disagreeing means either nobody is offered
// the update, or everybody is offered one that installs the same version they
// already have.
check('update.json version matches manifest.json',
  update.version === manifest.version,
  'update.json ' + update.version + ' vs manifest ' + manifest.version);

check('update.json carries release notes',
  Array.isArray(update.notes) && update.notes.length > 0);

console.log('files');

const listed = (update.files || []).map((f) => f.split(path.sep).join('/'));
const listedSet = new Set(listed);
const onDisk = walk(ROOT, '');

check('update.json lists files at all', listed.length > 0, listed.length + ' listed');

check('no file is listed twice',
  listedSet.size === listed.length,
  listed.filter((f, i) => listed.indexOf(f) !== i).join(', '));

// A listed file that does not exist aborts the whole install on a 404, so the
// machine stays on the old version — loudly, at least, but still stuck.
const ghosts = listed.filter((f) => !fs.existsSync(path.join(ROOT, f)));
check('every listed file exists on disk', ghosts.length === 0, ghosts.join(', '));

// The silent one: shipped, but never delivered.
const unlisted = onDisk.filter((f) => !listedSet.has(f) && !SKIP_FILES.has(f));
check('every shipped file is listed in update.json',
  unlisted.length === 0,
  unlisted.join(', '));

// manifest.json is written last by the installer precisely so an interrupted
// write cannot claim a version the other files do not back up. That only works
// if it is in the list to begin with.
check('manifest.json is listed, so an update can replace it',
  listedSet.has('manifest.json'));

check('update.json is listed, so the next check sees the new version',
  listedSet.has('update.json'));

console.log('');
if (failures) {
  console.log(failures + ' failure(s)');
  process.exit(1);
}
console.log('manifest and update.json agree, and every shipped file is listed');
