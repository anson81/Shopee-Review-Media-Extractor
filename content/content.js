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
    } else if (data.json) {
      captured.detail = data.json;
    }
  });

  /* ------------------------------------------------------------------ *
   * Identifying the product
   * ------------------------------------------------------------------ */

  /**
   * The URL is the reliable source. The embedded state is the fallback for
   * region URL forms that do not carry the i.SHOP.ITEM segment.
   */
  function productIds() {
    const fromUrl = Api.idsFromUrl(location.href);
    if (fromUrl) return fromUrl;

    try {
      const initial = window.__INITIAL_STATE__ || window.__NEXT_DATA__;
      const text = initial ? JSON.stringify(initial) : document.documentElement.innerHTML;
      const m = text.match(/"itemid"\s*:\s*(\d+)[\s\S]{0,200}?"shopid"\s*:\s*(\d+)/) ||
        text.match(/"shopid"\s*:\s*(\d+)[\s\S]{0,200}?"itemid"\s*:\s*(\d+)/);
      if (!m) return null;
      // The two patterns capture in opposite orders; disambiguate by which
      // matched rather than trusting position.
      return /"itemid"/.test(m[0].slice(0, 12))
        ? { itemid: m[1], shopid: m[2] }
        : { shopid: m[1], itemid: m[2] };
    } catch (_) {
      return null;
    }
  }

  function productName() {
    const heading = document.querySelector('h1, [class*="product-briefing"] span');
    const text = heading?.textContent?.trim();
    if (text) return text.slice(0, 120);
    return (document.title || 'product').split('|')[0].trim();
  }

  function shopName() {
    const node = document.querySelector('[class*="shop-name"], [class*="page-product__shop"] a');
    return node?.textContent?.trim()?.slice(0, 80) || 'shopee';
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

  function productMedia(detail, want, hostname) {
    const items = [];
    if (!detail) return items;

    const data = detail.data || detail;
    const item = data.item || data;

    if (want.mainImages && Array.isArray(item.images)) {
      item.images.forEach((hash, i) => {
        items.push({
          url: Api.imageUrl(hash, hostname), thumb: Api.imageUrl(hash, hostname),
          kind: 'image', source: 'main', mediaIndex: i + 1, label: 'main'
        });
      });
    }

    if (want.variantImages && Array.isArray(item.models)) {
      item.models.forEach((model, i) => {
        const hash = model && (model.image || model.extinfo?.tier_image);
        if (!hash) return;
        items.push({
          url: Api.imageUrl(hash, hostname), thumb: Api.imageUrl(hash, hostname),
          kind: 'image', source: 'variant', mediaIndex: i + 1,
          label: String(model.name || 'variant')
        });
      });
    }

    if (want.productVideos && Array.isArray(item.video_info_list)) {
      item.video_info_list.forEach((v, i) => {
        const url = v && (v.default_format?.url || v.url);
        items.push({
          url: url || '',
          thumb: v?.thumb_url ? Api.imageUrl(v.thumb_url, hostname) : '',
          kind: 'video', source: 'product-video', mediaIndex: i + 1,
          label: 'video', unavailable: !url
        });
      });
    }

    return items;
  }

  function descriptionParts(detail, want, hostname) {
    if (!want.description || !detail) return { text: '', images: [] };

    const data = detail.data || detail;
    const item = data.item || data;
    const text = String(item.description || '');
    const images = [];

    const rich = item.description_info?.rich_text_description?.paragraph_list;
    if (Array.isArray(rich)) {
      rich.forEach((p, i) => {
        if (!p || !p.image_id) return;
        images.push({
          url: Api.imageUrl(p.image_id, hostname),
          thumb: Api.imageUrl(p.image_id, hostname),
          kind: 'image', source: 'description', mediaIndex: i + 1, label: 'img'
        });
      });
    }

    return { text, images };
  }

  /* ------------------------------------------------------------------ *
   * The run
   * ------------------------------------------------------------------ */

  let stopped = false;

  function report(page, found, message) {
    chrome.runtime.sendMessage({ type: 'progress', page, found, message }).catch(() => {});
  }

  async function run(request) {
    stopped = false;

    const ids = productIds();
    if (!ids) {
      throw new Error('This does not look like a product page — open a product first.');
    }

    const want = request.want || {};
    const origin = location.origin;
    const hostname = location.hostname;

    let reviews = [];
    let usedFallback = false;

    if (want.reviewImages || want.reviewVideos) {
      const maxPages = Api.parsePageRange(request.pages);
      try {
        reviews = await Api.fetchReviews({
          origin, hostname, ids, maxPages,
          pageDelayMs: request.pageDelayMs,
          shouldStop: () => stopped,
          onPage: (page, batch) => {
            report(page, batch.length, 'Page ' + page + '…');
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
        detail = await Api.fetchJson(Api.detailUrl(origin, ids));
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

    const picked = await Picker.open(items, { style: request.style });
    if (!picked) return { cancelled: true };

    const reply = await chrome.runtime.sendMessage({
      type: 'export',
      payload: {
        items: picked.items,
        reviews,
        shopName: shopName(),
        productName: productName(),
        style: picked.style,
        description: desc.text
      }
    });

    return { ...reply, usedFallback };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
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
