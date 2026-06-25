// 🆕 2026-06-15 v3.300 (Khushi) — Gumroad-style UI restyle of the admin suite
// (AdminPage, Reports, LiveMonitor, AuditPage, EventsAdmin, KnowledgeBaseAdmin,
// DigitorySync). Inline-style only; all handlers/logic/data unchanged.
import { useState, useEffect, useRef } from "react";
import { useLocation } from "wouter";
import { useStaff, DOOR_STAFF_SEED } from "@/lib/staff-context";
import { HOD_MENU_ITEMS, HOD_CATEGORY_LABELS } from "@/lib/hod-menu";
import type { StaffMember, MenuOverride, StaffRole } from "@/lib/types";
import {
  subscribeToMenuOverrides, setMenuOverride, menuOverrideKey,
  upsertStaffMember, updateStaffMember, deleteStaffMember,
  logAudit,
  subscribeToEdcDefaultVendor, setEdcDefaultVendor, type EdcDefaultVendor,
} from "@/lib/firestore";
import { FEATURES } from "@/lib/feature-flags";
import { centeredPinPrompt } from "@/lib/centered-ui";
import { getTabletFloor, setTabletFloor, type TabletFloor, sha256,
  listSuspendedCaptainsToday, unlockCaptainVoids, type CaptainVoidStats,
  CaptainVoidStatsRulesError,
  subscribeToDoorPricingSettings, updateDoorPricingSettings, type DoorPricingSettings,
  subscribeToTablePricingSettings, updateTablePricingSettings, type TablePricingSettings, type TablePricingTierKey, TABLE_PRICING_OVERRIDE_TABLES,
} from "@/lib/firestore-hod";
import { formatINR } from "@/lib/utils-pos";
import { LiveMonitor } from "./LiveMonitor";
import Reports from "./Reports";
import AgentsReport from "./AgentsReport";
import LiveReports from "./LiveReports";
import EventsAdmin from "./EventsAdmin";
import KnowledgeBaseAdmin from "./KnowledgeBaseAdmin";
import DigitorySync from "./DigitorySync";
import AuditPage from "./AuditPage";

const MANAGER_HASH_ADMIN = "2926a2731f4b312c08982cacf8061eb14bf65c1a87cc5d70e864e079c6220731";
async function requireManagerPinAdmin(reason: string): Promise<boolean> {
  const pin = window.prompt(`🔒 MANAGER PIN REQUIRED\n\n${reason}\n\nENTER 4-DIGIT MANAGER PIN:`);
  if (!pin) return false;
  const h = await sha256(pin.trim());
  if (h !== MANAGER_HASH_ADMIN) { alert("❌ WRONG MANAGER PIN."); return false; }
  return true;
}

const _minToHHMM = (m: number): string => {
  const mm = Math.max(0, Math.min(1439, Math.round(m || 0)));
  const h = Math.floor(mm / 60), r = mm % 60;
  return String(h).padStart(2, "0") + ":" + String(r).padStart(2, "0");
};
const _hhmmToMin = (s: string): number => {
  const m = /^(\d{1,2}):(\d{2})$/.exec((s || "").trim());
  if (!m) return NaN;
  const h = Number(m[1]), r = Number(m[2]);
  if (h < 0 || h > 23 || r < 0 || r > 59) return NaN;
  return h * 60 + r;
};
const _fmt12 = (s: string): string => {
  const min = _hhmmToMin(s);
  if (!Number.isFinite(min)) return s;
  const h = Math.floor(min / 60), r = min % 60;
  const ap = h >= 12 ? "PM" : "AM";
  const h12 = ((h + 11) % 12) + 1;
  return h12 + (r ? ":" + String(r).padStart(2, "0") : "") + " " + ap;
};
const TP_TIERS: { key: TablePricingTierKey; label: string; hint: string }[] = [
  { key: "groundPremium", label: "🎧 Ground Premium", hint: "C1–C4" },
  { key: "groundVvip", label: "👑 Ground VVIP", hint: "VIP1 / VIP2" },
  { key: "dining", label: "🍽 Dining", hint: "" },
  { key: "rooftop", label: "🌳 Rooftop", hint: "" },
];

// Gumroad-style hard shadow — solid offset, no blur, black.
const SHADOW_LG = "4px 4px 0px #000";
const SHADOW_MD = "3px 3px 0px #000";
const SHADOW_SM = "2px 2px 0px #000";

