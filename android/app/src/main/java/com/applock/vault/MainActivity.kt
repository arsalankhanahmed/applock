package com.applock.vault

import android.app.AppOpsManager
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Process
import android.provider.Settings
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.ListView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity

class MainActivity : AppCompatActivity() {

    private lateinit var prefs: SharedPreferences
    private val lockedPackages = HashSet<String>()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        prefs = getSharedPreferences("AppLockPrefs", Context.MODE_PRIVATE)
        val saved = prefs.getStringSet("LOCKED_PACKAGES", null)
        if (saved != null) {
            lockedPackages.addAll(saved)
        } else {
            // Default locked apps
            lockedPackages.add("com.whatsapp")
            lockedPackages.add("com.google.android.apps.photos")
            lockedPackages.add("com.android.settings")
        }

        setupPermissionButtons()
        loadInstalledApplications()
    }

    private fun setupPermissionButtons() {
        findViewById<Button>(R.id.btnOverlayPermission).setOnClickListener {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && !Settings.canDrawOverlays(this)) {
                val intent = Intent(
                    Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                    Uri.parse("package:$packageName")
                )
                startActivity(intent)
            } else {
                Toast.makeText(this, "Overlay Permission Already Granted!", Toast.LENGTH_SHORT).show()
            }
        }

        findViewById<Button>(R.id.btnAccessibilityPermission).setOnClickListener {
            val intent = Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)
            startActivity(intent)
            Toast.makeText(this, "Enable 'AppLock Service' in the list", Toast.LENGTH_LONG).show()
        }

        findViewById<Button>(R.id.btnUsageStatsPermission).setOnClickListener {
            if (!hasUsageStatsPermission()) {
                val intent = Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS)
                startActivity(intent)
            } else {
                Toast.makeText(this, "Usage Access Already Granted!", Toast.LENGTH_SHORT).show()
            }
        }
    }

    private fun hasUsageStatsPermission(): Boolean {
        val appOps = getSystemService(Context.APP_OPS_SERVICE) as AppOpsManager
        val mode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            appOps.unsafeCheckOpNoThrow(
                AppOpsManager.OPSTR_GET_USAGE_STATS,
                Process.myUid(),
                packageName
            )
        } else {
            @Suppress("DEPRECATION")
            appOps.checkOpNoThrow(
                AppOpsManager.OPSTR_GET_USAGE_STATS,
                Process.myUid(),
                packageName
            )
        }
        return mode == AppOpsManager.MODE_ALLOWED
    }

    private fun loadInstalledApplications() {
        val pm = packageManager
        val apps = pm.getInstalledApplications(PackageManager.GET_META_DATA)
        val displayList = ArrayList<String>()
        val packageMap = ArrayList<String>()

        for (app in apps) {
            // Filter non-system apps or common apps
            val isSystem = (app.flags and ApplicationInfo.FLAG_SYSTEM) != 0
            if (!isSystem || app.packageName == "com.android.settings" || app.packageName.contains("camera")) {
                val label = pm.getApplicationLabel(app).toString()
                val isLocked = lockedPackages.contains(app.packageName)
                displayList.add("${if (isLocked) "🔒 [LOCKED]" else "🔓 [UNLOCKED]"} $label (${app.packageName})")
                packageMap.add(app.packageName)
            }
        }

        val listView = findViewById<ListView>(R.id.appsListView)
        val adapter = ArrayAdapter(this, android.R.layout.simple_list_item_1, displayList)
        listView.adapter = adapter

        listView.setOnItemClickListener { _, _, position, _ ->
            val pkg = packageMap[position]
            if (lockedPackages.contains(pkg)) {
                lockedPackages.remove(pkg)
                Toast.makeText(this, "Unlocked $pkg", Toast.LENGTH_SHORT).show()
            } else {
                lockedPackages.add(pkg)
                Toast.makeText(this, "Locked $pkg", Toast.LENGTH_SHORT).show()
            }
            prefs.edit().putStringSet("LOCKED_PACKAGES", lockedPackages).apply()
            loadInstalledApplications() // Refresh list
        }
    }
}
