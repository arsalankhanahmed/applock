import React, { useState } from "react";
import { AppItem } from "../types";
import {
  Lock,
  Unlock,
  Clock,
  Play,
  Search,
  CheckCircle,
  AlertCircle,
  Smartphone,
  ShieldCheck,
  Info,
  Plus,
  Trash2,
  X,
  Code2,
  AlertTriangle,
} from "lucide-react";
import { AndroidApkGuide } from "./AndroidApkGuide";

interface AppLockManagerProps {
  apps: AppItem[];
  onToggleLock: (id: string) => void;
  onUpdateUsageLimit: (id: string, minutes: number) => void;
  onSimulateAppLaunch: (app: AppItem) => void;
  onResetAppUsage: (id: string) => void;
  onDeleteApp: (id: string) => void;
  onAddApp: (app: AppItem) => void;
}

export const AppLockManager: React.FC<AppLockManagerProps> = ({
  apps,
  onToggleLock,
  onUpdateUsageLimit,
  onSimulateAppLaunch,
  onResetAppUsage,
  onDeleteApp,
  onAddApp,
}) => {
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedCategory, setSelectedCategory] = useState<string>("All");
  const [editingLimitAppId, setEditingLimitAppId] = useState<string | null>(null);
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [showApkGuide, setShowApkGuide] = useState(false);

  // New App Form State
  const [newAppName, setNewAppName] = useState("");
  const [newAppCategory, setNewAppCategory] = useState<"Social" | "Utility" | "Finance" | "Entertainment">("Social");

  const categories = ["All", "Social", "Utility", "Finance", "Entertainment"];

  const filteredApps = apps.filter((app) => {
    const matchesSearch =
      app.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      app.nameUrdu.includes(searchQuery);
    const matchesCategory =
      selectedCategory === "All" || app.category === selectedCategory;
    return matchesSearch && matchesCategory;
  });

  const lockedCount = apps.filter((a) => a.isLocked).length;

  const handleCreateApp = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newAppName.trim()) return;

    const colors = [
      "bg-emerald-600",
      "bg-blue-600",
      "bg-purple-600",
      "bg-rose-600",
      "bg-amber-600",
      "bg-cyan-600",
    ];
    const randomColor = colors[Math.floor(Math.random() * colors.length)];

    const created: AppItem = {
      id: `custom-${Date.now()}`,
      name: newAppName.trim(),
      nameUrdu: newAppName.trim(),
      packageName: `com.${newAppName.toLowerCase().replace(/[^a-z0-9]/g, "")}.app`,
      iconName: "Smartphone",
      color: randomColor,
      category: newAppCategory,
      isLocked: true,
      usageLimitMinutes: 30,
      usedMinutesToday: 0,
      isTemporarilyUnlocked: false,
    };

    onAddApp(created);
    setNewAppName("");
    setIsAddModalOpen(false);
  };

  return (
    <div className="flex flex-col gap-6">
      {/* Overview Stat Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="p-4 rounded-2xl bg-slate-900/90 border border-slate-800 flex items-center justify-between">
          <div>
            <span className="text-xs text-slate-400 font-medium">Protected Apps</span>
            <div className="text-2xl font-bold text-cyan-400 mt-1">
              {lockedCount}{" "}
              <span className="text-sm font-normal text-slate-400">/ {apps.length}</span>
            </div>
          </div>
          <div className="w-10 h-10 rounded-xl bg-cyan-500/10 border border-cyan-500/20 flex items-center justify-center text-cyan-400">
            <Lock className="w-5 h-5" />
          </div>
        </div>

        <div className="p-4 rounded-2xl bg-slate-900/90 border border-slate-800 flex items-center justify-between">
          <div>
            <span className="text-xs text-slate-400 font-medium">Apps with Usage Limits</span>
            <div className="text-2xl font-bold text-amber-400 mt-1">
              {apps.filter((a) => a.usageLimitMinutes > 0).length}
            </div>
          </div>
          <div className="w-10 h-10 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center text-amber-400">
            <Clock className="w-5 h-5" />
          </div>
        </div>

        <div className="p-4 rounded-2xl bg-slate-900/90 border border-slate-800 flex items-center justify-between">
          <div>
            <span className="text-xs text-slate-400 font-medium">Ad-Free Security</span>
            <div className="text-base font-semibold text-emerald-400 mt-1 flex items-center gap-1.5">
              <ShieldCheck className="w-4 h-4" /> 100% Ad-Free
            </div>
          </div>
          <span className="text-[10px] px-2 py-1 rounded-full bg-emerald-500/10 text-emerald-300 border border-emerald-500/30">
            Active
          </span>
        </div>
      </div>

      {/* Notice Banner: Browser Sandbox vs Android OS APK */}
      <div className="p-4 rounded-2xl bg-slate-900/95 border border-amber-500/30 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
        <div className="flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
          <div>
            <h4 className="text-xs font-bold text-slate-100">
              Browser Web App vs Real Android System APK
            </h4>
            <p className="text-[11px] text-slate-400 mt-0.5 leading-relaxed">
              Web apps run in browser sandbox and cannot block external Android apps directly. You can test locking below, add/delete your apps, or view the native Android Kotlin source code for a real OS APK.
            </p>
          </div>
        </div>

        <button
          type="button"
          onClick={() => setShowApkGuide(!showApkGuide)}
          className="px-3 py-1.5 rounded-xl bg-amber-500/15 hover:bg-amber-500/25 text-amber-300 border border-amber-500/40 text-xs font-bold flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0"
        >
          <Code2 className="w-4 h-4" />
          {showApkGuide ? "Hide APK Guide" : "Real APK Source Code"}
        </button>
      </div>

      {/* APK Guide Accordion */}
      {showApkGuide && <AndroidApkGuide />}

      {/* Filter, Search & Add App Bar */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
        <div className="relative flex-1">
          <Search className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            placeholder="Search apps (e.g. WhatsApp, Photos)..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-10 pr-4 py-2.5 rounded-xl bg-slate-900 border border-slate-800 text-sm text-slate-100 placeholder-slate-400 focus:outline-none focus:border-cyan-500 transition-colors"
          />
        </div>

        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5 overflow-x-auto pb-1 sm:pb-0">
            {categories.map((cat) => (
              <button
                key={cat}
                type="button"
                onClick={() => setSelectedCategory(cat)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-all ${
                  selectedCategory === cat
                    ? "bg-cyan-500 text-slate-950 font-semibold"
                    : "bg-slate-900 text-slate-400 hover:text-slate-200 border border-slate-800"
                }`}
              >
                {cat}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={() => setIsAddModalOpen(true)}
            className="px-3.5 py-2 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-bold text-xs flex items-center gap-1.5 transition-colors shrink-0 shadow-md shadow-cyan-500/20"
          >
            <Plus className="w-4 h-4" />
            + Add App
          </button>
        </div>
      </div>

      {/* Add Custom App Modal */}
      {isAddModalOpen && (
        <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-3xl max-w-md w-full p-5 shadow-2xl space-y-4 animate-scale-up">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h3 className="text-sm font-bold text-slate-100 flex items-center gap-2">
                <Smartphone className="w-4 h-4 text-cyan-400" />
                Add Your Mobile App to AppLock
              </h3>
              <button
                type="button"
                onClick={() => setIsAddModalOpen(false)}
                className="p-1 rounded-lg text-slate-400 hover:text-slate-200"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleCreateApp} className="space-y-4">
              <div>
                <label className="text-xs text-slate-300 font-medium block mb-1">
                  App Name (e.g. JazzCash, Easypaisa, Gallery, Snapchat):
                </label>
                <input
                  type="text"
                  required
                  placeholder="Enter app name..."
                  value={newAppName}
                  onChange={(e) => setNewAppName(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-xs text-slate-100 focus:outline-none focus:border-cyan-500"
                />
              </div>

              <div>
                <label className="text-xs text-slate-300 font-medium block mb-1">
                  Category:
                </label>
                <select
                  value={newAppCategory}
                  onChange={(e) => setNewAppCategory(e.target.value as any)}
                  className="w-full px-3 py-2 rounded-xl bg-slate-950 border border-slate-800 text-xs text-slate-100 focus:outline-none focus:border-cyan-500"
                >
                  <option value="Social">Social</option>
                  <option value="Finance">Finance</option>
                  <option value="Utility">Utility</option>
                  <option value="Entertainment">Entertainment</option>
                </select>
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setIsAddModalOpen(false)}
                  className="px-3.5 py-1.5 rounded-xl text-xs text-slate-400 hover:bg-slate-800"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-1.5 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-bold text-xs transition-colors"
                >
                  Add & Lock App
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Apps List */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
        {filteredApps.map((app) => {
          const isLimitReached =
            app.usageLimitMinutes > 0 &&
            app.usedMinutesToday >= app.usageLimitMinutes;

          const percentageUsed =
            app.usageLimitMinutes > 0
              ? Math.min(100, Math.round((app.usedMinutesToday / app.usageLimitMinutes) * 100))
              : 0;

          return (
            <div
              key={app.id}
              className={`p-4 rounded-2xl bg-slate-900/90 border transition-all ${
                app.isLocked
                  ? "border-cyan-500/30 shadow-sm shadow-cyan-500/5"
                  : "border-slate-800 hover:border-slate-700"
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                {/* App icon & name */}
                <div className="flex items-center gap-3">
                  <div
                    className={`w-12 h-12 rounded-2xl ${app.color} flex items-center justify-center text-white font-bold text-lg shadow-md shrink-0`}
                  >
                    {app.name.charAt(0)}
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="text-sm font-bold text-slate-100">{app.name}</h3>
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 border border-slate-700">
                        {app.category}
                      </span>
                    </div>
                    <p className="text-xs text-slate-400">{app.nameUrdu}</p>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  {/* Delete App button if user doesn't have it (e.g. Instagram) */}
                  <button
                    type="button"
                    onClick={() => onDeleteApp(app.id)}
                    className="p-1.5 rounded-lg text-slate-500 hover:text-red-400 hover:bg-slate-800 transition-colors"
                    title={`Remove ${app.name} from list`}
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>

                  {/* Lock/Unlock Toggle Switch */}
                  <button
                    type="button"
                    onClick={() => onToggleLock(app.id)}
                    className={`relative w-14 h-8 rounded-full p-1 transition-colors flex items-center shrink-0 ${
                      app.isLocked ? "bg-cyan-500" : "bg-slate-800"
                    }`}
                    title={app.isLocked ? "Unlock app" : "Lock app"}
                  >
                    <div
                      className={`w-6 h-6 rounded-full bg-slate-950 flex items-center justify-center text-xs transition-transform duration-200 ${
                        app.isLocked ? "translate-x-6 text-cyan-400" : "translate-x-0 text-slate-400"
                      }`}
                    >
                      {app.isLocked ? <Lock className="w-3.5 h-3.5" /> : <Unlock className="w-3.5 h-3.5" />}
                    </div>
                  </button>
                </div>
              </div>

              {/* Usage Limit Tracker Section */}
              <div className="mt-3 pt-3 border-t border-slate-800/80">
                <div className="flex items-center justify-between text-xs mb-1.5">
                  <div className="flex items-center gap-1.5 text-slate-400">
                    <Clock className="w-3.5 h-3.5 text-amber-400" />
                    <span>Usage Limit:</span>
                    <span className="font-semibold text-slate-200">
                      {app.usageLimitMinutes > 0 ? `${app.usageLimitMinutes} mins` : "Unlimited"}
                    </span>
                  </div>

                  <div className="flex items-center gap-2">
                    <span className="text-[11px] text-slate-400">
                      Used: <strong className={isLimitReached ? "text-red-400" : "text-slate-200"}>{app.usedMinutesToday}m</strong>
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        setEditingLimitAppId(editingLimitAppId === app.id ? null : app.id)
                      }
                      className="text-[11px] text-cyan-400 hover:text-cyan-300 underline font-medium"
                    >
                      {editingLimitAppId === app.id ? "Done" : "Set Limit"}
                    </button>
                  </div>
                </div>

                {/* Progress bar */}
                {app.usageLimitMinutes > 0 && (
                  <div className="w-full h-1.5 rounded-full bg-slate-800 overflow-hidden mb-2">
                    <div
                      className={`h-full rounded-full transition-all ${
                        percentageUsed >= 100
                          ? "bg-red-500"
                          : percentageUsed >= 75
                          ? "bg-amber-400"
                          : "bg-cyan-500"
                      }`}
                      style={{ width: `${percentageUsed}%` }}
                    />
                  </div>
                )}

                {/* Inline limit picker editor if opened */}
                {editingLimitAppId === app.id && (
                  <div className="p-2.5 rounded-xl bg-slate-950/80 border border-slate-800 my-2 flex flex-col gap-2">
                    <span className="text-[11px] text-slate-400">Choose daily screen time limit:</span>
                    <div className="flex items-center gap-1.5 flex-wrap">
                      {[0, 15, 30, 45, 60, 90, 120].map((mins) => (
                        <button
                          key={mins}
                          type="button"
                          onClick={() => onUpdateUsageLimit(app.id, mins)}
                          className={`text-xs px-2.5 py-1 rounded-lg border transition-all ${
                            app.usageLimitMinutes === mins
                              ? "bg-cyan-500 text-slate-950 font-bold border-cyan-400"
                              : "bg-slate-900 text-slate-300 border-slate-800 hover:bg-slate-850"
                          }`}
                        >
                          {mins === 0 ? "Off" : `${mins}m`}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* Action buttons: Test App Launch simulator */}
                <div className="flex items-center justify-between mt-2 pt-2">
                  <span className="text-[11px] text-slate-400 flex items-center gap-1">
                    {app.isLocked ? (
                      <span className="text-cyan-400 flex items-center gap-1">
                        <CheckCircle className="w-3 h-3" /> Protected
                      </span>
                    ) : (
                      <span className="text-slate-400 flex items-center gap-1">
                        <AlertCircle className="w-3 h-3" /> Unlocked
                      </span>
                    )}
                  </span>

                  <button
                    type="button"
                    onClick={() => onSimulateAppLaunch(app)}
                    className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-750 text-cyan-300 border border-slate-700 transition-colors shadow-sm"
                  >
                    <Play className="w-3 h-3 text-cyan-400 fill-cyan-400" />
                    {app.isLocked ? "Test Lock on App" : "Open App"}
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
