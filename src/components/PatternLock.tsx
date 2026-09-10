import React, { useState, useRef, useEffect, useCallback } from "react";
import { RefreshCw, CheckCircle2, AlertCircle } from "lucide-react";

interface PatternLockProps {
  onSuccess: () => void;
  onFailure: () => void;
  targetPattern?: number[]; // Expected pattern e.g. [0, 1, 2, 4, 6, 7, 8]
  isSettingMode?: boolean; // When user is configuring a new pattern
  onPatternRecorded?: (pattern: number[]) => void;
  title?: string;
  subtitle?: string;
}

export const PatternLock: React.FC<PatternLockProps> = ({
  onSuccess,
  onFailure,
  targetPattern = [0, 1, 2, 4, 6, 7, 8],
  isSettingMode = false,
  onPatternRecorded,
  title = "Draw Pattern to Unlock",
  subtitle = "Connect the dots in sequence",
}) => {
  const [selectedNodes, setSelectedNodes] = useState<number[]>([]);
  const [isInteracting, setIsInteracting] = useState(false);
  const [currentCoord, setCurrentCoord] = useState<{ x: number; y: number } | null>(null);
  const [status, setStatus] = useState<"idle" | "error" | "success">("idle");
  const [errorMessage, setErrorMessage] = useState<string>("");

  const containerRef = useRef<HTMLDivElement>(null);
  const dotsRef = useRef<{ [key: number]: { x: number; y: number } }>({});

  // 3x3 Grid node coordinates calculation
  const updateDotsCoordinates = useCallback(() => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const size = rect.width;
    const padding = size * 0.15;
    const step = (size - padding * 2) / 2;

    const newDots: { [key: number]: { x: number; y: number } } = {};
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        const index = r * 3 + c;
        newDots[index] = {
          x: padding + c * step,
          y: padding + r * step,
        };
      }
    }
    dotsRef.current = newDots;
  }, []);

  useEffect(() => {
    updateDotsCoordinates();
    window.addEventListener("resize", updateDotsCoordinates);
    return () => window.removeEventListener("resize", updateDotsCoordinates);
  }, [updateDotsCoordinates]);

  const getNodeAtPoint = (clientX: number, clientY: number): number | null => {
    if (!containerRef.current) return null;
    const rect = containerRef.current.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;

    const hitRadius = 38; // forgiving touch target
    for (const [keyStr, dot] of Object.entries(dotsRef.current)) {
      const idx = Number(keyStr);
      const dotCoord = dot as { x: number; y: number };
      const dist = Math.hypot(dotCoord.x - x, dotCoord.y - y);
      if (dist <= hitRadius) {
        return idx;
      }
    }
    return null;
  };

  const handleStart = (clientX: number, clientY: number) => {
    if (status !== "idle") {
      setStatus("idle");
      setErrorMessage("");
    }
    updateDotsCoordinates();
    setIsInteracting(true);
    const initialNode = getNodeAtPoint(clientX, clientY);
    if (initialNode !== null) {
      setSelectedNodes([initialNode]);
      if (typeof navigator !== "undefined" && navigator.vibrate) {
        try { navigator.vibrate(20); } catch { /* ignore */ }
      }
    } else {
      setSelectedNodes([]);
    }

    if (containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      setCurrentCoord({ x: clientX - rect.left, y: clientY - rect.top });
    }
  };

  const handleMove = (clientX: number, clientY: number) => {
    if (!isInteracting || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    setCurrentCoord({ x: clientX - rect.left, y: clientY - rect.top });

    const hoveredNode = getNodeAtPoint(clientX, clientY);
    if (hoveredNode !== null && !selectedNodes.includes(hoveredNode)) {
      setSelectedNodes((prev) => [...prev, hoveredNode]);
      if (typeof navigator !== "undefined" && navigator.vibrate) {
        try { navigator.vibrate(25); } catch { /* ignore */ }
      }
    }
  };

  const handleEnd = () => {
    if (!isInteracting) return;
    setIsInteracting(false);
    setCurrentCoord(null);

    if (selectedNodes.length === 0) return;

    if (selectedNodes.length < 4) {
      setStatus("error");
      setErrorMessage("Connect at least 4 dots");
      setTimeout(() => {
        setSelectedNodes([]);
        setStatus("idle");
      }, 1000);
      return;
    }

    if (isSettingMode) {
      setStatus("success");
      onPatternRecorded?.(selectedNodes);
      return;
    }

    // Verify pattern
    const isCorrect =
      selectedNodes.length === targetPattern.length &&
      selectedNodes.every((val, idx) => val === targetPattern[idx]);

    if (isCorrect) {
      setStatus("success");
      setTimeout(() => {
        onSuccess();
      }, 300);
    } else {
      setStatus("error");
      setErrorMessage("Incorrect Pattern");
      onFailure();
      setTimeout(() => {
        setSelectedNodes([]);
        setStatus("idle");
      }, 1200);
    }
  };

  const resetPattern = () => {
    setSelectedNodes([]);
    setStatus("idle");
    setErrorMessage("");
  };

  return (
    <div className="flex flex-col items-center justify-center select-none w-full max-w-sm mx-auto p-4">
      <div className="text-center mb-4">
        <h3 className="text-lg font-semibold text-slate-100 flex items-center justify-center gap-2">
          {title}
        </h3>
        <p className="text-xs text-slate-400 mt-1">
          {errorMessage || subtitle}
        </p>
      </div>

      <div
        ref={containerRef}
        className={`relative w-72 h-72 rounded-3xl bg-slate-900/90 border transition-all duration-300 touch-none shadow-2xl ${
          status === "error"
            ? "border-red-500/80 shadow-red-500/20 animate-shake"
            : status === "success"
            ? "border-emerald-500/80 shadow-emerald-500/20"
            : "border-slate-800 shadow-cyan-950/30"
        }`}
        onMouseDown={(e) => handleStart(e.clientX, e.clientY)}
        onMouseMove={(e) => handleMove(e.clientX, e.clientY)}
        onMouseUp={handleEnd}
        onMouseLeave={handleEnd}
        onTouchStart={(e) => {
          if (e.touches[0]) {
            handleStart(e.touches[0].clientX, e.touches[0].clientY);
          }
        }}
        onTouchMove={(e) => {
          if (e.touches[0]) {
            handleMove(e.touches[0].clientX, e.touches[0].clientY);
          }
        }}
        onTouchEnd={handleEnd}
      >
        {/* SVG Drawing Layer for connecting lines */}
        <svg className="absolute inset-0 w-full h-full pointer-events-none">
          {/* Static connected segments */}
          {selectedNodes.map((nodeIdx, i) => {
            if (i === 0) return null;
            const prev = dotsRef.current[selectedNodes[i - 1]];
            const curr = dotsRef.current[nodeIdx];
            if (!prev || !curr) return null;

            const strokeColor =
              status === "error"
                ? "#ef4444"
                : status === "success"
                ? "#10b981"
                : "#06b6d4";

            return (
              <line
                key={`line-${i}`}
                x1={prev.x}
                y1={prev.y}
                x2={curr.x}
                y2={curr.y}
                stroke={strokeColor}
                strokeWidth="5"
                strokeLinecap="round"
                className="transition-colors"
              />
            );
          })}

          {/* Active pointer follower line */}
          {isInteracting && selectedNodes.length > 0 && currentCoord && (
            <line
              x1={dotsRef.current[selectedNodes[selectedNodes.length - 1]]?.x || 0}
              y1={dotsRef.current[selectedNodes[selectedNodes.length - 1]]?.y || 0}
              x2={currentCoord.x}
              y2={currentCoord.y}
              stroke={
                status === "error"
                  ? "#ef4444"
                  : status === "success"
                  ? "#10b981"
                  : "#06b6d4"
              }
              strokeWidth="4"
              strokeDasharray="4 4"
              strokeLinecap="round"
            />
          )}
        </svg>

        {/* 9 Interactive Dots */}
        {[...Array(9)].map((_, idx) => {
          const isSelected = selectedNodes.includes(idx);
          const pos = dotsRef.current[idx] || { x: 0, y: 0 };

          return (
            <div
              key={`dot-${idx}`}
              className="absolute -translate-x-1/2 -translate-y-1/2 cursor-pointer flex items-center justify-center p-3"
              style={{
                left: `${pos.x}px`,
                top: `${pos.y}px`,
              }}
            >
              {/* Outer halo */}
              <div
                className={`w-10 h-10 rounded-full flex items-center justify-center transition-transform duration-200 ${
                  isSelected
                    ? status === "error"
                      ? "bg-red-500/20 scale-125 border border-red-500"
                      : status === "success"
                      ? "bg-emerald-500/20 scale-125 border border-emerald-500"
                      : "bg-cyan-500/25 scale-125 border border-cyan-400"
                    : "bg-slate-800/40 hover:bg-slate-800"
                }`}
              >
                {/* Center Core dot */}
                <div
                  className={`rounded-full transition-all duration-200 ${
                    isSelected
                      ? status === "error"
                        ? "w-4 h-4 bg-red-500 shadow-md shadow-red-500/50"
                        : status === "success"
                        ? "w-4 h-4 bg-emerald-400 shadow-md shadow-emerald-400/50"
                        : "w-4 h-4 bg-cyan-400 shadow-md shadow-cyan-400/50"
                      : "w-3 h-3 bg-slate-500"
                  }`}
                />
              </div>
            </div>
          );
        })}
      </div>

      {/* Control Footer */}
      <div className="flex items-center justify-between w-full max-w-xs mt-4 px-2">
        <button
          type="button"
          onClick={resetPattern}
          className="text-xs text-slate-400 hover:text-slate-200 flex items-center gap-1.5 py-1 px-3 rounded-lg hover:bg-slate-800/60 transition-colors"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          Clear / Reset
        </button>

        <span className="text-xs text-slate-400">
          Default: <span className="text-cyan-400 font-mono">Z shape</span>
        </span>
      </div>
    </div>
  );
};
