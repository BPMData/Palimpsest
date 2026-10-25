# Getting Palimpsest onto the iPad

Palimpsest runs on Android today. The plan is to ship it on iPad too. This page collects everything we know about that, so the work can start quickly once there's an iPad (and a Mac) to test on.

## What GitHub already checks for us, for free

Every build runs all the browser tests in **WebKit**, the engine inside Safari and inside every iPad app. A failure there **never blocks a merge**. Instead:

- the run's summary page shows a to-do list, with each failing test and its error;
- the run has a **webkit-report** download (kept 90 days) with a screenshot of each failure and a step-by-step replay (drop `trace.zip` onto https://trace.playwright.dev);
- on `main`, one open GitHub issue labelled **ipad** stays up to date with the current list. It gets a comment whenever the list changes, and closes itself when everything passes.

This WebKit runs on Linux, which is close to an iPad but not the same. A pass there means "probably fine", not "tested on iPad". Everything below needs a real device.

## What has to be built first

1. **The iOS app project.** `npx cap add ios`, then build it in Xcode. This needs a Mac. GitHub's macOS runners can build it too, but installing on a device needs an Apple Developer account ($99 a year, which you also need to sell on the App Store).
2. **A native plugin with the same methods as Android's**, so nothing in `www/` has to change (see the list at the top of `www/js/source.js`):
   - `pickFolder` / `restore`: `UIDocumentPickerViewController` for folders. Save a *security-scoped bookmark* so the folder still works after a restart (Apple's version of Android's persisted permission).
   - `list`, `read`: read through that bookmark. Wrap every read in `startAccessingSecurityScopedResource` / `stop…`.
   - `saveFile`: write to a temporary file, then show `UIDocumentPickerViewController(forExporting:)`, the "Save to Files" screen. The writer's `close()` is the moment to show it. `abort()` deletes the temporary file.
3. **Pen settings that make sense for an Apple Pencil** (see below).

## Things to try on a real iPad

Tick these off the first time through, and add anything new you find.

**Apple Pencil**
- [ ] The Pencil writes and fingers turn pages (the web view should report the Pencil as `pointerType: "pen"`).
- [ ] Pressure changes the line the way it does on Android.
- [ ] **The Apple Pencil has no eraser end.** Decide what replaces it: the Pencil 2 double-tap or the Pencil Pro squeeze (both need a small native bridge; the web view doesn't see them), or just the on-screen Erase button.
- [ ] Hovering the Pencil (newer iPads) doesn't draw anything.
- [ ] A palm resting on the screen while writing doesn't turn the page.

**Gestures**
- [ ] Swiping from the screen's left edge turns the page and doesn't trigger iOS's "go back" swipe.
- [ ] Pinch zoom and double-tap zoom work, and the page doesn't zoom the whole app instead.
- [ ] The Library button is easy to find. iPads have no Back button, so it's the only way out of a book.

**Memory and size**
- [ ] Open the biggest CBR you have. iPad apps are shut down harder than Android ones when they use too much memory. If it crashes, the fix is to unpack RAR pages on demand instead of all at once.
- [ ] Zoom all the way in on a big PDF page. iPad Safari has a hard limit on canvas size (about 16.7 megapixels). `MAX_PIXELS` in `books.js` is already set just under it.
- [ ] Notes are still there after the iPad has been low on storage. Consider asking for persistent storage (`navigator.storage.persist()`).

**Files**
- [ ] Picking a folder in iCloud Drive and in "On My iPad" both work, and still work after restarting the app.
- [ ] Books that iCloud hasn't downloaded yet show up and download when opened (or say clearly that they need downloading).
- [ ] Save as CBZ shows "Save to Files" and the copy appears in the library.

**Screen**
- [ ] Nothing hides under the rounded corners or the home bar (safe areas).
- [ ] Split View, Slide Over and Stage Manager windows of any size lay out properly.
- [ ] Keyboard shortcuts work with a Magic Keyboard (arrows, Ctrl or Cmd + Z).

**App Store**
- [ ] The app downloads no code (it doesn't: everything, including the WebAssembly, ships inside it).
- [ ] If it's paid or sells upgrades, Apple's in-app purchase rules apply. Decide the pricing before building any purchase screens.
