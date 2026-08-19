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

  /**
   * The picker currently on screen, if any.
   *
   * close() used to be two different functions: an inner one that resolved
   * the promise and unbound the key handler, and a module-level one that only
   * removed the DOM node. The Stop button called the second, so the run was
   * left awaiting a promise that could never settle, and a capture-phase
   * keydown listener stayed bound to Shopee's page for the life of the tab —
   * still live, so a later Escape resolved the long-dead promise.
   *
   * Holding the teardown here means there is exactly one way to close.
   */
  let active = null;

  function dismiss(result) {
    if (!active) return;
    const { resolve, onKey, root } = active;
    active = null;
    document.removeEventListener('keydown', onKey, true);
    root.remove();
    resolve(result);
  }

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
      // A picker already up belongs to a run still waiting on it. Settle that
      // one as a cancellation before replacing it, or its run never returns.
      dismiss(null);
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

      /**
       * The filter hides tiles; it does not deselect them. That is the right
       * behaviour, but it used to be a trap: filter to Videos, press Select
       * none, and the counter still showed the hidden images as selected —
       * and Export sent them. The count now says out loud how many selected
       * files the filter is hiding, so what Export will do is never a
       * surprise.
       */
      function refresh() {
        const hidden = selectable.filter(
          (i) => chosen.has(i) && tiles.get(i).style.display === 'none'
        ).length;

        count.textContent = chosen.size + ' of ' + selectable.length + ' selected' +
          (hidden ? ' · ' + hidden + ' hidden by the filter and still selected' : '');
        btnExport.disabled = chosen.size === 0;
      }

      function applyFilter() {
        const want = filter.value;
        for (const [item, tile] of tiles) {
          tile.style.display = want === 'all' || item.kind === want ? '' : 'none';
        }
        refresh();
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

      function onKey(e) {
        if (e.key === 'Escape') {
          e.stopPropagation();
          e.preventDefault();
          dismiss(null);
        }
      }

      btnCancel.addEventListener('click', () => dismiss(null));
      backdrop.addEventListener('click', () => dismiss(null));
      btnExport.addEventListener('click', () => {
        // Emitted in the original order, not click order, so filenames follow
        // the page and review sequence the user expects.
        dismiss({
          items: items.filter((i) => chosen.has(i)),
          style: style.value
        });
      });

      document.addEventListener('keydown', onKey, true);

      // Registered before the node is attached, so any path that closes the
      // picker from here on goes through dismiss() and settles this promise.
      active = { resolve, onKey, root: rootEl };

      rootEl.append(backdrop, panel);
      document.documentElement.appendChild(rootEl);
      refresh();
      applyFilter();
    });
  }

  /**
   * Close from outside — the Stop button.
   *
   * Resolves the pending open() as a cancellation rather than merely deleting
   * the DOM, so the run it belongs to actually finishes.
   */
  function close() {
    dismiss(null);
    // Belt and braces: a node left by an earlier version of this file, or by
    // a reload mid-picker, would otherwise sit on the page for ever.
    document.getElementById(ROOT_ID)?.remove();
  }

  return { open, close };
});
