/**
 * The three files that open IndexedDB must agree on the version.
 *
 * WHY THIS TEST EXISTS.
 *
 * The worker and the offscreen writer moved to version 2 to add the payloads
 * store. options.js was left opening version 1. IndexedDB refuses to open an
 * existing database at a LOWER version — it throws VersionError — so as soon
 * as one export had run, the Options page could no longer read or write the
 * output folder handle at all.
 *
 * Nothing failed loudly. The folder picker still appeared to work and saved
 * nothing, so every export fell through to the downloads fallback with no
 * folder to write to, and the user was left with no file and no explanation.
 *
 * No unit test could have caught it, because each file is correct on its own.
 * The invariant lives BETWEEN the files, so it is checked between them.
 *
 *   node tools/test-db-version.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const FILES = [
  'options/options.js',
  'background/background.js',
  'offscreen/offscreen.js'
];

let failures = 0;

function check(name, condition, detail) {
  if (condition) {
    console.log('  ok   ' + name);
  } else {
    failures += 1;
    console.log('  FAIL ' + name + (detail ? '  -> ' + detail : ''));
  }
}

console.log('indexeddb');

const found = FILES.map((rel) => {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');

  // The version as passed to open(), whether spelled as a literal or via the
  // constant. A literal is what caused the bug, so it must not be missed.
  const call = src.match(/indexedDB\.open\(\s*[A-Za-z_$][\w$]*\s*,\s*([^)]+)\)/);
  let version = call ? call[1].trim() : null;

  if (version && /^[A-Za-z_$]/.test(version)) {
    const decl = src.match(
      new RegExp('const\\s+' + version.replace(/[$]/g, '\\$') + '\\s*=\\s*(\\d+)')
    );
    version = decl ? decl[1] : version + ' (unresolved)';
  }

  const name = src.match(/const\s+DB_NAME\s*=\s*'([^']+)'/);
  return { rel, version, dbName: name ? name[1] : null };
});

for (const f of found) {
  check(f.rel + ' opens a resolvable version', /^\d+$/.test(String(f.version)),
    String(f.version));
}

const versions = [...new Set(found.map((f) => String(f.version)))];
check('all three open the SAME version', versions.length === 1,
  found.map((f) => f.rel.split('/')[0] + '=' + f.version).join(', '));

const names = [...new Set(found.map((f) => f.dbName))];
check('all three open the same database name', names.length === 1 && names[0],
  names.join(', '));

// Every store any of them uses must be created in every upgrade handler, or
// whichever file runs the upgrade first leaves the others without their store.
const stores = ['handles', 'payloads'];
for (const store of stores) {
  const missing = FILES.filter((rel) => {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    if (!src.includes('onupgradeneeded')) return true;
    return !src.includes("'" + store + "'") && !src.includes('"' + store + '"');
  });
  check("every opener creates the '" + store + "' store", missing.length === 0,
    missing.join(', '));
}

console.log('');
if (failures) {
  console.log(failures + ' failure(s)');
  process.exit(1);
}
console.log('the database contract holds across all three files');
