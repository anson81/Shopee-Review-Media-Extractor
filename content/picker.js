/**
 * The in-page picker.
 *
 * Injected into Shopee's own page rather than shown in the popup, for one
 * practical reason: a Chrome popup closes the moment the user clicks anything
 * else, and choosing among three hundred thumbnails takes longer than that.
 *
 * Everything is built with createElement rather than innerHTML. The strings
 * involved are review text and buyer names — arbitrary text from the internet
 * — and building DOM this way means there is no HTML parsing step for any of
 * it to be interpreted by.
 */
(function (root, factory) {
  root.SRME_Picker = factory();
})(typeof globalThis !== 'undefined' ? globalThis : self, function () {
  'use strict';

  const ROOT_ID = 'srme-root';

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = String(text);
    return node;
  }

  function sourceLabel(item) {
    switch (item.source) {
      case 'review': return 'Review page ' + item.page;
      case 'main': return 'Main image';
      case 'variant': return 'Variant' + (item.label ? ' · ' + item.label : '');
      case 'product-video': return 'Product video';
      case 'description': return 'Description';
      default: return item.source || 'File';
    }
  }

  /**
   * Thumbnails load only as they scroll into view.
   *
   * A run of several hundred files with every <img> src set at once stalls the
   * page and hammers the CDN with requests for pictures nobody has looked at.
   */
  function makeLazyLoader() {
    if (typeof IntersectionObserver !== 'function') {
      // Old browser: load everything rather than showing blank tiles.
      return { observe: (img) => { img.src = img.dataset.src; } };
    }
    const io = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const img = entry.target;
        if (img.dataset.src) {
          img.src = img.dataset.src;
          delete img.dataset.src;
        }
        io.unobserve(img);
      }
    }, { rootMargin: '200px' });
    return { observe: (img) => io.observe(img) };
  }

  /**
   * Show the picker.
   *
   * items: the found media, each { url, kind, source, page, reviewIndex,
   *        thumb, unavailable }
   * Returns a promise resolving to { items, style } or null if cancelled.
   */
  function open(items, options) {
    const opts = options || {};

    return new Promise((resolve) => {
      document.getElementById(ROOT_ID)?.remove();

      const rootEl = el('div', null);
      rootEl.id = ROOT_ID;

      const backdrop = el('div', 'srme-backdrop');
      const panel = el('div', 'srme-panel');

      /* header ----------------------------------------------------------- */
      const head = el('div', 'srme-head');
      const selectable = items.filter((i) => !i.unavailable);
      head.appendChild(el('h2', 'srme-title',
        'Found ' + items.length + ' files. All are selected by default.'));

      const deadCount = items.length - selectable.length;
      head.appendChild(el('p', 'srme-sub',
        deadCount
          ? deadCount + ' could not be reached and cannot be exported.'
          : 'Untick anything you do not want.'));
      panel.appendChild(head);

      /* toolbar ---------------------------------------------------------- */
      const tools = el('div', 'srme-tools');
      const btnAll = el('button', null, 'Select all');
      const btnNone = el('button', null, 'Select none');
      const btnInvert = el('button', null, 'Invert');

      const filter = document.createElement('select');
      [
        ['all', 'All types'],
        ['image', 'Images only'],
        ['video', 'Videos only']
      ].forEach(([value, label]) => {
        const o = document.createElement('option');
        o.value = value;
        o.textContent = label;
        filter.appendChild(o);
      });

      const style = document.createElement('select');
      [
        ['page-review-type', 'Name: page, review, type'],
        ['date-buyer', 'Name: date, buyer'],
        ['sequential', 'Name: sequential']
      ].forEach(([value, label]) => {
        const o = document.createElement('option');
        o.value = value;
        o.textContent = label;
        style.appendChild(o);
      });
      if (opts.style) style.value = opts.style;

      tools.append(btnAll, btnNone, btnInvert, filter, el('span', 'srme-spacer'), style);
      panel.appendChild(tools);

      /* grid ------------------------------------------------------------- */
      const grid = el('div', 'srme-grid');
      panel.appendChild(grid);

      const lazy = makeLazyLoader();
      const chosen = new Set(selectable);
      const tiles = new Map();

      if (items.length === 0) {
        grid.appendChild(el('div', 'srme-empty',
          'No media was found for this product.'));
      }

      for (const item of items) {
        const tile = el('div', 'srme-tile' + (item.unavailable ? ' srme-dead' : ' srme-on'));

        const img = document.createElement('img');
        img.className = 'srme-thumb';
        img.alt = '';
        img.loading = 'lazy';
        // Referrer is deliberately not sent: the CDN does not need it and it
        // leaks which product page the seller is working on.
        img.referrerPolicy = 'no-referrer';
        img.dataset.src = item.thumb || item.url;
        lazy.observe(img);
        tile.appendChild(img);

        if (item.kind === 'video') {
          tile.appendChild(el('div', 'srme-play', '▶'));
        }
        tile.appendChild(el('span', 'srme-badge', item.unavailable ? 'n/a' : item.kind));

        const meta = el('div', 'srme-meta');
        meta.appendChild(el('strong', null, sourceLabel(item)));
        meta.appendChild(document.createTextNode(
          item.unavailable ? 'no direct link' : item.kind));
        tile.appendChild(meta);

        if (!item.unavailable) {
          tile.addEventListener('click', () => {
            if (chosen.has(item)) chosen.delete(item);
            else chosen.add(item);
            tile.classList.toggle('srme-on', chosen.has(item));
            refresh();
          });
        }

        tiles.set(item, tile);
        grid.appendChild(tile);
      }

      /* footer ----------------------------------------------------------- */
      const foot = el('div', 'srme-foot');
      const count = el('span', 'srme-count', '');
      const btnCancel = el('button', null, 'Cancel');
      const btnExport = el('button', 'srme-primary', 'Export selected');
      foot.append(count, el('span', 'srme-spacer'), btnCancel, btnExport);
      panel.appendChild(foot);

      function refresh() {
        count.textContent = chosen.size + ' of ' + selectable.length + ' selected';
        btnExport.disabled = chosen.size === 0;
      }

      function applyFilter() {
        const want = filter.value;
        for (const [item, tile] of tiles) {
          tile.style.display = want === 'all' || item.kind === want ? '' : 'none';
        }
      }

      /** Acts on what is visible, so "select none" under a filter is not a trap. */
      function visibleSelectable() {
        return selectable.filter((i) => tiles.get(i).style.display !== 'none');
      }

      btnAll.addEventListener('click', () => {
        for (const i of visibleSelectable()) {
          chosen.add(i);
          tiles.get(i).classList.add('srme-on');
        }
        refresh();
      });

      btnNone.addEventListener('click', () => {
        for (const i of visibleSelectable()) {
          chosen.delete(i);
          tiles.get(i).classList.remove('srme-on');
        }
        refresh();
      });

      btnInvert.addEventListener('click', () => {
        for (const i of visibleSelectable()) {
          if (chosen.has(i)) chosen.delete(i);
          else chosen.add(i);
          tiles.get(i).classList.toggle('srme-on', chosen.has(i));
        }
        refresh();
      });

      filter.addEventListener('change', applyFilter);

      function close(result) {
        document.removeEventListener('keydown', onKey, true);
        rootEl.remove();
        resolve(result);
      }

      function onKey(e) {
        if (e.key === 'Escape') {
          e.stopPropagation();
          close(null);
        }
      }

      btnCancel.addEventListener('click', () => close(null));
      backdrop.addEventListener('click', () => close(null));
      btnExport.addEventListener('click', () => {
        // Emitted in the original order, not click order, so filenames follow
        // the page and review sequence the user expects.
        close({
          items: items.filter((i) => chosen.has(i)),
          style: style.value
        });
      });

      document.addEventListener('keydown', onKey, true);

      rootEl.append(backdrop, panel);
      document.documentElement.appendChild(rootEl);
      refresh();
      applyFilter();
    });
  }

  function close() {
    document.getElementById(ROOT_ID)?.remove();
  }

  return { open, close };
});
