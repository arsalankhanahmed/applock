package com.applock.vault

import android.accessibilityservice.AccessibilityService
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.view.accessibility.AccessibilityEvent

/**
 * AppLockAccessibilityService continuously detects when any app on the Android phone is launched.
 * When a user opens a protected app (e.g. WhatsApp, Facebook, Photos, Settings),
 * it displays the secure LockScreenOverlayActivity immediately before the user can view the contents.
 */
class AppLockAccessibilityService : AccessibilityService() {

    private lateinit var prefs: SharedPreferences
    private var lastUnlockedPackage: String? = null
    private var lastUnlockedTime: Long = 0

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

        // Ignore our own AppLock package
        if (packageName == applicationContext.packageName) {
            return
        }

        // Check if package is locked by user in SharedPreferences
        val lockedSet = prefs.getStringSet("LOCKED_PACKAGES", hashSetOf(
            "com.whatsapp",
            "com.google.android.apps.photos",
            "com.android.settings",
            "com.facebook.katana"
        )) ?: emptySet()

        if (lockedSet.contains(packageName)) {
            // Check if recently unlocked within grace period (e.g. 15 seconds)
            val now = System.currentTimeMillis()
            if (temporarilyUnlockedPackage == packageName && (now - temporarilyUnlockedTimestamp) < 15_000) {
                return // Allowed in
            }

            // Launch Lock Screen Overlay
            val lockIntent = Intent(this, LockScreenOverlayActivity::class.java).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP)
                addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
                putExtra("EXTRA_PACKAGE_NAME", packageName)
            }
            startActivity(lockIntent)
        }
    }

    override fun onInterrupt() {
        // Handle interruption
    }
}
