import React, { useState } from "react";
import { AppItem, LockType, SecurityConfig, IntruderLog } from "../types";
import { PatternLock } from "./PatternLock";
import { PinLock } from "./PinLock";
import { FingerprintLock } from "./FingerprintLock";
import { captureFrontCameraPhoto } from "../utils/camera";
import {
  Shield,
  KeyRound,
  Grid3X3,
  Fingerprint,
  Camera,
  AlertTriangle,
  Clock,
  Lock,
  X,
} from "lucide-react";

interface AppLockScreenProps {
  app: AppItem;
  config: SecurityConfig;
  onUnlockSuccess: () => void;
  onCancel: () => void;
  onIntruderCaptured: (log: IntruderLog) => void;
  onExtendUsageLimit?: (minutes: number) => void;
}

export const AppLockScreen: React.FC<AppLockScreenProps> = ({
  app,
  config,
  onUnlockSuccess,
  onCancel,
  onIntruderCaptured,
  onExtendUsageLimit,
}) => {
  const [activeTab, setActiveTab] = useState<LockType>(config.primaryLockType);
  const [wrongAttempts, setWrongAttempts] = useState<number>(0);
  const [intruderTriggered, setIntruderTriggered] = useState<boolean>(false);
  const [lastIntruderPhoto, setLastIntruderPhoto] = useState<string | null>(null);

  const isLimitReached =
    app.usageLimitMinutes > 0 && app.usedMinutesToday >= app.usageLimitMinutes;

  const handleFailedAttempt = async (method: LockType) => {
    const nextAttempts = wrongAttempts + 1;
    setWrongAttempts(nextAttempts);

    if (nextAttempts >= config.intruderThreshold) {
      setIntruderTriggered(true);

      // Trigger intruder selfie capture
      const { photoUrl, isRealCapture } = await captureFrontCameraPhoto();
      setLastIntruderPhoto(photoUrl);

      const newLog: IntruderLog = {
        id: `intruder-${Date.now()}`,
        timestamp: Date.now(),
        photoUrl,
        targetAppName: app.name,
        method,
        attemptCount: nextAttempts,
        status: isRealCapture ? "Captured" : "Simulated",
        notes: `Intruder attempted to open ${app.name} with incorrect ${method.toUpperCase()}`,
      };

      onIntruderCaptured(newLog);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/95 backdrop-blur-xl flex flex-col justify-between p-4 sm:p-6 overflow-y-auto">
      {/* Top Bar: Target App info & close */}
      <div className="flex items-center justify-between w-full max-w-md mx-auto pt-2">
        <div className="flex items-center gap-3">
          <div
            className={`w-11 h-11 rounded-2xl ${app.color} flex items-center justify-center text-white font-bold shadow-lg`}
          >
            <Lock className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-base font-bold text-slate-100">{app.name}</h2>
              <span className="text-xs px-2 py-0.5 rounded-full bg-slate-800 text-slate-300 border border-slate-700">
                Locked
              </span>
            </div>
            <p className="text-xs text-slate-400">
              {app.nameUrdu} • Protected by AppLock
            </p>
          </div>
        </div>

        <button
          type="button"
          onClick={onCancel}
          className="p-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-slate-400 hover:text-slate-200 border border-slate-800 transition-colors"
          title="Cancel / Return to home"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      {/* App Usage Limit Alert Banner if limit exceeded */}
      {isLimitReached && (
        <div className="w-full max-w-md mx-auto my-3 p-3.5 rounded-2xl bg-amber-500/10 border border-amber-500/30 flex items-start gap-3">
          <Clock className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
          <div className="flex-1">
            <h4 className="text-xs font-semibold text-amber-300">
              App Usage Limit Reached ({app.usedMinutesToday}/{app.usageLimitMinutes} mins)
            </h4>
            <p className="text-[11px] text-amber-400/80 mt-0.5">
              Daily time quota exhausted. Unlock with master code to extend by 15 mins.
            </p>
            {onExtendUsageLimit && (
              <button
                type="button"
                onClick={() => onExtendUsageLimit(15)}
                className="mt-2 text-xs font-medium px-3 py-1 rounded-lg bg-amber-500 text-slate-950 hover:bg-amber-400 transition-colors"
              >
                + Extend 15 Minutes
              </button>
            )}
          </div>
        </div>
      )}

      {/* Intruder Warning Toast if triggered */}
      {intruderTriggered && (
        <div className="w-full max-w-md mx-auto my-2 p-3 rounded-2xl bg-red-950/70 border border-red-500/50 flex items-center gap-3 animate-bounce-subtle">
          <div className="p-2 rounded-xl bg-red-900/50 text-red-400">
            <Camera className="w-5 h-5" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 text-xs font-bold text-red-400">
              <AlertTriangle className="w-3.5 h-3.5" />
              <span>Intruder Selfie Captured!</span>
            </div>
            <p className="text-[11px] text-red-300/80 truncate">
              {wrongAttempts} failed attempts recorded and saved to security log.
            </p>
          </div>
          {lastIntruderPhoto && (
            <img
              src={lastIntruderPhoto}
              alt="Intruder thumbnail"
              className="w-10 h-10 rounded-lg object-cover border border-red-500/50 shrink-0"
            />
          )}
        </div>
      )}

      {/* Main Lock Component according to chosen option */}
      <div className="w-full max-w-md mx-auto my-auto py-2">
        {activeTab === "pattern" && (
          <PatternLock
            targetPattern={config.pattern}
            onSuccess={onUnlockSuccess}
            onFailure={() => handleFailedAttempt("pattern")}
            title={`Unlock ${app.name}`}
            subtitle="Connect your pattern to open"
          />
        )}

        {activeTab === "pin" && (
          <PinLock
            targetPin={config.pin}
            onSuccess={onUnlockSuccess}
            onFailure={() => handleFailedAttempt("pin")}
            title={`Enter PIN for ${app.name}`}
            subtitle="Enter your 4-digit passcode"
          />
        )}

        {activeTab === "fingerprint" && (
          <FingerprintLock
            onSuccess={onUnlockSuccess}
            onFailure={() => handleFailedAttempt("fingerprint")}
            title={`Scan Fingerprint for ${app.name}`}
            subtitle="Place registered finger on sensor"
          />
        )}
      </div>

      {/* Lock Method Switcher Tabs (Passcode, Pattern, Fingerprint) */}
      <div className="w-full max-w-xs mx-auto pb-4">
        <div className="p-1 rounded-2xl bg-slate-900/80 border border-slate-800 flex items-center justify-around shadow-inner">
          <button
            type="button"
            onClick={() => setActiveTab("pattern")}
            className={`flex-1 py-2 px-3 rounded-xl text-xs font-medium flex items-center justify-center gap-1.5 transition-all ${
              activeTab === "pattern"
                ? "bg-cyan-500 text-slate-950 font-bold shadow-md shadow-cyan-500/20"
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            <Grid3X3 className="w-4 h-4" />
            Pattern
          </button>

          <button
            type="button"
            onClick={() => setActiveTab("pin")}
            className={`flex-1 py-2 px-3 rounded-xl text-xs font-medium flex items-center justify-center gap-1.5 transition-all ${
              activeTab === "pin"
                ? "bg-cyan-500 text-slate-950 font-bold shadow-md shadow-cyan-500/20"
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            <KeyRound className="w-4 h-4" />
            Passcode
          </button>

          <button
            type="button"
            onClick={() => setActiveTab("fingerprint")}
            className={`flex-1 py-2 px-3 rounded-xl text-xs font-medium flex items-center justify-center gap-1.5 transition-all ${
              activeTab === "fingerprint"
                ? "bg-cyan-500 text-slate-950 font-bold shadow-md shadow-cyan-500/20"
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            <Fingerprint className="w-4 h-4" />
            Touch ID
          </button>
        </div>

        <p className="text-center text-[10px] text-slate-400 mt-2">
          Intruder Selfie Trigger: {config.intruderThreshold} wrong attempts • 100% Ad-Free
        </p>
      </div>
    </div>
  );
};
