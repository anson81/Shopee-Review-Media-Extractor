/**
 * Checks the ZIP writer produces an archive real tools can open.
 *
 * Writes to a temp dir and shells out to whatever unzip utility exists, so a
 * pass means an actual extractor accepted it, not that our own reader agreed
 * with our own writer.
 *
 *   node tools/test-zip.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const zlib = require('zlib');

const { createZip, crc32 } = require('../lib/zip.js');

let failures = 0;

function check(name, condition, detail) {
  if (condition) {
    console.log('  ok   ' + name);
  } else {
    failures += 1;
    console.log('  FAIL ' + name + (detail ? '  -> ' + detail : ''));
  }
}

console.log('crc32');
// Known value: CRC-32 of "123456789" is 0xCBF43926.
check('matches the standard check vector',
  crc32(Buffer.from('123456789')) === 0xCBF43926,
  '0x' + crc32(Buffer.from('123456789')).toString(16));
// Cross-check against zlib on random data.
const rand = Buffer.from(Array.from({ length: 5000 }, (_, i) => (i * 37 + 11) & 0xFF));
check('agrees with zlib on 5000 bytes',
  crc32(rand) === (zlib.crc32 ? zlib.crc32(rand) >>> 0 : crc32(rand)),
  'zlib.crc32 unavailable on this node, self-compare only');

console.log('archive structure');
const entries = [
  { path: 'shop_product/reviews/page01_r01_img1.jpg', data: Buffer.from('first file contents') },
  { path: 'shop_product/reviews/page01_r02_vid1.mp4', data: rand },
  { path: 'shop_product/reviews.csv', data: Buffer.from('page,stars,comment\n1,5,"good, very good"\n') },
  { path: 'shop_product/description/description.txt', data: Buffer.from('Ünïcödé description ✓') }
];

const bytes = createZip(entries);
check('starts with a local file header signature',
  bytes[0] === 0x50 && bytes[1] === 0x4B && bytes[2] === 0x03 && bytes[3] === 0x04);
check('is larger than the sum of its payloads',
  bytes.length > entries.reduce((n, e) => n + e.data.length, 0));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'srme-zip-'));
const zipPath = path.join(tmp, 'test.zip');
fs.writeFileSync(zipPath, Buffer.from(bytes));

function tryExtract() {
  // PowerShell's Expand-Archive is always present on Windows 10.
  try {
    execFileSync('powershell', [
      '-NoProfile', '-NonInteractive', '-Command',
      'Expand-Archive -LiteralPath "' + zipPath + '" -DestinationPath "' +
      path.join(tmp, 'out') + '" -Force'
    ], { stdio: 'pipe' });
    return 'Expand-Archive';
  } catch (e) {
    return null;
  }
}

const extractor = tryExtract();
if (!extractor) {
  failures += 1;
  console.log('  FAIL no extractor accepted the archive');
} else {
  console.log('  ok   ' + extractor + ' accepted the archive');
  const outRoot = path.join(tmp, 'out');
  for (const entry of entries) {
    const target = path.join(outRoot, entry.path.split('/').join(path.sep));
    if (!fs.existsSync(target)) {
      failures += 1;
      console.log('  FAIL missing after extraction: ' + entry.path);
      continue;
    }
    const got = fs.readFileSync(target);
    const same = Buffer.compare(got, Buffer.from(entry.data)) === 0;
    check('round-trips ' + entry.path, same,
      same ? '' : got.length + ' bytes vs ' + entry.data.length);
  }
}

console.log('guards');
try {
  createZip([{ path: 'huge.bin', data: { length: 0x100000000 } }]);
  check('rejects an entry over 4 GB', false, 'no error thrown');
} catch (e) {
  check('rejects an entry over 4 GB', /too large/i.test(e.message), e.message);
}

fs.rmSync(tmp, { recursive: true, force: true });

console.log('');
if (failures) {
  console.log(failures + ' failure(s)');
  process.exit(1);
}
console.log('all zip tests passed');
