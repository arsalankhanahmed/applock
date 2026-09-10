import React, { useState, useEffect } from "react";
import { AppItem } from "../types";
import {
  Lock,
  ArrowLeft,
  Clock,
  Send,
  Heart,
  MessageCircle,
  Share2,
  CheckCircle,
  AlertCircle,
  DollarSign,
  Shield,
  Smartphone,
} from "lucide-react";

interface SimulatedAppWindowProps {
  app: AppItem;
  onClose: () => void;
  onAppLockAgain: () => void;
  onIncrementUsage: (id: string, mins: number) => void;
}

export const SimulatedAppWindow: React.FC<SimulatedAppWindowProps> = ({
  app,
  onClose,
  onAppLockAgain,
  onIncrementUsage,
}) => {
  const [sessionSeconds, setSessionSeconds] = useState<number>(0);
  const [mockMessage, setMockMessage] = useState<string>("");
  const [chatLog, setChatLog] = useState<string[]>([
    "Hey! Are you using the new AppLock?",
    "Yes, my private vault and intruder selfie are now active!",
  ]);

  useEffect(() => {
    const timer = setInterval(() => {
      setSessionSeconds((s) => s + 1);
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const formatSessionTime = (totalSeconds: number) => {
    const mins = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;
    return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  };

  const handleSendMessage = (e: React.FormEvent) => {
    e.preventDefault();
    if (!mockMessage.trim()) return;
    setChatLog((prev) => [...prev, mockMessage.trim()]);
    setMockMessage("");
  };

  return (
    <div className="fixed inset-0 z-40 bg-slate-950 flex flex-col justify-between overflow-hidden">
      {/* Phone Header / Status bar */}
      <div className="bg-slate-900 border-b border-slate-800 p-3 sm:p-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-xl hover:bg-slate-800 text-slate-300 transition-colors"
            title="Exit App"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div
            className={`w-9 h-9 rounded-xl ${app.color} flex items-center justify-center text-white font-bold text-sm`}
          >
            {app.name.charAt(0)}
          </div>
          <div>
            <h3 className="text-sm font-bold text-slate-100 flex items-center gap-1.5">
              {app.name}
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-400 font-semibold border border-emerald-500/30">
                Unlocked
              </span>
            </h3>
            <p className="text-[11px] text-slate-400">
              {app.packageName}
            </p>
          </div>
        </div>

        {/* Live Active Session & Lock Now */}
        <div className="flex items-center gap-3">
          <div className="hidden sm:flex items-center gap-1.5 text-xs text-amber-300 bg-amber-500/10 px-3 py-1 rounded-xl border border-amber-500/20">
            <Clock className="w-3.5 h-3.5" />
            <span>Session: {formatSessionTime(sessionSeconds)}</span>
          </div>

          <button
            type="button"
            onClick={onAppLockAgain}
            className="px-3 py-1.5 rounded-xl bg-cyan-500/15 hover:bg-cyan-500/25 text-cyan-300 border border-cyan-500/30 text-xs font-semibold flex items-center gap-1.5 transition-colors"
          >
            <Lock className="w-3.5 h-3.5" />
            Re-Lock App
          </button>
        </div>
      </div>

      {/* App Body Content Simulation */}
      <div className="flex-1 overflow-y-auto p-4 max-w-2xl mx-auto w-full flex flex-col justify-between">
        {/* Customized view depending on app */}
        {app.id === "whatsapp" || app.id === "messages" ? (
          <div className="flex flex-col h-full justify-between">
            <div className="space-y-3 flex-1 overflow-y-auto pr-1">
              <div className="text-center my-2">
                <span className="text-[10px] px-2.5 py-1 rounded-full bg-slate-900 text-slate-400 border border-slate-800">
                  🔒 Messages are end-to-end encrypted & protected by AppLock
                </span>
              </div>

              {chatLog.map((msg, i) => (
                <div
                  key={i}
                  className={`flex ${
                    i % 2 === 0 ? "justify-start" : "justify-end"
                  }`}
                >
                  <div
                    className={`max-w-[75%] px-3.5 py-2 rounded-2xl text-xs ${
                      i % 2 === 0
                        ? "bg-slate-900 text-slate-200 border border-slate-800"
                        : "bg-emerald-600 text-white"
                    }`}
                  >
                    {msg}
                  </div>
                </div>
              ))}
            </div>

            <form
              onSubmit={handleSendMessage}
              className="mt-4 flex items-center gap-2 p-2 rounded-2xl bg-slate-900 border border-slate-800"
            >
              <input
                type="text"
                placeholder="Type a simulated message..."
                value={mockMessage}
                onChange={(e) => setMockMessage(e.target.value)}
                className="flex-1 px-3 py-1.5 bg-transparent text-xs text-slate-100 placeholder-slate-500 focus:outline-none"
              />
              <button
                type="submit"
                className="p-2 rounded-xl bg-emerald-500 text-slate-950 hover:bg-emerald-400 font-bold"
              >
                <Send className="w-4 h-4" />
              </button>
            </form>
          </div>
        ) : app.id === "banking" ? (
          <div className="flex flex-col gap-4 py-4">
            <div className="p-6 rounded-3xl bg-gradient-to-br from-blue-900 to-indigo-950 border border-blue-500/30 text-white shadow-xl">
              <div className="flex items-center justify-between text-xs text-blue-200">
                <span>Secure Premier Account</span>
                <span>Active Protection</span>
              </div>
              <div className="text-3xl font-extrabold mt-3 tracking-tight">
                $14,850.00
              </div>
              <div className="text-xs text-blue-300 mt-2 font-mono">
                •••• •••• •••• 8842
              </div>
            </div>

            <div className="p-4 rounded-2xl bg-slate-900 border border-slate-800 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-blue-500/15 flex items-center justify-center text-blue-400 font-bold">
                  $
                </div>
                <div>
                  <div className="text-xs font-bold text-slate-200">Latest Transfer</div>
                  <div className="text-[10px] text-slate-400">Sent to Savings Vault</div>
                </div>
              </div>
              <span className="text-xs font-bold text-emerald-400">+$250.00</span>
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-center py-8">
            <div
              className={`w-20 h-20 rounded-3xl ${app.color} flex items-center justify-center text-white font-extrabold text-3xl shadow-xl mb-4`}
            >
              {app.name.charAt(0)}
            </div>
            <h3 className="text-lg font-bold text-slate-100">
              Welcome to {app.name}
            </h3>
            <p className="text-xs text-slate-400 max-w-sm mt-1 mb-6">
              You have successfully bypassed the AppLock security screen using authorized credentials.
            </p>

            <div className="p-4 rounded-2xl bg-slate-900/90 border border-slate-800 w-full max-w-sm flex items-center justify-between text-xs">
              <span className="text-slate-400">Today's Usage:</span>
              <span className="text-cyan-400 font-bold">
                {app.usedMinutesToday} minutes logged
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Bottom Bar */}
      <div className="bg-slate-900 border-t border-slate-800 p-3 flex items-center justify-between text-xs text-slate-400">
        <span className="flex items-center gap-1.5">
          <CheckCircle className="w-3.5 h-3.5 text-emerald-400" />
          Verified Secure Environment
        </span>
        <button
          type="button"
          onClick={onClose}
          className="text-cyan-400 hover:underline font-semibold"
        >
          Return to AppLock Dashboard
        </button>
      </div>
    </div>
  );
};
