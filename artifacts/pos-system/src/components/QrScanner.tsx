import { useEffect, useRef, useState } from "react";
import jsQR from "jsqr";

/**
 * Cross-browser QR scanner.
 *
 * Tries the native `BarcodeDetector` API first (Chrome/Edge on Android +
 * desktop). When unavailable (iOS Safari, older browsers, desktop Firefox)
 * falls back to a canvas + jsQR pipeline so the door + bar tablets work
 * regardless of the device the staff happens to grab.
 *
 * Surfaces inline status / permission errors instead of failing silently.
 */
export function QrScanner({ onResult, onClose }: { onResult: (data: string) => void; onClose: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const scanRef = useRef(true);
  const rafRef = useRef(0);
  const [status, setStatus] = useState("Starting camera…");
  const [err, setErr] = useState("");

  useEffect(() => {
    let cancelled = false;
    scanRef.current = true;

    const stop = () => {
      scanRef.current = false;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };

    const start = async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          setErr("Camera not supported on this browser. Try Safari or Chrome.");
          return;
        }
        let stream: MediaStream;
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: { ideal: "environment" } },
            audio: false,
          });
        } catch {
          // Some desktops/iframes refuse facingMode constraints — retry plain.
          stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        }
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = stream;
        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        video.setAttribute("playsinline", "true"); // iOS Safari: prevents fullscreen takeover
        try { await video.play(); } catch {}
        setStatus("Point camera at QR code");

        // Native path — fastest where available
        const hasNative = typeof (window as unknown as { BarcodeDetector?: unknown }).BarcodeDetector === "function";
        if (hasNative) {
          try {
            const Detector = (window as unknown as { BarcodeDetector: new (opts: { formats: string[] }) => { detect: (s: HTMLVideoElement) => Promise<Array<{ rawValue: string }>> } }).BarcodeDetector;
            const detector = new Detector({ formats: ["qr_code"] });
            const tick = async () => {
              if (!scanRef.current || !videoRef.current) return;
              try {
                const codes = await detector.detect(videoRef.current);
                if (codes.length > 0 && codes[0].rawValue) {
                  scanRef.current = false;
                  onResult(codes[0].rawValue);
                  return;
                }
              } catch {}
              rafRef.current = requestAnimationFrame(tick);
            };
            tick();
            return;
          } catch {
            // Detector instantiation failed (e.g. format unsupported) — drop to jsQR.
          }
        }

        // jsQR fallback — iOS Safari, desktop Firefox, anything without BarcodeDetector
        const canvas = document.createElement("canvas");
        canvasRef.current = canvas;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) { setErr("Unable to initialise canvas for QR fallback."); return; }

        const tick = () => {
          if (!scanRef.current || !videoRef.current) return;
          const v = videoRef.current;
          if (v.readyState === v.HAVE_ENOUGH_DATA && v.videoWidth > 0) {
            // Sample at ≤640px wide to keep jsQR snappy on low-end tablets.
            const scale = Math.min(1, 640 / v.videoWidth);
            const w = Math.floor(v.videoWidth * scale);
            const h = Math.floor(v.videoHeight * scale);
            if (canvas.width !== w) canvas.width = w;
            if (canvas.height !== h) canvas.height = h;
            ctx.drawImage(v, 0, 0, w, h);
            try {
              const img = ctx.getImageData(0, 0, w, h);
              const code = jsQR(img.data, img.width, img.height, { inversionAttempts: "dontInvert" });
              if (code?.data) {
                scanRef.current = false;
                onResult(code.data);
                return;
              }
            } catch {}
          }
          rafRef.current = requestAnimationFrame(tick);
        };
        tick();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/permission|denied|notallowed/i.test(msg)) {
          setErr("Camera permission denied. Allow access in browser settings, then re-open the scanner.");
        } else if (/not.*found|notfound/i.test(msg)) {
          setErr("No camera found on this device.");
        } else {
          setErr(`Couldn't start camera: ${msg}`);
        }
      }
    };

    start();
    return () => { cancelled = true; stop(); };
  }, [onResult]);

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.95)", zIndex: 9999, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div style={{ position: "relative", width: "100%", maxWidth: 360, aspectRatio: "1", borderRadius: 20, overflow: "hidden", border: "3px solid rgba(242,199,68,.4)", background: "#000" }}>
        <video ref={videoRef} style={{ width: "100%", height: "100%", objectFit: "cover" }} playsInline muted autoPlay />
        <div style={{ position: "absolute", inset: "20%", border: "3px solid rgba(242,199,68,.6)", borderRadius: 16, pointerEvents: "none" }} />
      </div>
      <div style={{ color: err ? "#FCA5A5" : "rgba(255,255,255,.65)", fontSize: 13, marginTop: 16, textAlign: "center", maxWidth: 360, lineHeight: 1.4 }}>
        {err || status}
      </div>
      <button onClick={onClose}
        style={{ marginTop: 20, padding: "12px 28px", borderRadius: 12, background: "rgba(255,255,255,.08)", border: "1px solid rgba(255,255,255,.15)", color: "#fff", fontSize: 14, fontWeight: 700, cursor: "pointer" }}>
        Close Scanner
      </button>
    </div>
  );
}

export default QrScanner;
