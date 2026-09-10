export type LockType = "pattern" | "pin" | "fingerprint";

export interface SecurityConfig {
  primaryLockType: LockType;
  pin: string; // Default '1234'
  pattern: number[]; // e.g. [0, 1, 2, 4, 6, 7, 8]
  fingerprintEnabled: boolean;
  intruderThreshold: number; // 1, 2, or 3 wrong attempts
  autoLockDelaySeconds: number;
  cameraPermissionGranted: boolean;
}

export interface AppItem {
  id: string;
  name: string;
  nameUrdu: string;
  packageName: string;
  iconName: string;
  color: string;
  category: "Social" | "Entertainment" | "Utility" | "Finance";
  isLocked: boolean;
  usageLimitMinutes: number; // 0 = unlimited
  usedMinutesToday: number;
  isTemporarilyUnlocked: boolean;
  unlockedUntil?: number;
}

export interface IntruderLog {
  id: string;
  timestamp: number;
  photoUrl: string;
  targetAppName: string;
  method: LockType;
  attemptCount: number;
  status: "Captured" | "Simulated";
  notes?: string;
}

export interface VaultPhoto {
  id: string;
  title: string;
  dataUrl: string;
  timestamp: number;
  category: "Personal" | "Documents" | "Family" | "Other";
  sizeKb: number;
  aiAnalysis?: string;
  aiAnalysisModel?: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  modelUsed?: string;
}
