# Shopee Review Media Extractor — Design

Date: 2026-08-18
Status: approved

## Purpose

A Chrome extension that extracts reviews and their media (images, videos) plus
product content from a Shopee product page, with no page limit and no per-day
product limit.

It replaces a third-party extension that caps free use at 2 review pages and 2
products per day. Layout and flow follow that extension; the limits do not.

## Scope

In scope:

- Review images and review videos, across any number of review pages
- Product main images, variant images, product videos, description content
- A visual picker so the user chooses which found files to export
- One ZIP per product, written to the Downloads folder
- A `reviews.csv` describing the reviews whose media was exported
- Self-update from GitHub, matching the two sibling extensions

Out of scope:

- Any licensing, paywall or usage metering
- Seller Centre pages (covered by Shopee Report Downloader)
- Bulk mode across many product URLs at once
- Editing, resizing or watermarking the media

## Sites

Content scripts and host permissions cover:

    https://shopee.com.my/*
    https://shopee.sg/*
    https://shopee.ph/*
    https://shopee.co.th/*
    https://shopee.co.id/*

Region matters beyond the match list: review image hashes resolve against a
region CDN host (for example `down-my.img.susercontent.com` for Malaysia). The
CDN host is derived from the page's own hostname at run time rather than
hard-coded, so adding a site later is a one-line change.

## Data acquisition

### Primary path — the ratings endpoint

Shopee's product page loads reviews from a JSON endpoint on the same origin:

    /api/v2/item/get_ratings?itemid={itemid}&shopid={shopid}&type=0&filter=0&flag=1&limit={n}&offset={m}

The content script calls this itself, from the page's origin so the session
cookies are sent, stepping `offset` until a response returns no further
ratings. The site's own UI requests 6 at a time; the endpoint serves a larger
`limit`, so paging is far cheaper than scrolling the DOM. The exact working
maximum is confirmed against a live page during implementation and pinned in
`content/api.js` as a named constant.

Each rating carries: `comment`, `rating_star`, `ctime`, `author_username`,
the ordered variant (`product_items[].model_name`), `images[]` as CDN hashes,
and `videos[]` with a cover image and a playable URL.

`itemid` and `shopid` come from the product URL (the trailing `iNNN.NNN.NNN`
segment), falling back to the page's embedded initial state when the URL form
differs by region.

### Fallback path — request interception

If the endpoint's URL or response shape changes, a MAIN-world content script
wraps `fetch` and `XMLHttpRequest` and captures ratings payloads the page
requests for itself. This mirrors `content/interceptor.js` in Shopee Report
Downloader. The fallback yields whatever the page has actually loaded, so its
coverage depends on scrolling; it exists so that a Shopee change degrades the
extension instead of breaking it. The popup states plainly which path produced
the results.

### Product content

Main images, variant images, product video and description come from the
product detail endpoint the page already uses. Description images are
collected alongside the description text.

## Politeness and resilience

- A short delay between page fetches, so a 50-page run is not a burst
- Exponential backoff and retry on HTTP 429 and 5xx
- A hard stop the user can trigger mid-run
- Media downloads run with a small fixed concurrency, not all at once

These protect a logged-in account from rate limiting.

## User flow

### Step 1 — popup panel

Fields, in order:

- **Review pages** — text input accepting `1-2`, `1-50` or `all`
- **Review media** — checkboxes: Review images, Review videos
- **Product content** — checkboxes: Main images, Variant images, Product
  videos, Description content
- **Filename style** — dropdown, see below
- **Find media** — primary button

While finding: a progress line (`Page 7 of 50 · 312 files`) and a Stop button.

### Step 2 — in-page picker

A modal injected into the Shopee page, styled to sit above page content:

- Header: `Found N files. All are selected by default.`
- Scrolling grid of thumbnails, each with a checkbox, a source label
  (`Review page 1`, `Main image`, `Variant image`) and a type label
  (`image` / `video`)
- Videos display their cover frame with a play badge
- Toolbar: Select all / Select none / Invert, and a type filter
- Footer: **Cancel** and **Export selected**

Thumbnails load lazily via `IntersectionObserver`; a run of several hundred
files must not stall the page.

