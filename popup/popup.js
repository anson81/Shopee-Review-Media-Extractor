/**
 * Popup panel.
 *
 * Holds no run state of its own. A Chrome popup is destroyed the moment it
 * loses focus, so anything it remembered would vanish mid-run; the service
 * worker owns the state and this asks for it on open.
 */
const $ = (id) => document.getElementById(id);

const PRODUCT_HOSTS = /(^|\.)shopee\.(com\.my|sg|ph|co\.th|co\.id)$/i;

/**
 * The name of the folder chosen in Options, so a finished run can say WHERE
 * the file went. The popup cannot read a directory handle itself, and
 * "Saved 2 files." with no location just sends the seller hunting.
 */
let folderName = null;

/* ------------------------------------------------------------------ *
 * The update bar
 *
 * Same shape as both sibling extensions. Installing an update needs a
 * directory handle the user granted through a picker, and only a real page
 * can show one — so the popup reports, and Options installs.
 * ------------------------------------------------------------------ */
let updateAction = 'check';

function showUpdate(text, kind, actionLabel, action) {
  const bar = $('update-bar');
  const button = $('update-action');
  bar.hidden = false;
  bar.className = 'update-bar' + (kind ? ' ' + kind : '');
  $('update-text').textContent = text;
  button.hidden = !actionLabel;
  if (actionLabel) button.textContent = actionLabel;
  if (action) updateAction = action;
}

function renderUpdate(info) {
  if (!info) {
    showUpdate('Updates not checked yet.', null, 'Check', 'check');
    return;
  }
  if (info.error) {
    // Worth showing rather than hiding: a self-updating extension that has
    // quietly stopped being able to check is exactly what leaves someone on
    // an old version wondering why a fix never arrived.
    showUpdate('Could not check for updates.', 'warn', 'Check', 'check');
    return;
  }
  if (info.available) {
    showUpdate('Version ' + info.latest + ' is available.', 'new', 'Update', 'options');
    return;
  }
  showUpdate('Up to date (v' + info.current + ').', 'ok', 'Check', 'check');
}

const WANT_IDS = {
  reviewImages: 'review-images',
  reviewVideos: 'review-videos',
  mainImages: 'main-images',
  variantImages: 'variant-images',
  productVideos: 'product-videos',
  description: 'description'
};

function readWant() {
  const want = {};
  for (const [key, id] of Object.entries(WANT_IDS)) want[key] = $(id).checked;
  return want;
}

function setStatus(text, kind) {
  const el = $('status');
  el.textContent = text || '';
  el.className = 'status' + (kind ? ' ' + kind : '');
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

/**
 * Make sure the page actually has our content script in it.
 *
 * Chrome injects declared content scripts on NAVIGATION. Every tab that was
 * already open when the extension was installed, reloaded, or updated has no
 * script in it — which is every tab, the first time anyone uses this.
 *
 * Without this, clicking Find sent a message into a tab with no listener.
 * chrome.tabs.sendMessage rejects asynchronously in that case, so the
 * try/catch around it could never fire and the .catch() swallowed it: the
 * button hid, "Starting…" appeared, and nothing else ever happened. Telling
 * the user to reload every tab is not a fix; injecting is. Both sibling
 * extensions carry this same helper for the same reason.
 */
async function ensureContentScript(tabId) {
  try {
    const pong = await chrome.tabs.sendMessage(tabId, { type: 'ping' });
    if (pong?.ok) return true;
  } catch (_) {
    /* not there yet - inject below */
  }

  try {
    // MAIN world first and separately: it wraps the page's own fetch, and it
    // cannot be bundled with the isolated-world files.
    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      files: ['content/interceptor.js']
    });
  } catch (_) {
    /* the fallback path is a bonus; carry on without it */
  }

  await chrome.scripting.insertCSS({ target: { tabId }, files: ['content/picker.css'] });
  await chrome.scripting.executeScript({
    target: { tabId },
    // Same order as the manifest. api.js and picker.js must be defined before
    // content.js reads them.
    files: ['lib/naming.js', 'content/api.js', 'content/picker.js', 'content/content.js']
  });

  const pong = await chrome.tabs.sendMessage(tabId, { type: 'ping' });
  return !!pong?.ok;
}

function isProductPage(tab) {
  try {
    const url = new URL(tab.url);
    if (!PRODUCT_HOSTS.test(url.hostname)) return false;

    // Asked of api.js rather than re-tested here. This used to carry its own
    // copy of the rule that only knew the i.SHOP.ITEM form, so on a
    // /product/SHOP/ITEM/ URL — which Shopee serves just as often — the popup
    // decided it was not a product page and disabled the button, while every
    // other part of the extension would have handled it fine.
    return window.SRME_Api.isProductUrl(tab.url);
  } catch (_) {
    return false;
  }
}

function describeFolderIssue(issue) {
  if (issue === 'no-folder') {
    return 'Saved through Chrome, where another extension can rename it. ' +
      'Choose a folder in Settings to stop that for good.';
  }
  if (issue === 'permission') {
    return 'The export folder needs permission again — open Settings and choose it once more.';
  }
  return '';
}

