/**
 * Checks the paging logic against a stub server.
 *
 * Paging bugs are the expensive kind: stopping one page early loses reviews
 * silently, and failing to stop asks Shopee for pages that do not exist from a
 * logged-in account. Both are tested here rather than discovered on a live run.
 *
 *   node tools/test-api.js
 */
'use strict';

const A = require('../content/api.js');

let failures = 0;

function check(name, condition, detail) {
  if (condition) {
    console.log('  ok   ' + name);
  } else {
    failures += 1;
    console.log('  FAIL ' + name + (detail ? '  -> ' + detail : ''));
  }
}

/** A stub fetch serving `total` reviews, recording every URL it is asked for. */
function stubServer(total, opts) {
  const options = opts || {};
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);

    if (options.failFirst && calls.length <= options.failFirst) {
      return { ok: false, status: options.failStatus || 500, json: async () => ({}) };
    }

    const params = new URL(url).searchParams;
    const offset = Number(params.get('offset'));
    const limit = Number(params.get('limit'));
    const slice = [];
    for (let i = offset; i < Math.min(offset + limit, total); i++) {
      slice.push({
        ctime: 1752451200,
        rating_star: 5,
        author_username: 'buyer' + i,
        comment: 'review ' + i,
        images: ['hash' + i],
        videos: [],
        product_items: [{ model_name: 'Blue' }]
      });
    }
    return { ok: true, status: 200, json: async () => ({ data: { ratings: slice } }) };
  };
  return { fetchImpl, calls };
}

const BASE = {
  origin: 'https://shopee.com.my',
  hostname: 'shopee.com.my',
  ids: { shopid: '123', itemid: '456' },
  pageDelayMs: 0
};

console.log('url and id parsing');
const IDS = JSON.stringify({ shopid: '123456', itemid: '7890123' });

check('reads the i.SHOP.ITEM form',
  JSON.stringify(A.idsFromUrl('https://shopee.com.my/Nice-Thing-i.123456.7890123')) === IDS);

// Shopee serves this form just as often, and only the other one was handled —
// so the popup called a real product page "not a product page" and disabled
// the button. Found on a live page, not by reading.
check('reads the /product/SHOP/ITEM form',
  JSON.stringify(A.idsFromUrl('https://shopee.com.my/product/123456/7890123/')) === IDS,
  JSON.stringify(A.idsFromUrl('https://shopee.com.my/product/123456/7890123/')));
check('reads the /product/ form with a query string',
  JSON.stringify(A.idsFromUrl('https://shopee.com.my/product/123456/7890123?utm=x')) === IDS);
check('both forms agree on which number is which',
  JSON.stringify(A.idsFromUrl('https://shopee.com.my/x-i.123456.7890123')) ===
  JSON.stringify(A.idsFromUrl('https://shopee.com.my/product/123456/7890123/')));

check('returns null when the url has no ids',
  A.idsFromUrl('https://shopee.com.my/search?keyword=x') === null);
check('survives a null url', A.idsFromUrl(null) === null);

check('isProductUrl accepts both forms',
  A.isProductUrl('https://shopee.com.my/x-i.1.2') &&
  A.isProductUrl('https://shopee.com.my/product/1/2/'));
check('isProductUrl rejects a search page',
  !A.isProductUrl('https://shopee.com.my/search?keyword=x'));

console.log('region and cdn');
check('malaysia', A.regionFor('shopee.com.my') === 'my');
check('singapore', A.regionFor('shopee.sg') === 'sg');
check('thailand', A.regionFor('shopee.co.th') === 'th');
check('a subdomain still resolves', A.regionFor('seller.shopee.ph') === 'ph');
check('an unknown host falls back rather than throwing', A.regionFor('example.com') === 'my');
check('builds a region cdn url',
  A.imageUrl('abc123', 'shopee.sg') === 'https://down-sg.img.susercontent.com/file/abc123',
  A.imageUrl('abc123', 'shopee.sg'));
check('leaves a full url alone',
  A.imageUrl('https://cdn.example/x.jpg', 'shopee.sg') === 'https://cdn.example/x.jpg');

console.log('response shapes');
check('reads data.ratings', A.readRatings({ data: { ratings: [1, 2] } }).length === 2);
check('reads a bare ratings array', A.readRatings({ ratings: [1] }).length === 1);
check('an unexpected shape yields nothing rather than throwing',
  A.readRatings({ nope: true }).length === 0);
