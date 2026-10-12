package com.applock.vault

import android.accessibilityservice.AccessibilityService
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.SharedPreferences
import android.os.Handler
import android.os.Looper
import android.view.accessibility.AccessibilityEvent
import androidx.core.content.ContextCompat
import com.applock.vault.learn.BookRepository
import com.applock.vault.learn.LearnOverlay
import com.applock.vault.learn.LearnSettings

/**
 * AppLockAccessibilityService continuously detects when any app on the Android phone is launched.
 * When a user opens a protected app (e.g. WhatsApp, Facebook, Photos, Settings),
 * it displays the secure LockScreenOverlayActivity immediately before the user can view the contents.
 */
class AppLockAccessibilityService : AccessibilityService() {

    private lateinit var prefs: SharedPreferences
    private var lastUnlockedPackage: String? = null
    private var lastUnlockedTime: Long = 0
    private lateinit var learnSettings: LearnSettings
    private var learnOverlay: LearnOverlay? = null
    private val handler = Handler(Looper.getMainLooper())

    /** Phone unlocked -> show the next book slide; screen off -> remove any slide. */
    private val screenReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            when (intent?.action) {
                Intent.ACTION_USER_PRESENT ->
                    if (learnSettings.showOnUnlock) handler.postDelayed({ showLearningSlide() }, 600)
                Intent.ACTION_SCREEN_OFF -> learnOverlay?.hide()
            }
        }
    }

    companion object {
        var temporarilyUnlockedPackage: String? = null
        var temporarilyUnlockedTimestamp: Long = 0

        /** Avoid spamming slides when the phone is locked/unlocked in quick succession. */
        private const val MIN_GAP_BETWEEN_SLIDES_MS = 15_000L
    }

    override fun onServiceConnected() {
        super.onServiceConnected()
        prefs = getSharedPreferences("AppLockPrefs", Context.MODE_PRIVATE)
        learnSettings = LearnSettings(this)
        learnOverlay = LearnOverlay(this)
        val filter = IntentFilter().apply {
            addAction(Intent.ACTION_USER_PRESENT)
            addAction(Intent.ACTION_SCREEN_OFF)
        }
        ContextCompat.registerReceiver(this, screenReceiver, filter, ContextCompat.RECEIVER_NOT_EXPORTED)
    }

    override fun onDestroy() {
        runCatching { unregisterReceiver(screenReceiver) }
        learnOverlay?.hide()
        handler.removeCallbacksAndMessages(null)
        super.onDestroy()
    }

    private fun showLearningSlide() {
        if (!learnSettings.enabled) return
        val now = System.currentTimeMillis()
        if (now - learnSettings.lastShownAt < MIN_GAP_BETWEEN_SLIDES_MS) return
        val card = BookRepository.nextSlide(this) ?: return
        learnSettings.lastShownAt = now
        learnOverlay?.show(card, learnSettings.displaySeconds)
    }

    /** While the phone is in use, show a slide every N minutes (if enabled). */
    private fun maybeShowLearningSlideDuringUse() {
        val minutes = learnSettings.usageIntervalMinutes
        if (minutes <= 0) return
        if (System.currentTimeMillis() - learnSettings.lastShownAt >= minutes * 60_000L) {
            showLearningSlide()
        }
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

        maybeShowLearningSlideDuringUse()

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
