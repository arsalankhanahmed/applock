/**
 * Camera utility for capturing Intruder Selfie and Vault Camera Photos
 */

export async function captureFrontCameraPhoto(): Promise<{
  photoUrl: string;
  isRealCapture: boolean;
}> {
  // Try real camera first
  if (typeof navigator !== "undefined" && navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: "user",
          width: { ideal: 640 },
          height: { ideal: 480 },
        },
        audio: false,
      });

      const video = document.createElement("video");
      video.playsInline = true;
      video.muted = true;
      video.srcObject = stream;

      await new Promise<void>((resolve) => {
        video.onloadedmetadata = () => {
          video.play().then(() => resolve()).catch(() => resolve());
        };
        setTimeout(resolve, 1500); // safety fallback timeout
      });

      // Allow camera sensor a brief moment to adjust exposure
      await new Promise((r) => setTimeout(r, 400));

      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth || 640;
      canvas.height = video.videoHeight || 480;
      const ctx = canvas.getContext("2d");

      if (ctx) {
        // Draw frame
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

        // Add security timestamp watermark
        ctx.fillStyle = "rgba(0, 0, 0, 0.6)";
        ctx.fillRect(0, canvas.height - 36, canvas.width, 36);
        ctx.font = "bold 14px sans-serif";
        ctx.fillStyle = "#ef4444";
        ctx.fillText(
          `[INTRUDER SELFIE CAPTURED] ${new Date().toLocaleString()}`,
          16,
          canvas.height - 13
        );

        const dataUrl = canvas.toDataURL("image/jpeg", 0.85);

        // Stop all tracks to release camera hardware promptly
        stream.getTracks().forEach((track) => track.stop());

        return { photoUrl: dataUrl, isRealCapture: true };
      }

      // Stop tracks if canvas failed
      stream.getTracks().forEach((track) => track.stop());
    } catch (err) {
      console.warn("Real camera capture not available or permitted, creating simulated intruder snapshot:", err);
    }
  }

  // Realistic simulated intruder capture
  return {
    photoUrl: generateSimulatedIntruderSvg(),
    isRealCapture: false,
  };
}

function generateSimulatedIntruderSvg(): string {
  const time = new Date().toLocaleTimeString();
  const date = new Date().toLocaleDateString();
  const randomId = Math.floor(1000 + Math.random() * 9000);

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480" viewBox="0 0 640 480">
    <rect width="640" height="480" fill="#090d16"/>
    <!-- Camera viewfinder grid lines -->
    <line x1="213" y1="0" x2="213" y2="480" stroke="#1e293b" stroke-width="1" stroke-dasharray="4,4"/>
    <line x1="426" y1="0" x2="426" y2="480" stroke="#1e293b" stroke-width="1" stroke-dasharray="4,4"/>
    <line x1="0" y1="160" x2="640" y2="160" stroke="#1e293b" stroke-width="1" stroke-dasharray="4,4"/>
    <line x1="0" y1="320" x2="640" y2="320" stroke="#1e293b" stroke-width="1" stroke-dasharray="4,4"/>

    <!-- Intruder silhouette -->
    <ellipse cx="320" cy="180" rx="70" ry="85" fill="#1e293b" stroke="#334155" stroke-width="3"/>
    <path d="M 180,410 C 180,310 240,280 320,280 C 400,280 460,310 460,410 Z" fill="#1e293b" stroke="#334155" stroke-width="3"/>
    
    <!-- Red target box around face -->
    <rect x="230" y="80" width="180" height="210" fill="none" stroke="#ef4444" stroke-width="2" stroke-dasharray="8,6"/>
    <circle cx="230" cy="80" r="6" fill="#ef4444"/>
    <circle cx="410" cy="80" r="6" fill="#ef4444"/>
    <circle cx="230" cy="290" r="6" fill="#ef4444"/>
    <circle cx="410" cy="290" r="6" fill="#ef4444"/>

    <!-- Warning badge banner -->
    <rect x="180" y="24" width="280" height="34" rx="6" fill="#dc2626"/>
    <text x="320" y="46" fill="#ffffff" font-family="sans-serif" font-size="14" font-weight="bold" text-anchor="middle" letter-spacing="1">⚠️ INTRUDER DETECTED #${randomId}</text>

    <!-- Bottom info bar -->
    <rect x="0" y="435" width="640" height="45" fill="#020617"/>
    <text x="20" y="462" fill="#ef4444" font-family="monospace" font-size="13" font-weight="bold">FRONT CAMERA AUTO-SNAP • ${date} ${time}</text>
    <text x="620" y="462" fill="#94a3b8" font-family="sans-serif" font-size="12" text-anchor="end">UNAUTHORIZED ACCESS ATTEMPT</text>
  </svg>`;

  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}