check('null yields nothing', A.readRatings(null).length === 0);

console.log('page range parsing');
const range = (s) => {
  const r = A.parsePageRange(s);
  return r.from + '..' + (r.to === null ? 'end' : r.to);
};
check('all means everything', range('all') === '1..end');
check('blank means everything', range('') === '1..end');
check('a range keeps BOTH bounds', range('1-20') === '1..20', range('1-20'));
// The bug this file used to bless: "5-10" fetched pages 1-10, because only
// the upper bound survived. "1-20" hid it, since there the start is 1 anyway.
check('a range starting past page 1 keeps its start', range('5-10') === '5..10', range('5-10'));
check('a range with spaces', range(' 2 - 7 ') === '2..7', range(' 2 - 7 '));
check('a reversed range is read as a typo, not as nothing',
  range('10-5') === '5..10', range('10-5'));
check('a single number', range('5') === '1..5');
check('nonsense means everything rather than zero pages', range('abc') === '1..end');
check('zero means everything rather than an empty run', range('0') === '1..end');

console.log('endpoints are what we think they are');
// M12/M13: replacing these constants with nonsense used to leave the suite
// green, so a typo in the one file that knows Shopee's API was undetectable.
check('ratings path', A.RATINGS_PATH === '/api/v2/item/get_ratings', A.RATINGS_PATH);
check('detail path', A.DETAIL_PATH === '/api/v4/pdp/get_pc', A.DETAIL_PATH);
check('ratings url carries the ids and paging',
  (() => {
    const u = new URL(A.ratingsUrl('https://shopee.com.my', { shopid: '1', itemid: '2' }, 100, 50));
    return u.pathname === A.RATINGS_PATH &&
      u.searchParams.get('shopid') === '1' &&
      u.searchParams.get('itemid') === '2' &&
      u.searchParams.get('offset') === '100' &&
      u.searchParams.get('limit') === '50';
  })());
check('detail url carries the ids',
  (() => {
    const u = new URL(A.detailUrl('https://shopee.com.my', { shopid: '1', itemid: '2' }));
    return u.pathname === A.DETAIL_PATH &&
      u.searchParams.get('shop_id') === '1' &&
      u.searchParams.get('item_id') === '2';
  })());

console.log('normalising a rating');
const norm = A.normaliseRating({
  ctime: 1752451200, rating_star: 4, author_username: 'ahmad',
  comment: 'good', images: ['h1', 'h2'], videos: [{ url: 'https://v/1.mp4', cover: 'c1' }],
  product_items: [{ model_name: 'Merah' }]
}, 3, 2, 'shopee.com.my');
check('keeps page and one-based review index', norm.page === 3 && norm.reviewIndex === 3);
check('maps image hashes to cdn urls',
  norm.images[0] === 'https://down-my.img.susercontent.com/file/h1');
check('reads the variant', norm.variant === 'Merah');
check('keeps the video cover', norm.videos[0].cover.endsWith('/c1'));

const sparse = A.normaliseRating({}, 1, 0, 'shopee.com.my');
check('a rating with nothing in it does not throw',
  sparse.comment === '' && sparse.images.length === 0 && sparse.variant === '');

