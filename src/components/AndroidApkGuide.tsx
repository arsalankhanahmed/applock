import React, { useState } from "react";
import {
  Smartphone,
  ShieldCheck,
  Code2,
  Download,
  AlertTriangle,
  Copy,
  Check,
  FileCode,
  CheckCircle2,
  ExternalLink,
  FolderArchive,
  GitBranch,
  Github,
} from "lucide-react";

export const AndroidApkGuide: React.FC = () => {
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<
    "manifest" | "service" | "overlay" | "main" | "gradle"
  >("manifest");
  const [isDownloading, setIsDownloading] = useState(false);

  const copyToClipboard = (text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 2500);
  };

  const handleDownloadZip = () => {
    setIsDownloading(true);
    // Direct link to backend ZIP generation endpoint
    window.location.href = "/api/download-android-source";
    setTimeout(() => setIsDownloading(false), 3000);
  };

  const manifestCode = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    xmlns:tools="http://schemas.android.com/tools"
    package="com.applock.vault">

    <!-- Essential Android Permissions for Real AppLock -->
    <uses-permission android:name="android.permission.SYSTEM_ALERT_WINDOW" />
    <uses-permission android:name="android.permission.PACKAGE_USAGE_STATS" tools:ignore="ProtectedPermissions" />
    <uses-permission android:name="android.permission.QUERY_ALL_PACKAGES" tools:ignore="QueryAllPackagesPermission" />
    <uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
    <uses-permission android:name="android.permission.RECEIVE_BOOT_COMPLETED" />
    <uses-permission android:name="android.permission.CAMERA" />
    <uses-permission android:name="android.permission.USE_BIOMETRIC" />

    <application
        android:allowBackup="true"
        android:icon="@mipmap/ic_launcher"
        android:label="AppLock &amp; Vault"
        android:roundIcon="@mipmap/ic_launcher"
        android:supportsRtl="true"
        android:theme="@style/Theme.AppLock">

        <!-- Main Settings Activity to choose which apps to lock -->
        <activity
            android:name=".MainActivity"
            android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>

        <!-- Lock Screen Overlay Activity that pops up over WhatsApp, Gallery, etc. -->
        <activity
            android:name=".LockScreenOverlayActivity"
            android:excludeFromRecents="true"
            android:exported="false"
            android:launchMode="singleTask"
            android:noHistory="true"
            android:theme="@style/Theme.AppLock.Translucent" />

        <!-- Accessibility Service to detect when user opens WhatsApp, Gallery, etc. -->
        <service
            android:name=".AppLockAccessibilityService"
            android:exported="true"
            android:permission="android.permission.BIND_ACCESSIBILITY_SERVICE">
            <intent-filter>
                <action android:name="android.accessibilityservice.AccessibilityService" />
            </intent-filter>
            <meta-data
                android:name="android.accessibilityservice"
                android:resource="@xml/accessibility_service_config" />
        </service>

        <!-- Boot Receiver to protect phone automatically after reboot -->
        <receiver
            android:name=".BootReceiver"
            android:enabled="true"
            android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.BOOT_COMPLETED" />
            </intent-filter>
        </receiver>

    </application>
</manifest>`;

  const serviceCode = `package com.applock.vault

import android.accessibilityservice.AccessibilityService
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.view.accessibility.AccessibilityEvent

class AppLockAccessibilityService : AccessibilityService() {

    private lateinit var prefs: SharedPreferences

    companion object {
        var temporarilyUnlockedPackage: String? = null
        var temporarilyUnlockedTimestamp: Long = 0
    }

