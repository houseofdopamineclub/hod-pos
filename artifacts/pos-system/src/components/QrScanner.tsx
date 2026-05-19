import { useCallback, useEffect, useRef, useState } from "react";
import jsQR from "jsqr";

/**
 * Cross-browser QR scanner.
 *
 * Tries the native `BarcodeDetector` API first (Chrome/Edge on Android +
 * desktop). When unavailable (iOS Safari, older browsers, desktop Firefox)
 * falls back to a canvas + jsQR pipeline so the door + bar tablets work
 * regardless of the device the staff happens to grab.
 *
 * Surfaces inline status / permission errors instead of failing silently,
 * shows the raw error to staff, and exposes a TRY AGAIN button so a fresh
 * user-gesture can re-prompt the camera if the first attempt failed.
 *
 * Used by Door Mode, Captain Mode, and Bar Mode.
 */
export function QrScanner({ onResult, onClose }: { onResult: (data: string) => void; onClose: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const scanRef = useRef(true);
  const rafRef = useRef(0);
  const [status, setStatus] = useState("Starting camera…");
  const [err, setErr] = useState("");
  // 🔴 BUGFIX 2026-05-19 (Khushi LIVE-NIGHT) — manual entry fallback. If the
  // camera refuses to start (permission denied, in-app webview, broken lens,
  // scratched screen, dim lighting), door staff can ALWAYS type the booking
  // ref / paste the wallet URL. Never lose a guest at the door.
  const [manualRef, setManualRef] = useState("");
  const [attempt, setAttempt] = useState(0);

  // Keep latest onResult in a ref so the camera-init effect can have []
  // deps. Otherwise the parent's frequent Firestore-driven re-renders
  // recreate `onResult` → effect re-runs → MediaStream torn down → iOS
  // Safari refuses to re-prompt the camera (no live user gesture).
  const onResultRef = useRef(onResult);
  onResultRef.current = onResult;

  // Pull the start fn out so the TRY AGAIN button can re-run it with a
  // fresh user-gesture context. iOS/Android Chrome both bind camera
  // permission re-prompts to a recent gesture.
  const startCamera = useCallback(async () => {
    setErr("");
    setStatus("Starting camera…");
    scanRef.current = true;

    // Stop any leftover stream from a previous attempt before re-asking.
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;

    try {
      // 🚨 HTTPS check — getUserMedia requires a secure context everywhere
      // except localhost. If the site is served over http://pos.hodclub.in
      // (not https), the API doesn't exist on the navigator object and both
      // iOS and Android fail silently. Show a loud, specific message.
      if (typeof window !== "undefined" && window.isSecureContext === false) {
        setErr("Site must load over HTTPS for camera. Use the https:// URL.");
        return;
      }
      if (!navigator.mediaDevices?.getUserMedia) {
        setErr("Camera not supported on this browser (in-app browsers like Instagram/Gmail block it). Open in Safari or Chrome.");
        return;
      }

      // iOS Safari needs playsinline + webkit-playsinline + muted as REAL
      // attributes set BEFORE srcObject. JSX props are not always enough.
      const v = videoRef.current;
      if (v) {
        v.setAttribute("playsinline", "");
        v.setAttribute("webkit-playsinline", "");
        v.setAttribute("muted", "");
        v.setAttribute("autoplay", "");
        v.muted = true;
        (v as HTMLVideoElement & { playsInline?: boolean }).playsInline = true;
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
      streamRef.current = stream;

      const video = videoRef.current;
      if (!video) { stream.getTracks().forEach((t) => t.stop()); return; }
      video.srcObject = stream;

      // Retry play() — first attempt may reject if metadata isn't loaded.
      try { await video.play(); }
      catch {
        await new Promise<void>((res) => {
          const onMeta = () => { video.removeEventListener("loadedmetadata", onMeta); res(); };
          video.addEventListener("loadedmetadata", onMeta);
          setTimeout(res, 1500);
        });
        try { await video.play(); } catch (e) {
          setErr(`Camera opened but won't play: ${(e as Error)?.message || e}. Tap TRY AGAIN.`);
          return;
        }
      }
      setStatus("Point camera at QR code");

      // Native BarcodeDetector — Chrome/Edge on Android + desktop.
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
                onResultRef.current(codes[0].rawValue);
                return;
              }
            } catch {}
            rafRef.current = requestAnimationFrame(tick);
          };
          tick();
          return;
        } catch {
          // Detector instantiation failed — drop to jsQR.
        }
      }

      // jsQR fallback — iOS Safari, desktop Firefox, anything without BarcodeDetector.
      const canvas = document.createElement("canvas");
      canvasRef.current = canvas;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) { setErr("Unable to initialise canvas for QR fallback."); return; }

      const tick = () => {
        if (!scanRef.current || !videoRef.current) return;
        const vv = videoRef.current;
        if (vv.readyState === vv.HAVE_ENOUGH_DATA && vv.videoWidth > 0) {
          const scale = Math.min(1, 640 / vv.videoWidth);
          const w = Math.floor(vv.videoWidth * scale);
          const h = Math.floor(vv.videoHeight * scale);
          if (canvas.width !== w) canvas.width = w;
          if (canvas.height !== h) canvas.height = h;
          ctx.drawImage(vv, 0, 0, w, h);
          try {
            const img = ctx.getImageData(0, 0, w, h);
            const code = jsQR(img.data, img.width, img.height, { inversionAttempts: "dontInvert" });
            if (code?.data) {
              scanRef.current = false;
              onResultRef.current(code.data);
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
        setErr("Camera permission denied. Browser settings → site → Allow Camera → tap TRY AGAIN.");
      } else if (/not.*found|notfound|nodevice|notreadable/i.test(msg)) {
        setErr(`No camera available (${msg}). Use the typing box below.`);
      } else if (/overconstrained|constraint/i.test(msg)) {
        setErr(`Camera doesn't match request (${msg}). Tap TRY AGAIN.`);
      } else {
        setErr(`Camera error: ${msg}. Tap TRY AGAIN or type the ref below.`);
      }
    }
  }, []);

  useEffect(() => {
    startCamera();
    return () => {
      scanRef.current = false;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, [startCamera, attempt]);

  const submitManual = () => {
    const v = manualRef.trim();
    if (!v) return;
    scanRef.current = false;
    onResultRef.current(v);
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.95)", zIndex: 9999, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 16, overflowY: "auto" }}>
      <div style={{ position: "relative", width: "100%", maxWidth: 360, aspectRatio: "1", borderRadius: 20, overflow: "hidden", border: "3px solid rgba(242,199,68,.4)", background: "#000" }}>
        <video ref={videoRef} style={{ width: "100%", height: "100%", objectFit: "cover" }} playsInline muted autoPlay />
        <div style={{ position: "absolute", inset: "20%", border: "3px solid rgba(242,199,68,.6)", borderRadius: 16, pointerEvents: "none" }} />
      </div>

      {/* Diagnostic line — Khushi needs to see WHY the camera failed so she
          can tell us, not a generic "couldn't open" message. */}
      <div style={{ color: err ? "#FCA5A5" : "rgba(255,255,255,.7)", fontSize: 13, marginTop: 14, textAlign: "center", maxWidth: 360, lineHeight: 1.4, fontWeight: err ? 700 : 500 }}>
        {err || status}
      </div>

      {/* TRY AGAIN — user-gesture re-prompt for camera permission. */}
      {err && (
        <button onClick={() => setAttempt((a) => a + 1)}
          style={{ marginTop: 10, padding: "10px 22px", borderRadius: 10, background: "#C8A645", border: "none", color: "#0A0A0A", fontSize: 13, fontWeight: 900, cursor: "pointer", letterSpacing: .3 }}>
          🔄 TRY CAMERA AGAIN
        </button>
      )}

      {/* MANUAL ENTRY — always visible, always works, never blocks revenue. */}
      <div style={{ marginTop: 16, width: "100%", maxWidth: 360, display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={{ fontSize: 10, fontWeight: 800, color: "rgba(255,255,255,.55)", letterSpacing: 1, textAlign: "center" }}>
          OR TYPE BOOKING REF / PASTE WALLET LINK
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <input
            value={manualRef}
            onChange={(e) => setManualRef(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") submitManual(); }}
            placeholder="e.g. HOD-XXXXX or TICKET-…"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            style={{ flex: 1, padding: "11px 12px", borderRadius: 10, background: "rgba(255,255,255,.06)", border: "1px solid rgba(255,255,255,.15)", color: "#fff", fontSize: 13, outline: "none" }}
          />
          <button onClick={submitManual} disabled={!manualRef.trim()}
            style={{ padding: "11px 18px", borderRadius: 10, background: manualRef.trim() ? "#C8A645" : "rgba(255,255,255,.06)", border: "none", color: manualRef.trim() ? "#0A0A0A" : "rgba(255,255,255,.4)", fontSize: 12, fontWeight: 900, cursor: manualRef.trim() ? "pointer" : "not-allowed", letterSpacing: .3 }}>
            FIND
          </button>
        </div>
      </div>

      <button onClick={onClose}
        style={{ marginTop: 14, padding: "12px 28px", borderRadius: 12, background: "rgba(255,255,255,.08)", border: "1px solid rgba(255,255,255,.15)", color: "#fff", fontSize: 14, fontWeight: 700, cursor: "pointer" }}>
        Close Scanner
      </button>
    </div>
  );
}

export default QrScanner;
