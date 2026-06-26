// Centered, branded modal helpers — replace window.prompt() and alert()
// so the POS never shows the ugly browser-native popups.
//
// Two exports:
//   centeredPinPrompt(reason)          → Promise<string|null>   (PIN entry)
//   centeredAlert(title, message, kind?) → Promise<void>        (info popup)
//
// Both render via a vanilla DOM overlay appended to <body>. No React tree
// changes, so callers can be sync or async and don't need to thread state.
// Brand colors: black #0C0816, gold #C8A645, ivory #F2EBD3.
//
// Fallback: if anything throws (e.g. SSR, no document), we fall back to the
// native window.prompt / alert so the POS never silently loses an interaction.

const GOLD = "#C8A645";
const BG = "#0C0816";
const IVORY = "#F2EBD3";

// 🎨 2026-06-02 (Khushi) — Door Mode opts into the Gumroad-brutalist look via a
// trailing `brutalist` arg. Other modes pass nothing → original dark-gold look.
const _BRUT = {
  surface: "#F4F4F0", white: "#FFFFFF", ink: "#000", muted: "#6B6B6B",
  pink: "#FF90E8", teal: "#23A094", error: "#FF5733",
  font: "ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif",
};

function _mountOverlay(brutalist = false): HTMLDivElement {
  const overlay = document.createElement("div");
  overlay.style.cssText = [
    "position:fixed", "inset:0",
    brutalist ? "background:rgba(0,0,0,.5)" : "background:rgba(0,0,0,.88)",
    brutalist ? "" : "backdrop-filter:blur(8px)", "z-index:99999",
    "display:flex", "align-items:center", "justify-content:center",
    "padding:16px",
    brutalist ? `font-family:${_BRUT.font}` : "font-family:-apple-system,Segoe UI,Roboto,sans-serif",
  ].filter(Boolean).join(";");
  document.body.appendChild(overlay);
  return overlay;
}

