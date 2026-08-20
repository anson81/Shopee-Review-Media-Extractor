# ⭐ Shopee Review Media Extractor

Pulls the photos and videos buyers left on a Shopee product page, plus the
listing's own images, and saves them as one zip.

No page limit. A product with 300 reviews gives you all 300.

---

## Install

**1. Download**

[⬇ Download the extension](https://github.com/anson81/Shopee-Review-Media-Extractor/archive/refs/heads/main.zip)

**2. Unzip it, and keep the folder somewhere safe**

Documents is a good spot. **Not** Downloads — Chrome reads from this folder
every time you use the extension, so it must not be deleted or moved later.

**3. Add it to Chrome**

1. Type `chrome://extensions` in the address bar
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked** (top left)
4. Choose the folder you unzipped

The orange icon appears in your toolbar. Pin it if you like.

> Chrome may show a popup saying *"Disable developer mode extensions"* when it
> starts. That is normal for extensions installed this way — just close it.

---

## Using it

1. Open any Shopee product page
2. Click the orange icon
3. Choose what you want, then click **Find media**
4. Pick the files you want from the grid, then **Export selected**

Both Shopee product address styles work:

```
shopee.com.my/Some-Product-i.123456.7890123
shopee.com.my/product/123456/7890123/
```

**Log in to Shopee first.** A signed-out page shows fewer reviews, and Shopee
sometimes replaces the page heading with a verification prompt.

### Review pages

`all` for every page, or a range like `1-20`. A range starting later — `5-10` —
starts at page 5.

Each page is 50 reviews, so `1-2` is a quick way to test before a long run.

### The picker

Everything is selected when it opens. Untick what you do not want.

When a run has both kinds of media you get tabs — **Review media** and
**Product content** — so a handful of listing photos is not lost among three
hundred buyer photos.

**Saved file names** changes the names of the files inside the zip, and shows
an example of what you will get. It has no effect on this screen, which is why
it shows the example.

> The type filter hides tiles but does not deselect them. If a filter is
> hiding something you have selected, the counter says so.

---

## Where the files go

Two options, in **Settings**. They have a real trade-off.

### Into a folder you choose *(default)*

Nothing can rename your files. Other extensions that handle downloads can
otherwise rename them mid-save — that is how exports end up called
`download (2).zip`.

The cost: **Chrome cannot open that folder for you afterwards.** No extension
is allowed to open an arbitrary folder. The popup shows the path instead.

### Through Chrome downloads

You get an **Open folder** button after each export.

The cost: another extension holding the downloads permission can rename the
file.

Either way, each run goes into its own dated folder, so exporting the same
product twice never overwrites the first one.

---

## What is inside the zip

```
reviews/           buyer photos and videos
product/           main images, variant images, product video
description/       description text and any images in it
reviews.csv        one row per review: page, date, stars, buyer, variant, comment
```

There is deliberately **no folder named after the product inside the zip**.
Windows already creates one when you extract, and a second copy of a long
Shopee title makes the path too long for Windows to extract at all.

---

## Updates

The popup shows the version and checks GitHub for a newer one.

When an update exists, click **Update** and the extension replaces its own
files. You will be asked to pick its folder once so it has permission to write
there.

---

## If something goes wrong

**"The extension was updated or reloaded"** — reload the Shopee tab. Reloading
an extension leaves the old code running in pages that were already open.

**Find media does nothing** — reload the Shopee tab and try again.

**Reviews come back empty** — check you are logged in to Shopee, then use
**Settings → Diagnostics → Run probe**. It reports exactly what Shopee's
endpoints returned, which is usually enough to say what changed.

**The zip is named after something odd** — you were probably signed out when it
ran.

---

## Being gentle with Shopee

A big run makes hundreds of requests from your logged-in account, and asking
too fast is what gets an account rate limited. The defaults pause between
review pages and download four files at a time. Raise them only if a run is
being refused.

---

## Known limits

- **Product content is the least tested part.** Review media has been run
  against live products many times; main images, variant images and product
  videos far less.
- **Open folder only works in downloads mode**, for the reason above.
- Description *images* are only found when the seller pasted image links into
  the description text.

---

## For developers

```
node tools/test-zip.js                     the zip writer, incl. ZIP64 and UTF-8 names
node tools/test-naming.js                  filenames, collisions, Windows MAX_PATH
node tools/test-api.js                     paging, backoff, endpoints
node tools/test-csv.js                     CSV escaping
node tools/test-no-filename-listener.js    guards a rule that must never be broken
node tools/test-db-version.js              the three IndexedDB openers must agree
node tools/test-picker-layout.js           the four declarations the grid depends on
```

Two harnesses render the UI without installing anything. Serve the folder and
open them:

```
tools/picker-harness.html    the picker, with fake media
tools/popup-harness.html     the popup, against a stubbed chrome API
```

Both fetch their markup from the real files, so they cannot drift.

### Releasing

```
.\tools\make-release.ps1 -Version 1.3.2 -Notes "What changed"
git add -A; git commit -m 'v1.3.2'; git push
```

It runs the tests, refuses to reship an unchanged version number, and
regenerates `update.json` from what is actually on disk — so the updater's file
list can never fall out of step with the extension.
