import React, { useState } from "react";
import { Delete, Eye, EyeOff, ShieldCheck } from "lucide-react";

interface PinLockProps {
  onSuccess: () => void;
  onFailure: () => void;
  targetPin?: string; // Default "1234"
  isSettingMode?: boolean;
  onPinRecorded?: (pin: string) => void;
  title?: string;
  subtitle?: string;
}

export const PinLock: React.FC<PinLockProps> = ({
  onSuccess,
  onFailure,
  targetPin = "1234",
  isSettingMode = false,
  onPinRecorded,
  title = "Enter Security PIN",
  subtitle = "Enter your 4-digit master passcode",
}) => {
  const [pin, setPin] = useState<string>("");
  const [showPin, setShowPin] = useState<boolean>(false);
  const [status, setStatus] = useState<"idle" | "error" | "success">("idle");
  const [errorText, setErrorText] = useState<string>("");

  const handleDigit = (digit: string) => {
    if (status === "error") {
      setStatus("idle");
      setErrorText("");
    }

    if (pin.length >= 4) return;

    const newPin = pin + digit;
    setPin(newPin);

    // Auto submit on 4th digit
    if (newPin.length === 4) {
      if (isSettingMode) {
        setStatus("success");
        onPinRecorded?.(newPin);
        return;
      }

      if (newPin === targetPin) {
        setStatus("success");
        setTimeout(() => {
          onSuccess();
        }, 300);
      } else {
        setStatus("error");
        setErrorText("Incorrect PIN entered");
        onFailure();
        setTimeout(() => {
          setPin("");
          setStatus("idle");
        }, 1000);
      }
    }
  };

  const handleBackspace = () => {
    if (status === "error") {
      setStatus("idle");
      setErrorText("");
    }
    setPin((prev) => prev.slice(0, -1));
  };

  const handleClear = () => {
    setPin("");
    setStatus("idle");
    setErrorText("");
  };

  return (
    <div className="flex flex-col items-center justify-center w-full max-w-sm mx-auto p-4 select-none">
      <div className="text-center mb-6">
        <h3 className="text-lg font-semibold text-slate-100 flex items-center justify-center gap-2">
          {title}
        </h3>
        <p className="text-xs text-slate-400 mt-1">
          {errorText || subtitle}
        </p>
      </div>

      {/* PIN Dots Indicator */}
      <div className="flex items-center justify-center gap-4 mb-6">
        {[0, 1, 2, 3].map((index) => {
          const isFilled = pin.length > index;
          return (
            <div
              key={index}
              className={`w-4 h-4 rounded-full transition-all duration-200 flex items-center justify-center ${
                status === "error"
                  ? "bg-red-500 scale-110 shadow-lg shadow-red-500/50"
                  : status === "success"
                  ? "bg-emerald-400 scale-110 shadow-lg shadow-emerald-400/50"
                  : isFilled
                  ? "bg-cyan-400 scale-105 shadow-md shadow-cyan-400/40"
                  : "bg-slate-700/60 border border-slate-600"
              }`}
            >
              {showPin && isFilled && (
                <span className="text-[10px] font-bold text-slate-900">
                  {pin[index]}
                </span>
              )}
            </div>
          );
        })}
      </div>

      {/* Numeric Keypad */}
      <div className="grid grid-cols-3 gap-3 w-full max-w-[260px]">
        {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((num) => (
          <button
            key={num}
            type="button"
            onClick={() => handleDigit(num)}
            className="w-16 h-16 rounded-2xl mx-auto bg-slate-800/80 hover:bg-slate-700/90 active:scale-95 text-slate-100 text-xl font-semibold border border-slate-750 flex flex-col items-center justify-center transition-all shadow-md active:bg-cyan-500/20 active:border-cyan-500"
          >
            {num}
          </button>
        ))}

        {/* Bottom row: Show/Hide, 0, Backspace */}
        <button
          type="button"
          onClick={() => setShowPin((v) => !v)}
          className="w-16 h-16 rounded-2xl mx-auto bg-slate-900/60 hover:bg-slate-800 active:scale-95 text-slate-400 text-xs flex flex-col items-center justify-center transition-all border border-slate-800"
          title="Toggle PIN Visibility"
        >
          {showPin ? (
            <EyeOff className="w-5 h-5 text-cyan-400" />
          ) : (
            <Eye className="w-5 h-5" />
          )}
          <span className="text-[9px] mt-1 font-medium">
            {showPin ? "Hide" : "Peek"}
          </span>
        </button>

        <button
          type="button"
          onClick={() => handleDigit("0")}
          className="w-16 h-16 rounded-2xl mx-auto bg-slate-800/80 hover:bg-slate-700/90 active:scale-95 text-slate-100 text-xl font-semibold border border-slate-750 flex flex-col items-center justify-center transition-all shadow-md active:bg-cyan-500/20 active:border-cyan-500"
        >
          0
        </button>

        <button
          type="button"
          onClick={handleBackspace}
          className="w-16 h-16 rounded-2xl mx-auto bg-slate-900/60 hover:bg-slate-800 active:scale-95 text-slate-300 flex flex-col items-center justify-center transition-all border border-slate-800"
          title="Backspace"
        >
          <Delete className="w-5 h-5" />
          <span className="text-[9px] mt-1 font-medium">Delete</span>
        </button>
      </div>

      <div className="flex items-center justify-between w-full max-w-[260px] mt-4 text-xs text-slate-400">
        <button
          type="button"
          onClick={handleClear}
          className="hover:text-slate-200 transition-colors"
        >
          Clear
        </button>
        <span className="text-slate-400">
          Default: <span className="text-cyan-400 font-mono">1234</span>
        </span>
      </div>
    </div>
  );
};
