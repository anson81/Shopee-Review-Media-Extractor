/**
 * Read-only probe for a Shopee PRODUCT page.
 *
 * Paste into DevTools Console (F12 -> Console) while a product page is open,
 * for example:
 *   https://shopee.com.my/Something-i.123456.7890123
 *
 * It answers the two things the extension currently guesses at:
 *
 *   1. How many reviews the ratings endpoint will actually serve per call.
 *      api.js pins PAGE_SIZE at 50 without ever having asked.
 *   2. Which product-detail endpoint answers, and what the fields are called.
 *      content.js reads item.images, item.models, item.video_info_list and
 *      item.description_info from memory of how Shopee used to look.
 *
 * It downloads nothing, clicks nothing and changes nothing. It makes about
 * five GET requests, the same ones the page makes for itself, and prints what
 * came back. Copy the final block and send it back.
 */
(async () => {
  'use strict';

  const out = { url: location.href, host: location.hostname, when: new Date().toISOString() };
  const log = (...a) => console.log('[probe]', ...a);

  const get = async (url) => {
    try {
      const res = await fetch(url, { credentials: 'include' });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch (_) { /* not json */ }
      return { ok: res.ok, status: res.status, json, sample: text.slice(0, 200) };
    } catch (err) {
      return { ok: false, status: 0, error: String(err && err.message || err) };
    }
  };

  /* ---- 1. identify the product -------------------------------------- */
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
  log('ids:', ids, 'from', out.idSource);

  if (!ids) {
    console.warn('[probe] No item/shop id found. Is this really a product page?');
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  /* ---- 2. how big a ratings page can we get? ------------------------ */
  const ratingsUrl = (limit, offset) =>
    `${location.origin}/api/v2/item/get_ratings?itemid=${ids.itemid}` +
    `&shopid=${ids.shopid}&type=0&filter=0&flag=1&limit=${limit}&offset=${offset || 0}`;

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
      // A server that silently caps the limit is the failure mode that would
      // make paging stop early, so the asked/got pair is the whole point.
      cappedAt: list && list.length < limit ? list.length : null,
      shape: r.json ? (r.json.data ? 'data.ratings' : (r.json.ratings ? 'ratings' : 'UNKNOWN')) : 'not json',
      sample: r.json ? undefined : r.sample
    };
    log(`ratings limit=${limit} -> ${list ? list.length : 'none'} (HTTP ${r.status})`);
    await new Promise((r2) => setTimeout(r2, 400));
  }

  /* ---- 3. what does one rating look like? --------------------------- */
  const probe = await get(ratingsUrl(50, 0));
  const list = readRatings(probe.json) || [];
  const withMedia = list.find((r) => (r.images || []).length || (r.videos || []).length) || list[0];

  if (withMedia) {
    out.ratingKeys = Object.keys(withMedia).sort();
    out.ratingSample = {
      hasComment: typeof withMedia.comment === 'string',
      rating_star: withMedia.rating_star,
      ctime: withMedia.ctime,
      author_username: withMedia.author_username,
      imagesCount: (withMedia.images || []).length,
      imagesLookLike: (withMedia.images || [])[0] || null,
      videosCount: (withMedia.videos || []).length,
      videoKeys: (withMedia.videos || [])[0] ? Object.keys(withMedia.videos[0]).sort() : [],
      videoSample: (withMedia.videos || [])[0] || null,
      product_items: (withMedia.product_items || [])[0] || null
    };
    log('one rating:', out.ratingSample);
  } else {
    out.ratingKeys = [];
    log('no ratings came back - try a product that has reviews');
  }

  /* ---- 4. which detail endpoint answers, and what are its fields? ---- */
  const candidates = [
    `${location.origin}/api/v4/pdp/get_pc?item_id=${ids.itemid}&shop_id=${ids.shopid}&detail_level=0`,
    `${location.origin}/api/v4/item/get?itemid=${ids.itemid}&shopid=${ids.shopid}`,
    `${location.origin}/api/v2/item/get?itemid=${ids.itemid}&shopid=${ids.shopid}`
  ];

  out.detail = [];
  for (const url of candidates) {
    const r = await get(url);
    const d = r.json ? (r.json.data || r.json) : null;
    const item = d ? (d.item || d) : null;

    out.detail.push({
      url: url.replace(location.origin, ''),
      httpStatus: r.status,
      topLevelKeys: r.json ? Object.keys(r.json).slice(0, 12) : null,
      itemKeys: item && typeof item === 'object' ? Object.keys(item).sort().slice(0, 60) : null,
      // These four are exactly what content.js reads today.
      images: item && Array.isArray(item.images) ? item.images.length : null,
      imagesLookLike: item && (item.images || [])[0] || null,
      models: item && Array.isArray(item.models) ? item.models.length : null,
      modelKeys: item && (item.models || [])[0] ? Object.keys(item.models[0]).sort() : null,
      video_info_list: item && Array.isArray(item.video_info_list) ? item.video_info_list.length : null,
      videoInfoKeys: item && (item.video_info_list || [])[0]
        ? Object.keys(item.video_info_list[0]).sort() : null,
      hasDescription: !!(item && item.description),
      hasDescriptionInfo: !!(item && item.description_info)
    });
    log('detail', url.replace(location.origin, ''), '-> HTTP', r.status);
    await new Promise((r2) => setTimeout(r2, 400));
  }

  /* ---- 5. page furniture the extension reads ------------------------ */
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

  console.log('%c---- copy everything below this line ----', 'color:#ee4d2d;font-weight:bold');
  console.log(JSON.stringify(out, null, 2));
})();
