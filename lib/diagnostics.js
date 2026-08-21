/**
 * The report a user copies when something goes wrong on a machine nobody can see.
 *
 * WHY THIS EXISTS.
 *
 * Every bug this extension has had was diagnosed by asking someone to describe
 * what they saw, and the descriptions were wrong more often than not - not
 * because anyone was careless, but because the useful facts are invisible from
 * the front. "It downloaded 9 out of 10" turned out to be a healthy run whose
 * check was reading the wrong download. "The files went loose into Downloads"
 * turned out to be another extension answering Chrome about our files.
 *
 * The extension already knew every one of those facts at the time. They sat in
 * chrome.storage.local on someone else's PC and never reached anyone who could
 * read them, so each was rediscovered from scratch, twice.
 *
 * This turns them into text on the clipboard.
 *
 * DESIGN NOTES.
 *
 * Plain text, not JSON. It gets pasted into a chat window by a person, and a
 * person should be able to read what they are sending before they send it.
 *
 * Pure and synchronous: every input is passed in, including the clock. That is
 * what makes it testable at all - see tools/test-diagnostics.js - and it means
 * this file cannot be the reason a report fails to appear.
 *
 * Nothing here touches the network. The transport is the user's clipboard, on
 * purpose: they can see it, and it cannot reach anywhere they did not paste it.
 */
