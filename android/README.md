# Real Android AppLock Native Source Code (Kotlin)

This folder contains the complete, production-ready Android Studio project for building a **Real OS-Level AppLock APK**.

---

## Why Native Android Code is Required for Real WhatsApp Locking

Web applications and browsers (Chrome, Safari) run in a sandboxed security model and are prohibited by the Android OS from intercepting or drawing over external native apps like WhatsApp, Facebook, or phone Settings.

To achieve **real app locking**, this project implements:
1. **Accessibility Service (`AppLockAccessibilityService.kt`)**: Detects the moment any app (WhatsApp, Photos, etc.) enters the foreground.
2. **System Alert Overlay (`LockScreenOverlayActivity.kt`)**: Draws the security PIN/Pattern/Biometric screen over the target application before the user can view its contents.
3. **`QUERY_ALL_PACKAGES`**: Dynamically reads all applications installed on the user's phone.
4. **Intruder Selfie Trigger**: Uses the front camera when wrong attempts are detected.

---

## How to Build the APK in Android Studio (3 Simple Steps)

### Step 1: Open the Project
1. Download this `/android/` directory (or click **"Download Android Studio Project (.ZIP)"** in the web app).
2. Open **Android Studio** (Koala, Iguana, Hedgehog, or newer).
3. Select **File > Open** and choose the `android` folder.

### Step 2: Sync Gradle
Android Studio will automatically detect the Gradle files (`build.gradle.kts`, `settings.gradle.kts`) and download all required AndroidX dependencies (`androidx.biometric`, `androidx.camera`, `androidx.appcompat`).

### Step 3: Build the `.apk`
1. Go to top menu: **Build > Build Bundle(s) / APK(s) > Build APK(s)**.
2. Once complete, Android Studio will display a pop-up saying **"APK(s) generated successfully"**.
3. Click **locate** to find your ready-to-install file:
   ```
   app/build/outputs/apk/debug/app-debug.apk
   ```
4. Copy `app-debug.apk` to any Android mobile phone and install it!

---

## Permissions Setup on the Phone
When you launch the app on your phone for the first time:
1. Tap **"1. Grant Display Over Other Apps"** (Allows the lock screen to show over WhatsApp).
2. Tap **"2. Enable Accessibility Service"** (Allows detecting when WhatsApp is opened).
3. Tap **"3. Grant Usage Access"**.
4. Select the apps you want to lock from your phone's real apps list.

---

## 📚 Book Learning on Unlock (PDF micro-learning)

Give the app any PDF book, in any language. Each time you unlock your phone, a small card shows
**one slide** from the book for a few seconds (5 by default): a one-line key idea plus a very
short explanation. The slides follow the book in order, starting with the introduction, so you
work through the whole book a few seconds at a time.

### How it works
1. **Import:** the PDF is copied into app storage and uploaded to Gemini's Files API, so Gemini can
   read any language, including scanned books.
2. **Structure:** Gemini maps out the book in reading order as chapters → small sections
   (about 1–5 pages each).
3. **Slides:** each section becomes 3–8 micro-slides (headline ≤ 12 words, detail ≤ 25 words).
   They are generated a few sections at a time, and more are fetched in the background
   when fewer than 10 unread slides are left.
4. **Pop-up:** the accessibility service listens for the unlock event (`ACTION_USER_PRESENT`)
   and shows the next slide as an accessibility overlay. It can also show one every N minutes
   while you use the phone.
   - Tap the card → next slide · ✕ → close · it fades away on its own after the timer.

### Setup on the phone
1. Open the app → **📚 Learn a Book on Every Unlock**.
2. Paste a Gemini API key (free at https://aistudio.google.com/apikey) and tap **Save settings**.
   - *Slides language*: leave empty to use the book's own language, or type e.g. `Urdu`, `Hindi`, `English`.
3. Tap **Enable Accessibility Service** and turn on *AppLock & Vault*.
4. Tap **➕ Import PDF book**, pick your PDF, and wait for "ready".
5. Lock and unlock your phone. 🎉

Code: `app/src/main/java/com/applock/vault/learn/`.