### Step 3 — export

Selected files are fetched, assembled into a ZIP, and downloaded.

## ZIP layout

    {shop-name}_{product-name}/
      reviews/      page01_r03_img1.jpg, page02_r07_vid1.mp4
      product/      main_01.jpg, variant_blue.jpg, video_01.mp4
      description/  description.txt, img_01.jpg
      reviews.csv

`reviews.csv` is included whenever review media is part of the export, and
omitted when the export is product content only. Columns: page, review index,
date, stars, buyer, variant, comment, and the exported filenames from that
review. This keeps every exported photo traceable to what the buyer wrote.

Folder and file names are sanitised for Windows: reserved characters removed,
reserved device names avoided, and each path segment truncated so the total
stays within the filesystem limit.

## Filename styles

- **Page, review, type** (default) — `page01_r03_img1.jpg`
- **Date, buyer** — `2026-07-14_ahmad_img1.jpg`
- **Sequential** — `0001.jpg`

Collisions get a numeric suffix.

## Download behaviour

The background worker calls `chrome.downloads.download()` with an explicit
`filename`, and **registers no `onDeterminingFilename` listener at all**.

This is deliberate. `onDeterminingFilename` is browser-wide: every extension
holding the downloads permission is asked about every download, and a listener
that calls `suggest()` with no arguments discards the requested path in favour
of Chrome's guess from the URL. That is what produced `download (4).zip` across
the two sibling extensions in August 2026. A third extension that never
registers the listener cannot join that contest and cannot regress them.

## Components

    manifest.json          MV3, host permissions for the five sites
    popup/                 panel UI and its controller
    content/
      content.js           ISOLATED world: orchestrates a run, injects picker
      api.js               endpoint URLs, paging, backoff, response parsing
      picker.js            the in-page modal
      picker.css           modal styling, namespaced to avoid page collisions
      interceptor.js       MAIN world: fallback capture of page requests
    background/
      background.js        message routing, media fetch queue, ZIP, download
    lib/
      zip.js               dependency-free store-mode ZIP writer
      csv.js               CSV escaping
      naming.js            filename styles, sanitising, collision suffixes
    options/               self-updater page, adapted from the siblings
    tools/
      make-release.ps1     version bump + update.json regeneration
      test-*.js            node test scripts run against stubs
    icons/

Each unit has one job and is testable on its own: `zip.js` takes entries and
returns bytes; `naming.js` takes a review and a style and returns a name;
`api.js` takes a page range and returns reviews. No external CDN is used —
extension pages cannot load one under the default content security policy.

## Testing

Unit level, runnable with node against stubs, in `tools/`:

- `zip.js` produces an archive that a real unzip utility can open
- `naming.js` sanitises Windows-hostile names and resolves collisions
- `csv.js` escapes commas, quotes and newlines inside review comments
- `api.js` paging stops correctly on an empty page and on a short page
- a guard asserting `onDeterminingFilename` is never referenced in the source

Manual, on live product pages:

- a product with few reviews
- a product with several hundred reviews, exercising paging and the picker
- a product with review videos
- a product with no review media at all
- confirmation that the sibling extensions still name their downloads
  correctly while this one is installed

## Release

Version starts at `1.0.0`. Its own GitHub repository, `update.json` generated
from the files on disk, and an Options page that fetches updates from
`raw.githubusercontent.com` and reloads the extension — the same mechanism the
two sibling extensions use. Any code change is accompanied by a version bump,
a commit and a push; an unpushed release is invisible to the updater.

## Risks

- **Shopee changes the endpoint.** Mitigated by the interceptor fallback and
  by keeping endpoint knowledge in one file.
- **Rate limiting on large runs.** Mitigated by throttling, backoff and Stop.
- **Video URLs may be segmented rather than a single file.** If a direct URL
  is unavailable for a given video, that item is listed in the picker as
  unavailable rather than silently skipped, and the run continues.
- **Memory on very large exports.** A ZIP is assembled in memory; several
  thousand images could be heavy. The picker's count gives the user warning,
  and export is chunked. If this proves a real limit in testing, the fix is
  streaming to a chosen folder — noted, not built.
