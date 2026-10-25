# Palimpsest: notes for Claude

- **What it is.** A comic and ebook reader for tablets with pen annotation and a real library. Android first; iPad later (it may become a paid app), so keep platform code behind the source interface in `www/js/source.js`. The app is plain web code in `www/` (ES modules, no build step) wrapped by Capacitor 8 (`android/`). The same `www/` runs in desktop Chrome/Edge, which is how the tests run.
- **The owner is a teacher, not a full-time developer.** Plain-language commit messages, comments and docs. Python tools (`tools/*.py`) keep their settings as variables at the top (he runs them in Thonny, not a terminal).
- **Ink is ported from OverBoard** (`www/js/ink-core.js` ← github.com/BPMData/OverBoard `shared/ink-core.js`). Keep the two close so fixes can move across. Strokes are in page units (page width = 1000).
- **Input rule:** the pen writes (its eraser end erases); fingers navigate (tap edges, swipe, pinch, double-tap) unless "Finger draws" is on; touches are ignored while the pen is down.
- **Play Store from day one:** no "All files access" and no permissions. Folder access goes only through the Storage Access Framework (`LibraryPlugin.java`: pick a folder once, persisted permission, one query per folder). The library folder is **read-only**. The one write, "Save as CBZ", goes through the system "Save as" screen (`ACTION_CREATE_DOCUMENT`), so the app can write only the new file the reader names; it never changes or deletes existing files. App ID `io.github.bpmdata.palimpsest` must never change. Target the current Android API.
- **Storage:** IndexedDB (`www/js/store.js`). A book's key is file name + size, so moving folders keeps notes.
- **Signing:** `android/keystores/debug.jks` (password `android`) signs test builds so each one installs over the last. A Play release key must never be committed.
- **Vendored libraries** in `www/vendor/` (PDF.js 4.10.38, fflate 0.8.3, libarchive.js 2.0.2 for CBR/CB7/CBT, loaded only when one opens), copied from `node_modules`; the app never loads anything from the internet.
- After changing `www/`, run `npx cap sync android` before building the APK.
- Tests: `npm ci && npm test` (Playwright; a fake library folder from `tests/fixtures/library/`, made by `tools/make_fixtures.py`). APK: `cd android && ./gradlew assembleDebug` (add `--max-workers=1` if Maven Central answers 429).
