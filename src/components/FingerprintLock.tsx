import React, { useState, useEffect } from "react";
import { Fingerprint, CheckCircle2, XCircle, ShieldAlert } from "lucide-react";

interface FingerprintLockProps {
  onSuccess: () => void;
  onFailure: () => void;
  title?: string;
  subtitle?: string;
}

export const FingerprintLock: React.FC<FingerprintLockProps> = ({
  onSuccess,
  onFailure,
  title = "Biometric Sensor",
  subtitle = "Touch and hold sensor to verify identity",
}) => {
  const [scanning, setScanning] = useState<boolean>(false);
  const [scanProgress, setScanProgress] = useState<number>(0);
  const [scanResult, setScanResult] = useState<"idle" | "success" | "failure">("idle");
  const [message, setMessage] = useState<string>("");

  useEffect(() => {
    let interval: NodeJS.Timeout;
    if (scanning) {
      interval = setInterval(() => {
        setScanProgress((prev) => {
          if (prev >= 100) {
            clearInterval(interval);
            return 100;
          }
          return prev + 12;
        });
      }, 70);
    } else {
      setScanProgress(0);
    }
    return () => clearInterval(interval);
  }, [scanning]);

  useEffect(() => {
    if (scanProgress >= 100 && scanning) {
      setScanning(false);
      setScanResult("success");
      setMessage("Biometric Authenticated");
      if (typeof navigator !== "undefined" && navigator.vibrate) {
        try { navigator.vibrate([40, 60, 40]); } catch { /* ignore */ }
      }
      setTimeout(() => {
        onSuccess();
      }, 500);
    }
  }, [scanProgress, scanning, onSuccess]);

  const handleTouchStart = () => {
    if (scanResult !== "idle") return;
    setScanning(true);
    setMessage("Reading biometric ridges...");
  };

  const handleTouchEnd = () => {
    if (scanProgress < 100 && scanResult === "idle") {
      setScanning(false);
      setMessage("Hold a little longer to complete scan");
    }
  };

  const handleTriggerIntruderFail = () => {
    setScanning(false);
    setScanResult("failure");
    setMessage("Fingerprint not recognized! Intruder alert triggered.");
    if (typeof navigator !== "undefined" && navigator.vibrate) {
      try { navigator.vibrate(200); } catch { /* ignore */ }
    }
    onFailure();
    setTimeout(() => {
      setScanResult("idle");
      setMessage("");
    }, 1500);
  };

  return (
    <div className="flex flex-col items-center justify-center w-full max-w-sm mx-auto p-4 select-none text-center">
      <div className="mb-6">
        <h3 className="text-lg font-semibold text-slate-100">{title}</h3>
        <p className="text-xs text-slate-400 mt-1">{message || subtitle}</p>
      </div>

      {/* Sensor Pad */}
      <div className="relative flex items-center justify-center mb-6">
        {/* Progress Ring */}
        <svg className="w-36 h-36 -rotate-90">
          <circle
            cx="72"
            cy="72"
            r="64"
            stroke="currentColor"
            strokeWidth="4"
            fill="transparent"
            className="text-slate-800"
          />
          <circle
            cx="72"
            cy="72"
            r="64"
            stroke="currentColor"
            strokeWidth="4"
            fill="transparent"
            strokeDasharray={402}
            strokeDashoffset={402 - (402 * scanProgress) / 100}
            strokeLinecap="round"
            className={`transition-all duration-75 ${
              scanResult === "success"
                ? "text-emerald-400"
                : scanResult === "failure"
                ? "text-red-500"
                : "text-cyan-400"
            }`}
          />
        </svg>

        {/* Interactive Sensor Button */}
        <button
          type="button"
          onMouseDown={handleTouchStart}
          onMouseUp={handleTouchEnd}
          onTouchStart={handleTouchStart}
          onTouchEnd={handleTouchEnd}
          className={`absolute w-28 h-28 rounded-full flex flex-col items-center justify-center transition-all duration-300 border shadow-2xl ${
            scanResult === "success"
              ? "bg-emerald-500/20 border-emerald-500 shadow-emerald-500/30"
              : scanResult === "failure"
              ? "bg-red-500/20 border-red-500 shadow-red-500/30"
              : scanning
              ? "bg-cyan-500/20 border-cyan-400 shadow-cyan-400/40 scale-95"
              : "bg-slate-900/90 border-slate-700 hover:border-cyan-500/50 hover:bg-slate-800"
          }`}
        >
          {/* Laser scan line animation */}
          {scanning && (
            <div className="absolute inset-x-2 h-0.5 bg-cyan-300 shadow-[0_0_8px_#38bdf8] animate-pulse -translate-y-4" />
          )}

          {scanResult === "success" ? (
            <CheckCircle2 className="w-12 h-12 text-emerald-400 animate-scale-up" />
          ) : scanResult === "failure" ? (
            <XCircle className="w-12 h-12 text-red-500 animate-shake" />
          ) : (
            <Fingerprint
              className={`w-14 h-14 transition-colors ${
                scanning
                  ? "text-cyan-300 animate-pulse"
                  : "text-slate-400 group-hover:text-cyan-400"
              }`}
            />
          )}

          <span className="text-[10px] font-medium tracking-wide mt-1 text-slate-400">
            {scanning ? `${scanProgress}%` : "TOUCH SENSOR"}
          </span>
        </button>
      </div>

      <div className="flex flex-col gap-2 w-full max-w-xs">
        {/* Quick tap button for desktop/mouse clicks */}
        <button
          type="button"
          onClick={() => {
            setScanProgress(100);
            setScanning(true);
          }}
          className="py-2 px-3 rounded-xl bg-slate-800/80 hover:bg-slate-700 text-xs text-cyan-300 border border-slate-700 flex items-center justify-center gap-1.5 transition-colors"
        >
          <Fingerprint className="w-3.5 h-3.5" />
          One-Click Instant Fingerprint
        </button>

        {/* Failed attempt simulation button for testing intruder selfie */}
        <button
          type="button"
          onClick={handleTriggerIntruderFail}
          className="py-1.5 px-3 rounded-xl bg-red-950/40 hover:bg-red-900/50 text-xs text-red-300 border border-red-900/50 flex items-center justify-center gap-1.5 transition-colors"
        >
          <ShieldAlert className="w-3.5 h-3.5 text-red-400" />
          Simulate Unmatched Finger (Trigger Intruder Selfie)
        </button>
      </div>
    </div>
  );
};
