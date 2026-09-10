import React, { useState, useRef } from "react";
import { VaultPhoto } from "../types";
import { captureFrontCameraPhoto } from "../utils/camera";
import {
  Image as ImageIcon,
  Upload,
  Camera,
  Trash2,
  Sparkles,
  Download,
  Eye,
  Lock,
  Plus,
  X,
  FileText,
  ShieldCheck,
  Search,
  CheckCircle,
  Loader2,
  Tag,
  Share2,
} from "lucide-react";

interface GalleryVaultProps {
  photos: VaultPhoto[];
  onAddPhoto: (photo: VaultPhoto) => void;
  onDeletePhoto: (id: string) => void;
  onUpdatePhoto: (photo: VaultPhoto) => void;
}

export const GalleryVault: React.FC<GalleryVaultProps> = ({
  photos,
  onAddPhoto,
  onDeletePhoto,
  onUpdatePhoto,
}) => {
  const [selectedPhoto, setSelectedPhoto] = useState<VaultPhoto | null>(null);
  const [selectedCategory, setSelectedCategory] = useState<string>("All");
  const [isUploading, setIsUploading] = useState<boolean>(false);
  const [isAnalyzing, setIsAnalyzing] = useState<boolean>(false);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [isCameraActive, setIsCameraActive] = useState<boolean>(false);
  const [uploadCategory, setUploadCategory] = useState<"Personal" | "Documents" | "Family" | "Other">("Personal");

  const fileInputRef = useRef<HTMLInputElement>(null);
  const categories = ["All", "Personal", "Documents", "Family", "Other"];

  const filteredPhotos = photos.filter((p) => {
    if (selectedCategory === "All") return true;
    return p.category === selectedCategory;
  });

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    Array.from(files).forEach((file: File) => {
      const reader = new FileReader();
      reader.onload = (event) => {
        const dataUrl = event.target?.result as string;
        if (dataUrl) {
          const newPhoto: VaultPhoto = {
            id: `photo-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
            title: file.name.replace(/\.[^/.]+$/, "") || "Untitled Vault Photo",
            dataUrl,
            timestamp: Date.now(),
            category: uploadCategory,
            sizeKb: Math.round(file.size / 1024),
          };
          onAddPhoto(newPhoto);
        }
      };
      reader.readAsDataURL(file);
    });

    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const handleCaptureVaultPhoto = async () => {
    setIsCameraActive(true);
    try {
      const { photoUrl } = await captureFrontCameraPhoto();
      const newPhoto: VaultPhoto = {
        id: `camera-snap-${Date.now()}`,
        title: `Camera Capture ${new Date().toLocaleDateString()}`,
        dataUrl: photoUrl,
        timestamp: Date.now(),
        category: uploadCategory,
        sizeKb: 180,
      };
      onAddPhoto(newPhoto);
    } catch (err) {
      console.error("Camera snap failed:", err);
    } finally {
      setIsCameraActive(false);
    }
  };

  // Analyze Photo with Gemini (gemini-3.1-pro-preview)
  const handleAnalyzeWithGemini = async (photo: VaultPhoto) => {
    setIsAnalyzing(true);
    setAnalysisError(null);
    try {
      const response = await fetch("/api/analyze-image", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          imageBase64: photo.dataUrl,
          mimeType: "image/jpeg",
          prompt:
            "Examine this private photo/document thoroughly. Detect if it contains sensitive personal data (passwords, financial cards, ID numbers, addresses), evaluate privacy risks, transcribe any critical text, and provide recommendations for keeping it secure in a private vault.",
          model: "gemini-3.1-pro-preview",
        }),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Analysis failed");
      }

      const updated = {
        ...photo,
        aiAnalysis: data.analysis,
        aiAnalysisModel: data.modelUsed || "gemini-3.1-pro-preview",
      };
      onUpdatePhoto(updated);
      setSelectedPhoto(updated);
    } catch (err: unknown) {
      console.error(err);
      const msg = err instanceof Error ? err.message : "Failed to analyze photo";
      setAnalysisError(msg);
    } finally {
      setIsAnalyzing(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      {/* Top Banner: Vault Status & Actions */}
      <div className="p-5 rounded-2xl bg-slate-900/90 border border-slate-800 flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
        <div className="flex items-start gap-3.5">
          <div className="w-12 h-12 rounded-2xl bg-cyan-500/10 border border-cyan-500/20 flex items-center justify-center text-cyan-400 shrink-0">
            <Lock className="w-6 h-6" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-base font-bold text-slate-100">
                Private Gallery Vault
              </h3>
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-cyan-500/15 text-cyan-300 font-semibold border border-cyan-500/30">
                Encrypted & Hidden
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-0.5">
              Hidden from device public gallery. Analyze sensitive photos with Gemini AI.
            </p>
          </div>
        </div>

        {/* Action Buttons */}
        <div className="flex items-center gap-2.5 w-full md:w-auto flex-wrap">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            onChange={handleFileUpload}
            className="hidden"
          />

          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="flex-1 md:flex-initial px-4 py-2 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-bold text-xs flex items-center justify-center gap-1.5 transition-colors shadow-md shadow-cyan-500/20"
          >
            <Upload className="w-4 h-4" />
            Import Photos
          </button>

          <button
            type="button"
            onClick={handleCaptureVaultPhoto}
            disabled={isCameraActive}
            className="flex-1 md:flex-initial px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors disabled:opacity-50"
          >
            <Camera className="w-4 h-4 text-cyan-400" />
            {isCameraActive ? "Taking Photo..." : "Snap to Vault"}
          </button>
        </div>
      </div>

      {/* Category Pills & Count */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-1.5 overflow-x-auto pb-1 sm:pb-0">
          {categories.map((cat) => (
            <button
              key={cat}
              type="button"
              onClick={() => setSelectedCategory(cat)}
              className={`px-3 py-1.5 rounded-xl text-xs font-medium whitespace-nowrap transition-all ${
                selectedCategory === cat
                  ? "bg-cyan-500 text-slate-950 font-bold shadow"
                  : "bg-slate-900 text-slate-400 hover:text-slate-200 border border-slate-800"
              }`}
            >
              {cat}
            </button>
          ))}
        </div>

        <span className="text-xs text-slate-400">
          Total Hidden Items: <strong className="text-cyan-400 font-mono">{filteredPhotos.length}</strong>
        </span>
      </div>

      {/* Photos Grid */}
      {filteredPhotos.length === 0 ? (
        <div className="p-12 rounded-2xl bg-slate-900/60 border border-slate-800 flex flex-col items-center justify-center text-center">
          <div className="w-16 h-16 rounded-full bg-slate-800/80 flex items-center justify-center text-slate-400 mb-3">
            <ImageIcon className="w-8 h-8 text-slate-500" />
          </div>
          <h4 className="text-base font-semibold text-slate-200">
            Vault Album is Empty
          </h4>
          <p className="text-xs text-slate-400 max-w-sm mt-1">
            Import personal photos, confidential documents, ID cards, or camera snapshots to protect them from unauthorized eyes.
          </p>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="mt-4 px-4 py-2 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-slate-950 text-xs font-bold transition-colors"
          >
            Choose Photos to Import
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3.5">
          {filteredPhotos.map((photo) => (
            <div
              key={photo.id}
              onClick={() => setSelectedPhoto(photo)}
              className="group relative aspect-square rounded-2xl bg-slate-900 border border-slate-800 overflow-hidden cursor-pointer hover:border-cyan-500/50 transition-all shadow-md"
            >
              <img
                src={photo.dataUrl}
                alt={photo.title}
                className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
              />

              {/* Badges */}
              <div className="absolute top-2 left-2 flex flex-col gap-1 pointer-events-none">
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-950/80 text-slate-300 font-medium backdrop-blur-sm border border-slate-700/60">
                  {photo.category}
                </span>
                {photo.aiAnalysis && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-cyan-500/90 text-slate-950 font-bold backdrop-blur-sm flex items-center gap-1">
                    <Sparkles className="w-2.5 h-2.5" /> AI Audited
                  </span>
                )}
              </div>

              {/* Hover Overlay */}
              <div className="absolute inset-0 bg-gradient-to-t from-slate-950/90 via-slate-950/20 to-transparent opacity-0 group-hover:opacity-100 transition-opacity flex flex-col justify-end p-2.5">
                <p className="text-xs font-semibold text-white truncate">{photo.title}</p>
                <div className="flex items-center justify-between text-[10px] text-slate-300 mt-1">
                  <span>{photo.sizeKb} KB</span>
                  <span className="text-cyan-400 flex items-center gap-0.5 font-medium">
                    <Eye className="w-3 h-3" /> View
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Full Photo Modal with Gemini AI Analysis */}
      {selectedPhoto && (
        <div className="fixed inset-0 z-50 bg-slate-950/90 backdrop-blur-md flex items-center justify-center p-3 sm:p-5 overflow-y-auto">
          <div className="bg-slate-900 border border-slate-800 rounded-3xl max-w-2xl w-full max-h-[90vh] flex flex-col overflow-hidden shadow-2xl animate-scale-up">
            {/* Modal Header */}
            <div className="p-4 border-b border-slate-800 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <ShieldCheck className="w-5 h-5 text-cyan-400" />
                <h4 className="text-sm font-bold text-slate-100 truncate max-w-xs sm:max-w-md">
                  {selectedPhoto.title}
                </h4>
              </div>
              <button
                type="button"
                onClick={() => {
                  setSelectedPhoto(null);
                  setAnalysisError(null);
                }}
                className="p-1.5 rounded-xl hover:bg-slate-800 text-slate-400 hover:text-slate-200 transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Modal Body */}
            <div className="p-4 overflow-y-auto flex flex-col gap-4">
              <div className="rounded-2xl overflow-hidden bg-slate-950 border border-slate-800 flex items-center justify-center p-2">
                <img
                  src={selectedPhoto.dataUrl}
                  alt={selectedPhoto.title}
                  className="max-h-[380px] w-auto max-w-full object-contain rounded-xl"
                />
              </div>

              {/* Photo Metadata */}
              <div className="grid grid-cols-3 gap-2 text-xs">
                <div className="p-2.5 rounded-xl bg-slate-950/60 border border-slate-800/80">
                  <span className="text-slate-400">Category:</span>
                  <div className="font-semibold text-slate-200 mt-0.5">
                    {selectedPhoto.category}
                  </div>
                </div>
                <div className="p-2.5 rounded-xl bg-slate-950/60 border border-slate-800/80">
                  <span className="text-slate-400">Size:</span>
                  <div className="font-semibold text-slate-200 mt-0.5">
                    {selectedPhoto.sizeKb} KB
                  </div>
                </div>
                <div className="p-2.5 rounded-xl bg-slate-950/60 border border-slate-800/80">
                  <span className="text-slate-400">Added:</span>
                  <div className="font-semibold text-slate-200 mt-0.5">
                    {new Date(selectedPhoto.timestamp).toLocaleDateString()}
                  </div>
                </div>
              </div>

              {/* Gemini AI Image Understanding Card */}
              <div className="p-4 rounded-2xl bg-cyan-950/20 border border-cyan-500/30 flex flex-col gap-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-xs font-bold text-cyan-300">
                    <Sparkles className="w-4 h-4 text-cyan-400" />
                    <span>Gemini AI Image Privacy & Security Analysis</span>
                  </div>

                  <button
                    type="button"
                    onClick={() => handleAnalyzeWithGemini(selectedPhoto)}
                    disabled={isAnalyzing}
                    className="px-3 py-1.5 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-slate-950 text-xs font-bold flex items-center gap-1.5 transition-colors disabled:opacity-50 shadow-sm"
                  >
                    {isAnalyzing ? (
                      <>
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        Analyzing with gemini-3.1-pro-preview...
                      </>
                    ) : (
                      <>
                        <Sparkles className="w-3.5 h-3.5" />
                        {selectedPhoto.aiAnalysis ? "Re-Analyze Image" : "Analyze with Gemini"}
                      </>
                    )}
                  </button>
                </div>

                {analysisError && (
                  <div className="text-xs text-red-400 p-2.5 rounded-xl bg-red-950/40 border border-red-900/50">
                    {analysisError}
                  </div>
                )}

                {selectedPhoto.aiAnalysis ? (
                  <div className="text-xs text-slate-300 leading-relaxed p-3 rounded-xl bg-slate-950/70 border border-cyan-500/20 whitespace-pre-wrap">
                    {selectedPhoto.aiAnalysis}
                    <div className="mt-2 pt-2 border-t border-slate-800 text-[10px] text-cyan-400 font-mono">
                      Analyzed via: {selectedPhoto.aiAnalysisModel || "gemini-3.1-pro-preview"}
                    </div>
                  </div>
                ) : (
                  <p className="text-xs text-slate-400">
                    Click "Analyze with Gemini" to scan this image for sensitive text, personal data, ID information, or confidentiality ratings using Gemini image understanding.
                  </p>
                )}
              </div>

              {/* Action Toolbar */}
              <div className="flex items-center justify-between pt-2 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => {
                    onDeletePhoto(selectedPhoto.id);
                    setSelectedPhoto(null);
                  }}
                  className="px-3.5 py-2 rounded-xl text-xs text-red-400 hover:bg-red-950/40 transition-colors flex items-center gap-1.5"
                >
                  <Trash2 className="w-4 h-4" />
                  Delete from Vault
                </button>

                <a
                  href={selectedPhoto.dataUrl}
                  download={`${selectedPhoto.title}.jpg`}
                  className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-100 text-xs font-semibold transition-colors flex items-center gap-1.5 border border-slate-700"
                >
                  <Download className="w-4 h-4" />
                  Export to Device
                </a>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
