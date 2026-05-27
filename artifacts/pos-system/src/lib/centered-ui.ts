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

function _mountOverlay(): HTMLDivElement {
  const overlay = document.createElement("div");
  overlay.style.cssText = [
    "position:fixed", "inset:0", "background:rgba(0,0,0,.88)",
    "backdrop-filter:blur(8px)", "z-index:99999",
    "display:flex", "align-items:center", "justify-content:center",
    "padding:16px", "font-family:-apple-system,Segoe UI,Roboto,sans-serif",
  ].join(";");
  document.body.appendChild(overlay);
  return overlay;
}

export function centeredPinPrompt(reason: string): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      if (typeof document === "undefined") {
        resolve(window.prompt(`🔒 Manager PIN required\n\n${reason}\n\nEnter 4-digit PIN:`));
        return;
      }
      const overlay = _mountOverlay();
      const box = document.createElement("div");
      box.style.cssText = [
        `background:${BG}`, `border:1.5px solid ${GOLD}`, "border-radius:18px",
        "padding:22px", "width:100%", "max-width:380px",
        "box-shadow:0 24px 48px rgba(0,0,0,.7)", "text-align:center",
      ].join(";");
      box.innerHTML = `
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
      const submit = () => {
        const v = (input.value || "").trim();
        if (v.length < 4) { errEl.textContent = "PIN must be at least 4 digits."; input.focus(); return; }
        close(v);
      };
      ok.onclick = submit;
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
): Promise<void> {
  return new Promise((resolve) => {
    try {
      if (typeof document === "undefined") { alert(`${title}\n\n${message}`); resolve(); return; }
      const overlay = _mountOverlay();
      const accent = kind === "success" ? "#10B981" : kind === "error" ? "#EF4444" : GOLD;
      const icon   = kind === "success" ? "✅"     : kind === "error" ? "⚠"      : "ℹ";
      const box = document.createElement("div");
      box.style.cssText = [
        `background:${BG}`, `border:1.5px solid ${accent}`, "border-radius:18px",
        "padding:22px", "width:100%", "max-width:400px",
        "box-shadow:0 24px 48px rgba(0,0,0,.7)", "text-align:center",
      ].join(";");
      box.innerHTML = `
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