function render(state) {
  const running = !!state.running;
  $('find').hidden = running;
  $('stop').hidden = !running;

  if (running) {
    if (state.phase === 'finding') {
      // "Page 7 of 50 · 312 files", per the spec. The total is only known
      // when a range was given, so it is omitted rather than guessed.
      const page = 'Page ' + (state.page || 0) +
        (state.totalPages ? ' of ' + state.totalPages : '');
      setStatus(page + ' · ' + (state.found || 0) + ' files');
    } else if (state.phase === 'choosing') {
      setStatus(state.message || 'Waiting for you to choose…');
    } else if (state.phase === 'fetching') {
      setStatus('Downloading ' + (state.done || 0) + ' of ' + (state.total || 0) + '…');
    } else {
      setStatus(state.message || 'Working…');
    }
    return;
  }

  if (state.phase === 'error') {
    setStatus(state.message || state.error || 'Something went wrong.', 'error');
    return;
  }

  const result = state.lastResult;
  if (result) {
    const bits = ['Saved ' + result.files + ' files'];
    if (result.failed) bits.push(result.failed + ' could not be downloaded');
    setStatus(bits.join(' · ') + '.', result.downloadFailed ? 'error' : 'good');

    // WHERE, not just whether. "Saved 2 files." on its own sent the user
    // hunting through folders — the extension knew the answer and did not say.
    const where = $('where');
    if (result.path) {
      where.hidden = false;
      where.textContent = result.viaFolder
        ? (folderName ? folderName + ' / ' + result.path : result.path)
        : 'Downloads / ' + result.path;
      where.title = where.textContent;
    } else {
      where.hidden = true;
    }

    // Only offered for a file that went through downloads, because
    // chrome.downloads.show() is the only thing that opens a folder and it
    // needs a download to point at. A file written into the chosen folder
    // cannot be revealed by any extension API — see revealFolder().
    $('open-folder').hidden = result.viaFolder || !result.path;

    // Everything below is something the user would otherwise never learn.
    const notes = [];
    const folder = describeFolderIssue(result.folderIssue);
    if (folder) notes.push(folder);
    if (result.usedFallback) {
      notes.push(
        'Shopee’s usual endpoint did not answer, so this came from what the ' +
        'page had already loaded. It is probably less than everything.'
      );
    }
    if (result.misnamed) {
      notes.push('Chrome saved it as "' + result.misnamed + '" instead.');
    }
    if (result.downloadFailed) {
      notes.push('The download did not finish. Check your Downloads list.');
    }

    $('folder-note').hidden = notes.length === 0;
    $('folder-note').textContent = notes.join(' ');
    return;
  }

  if (state.message) {
    setStatus(state.message);
    return;
  }

  setStatus('');
}

async function refresh() {
  const state = await chrome.runtime.sendMessage({ type: 'getState' });
  render(state || {});
}

document.addEventListener('DOMContentLoaded', async () => {
  const tab = await activeTab();
  const onProduct = tab && isProductPage(tab);
  $('not-product').hidden = !!onProduct;
  $('find').disabled = !onProduct;

  const settings = await chrome.runtime.sendMessage({ type: 'getSettings' });
  if (settings?.filenameStyle) $('style').value = settings.filenameStyle;

  const stored = await chrome.storage.local.get('outputFolderName');
  folderName = stored.outputFolderName || null;

  $('version').textContent = 'v' + chrome.runtime.getManifest().version;

  $('open-folder').addEventListener('click', async () => {
    const res = await chrome.runtime.sendMessage({ type: 'openFolder' });
    // Nothing was opened: say where it is instead of leaving a dead button.
    if (res && res.ok && !res.opened && res.path) {
      setStatus('Saved at ' + res.path);
    }
  });

  $('update-action').addEventListener('click', async () => {
    if (updateAction === 'options') {
      chrome.runtime.openOptionsPage();
      return;
    }
    showUpdate('Checking…');
    renderUpdate(await chrome.runtime.sendMessage({ type: 'checkUpdate' }));
  });

  // Whatever the last check found, shown at once, then refreshed in the
  // background. Waiting on the network before saying anything makes the popup
  // look broken on a slow connection.
  const { updateInfo } = await chrome.storage.local.get('updateInfo');
  renderUpdate(updateInfo);
  chrome.runtime.sendMessage({ type: 'checkUpdate' }).then(renderUpdate).catch(() => {});

  $('settings').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });

  $('find').addEventListener('click', async () => {
    const want = readWant();
    if (!Object.values(want).some(Boolean)) {
      setStatus('Tick at least one thing to export.', 'error');
      return;
    }

    $('folder-note').hidden = true;
    setStatus('Starting…');
    $('find').hidden = true;
    $('stop').hidden = false;

    try {
      // Awaited, unlike the run itself: if the script cannot be got into the
      // page there is no point pretending a run started.
      await ensureContentScript(tab.id);

      // Fire and forget from here: the picker outlives this popup, which
      // closes as soon as the user clicks into the page. The worker keeps the
      // state. The rejection when the popup unloads is expected and ignored;
      // a real delivery failure would already have thrown above.
      chrome.tabs.sendMessage(tab.id, {
        type: 'find',
        pages: $('pages').value,
        style: $('style').value,
        pageDelayMs: settings?.pageDelayMs,
        want
      }).catch(() => {});
    } catch (err) {
      setStatus(
        'Could not start on this page: ' + (err?.message || err) +
        ' — try reloading the Shopee tab.',
        'error'
      );
      $('find').hidden = false;
      $('stop').hidden = true;
    }
  });

  $('stop').addEventListener('click', async () => {
    setStatus('Stopping…');
    chrome.tabs.sendMessage(tab.id, { type: 'stop' }).catch(() => {});
    await chrome.runtime.sendMessage({
      type: 'runFinished', phase: 'idle', message: 'Stopped.'
    });
    refresh();
  });

  await refresh();
  // The worker is the source of truth and the run happens elsewhere, so poll
  // while the popup happens to be open rather than pushing updates at a target
  // that usually does not exist.
  setInterval(refresh, 700);
});
