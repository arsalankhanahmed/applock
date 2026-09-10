import React, { useState, useRef, useEffect } from "react";
import { ChatMessage } from "../types";
import {
  Sparkles,
  Send,
  Bot,
  User,
  Shield,
  Loader2,
  Trash2,
  Lock,
  Cpu,
  HelpCircle,
  KeyRound,
  Eye,
} from "lucide-react";

interface AiSecurityAssistantProps {
  chatMessages: ChatMessage[];
  onAddMessage: (msg: ChatMessage) => void;
  onClearChat: () => void;
}

export const AiSecurityAssistant: React.FC<AiSecurityAssistantProps> = ({
  chatMessages,
  onAddMessage,
  onClearChat,
}) => {
  const [inputPrompt, setInputPrompt] = useState<string>("");
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [selectedModel, setSelectedModel] = useState<
    "gemini-3.1-pro-preview" | "gemini-3.5-flash" | "gemini-3.1-flash-lite"
  >("gemini-3.5-flash");

  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [chatMessages]);

  const quickQuestions = [
    "How to set an unbreakable pattern lock?",
    "How does the intruder selfie front camera trigger work?",
    "What are the best app usage limits for screen addiction?",
    "How does the private photo vault keep my data safe?",
  ];

  const handleSendMessage = async (textToSend?: string) => {
    const messageText = (textToSend || inputPrompt).trim();
    if (!messageText || isLoading) return;

    const userMessage: ChatMessage = {
      id: `user-${Date.now()}`,
      role: "user",
      content: messageText,
      timestamp: Date.now(),
    };

    onAddMessage(userMessage);
    setInputPrompt("");
    setIsLoading(true);

    try {
      const historyPayload = [...chatMessages, userMessage].map((m) => ({
        role: m.role,
        content: m.content,
      }));

      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: historyPayload,
          model: selectedModel,
          systemInstruction:
            "You are the Gemini AI Security & Privacy Advisor for 'AppLock & Private Vault'. You provide concise, expert guidance in friendly, understandable language (supporting both English and Urdu/Roman Urdu queries). Advise users on pattern lock complexity, passcode best practices, biometric safety, app screen time management, intruder anti-theft measures, and photo encryption.",
        }),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Failed to get AI response");
      }

      const assistantMessage: ChatMessage = {
        id: `assistant-${Date.now()}`,
        role: "assistant",
        content: data.text || "No response received.",
        timestamp: Date.now(),
        modelUsed: data.modelUsed || selectedModel,
      };

      onAddMessage(assistantMessage);
    } catch (err: unknown) {
      console.error(err);
      const msg = err instanceof Error ? err.message : "Error communicating with AI";
      onAddMessage({
        id: `error-${Date.now()}`,
        role: "assistant",
        content: `⚠️ ${msg}`,
        timestamp: Date.now(),
      });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex flex-col h-[640px] rounded-3xl bg-slate-900/90 border border-slate-800 overflow-hidden shadow-2xl">
      {/* Chat Header */}
      <div className="p-4 border-b border-slate-800 flex items-center justify-between bg-slate-900/95">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-2xl bg-cyan-500/10 border border-cyan-500/20 flex items-center justify-center text-cyan-400">
            <Sparkles className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-bold text-slate-100">
                Gemini Security AI Advisor
              </h3>
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-cyan-500/15 text-cyan-300 font-medium border border-cyan-500/30">
                Multi-Turn Chat
              </span>
            </div>
            <p className="text-xs text-slate-400">
              Ask privacy questions, password advice & intruder defense tips
            </p>
          </div>
        </div>

        {/* Model Selector Pill */}
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5 p-1 rounded-xl bg-slate-950 border border-slate-800 text-xs">
            <Cpu className="w-3.5 h-3.5 text-cyan-400 ml-1" />
            <select
              value={selectedModel}
              onChange={(e) =>
                setSelectedModel(
                  e.target.value as "gemini-3.1-pro-preview" | "gemini-3.5-flash" | "gemini-3.1-flash-lite"
                )
              }
              className="bg-transparent text-xs text-slate-300 font-medium focus:outline-none pr-1 cursor-pointer"
            >
              <option value="gemini-3.5-flash" className="bg-slate-900 text-white">
                gemini-3.5-flash (General)
              </option>
              <option value="gemini-3.1-flash-lite" className="bg-slate-900 text-white">
                gemini-3.1-flash-lite (Fast)
              </option>
              <option value="gemini-3.1-pro-preview" className="bg-slate-900 text-white">
                gemini-3.1-pro-preview (Complex)
              </option>
            </select>
          </div>

          {chatMessages.length > 0 && (
            <button
              type="button"
              onClick={onClearChat}
              className="p-2 rounded-xl text-slate-400 hover:text-red-400 hover:bg-slate-800 transition-colors"
              title="Clear Conversation"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      {/* Messages Scrollable Thread */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {chatMessages.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center p-6 text-slate-400">
            <div className="w-14 h-14 rounded-2xl bg-slate-800/80 flex items-center justify-center text-cyan-400 mb-3 border border-slate-700">
              <Bot className="w-7 h-7" />
            </div>
            <h4 className="text-base font-semibold text-slate-200">
              How can I assist your security today?
            </h4>
            <p className="text-xs text-slate-400 max-w-sm mt-1 mb-6">
              Ask about locking your apps, securing private gallery photos, configuring intruder selfie thresholds, or biometric safety.
            </p>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 w-full max-w-md text-left">
              {quickQuestions.map((q, idx) => (
                <button
                  key={idx}
                  type="button"
                  onClick={() => handleSendMessage(q)}
                  className="p-3 rounded-2xl bg-slate-950/80 border border-slate-800 hover:border-cyan-500/40 text-xs text-slate-300 hover:text-cyan-300 transition-all text-left"
                >
                  "{q}"
                </button>
              ))}
            </div>
          </div>
        ) : (
          chatMessages.map((msg) => (
            <div
              key={msg.id}
              className={`flex gap-3 ${
                msg.role === "user" ? "justify-end" : "justify-start"
              }`}
            >
              {msg.role === "assistant" && (
                <div className="w-8 h-8 rounded-xl bg-cyan-500/10 border border-cyan-500/30 flex items-center justify-center text-cyan-400 shrink-0 mt-0.5">
                  <Bot className="w-4 h-4" />
                </div>
              )}

              <div
                className={`max-w-[82%] rounded-2xl px-4 py-3 text-xs leading-relaxed ${
                  msg.role === "user"
                    ? "bg-cyan-500 text-slate-950 font-medium rounded-br-sm shadow-md"
                    : "bg-slate-950/90 text-slate-200 border border-slate-800 rounded-bl-sm shadow"
                }`}
              >
                <div className="whitespace-pre-wrap">{msg.content}</div>
                {msg.modelUsed && (
                  <div className="mt-1.5 pt-1.5 border-t border-slate-800 text-[10px] text-cyan-400/80 font-mono">
                    Model: {msg.modelUsed}
                  </div>
                )}
              </div>

              {msg.role === "user" && (
                <div className="w-8 h-8 rounded-xl bg-slate-800 border border-slate-700 flex items-center justify-center text-slate-300 shrink-0 mt-0.5">
                  <User className="w-4 h-4" />
                </div>
              )}
            </div>
          ))
        )}

        {isLoading && (
          <div className="flex gap-3 justify-start items-center">
            <div className="w-8 h-8 rounded-xl bg-cyan-500/10 border border-cyan-500/30 flex items-center justify-center text-cyan-400 shrink-0">
              <Bot className="w-4 h-4" />
            </div>
            <div className="p-3 rounded-2xl bg-slate-950/90 border border-slate-800 text-xs text-cyan-400 flex items-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin" />
              <span>Gemini is thinking with {selectedModel}...</span>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input Bar */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          handleSendMessage();
        }}
        className="p-3 bg-slate-900/95 border-t border-slate-800 flex items-center gap-2"
      >
        <input
          type="text"
          placeholder="Ask security assistant (e.g. How to protect my gallery?)..."
          value={inputPrompt}
          onChange={(e) => setInputPrompt(e.target.value)}
          disabled={isLoading}
          className="flex-1 px-4 py-2.5 rounded-xl bg-slate-950 border border-slate-800 text-xs text-slate-100 placeholder-slate-400 focus:outline-none focus:border-cyan-500 transition-colors"
        />

        <button
          type="submit"
          disabled={!inputPrompt.trim() || isLoading}
          className="p-2.5 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-bold disabled:opacity-40 transition-colors shadow-md shadow-cyan-500/20"
        >
          <Send className="w-4 h-4" />
        </button>
      </form>
    </div>
  );
};
