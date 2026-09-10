import React, { useState } from "react";
import { IntruderLog, SecurityConfig } from "../types";
import { captureFrontCameraPhoto } from "../utils/camera";
import {
  Camera,
  ShieldAlert,
  Trash2,
  Eye,
  Sliders,
  AlertTriangle,
  Sparkles,
  Download,
  X,
  Clock,
  Smartphone,
  CheckCircle2,
} from "lucide-react";

interface IntruderLogsProps {
  logs: IntruderLog[];
  config: SecurityConfig;
  onUpdateConfig: (newConfig: SecurityConfig) => void;
  onDeleteLog: (id: string) => void;
  onClearAllLogs: () => void;
  onAddLog: (log: IntruderLog) => void;
}

export const IntruderLogs: React.FC<IntruderLogsProps> = ({
  logs,
  config,
  onUpdateConfig,
  onDeleteLog,
  onClearAllLogs,
  onAddLog,
}) => {
  const [selectedLog, setSelectedLog] = useState<IntruderLog | null>(null);
  const [isTestingCamera, setIsTestingCamera] = useState<boolean>(false);
  const [cameraTestMessage, setCameraTestMessage] = useState<string | null>(null);

  const handleManualTestSnapshot = async () => {
    setIsTestingCamera(true);
    setCameraTestMessage("Accessing front camera...");
    try {
      const { photoUrl, isRealCapture } = await captureFrontCameraPhoto();
      const testLog: IntruderLog = {
        id: `test-${Date.now()}`,
        timestamp: Date.now(),
        photoUrl,
        targetAppName: "Manual Security Test",
        method: "pin",
        attemptCount: 1,
        status: isRealCapture ? "Captured" : "Simulated",
        notes: isRealCapture
          ? "Real front-camera snapshot test"
          : "Simulated test capture (camera unavailable or simulated environment)",
      };
      onAddLog(testLog);
      setCameraTestMessage(
        isRealCapture
          ? "Success! Real front-camera photo captured and logged."
          : "Test snapshot logged successfully."
      );
      setTimeout(() => setCameraTestMessage(null), 4000);
    } catch (err) {
      console.error(err);
      setCameraTestMessage("Failed to test camera capture.");
    } finally {
      setIsTestingCamera(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      {/* Intruder Settings Card */}
      <div className="p-5 rounded-2xl bg-slate-900/90 border border-slate-800 flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
        <div className="flex items-start gap-3.5">
          <div className="w-12 h-12 rounded-2xl bg-red-500/10 border border-red-500/20 flex items-center justify-center text-red-400 shrink-0">
            <Camera className="w-6 h-6" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-base font-bold text-slate-100">
                Intruder Selfie Protection
              </h3>
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-red-500/15 text-red-300 font-semibold border border-red-500/30">
                Auto-Capture
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-0.5">
              Secretly snaps a photo from the front camera when wrong pattern, PIN, or fingerprint is attempted.
            </p>
          </div>
        </div>

        {/* Threshold Selector & Test button */}
        <div className="flex items-center gap-3 w-full md:w-auto justify-between md:justify-end">
          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-400">Capture After:</span>
            <select
              value={config.intruderThreshold}
              onChange={(e) =>
                onUpdateConfig({
                  ...config,
                  intruderThreshold: Number(e.target.value),
                })
              }
              className="px-2.5 py-1.5 rounded-xl bg-slate-800 border border-slate-700 text-xs font-semibold text-slate-200 focus:outline-none focus:border-red-500 cursor-pointer"
            >
              <option value={1}>1 Wrong Attempt</option>
              <option value={2}>2 Wrong Attempts (Recommended)</option>
              <option value={3}>3 Wrong Attempts</option>
            </select>
          </div>

          <button
            type="button"
            onClick={handleManualTestSnapshot}
            disabled={isTestingCamera}
            className="px-3.5 py-1.5 rounded-xl bg-red-600 hover:bg-red-500 text-white text-xs font-semibold flex items-center gap-1.5 transition-colors disabled:opacity-50 shadow-md shadow-red-600/20"
          >
            <Camera className="w-3.5 h-3.5" />
            {isTestingCamera ? "Capturing..." : "Test Snapshot"}
          </button>
        </div>
      </div>

      {cameraTestMessage && (
        <div className="p-3 rounded-xl bg-slate-800/90 border border-slate-700 text-xs text-slate-200 flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 text-emerald-400" />
          {cameraTestMessage}
        </div>
      )}

      {/* Header and Clear Action */}
      <div className="flex items-center justify-between">
        <div>
          <h4 className="text-sm font-bold text-slate-200 flex items-center gap-2">
            <ShieldAlert className="w-4 h-4 text-red-400" />
            Intruder Capture History ({logs.length})
          </h4>
          <p className="text-xs text-slate-400 mt-0.5">
            Logs of unauthorized attempts with timestamps and front camera photos
          </p>
        </div>

        {logs.length > 0 && (
          <button
            type="button"
            onClick={onClearAllLogs}
            className="text-xs text-red-400 hover:text-red-300 flex items-center gap-1.5 px-3 py-1.5 rounded-lg hover:bg-red-950/40 transition-colors"
          >
            <Trash2 className="w-3.5 h-3.5" />
            Clear All Logs
          </button>
        )}
      </div>

      {/* Empty State */}
      {logs.length === 0 ? (
        <div className="p-12 rounded-2xl bg-slate-900/60 border border-slate-800 flex flex-col items-center justify-center text-center">
          <div className="w-16 h-16 rounded-full bg-slate-800/80 flex items-center justify-center text-slate-400 mb-3">
            <Camera className="w-8 h-8 text-slate-500" />
          </div>
          <h4 className="text-base font-semibold text-slate-200">
            No Intruder Breaches Recorded
          </h4>
          <p className="text-xs text-slate-400 max-w-sm mt-1">
            Your device is secure. When someone attempts an incorrect pattern, PIN, or fingerprint, their selfie will appear here instantly.
          </p>
          <button
            type="button"
            onClick={handleManualTestSnapshot}
            className="mt-4 px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs text-cyan-300 border border-slate-700 font-medium transition-colors"
          >
            Run Camera Test Snapshot
          </button>
        </div>
      ) : (
        /* Intruder Grid */
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
          {logs.map((log) => (
            <div
              key={log.id}
              className="rounded-2xl bg-slate-900/90 border border-slate-800 overflow-hidden hover:border-red-500/40 transition-all shadow-md group flex flex-col justify-between"
            >
              {/* Photo Preview with Badges */}
              <div
                className="relative aspect-4/3 bg-slate-950 cursor-pointer overflow-hidden"
                onClick={() => setSelectedLog(log)}
              >
                <img
                  src={log.photoUrl}
                  alt={`Intruder for ${log.targetAppName}`}
                  className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                />

                <div className="absolute top-2 left-2 flex items-center gap-1.5">
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-red-600/90 text-white font-bold backdrop-blur-sm shadow">
                    ⚠️ Intruder
                  </span>
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-900/80 text-slate-300 font-medium backdrop-blur-sm border border-slate-700">
                    {log.method.toUpperCase()}
                  </span>
                </div>

                <div className="absolute inset-0 bg-slate-950/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                  <span className="px-3 py-1.5 rounded-xl bg-slate-900/90 text-white text-xs font-semibold flex items-center gap-1.5 border border-slate-700 shadow-xl">
                    <Eye className="w-3.5 h-3.5 text-cyan-400" />
                    Inspect Photo
                  </span>
                </div>
              </div>

              {/* Log Details */}
              <div className="p-3.5 flex flex-col gap-2">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <h5 className="text-sm font-bold text-slate-100 flex items-center gap-1.5">
                      <Smartphone className="w-3.5 h-3.5 text-red-400" />
                      {log.targetAppName}
                    </h5>
                    <span className="text-[11px] text-slate-400 flex items-center gap-1 mt-0.5">
                      <Clock className="w-3 h-3" />
                      {new Date(log.timestamp).toLocaleString()}
                    </span>
                  </div>

                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDeleteLog(log.id);
                    }}
                    className="p-1.5 rounded-lg text-slate-400 hover:text-red-400 hover:bg-slate-800 transition-colors"
                    title="Delete log"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>

                <div className="flex items-center justify-between text-[11px] text-slate-400 pt-2 border-t border-slate-800">
                  <span>Failed attempts: <strong className="text-red-400">{log.attemptCount}</strong></span>
                  <span className="text-slate-400">{log.status}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Full Photo Inspection Modal */}
      {selectedLog && (
        <div className="fixed inset-0 z-50 bg-slate-950/90 backdrop-blur-md flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-3xl max-w-lg w-full overflow-hidden shadow-2xl animate-scale-up">
            <div className="p-4 border-b border-slate-800 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <AlertTriangle className="w-5 h-5 text-red-400" />
                <h4 className="text-sm font-bold text-slate-100">
                  Intruder Capture Detail
                </h4>
              </div>
              <button
                type="button"
                onClick={() => setSelectedLog(null)}
                className="p-1.5 rounded-xl hover:bg-slate-800 text-slate-400 hover:text-slate-200 transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-4 flex flex-col gap-4">
              <div className="rounded-2xl overflow-hidden bg-slate-950 border border-slate-800">
                <img
                  src={selectedLog.photoUrl}
                  alt="Full Intruder Snapshot"
                  className="w-full max-h-[340px] object-contain mx-auto"
                />
              </div>

              <div className="grid grid-cols-2 gap-3 text-xs">
                <div className="p-3 rounded-xl bg-slate-950/70 border border-slate-800/80">
                  <span className="text-slate-400">Target Application:</span>
                  <div className="font-semibold text-slate-200 text-sm mt-0.5">
                    {selectedLog.targetAppName}
                  </div>
                </div>

                <div className="p-3 rounded-xl bg-slate-950/70 border border-slate-800/80">
                  <span className="text-slate-400">Breach Method:</span>
                  <div className="font-semibold text-red-400 text-sm mt-0.5 uppercase">
                    {selectedLog.method} Failure ({selectedLog.attemptCount}x)
                  </div>
                </div>

                <div className="p-3 rounded-xl bg-slate-950/70 border border-slate-800/80 col-span-2">
                  <span className="text-slate-400">Timestamp:</span>
                  <div className="font-mono text-slate-200 text-xs mt-0.5">
                    {new Date(selectedLog.timestamp).toString()}
                  </div>
                </div>
              </div>

              <div className="flex items-center justify-between pt-2">
                <button
                  type="button"
                  onClick={() => {
                    onDeleteLog(selectedLog.id);
                    setSelectedLog(null);
                  }}
                  className="px-4 py-2 rounded-xl text-xs text-red-400 hover:bg-red-950/50 transition-colors flex items-center gap-1.5"
                >
                  <Trash2 className="w-4 h-4" />
                  Delete Entry
                </button>

                <a
                  href={selectedLog.photoUrl}
                  download={`intruder-${selectedLog.id}.jpg`}
                  className="px-4 py-2 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-slate-950 text-xs font-bold transition-colors flex items-center gap-1.5"
                >
                  <Download className="w-4 h-4" />
                  Save / Download Photo
                </a>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