// 🆕 2026-06-24 (Khushi) — optional `validate` callback. When supplied, the
// modal verifies the entered PIN IN-PLACE: a wrong PIN shows "INCORRECT PIN"
// inside the prompt and keeps it open (no separate popup that can be missed or
// race the close); the promise only resolves the PIN once it's correct (or null
// on Cancel). Callers that omit it keep the old resolve-on-any-PIN behavior.
export function centeredPinPrompt(
  reason: string,
  brutalist = false,
  validate?: (pin: string) => boolean | Promise<boolean>,
): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      if (typeof document === "undefined") {
        resolve(window.prompt(`🔒 Manager PIN required\n\n${reason}\n\nEnter 4-digit PIN:`));
        return;
      }
      const overlay = _mountOverlay(brutalist);
      const box = document.createElement("div");
      box.style.cssText = brutalist
        ? [
            `background:${_BRUT.surface}`, `border:2px solid ${_BRUT.ink}`, "border-radius:8px",
            "padding:22px", "width:100%", "max-width:380px", "text-align:center",
          ].join(";")
        : [
            `background:${BG}`, `border:1.5px solid ${GOLD}`, "border-radius:18px",
            "padding:22px", "width:100%", "max-width:380px",
            "box-shadow:0 24px 48px rgba(0,0,0,.7)", "text-align:center",
          ].join(";");
      box.innerHTML = brutalist
        ? `
        <div style="font-size:42px;line-height:1;margin-bottom:6px">🔒</div>
        <div style="font-family:${_BRUT.font};font-size:20px;font-weight:900;color:${_BRUT.ink};margin-bottom:8px">MANAGER PIN REQUIRED</div>
        <div style="font-size:13px;color:${_BRUT.muted};margin-bottom:16px;line-height:1.4">${reason.replace(/</g, "&lt;")}</div>
        <input id="hod-pin-input" type="text" inputmode="numeric" pattern="[0-9]*" autocomplete="off" maxlength="6"
          name="hod-mgr-pin-code" data-lpignore="true" data-1p-ignore="" data-form-type="other"
          placeholder=""
          style="width:100%;padding:14px;border-radius:6px;background:${_BRUT.white};border:2px solid ${_BRUT.ink};color:${_BRUT.ink};font-size:22px;letter-spacing:8px;text-align:center;outline:none;box-sizing:border-box;font-weight:800;-webkit-text-security:disc;text-security:disc" />
        <div id="hod-pin-err" style="font-size:13px;color:${_BRUT.error};font-weight:700;margin-top:8px;min-height:18px"></div>
        <div style="display:flex;gap:8px;margin-top:12px">
          <button id="hod-pin-cancel" style="flex:1;padding:12px;border-radius:6px;background:${_BRUT.white};border:2px solid ${_BRUT.ink};color:${_BRUT.ink};font-size:14px;font-weight:800;cursor:pointer">CANCEL</button>
          <button id="hod-pin-ok" style="flex:1;padding:12px;border-radius:6px;background:${_BRUT.pink};border:2px solid ${_BRUT.ink};color:${_BRUT.ink};font-size:14px;font-weight:900;cursor:pointer">UNLOCK ➜</button>
        </div>
        <div style="font-size:11px;color:${_BRUT.muted};margin-top:10px">CANCEL leaves the action blocked.</div>
      `
        : `
        <div style="font-size:42px;line-height:1;margin-bottom:6px">🔒</div>
        <div style="font-family:'Playfair Display',serif;font-size:20px;font-weight:900;color:${GOLD};margin-bottom:8px">MANAGER PIN REQUIRED</div>
        <div style="font-size:13px;color:rgba(242,235,211,.78);margin-bottom:16px;line-height:1.4">${reason.replace(/</g, "&lt;")}</div>
        <input id="hod-pin-input" type="text" inputmode="numeric" pattern="[0-9]*" autocomplete="off" maxlength="6"
          name="hod-mgr-pin-code" data-lpignore="true" data-1p-ignore="" data-form-type="other"
          placeholder=""
          style="width:100%;padding:14px;border-radius:10px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);color:${IVORY};font-size:22px;letter-spacing:8px;text-align:center;outline:none;box-sizing:border-box;font-weight:800;-webkit-text-security:disc;text-security:disc" />
        <div id="hod-pin-err" style="font-size:13px;color:#EF4444;font-weight:700;margin-top:8px;min-height:18px"></div>
        <div style="display:flex;gap:8px;margin-top:12px">
          <button id="hod-pin-cancel" style="flex:1;padding:12px;border-radius:10px;background:transparent;border:1px solid rgba(255,255,255,.18);color:rgba(242,235,211,.7);font-size:14px;font-weight:800;cursor:pointer">CANCEL</button>
          <button id="hod-pin-ok" style="flex:1;padding:12px;border-radius:10px;background:${GOLD};border:none;color:${BG};font-size:14px;font-weight:900;cursor:pointer">UNLOCK ➜</button>
        </div>
        <div style="font-size:11px;color:rgba(242,235,211,.4);margin-top:10px">CANCEL leaves the action blocked.</div>
      `;
      overlay.appendChild(box);
      const input = box.querySelector("#hod-pin-input") as HTMLInputElement;
      const errEl = box.querySelector("#hod-pin-err") as HTMLDivElement;
      const ok = box.querySelector("#hod-pin-ok") as HTMLButtonElement;
      const cancel = box.querySelector("#hod-pin-cancel") as HTMLButtonElement;
      setTimeout(() => input.focus(), 50);

      const close = (val: string | null) => {
        try { document.body.removeChild(overlay); } catch {}
        resolve(val);
      };
      const submit = async () => {
        const v = (input.value || "").trim();
        if (v.length < 4) { errEl.textContent = "PIN must be at least 4 digits."; input.focus(); return; }
        if (validate) {
          ok.disabled = true;
          try {
            const valid = await validate(v);
            if (!valid) {
              ok.disabled = false;
              errEl.textContent = "INCORRECT PIN — try again.";
              input.value = "";
              input.focus();
              return;
            }
          } catch {
            ok.disabled = false;
            errEl.textContent = "Could not verify PIN. Try again.";
            input.focus();
            return;
          }
        }
        close(v);
      };
      ok.onclick = () => { void submit(); };
      cancel.onclick = () => close(null);
      overlay.addEventListener("click", (e) => { if (e.target === overlay) close(null); });
      input.addEventListener("keydown", (e: KeyboardEvent) => {
        if (e.key === "Enter") submit();
        else if (e.key === "Escape") close(null);
      });
    } catch (err) {
      // Fail-open: if our DOM modal can't render, never trap the captain.
      try { resolve(window.prompt(`🔒 Manager PIN required\n\n${reason}\n\nEnter 4-digit PIN:`)); }
      catch { resolve(null); }
    }
  });
}

