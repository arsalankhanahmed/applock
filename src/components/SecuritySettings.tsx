import React, { useState } from "react";
import { LockType, SecurityConfig } from "../types";
import { PatternLock } from "./PatternLock";
import { PinLock } from "./PinLock";
import { PWAInstallButton } from "./PWAInstallButton";
import {
  Shield,
  KeyRound,
  Grid3X3,
  Fingerprint,
  Camera,
  CheckCircle2,
  Lock,
  RefreshCw,
  Sparkles,
  Smartphone,
  ShieldCheck,
  Ban,
  Clock,
} from "lucide-react";

interface SecuritySettingsProps {
  config: SecurityConfig;
  onUpdateConfig: (newConfig: SecurityConfig) => void;
  onResetAll: () => void;
}

export const SecuritySettings: React.FC<SecuritySettingsProps> = ({
  config,
  onUpdateConfig,
  onResetAll,
}) => {
  const [editingMode, setEditingMode] = useState<"none" | "change-pin" | "change-pattern">("none");
  const [notification, setNotification] = useState<string | null>(null);

  const showToast = (msg: string) => {
    setNotification(msg);
    setTimeout(() => setNotification(null), 3000);
  };

  const handleSetNewPin = (newPin: string) => {
    onUpdateConfig({ ...config, pin: newPin });
    setEditingMode("none");
    showToast(`Master PIN successfully updated to: ${newPin}`);
  };

  const handleSetNewPattern = (newPattern: number[]) => {
    onUpdateConfig({ ...config, pattern: newPattern });
    setEditingMode("none");
    showToast(`Master Unlock Pattern updated (${newPattern.length} dots connected)`);
  };

  return (
    <div className="flex flex-col gap-6 max-w-2xl mx-auto w-full">
      {/* Toast Notification */}
      {notification && (
        <div className="p-3 rounded-2xl bg-emerald-500/15 border border-emerald-500/40 text-emerald-300 text-xs font-semibold flex items-center gap-2 animate-bounce-subtle">
          <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
          {notification}
        </div>
      )}

      {/* Ad-Free & Privacy Guarantee Banner */}
      <div className="p-5 rounded-3xl bg-gradient-to-r from-emerald-950/40 to-slate-900 border border-emerald-500/30 flex items-start gap-4">
        <div className="w-12 h-12 rounded-2xl bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center text-emerald-400 shrink-0">
          <ShieldCheck className="w-6 h-6" />
        </div>
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-base font-bold text-slate-100">
              100% Ad-Free & Private Architecture
            </h3>
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 font-bold border border-emerald-500/30">
              No Ads
            </span>
          </div>
          <p className="text-xs text-slate-400 mt-1 leading-relaxed">
            As requested, this app is completely ad-free. No banner ads, no popups, no interstitial video ads, and no tracking cookies. Your private gallery photos, patterns, passcodes, and intruder logs remain strictly on your device.
          </p>
        </div>
      </div>

      {/* Universal Mobile Phone Installer Card */}
      <div className="p-5 rounded-3xl bg-gradient-to-r from-cyan-950/40 via-slate-900 to-slate-900 border border-cyan-500/30 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div className="flex items-start gap-3.5">
          <div className="w-12 h-12 rounded-2xl bg-cyan-500/15 border border-cyan-500/30 flex items-center justify-center text-cyan-400 shrink-0">
            <Smartphone className="w-6 h-6" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-bold text-slate-100">
                Universal Mobile Phone Installer (PWA)
              </h3>
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-cyan-500/20 text-cyan-300 font-bold border border-cyan-500/30">
                Android & iOS
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-1">
              Har mobile (Samsung, Xiaomi, Vivo, Oppo, Realme ya iPhone) par baghair Play Store ke direct install karein.
            </p>
          </div>
        </div>
        <PWAInstallButton />
      </div>

      {/* Primary Unlock Method Selection */}
      <div className="p-5 rounded-3xl bg-slate-900/90 border border-slate-800 flex flex-col gap-4">
        <div>
          <h4 className="text-sm font-bold text-slate-100 flex items-center gap-2">
            <Lock className="w-4 h-4 text-cyan-400" />
            Default Preferred Unlock Method
          </h4>
          <p className="text-xs text-slate-400 mt-0.5">
            Choose which security option appears first when launching a locked app
          </p>
        </div>

        <div className="grid grid-cols-3 gap-3">
          {[
            {
              type: "pin" as LockType,
              label: "Passcode (PIN)",
              icon: KeyRound,
              desc: "4-Digit Keypad",
            },
            {
              type: "pattern" as LockType,
              label: "Pattern Lock",
              icon: Grid3X3,
              desc: "3x3 Dot Grid",
            },
            {
              type: "fingerprint" as LockType,
              label: "Fingerprint",
              icon: Fingerprint,
              desc: "Biometric Touch",
            },
          ].map((item) => {
            const isSelected = config.primaryLockType === item.type;
            const Icon = item.icon;
            return (
              <button
                key={item.type}
                type="button"
                onClick={() => {
                  onUpdateConfig({ ...config, primaryLockType: item.type });
                  showToast(`Default unlock method set to ${item.label}`);
                }}
                className={`p-3.5 rounded-2xl border text-left flex flex-col gap-2 transition-all ${
                  isSelected
                    ? "bg-cyan-500/10 border-cyan-500 shadow-md shadow-cyan-500/10 text-cyan-300"
                    : "bg-slate-950 border-slate-800 hover:border-slate-700 text-slate-400"
                }`}
              >
                <div className="flex items-center justify-between">
                  <Icon className={`w-5 h-5 ${isSelected ? "text-cyan-400" : "text-slate-500"}`} />
                  {isSelected && <CheckCircle2 className="w-4 h-4 text-cyan-400" />}
                </div>
                <div>
                  <div className={`text-xs font-bold ${isSelected ? "text-slate-100" : "text-slate-300"}`}>
                    {item.label}
                  </div>
                  <div className="text-[10px] text-slate-400">{item.desc}</div>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Passcode & Pattern Management */}
      <div className="p-5 rounded-3xl bg-slate-900/90 border border-slate-800 flex flex-col gap-4">
        <h4 className="text-sm font-bold text-slate-100 flex items-center gap-2">
          <KeyRound className="w-4 h-4 text-cyan-400" />
          Manage Credentials & Keys
        </h4>

        {/* Change PIN Row */}
        <div className="flex items-center justify-between p-3.5 rounded-2xl bg-slate-950/70 border border-slate-800">
          <div>
            <div className="text-xs font-semibold text-slate-200">Current Security PIN</div>
            <div className="text-[11px] text-slate-400">
              Master PIN: <strong className="font-mono text-cyan-400">{config.pin}</strong>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setEditingMode(editingMode === "change-pin" ? "none" : "change-pin")}
            className="px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-750 text-xs text-cyan-300 font-semibold border border-slate-700 transition-colors"
          >
            {editingMode === "change-pin" ? "Cancel" : "Change PIN"}
          </button>
        </div>

        {/* PIN Setting Sub-panel */}
        {editingMode === "change-pin" && (
          <div className="p-4 rounded-2xl bg-slate-950 border border-cyan-500/40">
            <PinLock
              isSettingMode={true}
              onPinRecorded={handleSetNewPin}
              onSuccess={() => {}}
              onFailure={() => {}}
              title="Set New 4-Digit Passcode"
              subtitle="Enter your new 4 numbers"
            />
          </div>
        )}

        {/* Change Pattern Row */}
        <div className="flex items-center justify-between p-3.5 rounded-2xl bg-slate-950/70 border border-slate-800">
          <div>
            <div className="text-xs font-semibold text-slate-200">Unlock Pattern Sequence</div>
            <div className="text-[11px] text-slate-400">
              Configured with {config.pattern.length} connected dots (Default: Z pattern)
            </div>
          </div>
          <button
            type="button"
            onClick={() =>
              setEditingMode(editingMode === "change-pattern" ? "none" : "change-pattern")
            }
            className="px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-750 text-xs text-cyan-300 font-semibold border border-slate-700 transition-colors"
          >
            {editingMode === "change-pattern" ? "Cancel" : "Draw New Pattern"}
          </button>
        </div>

        {/* Pattern Setting Sub-panel */}
        {editingMode === "change-pattern" && (
          <div className="p-4 rounded-2xl bg-slate-950 border border-cyan-500/40">
            <PatternLock
              isSettingMode={true}
              onPatternRecorded={handleSetNewPattern}
              onSuccess={() => {}}
              onFailure={() => {}}
              title="Draw New Unlock Pattern"
              subtitle="Connect at least 4 dots to save"
            />
          </div>
        )}

        {/* Biometric Toggle Row */}
        <div className="flex items-center justify-between p-3.5 rounded-2xl bg-slate-950/70 border border-slate-800">
          <div>
            <div className="text-xs font-semibold text-slate-200">Touch ID / Fingerprint</div>
            <div className="text-[11px] text-slate-400">
              Allow instant biometric sensor unlock for supported apps
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              onUpdateConfig({
                ...config,
                fingerprintEnabled: !config.fingerprintEnabled,
              });
              showToast(
                `Fingerprint authentication ${!config.fingerprintEnabled ? "Enabled" : "Disabled"}`
              );
            }}
            className={`w-12 h-7 rounded-full p-1 transition-colors flex items-center ${
              config.fingerprintEnabled ? "bg-cyan-500" : "bg-slate-800"
            }`}
          >
            <div
              className={`w-5 h-5 rounded-full bg-slate-950 transition-transform duration-200 ${
                config.fingerprintEnabled ? "translate-x-5" : "translate-x-0"
              }`}
            />
          </button>
        </div>
      </div>

      {/* Auto-Lock & Timing */}
      <div className="p-5 rounded-3xl bg-slate-900/90 border border-slate-800 flex flex-col gap-4">
        <h4 className="text-sm font-bold text-slate-100 flex items-center gap-2">
          <Clock className="w-4 h-4 text-cyan-400" />
          Re-Lock Policy
        </h4>

        <div className="flex items-center justify-between p-3.5 rounded-2xl bg-slate-950/70 border border-slate-800">
          <div>
            <div className="text-xs font-semibold text-slate-200">Auto-Lock When Leaving App</div>
            <div className="text-[11px] text-slate-400">
              Lock app immediately upon closing or switching away
            </div>
          </div>
          <select
            value={config.autoLockDelaySeconds}
            onChange={(e) =>
              onUpdateConfig({
                ...config,
                autoLockDelaySeconds: Number(e.target.value),
              })
            }
            className="px-3 py-1.5 rounded-xl bg-slate-800 border border-slate-700 text-xs font-semibold text-slate-200 focus:outline-none focus:border-cyan-500 cursor-pointer"
          >
            <option value={0}>Immediately</option>
            <option value={30}>After 30 Seconds</option>
            <option value={60}>After 1 Minute</option>
            <option value={300}>After 5 Minutes</option>
          </select>
        </div>
      </div>

      {/* Reset to Factory Defaults */}
      <div className="flex items-center justify-between pt-2">
        <button
          type="button"
          onClick={() => {
            if (window.confirm("Reset all settings, PIN (1234), and patterns to default?")) {
              onResetAll();
              showToast("Settings reset to defaults");
            }
          }}
          className="text-xs text-red-400 hover:text-red-300 flex items-center gap-1.5 px-3 py-2 rounded-xl hover:bg-red-950/40 transition-colors"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          Reset AppLock & Credentials
        </button>

        <span className="text-[11px] text-slate-400">
          AppLock & Vault v2.4 • Ad-Free Edition
        </span>
      </div>
    </div>
  );
};
