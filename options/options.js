/**
 * Options page.
 *
 * Also owns update INSTALLATION, which the background worker cannot do:
 * writing to the extension's own folder needs a directory handle the user
 * granted through a picker, and only a real page can show one.
 *
 * Adapted from the two sibling extensions. The folder handling is deliberately
 * near-identical to SiteGiant Downloader's — it is the part that took longest
 * to get right, and a difference here would be a difference in behaviour
 * nobody asked for.
 */
const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);

let savedTimer = null;

function flashSaved() {
  const el = $('saved');
  el.hidden = false;
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => {
    el.hidden = true;
  }, 1400);
}

async function save() {
  // Must match DEFAULTS in the background worker.
  const delay = Math.min(5000, Math.max(0, Number($('delay').value) || 0));
  const concurrency = Math.min(8, Math.max(1, Number($('concurrency').value) || 4));
  $('delay').value = delay;
  $('concurrency').value = concurrency;

  await send({
    type: 'saveSettings',
    values: {
      filenameStyle: $('style').value,
      pageDelayMs: delay,
      concurrency,
      updateSource: {
        owner: $('owner').value.trim(),
        repo: $('repo').value.trim(),
        branch: $('branch').value.trim() || 'main',
      },
    },
  });
  flashSaved();
}

function renderUpdate(info) {
  const status = $('update-status');
  const install = $('install');

  if (!info) {
    status.textContent = 'Not checked yet.';
    install.hidden = true;
    return;
  }
  if (info.error) {
    status.textContent = `Could not check for updates: ${info.error}`;
    install.hidden = true;
    return;
  }
  if (info.available) {
    status.textContent = `Version ${info.latest} is available. You have ${info.current}.`;
    install.hidden = false;
    return;
  }
  status.textContent = `Up to date (version ${info.current}).`;
  install.hidden = true;
}

/* ------------------------------------------------------------------ *
 * Remembering folders.
 *
 * A directory handle is structured-clonable but NOT JSON — chrome.storage
 * cannot hold one, so it goes in IndexedDB.
 *
 * Chrome may still ask to confirm the permission after a restart. That prompt
 * is one click, not a folder hunt, and it is not something an extension can
 * waive.
 * ------------------------------------------------------------------ */
const DB_NAME = 'shopee-review-media-extractor';
const STORE = 'handles';
const HANDLE_KEY = 'extensionDir';
/** Where exports are written. Separate from the folder used for self-updates. */
const OUTPUT_KEY = 'outputFolder';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbGet(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

async function idbDelete(key) {
  const db = await openDb();
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = () => resolve();
  });
}

/** Asks only if we do not already hold write permission. */
async function ensureWritable(handle, mayPrompt) {
  const opts = { mode: 'readwrite' };
  if ((await handle.queryPermission(opts)) === 'granted') return true;
  if (!mayPrompt) return false;
  return (await handle.requestPermission(opts)) === 'granted';
}

/* ------------------------------------------------------------------ *
 * The export folder
 *
 * Chosen once and remembered. The offscreen writer reads the same handle out
 * of IndexedDB — it cannot ask for permission itself, because that needs a
 * click and there is nobody to click in a background document. So this page is
 * the only place the grant can be renewed, which is why it re-checks on every
 * open.
 * ------------------------------------------------------------------ */
async function refreshOutputFolder() {
  const status = $('output-status');
  const forget = $('forget-output');
  const handle = await idbGet(OUTPUT_KEY);

  if (!handle) {
    status.textContent =
      'No folder chosen — exports are saved through Chrome, where another extension can rename them.';
    forget.hidden = true;
    return;
  }

  // mayPrompt: false. Opening Options should report the state, not fire a
  // permission dialog at someone who came here to change something else.
  const writable = await ensureWritable(handle, false);
  status.textContent = writable
    ? `Writing exports into "${handle.name}". No other extension can rename them.`
    : `"${handle.name}" needs permission again — choose it once more.`;
  forget.hidden = false;
}

async function pickOutputFolder() {
  const status = $('output-status');

  if (!window.showDirectoryPicker) {
    status.textContent = 'This Chrome cannot choose a folder, so exports keep using downloads.';
    return;
  }

  try {
    const chosen = await window.showDirectoryPicker({ mode: 'readwrite' });
    if (!(await ensureWritable(chosen, true))) {
      status.textContent = 'Permission refused — nothing changed.';
      return;
    }
    await idbSet(OUTPUT_KEY, chosen);
    await refreshOutputFolder();
  } catch (err) {
    // Cancelling the picker is a decision, not a fault, and Chrome's own
    // wording for it ("The user aborted a request") reads like one.
    if (err?.name !== 'AbortError') {
      status.textContent = `Could not use that folder: ${err?.message || err}`;
    }
  }
}

/**
 * Is this actually the extension's own folder?
 *
 * A remembered handle could point anywhere if the folder was moved or the
 * wrong one was chosen, and writing a manifest into someone's Documents would
 * be a miserable thing to debug. Reading our own manifest proves it.
 */