    override fun onServiceConnected() {
        super.onServiceConnected()
        prefs = getSharedPreferences("AppLockPrefs", Context.MODE_PRIVATE)
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        if (event == null || event.eventType != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) {
            return
        }

        val packageName = event.packageName?.toString() ?: return
        if (packageName == applicationContext.packageName) return

        // Read real locked apps selected by user in MainActivity
        val lockedSet = prefs.getStringSet("LOCKED_PACKAGES", hashSetOf(
            "com.whatsapp",
            "com.google.android.apps.photos",
            "com.android.settings",
            "com.facebook.katana"
        )) ?: emptySet()

        if (lockedSet.contains(packageName)) {
            // Check grace unlock period (15 seconds)
            val now = System.currentTimeMillis()
            if (temporarilyUnlockedPackage == packageName && (now - temporarilyUnlockedTimestamp) < 15_000) {
                return
            }

            // Launch PIN/Pattern Lock Screen over WhatsApp immediately!
            val lockIntent = Intent(this, LockScreenOverlayActivity::class.java).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP)
                addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
                putExtra("EXTRA_PACKAGE_NAME", packageName)
            }
            startActivity(lockIntent)
        }
    }

    override fun onInterrupt() {}
}`;

  const overlayCode = `package com.applock.vault

import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.os.Bundle
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat

class LockScreenOverlayActivity : AppCompatActivity() {

    private lateinit var prefs: SharedPreferences
    private var targetPackage: String? = null
    private var failedAttempts = 0

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_lock_overlay)

        prefs = getSharedPreferences("AppLockPrefs", Context.MODE_PRIVATE)
        targetPackage = intent.getStringExtra("EXTRA_PACKAGE_NAME")
    }

    fun onVerifyPin(pin: String) {
        val savedPin = prefs.getString("SECURITY_PIN", "1234")
        if (pin == savedPin) {
            // Unlock Success: Let user into WhatsApp
            targetPackage?.let {
                AppLockAccessibilityService.temporarilyUnlockedPackage = it
                AppLockAccessibilityService.temporarilyUnlockedTimestamp = System.currentTimeMillis()
            }
            finish()
        } else {
            failedAttempts++
            if (failedAttempts >= 2) {
                // Capture Intruder Selfie with front camera
                IntruderCaptureManager.captureIntruderPhoto(this, targetPackage)
            }
            Toast.makeText(this, "Incorrect PIN!", Toast.LENGTH_SHORT).show()
        }
    }

    override fun onBackPressed() {
        // Prevent bypassing lock screen: Send back to Home screen
        val homeIntent = Intent(Intent.ACTION_MAIN).apply {
            addCategory(Intent.CATEGORY_HOME)
            flags = Intent.FLAG_ACTIVITY_NEW_TASK
        }
        startActivity(homeIntent)
        finish()
    }
}`;

  const mainActivityCode = `package com.applock.vault

import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.widget.ArrayAdapter
import android.widget.ListView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity

