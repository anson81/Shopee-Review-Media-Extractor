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
    const out = { url: location.href, host: location.hostname };

    const get = async (url) => {
      try {
        const res = await fetch(url, { credentials: 'include' });
        const text = await res.text();
        let json = null;
        try { json = JSON.parse(text); } catch (_) { /* not json */ }
        return { ok: res.ok, status: res.status, json, sample: text.slice(0, 160) };
      } catch (err) {
        return { ok: false, status: 0, error: String((err && err.message) || err) };
      }
    };

    const nap = (ms) => new Promise((r) => setTimeout(r, ms));

    /* 1. identify the product */
    const m = location.href.match(/i\.(\d+)\.(\d+)/);
    let ids = m ? { shopid: m[1], itemid: m[2] } : null;

    if (!ids) {
      const html = document.documentElement.innerHTML;
      const a = html.match(/"itemid"\s*:\s*(\d+)/);
      const b = html.match(/"shopid"\s*:\s*(\d+)/);
      if (a && b) ids = { itemid: a[1], shopid: b[1] };
    }

    out.ids = ids;
    out.idSource = m ? 'url' : (ids ? 'embedded state' : 'NOT FOUND');
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

    out.ratings = {};
    for (const limit of [6, 50, 100]) {
      const r = await get(ratingsUrl(limit, 0));
      const list = readRatings(r.json);
      out.ratings['limit_' + limit] = {
        httpStatus: r.status,
        asked: limit,
        got: list ? list.length : null,
        // A server that silently caps the limit is what would make paging
        // stop early and lose the tail of a run, so asked-vs-got is the point.
        cappedAt: list && list.length < limit ? list.length : null,
        shape: r.json ? (r.json.data ? 'data.ratings' : (r.json.ratings ? 'ratings' : 'UNKNOWN')) : 'not json',
        note: r.json ? undefined : r.sample
      };
      await nap(400);
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
    for (const url of candidates) {
      const r = await get(url);
      const d = r.json ? (r.json.data || r.json) : null;
      const item = d ? (d.item || d) : null;

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
