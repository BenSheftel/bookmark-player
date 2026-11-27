# Bookmark Player

Offline music player with per-song timestamp bookmarks. One web app (`www/`), shipped two ways:

- **Android**: APK built with Capacitor (`BookmarkPlayer.apk`), sideloaded.
- **iPhone / any browser**: install as a PWA (iOS can't sideload APKs).

Songs you add are **copied into the app's storage** (IndexedDB), along with their bookmarks and the last-played position, so everything is there next time and works fully offline. Removing a song from the app never touches the original file.

## Install on Android
1. Copy `BookmarkPlayer.apk` to the phone and tap it.
2. Allow "Install unknown apps" for the app you opened it with (Files, Chrome, etc.) when prompted.

## Install on iPhone (PWA)
The `www/` folder needs to be served over HTTPS once (e.g. GitHub Pages, Netlify drop, Cloudflare Pages). Open it in **Safari** → Share → **Add to Home Screen**. After the first load it works offline.

## Develop / rebuild
```powershell
npm run serve          # http://localhost:5199 for testing in a browser
```
Rebuild the APK after changing `www/`:
```powershell
$env:JAVA_HOME="$env:USERPROFILE\.android-build\jdk"; $env:ANDROID_HOME="$env:USERPROFILE\.android-build\sdk"
npx cap sync android
cd android; .\gradlew.bat assembleDebug; cd ..
Copy-Item android\app\build\outputs\apk\debug\app-debug.apk BookmarkPlayer.apk
```
The toolchain (JDK 21 + Android SDK) lives in `%USERPROFILE%\.android-build`. Delete that folder to remove it.
`node scripts/make-icons.js android` regenerates icons/splash (run after `npx cap add android`).
