import React, { useState } from "react";
import { usePWAInstall } from "../hooks/usePWAInstall";
import {
  Download,
  Smartphone,
  CheckCircle2,
  Share2,
  ExternalLink,
  Copy,
  Check,
  X,
  ShieldCheck,
  Layers,
  Sparkles,
} from "lucide-react";

export const PWAInstallButton: React.FC = () => {
  const { isInstallable, isInstalled, isIOS, isAndroid, install } = usePWAInstall();
  const [isOpen, setIsOpen] = useState<boolean>(false);
  const [copied, setCopied] = useState<boolean>(false);

  const currentUrl = typeof window !== "undefined" ? window.location.href : "";

  const handleCopyLink = () => {
    navigator.clipboard.writeText(currentUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  };

  const handleDirectInstall = async () => {
    if (isInstallable) {
      await install();
      setIsOpen(false);
    } else {
      setIsOpen(true);
    }
  };

  return (
    <>
      {/* Header / Nav Trigger Button */}
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-gradient-to-r from-emerald-500 to-cyan-500 hover:from-emerald-400 hover:to-cyan-400 text-slate-950 font-bold text-xs shadow-md shadow-emerald-500/20 transition-all cursor-pointer"
        title="Install on Mobile Phone"
      >
        <Download className="w-3.5 h-3.5" />
        <span className="hidden sm:inline">Install Mobile App</span>
        <span className="sm:hidden">انسٹال کریں</span>
      </button>

      {/* Installer Modal */}
      {isOpen && (
        <div className="fixed inset-0 z-50 bg-slate-950/90 backdrop-blur-md flex items-center justify-center p-4 overflow-y-auto animate-scale-up">
          <div className="bg-slate-900 border border-slate-800 rounded-3xl max-w-lg w-full overflow-hidden shadow-2xl flex flex-col">
            {/* Modal Header */}
            <div className="p-5 border-b border-slate-800 flex items-center justify-between bg-slate-900/90">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-2xl bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center text-emerald-400">
                  <Smartphone className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-slate-100 flex items-center gap-2">
                    Mobile App Installer
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 font-semibold border border-emerald-500/30">
                      PWA Universal
                    </span>
                  </h3>
                  <p className="text-xs text-slate-400">
                    Works on Android, Samsung, Xiaomi, Vivo, Oppo & iPhone
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setIsOpen(false)}
                className="p-1.5 rounded-xl hover:bg-slate-800 text-slate-400 hover:text-slate-200 transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Modal Body */}
            <div className="p-5 space-y-5 max-h-[78vh] overflow-y-auto">
              {/* Direct 1-Click Install Button if supported */}
              {isInstallable && (
                <div className="p-4 rounded-2xl bg-gradient-to-r from-emerald-950/60 to-cyan-950/50 border border-emerald-500/40 flex flex-col gap-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-emerald-300">
                      Quick 1-Tap Direct Install
                    </span>
                    <span className="text-[10px] px-2 py-0.5 rounded bg-emerald-500 text-slate-950 font-extrabold">
                      READY
                    </span>
                  </div>
                  <p className="text-xs text-slate-300">
                    Your browser supports direct installation. Tap below to install directly to your device home screen with standalone app icon.
                  </p>
                  <button
                    type="button"
                    onClick={handleDirectInstall}
                    className="w-full py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-xs flex items-center justify-center gap-2 shadow-lg transition-colors cursor-pointer"
                  >
                    <Download className="w-4 h-4" />
                    Install Now (ابھی انسٹال کریں)
                  </button>
                </div>
              )}

              {/* Step by Step Guide for Android */}
              <div className="p-4 rounded-2xl bg-slate-950/80 border border-slate-800 space-y-3">
                <div className="flex items-center gap-2 text-xs font-bold text-slate-200">
                  <Smartphone className="w-4 h-4 text-emerald-400" />
                  <span>Android Phones (Samsung, Vivo, Xiaomi, Oppo, Realme)</span>
                </div>
                <div className="space-y-2 text-xs text-slate-300">
                  <div className="flex items-start gap-2">
                    <span className="w-5 h-5 rounded-full bg-slate-800 text-slate-300 text-[11px] font-bold flex items-center justify-center shrink-0 mt-0.5">
                      1
                    </span>
                    <span>
                      Open this URL in <strong>Google Chrome</strong> or <strong>Samsung Internet</strong> on your phone.
                    </span>
                  </div>
                  <div className="flex items-start gap-2">
                    <span className="w-5 h-5 rounded-full bg-slate-800 text-slate-300 text-[11px] font-bold flex items-center justify-center shrink-0 mt-0.5">
                      2
                    </span>
                    <span>
                      Tap the 3 dots menu (<strong>⋮</strong>) at the top right of Chrome.
                    </span>
                  </div>
                  <div className="flex items-start gap-2">
                    <span className="w-5 h-5 rounded-full bg-slate-800 text-slate-300 text-[11px] font-bold flex items-center justify-center shrink-0 mt-0.5">
                      3
                    </span>
                    <span>
                      Select <strong>"Install app"</strong> or <strong>"Add to Home Screen"</strong> (ایپ انسٹال کریں).
                    </span>
                  </div>
                </div>
              </div>

              {/* Step by Step Guide for iPhone / iPad */}
              <div className="p-4 rounded-2xl bg-slate-950/80 border border-slate-800 space-y-3">
                <div className="flex items-center gap-2 text-xs font-bold text-slate-200">
                  <Share2 className="w-4 h-4 text-cyan-400" />
                  <span>Apple iPhone / iPad (iOS Safari)</span>
                </div>
                <div className="space-y-2 text-xs text-slate-300">
                  <div className="flex items-start gap-2">
                    <span className="w-5 h-5 rounded-full bg-slate-800 text-slate-300 text-[11px] font-bold flex items-center justify-center shrink-0 mt-0.5">
                      1
                    </span>
                    <span>
                      Open this URL in <strong>Safari</strong> browser on iPhone.
                    </span>
                  </div>
                  <div className="flex items-start gap-2">
                    <span className="w-5 h-5 rounded-full bg-slate-800 text-slate-300 text-[11px] font-bold flex items-center justify-center shrink-0 mt-0.5">
                      2
                    </span>
                    <span>
                      Tap the <strong>Share</strong> button (box with an arrow up ⎋) at the bottom.
                    </span>
                  </div>
                  <div className="flex items-start gap-2">
                    <span className="w-5 h-5 rounded-full bg-slate-800 text-slate-300 text-[11px] font-bold flex items-center justify-center shrink-0 mt-0.5">
                      3
                    </span>
                    <span>
                      Scroll down and tap <strong>"Add to Home Screen"</strong> (ہوم اسکرین پر شامل کریں).
                    </span>
                  </div>
                </div>
              </div>

              {/* Share & Copy Link section */}
              <div className="p-4 rounded-2xl bg-slate-950/80 border border-slate-800 flex flex-col gap-2.5">
                <label className="text-xs font-bold text-slate-300">
                  App Link (Send to your phone via WhatsApp or SMS):
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    readOnly
                    value={currentUrl}
                    className="flex-1 px-3 py-2 rounded-xl bg-slate-900 border border-slate-700 text-xs text-slate-300 select-all font-mono truncate"
                  />
                  <button
                    type="button"
                    onClick={handleCopyLink}
                    className="px-3.5 py-2 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-bold text-xs flex items-center gap-1.5 transition-colors shrink-0"
                  >
                    {copied ? (
                      <>
                        <Check className="w-4 h-4 text-slate-950" />
                        Copied!
                      </>
                    ) : (
                      <>
                        <Copy className="w-4 h-4 text-slate-950" />
                        Copy Link
                      </>
                    )}
                  </button>
                </div>
              </div>

              {/* APK Packaging Tip */}
              <div className="p-4 rounded-2xl bg-slate-900/60 border border-slate-800 text-xs text-slate-400 leading-relaxed">
                <div className="font-bold text-slate-300 mb-1 flex items-center gap-1.5">
                  <ShieldCheck className="w-4 h-4 text-emerald-400" />
                  Direct Android APK Package
                </div>
                Agar aapko pure <strong>.APK</strong> file generate karni ho to aap is app ke URL ko{" "}
                <a
                  href="https://www.pwabuilder.com"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-cyan-400 hover:underline font-semibold"
                >
                  PWABuilder.com
                </a>{" "}
                mein enter karke 1-click se Android Studio signed APK download kar sakte hain!
              </div>
            </div>

            {/* Modal Footer */}
            <div className="p-4 border-t border-slate-800 bg-slate-950 flex justify-end">
              <button
                type="button"
                onClick={() => setIsOpen(false)}
                className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold transition-colors"
              >
                Close (بند کریں)
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};
