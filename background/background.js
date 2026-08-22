/**
 * Service worker: settings, message routing, the media fetch queue, the ZIP,
 * and saving it.
 *
 * NOTE THE ABSENCE. This file registers no chrome.downloads.onDeterminingFilename
 * listener, and must never gain one — see tools/test-no-filename-listener.js
 * for what happens to the sibling extensions if it does.
 */
importScripts('../lib/zip.js', '../lib/csv.js', '../lib/naming.js', '../lib/diagnostics.js');

const Zip = self.SRME_Zip;
const Csv = self.SRME_Csv;
const Naming = self.SRME_Naming;
const Diagnostics = self.SRME_Diagnostics;

const DEFAULTS = {
  filenameStyle: Naming.STYLES.PAGE_REVIEW_TYPE,
  pageDelayMs: 300,
  concurrency: 4,
  // 'folder' protects the filename; 'downloads' lets Chrome open the folder.
  saveVia: 'folder',
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
  // A worker already running its own export always wins. This only fills in
  // what a restart wiped; without the guard, stale session state could
  // overwrite a live run the moment anything re-entered here.
  if (state.running) return;

  try {
    const got = await chrome.storage.session.get(['runState', 'lastFolderIssue']);
    if (got.runState) Object.assign(state, got.runState);
    if (got.lastFolderIssue !== undefined) lastFolderIssue = got.lastFolderIssue;
  } catch (_) {
    /* nothing worth restoring */
  }

  // A run is driven from the content script, so a closed tab or a killed
  // worker leaves `running: true` in session storage with nobody to clear it,
  // and the popup shows "Downloading 12 of 400" for ever. A restored run is
  // only believable if this worker is the one running it — and it is not, or
  // this function would have returned above.
  if (state.running) {
    state.running = false;
    state.phase = 'idle';
    state.message = 'The last run was interrupted.';
  }
}

// Two names on purpose. `hydrating` is the promise to await; `hydrated` is the
// boolean a listener that must answer synchronously can read. Keeping only the
// promise, named like a boolean, meant `if (hydrated)` was true even on a cold
// worker with nothing in memory.
let hydrated = false;
const hydrating = hydrate().then(() => {
  hydrated = true;
});

/**
 * Paint the toolbar icon with what is happening.
 *
 * The picker is an in-page overlay, so clicking it closes the popup — and the
 * whole fetch, zip and save then runs with nothing on screen at all. An export
 * that failed looked exactly like an export that had not started. The badge is
 * the only surface that survives the popup closing.
 */
function setBadge(phase) {
  const look = {
    finding: { text: '…', colour: '#f59e0b' },
    choosing: { text: '…', colour: '#f59e0b' },
    fetching: { text: '…', colour: '#f59e0b' },
    saving: { text: '…', colour: '#f59e0b' },
    done: { text: 'OK', colour: '#16a34a' },
    error: { text: '!', colour: '#dc2626' }
  }[phase] || { text: '', colour: '#000000' };

  chrome.action.setBadgeText({ text: look.text }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: look.colour }).catch(() => {});
}

function setPhase(phase, message) {
  state.phase = phase;
  if (message !== undefined) state.message = message;
  setBadge(phase);
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One media file, with the same backoff the ratings endpoint gets.
 *
 * A media run is hundreds of requests where a ratings run is a handful, so
 * this is where rate limiting actually shows up — and it had no retry at all,
 * while the far less exposed ratings path had four.
 *
 * A failure is recorded, not thrown: one dead CDN link should cost the user
 * that file, not the other three hundred.
 */
async function fetchMedia(item) {
  if (!item.url) return { item, error: 'no direct link' };

  let wait = 400;
  for (let attempt = 0; attempt <= 3; attempt++) {
    try {
      const res = await fetch(item.url);
      if (res.ok) {
        const buf = await res.arrayBuffer();
        return { item, bytes: new Uint8Array(buf) };
      }
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt === 3) return { item, error: 'HTTP ' + res.status };
    } catch (err) {
      if (attempt === 3) return { item, error: err?.message || String(err) };
    }
    await sleep(wait);
    wait *= 2;
  }

  return { item, error: 'gave up' };
}

