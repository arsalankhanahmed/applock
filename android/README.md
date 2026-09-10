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
