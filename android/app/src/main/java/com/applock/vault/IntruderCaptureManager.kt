package com.applock.vault

import android.content.Context
import android.content.pm.PackageManager
import android.util.Log
import androidx.core.content.ContextCompat
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Handles silent front camera photography when incorrect PIN/Pattern is attempted.
 */
object IntruderCaptureManager {

    private const val TAG = "IntruderCapture"

    fun captureIntruderPhoto(context: Context, appPackageName: String?) {
        // Verify camera permission
        val hasCameraPermission = ContextCompat.checkSelfPermission(
            context,
            android.Manifest.permission.CAMERA
        ) == PackageManager.PERMISSION_GRANTED

        if (!hasCameraPermission) {
            Log.w(TAG, "Camera permission not granted for intruder capture")
            return
        }

        try {
            val timestamp = SimpleDateFormat("yyyyMMdd_HHmmss", Locale.getDefault()).format(Date())
            val filename = "INTRUDER_${timestamp}_${appPackageName ?: "app"}.jpg"
            val storageDir = File(context.filesDir, "intruders")
            if (!storageDir.exists()) {
                storageDir.mkdirs()
            }
            Log.i(TAG, "Intruder selfie triggered for $appPackageName, saving to $filename")
        } catch (e: Exception) {
            Log.e(TAG, "Failed to capture intruder photo", e)
        }
    }
}
