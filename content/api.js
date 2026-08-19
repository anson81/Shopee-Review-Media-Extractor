/**
 * Everything this extension knows about Shopee's endpoints.
 *
 * Kept in one file on purpose. Shopee changes these without warning, and when
 * it does the fix should be one file to read and one file to edit — not a
 * hunt through the orchestration code.
 *
 * Loaded as a content script (page origin, so session cookies are sent) and
 * via require() in the node tests. It performs no DOM work and holds no state.
 */
(function (root, factory) {
  const api = factory();
  root.SRME_Api = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : self, function () {
  'use strict';

  /**
   * Reviews requested per call.
   *
   * CONFIRMED ON A LIVE PAGE (shopee.com.my, 19 Aug 2026): limit=6 returns 6,
   * limit=50 returns 50, and limit=100 returns HTTP 200 with no ratings array
   * at all. So 50 is the real ceiling and asking for more yields nothing
   * rather than less — which readRatings would have read as "no more
   * reviews", quietly ending every run after one page.
   */
  const PAGE_SIZE = 50;

  /** Ratings endpoint, relative to the site origin. */
  const RATINGS_PATH = '/api/v2/item/get_ratings';

  /**
   * Product detail, for main images, variants, video and description.
   *
   * /api/v4/item/get, not /api/v4/pdp/get_pc. Both answer 200, and get_pc
   * looked like the natural choice — but measured on a live product it has no
   * `images` array at all, only a single `image`, and no video_info_list.
   * item/get carries images, video_info_list and the models. /api/v2/item/get
   * is a 404.
   */
  const DETAIL_PATH = '/api/v4/item/get';

  const DEFAULT_PAGE_DELAY_MS = 300;
  const MAX_RETRIES = 4;

  /**
   * itemid and shopid out of a product URL. Shopee serves TWO forms and both
   * are ordinary — this is not a region quirk, the same shop hands out both:
   *
   *   https://shopee.com.my/Some-Product-i.123456.7890123
   *   https://shopee.com.my/product/123456/7890123/
   *
   * Only the first was handled, so on a /product/ URL the extension decided
   * it was not on a product page at all and the Find button stayed dead.
   * Both put shopid first.
   */
  function idsFromUrl(href) {
    const s = String(href || '');

    const dotted = s.match(/i\.(\d+)\.(\d+)/);
    if (dotted) return { shopid: dotted[1], itemid: dotted[2] };

    const pathForm = s.match(/\/product\/(\d+)\/(\d+)/);
    if (pathForm) return { shopid: pathForm[1], itemid: pathForm[2] };

    return null;
  }

  /** Does this URL name a product at all? Used to enable the popup's button. */
  function isProductUrl(href) {
    return idsFromUrl(href) !== null;
  }

  /**
   * Review image hashes resolve against a REGION CDN host, and the region is
   * the page's own. Hard-coding down-my would silently break Singapore and
   * Thailand, so it is derived instead.
   *
   *   shopee.com.my -> down-my.img.susercontent.com
   *   shopee.sg     -> down-sg.img.susercontent.com
   */
  const REGION_BY_HOST = {
    'shopee.com.my': 'my',
    'shopee.sg': 'sg',
    'shopee.ph': 'ph',
    'shopee.co.th': 'th',
    'shopee.co.id': 'id'
  };

  function regionFor(hostname) {
    const host = String(hostname || '').replace(/^www\./, '');
    if (REGION_BY_HOST[host]) return REGION_BY_HOST[host];
    // A subdomain such as seller.shopee.com.my still tells us the region.
    const hit = Object.keys(REGION_BY_HOST).find((h) => host.endsWith(h));
    return hit ? REGION_BY_HOST[hit] : 'my';
  }

  function cdnBase(hostname) {
    return 'https://down-' + regionFor(hostname) + '.img.susercontent.com/file/';
  }

  /**
   * A CDN hash to a full URL. Shopee stores review images as bare hashes, and
   * occasionally as a full URL already — passing one of those through the
   * hash path would produce a doubled prefix.
   */
  function imageUrl(hashOrUrl, hostname) {
    const s = String(hashOrUrl || '');
    if (/^https?:\/\//i.test(s)) return s;
    return cdnBase(hostname) + s;
  }

  function ratingsUrl(origin, ids, offset, limit) {
    const params = new URLSearchParams({
      itemid: String(ids.itemid),
      shopid: String(ids.shopid),
      type: '0',
      filter: '0',
      flag: '1',
      limit: String(limit || PAGE_SIZE),
      offset: String(offset || 0)
    });
    return origin + RATINGS_PATH + '?' + params.toString();
  }

  /**
   * itemid/shopid, not item_id/shop_id — those are get_pc's spelling, and
   * this is item/get. Confirmed against a live page.
   */
  function detailUrl(origin, ids) {
    const params = new URLSearchParams({
      itemid: String(ids.itemid),
      shopid: String(ids.shopid)
    });
    return origin + DETAIL_PATH + '?' + params.toString();
  }

  /**
   * The item object out of a detail response.
   *
   * item/get returns the item AS `data`; other shapes nest it under
   * `data.item`. Reading both means a Shopee change of shape degrades to
   * "found nothing" rather than throwing.
   */
  function readItem(json) {
    if (!json || typeof json !== 'object') return null;
    const data = json.data && typeof json.data === 'object' ? json.data : json;
    return (data.item && typeof data.item === 'object') ? data.item : data;
  }

  /**
   * Pull the ratings array out of a response, whichever shape it arrives in.
   *
   * Shopee has moved this between `data.ratings` and a bare `ratings` before.
   * Reading both costs two lines and saves a broken release.
   */
  function readRatings(json) {
    if (!json || typeof json !== 'object') return [];
    const data = json.data && typeof json.data === 'object' ? json.data : json;
    const list = data.ratings;
    return Array.isArray(list) ? list : [];
  }

  /**
   * One rating to the shape the rest of the extension uses.
   *
   * Everything is defensive: a rating with no comment, no variant or no author
   * is ordinary, not an error, and must not abort a 50-page run.
   */
  function normaliseRating(raw, page, indexOnPage, hostname) {
    const images = Array.isArray(raw.images) ? raw.images : [];
    const videos = Array.isArray(raw.videos) ? raw.videos : [];

    const variant = Array.isArray(raw.product_items) && raw.product_items.length
      ? String(raw.product_items[0].model_name || '')
      : '';

    return {
      page,
      reviewIndex: indexOnPage + 1,
      ctime: Number(raw.ctime) || 0,
      stars: Number(raw.rating_star) || 0,
      buyer: String(raw.author_username || ''),
      variant,
      comment: String(raw.comment || ''),
      images: images.map((hash) => imageUrl(hash, hostname)),
      videos: videos.map((v) => ({
        // A video without a playable URL is listed as unavailable rather than
        // dropped, so the user is told instead of quietly getting less.
        url: String((v && (v.url || v.video_url)) || ''),
        cover: v && v.cover ? imageUrl(v.cover, hostname) : ''
      }))
    };
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Fetch with backoff on the failures worth retrying.
   *
   * 429 and 5xx are transient and deserve another go; a 404 does not, and
   * retrying it four times just wastes the user's time before the same error.
   */
  async function fetchJson(url, opts) {
    const options = opts || {};
    const doFetch = options.fetchImpl || fetch;
    let wait = 500;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      let res;
      try {
        res = await doFetch(url, { credentials: 'include' });
      } catch (err) {
        if (attempt === MAX_RETRIES) throw err;
        await sleep(wait);
        wait *= 2;
        continue;
      }

      if (res.ok) return res.json();

      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt === MAX_RETRIES) {
        throw new Error('Shopee returned HTTP ' + res.status);
      }
      await sleep(wait);
      wait *= 2;
    }

    throw new Error('Gave up after ' + MAX_RETRIES + ' retries');
  }

  /**
   * Walk the review pages.
   *
   * Stops on: the requested page count, an empty page, a short page, or the
   * caller asking it to. A short page means the server had no more to give —
   * asking again would return the same nothing.
   *
   * opts: { origin, hostname, ids, fromPage, toPage, pageDelayMs, fetchImpl,
   *         onPage(pageNumber, reviews, totalSoFar), shouldStop() }
   *
   * fromPage/toPage are 1-based and inclusive; toPage null means "to the end".
   */
  async function fetchReviews(opts) {
    const {
      origin, hostname, ids,
      fromPage = 1,
      toPage = null,
      pageDelayMs = DEFAULT_PAGE_DELAY_MS,
      fetchImpl, onPage, shouldStop
    } = opts;

    const all = [];
    const limit = PAGE_SIZE;
    // Zero-based index of the page being requested. Starting at fromPage - 1
    // is what makes "5-10" skip the first four pages instead of fetching them.
    let page = Math.max(0, fromPage - 1);

    while (toPage == null || page < toPage) {
      if (typeof shouldStop === 'function' && shouldStop()) break;

      const url = ratingsUrl(origin, ids, page * limit, limit);
      const json = await fetchJson(url, { fetchImpl });
      const raw = readRatings(json);

      if (raw.length === 0) break;

      const pageNumber = page + 1;
      const reviews = raw.map((r, i) => normaliseRating(r, pageNumber, i, hostname));
      all.push(...reviews);
      // The running total is passed out, because the caller reporting
      // batch.length as a cumulative count made the popup read the same
      // number on every page of a long run.
      if (typeof onPage === 'function') onPage(pageNumber, reviews, all.length);

      // A short page is the end. Checked AFTER the page is kept, so its
      // reviews are not thrown away.
      if (raw.length < limit) break;

      page += 1;
      if (pageDelayMs > 0) await sleep(pageDelayMs);
    }

    return all;
  }

  /**
   * Parse "1-20", "5-10", "all", "" or "7" into a page window.
   *
   * Returns { from, to } with 1-based inclusive pages; `to` is null for
   * "everything". This used to return a bare page COUNT, which threw the
   * lower bound away — "5-10" fetched pages 1 to 10. The common "1-20" form
   * hid it, because there the start happens to be 1.
   */
  function parsePageRange(input) {
    const s = String(input == null ? '' : input).trim().toLowerCase();
    if (s === '' || s === 'all') return { from: 1, to: null };

    const range = s.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      let from = Number(range[1]);
      let to = Number(range[2]);
      if (from < 1) from = 1;
      if (to < 1) return { from: 1, to: null };
      // A reversed range is a typo, not a request for nothing.
      if (to < from) { const t = from; from = to; to = t; }
      return { from, to };
    }

    const single = s.match(/^(\d+)$/);
    if (single) {
      const n = Number(single[1]);
      return n > 0 ? { from: 1, to: n } : { from: 1, to: null };
    }

    return { from: 1, to: null };
  }

  return {
    PAGE_SIZE,
    RATINGS_PATH,
    DETAIL_PATH,
    DEFAULT_PAGE_DELAY_MS,
    idsFromUrl,
    isProductUrl,
    regionFor,
    cdnBase,
    imageUrl,
    ratingsUrl,
    detailUrl,
    readRatings,
    readItem,
    normaliseRating,
    fetchJson,
    fetchReviews,
    parsePageRange
  };
});
