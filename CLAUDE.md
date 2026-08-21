# Shopee Review Media Extractor — working notes

Chrome MV3 extension. Extracts review images, review videos and product content
from Shopee product pages. Plain JavaScript, no build step, no dependencies.

## Never register a filename listener

This extension **must not** call `chrome.downloads.onDeterminingFilename`. Not
even to say "no opinion".

`onDeterminingFilename` is browser-wide: Chrome asks every extension holding the
`downloads` permission about every download, and gives the final say to the most
recently installed one that answers. `suggest()` with no arguments **is an
answer** — it tells Chrome to use the name it guessed from the URL. So a
listener here that politely abstained would override whichever sibling did have
an opinion, and their exports would start arriving as `download.zip` again.

That is not hypothetical. SiteGiant Downloader and Shopee CPM Report Downloader
did exactly this to each other through August 2026, and this extension is the
third one on the same machine.

The primary save path writes through a `FileSystemDirectoryHandle`, where
Chrome's naming never runs at all. The `downloads` permission is legitimate — the
fallback path needs it when no folder has been chosen — but the listener stays
absent.

`tools/test-no-filename-listener.js` enforces this, and defeats the spellings
that have got past a plain substring scan before (bracket access, concatenated
names). It also proves itself on each of them, so a guard that has quietly
stopped looking cannot pass silently.

## The IndexedDB version is shared

`options.js`, `background/background.js` and `offscreen/offscreen.js` all open
the same database and must agree on the version. They once did not: IndexedDB
throws `VersionError` on a lower version, so once a single export had run the
Options page could no longer read or write the output folder handle — the picker
still appeared to work and saved nothing. `tools/test-db-version.js` checks the
invariant that lives between the three files.

## When someone reports a problem

**Ask for the diagnostics paste before guessing.** Options -> Copy diagnostics
puts it on their clipboard; they paste it into the chat. It is one click and it
ends most of the guessing this project has done historically.

It carries the version, the browser, whether a folder is set, the last few runs
with every per-report error, and - on the two extensions that have a filename
listener - the ids of any other extensions that have been handling downloads.
That last section is why this exists: it is the fact the August 2026 filename
hunt lacked, and the hunt took a fortnight and blamed two innocent parties.

Read it carefully, in particular:

- **"none seen" and "not collected" are different claims.** The first is
  evidence that nothing else touched a download on that machine. The second
  means nobody looked - the Review Media Extractor registers no listener, by
  design, so it always reports the second. Treating one as the other sends you
  looking in the wrong place.
- **The home directory name is masked to `<you>`; the folders below it are
  not.** That is deliberate. The structure is where the answer usually is.
- **Nothing is sent anywhere.** The transport is the user's clipboard, and the
  page shows them the text before they copy it. Do not quietly turn this into
  an upload: these reports carry shop names and order counts, and that decision
  is Anson's to make, not one to arrive at by default.

`lib/diagnostics.js` is shared across all three extensions and is pure - it
takes its clock as an argument - so `tools/test-diagnostics.js` can check the
whole report without a browser. That test also checks the button is really
wired: a button that does nothing looks fine and fails silently, on a page
someone only opens when they are already in trouble.

## Releasing

There is no Chrome Web Store here. Every machine installs this extension by
hand from the GitHub branch and updates itself from that same branch:
`checkUpdate()` fetches `update.json`, compares its `version` against the
running manifest, and if it is higher the Options page downloads every path in
`update.json`'s `files` list and writes them into the extension folder.

Three things follow, and all three have been got wrong:

1. **Bump `manifest.json` AND `update.json` together.** `checkUpdate()` reads
   only `update.json`. Leave it behind and no machine is ever offered the fix —
   silently. Nothing errors; the old code just keeps running.
2. **Add every new shipped file to `update.json`'s `files`.** The installer
   downloads exactly that list. A file left out is never delivered, so machines
   end up running new code beside old.
3. **Push.** The updater reads `raw.githubusercontent.com` on the branch. A
   commit sitting on one PC does not exist as far as every other PC is
   concerned. A finished fix once sat unpushed for three days while machines
   ran the bug it fixed.

Write a plain-English line into `update.json`'s `notes` — it is what the user
sees in the update prompt. Describe what they will notice, not what changed in
the code.

## Tests

    node tools/test-<name>.js

Every one of them runs in CI on every push (`.github/workflows/tests.yml`), and
each was written after a bug that had already shipped. Run them before pushing
anyway — CI tells you after the fact, and the machines poll this branch.

If you are about to change how downloads are named or where files land, run the
filename tests first, and again after. That is the code with the worst history
in this repo.