export function centeredAlert(
  title: string,
  message: string,
  kind: "success" | "error" | "info" = "info",
  brutalist = false,
): Promise<void> {
  return new Promise((resolve) => {
    try {
      if (typeof document === "undefined") { alert(`${title}\n\n${message}`); resolve(); return; }
      const overlay = _mountOverlay(brutalist);
      const accent = brutalist
        ? (kind === "success" ? _BRUT.teal : kind === "error" ? _BRUT.error : _BRUT.pink)
        : (kind === "success" ? "#10B981" : kind === "error" ? "#EF4444" : GOLD);
      const icon   = kind === "success" ? "✅"     : kind === "error" ? "⚠"      : "ℹ";
      const box = document.createElement("div");
      box.style.cssText = brutalist
        ? [
            `background:${_BRUT.surface}`, `border:2px solid ${_BRUT.ink}`, "border-radius:8px",
            "padding:22px", "width:100%", "max-width:400px", "text-align:center",
          ].join(";")
        : [
            `background:${BG}`, `border:1.5px solid ${accent}`, "border-radius:18px",
            "padding:22px", "width:100%", "max-width:400px",
            "box-shadow:0 24px 48px rgba(0,0,0,.7)", "text-align:center",
          ].join(";");
      box.innerHTML = brutalist
        ? `
        <div style="font-size:54px;line-height:1;margin-bottom:6px">${icon}</div>
        <div style="font-family:${_BRUT.font};font-size:22px;font-weight:900;color:${_BRUT.ink};margin-bottom:10px">${title.replace(/</g, "&lt;")}</div>
        <div style="font-size:14px;color:${_BRUT.muted};margin-bottom:18px;line-height:1.5;white-space:pre-wrap">${message.replace(/</g, "&lt;")}</div>
        <button id="hod-alert-ok" style="width:100%;padding:14px;border-radius:6px;background:${accent};border:2px solid ${_BRUT.ink};color:${_BRUT.ink};font-size:15px;font-weight:900;cursor:pointer">OK</button>
      `
        : `
        <div style="font-size:54px;line-height:1;margin-bottom:6px">${icon}</div>
        <div style="font-family:'Playfair Display',serif;font-size:22px;font-weight:900;color:${accent};margin-bottom:10px">${title.replace(/</g, "&lt;")}</div>
        <div style="font-size:14px;color:rgba(242,235,211,.85);margin-bottom:18px;line-height:1.5;white-space:pre-wrap">${message.replace(/</g, "&lt;")}</div>
        <button id="hod-alert-ok" style="width:100%;padding:14px;border-radius:10px;background:${accent};border:none;color:${BG};font-size:15px;font-weight:900;cursor:pointer">OK</button>
      `;
      overlay.appendChild(box);
      const ok = box.querySelector("#hod-alert-ok") as HTMLButtonElement;
      const close = () => { try { document.body.removeChild(overlay); } catch {} resolve(); };
      ok.onclick = close;
      setTimeout(() => ok.focus(), 50);
      overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
      const onKey = (e: KeyboardEvent) => { if (e.key === "Enter" || e.key === "Escape") { document.removeEventListener("keydown", onKey); close(); } };
      document.addEventListener("keydown", onKey);
    } catch {
      try { alert(`${title}\n\n${message}`); } catch {}
      resolve();
    }
  });
}

