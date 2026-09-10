package com.applock.vault

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Automatically starts the AppLock monitoring service when the phone turns on or reboots.
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context?, intent: Intent?) {
        if (intent?.action == Intent.ACTION_BOOT_COMPLETED || intent?.action == "android.intent.action.QUICKBOOT_POWERON") {
            // Service will automatically bind if accessibility is granted by Android OS
        }
    }
}
