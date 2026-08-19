/**
 * Writes an export straight into the folder the seller chose.
 *
 * WHY THIS FILE EXISTS AT ALL.
 *
 * `chrome.downloads.download({filename})` only REQUESTS a name. Any other
 * installed extension holding the "downloads" permission can override it from
 * onDeterminingFilename, and Chrome settles the tie by install recency:
 *
 *   "the last extension installed whose listener passes a suggestion object to
 *    suggest wins"
 *
 * The two sibling extensions spent August 2026 losing that contest to each
 * other — every release made one of them the newest, and the newest silenced
 * the other. A file written through a FileSystemDirectoryHandle never touches
 * Chrome's download naming, so there is no contest to lose.
 *
 * The File System Access API needs a document, and an MV3 service worker is
 * not one — hence an offscreen document.
 *
 * HOW THE BYTES GET HERE.
 *
 * Not by message. The archive used to be base64'd and passed through
 * chrome.runtime.sendMessage, which JSON-serialises it: a 50 MB export became
 * a ~67 MB string, held simultaneously as raw bytes, a binary string, the
 * base64, the serialised copy and the decoded copy. Message passing has a size
 * ceiling and btoa() throws RangeError outright past roughly 400 MB, and both
 * failures landed in a bare catch that fell back to Chrome's downloads — the
 * exact naming contest this file exists to avoid, silently, on precisely the
 * large exports this extension is built for.
 *
 * The worker now stores the bytes in IndexedDB, which is shared same-origin
 * and holds a Uint8Array natively, and sends only a key. Nothing is copied and
 * nothing is encoded.
 */

const DB_NAME = 'shopee-review-media-extractor';
const DB_VERSION = 2;
const STORE = 'handles';
const PAYLOADS = 'payloads';
/** Where exports go. Deliberately NOT the key the self-updater uses. */
const OUTPUT_KEY = 'outputFolder';

function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      if (!db.objectStoreNames.contains(PAYLOADS)) db.createObjectStore(PAYLOADS);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbGet(store, key) {
  return idb().then((db) => new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readonly').objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

function idbDelete(store, key) {
  return idb().then((db) => new Promise((resolve) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  }));
}

/**
 * Walks (and creates) a folder path under the chosen root.
 *
 * Empty segments are dropped rather than passed through: getDirectoryHandle('')
 * throws, and a stray double slash in a built path is an easy mistake to make.
 */
async function folderFor(root, segments) {
  let dir = root;
  for (const part of segments.filter(Boolean)) {
    dir = await dir.getDirectoryHandle(part, { create: true });
  }
  return dir;
}

/**
 * Save one archive.
 *
 * Returns { ok: true, path } when it reached the chosen folder, or
 * { ok: false, reason, blobUrl } when it could not — with a blob URL the
 * worker can hand to chrome.downloads instead. The URL is made here because
 * URL.createObjectURL does not exist in a service worker.
 *
 * 'no-folder' and 'permission' are worth telling apart, because both are
 * fixed in Options and neither is a bug.
 */
async function write({ key, segments, filename }) {
  const bytes = await idbGet(PAYLOADS, key);
  if (!bytes) return { ok: false, reason: 'no-payload' };

  try {
    const root = await idbGet(STORE, OUTPUT_KEY);

    if (root) {
      // requestPermission() needs a user gesture and there is none here, so
      // this can only ever check. Options re-grants it.
      const granted = await root.queryPermission({ mode: 'readwrite' });
      if (granted === 'granted') {
        const dir = await folderFor(root, segments);
        const handle = await dir.getFileHandle(filename, { create: true });
        const writable = await handle.createWritable();
        try {
          await writable.write(bytes);
        } finally {
          // Closing is what commits the file. Skipping it on a failed write
          // would leave a zero-byte file that looks like a success.
          await writable.close();
        }
        await idbDelete(PAYLOADS, key);
        return { ok: true, path: segments.filter(Boolean).concat(filename).join('/') };
      }

      return { ok: false, reason: 'permission', blobUrl: blobUrlFor(bytes) };
    }

    return { ok: false, reason: 'no-folder', blobUrl: blobUrlFor(bytes) };
  } catch (err) {
    // Still offer the download route: a run that produced the bytes should
    // not lose them to a folder problem.
    return {
      ok: false,
      reason: 'error',
      error: (err && err.message) || String(err),
      blobUrl: blobUrlFor(bytes)
    };
  }
}

function blobUrlFor(bytes) {
  try {
    return URL.createObjectURL(new Blob([bytes], { type: 'application/zip' }));
  } catch (_) {
    return null;
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen-writer') return undefined;

  if (msg.action === 'revoke') {
    try { URL.revokeObjectURL(msg.url); } catch (_) { /* already gone */ }
    if (msg.key) idbDelete(PAYLOADS, msg.key);
    sendResponse({ ok: true });
    return undefined;
  }

  write(msg)
    .then(sendResponse)
    .catch((err) => sendResponse({
      ok: false, reason: 'error', error: err?.message || String(err)
    }));
  return true;
});