// 🆕 2026-06-26 (Khushi) — a NON-DISMISSABLE "please wait" overlay. The settle
// flow makes two slow server calls (send approval code ~5-6s, verify code
// ~3-5s); during those waits nothing covered the screen so a captain could tap
// other buttons. This mounts a full-screen spinner + message that BLOCKS every
// tap (fixed inset:0, z 99999, no backdrop-close) and returns a closer fn the
// caller invokes when the await resolves. Fail-open: returns a no-op closer if
// the DOM isn't available.
export function centeredBusy(message: string, brutalist = false): () => void {
  try {
    if (typeof document === "undefined") return () => {};
    if (!document.getElementById("hod-busy-kf")) {
      const st = document.createElement("style");
      st.id = "hod-busy-kf";
      st.textContent = "@keyframes hod-busy-spin{to{transform:rotate(360deg)}}";
      document.head.appendChild(st);
    }
    const overlay = _mountOverlay(brutalist);
    const ring   = brutalist ? _BRUT.teal : GOLD;
    const track  = brutalist ? "rgba(0,0,0,.15)" : "rgba(242,235,211,.18)";
    const ink    = brutalist ? _BRUT.ink : IVORY;
    const box = document.createElement("div");
    box.style.cssText = brutalist
      ? [
          `background:${_BRUT.surface}`, `border:2px solid ${_BRUT.ink}`, "border-radius:8px",
          "padding:26px", "width:100%", "max-width:360px", "text-align:center",
        ].join(";")
      : [
          `background:${BG}`, `border:1.5px solid ${GOLD}`, "border-radius:18px",
          "padding:26px", "width:100%", "max-width:360px",
          "box-shadow:0 24px 48px rgba(0,0,0,.7)", "text-align:center",
        ].join(";");
    box.innerHTML = `
      <div style="width:46px;height:46px;margin:0 auto 16px;border-radius:50%;border:5px solid ${track};border-top-color:${ring};animation:hod-busy-spin .8s linear infinite"></div>
      <div style="font-family:${brutalist ? _BRUT.font : "'Playfair Display',serif"};font-size:16px;font-weight:900;color:${ink};line-height:1.5;white-space:pre-wrap">${message.replace(/</g, "&lt;")}</div>
    `;
    overlay.appendChild(box);
    // Deliberately NO backdrop-close — this is a forced wait, not a prompt.
    let closed = false;
    return () => { if (closed) return; closed = true; try { document.body.removeChild(overlay); } catch {} };
  } catch { return () => {}; }
}

