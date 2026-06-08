import { useState } from "react";
import { useLocation } from "wouter";
import { useStaff } from "@/lib/staff-context";
import MenuEditor from "@/pages/MenuEditor";
import MenuCRM from "@/pages/MenuCRM";

// 🆕 2026-06-08 v3.239 (Khushi) — NEW "MENU" mode. The MENU EDITOR and MENU CRM
// tabs were MOVED out of Boss Mode into their own standalone mode so menu
// management has its own home-screen icon. Same two screens, same components —
// only the location changed. Entry is still gated behind the Boss PIN (the
// LoginPage tile uses authMode "pin", roles admin/manager) exactly like the
// tabs were when they lived under Boss Mode.
//
// 🆕 2026-06-08 v3.240 (Khushi) — FULL Gumroad light restyle (cream bg, bold 2px
// black borders, pink/orange accents, bold uppercase) so MENU matches Door &
// Captain Mode. Only styling changed — tabs, gating and components are identical.
type MenuTab = "menu-editor" | "menu-crm";

const INK = "#000";
const CREAM = "#F4F4F0";
const PINK = "#FF90E8";
const FONT = "'Space Grotesk',ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif";

export default function MenuMode() {
  const { currentStaff, hasRole, logout } = useStaff();
  const [, navigate] = useLocation();
  const [tab, setTab] = useState<MenuTab>("menu-editor");

  const TABS: Array<{ id: MenuTab; label: string }> = [
    { id: "menu-editor", label: "📋 MENU EDITOR" },
    { id: "menu-crm", label: "📋 MENU CRM" },
  ];

  // 🆕 v3.239 — ROLE GATE (mirrors AdminPage). The LoginPage tile already
  // requires the Boss PIN, but AuthGate only proves *someone* is logged in —
  // an already-logged-in bartender/captain could deep-link to /menu. Block any
  // non-admin/manager here, exactly as Boss Mode does for its own menu tabs.
  if (!hasRole("admin", "manager")) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4" style={{ background: CREAM, color: INK, fontFamily: FONT }}>
        <p style={{ fontWeight: 800, letterSpacing: 0.5, textTransform: "uppercase" }}>Access denied. Manager or Admin role required.</p>
        <button onClick={() => { logout(); navigate("/"); }} style={{ background: "#fff", border: "2px solid #000", borderRadius: 8, padding: "8px 16px", fontWeight: 900, fontSize: 13, letterSpacing: 0.5, color: INK, cursor: "pointer", textTransform: "uppercase" }}>← Modes</button>
      </div>
    );
  }

  return (
    <div className="min-h-screen" style={{ background: CREAM, color: INK, fontFamily: FONT }}>
      <header className="flex items-center justify-between" style={{ padding: "14px 18px", background: "#fff", borderBottom: "2px solid #000" }}>
        <div className="flex items-center gap-4">
          {/* Back returns to the mode picker (same convention as Boss Mode). */}
          <button onClick={() => { logout(); navigate("/"); }} style={{ background: "#fff", border: "2px solid #000", borderRadius: 8, padding: "6px 12px", fontWeight: 900, fontSize: 12, letterSpacing: 0.5, color: INK, cursor: "pointer", textTransform: "uppercase" }}>← Modes</button>
          <h1 style={{ fontSize: 22, fontWeight: 900, letterSpacing: 1, margin: 0 }}>📖 MENU</h1>
        </div>
        <div className="flex items-center gap-3">
          <span style={{ fontSize: 12, fontWeight: 700, color: "#3D3D3D" }}>{currentStaff?.name}</span>
          <button onClick={() => { logout(); navigate("/"); }} style={{ background: PINK, border: "2px solid #000", borderRadius: 8, padding: "6px 12px", fontWeight: 900, fontSize: 12, letterSpacing: 0.5, color: INK, cursor: "pointer", textTransform: "uppercase" }}>Logout</button>
        </div>
      </header>

      <div className="flex gap-2 flex-wrap items-center" style={{ padding: "14px 18px" }}>
        {TABS.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)}
            style={{ background: tab === t.id ? "#000" : "#fff", color: tab === t.id ? "#fff" : "#000", border: "2px solid #000", borderRadius: 10, padding: "10px 18px", fontWeight: 900, fontSize: 13, letterSpacing: 0.5, cursor: "pointer", textTransform: "uppercase" }}>
            {t.label}
          </button>
        ))}
      </div>

      <div style={{ padding: "0 18px 24px" }}>
        {tab === "menu-editor" && <MenuEditor currentStaff={currentStaff} />}
        {tab === "menu-crm" && <MenuCRM />}
      </div>
    </div>
  );
}
