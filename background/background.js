/**
 * Service worker: settings, message routing, the media fetch queue, the ZIP,
 * and saving it.
 *
 * NOTE THE ABSENCE. This file registers no chrome.downloads.onDeterminingFilename
 * listener, and must never gain one — see tools/test-no-filename-listener.js
 * for what happens to the sibling extensions if it does.
 */
importScripts('../lib/zip.js', '../lib/csv.js', '../lib/naming.js');

const Zip = self.SRME_Zip;
const Csv = self.SRME_Csv;
const Naming = self.SRME_Naming;

const DEFAULTS = {
  filenameStyle: Naming.STYLES.PAGE_REVIEW_TYPE,
  pageDelayMs: 300,
  concurrency: 4,
  updateSource: {
    owner: 'anson81',
    repo: 'Shopee-Review-Media-Extractor',
    branch: 'main'
  }
};

const UPDATE_MANIFEST = 'update.json';

async function getSettings() {
  const stored = await chrome.storage.local.get('settings');
  const s = stored.settings || {};
  return {
    ...DEFAULTS,
    ...s,
    updateSource: { ...DEFAULTS.updateSource, ...(s.updateSource || {}) }
  };
}

async function saveSettings(values) {
  const current = await getSettings();
  const next = {
    ...current,
    ...values,
    updateSource: { ...current.updateSource, ...(values.updateSource || {}) }
  };
  await chrome.storage.local.set({ settings: next });
  return next;
}

/* ------------------------------------------------------------------ *
 * Run state that has to survive the worker
 *
 * MV3 stops an idle worker after about 30 seconds, and a 50-page run spends
 * most of its time waiting. Anything the popup needs to redraw after that has
 * to be somewhere other than a module variable.
 * ------------------------------------------------------------------ */
const state = {
  running: false,
  phase: 'idle',
  message: '',
  page: 0,
  found: 0,
  done: 0,
  total: 0,
  lastResult: null,
  error: null
};

/** Why the last folder write was skipped, surfaced in the popup. */
let lastFolderIssue = null;

function persist() {
  return chrome.storage.session.set({ runState: state, lastFolderIssue }).catch(() => {});
}

async function hydrate() {
  try {
    const got = await chrome.storage.session.get(['runState', 'lastFolderIssue']);
    if (got.runState) Object.assign(state, got.runState);
    if (got.lastFolderIssue !== undefined) lastFolderIssue = got.lastFolderIssue;
  } catch (_) {
    /* nothing worth restoring */
  }
}

const hydrated = hydrate();

function setPhase(phase, message) {
  state.phase = phase;
  if (message !== undefined) state.message = message;
  persist();
}

/**
 * Any extension API call resets Chrome's idle timer. A long run would
 * otherwise be stopped halfway through fetching media.
 */
let keepAliveTimer = null;

function startKeepAlive() {
  if (keepAliveTimer) return;
  keepAliveTimer = setInterval(() => {
    chrome.runtime.getPlatformInfo().catch(() => {});
  }, 20000);
}

function stopKeepAlive() {
  if (keepAliveTimer) clearInterval(keepAliveTimer);
  keepAliveTimer = null;
}

/* ------------------------------------------------------------------ *
 * Fetching media
 * ------------------------------------------------------------------ */

/**
 * Runs tasks with a fixed number in flight.
 *
 * Not Promise.all over everything: several hundred images at once is a burst
 * that gets an account rate limited, and it holds every response in memory at
 * the same moment.
 */
async function pooled(items, limit, worker, onProgress) {
  const results = new Array(items.length);
  let next = 0;
  let completed = 0;

  async function run() {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
      completed += 1;
      if (onProgress) onProgress(completed, items.length);
    }
  }

  const size = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: size }, run));
  return results;
}

/**
 * One media file.
 *
 * A failure is recorded, not thrown: one dead CDN link should cost the user
 * that file, not the other three hundred.
 */
async function fetchMedia(item) {
  try {
    const res = await fetch(item.url);
    if (!res.ok) return { item, error: 'HTTP ' + res.status };
    const buf = await res.arrayBuffer();
    return { item, bytes: new Uint8Array(buf) };
  } catch (err) {
    return { item, error: err?.message || String(err) };
  }
}