async function isExtensionFolder(handle) {
  try {
    const file = await (await handle.getFileHandle('manifest.json')).getFile();
    const json = JSON.parse(await file.text());
    return json?.name === chrome.runtime.getManifest().name;
  } catch {
    return false;
  }
}

/**
 * Says whether the folder is remembered, so "will it ask me again?" is
 * answerable without running an update to find out.
 */
async function refreshFolderStatus() {
  const status = $('folder-status');
  const forget = $('forget-folder');
  const pick = $('pick-folder');

  const handle = await idbGet(HANDLE_KEY);
  if (!handle) {
    status.textContent = 'Extension folder: not chosen yet — you will be asked once.';
    forget.hidden = true;
    pick.textContent = 'Choose the extension folder…';
    return null;
  }

  const granted = await ensureWritable(handle, false);
  status.textContent = granted
    ? `Extension folder: remembered (${handle.name}). You will not be asked again.`
    : `Extension folder: remembered (${handle.name}), but Chrome will ask you to confirm on the next write.`;
  forget.hidden = false;
  pick.textContent = 'Choose a different folder…';
  return handle;
}

/**
 * Asks for the folder. Must run straight from a click — the directory picker
 * needs user activation, which is why this is its own button rather than
 * something the install path does several awaits deep.
 */
async function requestFolder() {
  const status = $('folder-status');
  if (!window.showDirectoryPicker) {
    status.textContent = 'This Chrome has no directory picker.';
    return null;
  }

  let chosen;
  try {
    chosen = await window.showDirectoryPicker({ mode: 'readwrite' });
  } catch {
    return null; // cancelled
  }

  if (!(await isExtensionFolder(chosen))) {
    status.textContent = 'That is not this extension’s folder — look for the one holding manifest.json.';
    return null;
  }
  if (!(await ensureWritable(chosen, true))) {
    status.textContent = 'Write permission was declined.';
    return null;
  }

  await idbSet(HANDLE_KEY, chosen);
  await refreshFolderStatus();
  return chosen;
}

/** The folder to write into: remembered if possible, chosen if not. */
async function extensionFolder(status) {
  const remembered = await idbGet(HANDLE_KEY);

  if (remembered) {
    if ((await ensureWritable(remembered, true)) && (await isExtensionFolder(remembered))) {
      return remembered;
    }
    // Stale or wrong — forget it rather than asking about it again next time.
    await idbDelete(HANDLE_KEY);
    await refreshFolderStatus();
  }

  status.textContent = 'Choose this extension’s folder — just this once…';
  const chosen = await requestFolder();
  if (!chosen) throw new Error('No folder chosen, so nothing was written.');
  return chosen;
}

/* ------------------------------------------------------------------ *
 * Installing an update.
 *
 * Fetches every file listed in the remote update.json and writes it into the
 * extension's own folder. manifest.json is written LAST, so a half-finished
 * download cannot leave the extension claiming a version it does not have.
 * ------------------------------------------------------------------ */
async function install() {
  const button = $('install');
  const status = $('update-status');

  if (!window.showDirectoryPicker) {
    status.textContent = 'This Chrome cannot write files. Update by re-downloading the folder.';
    return;
  }

  button.disabled = true;
  try {
    const settings = await send({ type: 'getSettings' });
    const cfg = settings.updateSource;
    const base = `https://raw.githubusercontent.com/${cfg.owner}/${cfg.repo}/${cfg.branch}`;

    status.textContent = 'Reading the update…';
    const listRes = await fetch(`${base}/update.json?t=${Date.now()}`);
    if (!listRes.ok) throw new Error(`Could not read update.json (HTTP ${listRes.status})`);
    const remote = await listRes.json();

    const root = await extensionFolder(status);

    const files = (remote.files || []).filter((f) => f !== 'manifest.json');
    files.push('manifest.json');

    // Fetch EVERYTHING before writing anything.
    //
    // Downloading and writing file by file means a connection that drops
    // halfway leaves the folder holding a mix of old and new code — which
    // still loads, and misbehaves in ways no version number explains. Writing
    // manifest.json last keeps it from CLAIMING the new version, but that only
    // helps if the rest of the files agree with each other.
    const fetched = [];
    for (const file of files) {
      status.textContent = `Downloading ${file} (${fetched.length + 1} of ${files.length})…`;
      const res = await fetch(`${base}/${file}?t=${Date.now()}`);
      if (!res.ok) throw new Error(`Could not download ${file} (HTTP ${res.status})`);
      fetched.push({ file, bytes: await res.arrayBuffer() });
    }

    // Everything is in hand; now it can go to disk. manifest.json is still
    // last, so an interrupted WRITE leaves the old version number in place.
    let done = 0;
    for (const { file, bytes } of fetched) {
      status.textContent = `Writing ${file} (${done + 1} of ${fetched.length})…`;

      const parts = file.split('/');
      const name = parts.pop();
      let dir = root;
      for (const part of parts) {
        dir = await dir.getDirectoryHandle(part, { create: true });
      }

      const handle = await dir.getFileHandle(name, { create: true });
      const writable = await handle.createWritable();
      await writable.write(bytes);
      await writable.close();
      done += 1;
    }

    // Reload ourselves rather than sending the user to chrome://extensions.
    // Chrome keeps running the OLD code until the extension restarts, so
    // stopping at "files written" would leave it looking updated while
    // behaving exactly as before — the worst of both.
    status.textContent = `Updated to ${remote.version}. Reloading…`;
    $('install').hidden = true;
    await chrome.storage.local.remove('updateInfo');
    setTimeout(() => chrome.runtime.reload(), 800);
  } catch (err) {
    status.textContent =
      err?.name === 'AbortError'
        ? 'Update cancelled — nothing was changed.'
        : `Update failed: ${err?.message || err}`;
  } finally {
    button.disabled = false;
  }
}

