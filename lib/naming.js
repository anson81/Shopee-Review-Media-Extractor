/**
 * Filename construction, sanitising and collision handling.
 *
 * Loaded three ways: as a content script, via importScripts() in the service
 * worker, and via require() in the node tests. It therefore attaches to the
 * global and exports itself, and depends on nothing.
 */
(function (root, factory) {
  const api = factory();
  root.SRME_Naming = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : self, function () {
  'use strict';

  const STYLES = {
    PAGE_REVIEW_TYPE: 'page-review-type',
    DATE_BUYER: 'date-buyer',
    SEQUENTIAL: 'sequential'
  };

  // Characters Windows forbids in a path segment, plus control characters.
  const ILLEGAL = /[<>:"/\\|?*\x00-\x1F]/g;

  // Windows refuses these names even with an extension. CONIN$ and CONOUT$
  // are real console devices, and COM¹/COM²/COM³ use superscript digits that
  // Windows still resolves as COM1/COM2/COM3.
  const RESERVED = new Set([
    'CON', 'PRN', 'AUX', 'NUL', 'CONIN$', 'CONOUT$',
    'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
    'COM¹', 'COM²', 'COM³',
    'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
    'LPT¹', 'LPT²', 'LPT³'
  ]);

  const MAX_SEGMENT = 80;
  /**
   * How long the archive's own name may get.
   *
   * Cut from 110 to 70 after Windows refused to extract a real export with
   * "Destination Path Too Long". A Shopee title is not a name, it is a
   * keyword list — "QFM Melody Batwing Knitwear Top (#3299) | Oversize Modest
   * Blouse Muslimah Baju Knit Long Sleeve" — and every character of it is
   * spent twice over: once in the folder Windows creates when extracting, and
   * again in every path inside it.
   *
   * 70 still identifies the product on sight.
   */
  const MAX_ROOT = 70;

  /**
   * Truncate by CHARACTER, not by UTF-16 code unit.
   *
   * slice() cuts code units, so it can split an emoji or any astral character
   * in half and leave a lone surrogate. TextEncoder turns that into U+FFFD,
   * so a shop name ending in an emoji produced a replacement character in
   * every path in the archive. Shopee shop names carry emoji constantly.
   */
  function truncateChars(s, limit) {
    const chars = Array.from(s);
    return chars.length <= limit ? s : chars.slice(0, limit).join('');
  }

  /**
   * Make one path segment safe for Windows, macOS and the ZIP format.
   * Never returns an empty string, because an empty segment produces a
   * malformed archive path.
   */
  function sanitizeSegment(input, fallback, limit) {
    const cap = limit || MAX_SEGMENT;
    let s = String(input == null ? '' : input);

    s = s.replace(ILLEGAL, ' ');
    // Collapse whitespace so names stay readable and predictable.
    s = s.replace(/\s+/g, ' ').trim();
    // Windows silently strips trailing dots and spaces; do it ourselves so
    // the name we record matches the name on disk.
    s = s.replace(/[. ]+$/g, '');

    if (Array.from(s).length > cap) {
      s = truncateChars(s, cap).replace(/[. ]+$/g, '');
    }

    const stem = s.split('.')[0].toUpperCase();
    if (RESERVED.has(stem)) s = '_' + s;

    if (!s) s = fallback || 'untitled';
    return s;
  }

  /** Two-digit and above, zero padded. */
  function pad(n, width) {
    return String(n).padStart(width, '0');
  }

  /**
   * Extension for a media item, inferred from its URL and falling back to the
   * kind. Shopee CDN image URLs frequently carry no extension at all.
   */
  function extensionFor(item) {
    const url = String(item.url || '');
    const path = url.split('?')[0].split('#')[0];
    const match = path.match(/\.([a-z0-9]{2,4})$/i);
    if (match) {
      const ext = match[1].toLowerCase();
      // Guard against a path segment that merely looks like an extension.
      const known = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'mp4', 'webm', 'mov', 'm4v'];
      if (known.includes(ext)) return ext;
    }
    return item.kind === 'video' ? 'mp4' : 'jpg';
  }

  /** yyyy-mm-dd from a unix seconds timestamp, in local time. */
  function dateStamp(ctime) {
    if (!ctime) return 'undated';
    const d = new Date(Number(ctime) * 1000);
    if (Number.isNaN(d.getTime())) return 'undated';
    return d.getFullYear() + '-' + pad(d.getMonth() + 1, 2) + '-' + pad(d.getDate(), 2);
  }

  /**
   * Build the base filename (no extension) for one media item.
   *
   * item: { kind, source, page, reviewIndex, mediaIndex, ctime, buyer, label }
   *   source is 'review' | 'main' | 'variant' | 'product-video' | 'description'
   */
  function baseName(item, style, sequence) {
    if (style === STYLES.SEQUENTIAL) {
      return pad(sequence, 4);
    }

    if (item.source !== 'review') {
      // Product content has no page or buyer, so both remaining styles agree.
      const label = item.label ? sanitizeSegment(item.label, item.source) : item.source;
      return label + '_' + pad(item.mediaIndex || 1, 2);
    }

    const kindTag = item.kind === 'video' ? 'vid' : 'img';

    if (style === STYLES.DATE_BUYER) {
      const buyer = sanitizeSegment(item.buyer || 'anonymous', 'anonymous')
        .replace(/\s+/g, '-')
        .toLowerCase();
      return dateStamp(item.ctime) + '_' + buyer + '_' + kindTag + (item.mediaIndex || 1);
    }

    // Default: page, review, type.
    return 'page' + pad(item.page || 1, 2) +
      '_r' + pad(item.reviewIndex || 1, 2) +
      '_' + kindTag + (item.mediaIndex || 1);
  }

  /** Folder a media item belongs in, inside the product folder. */
  function folderFor(item) {
    if (item.source === 'review') return 'reviews';
    if (item.source === 'description') return 'description';
    return 'product';
  }

  /**
   * Assign a unique in-archive path to every item, in order.
   * Returns a new array of { ...item, path }.
   */
  /**
   * Windows refuses a path over 260 characters unless long paths are enabled,
   * and everything in front of the archive's contents counts towards it.
   *
   * The reservation covers the whole realistic prefix:
   *
   *   C:\Users\<name>\Documents\        ~40
   *   Shopee Review Media\               21
   *   2026-08-20\                        11
   *   <archive name>\                 up to 71   <- created by extracting
   *                                    ----
   *                                     143, rounded up to 170 for headroom
   *
   * A name a few characters shorter is a cosmetic loss; a path that will not
   * extract is a real one, so the reservation is deliberately generous.
   */
  const MAX_PATH_TOTAL = 260;
  const ASSUMED_PREFIX = 170;

  /**
   * Assign a unique in-archive path to every item, in order.
   * Returns a new array of { ...item, path }.
   *
   * THERE IS NO ROOT FOLDER INSIDE THE ARCHIVE, deliberately.
   *
   * There used to be, named identically to the archive — and Windows creates
   * a folder named after the archive when extracting, so the same 100-character
   * Shopee title landed in the path TWICE and Windows refused the extraction
   * outright with "Destination Path Too Long". Dropping the inner copy is what
   * makes a long product name survivable at all.
   *
   * The trade is that "extract here", rather than the default "extract to a
   * folder", drops reviews/ and product/ straight into the current directory
   * and two different products would merge. The default on both Windows and
   * macOS creates the folder, and a path that cannot be extracted at all is
   * the worse failure.
   */
  function assignPaths(items, style) {
    const used = new Set();
    const out = [];

    items.forEach(function (item, i) {
      const folder = folderFor(item);
      const ext = extensionFor(item);

      // Room left for this filename once the sub-folder, the separator, the
      // extension and a possible "_12" collision suffix are accounted for.
      const fixed = folder.length + 1 + ext.length + 1 + 3;
      const room = Math.max(8, Math.min(
        MAX_SEGMENT,
        MAX_PATH_TOTAL - ASSUMED_PREFIX - fixed
      ));

      const base = sanitizeSegment(baseName(item, style, i + 1), 'file', room);

      let candidate = folder + '/' + base + '.' + ext;
      let n = 2;
      while (used.has(candidate.toLowerCase())) {
        // The suffix replaces the tail rather than extending it, so a
        // collision cannot push the segment back over the cap it was just
        // truncated to.
        const suffix = '_' + n;
        const stem = Array.from(base).length + suffix.length > room
          ? truncateChars(base, Math.max(1, room - suffix.length))
          : base;
        candidate = folder + '/' + stem + suffix + '.' + ext;
        n += 1;
      }
      used.add(candidate.toLowerCase());

      out.push(Object.assign({}, item, { path: candidate }));
    });

    return out;
  }

  /**
   * Folder name inside the archive.
   *
   * zipName is defined AS this plus ".zip" rather than repeating the
   * construction, because the two drifted when they were separate: both
   * sliced at 120, but assignPaths then re-sanitised the root down to 80, so
   * the folder inside the archive did not match the archive's own name.
   */
  function rootFolderName(shopName, productName) {
    const shop = sanitizeSegment(shopName, 'shop', MAX_ROOT).replace(/\s+/g, '-');
    const product = sanitizeSegment(productName, 'product', MAX_ROOT).replace(/\s+/g, '-');
    return sanitizeSegment(shop + '_' + product, 'shopee-product', MAX_ROOT);
  }

  /** Name for the downloaded archive itself. */
  function zipName(shopName, productName) {
    return rootFolderName(shopName, productName) + '.zip';
  }

  return {
    STYLES: STYLES,
    sanitizeSegment: sanitizeSegment,
    extensionFor: extensionFor,
    dateStamp: dateStamp,
    baseName: baseName,
    folderFor: folderFor,
    assignPaths: assignPaths,
    zipName: zipName,
    rootFolderName: rootFolderName
  };
});