/* ------------------------------------------------------------------ *
 * Saving
 * ------------------------------------------------------------------ */

async function ensureOffscreen() {
  const existing = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT']
  });
  if (existing.length) return;

  await chrome.offscreen.createDocument({
    url: 'offscreen/offscreen.html',
    reasons: ['BLOBS'],
    justification:
      'Writes the export into the folder the user chose, using the File System ' +
      'Access API, which a service worker cannot reach.'
  });
}

/** Bytes to base64, in chunks — apply() on a huge array overflows the stack. */
function toBase64(bytes) {
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

async function saveToChosenFolder(base64, filename) {
  try {
    await ensureOffscreen();
    const reply = await chrome.runtime.sendMessage({
      target: 'offscreen-writer',
      segments: ['Shopee Review Media'],
      filename,
      base64
    });

    if (reply?.ok) return reply;

    // Not an error worth stopping for: no folder chosen yet, or the permission
    // lapsed. Both are settled in Options, and the download fallback still
    // produces the file meanwhile.
    if (reply?.reason) lastFolderIssue = reply.reason;
    return null;
  } catch (_) {
    return null;
  }
}

/**
 * Save the archive.
 *
 * The chosen folder is the real path; downloads is what happens on a fresh
 * install before anyone has been to Options. No filename listener is
 * registered for the fallback — an explicit `filename` is a request Chrome
 * honours unless another extension overrides it, and answering about our own
 * download would mean answering about everyone's.
 */
async function saveArchive(bytes, filename) {
  const base64 = toBase64(bytes);

  const written = await saveToChosenFolder(base64, filename);
  if (written) {
    lastFolderIssue = null;
    return { path: written.path, viaFolder: true };
  }

  const downloadId = await chrome.downloads.download({
    url: 'data:application/zip;base64,' + base64,
    filename: 'Shopee Review Media/' + filename,
    conflictAction: 'uniquify',
    saveAs: false
  });

  return { downloadId, path: 'Shopee Review Media/' + filename, viaFolder: false };
}

/* ------------------------------------------------------------------ *
 * The export
 * ------------------------------------------------------------------ */

/**
 * items: [{ url, kind, source, page, reviewIndex, mediaIndex, ctime, buyer,
 *           label }]
 * reviews: the normalised reviews, for reviews.csv
 */
async function runExport({ items, reviews, shopName, productName, style, description }) {
  const settings = await getSettings();
  const chosenStyle = style || settings.filenameStyle;

  state.running = true;
  state.error = null;
  state.done = 0;
  state.total = items.length;
  setPhase('fetching', 'Downloading ' + items.length + ' files…');
  startKeepAlive();

  try {
    const root = Naming.rootFolderName(shopName, productName);
    const planned = Naming.assignPaths(items, chosenStyle, root);

    const fetched = await pooled(planned, settings.concurrency, fetchMedia, (done, total) => {
      state.done = done;
      state.total = total;
      // Persisted on a beat rather than every file: a 400-file run would
      // otherwise write to session storage 400 times for no benefit.
      if (done % 10 === 0 || done === total) persist();
    });

    const ok = fetched.filter((r) => r && r.bytes);
    const failed = fetched.filter((r) => r && r.error);

    setPhase('zipping', 'Building the archive…');

    const entries = ok.map((r) => ({ path: r.item.path, data: r.bytes }));

    // reviews.csv only when review media is actually in the export — a
    // product-content-only run has nothing to describe.
    const exportedReviewFiles = new Map();
    for (const r of ok) {
      if (r.item.source !== 'review') continue;
      const key = r.item.page + ':' + r.item.reviewIndex;
      if (!exportedReviewFiles.has(key)) exportedReviewFiles.set(key, []);
      exportedReviewFiles.get(key).push(r.item.path.split('/').pop());
    }

    if (exportedReviewFiles.size > 0) {
      const rows = (reviews || [])
        .filter((rv) => exportedReviewFiles.has(rv.page + ':' + rv.reviewIndex))
        .map((rv) => ({
          page: rv.page,
          reviewIndex: rv.reviewIndex,
          date: Naming.dateStamp(rv.ctime),
          stars: rv.stars,
          buyer: rv.buyer,
          variant: rv.variant,
          comment: rv.comment,
          files: exportedReviewFiles.get(rv.page + ':' + rv.reviewIndex) || []
        }));

      entries.push({
        path: root + '/reviews.csv',
        data: new TextEncoder().encode(Csv.buildReviewsCsv(rows))
      });
    }

    if (description) {
      entries.push({
        path: root + '/description/description.txt',
        data: new TextEncoder().encode(String(description))
      });
    }

    if (entries.length === 0) {
      throw new Error('Nothing downloaded successfully, so there is no archive to save.');
    }

    const bytes = Zip.createZip(entries);

    setPhase('saving', 'Saving…');
    const saved = await saveArchive(bytes, Naming.zipName(shopName, productName));

    state.lastResult = {
      path: saved.path,
      viaFolder: saved.viaFolder,
      files: ok.length,
      failed: failed.length,
      folderIssue: lastFolderIssue
    };
    setPhase('done', 'Saved ' + ok.length + ' files.');
    return state.lastResult;
  } catch (err) {
    state.error = err?.message || String(err);
    setPhase('error', state.error);
    throw err;
  } finally {
    state.running = false;
    stopKeepAlive();
    persist();
  }
}

/* ------------------------------------------------------------------ *
 * Updates
 * ------------------------------------------------------------------ */

function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

async function checkUpdate() {
  const current = chrome.runtime.getManifest().version;
  try {
    const cfg = (await getSettings()).updateSource;
    const url =
      'https://raw.githubusercontent.com/' +
      cfg.owner + '/' + cfg.repo + '/' + cfg.branch + '/' + UPDATE_MANIFEST +
      '?t=' + Date.now();

    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(
        res.status === 404
          ? 'No ' + UPDATE_MANIFEST + ' found in ' + cfg.owner + '/' + cfg.repo + '.'
          : 'HTTP ' + res.status
      );
    }

    const remote = await res.json();
    const info = {
      current,
      latest: remote.version,
      available: compareVersions(remote.version, current) > 0,
      notes: remote.notes || []
    };
    await chrome.storage.local.set({ updateInfo: info });
    return info;
  } catch (err) {
    const info = { current, error: err?.message || String(err) };
    await chrome.storage.local.set({ updateInfo: info });
    return info;
  }
}