/* ------------------------------------------------------------------ *
 * Diagnostics
 *
 * The same checks the console script does, run from here instead. Chrome
 * blocks the first paste into DevTools as a self-XSS guard, and a Shopee
 * product page floods the console with its own warnings anyway, so the answer
 * was getting lost even when the paste worked. A button has neither problem.
 * ------------------------------------------------------------------ */
const PRODUCT_URL = /shopee\.(com\.my|sg|ph|co\.th|co\.id)\/.*i\.\d+\.\d+/i;

async function findProductTab() {
  // The active tab first, since that is almost always the one meant. Falling
  // back to any product tab saves a round trip when Settings is the active tab
  // in its own window, which it usually is.
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (active && PRODUCT_URL.test(active.url || '')) return active;

  const all = await chrome.tabs.query({});
  return all.find((t) => PRODUCT_URL.test(t.url || '')) || null;
}

async function runProbe() {
  const status = $('probe-status');
  const out = $('probe-out');
  const copy = $('probe-copy');
  const button = $('probe');

  out.hidden = true;
  copy.hidden = true;
  button.disabled = true;
  status.textContent = 'Looking for an open product page…';

  try {
    const tab = await findProductTab();
    if (!tab) {
      status.textContent =
        'No Shopee product page is open. Open one (the address has i.NUMBER.NUMBER in it) and try again.';
      return;
    }

    status.textContent = 'Asking Shopee… this takes a few seconds.';

    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      // Passed by reference, but Chrome ships the SOURCE to the page — which
      // is why the probe is one function that closes over nothing.
      func: SRME_Probe.run
    });

    const data = result?.result;
    if (!data) throw new Error('The page returned nothing.');

    out.value = JSON.stringify(data, null, 2);
    out.hidden = false;
    copy.hidden = false;

    if (data.problem) {
      status.textContent = data.problem;
      return;
    }

    // The headline answer, so the useful part is not buried in the JSON.
    const asked50 = data.ratings?.limit_50;
    const got = asked50 ? asked50.got : null;
    const answering = (data.detail || []).filter((d) => d.httpStatus === 200).map((d) => d.path);

    status.textContent =
      'Done. Reviews per call: ' + (got == null ? 'none came back' : got + ' of 50 asked') +
      ' · detail endpoints answering: ' + (answering.length ? answering.join(', ') : 'none') +
      ' — send me the text below.';
  } catch (err) {
    status.textContent = 'Could not run it: ' + (err?.message || err);
  } finally {
    button.disabled = false;
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  $('version').textContent = chrome.runtime.getManifest().version;

  const settings = await send({ type: 'getSettings' });
  $('style').value = settings.filenameStyle;
  $('delay').value = settings.pageDelayMs;
  $('concurrency').value = settings.concurrency;
  $('owner').value = settings.updateSource.owner;
  $('repo').value = settings.updateSource.repo;
  $('branch').value = settings.updateSource.branch;

  for (const id of ['style', 'delay', 'concurrency', 'owner', 'repo', 'branch']) {
    $(id).addEventListener('change', save);
  }

  $('check').addEventListener('click', async () => {
    $('update-status').textContent = 'Checking…';
    renderUpdate(await send({ type: 'checkUpdate' }));
  });
  $('install').addEventListener('click', install);

  $('pick-output').addEventListener('click', pickOutputFolder);
  $('forget-output').addEventListener('click', async () => {
    await idbDelete(OUTPUT_KEY);
    await refreshOutputFolder();
  });
  await refreshOutputFolder();

  $('pick-folder').addEventListener('click', requestFolder);
  $('forget-folder').addEventListener('click', async () => {
    await idbDelete(HANDLE_KEY);
    await refreshFolderStatus();
  });
  await refreshFolderStatus();

  $('probe').addEventListener('click', runProbe);
  $('probe-copy').addEventListener('click', async () => {
    await navigator.clipboard.writeText($('probe-out').value);
    $('probe-status').textContent = 'Copied — paste it back to Claude.';
  });

  const { updateInfo } = await chrome.storage.local.get('updateInfo');
  renderUpdate(updateInfo);
});
