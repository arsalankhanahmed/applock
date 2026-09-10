package com.applock.vault

import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.os.Bundle
import android.widget.ImageView
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import java.util.concurrent.Executor

class LockScreenOverlayActivity : AppCompatActivity() {

    private lateinit var prefs: SharedPreferences
    private var targetPackage: String? = null
    private var enteredPin = StringBuilder()
    private var failedAttempts = 0

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_lock_overlay)

        prefs = getSharedPreferences("AppLockPrefs", Context.MODE_PRIVATE)
        targetPackage = intent.getStringExtra("EXTRA_PACKAGE_NAME")

        setupAppInfo()
        setupBiometricAuth()
    }

    private fun setupAppInfo() {
        val tvAppName = findViewById<TextView>(R.id.tvAppName)
        val appIcon = findViewById<ImageView>(R.id.appIcon)

        targetPackage?.let { pkg ->
            try {
                val pm = packageManager
                val appInfo = pm.getApplicationInfo(pkg, 0)
                val appLabel = pm.getApplicationLabel(appInfo).toString()
                tvAppName.text = "$appLabel is Locked"
                appIcon.setImageDrawable(pm.getApplicationIcon(appInfo))
            } catch (e: PackageManager.NameNotFoundException) {
                tvAppName.text = "Application is Locked"
            }
        }
    }

    private fun setupBiometricAuth() {
        val executor: Executor = ContextCompat.getMainExecutor(this)
        val biometricPrompt = BiometricPrompt(this, executor,
            object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                    super.onAuthenticationSucceeded(result)
                    unlockSuccess()
                }

                override fun onAuthenticationFailed() {
                    super.onAuthenticationFailed()
                    handleFailedAttempt()
                }
            })

        val promptInfo = BiometricPrompt.PromptInfo.Builder()
            .setTitle("Unlock Application")
            .setSubtitle("Touch the fingerprint sensor")
            .setNegativeButtonText("Use PIN")
            .build()

        biometricPrompt.authenticate(promptInfo)
    }

    fun onKeyClick(digit: String) {
        if (enteredPin.length < 4) {
            enteredPin.append(digit)
            if (enteredPin.length == 4) {
                verifyPin()
            }
        }
    }

    private fun verifyPin() {
        val savedPin = prefs.getString("SECURITY_PIN", "1234")
        if (enteredPin.toString() == savedPin) {
            unlockSuccess()
        } else {
            handleFailedAttempt()
            enteredPin.clear()
            Toast.makeText(this, "Incorrect PIN!", Toast.LENGTH_SHORT).show()
        }
    }

    private fun handleFailedAttempt() {
        failedAttempts++
        if (failedAttempts >= 2) {
            // Trigger Intruder Selfie capture silently with front camera
            IntruderCaptureManager.captureIntruderPhoto(this, targetPackage)
        }
    }

    private fun unlockSuccess() {
        // Record grace timestamp so user can use the app without being locked repeatedly
        targetPackage?.let {
            AppLockAccessibilityService.temporarilyUnlockedPackage = it
            AppLockAccessibilityService.temporarilyUnlockedTimestamp = System.currentTimeMillis()
        }
        finish()
    }

    override fun onBackPressed() {
        // Strict AppLock behavior: If user taps back on lock screen, do NOT allow them into WhatsApp.
        // Instead, send them back to the phone's Home Launcher.
        val homeIntent = Intent(Intent.ACTION_MAIN).apply {
            addCategory(Intent.CATEGORY_HOME)
            flags = Intent.FLAG_ACTIVITY_NEW_TASK
        }
        startActivity(homeIntent)
        finish()
    }
}
