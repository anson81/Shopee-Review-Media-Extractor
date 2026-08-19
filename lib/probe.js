/**
 * The live-page probe, as an injectable function.
 *
 * This answers the questions api.js and content.js currently guess at: how
 * many reviews the ratings endpoint really serves per call, which product
 * detail endpoint answers, and what its fields are called.
 *
 * It is written as ONE self-contained function with no outside references,
 * because chrome.scripting.executeScript serialises the function source and
 * runs it in the page — anything it closed over here would be undefined there.
 *
 * It is read-only: about five GETs, the same ones the page makes for itself.
 * Nothing is clicked, nothing is downloaded, nothing on the page changes.
 */
(function (root, factory) {
  root.SRME_Probe = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = root.SRME_Probe;
})(typeof globalThis !== 'undefined' ? globalThis : self, function () {
  'use strict';

  async function srmeProbe() {
    const out = { url: location.href, host: location.hostname, world: 'unknown' };

    // Which JavaScript world is this running in? An isolated-world fetch is
    // routed through the extension's CORS identity since Chrome 85 — cookies
    // go, but the request does not look like the page asking for its own
    // data. That is the leading suspect for the 403s, so the answer has to be
    // recorded rather than assumed.
    try {
      out.world = (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id)
        ? 'isolated (extension)'
        : 'main (page)';
    } catch (_) {
      out.world = 'main (page)';
    }

    /* ---- capture Shopee's OWN request, headers and all ---------------- */
    // Whatever the page sends and gets a 200 for is the exact recipe. This
    // beats guessing at headers one release at a time.
    const seen = [];
    const WATCH = /get_ratings|pdp\/get_pc|item\/get/i;

    try {
      const origFetch = window.fetch;
      window.fetch = function (input, init) {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        const p = origFetch.apply(this, arguments);
        if (WATCH.test(url)) {
          const headers = {};
          try {
            const h = (init && init.headers) || (input && input.headers);
            if (h) {
              if (typeof h.forEach === 'function') h.forEach((v, k) => { headers[k] = v; });
              else Object.assign(headers, h);
            }
          } catch (_) { /* ignore */ }

          p.then((res) => {
            seen.push({
              url: String(url).slice(0, 200),
              status: res.status,
              via: 'fetch',
              headers,
              credentials: (init && init.credentials) || 'default'
            });
          }).catch(() => {});
        }
        return p;
      };

      const origOpen = XMLHttpRequest.prototype.open;
      const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
      const origSend = XMLHttpRequest.prototype.send;

      XMLHttpRequest.prototype.open = function (method, url) {
        this.__srmeUrl = url;
        this.__srmeHeaders = {};
        return origOpen.apply(this, arguments);
      };
      XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
        if (this.__srmeHeaders) this.__srmeHeaders[k] = v;
        return origSetHeader.apply(this, arguments);
      };
      XMLHttpRequest.prototype.send = function () {
        const url = this.__srmeUrl || '';
        if (WATCH.test(url)) {
          this.addEventListener('load', () => {
            seen.push({
              url: String(url).slice(0, 200),
              status: this.status,
              via: 'xhr',
              headers: this.__srmeHeaders || {}
            });
          });
        }
        return origSend.apply(this, arguments);
      };
    } catch (_) {
      /* hooking is a bonus, not a requirement */
    }

    const get = async (url, headers) => {
      try {
        const res = await fetch(url, {
          credentials: 'include',
          headers: headers || undefined
        });
        const text = await res.text();
        let json = null;
        try { json = JSON.parse(text); } catch (_) { /* not json */ }
        return { ok: res.ok, status: res.status, json, sample: text.slice(0, 160) };
      } catch (err) {
        return { ok: false, status: 0, error: String((err && err.message) || err) };
      }
    };

    const nap = (ms) => new Promise((r) => setTimeout(r, ms));

    /* 1. identify the product — both URL forms Shopee serves */
    const dotted = location.href.match(/i\.(\d+)\.(\d+)/);
    const pathForm = location.href.match(/\/product\/(\d+)\/(\d+)/);
    const m = dotted || pathForm;
    let ids = m ? { shopid: m[1], itemid: m[2] } : null;

    if (!ids) {
      const canonical = document.querySelector('link[rel="canonical"]')?.href || '';
      const c = canonical.match(/i\.(\d+)\.(\d+)/) ||
        canonical.match(/\/product\/(\d+)\/(\d+)/);
      if (c) ids = { shopid: c[1], itemid: c[2] };
    }

    out.ids = ids;
    out.idSource = dotted ? 'url (i.SHOP.ITEM)'
      : pathForm ? 'url (/product/SHOP/ITEM)'
        : (ids ? 'canonical link' : 'NOT FOUND');
    if (!ids) {
      out.problem = 'No item/shop id found - is this really a product page?';
      return out;
    }

    /* 2. how big a ratings page can we actually get? */
    const ratingsUrl = (limit, offset) =>
      location.origin + '/api/v2/item/get_ratings?itemid=' + ids.itemid +
      '&shopid=' + ids.shopid + '&type=0&filter=0&flag=1&limit=' + limit +
      '&offset=' + (offset || 0);

    const readRatings = (json) => {
      if (!json) return null;
      const d = json.data && typeof json.data === 'object' ? json.data : json;
      return Array.isArray(d.ratings) ? d.ratings : null;
    };

    // Everything came back 403 last time, so the question is no longer "how
    // many per page" but "what does it take to get a 200 at all". Each
    // variant changes one thing.
    const VARIANTS = [
      { name: 'plain', headers: null },
      {
        name: 'with shopee client headers',
        headers: {
          'x-api-source': 'pc',
          'x-shopee-language': 'en',
          'x-requested-with': 'XMLHttpRequest'
        }
      },
      {
        name: 'with client headers and referer-ish hints',
        headers: {
          'x-api-source': 'pc',
          'x-shopee-language': 'en',
          'x-requested-with': 'XMLHttpRequest',
          'af-ac-enc-dat': '',
          'accept': 'application/json'
        }
      }
    ];

    out.ratings = {};
    for (const variant of VARIANTS) {
      const r = await get(ratingsUrl(50, 0), variant.headers);
      const list = readRatings(r.json);
      out.ratings[variant.name] = {
        httpStatus: r.status,
        got: list ? list.length : null,
        shape: r.json ? (r.json.data ? 'data.ratings' : (r.json.ratings ? 'ratings' : 'UNKNOWN')) : 'not json',
        error: r.json && r.json.error !== undefined ? r.json.error : undefined,
        isLogin: r.json && r.json.is_login,
        note: r.json ? undefined : r.sample
      };
      await nap(400);
    }

    // Only worth asking if something got through.
    const working = Object.values(out.ratings).find((v) => v.got != null);
    if (working) {
      out.pageSize = {};
      for (const limit of [6, 50, 100]) {
        const r = await get(ratingsUrl(limit, 0));
        const list = readRatings(r.json);
        out.pageSize['limit_' + limit] = {
          asked: limit,
          got: list ? list.length : null,
          cappedAt: list && list.length < limit ? list.length : null
        };
        await nap(400);
      }
    }

    /* 3. what does one rating look like? */
    const probeRes = await get(ratingsUrl(50, 0));
    const list = readRatings(probeRes.json) || [];
    const withMedia = list.find((r) => (r.images || []).length || (r.videos || []).length) || list[0];

    if (withMedia) {
      out.ratingKeys = Object.keys(withMedia).sort();
      out.ratingSample = {
        rating_star: withMedia.rating_star,
        ctime: withMedia.ctime,
        author_username: withMedia.author_username,
        hasComment: typeof withMedia.comment === 'string',
        imagesCount: (withMedia.images || []).length,
        imagesLookLike: (withMedia.images || [])[0] || null,
        videosCount: (withMedia.videos || []).length,
        videoKeys: (withMedia.videos || [])[0] ? Object.keys(withMedia.videos[0]).sort() : [],
        videoSample: (withMedia.videos || [])[0] || null,
        product_items: (withMedia.product_items || [])[0] || null
      };
    } else {
      out.ratingKeys = [];
      out.ratingSample = null;
      out.note = 'No ratings came back - try a product that has reviews.';
    }

    /* 4. which detail endpoint answers, and what are its fields called? */
    const candidates = [
      location.origin + '/api/v4/pdp/get_pc?item_id=' + ids.itemid + '&shop_id=' + ids.shopid + '&detail_level=0',
      location.origin + '/api/v4/item/get?itemid=' + ids.itemid + '&shopid=' + ids.shopid,
      location.origin + '/api/v2/item/get?itemid=' + ids.itemid + '&shopid=' + ids.shopid
    ];

    out.detail = [];
    let bestItem = null;

    for (const url of candidates) {
      const r = await get(url);
      const d = r.json ? (r.json.data || r.json) : null;
      const item = d ? (d.item || d) : null;
      if (item && Array.isArray(item.images) && item.images.length) bestItem = item;

      out.detail.push({
        path: url.replace(location.origin, '').split('?')[0],
        httpStatus: r.status,
        topLevelKeys: r.json ? Object.keys(r.json).slice(0, 12) : null,
        itemKeys: item && typeof item === 'object' ? Object.keys(item).sort().slice(0, 60) : null,
        // These four are exactly what content.js reads today.
        images: item && Array.isArray(item.images) ? item.images.length : null,
        imagesLookLike: (item && (item.images || [])[0]) || null,
        models: item && Array.isArray(item.models) ? item.models.length : null,
        modelKeys: item && (item.models || [])[0] ? Object.keys(item.models[0]).sort() : null,
        video_info_list: item && Array.isArray(item.video_info_list) ? item.video_info_list.length : null,
        videoInfoKeys: item && (item.video_info_list || [])[0]
          ? Object.keys(item.video_info_list[0]).sort() : null,
        hasDescription: !!(item && item.description),
        hasDescriptionInfo: !!(item && item.description_info)
      });
      await nap(400);
    }

    /* 4a. how does a bare CDN hash become a URL? */
    //
    // Not a guess this time. Review images arrive as bare hashes, and there
    // are two plausible shapes in the wild — Shopee's own video cover came
    // back as down-tx-my.../<hash>_cover with NO /file/ segment, while the
    // documented image form has one. Rather than pick, both are fetched and
    // the status recorded. A no-cors request cannot report status, so this
    // uses an <img> load, which succeeds or fails honestly.
    const sampleHash = (withMedia && (withMedia.images || [])[0]) ||
      (bestItem && (bestItem.images || [])[0]) || null;

    out.imageUrlForms = { sampleHash, tried: [] };

    if (sampleHash) {
      const region = (location.hostname.match(/shopee\.(?:com\.)?(\w\w)$/) || [])[1] || 'my';
      const forms = [
        'https://down-' + region + '.img.susercontent.com/file/' + sampleHash,
        'https://down-' + region + '.img.susercontent.com/' + sampleHash,
        'https://down-tx-' + region + '.img.susercontent.com/file/' + sampleHash,
        'https://cf.shopee.com.my/file/' + sampleHash
      ];

      for (const url of forms) {
        const loaded = await new Promise((resolve) => {
          const img = new Image();
          const done = (v) => resolve(v);
          img.onload = () => done({ ok: true, w: img.naturalWidth, h: img.naturalHeight });
          img.onerror = () => done({ ok: false });
          img.referrerPolicy = 'no-referrer';
          img.src = url;
          setTimeout(() => done({ ok: false, timedOut: true }), 8000);
        });
        out.imageUrlForms.tried.push({ url, ...loaded });
      }
    }

    /* 4c. the fields the extension now reads, present or not? */
    out.itemShape = bestItem ? {
      images: Array.isArray(bestItem.images) ? bestItem.images.length : null,
      tier_variations: Array.isArray(bestItem.tier_variations)
        ? bestItem.tier_variations.map((t) => ({
          name: t && t.name,
          options: Array.isArray(t && t.options) ? t.options.length : null,
          images: Array.isArray(t && t.images) ? t.images.length : null
        }))
        : null,
      video_info_list: Array.isArray(bestItem.video_info_list)
        ? bestItem.video_info_list.length : null,
      videoInfoKeys: bestItem.video_info_list && bestItem.video_info_list[0]
        ? Object.keys(bestItem.video_info_list[0]).sort() : null,
      descriptionLength: typeof bestItem.description === 'string'
        ? bestItem.description.length : null,
      // The zip is named after the shop and the page selectors found nothing,
      // so the payload is the next place to look.
      shopNameFields: Object.keys(bestItem)
        .filter((k) => /shop.*name|name.*shop/i.test(k))
        .reduce((acc, k) => { acc[k] = bestItem[k]; return acc; }, {})
    } : null;

    /* 4b. what does the PAGE itself send? */
    //
    // The decisive question. If Shopee's own request succeeds while ours is
    // refused, the difference between them is the whole answer — and it is
    // sitting in these headers.
    out.waitedForPageRequests = true;
    for (let i = 0; i < 30 && seen.length === 0; i++) await nap(1000);

    out.pageRequests = seen.slice(0, 6);
    out.pageRequestCount = seen.length;

    /* 5. page furniture the extension reads for names */
    const pick = (sel) => {
      const n = document.querySelector(sel);
      return n ? (n.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 90) : null;
    };
    out.page = {
      h1: pick('h1'),
      productBriefing: pick('[class*="product-briefing"] span'),
      shopName: pick('[class*="shop-name"]'),
      shopLink: pick('[class*="page-product__shop"] a'),
      title: document.title.slice(0, 90)
    };

    return out;
  }

  return { run: srmeProbe };
});
