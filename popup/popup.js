/**
 * Popup panel.
 *
 * Holds no run state of its own. A Chrome popup is destroyed the moment it
 * loses focus, so anything it remembered would vanish mid-run; the service
 * worker owns the state and this asks for it on open.
 */
const $ = (id) => document.getElementById(id);

const PRODUCT_HOSTS = /(^|\.)shopee\.(com\.my|sg|ph|co\.th|co\.id)$/i;

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

function isProductPage(tab) {
  try {
    const url = new URL(tab.url);
    // The product page is the one carrying the i.SHOP.ITEM segment. Search
    // results and the shop page share the host but have no product to read.
    return PRODUCT_HOSTS.test(url.hostname) && /i\.\d+\.\d+/.test(url.pathname);
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
      setStatus('Page ' + (state.page || 0) + ' · ' + (state.found || 0) + ' files found');
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
    setStatus(bits.join(' · ') + '.', 'good');

    const note = describeFolderIssue(result.folderIssue);
    $('folder-note').hidden = !note;
    $('folder-note').textContent = note;
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
      // Fire and forget: the picker outlives this popup, which closes as soon
      // as the user clicks into the page. The worker keeps the state.
      chrome.tabs.sendMessage(tab.id, {
        type: 'find',
        pages: $('pages').value,
        style: $('style').value,
        pageDelayMs: settings?.pageDelayMs,
        want
      }).catch(() => {});
    } catch (err) {
      setStatus(err?.message || String(err), 'error');
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