/* ------------------------------------------------------------------ *
 * Messages
 * ------------------------------------------------------------------ */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // The offscreen document talks to itself through the same channel; ignoring
  // its traffic here keeps the two from answering each other.
  if (msg?.target === 'offscreen-writer') return undefined;

  (async () => {
    await hydrated;

    switch (msg?.type) {
      case 'getSettings':
        return sendResponse(await getSettings());

      case 'saveSettings':
        return sendResponse(await saveSettings(msg.values || {}));

      case 'checkUpdate':
        return sendResponse(await checkUpdate());

      case 'getState':
        return sendResponse({ ...state, folderIssue: lastFolderIssue });

      case 'progress':
        // Relayed by content.js while it walks the review pages.
        state.running = true;
        state.phase = 'finding';
        state.page = msg.page || 0;
        state.found = msg.found || 0;
        state.message = msg.message || '';
        persist();
        return sendResponse({ ok: true });

      case 'export':
        try {
          return sendResponse({ ok: true, result: await runExport(msg.payload || {}) });
        } catch (err) {
          return sendResponse({ ok: false, error: err?.message || String(err) });
        }

      case 'runFinished':
        state.running = false;
        state.phase = msg.phase || 'idle';
        state.message = msg.message || '';
        persist();
        return sendResponse({ ok: true });

      default:
        return sendResponse({ ok: false, error: 'Unknown message: ' + msg?.type });
    }
  })();

  return true;
});

chrome.runtime.onInstalled.addListener(() => {
  checkUpdate().catch(() => {});
});
