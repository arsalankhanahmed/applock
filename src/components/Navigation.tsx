import React from "react";
import { PWAInstallButton } from "./PWAInstallButton";
import {
  Shield,
  Lock,
  Camera,
  Image as ImageIcon,
  Sparkles,
  Settings,
  ShieldCheck,
  Smartphone,
  Eye,
} from "lucide-react";

export type NavTab = "apps" | "intruder" | "vault" | "ai" | "settings";

interface NavigationProps {
  activeTab: NavTab;
  onSelectTab: (tab: NavTab) => void;
  intruderCount: number;
  vaultCount: number;
}

export const Navigation: React.FC<NavigationProps> = ({
  activeTab,
  onSelectTab,
  intruderCount,
  vaultCount,
}) => {
  const tabs = [
    {
      id: "apps" as NavTab,
      label: "AppLock & Limits",
      labelUrdu: "ایپ لاک",
      icon: Lock,
    },
    {
      id: "intruder" as NavTab,
      label: "Intruder Selfie",
      labelUrdu: "انٹروڈر سیلفی",
      icon: Camera,
      badge: intruderCount > 0 ? intruderCount : undefined,
      badgeColor: "bg-red-500 text-white",
    },
    {
      id: "vault" as NavTab,
      label: "Private Vault",
      labelUrdu: "پرائیویٹ گیلری",
      icon: ImageIcon,
      badge: vaultCount > 0 ? vaultCount : undefined,
      badgeColor: "bg-cyan-500 text-slate-950",
    },
    {
      id: "ai" as NavTab,
      label: "Gemini AI Advisor",
      labelUrdu: "سیکیورٹی ایڈوائزر",
      icon: Sparkles,
    },
    {
      id: "settings" as NavTab,
      label: "Security Settings",
      labelUrdu: "ترتیبات",
      icon: Settings,
    },
  ];

  return (
    <header className="sticky top-0 z-30 bg-slate-950/90 backdrop-blur-xl border-b border-slate-800/80">
      <div className="max-w-7xl mx-auto px-4 sm:px-6">
        {/* Top Branding Row */}
        <div className="flex items-center justify-between py-3.5 border-b border-slate-900">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-gradient-to-tr from-cyan-600 to-emerald-500 flex items-center justify-center text-slate-950 shadow-lg shadow-cyan-500/20">
              <Shield className="w-6 h-6 text-slate-950 stroke-[2.5]" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-base sm:text-lg font-extrabold tracking-tight text-white">
                  AppLock & Private Vault
                </h1>
                <span className="hidden sm:inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
                  <ShieldCheck className="w-3 h-3" /> 100% Ad-Free
                </span>
              </div>
              <p className="text-xs text-slate-400">
                Pattern • Passcode • Fingerprint • Intruder Selfie • Photo Vault
              </p>
            </div>
          </div>

          {/* Ad-Free & Security Status Badge & Mobile Install */}
          <div className="flex items-center gap-2">
            <PWAInstallButton />
            <div className="px-3 py-1.5 rounded-xl bg-slate-900 border border-slate-800 flex items-center gap-2 text-xs">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
              <span className="text-slate-300 font-medium hidden sm:inline">
                Real-Time Guard Active
              </span>
              <span className="text-emerald-400 font-bold text-[11px] sm:hidden">
                Ad-Free
              </span>
            </div>
          </div>
        </div>

        {/* Tab Navigation Menu */}
        <nav className="flex items-center gap-1 overflow-x-auto py-2.5 no-scrollbar">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;

            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => onSelectTab(tab.id)}
                className={`flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs font-semibold whitespace-nowrap transition-all duration-200 ${
                  isActive
                    ? "bg-cyan-500 text-slate-950 shadow-md shadow-cyan-500/20 font-bold"
                    : "text-slate-400 hover:text-slate-200 hover:bg-slate-900"
                }`}
              >
                <Icon className={`w-4 h-4 ${isActive ? "text-slate-950" : "text-slate-400"}`} />
                <span>{tab.label}</span>
                {tab.badge !== undefined && (
                  <span
                    className={`text-[10px] px-1.5 py-0.2 rounded-full font-bold leading-none ${
                      isActive ? "bg-slate-950 text-cyan-300" : tab.badgeColor
                    }`}
                  >
                    {tab.badge}
                  </span>
                )}
              </button>
            );
          })}
        </nav>
      </div>
    </header>
  );
};