/**
 * A folder per run, so extracting the same product twice does not overwrite
 * the first export. getFileHandle(create:true) truncates without asking, and
 * the download path would have uniquified instead — the two save routes
 * disagreed about what a repeat run means. SiteGiant solves this the same way.
 */
function runFolderName(now) {
  const d = now || new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

/* ------------------------------------------------------------------ *
 * Saving
 * ------------------------------------------------------------------ */

/**
 * The offscreen document, created at most once.
 *
 * The in-flight promise is memoised as well as checked, because getContexts()
 * is a snapshot: two exports starting together both saw zero contexts and both
 * called createDocument(), and the second rejects with "Only a single offscreen
 * document may be created". That rejection used to be swallowed and the run
 * fell back to chrome.downloads — silently re-entering the naming contest the
 * offscreen document exists to avoid.
 */
let offscreenReady = null;

function ensureOffscreen() {
  if (offscreenReady) return offscreenReady;

  offscreenReady = (async () => {
    const existing = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT']
    });
    if (existing.length) return;

    try {
      await chrome.offscreen.createDocument({
        url: 'offscreen/offscreen.html',
        reasons: ['BLOBS'],
        justification:
          'Writes the export into the folder the user chose, using the File System ' +
          'Access API, which a service worker cannot reach.'
      });
    } catch (err) {
      // Lost the race to another caller: the document exists, which is all
      // this function promised.
      if (!/single offscreen document/i.test(err?.message || '')) throw err;
    }
  })().finally(() => {
    // Cleared so a document closed by Chrome can be recreated later.
    offscreenReady = null;
  });

  return offscreenReady;
}

/* ------------------------------------------------------------------ *
 * Handing the archive to the writer
 *
 * Through IndexedDB, not through a message. See the header of
 * offscreen/offscreen.js for why base64-over-sendMessage had to go.
 * ------------------------------------------------------------------ */
const DB_NAME = 'shopee-review-media-extractor';
const DB_VERSION = 2;
const PAYLOADS = 'payloads';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('handles')) db.createObjectStore('handles');
      if (!db.objectStoreNames.contains(PAYLOADS)) db.createObjectStore(PAYLOADS);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function stashPayload(key, bytes) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(PAYLOADS, 'readwrite');
    tx.objectStore(PAYLOADS).put(bytes, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  }));
}

function dropPayload(key) {
  return openDb().then((db) => new Promise((resolve) => {
    const tx = db.transaction(PAYLOADS, 'readwrite');
    tx.objectStore(PAYLOADS).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  })).catch(() => {});
}

/**
 * Let go of the fallback's blob and the copy of the bytes behind it.
 *
 * The URL belongs to the offscreen document, so only the offscreen document
 * can revoke it. If that document is gone the URL died with it and there is
 * nothing to revoke — but the payload row is in IndexedDB and outlives
 * everything, so it still has to be cleared here or a 50 MB export stays on
 * disk for ever.
 */
function releaseBlob(url, key) {
  chrome.runtime
    .sendMessage({ target: 'offscreen-writer', action: 'revoke', url, key })
    .catch(() => dropPayload(key));
}

/** Waits for a download to settle, so "saved" is a fact and not a hope. */
function verifyDownload(downloadId) {
  return new Promise((resolve) => {
    const done = (delta) => {
      if (delta.id !== downloadId || !delta.state) return;
      if (delta.state.current === 'in_progress') return;
      chrome.downloads.onChanged.removeListener(done);
      chrome.downloads.search({ id: downloadId }).then((r) => resolve(r[0] || null));
    };
    chrome.downloads.onChanged.addListener(done);
    // Already finished before the listener attached.
    chrome.downloads.search({ id: downloadId }).then((r) => {
      const item = r[0];
      if (item && item.state !== 'in_progress') {
        chrome.downloads.onChanged.removeListener(done);
        resolve(item);
      }
    });
  });
}

