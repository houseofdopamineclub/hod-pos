import { Component, type ErrorInfo, type ReactNode } from "react";

// 🆕 2026-06-04 v3.220 — CRITICAL RELIABILITY: global crash safety net.
// Khushi (3:00 AM): "DID KOT PRINT AND IT HUNG AND THERE WAS A BLACK SCREEN ...
// CLICKED ADD ITEMS IN CAPTAIN MODE AND IT HUNG AGAIN."
// ROOT CAUSE: the POS had NO React error boundary. Any uncaught render error
// (a bad data value during a print or an add-items repaint) unmounts the WHOLE
// tree → black screen, recoverable only by closing & reopening the app.
// This boundary catches that error, keeps the tablet usable, AUTO-RELOADS so an
// unattended tablet recovers itself, and shows the error text so we can find &
// fix the real root cause next time. A loop-guard stops auto-reload if it fails
// repeatedly in a short window (so a persistent error can't boot-loop).

const RELOAD_KEY = "hod_eb_reloads";
const LOOP_WINDOW_MS = 60_000; // count reloads within this window
const LOOP_MAX = 3; // stop auto-reloading after this many reloads in the window
const AUTO_RELOAD_MS = 6_000; // auto-reload delay so staff can see what happened

function recentReloadCount(): number {
  try {
    const raw = sessionStorage.getItem(RELOAD_KEY);
    const arr: number[] = raw ? JSON.parse(raw) : [];
    const now = Date.now();
    return arr.filter((t) => now - t < LOOP_WINDOW_MS).length;
  } catch {
    return 0;
  }
}

function stampReload(): void {
  try {
    const raw = sessionStorage.getItem(RELOAD_KEY);
    const arr: number[] = raw ? JSON.parse(raw) : [];
    const now = Date.now();
    const next = [...arr.filter((t) => now - t < LOOP_WINDOW_MS), now];
    sessionStorage.setItem(RELOAD_KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
}

interface State {
  hasError: boolean;
  error?: Error;
  looping: boolean;
  countdown: number;
}

export class AppErrorBoundary extends Component<{ children: ReactNode }, State> {
  private reloadTimer: number | undefined;
  private tickTimer: number | undefined;

  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = {
      hasError: false,
      looping: false,
      countdown: Math.round(AUTO_RELOAD_MS / 1000),
    };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    try {
      console.error("[HOD ErrorBoundary] caught:", error, info?.componentStack);
    } catch {
      /* ignore */
    }
    const looping = recentReloadCount() >= LOOP_MAX;
    this.setState({ looping });
    if (!looping) {
      this.tickTimer = window.setInterval(() => {
        this.setState((s) => ({ countdown: Math.max(0, s.countdown - 1) }));
      }, 1000);
      this.reloadTimer = window.setTimeout(() => this.reload(), AUTO_RELOAD_MS);
    }
  }

  componentWillUnmount() {
    if (this.reloadTimer) window.clearTimeout(this.reloadTimer);
    if (this.tickTimer) window.clearInterval(this.tickTimer);
  }

  reload = () => {
    if (this.reloadTimer) window.clearTimeout(this.reloadTimer);
    if (this.tickTimer) window.clearInterval(this.tickTimer);
    stampReload();
    try {
      window.location.reload();
    } catch {
      /* ignore */
    }
  };

  render() {
    if (!this.state.hasError) return this.props.children;
    const { error, looping, countdown } = this.state;
    return (
      <div
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 2147483647,
          background: "#FBF3D6",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 20,
          fontFamily:
            "ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif",
        }}
      >
        <div
          style={{
            width: "100%",
            maxWidth: 440,
            background: "#FFFFFF",
            border: "2px solid #000",
            borderRadius: 14,
            boxShadow: "4px 4px 0 rgba(0,0,0,.18)",
            padding: "24px 22px",
            textAlign: "center",
          }}
        >
          <div style={{ fontSize: 40, lineHeight: 1, marginBottom: 10 }}>⚠️</div>
          <div
            style={{
              fontSize: 21,
              fontWeight: 900,
              color: "#000",
              letterSpacing: 0.5,
            }}
          >
            SOMETHING GLITCHED
          </div>
          <div
            style={{
              fontSize: 14,
              fontWeight: 600,
              color: "#3D3D3D",
              marginTop: 8,
              lineHeight: 1.5,
            }}
          >
            {looping
              ? "The screen keeps hitting an error. Auto-reload is paused so it doesn't loop. Please tap RELOAD, and screenshot the message below for the developer."
              : `The screen hit an error. Your data is safe — it will reload automatically in ${countdown}s. You can also tap below.`}
          </div>

          <button
            type="button"
            onClick={this.reload}
            style={{
              marginTop: 18,
              width: "100%",
              padding: "15px 12px",
              borderRadius: 10,
              background: "#23A094",
              border: "2px solid #000",
              color: "#FFFFFF",
              fontSize: 16,
              fontWeight: 900,
              letterSpacing: 0.5,
              cursor: "pointer",
              textTransform: "uppercase",
            }}
          >
            ↻ Reload Now
          </button>

          {error?.message ? (
            <div
              style={{
                marginTop: 16,
                textAlign: "left",
                background: "#F4F4F0",
                border: "1px solid rgba(0,0,0,.2)",
                borderRadius: 8,
                padding: "10px 12px",
                fontFamily: "ui-monospace,SFMono-Regular,Menlo,monospace",
                fontSize: 11,
                color: "#000",
                wordBreak: "break-word",
                maxHeight: 120,
                overflow: "auto",
              }}
            >
              {String(error.message).slice(0, 300)}
            </div>
          ) : null}
        </div>
      </div>
    );
  }
}
