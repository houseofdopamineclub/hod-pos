import { createRoot } from "react-dom/client";
import App from "./App";
import { AppErrorBoundary } from "./components/AppErrorBoundary";
import "./index.css";

document.documentElement.classList.add("dark");

// 🆕 2026-06-04 v3.220 — if a NEW version is deployed mid-shift, an already-open
// tablet can fail to load a code chunk that no longer exists on the server
// ("Failed to fetch dynamically imported module" / chunk load error) → blank
// screen. Auto-reload ONCE to pull the fresh build. Loop-guarded via
// sessionStorage so a genuinely broken deploy can't boot-loop the tablet.
const CHUNK_RE =
  /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|ChunkLoadError|Loading chunk \d+ failed/i;
function maybeReloadForStaleChunk(msg?: string): boolean {
  if (!msg || !CHUNK_RE.test(msg)) return false;
  try {
    const KEY = "hod_chunk_reloads";
    const now = Date.now();
    const arr: number[] = JSON.parse(sessionStorage.getItem(KEY) || "[]");
    const recent = arr.filter((t) => now - t < 60_000);
    if (recent.length >= 2) return false; // already tried twice — stop, let the boundary show
    sessionStorage.setItem(KEY, JSON.stringify([...recent, now]));
    window.location.reload();
    return true;
  } catch {
    return false;
  }
}

window.addEventListener("unhandledrejection", (e) => {
  const msg = e.reason?.message as string | undefined;
  if (msg?.includes("Missing or insufficient permissions") ||
      e.reason?.code === "permission-denied") {
    e.preventDefault();
    return;
  }
  if (maybeReloadForStaleChunk(msg)) e.preventDefault();
});

window.addEventListener("error", (e) => {
  if (e.message?.includes("Missing or insufficient permissions") ||
      e.message?.includes("permission-denied")) {
    e.preventDefault();
    return;
  }
  // Benign noise some Android WebViews spam — never let it bubble as a crash.
  if (e.message?.includes("ResizeObserver loop")) {
    e.preventDefault();
    return;
  }
  if (maybeReloadForStaleChunk(e.message)) e.preventDefault();
});

createRoot(document.getElementById("root")!).render(
  <AppErrorBoundary>
    <App />
  </AppErrorBoundary>,
);