export default function AdminPage() {
  const { currentStaff, allStaff, hasRole, logout } = useStaff();
  const [, navigate] = useLocation();
  const [tab, setTab] = useState<"monitor" | "reports" | "live-reports" | "agents" | "audit" | "events" | "menu" | "bot-knowledge" | "staff" | "tablet" | "locks" | "settings" | "door-pricing" | "table-pricing" | "digitory-sync">("monitor");
  const [doorPricing, setDoorPricing] = useState<DoorPricingSettings>({ priceOverrideEnabled: false });
  const [doorPricingSaving, setDoorPricingSaving] = useState(false);
  const [tablePricing, setTablePricing] = useState<TablePricingSettings>({
    enabled: true,
    groundPremium: { price: 2500, startMin: 1260 },
    groundVvip: { price: 2500, startMin: 1260 },
    dining: { price: 2500, startMin: 1260 },
    rooftop: { price: 2500, startMin: 1260 },
  });
  const [tablePricingDraft, setTablePricingDraft] = useState<Record<TablePricingTierKey, { price: string; start: string }>>({
    groundPremium: { price: "2500", start: "21:00" },
    groundVvip: { price: "2500", start: "21:00" },
    dining: { price: "2500", start: "21:00" },
    rooftop: { price: "2500", start: "21:00" },
  });
  const [tableOverridesDraft, setTableOverridesDraft] = useState<Record<string, string>>(
    () => Object.fromEntries(TABLE_PRICING_OVERRIDE_TABLES.map((t) => [t.key, ""]))
  );
  const [tablePricingSaving, setTablePricingSaving] = useState(false);
  const [tablePricingMsg, setTablePricingMsg] = useState("");
  const tablePricingSeededRef = useRef(false);
  const [tabletFloor, setTabletFloorState] = useState<TabletFloor | null>(getTabletFloor());
  const [menuOverrides, setMenuOverridesState] = useState<Record<string, MenuOverride>>({});
  const [menuSearch, setMenuSearch] = useState("");
  const [newStaff, setNewStaff] = useState<{ name: string; phone: string; empId: string; pin: string; role: StaffRole; access: StaffRole[] }>({ name: "", phone: "", empId: "", pin: "", role: "captain", access: [] });
  const [editStaff, setEditStaff] = useState<StaffMember | null>(null);
  // 🆕 2026-06-25 (Khushi) — VIEW STAFF PIN. The Edit modal shows the staff's
  // current PIN masked; tapping 👁 View asks for the OWNER PIN before revealing.
  // revealedPin: null = hidden (masked), string = shown. Reset whenever a
  // different staff row is opened (or the modal closes → editStaff null).
  const [revealedPin, setRevealedPin] = useState<string | null>(null);
  useEffect(() => { setRevealedPin(null); }, [editStaff?.id]);
  const [staffMsg, setStaffMsg] = useState("");
  const [edcDefaultVendor, setEdcDefaultVendorState] = useState<EdcDefaultVendor | null>(null);
  const [edcSaving, setEdcSaving] = useState(false);
  const [edcSaveMsg, setEdcSaveMsg] = useState("");

  useEffect(() => {
    const unsubs = [
      subscribeToMenuOverrides(setMenuOverridesState),
      subscribeToEdcDefaultVendor(setEdcDefaultVendorState),
      subscribeToDoorPricingSettings(setDoorPricing),
      subscribeToTablePricingSettings((s) => {
        setTablePricing(s);
        if (!tablePricingSeededRef.current) {
          tablePricingSeededRef.current = true;
          setTablePricingDraft({
            groundPremium: { price: String(s.groundPremium.price), start: _minToHHMM(s.groundPremium.startMin) },
            groundVvip: { price: String(s.groundVvip.price), start: _minToHHMM(s.groundVvip.startMin) },
            dining: { price: String(s.dining.price), start: _minToHHMM(s.dining.startMin) },
            rooftop: { price: String(s.rooftop.price), start: _minToHHMM(s.rooftop.startMin) },
          });
          const ov = s.tableOverrides || {};
          setTableOverridesDraft(
            Object.fromEntries(TABLE_PRICING_OVERRIDE_TABLES.map((t) => {
              const v = (ov as any)[t.key];
              return [t.key, typeof v === "number" && v > 0 ? String(v) : ""];
            }))
          );
        }
      }),
    ];
    return () => unsubs.forEach(u => u());
  }, []);

  const handleEdcVendorChange = async (vendor: EdcDefaultVendor) => {
    if (vendor === edcDefaultVendor) return;
    setEdcSaving(true); setEdcSaveMsg("");
    try {
      await setEdcDefaultVendor(vendor, currentStaff?.name || "admin");
      if (currentStaff) {
        await logAudit({
          action: "edc_default_vendor_changed",
          staffId: currentStaff.id || "", staffName: currentStaff.name, staffRole: currentStaff.role,
          details: { from: edcDefaultVendor || "(unset)", to: vendor },
        });
      }
      setEdcSaveMsg(`✅ Default card machine set to ${vendor === "razorpay" ? "Razorpay POS" : "Pine Labs"}.`);
    } catch (e: any) {
      setEdcSaveMsg(`❌ Save failed: ${e?.message || e}`);
    }
    setEdcSaving(false);
  };

  if (!hasRole("admin", "manager")) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: "#F4F4F0" }}>
        <p style={{ fontWeight: 700, color: "#000" }}>Access denied. Manager or Admin role required.</p>
      </div>
    );
  }

  const filteredMenu = menuSearch
    ? HOD_MENU_ITEMS.filter(i => i.name.toLowerCase().includes(menuSearch.toLowerCase()) || (HOD_CATEGORY_LABELS[i.category] || "").toLowerCase().includes(menuSearch.toLowerCase()))
    : HOD_MENU_ITEMS;

  const toggleOutOfStock = async (itemName: string) => {
    const key = menuOverrideKey(itemName);
    const current = menuOverrides[key];
    const goingOOS = !current?.outOfStock;
    if (!(await requireManagerPinAdmin(`${goingOOS ? "MARK OUT OF STOCK" : "MARK BACK IN STOCK"}: ${itemName}`))) return;
    await setMenuOverride(itemName, { outOfStock: goingOOS, updatedBy: currentStaff?.name || "admin" });
    if (currentStaff) {
      await logAudit({
        action: goingOOS ? "menu_out_of_stock" : "menu_back_in_stock",
        staffId: currentStaff.id || "", staffName: currentStaff.name, staffRole: currentStaff.role,
        details: { menuItemKey: key, itemName },
      });
    }
  };

  const setItemDiscount = async (itemName: string, basePrice: number) => {
    const key = menuOverrideKey(itemName);
    const current = menuOverrides[key];
    const existingPct = current?.discountPercent || 0;
    const existingAmt = current?.discountAmount || 0;
    const existingStr = existingPct ? `${existingPct}%` : existingAmt ? `₹${existingAmt}` : "NONE";
    const input = window.prompt(
      `💰 SET DISCOUNT for ${itemName}\nCurrent price: ₹${basePrice}\nCurrent discount: ${existingStr}\n\n` +
      `Enter discount as either:\n  • A percent like "10%" (max 50%)\n  • A flat rupee amount like "50" (max ₹${Math.floor(basePrice * 0.5)})\n  • Empty / "0" / "clear" to REMOVE the discount.`,
      existingPct ? `${existingPct}%` : existingAmt ? `${existingAmt}` : ""
    );
    if (input === null) return;
    const trimmed = input.trim().toLowerCase();
    let discountPercent: number | undefined;
    let discountAmount: number | undefined;
    if (trimmed === "" || trimmed === "0" || trimmed === "clear") {
      // Clear discount.
    } else if (trimmed.endsWith("%")) {
      const n = parseFloat(trimmed.slice(0, -1));
      if (!isFinite(n) || n <= 0) { alert("❌ INVALID PERCENT."); return; }
      if (n > 50) { alert("❌ DISCOUNT % CAPPED AT 50%."); return; }
      discountPercent = Math.round(n * 100) / 100;
    } else {
      const n = parseFloat(trimmed);
      if (!isFinite(n) || n <= 0) { alert("❌ INVALID AMOUNT."); return; }
      if (n >= basePrice) { alert("❌ DISCOUNT MUST BE LESS THAN ITEM PRICE."); return; }
      if (n > basePrice * 0.5) { alert(`❌ MAX DISCOUNT IS ₹${Math.floor(basePrice * 0.5)} (50% OF PRICE).`); return; }
      discountAmount = Math.round(n);
    }
    const reason = window.prompt(`📝 REASON FOR THIS DISCOUNT?\n(E.g. SLOW MOVING, FESTIVAL, NEAR EXPIRY, MGMT CALL)`, current?.discountReason || "") || "";
    if (!(await requireManagerPinAdmin(
      `${discountPercent || discountAmount ? "SET" : "CLEAR"} DISCOUNT on ${itemName}` +
      (discountPercent ? ` (${discountPercent}% OFF)` : discountAmount ? ` (₹${discountAmount} OFF)` : "")
    ))) return;
    await setMenuOverride(itemName, {
      outOfStock: current?.outOfStock || false,
      discountPercent: discountPercent ?? 0,
      discountAmount: discountAmount ?? 0,
      discountReason: reason.trim() || "",
      updatedBy: currentStaff?.name || "admin",
    });
    if (currentStaff) {
      await logAudit({
        action: "menu_discount_set",
        staffId: currentStaff.id || "", staffName: currentStaff.name, staffRole: currentStaff.role,
        details: { menuItemKey: key, itemName, discountPercent, discountAmount, reason: reason.trim() },
      });
    }
  };

  const ROLE_CHOICES: { value: StaffRole; label: string }[] = [
    { value: "captain",   label: "CAPTAIN" },
    { value: "hostess",   label: "HOSTESS / DOOR" },
    { value: "bartender", label: "BAR / CASHIER" },
    { value: "manager",   label: "MANAGER" },
    { value: "chef",      label: "KITCHEN / KDS" },
    { value: "admin",     label: "OWNERS" },
  ];
  const ACCESS_MODES: { role: StaffRole; label: string; ownerOnly?: boolean }[] = [
    { role: "bartender", label: "Bar / Cashier" },
    { role: "captain",   label: "Captain" },
    { role: "hostess",   label: "Door" },
    { role: "chef",      label: "KDS" },
    { role: "manager",   label: "Manager", ownerOnly: true },
    { role: "admin",     label: "Boss / Owner", ownerOnly: true },
  ];
  const roleLabel = (r: StaffRole): string => ROLE_CHOICES.find((c) => c.value === r)?.label || r;
  const isElevatedRole = (r: StaffRole): boolean => r === "admin" || r === "manager";
  const isEffectivelyElevated = (s: StaffMember): boolean =>
    isElevatedRole(s.role) || (s.roles || []).some(isElevatedRole);
  const roleChoices = hasRole("admin") ? ROLE_CHOICES : ROLE_CHOICES.filter((c) => !isElevatedRole(c.value));
  const buildRoles = (role: StaffRole, access: StaffRole[]): StaffRole[] =>
    Array.from(new Set<StaffRole>([role, ...access]));
  const inpStyle = { background: "#fff", border: "2px solid #000", color: "#000" };

  const renderAccess = (
    primary: StaffRole,
    access: StaffRole[],
    onToggle: (r: StaffRole) => void,
    onAll: (on: boolean) => void,
    onDemotePrimary?: () => void,
  ) => {
    const ownerAllowed = hasRole("admin");
    const modes = ACCESS_MODES.filter((m) => !m.ownerOnly || ownerAllowed);
    const allOn = modes.every((m) => m.role === primary || access.includes(m.role));
    const primaryIsElevated = isElevatedRole(primary) && !!onDemotePrimary;
    return (
      <div className="mt-3">
        <div className="flex items-center justify-between mb-1">
          <span className="text-[11px] tracking-wide font-bold uppercase" style={{ color: "#555" }}>ACCESS LEVEL — modes this person can enter</span>
          <button type="button" onClick={() => onAll(!allOn)} className="text-[11px] px-2 py-0.5 font-bold"
            style={{ background: allOn ? "#F2C744" : "#F4F4F0", color: "#000", border: "2px solid #000", boxShadow: SHADOW_SM }}>
            {allOn ? "ALL ACCESS ✓" : "ALL ACCESS"}
          </button>
        </div>
        <div className="flex gap-1.5 flex-wrap">
          {modes.map((m) => {
            const isPrimary = m.role === primary;
            const on = isPrimary || access.includes(m.role);
            // 🆕 2026-06-25 (Khushi) — a person's ELEVATED main role (Boss/Owner
            // or Manager) used to be a LOCKED chip you couldn't untick, which
            // looked broken ("can't uncheck boss access"). Now tapping it DEMOTES
            // the person to Captain (clears the elevated role). Non-elevated main
            // roles (e.g. Captain) stay locked — you change those via the Role
            // dropdown (a person must always have one base role).
            const demotable = isPrimary && primaryIsElevated;
            const locked = isPrimary && !demotable;
            return (
              <button type="button" key={m.role} disabled={locked}
                title={demotable ? "Tap to remove this access (demotes to Captain)" : undefined}
                onClick={() => { if (demotable) onDemotePrimary?.(); else if (!isPrimary) onToggle(m.role); }}
                className="text-[11px] px-2.5 py-1 font-semibold"
                style={{
                  background: on ? "#E8FFF5" : "#F4F4F0",
                  color: on ? "#23A094" : "#555",
                  border: `2px solid ${on ? "#23A094" : "#ccc"}`,
                  cursor: locked ? "default" : "pointer",
                }}>
                {on ? "✓ " : ""}{m.label}{demotable ? " ✕ TAP TO REMOVE" : isPrimary ? " (role)" : ""}
              </button>
            );
          })}
        </div>
        {primaryIsElevated && (
          <div className="text-[10px] font-semibold mt-1.5" style={{ color: "#B45309" }}>
            ⓘ {roleLabel(primary)} is this person's MAIN role. Tap the green “{ACCESS_MODES.find(m => m.role === primary)?.label}” chip above (or change the Role dropdown) to remove it — they'll become a Captain.
          </div>
        )}
      </div>
    );
  };

  const handleAddStaff = async () => {
    setStaffMsg("");
    const name = newStaff.name.trim();
    const empId = newStaff.empId.trim().toUpperCase();
    const phone = newStaff.phone.trim();
    if (!name) { setStaffMsg("❌ ENTER NAME"); return; }
    if (!empId) { setStaffMsg("❌ ENTER EMPLOYEE ID"); return; }
    if (newStaff.pin.length !== 5) { setStaffMsg("❌ PIN MUST BE 5 DIGITS"); return; }
    const roles = buildRoles(newStaff.role, newStaff.access);
    if (!hasRole("admin") && (isElevatedRole(newStaff.role) || roles.some(isElevatedRole))) {
      setStaffMsg("❌ ONLY OWNERS CAN ASSIGN MANAGER / OWNER ACCESS"); return;
    }
    try {
      const res = await upsertStaffMember(empId, { name, phone, pin: newStaff.pin, role: newStaff.role, roles, active: true });
      if (res === "existed") { setStaffMsg(`❌ EMPLOYEE ID ${empId} ALREADY EXISTS — USE EDIT`); return; }
      if (currentStaff) {
        try {
          await logAudit({
            action: "staff_added",
            staffId: currentStaff.id || "", staffName: currentStaff.name, staffRole: currentStaff.role,
            details: { newId: empId, newName: name, role: newStaff.role, roles },
          });
        } catch (e) { console.warn("audit log failed (non-fatal)", e); }
      }
      setNewStaff({ name: "", phone: "", empId: "", pin: "", role: "captain", access: [] });
      setStaffMsg(`✅ ADDED ${name} (${empId})`);
    } catch (e: any) {
      setStaffMsg(`❌ FAILED: ${e?.message || e}`);
    }
  };

  const handleSaveEdit = async () => {
    if (!editStaff || !editStaff.id) return;
    setStaffMsg("");
    const name = editStaff.name.trim();
    if (!name) { setStaffMsg("❌ ENTER NAME"); return; }
    const newPin = (editStaff.pin || "").trim();
    if (newPin && newPin.length !== 5) { setStaffMsg("❌ PIN MUST BE 5 DIGITS (OR LEAVE BLANK TO KEEP)"); return; }
    const role = editStaff.role;
    const roles = buildRoles(role, editStaff.roles || []);
    if (!hasRole("admin") && (isElevatedRole(role) || roles.some(isElevatedRole))) {
      setStaffMsg("❌ ONLY OWNERS CAN ASSIGN MANAGER / OWNER ACCESS"); return;
    }
    const patch: Partial<StaffMember> = { name, phone: editStaff.phone || "", role, roles, canSettle: !!editStaff.canSettle };
    if (newPin) patch.pin = newPin;
    try {
      await updateStaffMember(editStaff.id, patch);
      if (currentStaff) {
        try {
          await logAudit({
            action: "staff_updated",
            staffId: currentStaff.id || "", staffName: currentStaff.name, staffRole: currentStaff.role,
            details: { editedId: editStaff.id, editedName: name, role, roles, pinChanged: !!newPin },
          });
        } catch (e) { console.warn("audit log failed (non-fatal)", e); }
      }
      setStaffMsg(`✅ UPDATED ${name}`);
      setEditStaff(null);
    } catch (e: any) {
      setStaffMsg(`❌ FAILED: ${e?.message || e}`);
    }
  };

  return (
    <div className="min-h-screen" style={{ background: "#F4F4F0", color: "#000", fontFamily: "ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif" }}>
      <header className="flex items-center justify-between px-4 py-3" style={{ borderBottom: "2px solid #000", background: "#F4F4F0" }}>
        <div className="flex items-center gap-4">
          <button onClick={logout} className="text-sm font-bold" style={{ color: "#000" }}>← Modes</button>
          <h1 className="text-lg font-black tracking-tight uppercase" style={{ color: "#000" }}>👑 BOSS MODE</h1>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs font-semibold" style={{ color: "#555" }}>{currentStaff?.name}</span>
          <button onClick={logout} className="text-xs px-3 py-1 font-bold"
            style={{ background: "#fff", color: "#000", border: "2px solid #000", boxShadow: SHADOW_SM }}>
            Logout
          </button>
        </div>
      </header>

      {/* Tab bar — grouped by purpose */}
      <div className="flex gap-1.5 px-4 py-3 flex-wrap items-center" style={{ borderBottom: "2px solid #000", background: "#F4F4F0" }}>
        {(() => {
          const groups: Array<Array<{ id: typeof tab; label: string }>> = [
            [
              { id: "monitor",      label: "🔴 Live Monitor" },
              { id: "reports",      label: "📋 Reports" },
              { id: "live-reports", label: "📊 Live Reports" },
              { id: "agents",       label: "👥 Agents" },
              { id: "audit",        label: "🛡 Audit" },
            ],
            [
              { id: "events",       label: "🎟 Events" },
              { id: "menu",         label: "OOS / Discount" },
              { id: "bot-knowledge",label: "🧠 Bot Knowledge" },
            ],
            [
              { id: "staff",        label: "Staff" },
              { id: "locks",        label: "🔓 Locks" },
            ],
            [
              { id: "door-pricing", label: "💰 Door Pricing" },
              { id: "table-pricing",label: "🎟️ Table Cover Pricing" },
              { id: "tablet",       label: "🖨 This Tablet" },
              { id: "settings",     label: "⚙️ Settings" },
            ],
            [
              { id: "digitory-sync",label: "🔗 Digitory Sync" },
            ],
          ];
          return groups.flatMap((grp, gi) => [
            ...grp.map((t) => (
              <button key={t.id} onClick={() => setTab(t.id)}
                className="px-3 py-1.5 text-sm font-bold transition-colors"
                style={{
                  background: tab === t.id ? "#FF90E8" : "#fff",
                  color: "#000",
                  border: "2px solid #000",
                  boxShadow: tab === t.id ? SHADOW_MD : SHADOW_SM,
                  transform: tab === t.id ? "translate(-1px, -1px)" : "none",
                }}>
                {t.label}
              </button>
            )),
            gi < groups.length - 1
              ? <div key={`div-${gi}`} className="mx-0.5 h-6 w-0.5" style={{ background: "#000" }} />
              : null,
          ]);
        })()}
      </div>

      <div className="p-4">
        {tab === "monitor"      && <LiveMonitor />}
        {tab === "reports"      && <Reports embedded />}
        {tab === "live-reports" && <LiveReports />}
        {tab === "agents"       && <AgentsReport />}
        {tab === "audit"        && <AuditPage embedded />}
        {tab === "events"       && <EventsAdmin />}
        {tab === "locks"        && <CaptainLocksTab adminName={currentStaff?.name || "admin"} />}
        {tab === "bot-knowledge"&& <KnowledgeBaseAdmin />}
        {tab === "digitory-sync"&& <DigitorySync currentStaff={currentStaff} />}

        {tab === "menu" && (
          <div>
            <input
              type="text" placeholder="Search menu items..."
              value={menuSearch} onChange={(e) => setMenuSearch(e.target.value)}
              className="w-full px-4 py-2 text-sm mb-3 font-medium"
              style={{ background: "#fff", border: "2px solid #000", color: "#000" }}
            />
            <div className="text-xs mb-2 font-semibold" style={{ color: "#555" }}>
              💡 OOS + DISCOUNT CHANGES SYNC LIVE TO CAPTAIN, BAR &amp; CUSTOMER WALLET (HODCLUB.IN). MANAGER PIN REQUIRED.
              <br />💰 BULK DISCOUNT (happy-hour) HAS MOVED → MENU EDITOR PAGE.
            </div>
            <div className="space-y-1.5 max-h-[70vh] overflow-y-auto">
              {filteredMenu.map((item) => {
                const ov = menuOverrides[menuOverrideKey(item.name)];
                const isOOS = !!ov?.outOfStock;
                const dPct = ov?.discountPercent || 0;
                const dAmt = ov?.discountAmount || 0;
                const hasDiscount = dPct > 0 || dAmt > 0;
                const effPrice = hasDiscount
                  ? Math.max(0, Math.round((item.price - (dPct ? item.price * dPct / 100 : dAmt)) * 100) / 100)
                  : item.price;
                return (
                  <div key={item.id} className="flex items-center justify-between gap-2 px-3 py-2"
                    style={{ background: "#fff", border: "2px solid #000", opacity: isOOS ? 0.5 : 1 }}>
                    <div className="flex-1 min-w-0">
                      <span className="text-sm font-semibold">{item.name}</span>
                      <span className="text-xs ml-2" style={{ color: "#666" }}>
                        {HOD_CATEGORY_LABELS[item.category] || item.category} ·{" "}
                        {hasDiscount ? (
                          <>
                            <span style={{ textDecoration: "line-through", color: "#aaa" }}>{formatINR(item.price)}</span>
                            {" → "}
                            <span style={{ color: "#23A094", fontWeight: 700 }}>{formatINR(effPrice)}</span>
                            <span style={{ color: "#23A094", marginLeft: 6 }}>
                              ({dPct ? `${dPct}% OFF` : `₹${dAmt} OFF`})
                            </span>
                          </>
                        ) : (
                          formatINR(item.price)
                        )}
                      </span>
                      {item.isVeg !== undefined && (
                        <span className="ml-2 text-xs font-bold" style={{ color: item.isVeg ? "#23A094" : "#FF5733" }}>
                          {item.isVeg ? "●VEG" : "●NV"}
                        </span>
                      )}
                      {ov?.discountReason && (
                        <div className="text-xs mt-0.5 font-medium" style={{ color: "#777" }}>📝 {ov.discountReason}</div>
                      )}
                    </div>
                    <button onClick={() => setItemDiscount(item.name, item.price)} className="px-3 py-1 text-xs font-bold"
                      style={{
                        background: hasDiscount ? "#E8FFF5" : "#FFFBEB",
                        border: `2px solid ${hasDiscount ? "#23A094" : "#F2C744"}`,
                        color: hasDiscount ? "#23A094" : "#000",
                        whiteSpace: "nowrap",
                        boxShadow: SHADOW_SM,
                      }}>
                      💰 {hasDiscount ? "EDIT" : "DISCOUNT"}
                    </button>
                    <button onClick={() => toggleOutOfStock(item.name)} className="px-3 py-1 text-xs font-bold"
                      style={{
                        background: isOOS ? "#23A094" : "#FF5733",
                        color: "#fff",
                        border: `2px solid ${isOOS ? "#23A094" : "#FF5733"}`,
                        whiteSpace: "nowrap",
                        boxShadow: SHADOW_SM,
                      }}>
                      {isOOS ? "BACK IN STOCK" : "OUT OF STOCK"}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {tab === "staff" && (
          <div>
            {hasRole("admin") && (
              <div className="mb-4 p-4" style={{ background: "#fff", border: "2px dashed #F2C744" }}>
                <h3 className="text-sm font-black uppercase mb-2">🚪 Door-Access Staff (8 people)</h3>
                <div className="text-xs mb-2 font-medium" style={{ color: "#444" }}>
                  One-click seed: 2 Admins + 2 GMs + HR + Store + 2 Hostesses. Default PIN = <b>100 + last 3 of Emp ID</b> (e.g. HOD-129 → 100129).
                </div>
                <div className="text-xs mb-3 p-2" style={{ background: "#FFFBEB", color: "#856404", border: "2px solid #F2C744" }}>
                  ⚠ <b>HEADS-UP:</b> GMs / HR / Store get role = <b>manager</b>. Hostesses get <b>hostess</b>. Admins get <b>admin</b> (full /admin).
                </div>
                <button
                  onClick={async () => {
                    if (!confirm("Seed 8 door-access staff to Firestore?\n\n• Safe to click multiple times (skips existing).\n• Default PIN = 100+last3 of Emp ID.\n• PROCEED?")) return;
                    let created = 0, existed = 0;
                    const failures: string[] = [];
                    for (const s of DOOR_STAFF_SEED) {
                      const { id, ...rest } = s;
                      try {
                        const result = await upsertStaffMember(id!, rest);
                        if (result === "created") {
                          created++;
                          if (currentStaff) {
                            try {
                              await logAudit({
                                action: "door_staff_seeded",
                                staffId: currentStaff.id || "", staffName: currentStaff.name, staffRole: currentStaff.role,
                                details: { seededId: id, seededName: s.name, seededRole: s.role },
                              });
                            } catch (auditErr) { console.warn("audit log failed (non-fatal)", auditErr); }
                          }
                        } else { existed++; }
                      } catch (e: any) {
                        console.error("Seed failed for", s.name, e);
                        failures.push(`${s.name}: ${e?.message || e}`);
                      }
                    }
                    const failPart = failures.length
                      ? `\n\n❌ FAILED (${failures.length}):\n${failures.join("\n")}\n\n→ FALLBACK: open Add Staff above and add the failed ones manually.`
                      : "";
                    alert(`${failures.length ? "⚠ PARTIAL" : "✅ DONE"}\n\nNewly added: ${created}\nAlready existed (skipped): ${existed}${failPart}`);
                  }}
                  className="px-4 py-2 text-sm font-black uppercase"
                  style={{ background: "#F2C744", color: "#000", border: "2px solid #000", boxShadow: SHADOW_LG }}>
                  🚪 SEED 8 DOOR STAFF NOW
                </button>
              </div>
            )}

            <div className="mb-4 p-4" style={{ background: "#fff", border: "2px solid #000" }}>
              <h3 className="text-sm font-black uppercase mb-3">Add Staff</h3>
              <div className="flex gap-2 flex-wrap">
                <input placeholder="Name" value={newStaff.name} onChange={(e) => setNewStaff(s => ({...s, name: e.target.value}))}
                  className="px-3 py-2 text-sm flex-1 min-w-[140px]" style={inpStyle} />
                <input placeholder="Phone" value={newStaff.phone} inputMode="tel"
                  onChange={(e) => setNewStaff(s => ({...s, phone: e.target.value.replace(/[^\d+]/g, "").slice(0,15)}))}
                  className="px-3 py-2 text-sm w-36" style={inpStyle} />
                <input placeholder="Employee ID (HOD001)" value={newStaff.empId}
                  onChange={(e) => setNewStaff(s => ({...s, empId: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0,12)}))}
                  className="px-3 py-2 text-sm w-44 font-mono" style={inpStyle} />
                <input placeholder="5-digit PIN" value={newStaff.pin} inputMode="numeric"
                  onChange={(e) => setNewStaff(s => ({...s, pin: e.target.value.replace(/\D/g, "").slice(0,5)}))} maxLength={5}
                  className="px-3 py-2 text-sm w-28 font-mono" style={inpStyle} />
                <select value={newStaff.role} onChange={(e) => setNewStaff(s => ({...s, role: e.target.value as StaffRole, access: s.access.filter(r => r !== (e.target.value as StaffRole))}))}
                  className="px-3 py-2 text-sm font-semibold" style={inpStyle}>
                  {roleChoices.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                </select>
              </div>
              {renderAccess(
                newStaff.role, newStaff.access,
                (r) => setNewStaff(s => ({...s, access: s.access.includes(r) ? s.access.filter(x => x !== r) : [...s.access, r]})),
                (on) => {
                  const ownerAllowed = hasRole("admin");
                  const all = ACCESS_MODES.filter(m => (!m.ownerOnly || ownerAllowed) && m.role !== newStaff.role).map(m => m.role);
                  setNewStaff(s => ({...s, access: on ? all : []}));
                }
              )}
              <div className="flex items-center gap-3 mt-3">
                <button onClick={handleAddStaff} className="px-4 py-2 text-sm font-black uppercase"
                  style={{ background: "#F2C744", color: "#000", border: "2px solid #000", boxShadow: SHADOW_MD }}>
                  Add Staff
                </button>
                {staffMsg && !editStaff && <span className="text-xs font-semibold" style={{ color: staffMsg.startsWith("✅") ? "#23A094" : "#FF5733" }}>{staffMsg}</span>}
              </div>
            </div>

            <div className="space-y-1.5">
              {allStaff.map((s) => {
                const access = (s.roles && s.roles.length > 0 ? s.roles : [s.role]).filter(r => r !== s.role);
                return (
                  <div key={s.id} className="flex items-center justify-between px-3 py-2 gap-2"
                    style={{ background: "#fff", border: "2px solid #000" }}>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-bold">{s.name}</span>
                        <span className="text-[11px] font-mono px-1.5 py-0.5" style={{ background: "#F4F4F0", color: "#555", border: "1px solid #ccc" }}>{s.id}</span>
                        <span className="text-[11px] px-2 py-0.5 font-bold" style={{ background: "#F4F4F0", color: "#000", border: "2px solid #000" }}>{roleLabel(s.role)}</span>
                        {access.map(r => (
                          <span key={r} className="text-[10px] px-1.5 py-0.5 font-bold" style={{ background: "#E8FFF5", color: "#23A094", border: "2px solid #23A094" }}>+ {roleLabel(r)}</span>
                        ))}
                      </div>
                      {s.phone && <div className="text-[11px] mt-0.5 font-medium" style={{ color: "#777" }}>📞 {s.phone}</div>}
                    </div>
                    <div className="flex gap-2 shrink-0">
                      {(hasRole("admin") || !isEffectivelyElevated(s)) && (
                        <button onClick={() => setEditStaff({ ...s, pin: "", roles: s.roles && s.roles.length > 0 ? s.roles : [s.role] })}
                          className="text-xs px-2 py-1 font-bold"
                          style={{ background: "#FFFBEB", color: "#000", border: "2px solid #F2C744", boxShadow: SHADOW_SM }}>Edit</button>
                      )}
                      {(hasRole("admin") || !isEffectivelyElevated(s)) && (
                        <button onClick={() => s.id && updateStaffMember(s.id, { active: !s.active })}
                          className="text-xs px-2 py-1 font-bold"
                          style={{ background: s.active ? "#E8FFF5" : "#FFF0EE", color: s.active ? "#23A094" : "#FF5733", border: `2px solid ${s.active ? "#23A094" : "#FF5733"}`, boxShadow: SHADOW_SM }}>
                          {s.active ? "Active" : "Inactive"}
                        </button>
                      )}
                      {hasRole("admin") && s.role !== "admin" && (
                        <button onClick={() => { if (s.id && confirm(`Delete ${s.name}? This cannot be undone.`)) deleteStaffMember(s.id); }}
                          className="text-xs px-2 py-1 font-bold"
                          style={{ background: "#FFF0EE", color: "#FF5733", border: "2px solid #FF5733", boxShadow: SHADOW_SM }}>Delete</button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {editStaff && (
              <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,.5)" }} onClick={() => { setEditStaff(null); setStaffMsg(""); }}>
                <div className="w-full max-w-md p-5" style={{ background: "#fff", border: "2px solid #000", boxShadow: "6px 6px 0px #000" }} onClick={(e) => e.stopPropagation()}>
                  <h3 className="text-sm font-black uppercase mb-3">Edit {editStaff.name} <span className="font-mono text-xs font-normal" style={{ color: "#555" }}>({editStaff.id})</span></h3>
                  <div className="space-y-2">
                    <input placeholder="Name" value={editStaff.name} onChange={(e) => setEditStaff(p => p && ({...p, name: e.target.value}))}
                      className="w-full px-3 py-2 text-sm" style={inpStyle} />
                    <input placeholder="Phone" value={editStaff.phone || ""} inputMode="tel"
                      onChange={(e) => setEditStaff(p => p && ({...p, phone: e.target.value.replace(/[^\d+]/g, "").slice(0,15)}))}
                      className="w-full px-3 py-2 text-sm" style={inpStyle} />
                    {/* 🆕 2026-06-25 (Khushi) — CURRENT PIN (masked) + 👁 View.
                        Tapping View asks for the OWNER PIN before revealing, so a
                        forgotten PIN can be looked up without resetting it. The
                        field below is only for CHANGING the PIN. */}
                    {(() => {
                      const OWNER_VIEW_PIN = "33333"; // owner master PIN — change here when the owner updates it
                      const origPin = allStaff.find(s => s.id === editStaff.id)?.pin || "";
                      const shown = revealedPin !== null;
                      return (
                        <div className="flex items-center gap-2 px-3 py-2" style={{ background: "#F4F4F0", border: "2px solid #000", boxShadow: SHADOW_SM }}>
                          <span className="text-[11px] font-black uppercase shrink-0" style={{ color: "#555" }}>Current PIN</span>
                          <span className="flex-1 font-mono text-base font-bold tracking-widest" style={{ color: "#000" }}>
                            {shown ? (origPin || "—") : (origPin ? "•".repeat(origPin.length) : "—")}
                          </span>
                          <button type="button"
                            onClick={async () => {
                              if (shown) { setRevealedPin(null); return; }
                              if (!origPin) { setStaffMsg("❌ NO PIN ON RECORD FOR THIS STAFF"); return; }
                              const entered = await centeredPinPrompt(
                                `Enter the OWNER PIN to view ${editStaff?.name}'s PIN.`, true,
                                (pin) => pin === OWNER_VIEW_PIN || (hasRole("admin") && !!currentStaff?.pin && pin === currentStaff.pin),
                              );
                              if (entered) {
                                setRevealedPin(origPin);
                                // 🆕 Accountability — log every PIN reveal (fail-open).
                                if (currentStaff) {
                                  try {
                                    await logAudit({
                                      action: "staff_pin_revealed",
                                      staffId: currentStaff.id || "", staffName: currentStaff.name, staffRole: currentStaff.role,
                                      details: { viewedStaffId: editStaff?.id, viewedStaffName: editStaff?.name },
                                    });
                                  } catch (auditErr) { console.warn("audit log failed (non-fatal)", auditErr); }
                                }
                              }
                            }}
                            className="px-3 py-1 text-[11px] font-black uppercase shrink-0"
                            style={{ background: shown ? "#FF90E8" : "#fff", color: "#000", border: "2px solid #000", boxShadow: SHADOW_SM, cursor: "pointer" }}>
                            {shown ? "🙈 Hide" : "👁 View"}
                          </button>
                        </div>
                      );
                    })()}
                    <input placeholder="New 5-digit PIN (leave blank to keep)" value={editStaff.pin} inputMode="numeric"
                      onChange={(e) => setEditStaff(p => p && ({...p, pin: e.target.value.replace(/\D/g, "").slice(0,5)}))} maxLength={5}
                      className="w-full px-3 py-2 text-sm font-mono" style={inpStyle} />
                    <select value={editStaff.role} onChange={(e) => setEditStaff(p => { if (!p) return p; const next = e.target.value as StaffRole; return {...p, role: next, roles: (p.roles || []).filter(r => r !== next && r !== p.role)}; })}
                      className="w-full px-3 py-2 text-sm font-semibold" style={inpStyle}>
                      {roleChoices.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                    </select>
                    {renderAccess(
                      editStaff.role,
                      (editStaff.roles || []).filter(r => r !== editStaff.role),
                      (r) => setEditStaff(p => { if (!p) return p; const cur = (p.roles || []).filter(x => x !== p.role); const next = cur.includes(r) ? cur.filter(x => x !== r) : [...cur, r]; return {...p, roles: next}; }),
                      (on) => setEditStaff(p => { if (!p) return p; const ownerAllowed = hasRole("admin"); const all = ACCESS_MODES.filter(m => (!m.ownerOnly || ownerAllowed) && m.role !== p.role).map(m => m.role); return {...p, roles: on ? all : []}; }),
                      // 🆕 demote elevated main role → Captain (strip ALL elevated tiers from roles[]).
                      () => setEditStaff(p => p && ({ ...p, role: "captain", roles: (p.roles || []).filter(r => !isElevatedRole(r)) })),
                    )}
                    {/* 🆕 2026-06-25 (Khushi) — per-staff "Can settle bills". Admins &
                        managers always can, so the toggle is only meaningful for a
                        plain captain. OFF = captain may only NOTIFY a supervisor. */}
                    {(() => {
                      const alwaysCan = editStaff.role === "admin" || editStaff.role === "manager"
                        || (editStaff.roles || []).some(r => r === "admin" || r === "manager");
                      const on = alwaysCan || !!editStaff.canSettle;
                      return (
                        <button type="button"
                          disabled={alwaysCan}
                          onClick={() => setEditStaff(p => p && ({ ...p, canSettle: !p.canSettle }))}
                          className="w-full px-3 py-2 text-xs font-black uppercase flex items-center justify-between"
                          style={{ background: on ? "#23A094" : "#F4F4F0", color: on ? "#fff" : "#000", border: "2px solid #000", boxShadow: SHADOW_SM, cursor: alwaysCan ? "not-allowed" : "pointer", opacity: alwaysCan ? 0.85 : 1 }}>
                          <span>💰 Can settle bills</span>
                          <span>{on ? "✅ ON" : "OFF"}</span>
                        </button>
                      );
                    })()}
                    {(editStaff.role === "admin" || editStaff.role === "manager"
                      || (editStaff.roles || []).some(r => r === "admin" || r === "manager")) && (
                      <div className="text-[10px] font-semibold" style={{ color: "#555" }}>Admins &amp; managers can always settle bills.</div>
                    )}
                  </div>
                  {staffMsg && <div className="text-xs mt-2 font-semibold" style={{ color: staffMsg.startsWith("✅") ? "#23A094" : "#FF5733" }}>{staffMsg}</div>}
                  <div className="flex gap-2 mt-4">
                    <button onClick={handleSaveEdit} className="flex-1 px-4 py-2 text-sm font-black uppercase"
                      style={{ background: "#F2C744", color: "#000", border: "2px solid #000", boxShadow: SHADOW_MD }}>Save</button>
                    <button onClick={() => { setEditStaff(null); setStaffMsg(""); }} className="px-4 py-2 text-sm font-bold"
                      style={{ background: "#F4F4F0", color: "#000", border: "2px solid #000", boxShadow: SHADOW_SM }}>Cancel</button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {tab === "tablet" && (
          <div className="max-w-xl space-y-4">
            <div className="p-4" style={{ background: "#fff", border: "2px solid #000" }}>
              <h3 className="text-sm font-black uppercase mb-2">🖨 Set This Tablet's Floor</h3>
              <p className="text-xs mb-4 font-medium" style={{ color: "#555" }}>
                When a captain fires a KOT, drinks print to <b>this floor's bar printer</b> and bills to <b>this floor's bill printer</b>. Food always goes to the kitchen. Set this once per tablet.
              </p>
              <div className="grid grid-cols-3 gap-2 mb-3">
                {(["ground", "first", "rooftop"] as const).map((f) => {
                  const isSel = tabletFloor === f;
                  const label = f === "ground" ? "Ground Floor" : f === "first" ? "First Floor" : "Rooftop";
                  return (
                    <button key={f} onClick={() => { setTabletFloor(f); setTabletFloorState(f); }}
                      className="px-3 py-3 text-sm font-black uppercase"
                      style={{ background: isSel ? "#FF90E8" : "#F4F4F0", color: "#000", border: "2px solid #000", boxShadow: isSel ? SHADOW_MD : SHADOW_SM }}>
                      {label}
                    </button>
                  );
                })}
              </div>
              <div className="text-xs p-3 font-bold" style={{ background: "#F4F4F0", border: "2px solid #000", color: tabletFloor ? "#23A094" : "#FF5733" }}>
                {tabletFloor
                  ? `✅ This tablet is bound to ${tabletFloor === "ground" ? "Ground Floor" : tabletFloor === "first" ? "First Floor" : "Rooftop"}.`
                  : "⚠️ No floor set. Drinks/bills will default to FF printers. Pick a floor above."}
              </div>
            </div>
            <div className="p-4 text-xs space-y-2" style={{ background: "#F4F4F0", border: "2px dashed #000", color: "#555" }}>
              <div><b style={{ color: "#000" }}>How printing works (Cloud-Routed):</b></div>
              <div>1. Captain hits Fire KOT → KOT written to Firestore with item destination tags.</div>
              <div>2. Each floor's PC runs <code>print-server</code>, subscribes to Firestore, prints over TCP to local Ethernet printers.</div>
              <div>3. Mixed orders auto-split: e.g. 1 beer + 1 tikka on a Rooftop tablet → beer prints at RT bar, tikka prints in kitchen.</div>
              <div>4. Works offline (Firestore SDK queues writes); recovers if a floor PC reboots.</div>
              <div className="pt-2 border-t" style={{ borderColor: "#ccc" }}>Full architecture: see <code>replit.md → 🖨 KOT PRINTING ARCHITECTURE</code>.</div>
            </div>
          </div>
        )}

        {tab === "settings" && (
          <div className="max-w-xl space-y-4">
            <div className="p-4" style={{ background: "#fff", border: "2px solid #000" }}>
              <h3 className="text-sm font-black uppercase mb-1">💳 Default Card Machine</h3>
              <p className="text-xs mb-3 font-medium" style={{ color: "#555" }}>
                Venue-wide default for Door Mode card swipes. Takes effect on the next bouncer who opens Door Mode — no rebuild needed.
                {!FEATURES.edc && <><br /><span style={{ color: "#FF5733", fontWeight: 700 }}>⚠️ EDC feature flag (<code>VITE_EDC</code>) is OFF — ignored until EDC is enabled.</span></>}
              </p>
              <div className="grid grid-cols-2 gap-2 mb-3">
                {(["razorpay", "pinelabs"] as const).map((v) => {
                  const sel = edcDefaultVendor === v;
                  const label = v === "razorpay" ? "Razorpay POS" : "Pine Labs Plutus";
                  return (
                    <button key={v} onClick={() => handleEdcVendorChange(v)} disabled={edcSaving}
                      className="px-3 py-3 text-sm font-black uppercase"
                      style={{ background: sel ? "#FF90E8" : "#F4F4F0", color: "#000", border: "2px solid #000", boxShadow: sel ? SHADOW_MD : SHADOW_SM, cursor: edcSaving ? "wait" : "pointer", opacity: edcSaving ? 0.7 : 1 }}>
                      {label}{sel ? " ✓" : ""}
                    </button>
                  );
                })}
              </div>
              <div className="text-xs p-3 font-semibold" style={{ background: "#F4F4F0", border: "2px solid #000", color: edcDefaultVendor ? "#23A094" : "#555" }}>
                {edcSaveMsg
                  ? edcSaveMsg
                  : edcDefaultVendor
                    ? `✅ Venue default: ${edcDefaultVendor === "razorpay" ? "Razorpay POS" : "Pine Labs Plutus"}.`
                    : `No venue default set yet — Door Mode falls back to the build-time default (${(import.meta.env.VITE_EDC_VENDOR as string) === "pinelabs" ? "Pine Labs" : "Razorpay POS"}).`}
              </div>
            </div>
          </div>
        )}

        {tab === "door-pricing" && (
          <div className="space-y-4 max-w-xl">
            <div className="p-5" style={{ background: "#fff", border: "2px solid #000" }}>
              <h3 className="text-base font-black uppercase mb-2">💰 Door Bargain Pricing</h3>
              <p className="text-xs leading-relaxed mb-4 font-medium" style={{ color: "#555" }}>
                When <b>ON</b>, door staff can edit the price for each walk-in — useful for Koramangala customers who bargain. Every overridden price is stamped in the booking's notes for your review.
                <br /><br />
                When <b>OFF</b>, prices lock to the event's published values.
              </p>
              <div className="flex items-center justify-between p-4" style={{ background: "#F4F4F0", border: "2px solid #000" }}>
                <div>
                  <div className="text-sm font-black uppercase">Allow door staff to override prices</div>
                  <div className="text-xs mt-1 font-semibold" style={{ color: doorPricing.priceOverrideEnabled ? "#23A094" : "#777" }}>
                    {doorPricing.priceOverrideEnabled
                      ? "✅ ON — door girls can bargain prices on every walk-in"
                      : "🔒 OFF — prices locked to event values (safest default)"}
                  </div>
                </div>
                <button
                  onClick={async () => {
                    if (doorPricingSaving) return;
                    const next = !doorPricing.priceOverrideEnabled;
                    const ok = await requireManagerPinAdmin(
                      next ? "Allow door staff to override walk-in prices?" : "Lock door walk-in prices back to event values?"
                    );
                    if (!ok) return;
                    setDoorPricingSaving(true);
                    try {
                      await updateDoorPricingSettings({ priceOverrideEnabled: next }, currentStaff?.name || "admin");
                      setDoorPricing({ priceOverrideEnabled: next });
                      await logAudit({
                        action: "DOOR_PRICING_OVERRIDE_TOGGLE",
                        staffId: currentStaff?.id || "admin", staffName: currentStaff?.name || "admin",
                        staffRole: (currentStaff?.role || "admin") as StaffRole, details: { enabled: next },
                      }).catch(() => {});
                    } catch (e: any) {
                      alert(`❌ Could not update setting: ${e?.message || e}`);
                    } finally { setDoorPricingSaving(false); }
                  }}
                  disabled={doorPricingSaving}
                  className="relative inline-flex items-center"
                  style={{ width: 64, height: 34, borderRadius: 999, background: doorPricing.priceOverrideEnabled ? "#23A094" : "#ccc", border: "2px solid #000", cursor: doorPricingSaving ? "wait" : "pointer", opacity: doorPricingSaving ? 0.6 : 1, transition: "background .2s" }}
                  aria-label="Toggle door pricing override">
                  <span style={{ position: "absolute", left: doorPricing.priceOverrideEnabled ? 30 : 2, top: 3, width: 26, height: 26, borderRadius: "50%", background: "#fff", border: "1px solid #ccc", transition: "left .2s" }} />
                </button>
              </div>
              <div className="mt-4 p-3 text-xs leading-relaxed font-medium" style={{ background: "#F4F4F0", border: "2px solid #000", color: "#555" }}>
                <b style={{ color: "#000" }}>🛟 Fallback:</b> If this setting can't load, the door modal defaults to <b>OFF</b>. Audit overrides in <b>📋 Reports</b> — look for "PRICE OVERRIDE" in notes.
              </div>
            </div>
          </div>
        )}

        {tab === "table-pricing" && (
          <div className="space-y-4 max-w-xl">
            <div className="p-5" style={{ background: "#fff", border: "2px solid #000" }}>
              <h3 className="text-base font-black uppercase mb-2">🎟️ Table Cover Pricing</h3>
              <p className="text-xs leading-relaxed mb-4 font-medium" style={{ color: "#555" }}>
                Sets the <b>per-head cover charge</b> and <b>start time</b> for each table tier on hodclub.in. <b>Ground Premium</b> = C1–C4; <b>Ground VVIP</b> = VIP1 / VIP2. When <b>OFF</b>, all table bookings are free.
              </p>
              <div className="flex items-center justify-between p-4 mb-4" style={{ background: "#F4F4F0", border: "2px solid #000" }}>
                <div>
                  <div className="text-sm font-black uppercase">Weekend table cover charges</div>
                  <div className="text-xs mt-1 font-semibold" style={{ color: tablePricing.enabled ? "#23A094" : "#777" }}>
                    {tablePricing.enabled ? "✅ ON — weekend tables carry the per-head cover" : "🔒 OFF — all table bookings are free"}
                  </div>
                </div>
                <button
                  onClick={async () => {
                    if (tablePricingSaving) return;
                    const next = !tablePricing.enabled;
                    const ok = await requireManagerPinAdmin(next ? "Turn ON weekend table cover charges?" : "Turn OFF table cover charges (all tables free)?");
                    if (!ok) return;
                    setTablePricingSaving(true); setTablePricingMsg("");
                    try {
                      await updateTablePricingSettings({ enabled: next }, currentStaff?.name || "admin");
                      setTablePricing((p) => ({ ...p, enabled: next }));
                      await logAudit({
                        action: "TABLE_PRICING_ENABLE_TOGGLE",
                        staffId: currentStaff?.id || "admin", staffName: currentStaff?.name || "admin",
                        staffRole: (currentStaff?.role || "admin") as StaffRole, details: { enabled: next },
                      }).catch(() => {});
                    } catch (e: any) {
                      alert(`❌ Could not update setting: ${e?.message || e}`);
                    } finally { setTablePricingSaving(false); }
                  }}
                  disabled={tablePricingSaving}
                  className="relative inline-flex items-center"
                  style={{ width: 64, height: 34, borderRadius: 999, background: tablePricing.enabled ? "#23A094" : "#ccc", border: "2px solid #000", cursor: tablePricingSaving ? "wait" : "pointer", opacity: tablePricingSaving ? 0.6 : 1, transition: "background .2s" }}
                  aria-label="Toggle table cover charges">
                  <span style={{ position: "absolute", left: tablePricing.enabled ? 30 : 2, top: 3, width: 26, height: 26, borderRadius: "50%", background: "#fff", border: "1px solid #ccc", transition: "left .2s" }} />
                </button>
              </div>
              <div className="space-y-3 mb-4">
                {TP_TIERS.map((f) => (
                  <div key={f.key} className="p-3" style={{ background: "#F4F4F0", border: "2px solid #000" }}>
                    <div className="text-xs font-black uppercase mb-2">
                      {f.label}{f.hint ? <span style={{ color: "#555", fontWeight: 500 }}> · {f.hint}</span> : null}
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-[10px] font-black uppercase mb-1" style={{ color: "#555" }}>PER-HEAD COVER</label>
                        <div className="flex items-center px-2" style={{ background: "#fff", border: "2px solid #000" }}>
                          <span className="text-sm font-bold" style={{ color: "#555" }}>₹</span>
                          <input type="number" inputMode="numeric" min={0}
                            value={tablePricingDraft[f.key].price}
                            onChange={(e) => setTablePricingDraft((d) => ({ ...d, [f.key]: { ...d[f.key], price: e.target.value } }))}
                            className="w-full bg-transparent py-2 px-1 text-sm outline-none font-semibold" style={{ color: "#000" }} />
                        </div>
                      </div>
                      <div>
                        <label className="block text-[10px] font-black uppercase mb-1" style={{ color: "#555" }}>COVER STARTS</label>
                        <input type="time" value={tablePricingDraft[f.key].start}
                          onChange={(e) => setTablePricingDraft((d) => ({ ...d, [f.key]: { ...d[f.key], start: e.target.value } }))}
                          className="w-full py-2 px-2 text-sm outline-none font-semibold"
                          style={{ background: "#fff", border: "2px solid #000", color: "#000" }} />
                      </div>
                    </div>
                    {(() => {
                      const tabs = TABLE_PRICING_OVERRIDE_TABLES.filter((t) => t.tier === f.key);
                      if (tabs.length === 0) return null;
                      return (
                        <div className="mt-3 pt-3" style={{ borderTop: "2px dashed #000" }}>
                          <div className="text-[10px] font-black uppercase mb-2" style={{ color: "#555" }}>
                            PER-TABLE PRICE <span style={{ fontWeight: 500 }}>· blank = use ₹{tablePricingDraft[f.key].price || "0"} above</span>
                          </div>
                          <div className="grid grid-cols-2 gap-3">
                            {tabs.map((t) => (
                              <div key={t.key}>
                                <label className="block text-[10px] font-black uppercase mb-1" style={{ color: "#555" }}>{t.label}</label>
                                <div className="flex items-center px-2" style={{ background: "#fff", border: "2px solid #000" }}>
                                  <span className="text-sm font-bold" style={{ color: "#555" }}>₹</span>
                                  <input type="number" inputMode="numeric" min={0}
                                    placeholder={tablePricingDraft[f.key].price || "0"}
                                    value={tableOverridesDraft[t.key] ?? ""}
                                    onChange={(e) => setTableOverridesDraft((d) => ({ ...d, [t.key]: e.target.value }))}
                                    className="w-full bg-transparent py-2 px-1 text-sm outline-none font-semibold" style={{ color: "#000" }} />
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      );
                    })()}
                  </div>
                ))}
              </div>
              <button
                onClick={async () => {
                  if (tablePricingSaving) return;
                  const patch: Partial<TablePricingSettings> = {};
                  for (const f of TP_TIERS) {
                    const price = Math.round(Number(tablePricingDraft[f.key].price));
                    const startMin = _hhmmToMin(tablePricingDraft[f.key].start);
                    if (!Number.isFinite(price) || price < 0) { setTablePricingMsg(`❌ Enter a valid price for ${f.label}.`); return; }
                    if (!Number.isFinite(startMin)) { setTablePricingMsg(`❌ Enter a valid start time for ${f.label}.`); return; }
                    (patch as any)[f.key] = { price, startMin };
                  }
                  // Per-table price overrides (price only; 0 = clear → use tier price).
                  const overrides: Record<string, number> = {};
                  for (const t of TABLE_PRICING_OVERRIDE_TABLES) {
                    const raw = (tableOverridesDraft[t.key] ?? "").trim();
                    if (raw === "") { overrides[t.key] = 0; continue; }
                    const v = Math.round(Number(raw));
                    if (!Number.isFinite(v) || v < 0) { setTablePricingMsg(`❌ Enter a valid price for ${t.label}.`); return; }
                    overrides[t.key] = v;
                  }
                  patch.tableOverrides = overrides;
                  const tierSummary = TP_TIERS.map((f) => `${f.label}: ₹${(patch as any)[f.key].price} from ${_fmt12(tablePricingDraft[f.key].start)}`).join("\n");
                  const ovSummary = TABLE_PRICING_OVERRIDE_TABLES
                    .filter((t) => overrides[t.key] > 0)
                    .map((t) => `${t.label}: ₹${overrides[t.key]}`)
                    .join("\n");
                  const summary = tierSummary + (ovSummary ? "\n\nPER-TABLE:\n" + ovSummary : "");
                  const ok = await requireManagerPinAdmin("Save table cover pricing?\n\n" + summary);
                  if (!ok) return;
                  setTablePricingSaving(true); setTablePricingMsg("");
                  try {
                    await updateTablePricingSettings(patch, currentStaff?.name || "admin");
                    setTablePricing((p) => ({ ...p, ...patch } as TablePricingSettings));
                    await logAudit({
                      action: "TABLE_PRICING_UPDATE",
                      staffId: currentStaff?.id || "admin", staffName: currentStaff?.name || "admin",
                      staffRole: (currentStaff?.role || "admin") as StaffRole, details: patch as any,
                    }).catch(() => {});
                    setTablePricingMsg("✅ Saved.");
                  } catch (e: any) {
                    setTablePricingMsg(`❌ Could not save: ${e?.message || e}`);
                  } finally { setTablePricingSaving(false); }
                }}
                disabled={tablePricingSaving}
                className="px-4 py-2 text-sm font-black uppercase"
                style={{ background: "#F2C744", color: "#000", border: "2px solid #000", boxShadow: SHADOW_MD, cursor: tablePricingSaving ? "wait" : "pointer", opacity: tablePricingSaving ? 0.6 : 1 }}>
                {tablePricingSaving ? "Saving…" : "Save Prices & Times"}
              </button>
              {tablePricingMsg && (
                <span className="ml-3 text-xs font-semibold" style={{ color: tablePricingMsg.startsWith("✅") ? "#23A094" : "#FF5733" }}>{tablePricingMsg}</span>
              )}
              <div className="mt-4 p-3 text-xs leading-relaxed font-medium" style={{ background: "#F4F4F0", border: "2px solid #000", color: "#555" }}>
                <b style={{ color: "#000" }}>🛟 Fallback:</b> If the customer site can't load this setting, it defaults to <b>₹2,500/head, ON</b>.
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════
// CAPTAIN VOID LOCKS TAB
// ════════════════════════════════════════════════════════════════════════
const ADMIN_HASH_LOCKS = "888df25ae35772424a560c7152a1de794440e0ea5cfee62828333a456a506e05";

function CaptainLocksTab({ adminName }: { adminName: string }) {
  const [rows, setRows] = useState<CaptainVoidStats[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [unlocking, setUnlocking] = useState<string | null>(null);
  const [rulesMissing, setRulesMissing] = useState(false);

  const load = async () => {
    setLoading(true); setError(""); setRulesMissing(false);
    try { setRows(await listSuspendedCaptainsToday()); }
    catch (e: unknown) {
      if (e instanceof CaptainVoidStatsRulesError) { setRulesMissing(true); setRows([]); }
      else setError(e instanceof Error ? e.message : String(e));
    }
    setLoading(false);
  };
  useEffect(() => { load(); }, []);

  const handleUnlock = async (row: CaptainVoidStats) => {
    const pin = window.prompt(
      `🔓 UNLOCK ${row.captainName.toUpperCase()} FOR VOIDS\n\n` +
      `Tonight so far: ${row.voidCount} voids · ₹${row.voidValue}\n` +
      `Reason locked: ${row.suspendReason || "—"}\n\n` +
      `This RESETS their void counter to 0 — they get a fresh cap.\n` +
      `Make sure you've spoken to them on the phone first.\n\n` +
      `ENTER 4-DIGIT ADMIN PIN (9999):`
    );
    if (!pin) return;
    const h = await sha256(pin.trim());
    if (h !== ADMIN_HASH_LOCKS) { alert("❌ WRONG ADMIN PIN."); return; }
    setUnlocking(row.id);
    try {
      await unlockCaptainVoids(row.id, adminName);
      alert(`✅ ${row.captainName.toUpperCase()} UNLOCKED.\n\nThey can void again. Counter reset to 0.\nUnlock logged for the audit.`);
      await load();
    } catch (e: unknown) {
      alert("Unlock failed: " + (e instanceof Error ? e.message : String(e)));
    }
    setUnlocking(null);
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-lg font-black uppercase">🔓 Captain Void Locks</h3>
          <p className="text-xs font-medium" style={{ color: "#555" }}>
            Auto-suspended captains for tonight (cap: 5 voids OR ₹3000). Admin PIN required to unlock.
          </p>
        </div>
        <button onClick={load} className="px-3 py-1.5 text-xs font-black uppercase"
          style={{ background: "#F4F4F0", border: "2px solid #000", color: "#000", boxShadow: SHADOW_SM }}>
          🔄 Refresh
        </button>
      </div>

      {loading && <div className="text-center py-12 text-sm font-semibold" style={{ color: "#555" }}>Loading...</div>}
      {error && (
        <div className="p-3 mb-3 font-semibold" style={{ background: "#FFF0EE", border: "2px solid #FF5733", color: "#FF5733", fontSize: 13 }}>
          ⚠ {error}
        </div>
      )}
      {rulesMissing && (
        <div className="p-4 mb-3" style={{ background: "#FFFBEB", border: "2px solid #F2C744" }}>
          <div style={{ fontSize: 14, fontWeight: 900, color: "#000", marginBottom: 6 }}>
            🛠 ONE-TIME FIRESTORE RULES PATCH NEEDED
          </div>
          <div style={{ fontSize: 12, color: "#444", marginBottom: 10, lineHeight: 1.5, fontWeight: 500 }}>
            The Captain Void Cap (anti-fraud #A2) needs <strong>2 small Firestore rule blocks</strong> deployed once.
            Until then, voids still work fine — there's just no nightly cap and this tab can't list locks.
            <br /><br />
            <strong>WHAT TO DO:</strong> Open Firebase Console → Firestore → Rules. Paste the blocks below, then click <strong>Publish</strong>.
          </div>
          <pre style={{ background: "#111", border: "2px solid #000", padding: 12, fontSize: 11, color: "#F2C744", overflow: "auto", lineHeight: 1.5, fontFamily: "monospace" }}>
{`// HOD anti-fraud collections — POS captain void cap + customer notify queue
match /captainVoidStats/{docId} {
  allow read, write: if request.auth != null;
}
match /voidNotificationsQueue/{docId} {
  allow create, read: if request.auth != null;
  allow update: if request.auth != null;
}`}
          </pre>
          <div style={{ fontSize: 11, color: "#666", marginTop: 8, fontWeight: 500 }}>
            After Publish, tap <strong>🔄 Refresh</strong> above — this banner disappears and Locks goes live.
          </div>
        </div>
      )}

      {!loading && !error && !rulesMissing && rows.length === 0 && (
        <div className="text-center py-12" style={{ border: "2px dashed #000" }}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>✅</div>
          <div style={{ fontSize: 14, fontWeight: 900 }}>NO CAPTAINS LOCKED TONIGHT</div>
          <div style={{ fontSize: 12, marginTop: 4, color: "#555", fontWeight: 500 }}>Everyone's voids are within the daily cap.</div>
        </div>
      )}

      {!loading && !error && !rulesMissing && rows.length > 0 && (
        <div className="flex flex-col gap-2">
          {rows.map((r) => (
            <div key={r.id} className="p-4" style={{ background: "#FFF0EE", border: "2px solid #FF5733" }}>
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div style={{ minWidth: 0 }}>
                  <div className="flex items-center gap-2 mb-1 flex-wrap">
                    <span style={{ fontSize: 16, fontWeight: 900 }}>{r.captainName.toUpperCase()}</span>
                    <span style={{ background: "#FF5733", color: "#fff", fontSize: 10, fontWeight: 900, padding: "2px 6px", letterSpacing: .5 }}>🚫 SUSPENDED</span>
                  </div>
                  <div style={{ fontSize: 13, color: "#333", marginBottom: 2, fontWeight: 600 }}>
                    {r.voidCount} voids · ₹{r.voidValue.toLocaleString("en-IN")} total
                  </div>
                  <div style={{ fontSize: 11, color: "#666", fontWeight: 500 }}>
                    {r.suspendReason || "Cap exceeded"}
                    {r.suspendedAt && ` · at ${new Date(r.suspendedAt).toLocaleString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false })}`}
                  </div>
                </div>
                <button onClick={() => handleUnlock(r)} disabled={unlocking === r.id}
                  style={{ padding: "10px 18px", background: "#E8FFF5", border: "2px solid #23A094", color: "#23A094", fontSize: 13, fontWeight: 900, cursor: "pointer", opacity: unlocking === r.id ? .6 : 1, boxShadow: SHADOW_SM }}>
                  {unlocking === r.id ? "Unlocking..." : "🔓 Unlock"}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="mt-6 p-3 text-xs" style={{ background: "#fff", border: "2px solid #000", color: "#555" }}>
        <div style={{ color: "#000", fontWeight: 900, marginBottom: 4, textTransform: "uppercase" }}>HOW THIS WORKS</div>
        <div style={{ lineHeight: 1.6, fontWeight: 500 }}>
          • Every captain has a nightly cap: <strong>5 voids OR ₹3,000 in voided value</strong>.<br/>
          • Hit either → captain is auto-suspended from FURTHER voids that night.<br/>
          • Captain calls you → you tap <strong>🔓 Unlock</strong> + enter Admin PIN (9999).<br/>
          • Counter resets to 0; they get a fresh cap.<br/>
          • Every unlock is recorded on the same Firestore doc for the audit.
        </div>
      </div>
    </div>
  );
}