function basename(path) {
  return String(path || '').split(/[\\/]/).pop();
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
async function saveArchive(bytes, filename, runFolder, preferDownload) {
  const key = 'export-' + filename + '-' + bytes.length;
  const segments = ['Shopee Review Media', runFolder];

  let reply = null;
  try {
    await stashPayload(key, bytes);
    await ensureOffscreen();
    reply = await chrome.runtime.sendMessage({
      target: 'offscreen-writer',
      action: 'write',
      key,
      segments,
      filename,
      preferDownload
    });
  } catch (err) {
    lastFolderIssue = 'error';
    reply = null;
  }

  // The writer reached the chosen folder.
  if (reply?.ok) {
    lastFolderIssue = null;
    return { path: reply.path, viaFolder: true };
  }

  // It could not, and handed back a blob URL to download instead. Not an error
  // worth stopping for: no folder chosen yet, or the permission lapsed. Both
  // are settled in Options, and the file still arrives meanwhile.
  if (reply?.reason) lastFolderIssue = reply.reason;

  // Nothing to download — no payload, or the blob itself could not be made.
  if (!reply?.blobUrl) {
    await dropPayload(key);
    throw new Error(
      'Could not save the archive: ' + (reply?.error || reply?.reason || 'no writer available')
    );
  }

  // STARTED HERE, NOT IN THE WRITER. chrome.downloads is undefined in an
  // offscreen document — runtime is the only extensions API Chrome gives one —
  // so the version that called it there threw a TypeError instead of saving,
  // on every machine whose folder permission had lapsed. See the comment on
  // handBack() in offscreen/offscreen.js.
  let downloadId;
  try {
    downloadId = await chrome.downloads.download({
      url: reply.blobUrl,
      filename: reply.path,
      conflictAction: 'overwrite',
      saveAs: false
    });
  } catch (err) {
    releaseBlob(reply.blobUrl, key);
    throw new Error('Could not save the archive: ' + (err?.message || String(err)));
  }

  const path = reply.path;
  const item = await verifyDownload(downloadId);

  // Only now. Revoking before the download has read the blob cancels it.
  releaseBlob(reply.blobUrl, key);

  // A NAME IS NOT WORTH THE RUN. If Chrome saved it elsewhere or under
  // another name, say so rather than reporting a success that did not happen.
  const saved = item && basename(item.filename);
  return {
    downloadId,
    path: item?.filename || path,
    viaFolder: false,
    failed: item ? item.state !== 'complete' : false,
    misnamed: saved && saved !== filename ? saved : null
  };
}

/* ------------------------------------------------------------------ *
 * The export
 * ------------------------------------------------------------------ */

/**
 * items: [{ url, kind, source, page, reviewIndex, mediaIndex, ctime, buyer,
 *           label }]
 * reviews: the normalised reviews, for reviews.csv
 */
async function runExport({
  items, reviews, shopName, productName, style, description, usedFallback
}) {
  const settings = await getSettings();
  const chosenStyle = style || settings.filenameStyle;

  state.running = true;
  state.error = null;
  state.done = 0;
  state.total = items.length;
  // Cleared at the start, so a run that fails or is cancelled cannot leave the
  // previous run's "Saved 312 files" sitting in the popup as if it were this
  // one's result.
  state.lastResult = null;
  state.usedFallback = !!usedFallback;
  setPhase('fetching', 'Downloading ' + items.length + ' files…');
  startKeepAlive();

  try {
    // No root folder inside the archive: Windows creates one named after the
    // zip when extracting, and a second copy of a 100-character Shopee title
    // inside it is what produced 'Destination Path Too Long'.
    const planned = Naming.assignPaths(items, chosenStyle);

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
        path: 'reviews.csv',
        data: new TextEncoder().encode(Csv.buildReviewsCsv(rows))
      });
    }

    if (description) {
      entries.push({
        path: 'description/description.txt',
        data: new TextEncoder().encode(String(description))
      });
    }

    if (entries.length === 0) {
      throw new Error('Nothing downloaded successfully, so there is no archive to save.');
    }

    const bytes = Zip.createZip(entries);

    setPhase('saving', 'Saving…');
    const saved = await saveArchive(
      bytes,
      Naming.zipName(shopName, productName),
      runFolderName(),
      settings.saveVia === 'downloads'
    );

    // Kept for revealFolder(), which needs the download id to open Chrome's
    // own file-in-folder view.
    state.lastDownloadId = saved.downloadId ?? null;
    state.lastOutputPath = saved.path;

    state.lastResult = {
      path: saved.path,
      viaFolder: saved.viaFolder,
      files: ok.length,
      failed: failed.length,
      folderIssue: lastFolderIssue,
      misnamed: saved.misnamed || null,
      downloadFailed: !!saved.failed,
      usedFallback: !!usedFallback
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

/**
 * Show the seller where the last export went.
 *
 * chrome.downloads.show() opens the containing folder with the file already
 * selected, which is exactly right — but only for a file that went through
 * downloads. There is no extension API that opens an arbitrary directory, so
 * a file written into the seller's own chosen folder cannot be revealed at
 * all; the honest answer there is to hand back the path and let the popup
 * show it. Opening the Downloads folder instead would be actively unhelpful,
 * because that is the one place the file is NOT.
 */
async function revealFolder() {
  if (state.lastDownloadId != null) {
    try {
      await chrome.downloads.show(state.lastDownloadId);
      return { ok: true, opened: true };
    } catch (_) {
      /* fall through to reporting the path */
    }
  }

  if (state.lastOutputPath) {
    return { ok: true, opened: false, path: state.lastOutputPath };
  }

  return { ok: false, opened: false };
}

/* ------------------------------------------------------------------ *
 * Messages
 * ------------------------------------------------------------------ */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // The offscreen document talks to itself through the same channel; ignoring
  // its traffic here keeps the two from answering each other.
  if (msg?.target === 'offscreen-writer') return undefined;

  (async () => {
    await hydrating;

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
        // Relayed by content.js while it walks the review pages and while the
        // picker is open. `found` is the running total, not the last page's.
        state.running = msg.phase !== 'idle';
        state.phase = msg.phase || 'finding';
        state.page = msg.page || 0;
        state.found = msg.found || 0;
        state.totalPages = msg.totalPages || null;
        state.message = msg.message || '';
        persist();
        return sendResponse({ ok: true });

      case 'export':
        try {
          return sendResponse({ ok: true, result: await runExport(msg.payload || {}) });
        } catch (err) {
          return sendResponse({ ok: false, error: err?.message || String(err) });
        }

      case 'openFolder':
        return sendResponse(await revealFolder());

      // Everything the Options page needs for "Copy diagnostics". The
      // formatting lives in lib/diagnostics.js so a node test can read it
      // without a browser.
      //
      // otherExtensions and history are passed as an explicit null, and that is
      // not laziness. This extension registers no filename listener - see
      // tools/test-no-filename-listener.js for why that rule exists - so it
      // genuinely cannot see what else is handling downloads, and it keeps no
      // run history. Reporting either as "none" would read as evidence, and
      // send whoever is diagnosing this looking in the wrong place.
      case 'getDiagnostics': {
        const settings = await getSettings();
        const { updateInfo } = await chrome.storage.local.get('updateInfo');
        return sendResponse({
          ok: true,
          report: Diagnostics.buildReport({
            now: Date.now(),
            extension: {
              name: chrome.runtime.getManifest().name,
              version: chrome.runtime.getManifest().version,
              id: chrome.runtime.id
            },
            browser: navigator.userAgent,
            platform: (navigator.userAgentData && navigator.userAgentData.platform) || '',
            folder: {
              chosen: msg.outputFolder === true,
              name: msg.outputFolderName || '',
              extensionFolderGranted: msg.extensionFolderGranted === true
            },
            updateSource: settings.updateSource || null,
            updateInfo: updateInfo || null,
            otherExtensions: null,
            history: null,
            notes: [
              'Current phase: ' + (state.phase || 'idle') +
                (state.running ? ' (running)' : ''),
              'Last progress: page ' + (state.page || 0) +
                (state.totalPages ? ' of ' + state.totalPages : '') +
                ', ' + (state.found || 0) + ' found',
              'Last message: ' + (state.message || '(none)'),
              'Last folder issue: ' + (lastFolderIssue || '(none)')
            ]
          })
        });
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
  })().catch((err) => {
    // Returning true above promises a reply. Without this, a rejection
    // anywhere in the switch — storage quota, a context invalidated
    // mid-update — left the caller awaiting for ever: the Options page would
    // simply never populate, with nothing shown to explain it.
    try {
      sendResponse({ ok: false, error: err?.message || String(err) });
    } catch (_) {
      /* the port is already gone; nothing left to tell */
    }
  });

  return true;
});

chrome.runtime.onInstalled.addListener(() => {
  checkUpdate().catch(() => {});
});