// 🆕 2026-06-26 (Khushi) — a branded yes/no confirmation (replaces window.confirm
// in NEW flows). Resolves true on confirm, false on cancel / backdrop / Esc.
// Used for the aggregator-discount "are you sure?" reminder before settling.
export function centeredConfirm(
  title: string,
  message: string,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  brutalist = false,
): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      if (typeof document === "undefined") { resolve(window.confirm(`${title}\n\n${message}`)); return; }
      const overlay = _mountOverlay(brutalist);
      const accent = brutalist ? _BRUT.teal : GOLD;
      const box = document.createElement("div");
      box.style.cssText = brutalist
        ? [
            `background:${_BRUT.surface}`, `border:2px solid ${_BRUT.ink}`, "border-radius:8px",
            "padding:22px", "width:100%", "max-width:400px", "text-align:center",
          ].join(";")
        : [
            `background:${BG}`, `border:1.5px solid ${accent}`, "border-radius:18px",
            "padding:22px", "width:100%", "max-width:400px",
            "box-shadow:0 24px 48px rgba(0,0,0,.7)", "text-align:center",
          ].join(";");
      box.innerHTML = brutalist
        ? `
        <div style="font-size:48px;line-height:1;margin-bottom:6px">⚠️</div>
        <div style="font-family:${_BRUT.font};font-size:21px;font-weight:900;color:${_BRUT.ink};margin-bottom:10px">${title.replace(/</g, "&lt;")}</div>
        <div style="font-size:14px;color:${_BRUT.muted};margin-bottom:18px;line-height:1.5;white-space:pre-wrap">${message.replace(/</g, "&lt;")}</div>
        <div style="display:flex;gap:8px">
          <button id="hod-cf-cancel" style="flex:1;padding:13px;border-radius:6px;background:${_BRUT.white};border:2px solid ${_BRUT.ink};color:${_BRUT.ink};font-size:14px;font-weight:800;cursor:pointer">${cancelLabel.replace(/</g, "&lt;")}</button>
          <button id="hod-cf-ok" style="flex:1.4;padding:13px;border-radius:6px;background:${_BRUT.teal};border:2px solid ${_BRUT.ink};color:${_BRUT.ink};font-size:14px;font-weight:900;cursor:pointer">${confirmLabel.replace(/</g, "&lt;")}</button>
        </div>
      `
        : `
        <div style="font-size:48px;line-height:1;margin-bottom:6px">⚠</div>
        <div style="font-family:'Playfair Display',serif;font-size:21px;font-weight:900;color:${accent};margin-bottom:10px">${title.replace(/</g, "&lt;")}</div>
        <div style="font-size:14px;color:rgba(242,235,211,.85);margin-bottom:18px;line-height:1.5;white-space:pre-wrap">${message.replace(/</g, "&lt;")}</div>
        <div style="display:flex;gap:8px">
          <button id="hod-cf-cancel" style="flex:1;padding:13px;border-radius:10px;background:transparent;border:1px solid rgba(255,255,255,.18);color:rgba(242,235,211,.7);font-size:14px;font-weight:800;cursor:pointer">${cancelLabel.replace(/</g, "&lt;")}</button>
          <button id="hod-cf-ok" style="flex:1.4;padding:13px;border-radius:10px;background:${accent};border:none;color:${BG};font-size:14px;font-weight:900;cursor:pointer">${confirmLabel.replace(/</g, "&lt;")}</button>
        </div>
      `;
      overlay.appendChild(box);
      const ok = box.querySelector("#hod-cf-ok") as HTMLButtonElement;
      const cancel = box.querySelector("#hod-cf-cancel") as HTMLButtonElement;
      const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(false); };
      const close = (v: boolean) => {
        document.removeEventListener("keydown", onKey);
        try { document.body.removeChild(overlay); } catch {}
        resolve(v);
      };
      ok.onclick = () => close(true);
      cancel.onclick = () => close(false);
      setTimeout(() => ok.focus(), 50);
      overlay.addEventListener("click", (e) => { if (e.target === overlay) close(false); });
      document.addEventListener("keydown", onKey);
    } catch {
      try { resolve(window.confirm(`${title}\n\n${message}`)); } catch { resolve(false); }
    }
  });
}

// 🆕 2026-06-18 (Khushi) — APP-WIDE FIX: copying text from a field inside a
// hand-rolled modal used to close it. Those modals close on a backdrop click
// (`<div onClick={onClose}>`), but a text-selection drag that ends on the dim
// backdrop — or the native copy context-menu click — lands a `click` whose
// target IS the backdrop, firing onClose. This guard only closes when (a) the
// click is on the backdrop itself (not bubbled from content) AND (b) there is
// no active text selection AND (c) no selection was active within the last 400ms.
// Fail-CLOSED: when unsure, the modal stays open so no in-progress edit is lost.
//
// 🆕 v3.340 — iOS/Android copy regression fix: the browser clears
// window.getSelection() BEFORE firing the click on the context-menu dismiss,
// so the original check (getSelection().length > 0) arrived too late and the
// guard missed the copy action → modal closed → typed text lost.
// Fix: track the last timestamp a non-empty selection existed via a
// document-level `selectionchange` listener; refuse to close within 400ms.
let _lastSelectionMs = 0;
if (typeof document !== "undefined") {
  document.addEventListener("selectionchange", () => {
    try {
      const s = window.getSelection();
      if (s && s.toString().length > 0) _lastSelectionMs = Date.now();
    } catch { /* ignore */ }
  }, { passive: true });
}

export function closeOnBackdrop(onClose: () => void) {
  return (e: { target: EventTarget | null; currentTarget: EventTarget | null }) => {
    if (e.target !== e.currentTarget) return;
    // Guard 1: selection cleared after copy — was there a selection within 400ms?
    if (Date.now() - _lastSelectionMs < 400) return;
    // Guard 2: selection still active at click time
    try {
      const sel = typeof window !== "undefined" && window.getSelection ? window.getSelection() : null;
      if (sel && String(sel).length > 0) return;
    } catch {
      // Fail-CLOSED: if we cannot tell whether text is selected, keep the modal
      // open so an in-progress edit is never lost. User can tap Back / ✕ to close.
      return;
    }
    onClose();
  };
}
