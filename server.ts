import express from "express";
import path from "path";
import fs from "fs";
import JSZip from "jszip";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = 3000;

app.use(express.json({ limit: "25mb" }));

function getGeminiClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return null;
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        "User-Agent": "aistudio-build",
      },
    },
  });
}

// Health check
app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    hasApiKey: Boolean(process.env.GEMINI_API_KEY),
    timestamp: new Date().toISOString(),
  });
});

// Gemini Multi-turn Chat Endpoint
app.post("/api/chat", async (req, res) => {
  try {
    const { messages, model = "gemini-3.5-flash", systemInstruction } = req.body;
    const ai = getGeminiClient();

    if (!ai) {
      return res.status(503).json({
        error: "Gemini API Key is not configured on the server. Please check the Secrets panel.",
      });
    }

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "Messages array is required." });
    }

    // Selected model from allowed models
    const validModels = [
      "gemini-3.1-pro-preview",
      "gemini-3.5-flash",
      "gemini-3.1-flash-lite",
      "gemini-3.8-flash",
    ];
    let selectedModel = validModels.includes(model) ? model : "gemini-3.5-flash";

    // Format chat history
    const contents = messages.map((m: { role: string; content: string }) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));

    const config: Record<string, unknown> = {};
    if (systemInstruction) {
      config.systemInstruction = systemInstruction;
    }

    let responseText = "";
    try {
      const response = await ai.models.generateContent({
        model: selectedModel,
        contents,
        config,
      });
      responseText = response.text || "No response received from assistant.";
    } catch (primaryErr) {
      console.warn(`Primary model ${selectedModel} failed, trying fallback model gemini-3.8-flash:`, primaryErr);
      // Try fallback to gemini-3.8-flash
      const fallbackResponse = await ai.models.generateContent({
        model: "gemini-3.8-flash",
        contents,
        config,
      });
      responseText = fallbackResponse.text || "No response received from assistant.";
    }

    return res.json({ text: responseText, modelUsed: selectedModel });
  } catch (error: unknown) {
    console.error("Chat error:", error);
    const msg = error instanceof Error ? error.message : "Internal chat error";
    return res.status(500).json({ error: msg });
  }
});

// Gemini Image Analysis Endpoint (Analyze sensitive content, private vault privacy tags, documents)
app.post("/api/analyze-image", async (req, res) => {
  try {
    const {
      imageBase64,
      mimeType = "image/jpeg",
      prompt = "Analyze this image for privacy, sensitive credentials, document classification, or safety in a private vault. Provide key details, detected text/objects, and privacy recommendations.",
      model = "gemini-3.1-pro-preview",
    } = req.body;

    const ai = getGeminiClient();
    if (!ai) {
      return res.status(503).json({
        error: "Gemini API Key is not configured on the server. Please check the Secrets panel.",
      });
    }

    if (!imageBase64) {
      return res.status(400).json({ error: "imageBase64 is required." });
    }

    // Clean up base64 string if it has data URL prefix
    const cleanBase64 = imageBase64.replace(/^data:[^;]+;base64,/, "");

    const imagePart = {
      inlineData: {
        mimeType,
        data: cleanBase64,
      },
    };

    const textPart = {
      text: prompt,
    };

    let selectedModel = model === "gemini-3.1-pro-preview" ? "gemini-3.1-pro-preview" : "gemini-3.8-flash";
    let analysisText = "";

    try {
      const response = await ai.models.generateContent({
        model: selectedModel,
        contents: { parts: [imagePart, textPart] },
        config: {
          systemInstruction:
            "You are an expert digital privacy and image security analyst for a private gallery vault app. Provide clear, helpful, structured analysis.",
        },
      });
      analysisText = response.text || "No analysis generated.";
    } catch (primaryErr) {
      console.warn(`Primary model ${selectedModel} failed for image analysis, falling back to gemini-3.8-flash:`, primaryErr);
      const fallbackResponse = await ai.models.generateContent({
        model: "gemini-3.8-flash",
        contents: { parts: [imagePart, textPart] },
        config: {
          systemInstruction:
            "You are an expert digital privacy and image security analyst for a private gallery vault app. Provide clear, helpful, structured analysis.",
        },
      });
      analysisText = fallbackResponse.text || "No analysis generated.";
      selectedModel = "gemini-3.8-flash";
    }

    return res.json({ analysis: analysisText, modelUsed: selectedModel });
  } catch (error: unknown) {
    console.error("Image analysis error:", error);
    const msg = error instanceof Error ? error.message : "Internal image analysis error";
    return res.status(500).json({ error: msg });
  }
});

function addDirectoryToZip(zip: JSZip, localDir: string, zipPrefix: string = "") {
  const items = fs.readdirSync(localDir);
  for (const item of items) {
    const fullPath = path.join(localDir, item);
    const stat = fs.statSync(fullPath);
    const zipPath = zipPrefix ? `${zipPrefix}/${item}` : item;
    if (stat.isDirectory()) {
      addDirectoryToZip(zip, fullPath, zipPath);
    } else {
      const content = fs.readFileSync(fullPath);
      zip.file(zipPath, content);
    }
  }
}

// Download Real Native Android Studio Project ZIP
app.get("/api/download-android-source", async (_req, res) => {
  try {
    const androidDir = path.join(process.cwd(), "android");
    if (!fs.existsSync(androidDir)) {
      return res.status(404).json({ error: "Android directory not found." });
    }

    const zip = new JSZip();
    addDirectoryToZip(zip, androidDir, "AppLock-Android");

    const buffer = await zip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
      compressionOptions: { level: 9 },
    });

    res.setHeader("Content-Type", "application/zip");
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="AppLock-Real-Android-Studio-Source.zip"'
    );
    res.setHeader("Content-Length", buffer.length);
    return res.send(buffer);
  } catch (error) {
    console.error("Error creating android zip:", error);
    if (!res.headersSent) {
      return res.status(500).json({ error: "Failed to generate android zip file." });
    }
  }
});

// Vite middleware or production static serving
async function start() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`AppLock & Vault server running on http://0.0.0.0:${PORT}`);
  });
}

start().catch((err) => {
  console.error("Failed to start server:", err);
});