(function (root, factory) {
  const api = factory();
  root.SRME_Diagnostics = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : self, function () {
  'use strict';

  /**
   * Take the person's name out of the paths.
   *
   * The home directory is the one genuinely personal thing a run record
   * carries, and it is never what a bug turns on - the folder STRUCTURE is, and
   * that is kept. Masking the name means the report can be forwarded without a
   * second thought.
   *
   * Windows, macOS and Linux each spell it differently, so all three are
   * handled rather than the one the developer happens to be sitting at.
   */
  function maskPaths(text) {
    if (typeof text !== 'string' || !text) return '';
    return text
      .replace(/([A-Za-z]:\\Users\\)[^\\\/]+/g, '$1<you>')
      .replace(/(\/Users\/)[^\/]+/g, '$1<you>')
      .replace(/(\/home\/)[^\/]+/g, '$1<you>');
  }

  function when(ts, now) {
    if (!ts) return 'unknown time';
    const ms = now - ts;
    if (ms < 0) return new Date(ts).toISOString();
    const mins = Math.round(ms / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + ' min ago';
    const hrs = Math.round(mins / 60);
    if (hrs < 48) return hrs + ' h ago';
    return Math.round(hrs / 24) + ' days ago';
  }

  function line(label, value) {
    const empty = value === undefined || value === null || value === '';
    return label + ': ' + (empty ? '(not set)' : String(value));
  }

  /**
   * Build the whole report.
   *
   * Every section is optional. A worker that has just woken with nothing in
   * storage still produces something useful, because "there is no history" is
   * itself an answer to the question being asked.
   */
  function buildReport(input) {
    const i = input || {};
    const now = i.now || 0;
    const out = [];

    const ext = i.extension || {};
    out.push('=== ' + (ext.name || 'extension') + ' diagnostics ===');
    out.push(line('Version', ext.version));
    out.push(line('Extension id', ext.id));
    out.push(line('Copied at', now ? new Date(now).toISOString() : '(no clock)'));
    out.push(line('Browser', i.browser));
    out.push(line('System', i.platform));

    out.push('');
    out.push('--- settings ---');
    const folder = i.folder || {};
    // `null` means this extension has no reports-folder feature at all. Printing
    // "no" there invites someone to go and turn on a setting that does not
    // exist - the first live report said exactly that about the Shopee
    // downloader, which has never had the option.
    out.push(line('Reports folder chosen',
      folder.chosen === null
        ? 'not offered by this extension'
        : folder.chosen
          ? 'yes: ' + maskPaths(folder.name || '(unnamed)')
          : 'no'));
    out.push(line('Extension folder granted', folder.extensionFolderGranted ? 'yes' : 'no'));
    if (i.updateSource) {
      const u = i.updateSource;
      out.push(line('Updates from', [u.owner, u.repo, u.branch].filter(Boolean).join('/')));
    }
    if (i.updateInfo) {
      const up = i.updateInfo;
      out.push(line('Latest seen on GitHub', up.latest));

      // The three extensions stamp this differently - `checkedAt` in one, `at`
      // in another - and the third does not stamp it at all. Reading only one
      // spelling made the first live report say "(never)" about a check that
      // had plainly just happened, since it also printed the version it found.
      //
      // A missing stamp is not evidence of never having checked, so it does not
      // get to say so. Same rule as "none seen" versus "not collected".
      const stamp = up.checkedAt || up.at || null;
      out.push(line('Last update check',
        stamp ? when(stamp, now) : 'not recorded by this extension'));

      if (up.error) out.push(line('Update check error', up.error));
    }

    // THE SECTION THAT WOULD HAVE ENDED THE AUGUST 2026 HUNT IN MINUTES.
    //
    // Chrome asks every extension holding the downloads permission about every
    // download, and hands over the asking extension's id for free. Recording
    // the ids we abstain on costs one property write and needs no extra
    // permission - notably NOT "management", which would make the install
    // warning say this extension reads the list of installed extensions.
    //
    // A machine where downloads misbehave and this list is empty has a
    // different problem from one where it names a sibling.
    //
    // NULL AND EMPTY MEAN DIFFERENT THINGS, AND THE DIFFERENCE MATTERS.
    //
    // "none seen" is evidence: this machine watched, and nothing else touched a
    // download. "not collected" is the absence of evidence, and reporting the
    // second as the first would send whoever reads this looking somewhere else
    // entirely. The Review Media Extractor registers no filename listener at
    // all - on purpose - so it has nothing to report here, and must say so in
    // those words.
    out.push('');
    out.push('--- other extensions seen handling downloads ---');
    const others = i.otherExtensions === null ? null : (i.otherExtensions || []);
    if (others === null) {
      out.push('not collected - this extension registers no filename listener, by design');
    } else if (!others.length) {
      out.push('none seen since this worker started');
    } else {
      for (const o of others) {
        out.push('  ' + (o.id || '?') + '  ' + (o.count || 0) +
          ' download(s), last ' + when(o.lastAt, now));
      }
    }

    // WHY THE LISTENER DID WHAT IT DID.
    //
    // The sightings above answer "was anyone else involved". They cannot answer
    // "why did OUR file end up loose", because Chrome never says who else
    // answered - and on 21 Aug 2026 the answer turned out to be that nobody
    // did, including us. decideDownloadPath has several ways to decline and the
    // report could not tell them apart, so it guessed, and blamed a download
    // manager that had not touched the file.
    if (i.decisions && i.decisions.length) {
      out.push('');
      out.push('--- what the filename listener decided ---');
      for (const d of i.decisions.slice(0, i.decisionLimit || 12)) {
        out.push('  ' + when(d.at, now) + '  ' + (d.name || '(no name yet)'));
        out.push('      ' + maskPaths(String(d.reason || '(no reason)')));
        if (d.byExt) out.push('      started by extension ' + d.byExt);
      }
    }

    // Explicitly `null`, never merely missing: a worker that simply has not
    // loaded storage yet is a different situation from one that never collects
    // this, and only the caller knows which it is.
    out.push('');
    out.push('--- recent runs ---');
    const history = i.history === null ? null : (i.history || []);
    if (history === null) {
      out.push('not kept - this extension records no run history');
    } else if (!history.length) {
      out.push('no runs recorded');
    } else {
      for (const h of history.slice(0, i.historyLimit || 5)) {
        out.push('');
        out.push('  ' + when(h.at, now) + (h.covers ? '   (covering ' + h.covers + ')' : ''));
        if (h.folder) out.push('    folder:     ' + maskPaths(h.folder));
        if (h.runFolder) out.push('    run folder: ' + maskPaths(h.runFolder));
        if (h.error) out.push('    RUN ERROR:  ' + maskPaths(h.error));
        for (const r of h.reports || []) {
          // The three extensions spell a report record slightly differently -
          // name/error here, label/message there. Reading both keeps one
          // builder shared across all of them, which is worth more than making
          // three copies agree by hand forever.
          const title = r.name || r.label || r.id || '?';
          const why = r.error || r.message || '';
          const bits = ['   ', (r.status || '?').padEnd(9), String(title)];
          if (r.filename) bits.push('-> ' + maskPaths(r.filename));
          if (r.landedAt) bits.push('[landed ' + maskPaths(r.landedAt) + ']');
          // Only when the message does not already say it. SiteGiant's message
          // field IS the counts, so printing both put the same three numbers on
          // two consecutive lines in the first live report.
          if (r.counts && !why) {
            bits.push('(' + [
              r.counts.created + ' new',
              r.counts.updated + ' updated',
              r.counts.unchanged + ' unchanged'
            ].join(', ') + ')');
          }
          out.push(bits.join(' ').replace(/\s+$/, ''));
          if (why) out.push('              ' + maskPaths(String(why)));
        }
      }
    }

    if (i.notes && i.notes.length) {
      out.push('');
      out.push('--- notes ---');
      for (const n of i.notes) out.push('  ' + maskPaths(String(n)));
    }

    out.push('');
    out.push('=== end ===');
    return out.join('\n');
  }

  return {
    buildReport: buildReport,
    maskPaths: maskPaths
  };
});
