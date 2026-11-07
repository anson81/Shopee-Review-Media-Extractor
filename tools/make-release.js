#!/usr/bin/env node
/**
 * Bumps the version and regenerates update.json from what is actually on disk,
 * so the file list can never drift out of sync with the extension.
 *
 * Usage (from the extension folder, on any OS):
 *     node tools/make-release.js 1.2.0 "Fixed X" "Added Y"
 *     node tools/make-release.js 1.2.0 "Fixed X" --dry-run   # show, write nothing
 *
 * Then commit and push. The extension checks update.json on the default
 * branch and offers the new version. An unpushed release is invisible to it.
 *
 * This replaces tools/make-release.ps1, which needed PowerShell and so could
 * not run on the Linux P50. The .ps1 is now a thin wrapper around this file,
 * so there is one implementation and nothing to keep in step.
 *
 * Nothing is written until every check has passed, and the result is verified
 * with tools/test-release-consistency.js before the script reports success.
 * If that final check fails, manifest.json and update.json are put back.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const TOOLS = __dirname;
const ROOT = path.resolve(TOOLS, '..');

// Not part of the installed extension. The updater fetches every file listed
// in update.json, so shipping these would make each update download notes and
// tooling for nothing. Kept in step with SKIP_DIRS/SKIP_FILES in
// tools/test-release-consistency.js and the exclude list in
// .github/workflows/tests.yml. Those three disagreeing is how a genuinely
// shipped file ends up exempt from every check there is.
const SKIP_DIRS = new Set(['tools', 'docs', '.git', '.github', 'node_modules']);
// Developer notes, not runtime code. CLAUDE.local.md and MIGRATION_HANDOFF.md
// are git-ignored notes from the move to the P50, but they are on disk.
const SKIP_FILES = new Set(['CLAUDE.md', 'CLAUDE.local.md', 'MIGRATION_HANDOFF.md']);

function fail(msg) {
  const e = new Error(msg);
  e.releaseError = true;
  throw e;
}

function parseArgs(argv) {
  const dryRun = argv.includes('--dry-run');
  const skipTests = argv.includes('--skip-tests'); // for tools/test-make-release.js only
  const rest = argv.filter((a) => a !== '--dry-run' && a !== '--skip-tests');
  const [version, ...notes] = rest;
  return { version, notes, dryRun, skipTests };
}

function cmpVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

// Same rule as the walk in tools/test-release-consistency.js: anything whose
// name starts with a dot, at any depth, is repo scaffolding (.gitignore,
// .gitattributes, .github).
function listShippedFiles(root) {
  const out = [];
  (function walk(dir, rel) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const here = rel ? rel + '/' + entry.name : entry.name;
      if (entry.isDirectory()) {
        if (!rel && SKIP_DIRS.has(entry.name)) continue;
        walk(path.join(dir, entry.name), here);
      } else if (entry.isFile()) {
        if (!rel && SKIP_FILES.has(entry.name)) continue;
        out.push(here);
      }
    }
  })(root, '');
  return out.sort(byPath);
}

// Plain character order, the same on every OS and locale. (PowerShell's
// Sort-Object followed the machine's culture, so the order used to depend on
// which PC made the release.)
function byPath(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// Every file the manifest points at must be shipped, or the updater installs
// a version that cannot load.
function manifestReferences(m) {
  const refs = new Set(['manifest.json']);
  const add = (v) => { if (typeof v === 'string' && v) refs.add(v.replace(/^\.?\//, '')); };
  if (m.background) add(m.background.service_worker);
  for (const cs of m.content_scripts || []) {
    (cs.js || []).forEach(add);
    (cs.css || []).forEach(add);
  }
  if (m.action) {
    add(m.action.default_popup);
    const di = m.action.default_icon;
    if (typeof di === 'string') add(di); else if (di) Object.values(di).forEach(add);
  }
  add(m.options_page);
  if (m.options_ui) add(m.options_ui.page);
  if (m.icons) Object.values(m.icons).forEach(add);
  return [...refs];
}

function runTests() {
  const tests = fs.readdirSync(TOOLS).filter((f) => /^test-.*\.js$/.test(f)).sort();
  if (!tests.length) fail('No tests found in tools/ - releasing blind is not a release.');
  console.log('Running tests...');
  for (const t of tests) {
    const r = spawnSync(process.execPath, [path.join(TOOLS, t)], { cwd: ROOT, encoding: 'utf8' });
    if (r.status !== 0) {
      process.stdout.write((r.stdout || '') + (r.stderr || ''));
      fail(t + ' failed - fix it before releasing.');
    }
    console.log('  ok  ' + t);
  }
}

function release({ version, notes, dryRun, skipTests }, root = ROOT) {
  if (!/^\d+\.\d+\.\d+$/.test(version || '')) {
    fail("Version must look like 1.2.0 (got '" + (version || '') + "').\n" +
      'Usage: node tools/make-release.js 1.2.0 "Fixed X" "Added Y"');
  }
  if (!notes.length || notes.some((n) => !n.trim())) {
    fail('Give at least one release note, e.g. "Fixed the download name". Notes are what the update button shows.');
  }

  if (!skipTests) runTests();

  // --- manifest.json, edited as text -----------------------------------------
  // Not round-tripped through JSON.stringify: that reformats the whole file.
  const manifestPath = path.join(root, 'manifest.json');
  const raw = fs.readFileSync(manifestPath, 'utf8');
  const before = JSON.parse(raw);
  const old = before.version;
  const pattern = /^(\s*"version"\s*:\s*)"[^"]*"/m;
  if (!pattern.test(raw)) fail('Could not find a "version" line in manifest.json.');

  // Refusing an unchanged version is not pedantry. checkUpdate() compares
  // version numbers and nothing else, so changes shipped under a version
  // already in the wild are never offered to any machine - silently. A LOWER
  // number is the same failure, so that is refused too.
  if (old === version) fail('manifest.json is already at ' + version + '. Never ship changes on an unchanged version number.');
  if (/^\d+\.\d+\.\d+$/.test(old || '') && cmpVersions(version, old) < 0) {
    fail('manifest.json is at ' + old + '; ' + version + ' is lower, so no installed copy would ever be offered it.');
  }

  const newRaw = raw.replace(pattern, '$1"' + version + '"');
  const after = JSON.parse(newRaw);
  if (after.version !== version) fail('manifest.json version did not take.');
  // Prove nothing but the version changed (the old script checked a few
  // counts by hand; this checks everything).
  const strip = (m) => JSON.stringify(Object.assign({}, m, { version: null }));
  if (strip(before) !== strip(after)) fail('Editing the version changed something else in manifest.json - restore it from git.');

  // --- the files that make up the extension ---------------------------------
  const files = listShippedFiles(root);
  // update.json lists itself, so the next check sees the new version. On a
  // first release it is not on disk yet.
  if (!files.includes('update.json')) { files.push('update.json'); files.sort(byPath); }
  const missing = manifestReferences(after).filter((f) => !files.includes(f));
  if (missing.length) fail('manifest.json references files that are not on disk: ' + missing.join(', '));

  const updatePath = path.join(root, 'update.json');
  const updateText = JSON.stringify({ version, notes, files }, null, 2) + '\n';

  console.log('manifest.json: ' + old + ' -> ' + version);
  console.log('update.json lists ' + files.length + ' files:');
  files.forEach((f) => console.log('  ' + f));

  if (dryRun) {
    console.log('\nDry run: nothing was written.');
    return { old, version, files };
  }

  // --- write both, then verify with the same check CI runs --------------------
  const oldUpdate = fs.existsSync(updatePath) ? fs.readFileSync(updatePath) : null;
  fs.writeFileSync(manifestPath, newRaw);
  fs.writeFileSync(updatePath, updateText);
  const check = path.join(root, 'tools', 'test-release-consistency.js');
  if (fs.existsSync(check)) {
    const r = spawnSync(process.execPath, [check], { cwd: root, encoding: 'utf8' });
    if (r.status !== 0) {
      fs.writeFileSync(manifestPath, raw);
      if (oldUpdate) fs.writeFileSync(updatePath, oldUpdate); else fs.unlinkSync(updatePath);
      process.stdout.write(r.stdout || '');
      fail('The release did not pass tools/test-release-consistency.js, so manifest.json and update.json were put back.');
    }
  }

  console.log('\nNow commit and push:');
  console.log('  git add -A && git commit -m "v' + version + '" && git push');
  return { old, version, files };
}

module.exports = { release, listShippedFiles, manifestReferences, cmpVersions, SKIP_DIRS, SKIP_FILES };

if (require.main === module) {
  try {
    release(parseArgs(process.argv.slice(2)));
  } catch (e) {
    console.error('\nRelease stopped: ' + (e.releaseError ? e.message : e.stack));
    process.exit(1);
  }
}