console.log('paging');
(async () => {
  // Exactly divisible: 100 reviews at 50 a page is two full pages, then an
  // empty third that stops it. The short-page rule cannot fire here.
  const exact = stubServer(100);
  const a = await A.fetchReviews(Object.assign({}, BASE, { fetchImpl: exact.fetchImpl }));
  check('an exact multiple fetches every review', a.length === 100, a.length + ' reviews');
  check('an exact multiple stops on the empty page', exact.calls.length === 3,
    exact.calls.length + ' calls');

  // Short page: 70 reviews means a full page then a half one, and the half
  // page is the end — asking again would return nothing.
  const short = stubServer(70);
  const b = await A.fetchReviews(Object.assign({}, BASE, { fetchImpl: short.fetchImpl }));
  check('a short page keeps its reviews', b.length === 70, b.length + ' reviews');
  check('a short page stops without another call', short.calls.length === 2,
    short.calls.length + ' calls');

  const none = stubServer(0);
  const c = await A.fetchReviews(Object.assign({}, BASE, { fetchImpl: none.fetchImpl }));
  check('a product with no reviews returns empty', c.length === 0);
  check('a product with no reviews asks once', none.calls.length === 1);

  const capped = stubServer(1000);
  const d = await A.fetchReviews(Object.assign({}, BASE, {
    fetchImpl: capped.fetchImpl, toPage: 3
  }));
  check('toPage caps the run', d.length === 150, d.length + ' reviews');
  check('toPage stops asking', capped.calls.length === 3, capped.calls.length + ' calls');

  // The whole point of keeping the lower bound: it must actually skip.
  const skipped = stubServer(1000);
  const s = await A.fetchReviews(Object.assign({}, BASE, {
    fetchImpl: skipped.fetchImpl, fromPage: 5, toPage: 6
  }));
  check('fromPage skips the pages before it', s.length === 100, s.length + ' reviews');
  check('fromPage starts at the right offset',
    new URL(skipped.calls[0]).searchParams.get('offset') === '200',
    skipped.calls[0]);
  check('fromPage numbers the pages correctly', s[0].page === 5, 'page ' + s[0].page);

  const stopper = stubServer(1000);
  let seen = 0;
  const e = await A.fetchReviews(Object.assign({}, BASE, {
    fetchImpl: stopper.fetchImpl,
    onPage: () => { seen += 1; },
    shouldStop: () => seen >= 2
  }));
  check('stop is honoured mid-run', e.length === 100, e.length + ' reviews');
  check('onPage fires once per page', seen === 2, seen + ' pages');

  console.log('retry and backoff');
  const flaky = stubServer(10, { failFirst: 2, failStatus: 500 });
  const f = await A.fetchReviews(Object.assign({}, BASE, { fetchImpl: flaky.fetchImpl }));
  check('retries a 5xx and recovers', f.length === 10, f.length + ' reviews');

  const rateLimited = stubServer(10, { failFirst: 1, failStatus: 429 });
  const g = await A.fetchReviews(Object.assign({}, BASE, { fetchImpl: rateLimited.fetchImpl }));
  check('retries a 429 and recovers', g.length === 10, g.length + ' reviews');

  const gone = stubServer(10, { failFirst: 99, failStatus: 404 });
  let threw = null;
  try {
    await A.fetchReviews(Object.assign({}, BASE, { fetchImpl: gone.fetchImpl }));
  } catch (err) {
    threw = err;
  }
  check('does not retry a 404', threw !== null && gone.calls.length === 1,
    gone.calls.length + ' calls');

  // Backoff must actually GROW. Flattening it to a constant used to pass,
  // which meant the politeness the spec promises was never verified.
  const stamps = [];
  const slow = {
    fetchImpl: async () => {
      stamps.push(Date.now());
      if (stamps.length <= 3) return { ok: false, status: 503, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ data: { ratings: [] } }) };
    }
  };
  await A.fetchReviews(Object.assign({}, BASE, { fetchImpl: slow.fetchImpl }));
  const gaps = stamps.slice(1).map((t, i) => t - stamps[i]);
  check('backoff grows between retries',
    gaps.length >= 3 && gaps[1] > gaps[0] && gaps[2] > gaps[1],
    gaps.join('ms, ') + 'ms');

  console.log('politeness');
  // pageDelayMs is deleted-and-still-green territory: BASE sets it to 0, so
  // nothing anywhere exercised the pause between pages.
  const paced = stubServer(150);
  const startedAt = Date.now();
  await A.fetchReviews(Object.assign({}, BASE, {
    fetchImpl: paced.fetchImpl, pageDelayMs: 120
  }));
  const elapsed = Date.now() - startedAt;
  check('waits between pages', elapsed >= 200, elapsed + 'ms for 3 pages');

  console.log('session');
  // Losing this sends the requests logged out, which returns different data
  // rather than an error - the kind of change that passes CI and breaks live.
  let sawCredentials = null;
  await A.fetchJson('https://shopee.com.my/x', {
    fetchImpl: async (_url, init) => {
      sawCredentials = init && init.credentials;
      return { ok: true, status: 200, json: async () => ({}) };
    }
  });
  check('sends cookies with every request', sawCredentials === 'include',
    String(sawCredentials));

  console.log('');
  if (failures) {
    console.log(failures + ' failure(s)');
    process.exit(1);
  }
  console.log('all api tests passed');
})();
