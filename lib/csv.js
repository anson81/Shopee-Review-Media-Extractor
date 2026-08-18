/**
 * CSV writing for reviews.csv.
 *
 * Review comments are the worst input a CSV can get: buyers write commas,
 * quotes, newlines and emoji, in Malay, Chinese and Thai. Everything here
 * exists because one of those breaks a naive join(',').
 *
 * Loaded via importScripts() in the service worker and require() in tests.
 */
(function (root, factory) {
  const api = factory();
  root.SRME_Csv = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : self, function () {
  'use strict';

  /**
   * Excel decides a leading =, +, - or @ makes a field a formula, and will
   * run it. A buyer who writes "=1+1" in a review should not become a
   * spreadsheet expression on the seller's machine, so those fields get a
   * leading apostrophe — the standard way to force Excel to treat the rest
   * as text. The apostrophe is not shown in the cell.
   *
   * Tab and carriage return are included because Excel skips leading
   * whitespace when it looks for the trigger character.
   */
  function defuseFormula(value) {
    return /^[\t\r ]*[=+\-@]/.test(value) ? "'" + value : value;
  }

  /**
   * Quote one field per RFC 4180.
   *
   * A field needs quoting if it contains the delimiter, a quote, or a line
   * break — and also if it has leading or trailing spaces, which some readers
   * silently trim. Inner quotes are doubled.
   */
  function escapeField(input) {
    // Lone \r inside a quoted field confuses readers that split on \r\n.
    const raw = (input == null ? '' : String(input)).replace(/\r\n?/g, '\n');
    const defused = defuseFormula(raw);

    // Decided on the ORIGINAL, not the defused copy. Prepending the
    // apostrophe first would hide a leading space behind it, and a reader
    // that trims edge whitespace would then silently alter the value. A
    // defused field is always quoted as well, so they all look the same.
    const mustQuote =
      /[",\n]/.test(raw) || /^\s|\s$/.test(raw) || defused !== raw;
    if (!mustQuote) return raw;

    return '"' + defused.replace(/"/g, '""') + '"';
  }

  /** One row, already escaped, with the CRLF that RFC 4180 asks for. */
  function row(fields) {
    return fields.map(escapeField).join(',') + '\r\n';
  }

  /**
   * Build a whole CSV document.
   *
   * The byte order mark is not decoration: without it Excel on Windows reads
   * a UTF-8 file as the local codepage, and every non-Latin buyer name in a
   * Shopee export turns to mojibake. Readers that do not want it strip it.
   */
  function build(headers, rows) {
    const BOM = '﻿';
    return BOM + row(headers) + rows.map(row).join('');
  }

  const REVIEW_HEADERS = [
    'page', 'review', 'date', 'stars', 'buyer', 'variant', 'comment', 'files'
  ];

  /**
   * reviews.csv from the reviews that contributed exported media.
   *
   * reviews: [{ page, reviewIndex, date, stars, buyer, variant, comment,
   *             files: [string] }]
   * Multiple filenames share a cell, separated by "; " — one row per review
   * keeps the file readable, and the separator is chosen because a filename
   * cannot contain it after sanitising.
   */
  function buildReviewsCsv(reviews) {
    const rows = reviews.map(function (r) {
      return [
        r.page,
        r.reviewIndex,
        r.date,
        r.stars,
        r.buyer,
        r.variant,
        r.comment,
        (r.files || []).join('; ')
      ];
    });
    return build(REVIEW_HEADERS, rows);
  }

  return {
    escapeField: escapeField,
    row: row,
    build: build,
    buildReviewsCsv: buildReviewsCsv,
    REVIEW_HEADERS: REVIEW_HEADERS
  };
});
