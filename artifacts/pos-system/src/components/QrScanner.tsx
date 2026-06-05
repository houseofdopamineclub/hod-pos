import { useCallback, useEffect, useRef, useState } from "react";
import jsQR from "jsqr";
import { BarcodeDetector as WasmBarcodeDetector, setZXingModuleOverrides } from "barcode-detector/ponyfill";

// ── Fast, device-independent QR decoding ────────────────────────────────────
// 2026-06 (Khushi — 21-tablet scanner perf fix). The old path used the native
// BarcodeDetector when present (instant) and fell back to jsQR otherwise. jsQR
// is a pure-JS decoder that runs on the main thread every frame and is SLOW on
// cheaper Android tablets + iPads (no native BarcodeDetector), which is exactly
// where staff reported slow / non-loading scans. We now use a WASM (zxing)
// decoder as the universal fast fallback so EVERY device decodes fast,
// regardless of camera/browser. jsQR is kept only as a last-resort safety net
// if the WASM module can't load (never lose the door).
//
// The WASM binary is SELF-HOSTED from /public (copied at build) so it works on
// venue wifi without any CDN dependency and loads once (browser-cached).
type _DetectFn = (src: CanvasImageSource) => Promise<Array<{ rawValue: string }>>;
let _zxingConfigured = false;
function _ensureZxingConfigured() {
  if (_zxingConfigured) return;
  _zxingConfigured = true;
  try {
    setZXingModuleOverrides({
      locateFile: (path: string, prefix: string) =>
        path.endsWith(".wasm") ? `${import.meta.env.BASE_URL}zxing_reader.wasm` : prefix + path,
    });
  } catch { /* fall through — defaults to CDN if override fails */ }
}

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
export function QrScanner({ onResult, onClose, brutalist = false }: { onResult: (data: string) => void; onClose: () => void; brutalist?: boolean }) {
  // 🆕 Door Mode opts into the Gumroad-brutalist look via `brutalist`; Captain/Bar
  // keep the original dark/gold theme (default false → zero change for them).
  const _t = brutalist
    ? {
        scrim: "rgba(0,0,0,.5)",
        frameBorder: "2px solid #000",
        frameRadius: 8,
        reticle: "2px solid #FF90E8",
        reticleRadius: 6,
        errText: "#FF5733",
        infoText: "#6B6B6B",
        btnBg: "#FF90E8",
        btnBorder: "2px solid #000",
        btnText: "#000",
        inputBg: "#FFFFFF",
        inputBorder: "2px solid #000",
        inputText: "#000",
        inputRadius: 6,
        btnRadius: 6,
        disabledBg: "#F4F4F0",
        disabledText: "#B0B0B0",
        closeBg: "#FFFFFF",
        closeBorder: "2px solid #000",
        closeText: "#000",
      }
    : {
        scrim: "rgba(0,0,0,.95)",
        frameBorder: "3px solid rgba(242,199,68,.4)",
        frameRadius: 20,
        reticle: "3px solid rgba(242,199,68,.6)",
        reticleRadius: 16,
        errText: "#FCA5A5",
        infoText: "rgba(255,255,255,.7)",
        btnBg: "#C8A645",
        btnBorder: "none",
        btnText: "#0A0A0A",
        inputBg: "rgba(255,255,255,.06)",
        inputBorder: "1px solid rgba(255,255,255,.15)",
        inputText: "#fff",
        inputRadius: 10,
        btnRadius: 10,
        disabledBg: "rgba(255,255,255,.06)",
        disabledText: "rgba(255,255,255,.4)",
        closeBg: "rgba(255,255,255,.08)",
        closeBorder: "1px solid rgba(255,255,255,.15)",
        closeText: "#fff",
      };
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

      // jsQR LAST-RESORT decoder, extracted into a function so we can drop to
      // it BOTH when no fast detector can be built AND if a built detector
      // (native or WASM) starts throwing at runtime — e.g. the WASM binary
      // 404s / is CSP-blocked on a tablet. Never lose the door.
      const startJsqr = () => {
        if (canvasRef.current) return; // already running
        const canvas = document.createElement("canvas");
        canvasRef.current = canvas;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) { setErr("Unable to initialise canvas for QR fallback."); return; }
        const jtick = () => {
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
          rafRef.current = requestAnimationFrame(jtick);
        };
        jtick();
      };

      // Build the FASTEST available decoder for this device:
      //   1. Native BarcodeDetector  — instant, zero download (Chrome/Android,
      //      newer Edge). When present we use it directly.
      //   2. WASM (zxing) ponyfill   — universal fast fallback for the tablets
      //      that have NO native detector (cheap Androids, iPads, Firefox).
      //      This is the key fix: these devices used to fall back to the slow
      //      jsQR path. Now they get near-native WASM speed too.
      // Only if BOTH can't be built do we drop straight to jsQR.
      let detector: { detect: _DetectFn } | null = null;
      const Native = (window as unknown as { BarcodeDetector?: new (o: { formats: string[] }) => { detect: _DetectFn } }).BarcodeDetector;
      if (typeof Native === "function") {
        try { detector = new Native({ formats: ["qr_code"] }); } catch { detector = null; }
      }
      if (!detector) {
        try {
          _ensureZxingConfigured();
          detector = new WasmBarcodeDetector({ formats: ["qr_code"] }) as unknown as { detect: _DetectFn };
          // Warm up the WASM module on a tiny canvas so the FIRST real scan
          // isn't delayed by module compilation.
          try {
            const warm = document.createElement("canvas");
            warm.width = 2; warm.height = 2;
            detector.detect(warm).catch(() => {});
          } catch {}
        } catch { detector = null; }
      }

      if (detector) {
        const det = detector;
        // Throttle to ~10fps. Decoding every animation frame is wasteful and
        // (on the WASM path) keeps the CPU pegged — 10fps decodes instantly to
        // the human eye while leaving the UI smooth.
        let last = 0;
        let fails = 0; // consecutive runtime decode failures
        const tick = async (ts: number) => {
          if (!scanRef.current || !videoRef.current) return;
          if (ts - last >= 100) {
            last = ts;
            try {
              const codes = await det.detect(videoRef.current);
              fails = 0;
              if (codes.length > 0 && codes[0].rawValue) {
                scanRef.current = false;
                onResultRef.current(codes[0].rawValue);
                return;
              }
            } catch {
              // A built detector throwing repeatedly means the WASM binary
              // failed to load (404 / CSP / network). Demote to the jsQR
              // safety net after a short burst so the door is never stuck on
              // a scanner that opens but never decodes.
              fails += 1;
              if (fails >= 8) { startJsqr(); return; }
            }
          }
          rafRef.current = requestAnimationFrame(tick);
        };
        rafRef.current = requestAnimationFrame(tick);
        return;
      }

      // No fast detector could be built at all — go straight to jsQR.
      startJsqr();
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
    <div style={{ position: "fixed", inset: 0, background: _t.scrim, zIndex: 9999, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 16, overflowY: "auto" }}>
      <div style={{ position: "relative", width: "100%", maxWidth: 360, aspectRatio: "1", borderRadius: _t.frameRadius, overflow: "hidden", border: _t.frameBorder, background: "#000" }}>
        <video ref={videoRef} style={{ width: "100%", height: "100%", objectFit: "cover" }} playsInline muted autoPlay />
        <div style={{ position: "absolute", inset: "20%", border: _t.reticle, borderRadius: _t.reticleRadius, pointerEvents: "none" }} />
      </div>

      {/* Diagnostic line — Khushi needs to see WHY the camera failed so she
          can tell us, not a generic "couldn't open" message. */}
      <div style={{ color: err ? _t.errText : _t.infoText, fontSize: 13, marginTop: 14, textAlign: "center", maxWidth: 360, lineHeight: 1.4, fontWeight: err ? 700 : 500 }}>
        {err || status}
      </div>

      {/* TRY AGAIN — user-gesture re-prompt for camera permission. */}
      {err && (
        <button onClick={() => setAttempt((a) => a + 1)}
          style={{ marginTop: 10, padding: "10px 22px", borderRadius: _t.btnRadius, background: _t.btnBg, border: _t.btnBorder, color: _t.btnText, fontSize: 13, fontWeight: 900, cursor: "pointer", letterSpacing: .3 }}>
          🔄 TRY CAMERA AGAIN
        </button>
      )}

      {/* MANUAL ENTRY — always visible, always works, never blocks revenue. */}
      <div style={{ marginTop: 16, width: "100%", maxWidth: 360, display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={{ fontSize: 10, fontWeight: 800, color: _t.infoText, letterSpacing: 1, textAlign: "center" }}>
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
            style={{ flex: 1, padding: "11px 12px", borderRadius: _t.inputRadius, background: _t.inputBg, border: _t.inputBorder, color: _t.inputText, fontSize: 13, outline: "none" }}
          />
          <button onClick={submitManual} disabled={!manualRef.trim()}
            style={{ padding: "11px 18px", borderRadius: _t.btnRadius, background: manualRef.trim() ? _t.btnBg : _t.disabledBg, border: manualRef.trim() ? _t.btnBorder : _t.inputBorder, color: manualRef.trim() ? _t.btnText : _t.disabledText, fontSize: 12, fontWeight: 900, cursor: manualRef.trim() ? "pointer" : "not-allowed", letterSpacing: .3 }}>
            FIND
          </button>
        </div>
      </div>

      <button onClick={onClose}
        style={{ marginTop: 14, padding: "12px 28px", borderRadius: _t.btnRadius, background: _t.closeBg, border: _t.closeBorder, color: _t.closeText, fontSize: 14, fontWeight: 700, cursor: "pointer" }}>
        Close Scanner
      </button>
    </div>
  );
}

export default QrScanner;