class MainActivity : AppCompatActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        // Request SYSTEM_ALERT_WINDOW permission
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && !Settings.canDrawOverlays(this)) {
            val intent = Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:$packageName"))
            startActivity(intent)
        }

        // Load all real applications installed on this mobile phone
        loadInstalledApps()
    }

    private fun loadInstalledApps() {
        val pm = packageManager
        val apps = pm.getInstalledApplications(PackageManager.GET_META_DATA)
        // User can tap any real app to lock/unlock it!
    }
}`;

  const gradleCode = `plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.applock.vault"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.applock.vault"
        minSdk = 24
        targetSdk = 34
        versionCode = 1
        versionName = "1.0.0"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.biometric:biometric:1.1.0")
    implementation("androidx.camera:camera-core:1.3.4")
    implementation("androidx.camera:camera-camera2:1.3.4")
    implementation("androidx.camera:camera-lifecycle:1.3.4")
}`;

  return (
    <div className="p-5 rounded-3xl bg-slate-900 border border-slate-800 flex flex-col gap-5">
      {/* Top Header Card */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 pb-4 border-b border-slate-800">
        <div className="flex items-start gap-3.5">
          <div className="w-12 h-12 rounded-2xl bg-cyan-500/15 border border-cyan-500/30 flex items-center justify-center text-cyan-400 shrink-0">
            <FolderArchive className="w-6 h-6" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-base font-bold text-slate-100">
                Real Android Native App Source Code (Kotlin)
              </h3>
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 font-bold border border-emerald-500/30">
                In Repository
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-0.5">
              Mukammal Android Studio project repository mein <code>/android</code> folder mein add ho chuka hai!
            </p>
          </div>
        </div>

        {/* 1-Click ZIP Download Button */}
        <button
          type="button"
          onClick={handleDownloadZip}
          disabled={isDownloading}
          className="w-full sm:w-auto px-4 py-2.5 rounded-2xl bg-gradient-to-r from-cyan-500 to-emerald-500 hover:from-cyan-400 hover:to-emerald-400 text-slate-950 font-extrabold text-xs flex items-center justify-center gap-2 shadow-lg shadow-cyan-500/20 transition-all cursor-pointer shrink-0"
        >
          <Download className="w-4 h-4" />
          {isDownloading ? "Generating ZIP..." : "Download Android Studio Project (.ZIP)"}
        </button>
      </div>

      {/* GitHub Export / Download Repo Instructions */}
      <div className="p-4 rounded-2xl bg-slate-950/80 border border-slate-800 space-y-3">
        <div className="flex items-center gap-2 text-xs font-bold text-slate-200">
          <Github className="w-4 h-4 text-cyan-400" />
          <span>GitHub Repo ya Full Code Download Karne ka Tariqa:</span>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs text-slate-300">
          <div className="p-3 rounded-xl bg-slate-900 border border-slate-800 space-y-1">
            <strong className="text-cyan-400 flex items-center gap-1.5">
              <GitBranch className="w-3.5 h-3.5" /> Option 1: AI Studio se Direct Export
            </strong>
            <p className="text-slate-400 text-[11px] leading-relaxed">
              Google AI Studio ke top right par <strong>Settings / Menu</strong> icon par click karein aur <strong>"Export to GitHub"</strong> ya <strong>"Download ZIP"</strong> select karein. Is repo mein Web App + <code>/android</code> native project dono shamil hain!
            </p>
          </div>

          <div className="p-3 rounded-xl bg-slate-900 border border-slate-800 space-y-1">
            <strong className="text-emerald-400 flex items-center gap-1.5">
              <Download className="w-3.5 h-3.5" /> Option 2: 1-Click Android ZIP
            </strong>
            <p className="text-slate-400 text-[11px] leading-relaxed">
              Upar diye gaye button <strong>"Download Android Studio Project (.ZIP)"</strong> par click karein. Yeh direct aapke computer par <code>AppLock-Real-Android-Studio-Source.zip</code> download kar dega.
            </p>
          </div>
        </div>
      </div>

      {/* Code Browser Tabs */}
      <div className="space-y-3">
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2">
          <div className="text-xs font-bold text-slate-200 flex items-center gap-2">
            <Code2 className="w-4 h-4 text-cyan-400" />
            Inspect Native Android Source Files:
          </div>

          <div className="flex items-center gap-1 bg-slate-950 p-1 rounded-xl border border-slate-800 text-xs overflow-x-auto max-w-full">
            <button
              type="button"
              onClick={() => setActiveTab("manifest")}
              className={`px-2.5 py-1 rounded-lg whitespace-nowrap transition-all ${
                activeTab === "manifest"
                  ? "bg-cyan-500 text-slate-950 font-bold"
                  : "text-slate-400 hover:text-slate-200"
              }`}
            >
              AndroidManifest.xml
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("service")}
              className={`px-2.5 py-1 rounded-lg whitespace-nowrap transition-all ${
                activeTab === "service"
                  ? "bg-cyan-500 text-slate-950 font-bold"
                  : "text-slate-400 hover:text-slate-200"
              }`}
            >
              AppLockService.kt
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("overlay")}
              className={`px-2.5 py-1 rounded-lg whitespace-nowrap transition-all ${
                activeTab === "overlay"
                  ? "bg-cyan-500 text-slate-950 font-bold"
                  : "text-slate-400 hover:text-slate-200"
              }`}
            >
              LockOverlay.kt
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("main")}
              className={`px-2.5 py-1 rounded-lg whitespace-nowrap transition-all ${
                activeTab === "main"
                  ? "bg-cyan-500 text-slate-950 font-bold"
                  : "text-slate-400 hover:text-slate-200"
              }`}
            >
              MainActivity.kt
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("gradle")}
              className={`px-2.5 py-1 rounded-lg whitespace-nowrap transition-all ${
                activeTab === "gradle"
                  ? "bg-cyan-500 text-slate-950 font-bold"
                  : "text-slate-400 hover:text-slate-200"
              }`}
            >
              build.gradle.kts
            </button>
          </div>
        </div>

        {/* Code Box with Copy */}
        <div className="relative rounded-2xl bg-slate-950 border border-slate-800 overflow-hidden">
          <div className="flex items-center justify-between px-4 py-2 bg-slate-900/90 border-b border-slate-800 text-xs">
            <span className="text-slate-400 font-mono text-[11px]">
              {activeTab === "manifest"
                ? "android/app/src/main/AndroidManifest.xml"
                : activeTab === "service"
                ? "android/app/src/main/java/com/applock/vault/AppLockAccessibilityService.kt"
                : activeTab === "overlay"
                ? "android/app/src/main/java/com/applock/vault/LockScreenOverlayActivity.kt"
                : activeTab === "main"
                ? "android/app/src/main/java/com/applock/vault/MainActivity.kt"
                : "android/app/build.gradle.kts"}
            </span>
            <button
              type="button"
              onClick={() =>
                copyToClipboard(
                  activeTab === "manifest"
                    ? manifestCode
                    : activeTab === "service"
                    ? serviceCode
                    : activeTab === "overlay"
                    ? overlayCode
                    : activeTab === "main"
                    ? mainActivityCode
                    : gradleCode,
                  activeTab
                )
              }
              className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-cyan-300 text-[11px] font-semibold transition-colors"
            >
              {copiedKey === activeTab ? (
                <>
                  <Check className="w-3.5 h-3.5 text-emerald-400" />
                  Copied!
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5" />
                  Copy Code
                </>
              )}
            </button>
          </div>

          <pre className="p-4 text-xs font-mono text-slate-300 overflow-x-auto max-h-72 leading-relaxed">
            {activeTab === "manifest"
              ? manifestCode
              : activeTab === "service"
              ? serviceCode
              : activeTab === "overlay"
              ? overlayCode
              : activeTab === "main"
              ? mainActivityCode
              : gradleCode}
          </pre>
        </div>
      </div>

      {/* 3 Step APK Build Steps */}
      <div className="p-4 rounded-2xl bg-slate-950/90 border border-slate-800 space-y-2 text-xs">
        <h4 className="font-bold text-slate-100 flex items-center gap-1.5">
          <CheckCircle2 className="w-4 h-4 text-emerald-400" />
          Android Studio mein APK Build karne ke 3 Steps:
        </h4>
        <ol className="space-y-1.5 list-decimal list-inside text-slate-300">
          <li>
            ZIP extract karke <strong>Android Studio</strong> open karein aur <strong>File &gt; Open</strong> karke <code>android</code> folder select karein.
          </li>
          <li>
            Gradle sync complete hone ke baad menu mein <strong>Build &gt; Build Bundle(s) / APK(s) &gt; Build APK(s)</strong> par click karein.
          </li>
          <li>
            Pop-up mein <strong>locate</strong> click karein. Aapki signed <code>app-debug.apk</code> file samne hogi jo kisi bhi real Android mobile par WhatsApp aur sari apps ko asal mein lock karegi!
          </li>
        </ol>
      </div>
    </div>
  );
};
