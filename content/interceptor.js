/**
 * MAIN-world interceptor — the fallback path.
 *
 * Runs inside Shopee's own JavaScript context (not the extension's isolated
 * world) at document_start, so it can wrap the page's own fetch and
 * XMLHttpRequest. A content script in the isolated world that patches fetch
 * only patches its own copy; the page would never notice.
 *
 * This exists so a Shopee change DEGRADES the extension instead of breaking
 * it. The primary path in api.js calls the ratings endpoint directly, which is
 * faster and complete. If that endpoint moves or changes shape, whatever the
 * page loads for itself still passes through here and can be salvaged — but
 * only what the user actually scrolled past, which is why it is the fallback
 * and not the plan.
 *
 * Captured payloads are relayed to content.js via window.postMessage. This
 * script never touches chrome.* APIs — it has no access to them.
 */
(() => {
  'use strict';

  if (window.__srmeHooked) return;
  window.__srmeHooked = true;

  const TAG = '__SRME__';

  // Ratings is what we are after. The product detail endpoint carries the
  // rest (main images, variants, video, description).
  //
  // `pdp/get_pc` is here because it was missing: the watch list named
  // get_pc_detail and get_item_detail, neither of which matches the
  // /api/v4/pdp/get_pc that api.js actually calls, so the fallback could
  // never capture the endpoint it existed to back up.
  const WATCHED = /get_ratings|pdp\/get_pc|get_pc_detail|get_item_detail|item\/get/i;

  /**
   * Anything posted before content.js is listening.
   *
   * This script runs at document_start and the ISOLATED-world listener is
   * installed at document_idle, so the page's own first ratings call — the
   * most valuable one, because it is the one that already succeeded — was
   * being posted into a void. The listener announces itself when it is ready
   * and everything held here is replayed.
   */
  let buffer = [];
  let listening = false;
  const MAX_BUFFER = 40;

  function post(payload) {
    const message = Object.assign({ [TAG]: true }, payload);

    if (!listening) {
      if (buffer.length < MAX_BUFFER) buffer.push(message);
      return;
    }

    try {
      window.postMessage(message, window.location.origin);
    } catch (_) {
      /* never break the page */
    }
  }

  /** Replies bypass the buffer: an answer nobody is waiting for is useless. */
  function reply(payload) {
    try {
      window.postMessage(Object.assign({ [TAG]: true }, payload), window.location.origin);
    } catch (_) {
      /* never break the page */
    }
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const d = event.data;
    if (!d || d[TAG] !== true) return;

    if (d.kind === 'ready') {
      listening = true;
      const held = buffer;
      buffer = [];
      for (const message of held) {
        try {
          window.postMessage(message, window.location.origin);
        } catch (_) {
          /* ignore */
        }
      }
      return;
    }

    /* ---- fetch on the content script's behalf ------------------------ *
     *
     * THE REASON THIS EXISTS.
     *
     * Since Chrome 85 a fetch from an isolated-world content script is routed
     * through the EXTENSION's CORS identity. The cookies still go, but the
     * request no longer looks like the page asking for its own data — and
     * Shopee answers every one of them 403, with an auth-gate body rather
     * than a 404. Measured on a live page: identical request, isolated world
     * 403, this world 200. No special headers were needed; only the world.
     *
     * So the content script stopped fetching and asks here instead. This is
     * the page's own JavaScript context, so a same-origin request is
     * indistinguishable from one Shopee makes for itself.
     * ------------------------------------------------------------------ */
    if (d.kind !== 'request' || typeof d.id !== 'number') return;

    // Deliberately NOT a general-purpose proxy. Anything on the page can post
    // into this listener, so it will only ever fetch same-origin /api/ paths —
    // the ones this extension already has permission to read.
    let target;
    try {
      target = new URL(String(d.url || ''), location.origin);
    } catch (_) {
      return reply({ kind: 'response', id: d.id, ok: false, status: 0, error: 'bad url' });
    }
    if (target.origin !== location.origin || !/^\/api\//.test(target.pathname)) {
      return reply({ kind: 'response', id: d.id, ok: false, status: 0, error: 'refused' });
    }

    fetch(target.href, { credentials: 'include' })
      .then((res) => res.text().then((text) => {
        let json = null;
        try { json = JSON.parse(text); } catch (_) { /* not json */ }
        reply({ kind: 'response', id: d.id, ok: res.ok, status: res.status, json });
      }))
      .catch((err) => reply({
        kind: 'response', id: d.id, ok: false, status: 0,
        error: String((err && err.message) || err)
      }));
  });

  function relay(url, json) {
    if (!json || typeof json !== 'object') return;
    post({ kind: 'api', url: String(url), json, at: Date.now() });
  }

  function relayText(url, text) {
    try {
      relay(url, JSON.parse(text));
    } catch (_) {
      /* not JSON — ignore */
    }
  }

  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (input, init) {
      const p = origFetch.apply(this, arguments);
      try {
        const url =
          typeof input === 'string' ? input : input && input.url ? input.url : '';
        if (WATCHED.test(url)) {
          // Cloned before reading: consuming the real response body would
          // starve the page of its own data and blank the reviews.
          p.then((res) => {
            try {
              res.clone().text().then((t) => relayText(url, t)).catch(() => {});
            } catch (_) {
              /* ignore */
            }
          }).catch(() => {});
        }
      } catch (_) {
        /* ignore */
      }
      return p;
    };
  }

  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    try {
      this.__srmeUrl = url;
    } catch (_) {
      /* ignore */
    }
    return origOpen.apply(this, arguments);
  };

  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function () {
    try {
      const url = this.__srmeUrl || '';
      if (WATCHED.test(url)) {
        this.addEventListener('load', () => {
          try {
            if (this.responseType === '' || this.responseType === 'text') {
              relayText(url, this.responseText);
            } else if (this.responseType === 'json' && this.response) {
              relay(url, this.response);
            }
          } catch (_) {
            /* ignore */
          }
        });
      }
    } catch (_) {
      /* ignore */
    }
    return origSend.apply(this, arguments);
  };
})();
