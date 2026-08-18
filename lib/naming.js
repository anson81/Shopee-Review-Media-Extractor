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

  // Windows refuses these names even with an extension.
  const RESERVED = new Set([
    'CON', 'PRN', 'AUX', 'NUL',
    'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
    'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9'
  ]);

  const MAX_SEGMENT = 80;

  /**
   * Make one path segment safe for Windows, macOS and the ZIP format.
   * Never returns an empty string, because an empty segment produces a
   * malformed archive path.
   */
  function sanitizeSegment(input, fallback) {
    let s = String(input == null ? '' : input);

    s = s.replace(ILLEGAL, ' ');
    // Collapse whitespace so names stay readable and predictable.
    s = s.replace(/\s+/g, ' ').trim();
    // Windows silently strips trailing dots and spaces; do it ourselves so
    // the name we record matches the name on disk.
    s = s.replace(/[. ]+$/g, '');

    if (s.length > MAX_SEGMENT) {
      s = s.slice(0, MAX_SEGMENT).replace(/[. ]+$/g, '');
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
  function assignPaths(items, style, rootFolder) {
    const used = new Set();
    const root = sanitizeSegment(rootFolder, 'shopee-product');
    const out = [];

    items.forEach(function (item, i) {
      const folder = folderFor(item);
      const ext = extensionFor(item);
      const base = sanitizeSegment(baseName(item, style, i + 1), 'file');

      let candidate = folder + '/' + base + '.' + ext;
      let n = 2;
      while (used.has(candidate.toLowerCase())) {
        candidate = folder + '/' + base + '_' + n + '.' + ext;
        n += 1;
      }
      used.add(candidate.toLowerCase());

      out.push(Object.assign({}, item, { path: root + '/' + candidate }));
    });

    return out;
  }

  /** Name for the downloaded archive itself. */
  function zipName(shopName, productName) {
    const shop = sanitizeSegment(shopName, 'shop').replace(/\s+/g, '-');
    const product = sanitizeSegment(productName, 'product').replace(/\s+/g, '-');
    return (shop + '_' + product).slice(0, 120) + '.zip';
  }

  /** Folder name inside the archive. */
  function rootFolderName(shopName, productName) {
    const shop = sanitizeSegment(shopName, 'shop').replace(/\s+/g, '-');
    const product = sanitizeSegment(productName, 'product').replace(/\s+/g, '-');
    return (shop + '_' + product).slice(0, 120);
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
