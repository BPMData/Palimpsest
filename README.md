# Palimpsest
An e-reader that fucking lets you fucking annotate your own shit fucking properly, God.

## What it does

- **Your library, as folders.** Pick the folder where you keep your comics and books once. Palimpsest shows its folders and covers, remembers your page in every book, and keeps a **Continue reading** row.
- **Reads PDF, CBZ, CBR, CB7, CBT and comic EPUBs** (the fixed-layout kind Humble Bundle and Kobo sell), plus **folders of loose pictures** as comics. One page at a time, or two-page spreads in landscape (the cover on its own). Text EPUBs (novels) come later.
- **Save as CBZ.** A CBR, CB7 or picture folder can be saved as a CBZ copy, which opens faster and works in any comic app. Your notes and place come along; the original is never touched.
- **Shows every file, even ones it can't open.** A copy-protected or text EPUB is dimmed and says why; a Kindle book or other file is listed under **Other files** with a hint.
- **Write on the page with your stylus.** Pen, highlighter (it goes *under* the printed lines, so they stay readable) and eraser; the pen's eraser end works too. Undo and redo. Notes stay on your device and stay put when you zoom.
- **Fingers turn pages, the pen writes.** Tap the edges or swipe to turn, pinch or double-tap to zoom, tap the middle to hide the bars. No stylus? Turn on **Finger draws**.
- **Private.** No account, no internet permission at all. It can only read the one folder you choose, and only writes a file when you save one through the system's own "Save as" screen.

## Install on your Android tablet

1. Get `app-debug.apk`: from the latest run under **Actions → Test and build the APK** (the *palimpsest-apk* download), or build it yourself (below).
2. Copy it to the tablet and tap it. Android will ask you to allow installs from that app (Files, Chrome, Drive…) once.
3. Open Palimpsest and choose your comics folder.

New builds install over the old one and keep your notes, because every test build is signed with the same key.

## Build it yourself

```
npm ci
npm test                      # browser tests
npx cap sync android
cd android && ./gradlew assembleDebug
```

The APK lands in `android/app/build/outputs/apk/debug/`. You need Node 22, Java 21 and the Android SDK (Android Studio installs it).

## License

MIT. The ink engine comes from [OverBoard](https://github.com/BPMData/OverBoard).
