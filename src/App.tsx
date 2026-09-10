/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from "react";
import {
  AppItem,
  ChatMessage,
  IntruderLog,
  SecurityConfig,
  VaultPhoto,
} from "./types";
import {
  DEFAULT_SECURITY_CONFIG,
  INITIAL_APPS,
  INITIAL_VAULT_PHOTOS,
} from "./data/initialData";
import { Navigation, NavTab } from "./components/Navigation";
import { AppLockManager } from "./components/AppLockManager";
import { IntruderLogs } from "./components/IntruderLogs";
import { GalleryVault } from "./components/GalleryVault";
import { AiSecurityAssistant } from "./components/AiSecurityAssistant";
import { SecuritySettings } from "./components/SecuritySettings";
import { AppLockScreen } from "./components/AppLockScreen";
import { SimulatedAppWindow } from "./components/SimulatedAppWindow";
import {
  Shield,
  ShieldCheck,
  Lock,
  Camera,
  Image as ImageIcon,
  KeyRound,
  Grid3X3,
  Fingerprint,
  Clock,
  Sparkles,
  AlertTriangle,
} from "lucide-react";

export default function App() {
  // Local persistence states
  const [apps, setApps] = useState<AppItem[]>(() => {
    const saved = localStorage.getItem("applock_apps");
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        return parsed.filter((a: AppItem) => a.id !== "instagram");
      } catch (e) {
        return INITIAL_APPS;
      }
    }
    return INITIAL_APPS;
  });

  const [config, setConfig] = useState<SecurityConfig>(() => {
    const saved = localStorage.getItem("applock_config");
    return saved ? JSON.parse(saved) : DEFAULT_SECURITY_CONFIG;
  });

  const [intruderLogs, setIntruderLogs] = useState<IntruderLog[]>(() => {
    const saved = localStorage.getItem("applock_intruder_logs");
    return saved ? JSON.parse(saved) : [];
  });

  const [vaultPhotos, setVaultPhotos] = useState<VaultPhoto[]>(() => {
    const saved = localStorage.getItem("applock_vault_photos");
    return saved ? JSON.parse(saved) : INITIAL_VAULT_PHOTOS;
  });

  const [chatMessages, setChatMessages] = useState<ChatMessage[]>(() => {
    const saved = localStorage.getItem("applock_chat_messages");
    return saved ? JSON.parse(saved) : [];
  });

  const [activeTab, setActiveTab] = useState<NavTab>("apps");

  // Active interaction states
  const [activeLockApp, setActiveLockApp] = useState<AppItem | null>(null);
  const [activeSimulatedApp, setActiveSimulatedApp] = useState<AppItem | null>(null);
  const [isVaultLocked, setIsVaultLocked] = useState<boolean>(true);
  const [isAttemptingVaultUnlock, setIsAttemptingVaultUnlock] = useState<boolean>(false);
  const [globalBannerNotice, setGlobalBannerNotice] = useState<string | null>(null);

  // Sync to localStorage
  useEffect(() => {
    localStorage.setItem("applock_apps", JSON.stringify(apps));
  }, [apps]);

  useEffect(() => {
    localStorage.setItem("applock_config", JSON.stringify(config));
  }, [config]);

  useEffect(() => {
    localStorage.setItem("applock_intruder_logs", JSON.stringify(intruderLogs));
  }, [intruderLogs]);

  useEffect(() => {
    localStorage.setItem("applock_vault_photos", JSON.stringify(vaultPhotos));
  }, [vaultPhotos]);

  useEffect(() => {
    localStorage.setItem("applock_chat_messages", JSON.stringify(chatMessages));
  }, [chatMessages]);

  const showGlobalNotice = (msg: string) => {
    setGlobalBannerNotice(msg);
    setTimeout(() => setGlobalBannerNotice(null), 3500);
  };

  // App lock toggle
  const handleToggleLock = (id: string) => {
    setApps((prev) =>
      prev.map((app) => {
        if (app.id === id) {
          const newState = !app.isLocked;
          showGlobalNotice(
            `${app.name} is now ${newState ? "Protected with AppLock" : "Unlocked"}`
          );
          return { ...app, isLocked: newState };
        }
        return app;
      })
    );
  };

  // Usage limit update
  const handleUpdateUsageLimit = (id: string, minutes: number) => {
    setApps((prev) =>
      prev.map((app) => (app.id === id ? { ...app, usageLimitMinutes: minutes } : app))
    );
    showGlobalNotice(
      `Usage limit for app updated to ${minutes > 0 ? `${minutes} minutes/day` : "Unlimited"}`
    );
  };

  const handleResetAppUsage = (id: string) => {
    setApps((prev) =>
      prev.map((app) => (app.id === id ? { ...app, usedMinutesToday: 0 } : app))
    );
  };

  const handleDeleteApp = (id: string) => {
    const target = apps.find((a) => a.id === id);
    setApps((prev) => prev.filter((app) => app.id !== id));
    showGlobalNotice(`${target?.name || "App"} removed from AppLock`);
  };

  const handleAddApp = (newApp: AppItem) => {
    setApps((prev) => [newApp, ...prev]);
    showGlobalNotice(`${newApp.name} added and protected`);
  };

  // Simulate opening an app
  const handleSimulateAppLaunch = (app: AppItem) => {
    if (app.isLocked) {
      // Prompt AppLock screen
      setActiveLockApp(app);
    } else {
      // Directly open app
      setActiveSimulatedApp(app);
    }
  };

  // Successful unlock of an app
  const handleUnlockSuccess = () => {
    if (activeLockApp) {
      const target = activeLockApp;
      setActiveLockApp(null);
      setActiveSimulatedApp(target);
      showGlobalNotice(`Access granted to ${target.name}`);
    } else if (isAttemptingVaultUnlock) {
      setIsAttemptingVaultUnlock(false);
      setIsVaultLocked(false);
      setActiveTab("vault");
      showGlobalNotice("Private Vault Unlocked");
    }
  };

  // Intruder selfie capture event
  const handleIntruderCaptured = (log: IntruderLog) => {
    setIntruderLogs((prev) => [log, ...prev]);
    showGlobalNotice(`🚨 Intruder selfie logged! Targeted: ${log.targetAppName}`);
  };

  // Extend usage limit
  const handleExtendUsageLimit = (minutes: number) => {
    if (activeLockApp) {
      setApps((prev) =>
        prev.map((a) =>
          a.id === activeLockApp.id
            ? { ...a, usageLimitMinutes: a.usageLimitMinutes + minutes }
            : a
        )
      );
      showGlobalNotice(`Usage limit extended by +${minutes} minutes`);
    }
  };

  // Tab change handler (guards vault if locked)
  const handleSelectTab = (tab: NavTab) => {
    if (tab === "vault" && isVaultLocked) {
      setIsAttemptingVaultUnlock(true);
    } else {
      setActiveTab(tab);
    }
  };

  // Reset all to defaults
  const handleResetAll = () => {
    setApps(INITIAL_APPS);
    setConfig(DEFAULT_SECURITY_CONFIG);
    setIntruderLogs([]);
    setVaultPhotos(INITIAL_VAULT_PHOTOS);
    setChatMessages([]);
    localStorage.clear();
    showGlobalNotice("All settings and data reset to defaults");
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col justify-between selection:bg-cyan-500 selection:text-slate-950">
      {/* Top App Bar & Navigation */}
      <Navigation
        activeTab={activeTab}
        onSelectTab={handleSelectTab}
        intruderCount={intruderLogs.length}
        vaultCount={vaultPhotos.length}
      />

      {/* Global Toast Notification */}
      {globalBannerNotice && (
        <div className="fixed top-20 right-4 z-40 max-w-sm p-3.5 rounded-2xl bg-slate-900/95 border border-cyan-500/40 shadow-2xl text-xs text-slate-100 flex items-center gap-2.5 animate-scale-up backdrop-blur-lg">
          <ShieldCheck className="w-4 h-4 text-cyan-400 shrink-0" />
          <span className="font-medium">{globalBannerNotice}</span>
        </div>
      )}

      {/* Main Content Area */}
      <main className="flex-1 max-w-7xl mx-auto w-full px-4 sm:px-6 py-6">
        {/* Ad-Free Assurance Sub-banner */}
        <div className="mb-6 p-3 rounded-2xl bg-slate-900/60 border border-slate-800/80 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 text-xs text-slate-400">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0" />
            <span>
              <strong className="text-slate-200">100% Ad-Free Guarantee:</strong> Clean, uncluttered UI with zero ads, tracking-free local vault, and active intruder monitoring.
            </span>
          </div>

          <div className="flex items-center gap-2 text-[11px] text-cyan-400 font-mono">
            <span>Primary Lock: <strong className="uppercase">{config.primaryLockType}</strong></span>
            <span>•</span>
            <span>Intruder Threshold: <strong>{config.intruderThreshold}x</strong></span>
          </div>
        </div>

        {/* Tab 1: AppLock & Usage Limits */}
        {activeTab === "apps" && (
          <AppLockManager
            apps={apps}
            onToggleLock={handleToggleLock}
            onUpdateUsageLimit={handleUpdateUsageLimit}
            onSimulateAppLaunch={handleSimulateAppLaunch}
            onResetAppUsage={handleResetAppUsage}
            onDeleteApp={handleDeleteApp}
            onAddApp={handleAddApp}
          />
        )}

        {/* Tab 2: Intruder Logs */}
        {activeTab === "intruder" && (
          <IntruderLogs
            logs={intruderLogs}
            config={config}
            onUpdateConfig={setConfig}
            onDeleteLog={(id) =>
              setIntruderLogs((prev) => prev.filter((l) => l.id !== id))
            }
            onClearAllLogs={() => setIntruderLogs([])}
            onAddLog={(log) => setIntruderLogs((prev) => [log, ...prev])}
          />
        )}

        {/* Tab 3: Private Gallery Vault */}
        {activeTab === "vault" && (
          <GalleryVault
            photos={vaultPhotos}
            onAddPhoto={(photo) => setVaultPhotos((prev) => [photo, ...prev])}
            onDeletePhoto={(id) =>
              setVaultPhotos((prev) => prev.filter((p) => p.id !== id))
            }
            onUpdatePhoto={(updated) =>
              setVaultPhotos((prev) =>
                prev.map((p) => (p.id === updated.id ? updated : p))
              )
            }
          />
        )}

        {/* Tab 4: Gemini AI Security Assistant */}
        {activeTab === "ai" && (
          <AiSecurityAssistant
            chatMessages={chatMessages}
            onAddMessage={(msg) => setChatMessages((prev) => [...prev, msg])}
            onClearChat={() => setChatMessages([])}
          />
        )}

        {/* Tab 5: Settings */}
        {activeTab === "settings" && (
          <SecuritySettings
            config={config}
            onUpdateConfig={setConfig}
            onResetAll={handleResetAll}
          />
        )}
      </main>

      {/* AppLock Screen Modal (Triggered when opening locked app) */}
      {activeLockApp && (
        <AppLockScreen
          app={activeLockApp}
          config={config}
          onUnlockSuccess={handleUnlockSuccess}
          onCancel={() => setActiveLockApp(null)}
          onIntruderCaptured={handleIntruderCaptured}
          onExtendUsageLimit={handleExtendUsageLimit}
        />
      )}

      {/* Vault Master Lock Screen Modal (Guarding private gallery) */}
      {isAttemptingVaultUnlock && (
        <AppLockScreen
          app={{
            id: "vault-master",
            name: "Private Gallery Vault",
            nameUrdu: "پرائیویٹ گیلری والٹ",
            packageName: "com.applock.privatevault",
            iconName: "Image",
            color: "bg-cyan-600",
            category: "Utility",
            isLocked: true,
            usageLimitMinutes: 0,
            usedMinutesToday: 0,
            isTemporarilyUnlocked: false,
          }}
          config={config}
          onUnlockSuccess={handleUnlockSuccess}
          onCancel={() => setIsAttemptingVaultUnlock(false)}
          onIntruderCaptured={handleIntruderCaptured}
        />
      )}

      {/* Simulated Unlocked Running App Window */}
      {activeSimulatedApp && (
        <SimulatedAppWindow
          app={activeSimulatedApp}
          onClose={() => setActiveSimulatedApp(null)}
          onAppLockAgain={() => {
            const current = activeSimulatedApp;
            setActiveSimulatedApp(null);
            setActiveLockApp(current);
          }}
          onIncrementUsage={(id, mins) => {
            setApps((prev) =>
              prev.map((a) =>
                a.id === id ? { ...a, usedMinutesToday: a.usedMinutesToday + mins } : a
              )
            );
          }}
        />
      )}

      {/* Footer */}
      <footer className="mt-8 border-t border-slate-900 bg-slate-950/80 py-6 text-center text-xs text-slate-400">
        <div className="max-w-7xl mx-auto px-4 flex flex-col sm:flex-row items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-emerald-400" />
            <span className="text-slate-300 font-medium">
              AppLock & Private Vault • 100% Ad-Free Security
            </span>
          </div>

          <div className="flex items-center gap-4 text-[11px] text-slate-400">
            <span>Pattern • Passcode • Biometrics</span>
            <span>•</span>
            <span>Intruder Selfie Active</span>
            <span>•</span>
            <span>Gemini AI Guard</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
