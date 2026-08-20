/**
 * ISOLATED-world content script: runs one extraction, start to finish.
 *
 * It lives in the page so its fetches carry the site's session cookies —
 * the ratings endpoint answers a logged-out request differently, and from the
 * service worker there is no session at all.
 *
 * Load order matters and is fixed in the manifest: naming.js, api.js,
 * picker.js, then this.
 */
(() => {
  'use strict';

  if (window.__srmeContentLoaded) return;
  window.__srmeContentLoaded = true;

  const Api = window.SRME_Api;
  const Picker = window.SRME_Picker;

  const TAG = '__SRME__';

  /* ------------------------------------------------------------------ *
   * Whatever the interceptor manages to catch.
   *
   * Only consulted when the direct call fails, so on a normal run this is
   * collected and never read. That is the intended outcome.
   * ------------------------------------------------------------------ */
  const captured = { ratings: [], detail: null };

  window.addEventListener('message', (event) => {
    // Same-window messages only. Any frame can postMessage into this page.
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data[TAG] !== true || data.kind !== 'api') return;

    if (/get_ratings/i.test(data.url)) {
      const list = Api.readRatings(data.json);
      if (list.length) captured.ratings.push(...list);
      return;
    }

    if (!data.json) return;

    // Only keep a detail payload that is about THIS product. The watch list
    // also matches recommendation and related-item calls, and last-writer-wins
    // meant the fallback could be holding a different product's payload — the
    // silent kind of wrong, where the export looks fine and is not.
    const ids = productIds();
    if (ids && String(data.url).indexOf(String(ids.itemid)) === -1) return;
    captured.detail = data.json;
  });

  // Tells interceptor.js it may start posting. It runs at document_start and
  // this listener is installed at document_idle, so without this handshake
  // everything the page loaded for itself in between was posted into a void.
  try {
    window.postMessage({ [TAG]: true, kind: 'ready' }, location.origin);
  } catch (_) {
    /* the fallback is a bonus, never a requirement */
  }

  /* ------------------------------------------------------------------ *
   * Fetching through the page
   *
   * A fetch from here is routed through the extension's CORS identity, and
   * Shopee refuses those: measured on a live page, the identical request got
   * 403 from this world and 200 from the page's. So the request is handed to
   * interceptor.js, which lives in the page's own context, and the answer
   * comes back by postMessage.
   *
   * Shaped like fetch() so api.js can take it as fetchImpl and know nothing
   * about any of this.
   * ------------------------------------------------------------------ */
  let requestSeq = 0;
  const pending = new Map();
  const PAGE_FETCH_TIMEOUT_MS = 30000;

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const d = event.data;
    if (!d || d[TAG] !== true || d.kind !== 'response') return;

    const waiting = pending.get(d.id);
    if (!waiting) return;
    pending.delete(d.id);
    clearTimeout(waiting.timer);
    waiting.resolve({
      ok: d.ok,
      status: d.status,
      json: async () => d.json,
      error: d.error
    });
  });

  function pageFetch(url) {
    return new Promise((resolve, reject) => {
      const id = ++requestSeq;
      const timer = setTimeout(() => {
        pending.delete(id);
        // Almost always means interceptor.js is not in the page — a tab that
        // predates the extension, or a failed injection. Worth saying so
        // rather than reporting it as a Shopee problem.
        reject(new Error(
          'The page did not answer. Reload the Shopee tab and try again.'
        ));
      }, PAGE_FETCH_TIMEOUT_MS);

      pending.set(id, { resolve, reject, timer });
      window.postMessage({ [TAG]: true, kind: 'request', id, url }, location.origin);
    });
  }

  /* ------------------------------------------------------------------ *
   * Identifying the product
   * ------------------------------------------------------------------ */

  /**
   * Identify the product being viewed.
   *
   * THE ORDER MATTERS, and the thing that is NOT here matters more.
   *
   * This used to fall back to scanning document.documentElement.innerHTML for
   * the first "itemid" it could find. A Shopee product page embeds "You may
   * also like" and "Similar products" carousels, each carrying its own
   * itemid/shopid — and .match() returns the first hit in the document, not
   * the relevant one. So on any page where the URL did not carry the ids, the
   * extension could export a DIFFERENT product's reviews into a folder named
   * after this one, with no error anywhere. Nothing downstream could detect
   * it, because every id was internally consistent.
   *
   * Every source below names the page's OWN product and nothing else.
   */
  function productIds() {
    // 1. The address bar.
    const fromUrl = Api.idsFromUrl(location.href);
    if (fromUrl) return fromUrl;

    // 2. The canonical link and og:url. Both are the page declaring which
    //    product it is, in the same i.SHOP.ITEM form.
    const declared = [
      document.querySelector('link[rel="canonical"]')?.href,
      document.querySelector('meta[property="og:url"]')?.content
    ];
    for (const href of declared) {
      const ids = href && Api.idsFromUrl(href);
      if (ids) return ids;
    }

    // 3. The page's own initial state, read as structured data rather than as
    //    text, so a carousel entry cannot be mistaken for the product.
    try {
      const state = window.__INITIAL_STATE__;
      const item = state && (state.item || (state.pdp && state.pdp.item));
      if (item && item.itemid && item.shopid) {
        return { itemid: String(item.itemid), shopid: String(item.shopid) };
      }
    } catch (_) {
      /* fall through */
    }

    return null;
  }

  /**
   * Text that is on the page but is not the product.
   *
   * A live export was named "shopee_Verify-to-Continue.zip": the tab was
   * logged out, Shopee had put a verification prompt in the first h1, and the
   * archive was named after it. Reading the first heading on the page trusts
   * whatever Shopee happens to be showing, which on a bad day is a login wall.
   */
  const NOT_A_PRODUCT =
    /verify|continue|log ?in|sign ?up|sign ?in|captcha|error|not found|loading/i;

  function productName() {
    // og:title is what Shopee publishes as the product's name for sharing.
    // It is not affected by anything overlaying the page.
    const og = document.querySelector('meta[property="og:title"]')?.content?.trim();
    if (og && !NOT_A_PRODUCT.test(og)) return og.slice(0, 120);

    // Then the visible heading, but only if it looks like a product.
    for (const node of document.querySelectorAll('h1, [class*="product-briefing"] span')) {
      const text = node.textContent?.trim();
      if (text && text.length > 3 && !NOT_A_PRODUCT.test(text)) return text.slice(0, 120);
    }

    const title = (document.title || '').split('|')[0].trim();
    if (title && !NOT_A_PRODUCT.test(title)) return title.slice(0, 120);

    // Better a name that admits it is unknown than one that is confidently
    // wrong — the ids at least identify the product later.
    const ids = productIds();
    return ids ? 'product-' + ids.itemid : 'product';
  }

  function shopName() {
    for (const sel of ['[class*="shop-name"]', '[class*="page-product__shop"] a']) {
      const text = document.querySelector(sel)?.textContent?.trim();
      if (text && !NOT_A_PRODUCT.test(text)) return text.slice(0, 80);
    }
    return 'shopee';
  }

  /* ------------------------------------------------------------------ *
   * Turning reviews and product detail into a flat media list
   * ------------------------------------------------------------------ */

  function reviewMedia(reviews, want) {
    const items = [];

    for (const r of reviews) {
      if (want.reviewImages) {
        r.images.forEach((url, i) => {
          items.push({
            url, thumb: url, kind: 'image', source: 'review',
            page: r.page, reviewIndex: r.reviewIndex, mediaIndex: i + 1,
            ctime: r.ctime, buyer: r.buyer
          });
        });
      }

      if (want.reviewVideos) {
        r.videos.forEach((v, i) => {
          items.push({
            url: v.url,
            thumb: v.cover || '',
            kind: 'video',
            source: 'review',
            page: r.page, reviewIndex: r.reviewIndex, mediaIndex: i + 1,
            ctime: r.ctime, buyer: r.buyer,
            // Shopee sometimes serves a video only as segments. Listed as
            // unavailable rather than dropped, so the count the user sees
            // matches what is actually there.
            unavailable: !v.url
          });
        });
      }
    }

    return items;
  }

  /**
   * Product content out of an /api/v4/item/get payload.
   *
   * Field names here were measured, not remembered. The previous version read
   * a shape that does not exist on this endpoint, so every box under "Product
   * content" would have returned nothing at all with no error.
   */
  function productMedia(detail, want, hostname) {
    const items = [];
    const item = Api.readItem(detail);
    if (!item) return items;

    // item.images is an array of bare CDN hashes. `item.image` is the single
    // cover and is usually images[0], so it is only used if images is absent.
    if (want.mainImages) {
      const main = Array.isArray(item.images) && item.images.length
        ? item.images
        : (item.image ? [item.image] : []);
      main.forEach((hash, i) => {
        items.push({
          url: Api.imageUrl(hash, hostname), thumb: Api.imageUrl(hash, hostname),
          kind: 'image', source: 'main', mediaIndex: i + 1, label: 'main'
        });
      });
    }

    // Variant pictures live on tier_variations, NOT on models. The models
    // array carries prices and stock and has no image field at all — reading
    // it was why variant images came back empty. Each tier_variation has
    // options[] and a parallel images[]; only the tier with pictures has any.
    if (want.variantImages && Array.isArray(item.tier_variations)) {
      let n = 0;
      item.tier_variations.forEach((tier) => {
        if (!tier || !Array.isArray(tier.images)) return;
        tier.images.forEach((hash, idx) => {
          if (!hash) return;
          n += 1;
          const option = Array.isArray(tier.options) ? tier.options[idx] : null;
          items.push({
            url: Api.imageUrl(hash, hostname), thumb: Api.imageUrl(hash, hostname),
            kind: 'image', source: 'variant', mediaIndex: n,
            label: String(option || tier.name || 'variant')
          });
        });
      });
    }

    if (want.productVideos && Array.isArray(item.video_info_list)) {
      item.video_info_list.forEach((v, i) => {
        const url = v && (v.default_format?.url || v.url);
        const cover = v && (v.thumb_url || v.cover);
        items.push({
          url: url || '',
          thumb: cover ? Api.imageUrl(cover, hostname) : '',
          kind: 'video', source: 'product-video', mediaIndex: i + 1,
          label: 'video', unavailable: !url
        });
      });
    }

    return items;
  }

  /**
   * Description text, and any pictures embedded in it.
   *
   * item/get returns the description as PLAIN TEXT in `item.description`;
   * there is no description_info on it, which is what the old rich-text
   * reader expected. Images are pulled out of the text instead — sellers
   * routinely paste CDN links into it — and the whole section degrades to
   * "text only" rather than to nothing.
   */
  function descriptionParts(detail, want, hostname) {
    if (!want.description) return { text: '', images: [] };

    const item = Api.readItem(detail);
    if (!item) return { text: '', images: [] };

    const text = String(item.description || '');
    const images = [];
    const seen = new Set();

    // Full URLs first, then bare hashes on their own line. Both appear.
    const urls = text.match(/https?:\/\/[^\s"'<>)]+\.(?:jpe?g|png|webp|gif)/gi) || [];
    for (const url of urls) {
      if (seen.has(url)) continue;
      seen.add(url);
      images.push({
        url, thumb: url, kind: 'image', source: 'description',
        mediaIndex: images.length + 1, label: 'img'
      });
    }

    return { text, images };
  }

  /* ------------------------------------------------------------------ *
   * The run
   * ------------------------------------------------------------------ */

  let stopped = false;
  /** One run at a time. A second Find while the picker is up orphaned it. */
  let running = false;

  /**
   * Is this content script still attached to a live extension?
   *
   * Reloading the extension does NOT remove the content script already running
   * in an open page. It keeps running, orphaned, and every chrome.* call it
   * makes throws "Extension context invalidated" — which showed up as an
   * uncaught error on the Errors page with no explanation of what to do.
   *
   * It is not really a fault, it is the cost of reloading during development,
   * but an error with no cause and no remedy is worse than the reload itself.
   */
  function contextAlive() {
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch (_) {
      return false;
    }
  }

  const RELOADED =
    'The extension was updated or reloaded. Reload this Shopee page and try again.';

  /** sendMessage that turns an orphaned context into a sentence worth reading. */
  async function send(msg) {
    if (!contextAlive()) throw new Error(RELOADED);
    try {
      return await chrome.runtime.sendMessage(msg);
    } catch (err) {
      const text = String(err?.message || err);
      if (/context invalidated|Receiving end does not exist/i.test(text)) {
        throw new Error(RELOADED);
      }
      throw err;
    }
  }

  function report(fields) {
    if (!contextAlive()) return;
    chrome.runtime.sendMessage(Object.assign({ type: 'progress' }, fields))
      .catch(() => {});
  }

  async function run(request) {
    if (running) {
      throw new Error('A run is already going on this page. Stop it first.');
    }
    running = true;
    stopped = false;

    try {
      return await doRun(request);
    } finally {
      running = false;
    }
  }

  async function doRun(request) {
    const ids = productIds();
    if (!ids) {
      throw new Error('This does not look like a product page — open a product first.');
    }

    const want = request.want || {};
    const origin = location.origin;
    const hostname = location.hostname;

    let reviews = [];
    let usedFallback = false;

    // Told to the worker up front, so the popup shows a run in progress from
    // the first moment rather than 700ms later — and so a product-content-only
    // run, which never reaches onPage, is not reported as idle throughout.
    report({ phase: 'finding', page: 0, found: 0, message: 'Starting…' });

    if (want.reviewImages || want.reviewVideos) {
      const range = Api.parsePageRange(request.pages);
      try {
        reviews = await Api.fetchReviews({
          origin, hostname, ids,
          fromPage: range.from,
          toPage: range.to,
          pageDelayMs: request.pageDelayMs,
          fetchImpl: pageFetch,
          shouldStop: () => stopped,
          onPage: (page, batch, total) => {
            // `total` is the running count, not this page's. Reporting
            // batch.length made the popup read the same number every page.
            report({
              phase: 'finding',
              page,
              found: total,
              totalPages: range.to,
              message: 'Page ' + page + (range.to ? ' of ' + range.to : '') + '…'
            });
          }
        });
      } catch (err) {
        // The endpoint moved or refused us. Whatever the page loaded for
        // itself is still worth offering, clearly labelled as less.
        if (captured.ratings.length === 0) throw err;
        usedFallback = true;
        reviews = captured.ratings.map((raw, i) =>
          Api.normaliseRating(raw, 1, i, hostname));
      }
    }

    let detail = null;
    const wantsProduct = want.mainImages || want.variantImages ||
      want.productVideos || want.description;

    if (wantsProduct) {
      try {
        detail = await Api.fetchJson(Api.detailUrl(origin, ids), { fetchImpl: pageFetch });
      } catch (_) {
        detail = captured.detail;
      }
    }

    const desc = descriptionParts(detail, want, hostname);
    const items = [
      ...reviewMedia(reviews, want),
      ...productMedia(detail, want, hostname),
      ...desc.images
    ];

    if (stopped) return { stopped: true };

    if (items.length === 0) {
      // Nothing to choose from, so do not make the user dismiss a modal to
      // be told so. The message goes where they are already looking.
      report({ phase: 'idle', message: 'No media found for this product.' });
      return { ok: true, empty: true, usedFallback };
    }

    report({ phase: 'choosing', found: items.length, message: 'Waiting for you to choose…' });

    const picked = await Picker.open(items, { style: request.style });
    if (!picked) return { cancelled: true };

    const reply = await send({
      type: 'export',
      payload: {
        items: picked.items,
        reviews,
        shopName: shopName(),
        productName: productName(),
        style: picked.style,
        description: desc.text,
        // Carried into the run result so the popup can say the results came
        // from the fallback. It used to be returned only to the popup's
        // discarded sendResponse, so a degraded export was indistinguishable
        // from a complete one.
        usedFallback
      }
    });

    return { ...reply, usedFallback };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    // The popup asks this before every run to find out whether this page
    // already has the script in it, or needs it injected.
    if (msg?.type === 'ping') {
      sendResponse({ ok: true });
      return undefined;
    }

    if (msg?.type === 'stop') {
      stopped = true;
      Picker.close();
      sendResponse({ ok: true });
      return undefined;
    }

    if (msg?.type !== 'find') return undefined;

    run(msg)
      .then((result) => {
        chrome.runtime.sendMessage({
          type: 'runFinished',
          phase: result?.ok === false ? 'error' : 'idle',
          message: result?.error || ''
        }).catch(() => {});
        sendResponse(result);
      })
      .catch((err) => {
        chrome.runtime.sendMessage({
          type: 'runFinished', phase: 'error', message: err?.message || String(err)
        }).catch(() => {});
        sendResponse({ ok: false, error: err?.message || String(err) });
      });

    return true;
  });
})();
