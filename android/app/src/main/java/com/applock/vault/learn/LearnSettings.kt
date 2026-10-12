package com.applock.vault.learn

import android.content.Context

/** User preferences for the micro-learning feature. */
class LearnSettings(context: Context) {
    private val prefs = context.getSharedPreferences("BookLearnPrefs", Context.MODE_PRIVATE)

    var apiKey: String
        get() = prefs.getString("GEMINI_API_KEY", "") ?: ""
        set(v) = prefs.edit().putString("GEMINI_API_KEY", v.trim()).apply()

    var model: String
        get() = prefs.getString("GEMINI_MODEL", DEFAULT_MODEL)?.ifBlank { DEFAULT_MODEL } ?: DEFAULT_MODEL
        set(v) = prefs.edit().putString("GEMINI_MODEL", v.trim()).apply()

    /** Language for the slides. Blank = same language as the book. */
    var explainLanguage: String
        get() = prefs.getString("EXPLAIN_LANGUAGE", "") ?: ""
        set(v) = prefs.edit().putString("EXPLAIN_LANGUAGE", v.trim()).apply()

    var enabled: Boolean
        get() = prefs.getBoolean("ENABLED", true)
        set(v) = prefs.edit().putBoolean("ENABLED", v).apply()

    /** Show a slide each time the phone is unlocked. */
    var showOnUnlock: Boolean
        get() = prefs.getBoolean("SHOW_ON_UNLOCK", true)
        set(v) = prefs.edit().putBoolean("SHOW_ON_UNLOCK", v).apply()

    /** While the phone is in use, also show a slide every N minutes (0 = off). */
    var usageIntervalMinutes: Int
        get() = prefs.getInt("USAGE_INTERVAL_MIN", 10)
        set(v) = prefs.edit().putInt("USAGE_INTERVAL_MIN", v.coerceAtLeast(0)).apply()

    /** How long the pop-up stays on screen. */
    var displaySeconds: Int
        get() = prefs.getInt("DISPLAY_SECONDS", 5)
        set(v) = prefs.edit().putInt("DISPLAY_SECONDS", v.coerceIn(2, 15)).apply()

    var activeBookId: String?
        get() = prefs.getString("ACTIVE_BOOK_ID", null)
        set(v) = prefs.edit().putString("ACTIVE_BOOK_ID", v).apply()

    var lastShownAt: Long
        get() = prefs.getLong("LAST_SHOWN_AT", 0)
        set(v) = prefs.edit().putLong("LAST_SHOWN_AT", v).apply()

    companion object {
        const val DEFAULT_MODEL = "gemini-flash-latest"
    }
}
