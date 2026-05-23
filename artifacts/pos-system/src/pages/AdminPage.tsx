import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { useStaff } from "@/lib/staff-context";
// 🔴 2026-05-09 — switched FROM menu-data.ts (314 items, prefix `m`)
// TO hod-menu.ts (373 items, prefix `hod`). Reason: hod-menu is the
// CANONICAL list — it matches BarMode and customer wallet (hodclub.in).
// Admin must manage the same list everyone else sells from. Override
// docs are now keyed by slug(name), so cross-list ID mismatch is moot.
import { HOD_MENU_ITEMS, HOD_CATEGORY_LABELS } from "@/lib/hod-menu";
import type { StaffMember, HappyHourConfig, AggregatorSettings, MenuOverride } from "@/lib/types";
import {
  subscribeToHappyHour, updateHappyHour,
  subscribeToAggregatorSettings, updateAggregatorSettings,
  subscribeToMenuOverrides, setMenuOverride, menuOverrideKey,
  logAudit,
  subscribeToEdcDefaultVendor, setEdcDefaultVendor, type EdcDefaultVendor,
} from "@/lib/firestore";
import { FEATURES } from "@/lib/feature-flags";
import { getTabletFloor, setTabletFloor, type TabletFloor, sha256,
  listSuspendedCaptainsToday, unlockCaptainVoids, type CaptainVoidStats,
  CaptainVoidStatsRulesError,
} from "@/lib/firestore-hod";
import { formatINR } from "@/lib/utils-pos";
import { LiveMonitor } from "./LiveMonitor";
import Reports from "./Reports";
import EventsAdmin from "./EventsAdmin";
import MenuEditor from "./MenuEditor";
import AttendanceAdmin from "./AttendanceAdmin";
import StaffManagement from "./StaffManagement";

// Manager PIN gate for menu changes (OOS toggle, discount set/clear).
// Same hash as CaptainMode (PIN 8888 — rotate via sha256(newPin)).
const MANAGER_HASH_ADMIN = "2926a2731f4b312c08982cacf8061eb14bf65c1a87cc5d70e864e079c6220731";
async function requireManagerPinAdmin(reason: string): Promise<boolean> {
  const pin = window.prompt(`🔒 MANAGER PIN REQUIRED\n\n${reason}\n\nENTER 4-DIGIT MANAGER PIN:`);
  if (!pin) return false;
  const h = await sha256(pin.trim());
  if (h !== MANAGER_HASH_ADMIN) { alert("❌ WRONG MANAGER PIN."); return false; }
  return true;
}

export default function AdminPage() {
  const { currentStaff, hasRole, logout } = useStaff();
  const [, navigate] = useLocation();
  const [tab, setTab] = useState<"monitor" | "reports" | "events" | "dashboard" | "menu" | "menu-editor" | "staff" | "attendance" | "aggregator" | "happy-hour" | "tablet" | "locks" | "settings">("monitor");
  const [tabletFloor, setTabletFloorState] = useState<TabletFloor | null>(getTabletFloor());
  const [happyHour, setHappyHour] = useState<HappyHourConfig | null>(null);
  const [aggSettings, setAggSettings] = useState<AggregatorSettings[]>([]);
  const [menuOverrides, setMenuOverridesState] = useState<Record<string, MenuOverride>>({});
  const [menuSearch, setMenuSearch] = useState("");
  const [editingHH, setEditingHH] = useState(false);
  const [hhForm, setHhForm] = useState({ enabled: false, days: [0,1,2,3,4,5,6], startTime: "12:00", endTime: "20:00", discountPercent: 10 });
  const [edcDefaultVendor, setEdcDefaultVendorState] = useState<EdcDefaultVendor | null>(null);
  const [edcSaving, setEdcSaving] = useState(false);
  const [edcSaveMsg, setEdcSaveMsg] = useState("");

  useEffect(() => {
    const unsubs = [
      subscribeToHappyHour(setHappyHour),
      subscribeToAggregatorSettings(setAggSettings),
      subscribeToMenuOverrides(setMenuOverridesState),
      subscribeToEdcDefaultVendor(setEdcDefaultVendorState),
    ];
    return () => unsubs.forEach(u => u());
  }, []);

  // Owner-facing change to the venue-wide default card machine. Door Mode
  // picks this up live via its own subscription on the next mount; bouncers
  // who already overrode the vendor on their tablet keep their override.
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

  useEffect(() => {
    if (happyHour) {
      setHhForm({
        enabled: happyHour.enabled,
        days: happyHour.days || [],
        startTime: happyHour.startTime || "12:00",
        endTime: happyHour.endTime || "20:00",
        discountPercent: happyHour.discountPercent || 10,
      });
    }
  }, [happyHour]);

  if (!hasRole("admin", "manager")) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: "#030305", color: "#C9A84C" }}>
        <p>Access denied. Manager or Admin role required.</p>
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
    if (!(await requireManagerPinAdmin(
      `${goingOOS ? "MARK OUT OF STOCK" : "MARK BACK IN STOCK"}: ${itemName}`
    ))) return;
    await setMenuOverride(itemName, {
      outOfStock: goingOOS,
      updatedBy: currentStaff?.name || "admin",
    });
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
    // 🔴 BUGFIX 2026-05-10 — same merge:true clear bug as bulk discount.
    // Write explicit 0/"" instead of undefined so the field actually clears.
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

  // 🔴 UX 2026-05-10 — BULK DISCOUNT (Khushi happy-hour ask). Sets the same %
  // discount on EVERY menu item (or every CURRENTLY-FILTERED item if a search
  // is active) in one tap. Manager-PIN gated, audit-logged. Skips OOS items
  // automatically — no point discounting what isn't being sold tonight.
  // 🛡 FALLBACK: if any single setMenuOverride fails, we keep going on the
  //              rest and surface a count of failures at the end so the
  //              manager knows to retry. We never silently swallow errors.
  const setBulkDiscount = async () => {
    const targetItems = filteredMenu;
    const scopeLabel = menuSearch ? `${targetItems.length} FILTERED items` : `ALL ${targetItems.length} menu items`;
    const input = window.prompt(
      `💰 BULK DISCOUNT — apply to ${scopeLabel}\n\n` +
      `Enter percent like "10%" or "20%" (max 50%).\n` +
      `Empty / "0" / "clear" to REMOVE discount from all these items.\n\n` +
      `⚠ This OVERWRITES any existing per-item discounts on these items.`,
      "10%"
    );
    if (input === null) return;
    const trimmed = input.trim().toLowerCase();
    let discountPercent: number | undefined;
    let clearing = false;
    if (trimmed === "" || trimmed === "0" || trimmed === "clear") {
      clearing = true;
    } else {
      const raw = trimmed.endsWith("%") ? trimmed.slice(0, -1) : trimmed;
      const n = parseFloat(raw);
      if (!isFinite(n) || n <= 0) { alert("❌ INVALID PERCENT."); return; }
      if (n > 50) { alert("❌ DISCOUNT % CAPPED AT 50%."); return; }
      discountPercent = Math.round(n * 100) / 100;
    }
    const reason = window.prompt(
      `📝 REASON FOR THIS BULK ${clearing ? "CLEAR" : "DISCOUNT"}?\n` +
      `(E.g. HAPPY HOUR 6-9PM, FRIDAY SPECIAL, FESTIVAL, MGMT CALL)`,
      clearing ? "BULK CLEAR" : "HAPPY HOUR"
    );
    if (reason === null) return;
    if (!(await requireManagerPinAdmin(
      `BULK ${clearing ? "CLEAR DISCOUNT" : `SET ${discountPercent}% DISCOUNT`} on ${scopeLabel}`
    ))) return;
    let ok = 0, fail = 0, skipped = 0;
    for (const item of targetItems) {
      const key = menuOverrideKey(item.name);
      const current = menuOverrides[key];
      // Skip OOS items — no point discounting what's not for sale
      if (current?.outOfStock) { skipped++; continue; }
      try {
        // 🔴 BUGFIX 2026-05-10 — Firestore setDoc({merge:true}) keeps existing
        // fields when you pass undefined. Write explicit 0 / "" to clear,
        // because all consumers check `if (ov.discountPercent)` which treats
        // 0 as falsy = no discount.
        await setMenuOverride(item.name, {
          outOfStock: current?.outOfStock || false,
          discountPercent: clearing ? 0 : discountPercent,
          discountAmount: 0,
          discountReason: clearing ? "" : (reason.trim() || "BULK DISCOUNT"),
          updatedBy: currentStaff?.name || "admin",
        });
        ok++;
      } catch (e) {
        console.error("[bulk discount] failed for", item.name, e);
        fail++;
      }
    }
    if (currentStaff) {
      await logAudit({
        action: "menu_discount_set",
        staffId: currentStaff.id || "", staffName: currentStaff.name, staffRole: currentStaff.role,
        details: {
          bulk: true,
          scope: menuSearch ? `filtered:${menuSearch}` : "all",
          discountPercent: clearing ? 0 : discountPercent,
          reason: reason.trim(),
          itemCount: ok, failCount: fail, oosSkipped: skipped,
        },
      });
    }
    alert(
      `✅ BULK ${clearing ? "CLEAR" : "DISCOUNT"} DONE\n\n` +
      `• APPLIED: ${ok} items\n` +
      `• SKIPPED (OUT OF STOCK): ${skipped}\n` +
      (fail > 0 ? `• ⚠ FAILED: ${fail} (CHECK CONSOLE / RETRY)\n` : "") +
      `\nLIVE-SYNCING TO CAPTAIN, BAR & HODCLUB.IN NOW.`
    );
  };

  const handleSaveHappyHour = async () => {
    await updateHappyHour({
      ...hhForm,
      appliesTo: "all",
      updatedBy: currentStaff?.name,
    });
    setEditingHH(false);
  };

  const dayLabels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  return (
    <div className="min-h-screen" style={{ background: "#030305", color: "hsl(36 29% 93%)" }}>
      <header className="flex items-center justify-between px-4 py-3" style={{ borderBottom: "1px solid hsl(240 8% 13%)" }}>
        <div className="flex items-center gap-4">
          <button onClick={() => navigate("/")} className="text-sm" style={{ color: "#C9A84C" }}>← Floor</button>
          <h1 className="text-lg font-semibold" style={{ color: "#C9A84C" }}>Admin Panel</h1>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs" style={{ color: "hsl(36 29% 60%)" }}>{currentStaff?.name}</span>
          <button onClick={logout} className="text-xs px-2 py-1 rounded" style={{ background: "hsl(240 12% 10%)", color: "hsl(36 29% 70%)" }}>Logout</button>
        </div>
      </header>

      <div className="flex gap-1 px-4 py-2" style={{ borderBottom: "1px solid hsl(240 8% 13%)" }}>
        {(["monitor", "reports", "events", "locks", "dashboard", "menu", "menu-editor", "staff", "attendance", "happy-hour", "aggregator", "tablet", "settings"] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)} className="px-4 py-2 rounded-lg text-sm font-medium transition-colors"
            style={{ background: tab === t ? "#C9A84C" : "hsl(240 12% 8%)", color: tab === t ? "#030305" : "hsl(36 29% 70%)" }}>
            {t === "monitor" ? "🔴 Live Monitor" : t === "reports" ? "📋 Reports" : t === "events" ? "🎟 Events" : t === "locks" ? "🔓 Locks" : t === "happy-hour" ? "Happy Hour" : t === "aggregator" ? "Aggregators" : t === "dashboard" ? "📊 Legacy Dashboard" : t === "tablet" ? "🖨 This Tablet" : t === "settings" ? "⚙️ Settings" : t === "menu-editor" ? "📋 Menu Editor" : t === "menu" ? "OOS / Discount" : t === "attendance" ? "📍 Attendance" : t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      <div className="p-4">
        {tab === "monitor" && <LiveMonitor />}
        {tab === "reports" && <Reports />}

        {tab === "events" && <EventsAdmin />}

        {tab === "locks" && <CaptainLocksTab adminName={currentStaff?.name || "admin"} />}

        {tab === "dashboard" && (
          // Embed the full hodclub.in admin dashboard (copied to public/admin.html).
          // Same Firestore project (hod-tickets), same admin token, identical UI.
          // Only visible here because the parent route already enforced
          // hasRole("admin","manager") via staff PIN — door staff cannot reach this.
          <div>
            <div className="flex items-center gap-2 mb-3 flex-wrap">
              <span className="text-xs" style={{ color: "hsl(36 29% 50%)" }}>
                Live mirror of hodclub.in admin dashboard — same data, same controls.
              </span>
              <div className="flex-1" />
              <button onClick={() => window.open("/admin.html?admin=hod_k9x7_dpm26_mQ3r", "_blank", "noopener")}
                className="px-3 py-1 rounded text-xs font-medium"
                style={{ background: "rgba(201,168,76,.15)", border: "1px solid rgba(201,168,76,.35)", color: "#C9A84C" }}>
                ↗ Open in New Tab
              </button>
            </div>
            <iframe
              src="/admin.html?admin=hod_k9x7_dpm26_mQ3r"
              title="HOD Admin Dashboard"
              style={{ width: "100%", height: "calc(100vh - 220px)", minHeight: 500, border: "1px solid hsl(240 8% 18%)", borderRadius: 10, background: "#fff" }}
            />
          </div>
        )}

        {tab === "menu-editor" && <MenuEditor currentStaff={currentStaff} />}

        {tab === "menu" && (
          <div>
            <input
              type="text" placeholder="Search menu items..."
              value={menuSearch} onChange={(e) => setMenuSearch(e.target.value)}
              className="w-full px-4 py-2 rounded-lg text-sm mb-3"
              style={{ background: "hsl(240 12% 8%)", border: "1px solid hsl(240 8% 18%)", color: "hsl(36 29% 93%)" }}
            />
            {/* 🔴 UX 2026-05-10 — BULK DISCOUNT row (Khushi happy-hour ask) */}
            <div className="flex items-center gap-2 mb-3 flex-wrap">
              <button
                onClick={setBulkDiscount}
                className="px-3 py-2 rounded-lg text-xs font-bold"
                style={{ background: "rgba(34,197,94,.15)", border: "1px solid rgba(34,197,94,.45)", color: "#22c55e" }}>
                💰 BULK DISCOUNT — {menuSearch ? `${filteredMenu.length} FILTERED` : `ALL ${HOD_MENU_ITEMS.length}`} ITEMS
              </button>
              <span className="text-xs" style={{ color: "hsl(36 29% 50%)" }}>
                One-tap happy-hour: set/clear same % on every visible item. OOS items auto-skipped.
              </span>
            </div>
            <div className="text-xs mb-2" style={{ color: "hsl(36 29% 50%)" }}>
              💡 OOS + DISCOUNT CHANGES SYNC LIVE TO CAPTAIN, BAR &amp; CUSTOMER WALLET (HODCLUB.IN). MANAGER PIN REQUIRED.
            </div>
            <div className="space-y-1 max-h-[70vh] overflow-y-auto">
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
                  <div key={item.id} className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg"
                    style={{ background: "hsl(240 12% 5%)", opacity: isOOS ? 0.5 : 1 }}>
                    <div className="flex-1 min-w-0">
                      <span className="text-sm">{item.name}</span>
                      <span className="text-xs ml-2" style={{ color: "hsl(36 29% 50%)" }}>
                        {HOD_CATEGORY_LABELS[item.category] || item.category} ·{" "}
                        {hasDiscount ? (
                          <>
                            <span style={{ textDecoration: "line-through", color: "hsl(36 29% 35%)" }}>{formatINR(item.price)}</span>
                            {" → "}
                            <span style={{ color: "#22c55e", fontWeight: 700 }}>{formatINR(effPrice)}</span>
                            <span style={{ color: "#22c55e", marginLeft: 6 }}>
                              ({dPct ? `${dPct}% OFF` : `₹${dAmt} OFF`})
                            </span>
                          </>
                        ) : (
                          formatINR(item.price)
                        )}
                      </span>
                      {item.isVeg !== undefined && (
                        <span className="ml-2 text-xs" style={{ color: item.isVeg ? "#22c55e" : "#ef4444" }}>
                          {item.isVeg ? "●VEG" : "●NV"}
                        </span>
                      )}
                      {ov?.discountReason && (
                        <div className="text-xs mt-0.5" style={{ color: "hsl(36 29% 45%)" }}>
                          📝 {ov.discountReason}
                        </div>
                      )}
                    </div>
                    <button
                      onClick={() => setItemDiscount(item.name, item.price)}
                      className="px-3 py-1 rounded text-xs font-medium"
                      style={{
                        background: hasDiscount ? "rgba(34,197,94,.15)" : "rgba(201,168,76,.15)",
                        border: `1px solid ${hasDiscount ? "rgba(34,197,94,.5)" : "rgba(201,168,76,.4)"}`,
                        color: hasDiscount ? "#22c55e" : "#C9A84C",
                        whiteSpace: "nowrap",
                      }}
                    >
                      💰 {hasDiscount ? "EDIT" : "DISCOUNT"}
                    </button>
                    <button
                      onClick={() => toggleOutOfStock(item.name)}
                      className="px-3 py-1 rounded text-xs font-medium"
                      style={{
                        background: isOOS ? "#22c55e" : "#ef4444",
                        color: "#fff",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {isOOS ? "BACK IN STOCK" : "OUT OF STOCK"}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {tab === "staff" && <StaffManagement />}

        {tab === "attendance" && <AttendanceAdmin />}

        {tab === "happy-hour" && (
          <div className="max-w-md">
            <div className="p-4 rounded-lg" style={{ background: "hsl(240 12% 5%)", border: "1px solid hsl(240 8% 18%)" }}>
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-semibold" style={{ color: "#C9A84C" }}>Happy Hour Settings</h3>
                <button onClick={() => { setHhForm(f => ({...f, enabled: !f.enabled})); setEditingHH(true); }}
                  className="px-3 py-1 rounded text-xs font-medium"
                  style={{ background: hhForm.enabled ? "#22c55e" : "#ef4444", color: "#fff" }}>
                  {hhForm.enabled ? "ON" : "OFF"}
                </button>
              </div>
              <div className="space-y-4">
                <div>
                  <label className="text-xs block mb-1" style={{ color: "hsl(36 29% 60%)" }}>Active Days</label>
                  <div className="flex gap-1">
                    {dayLabels.map((d, i) => (
                      <button key={i} onClick={() => { setHhForm(f => ({...f, days: f.days.includes(i) ? f.days.filter(x => x !== i) : [...f.days, i]})); setEditingHH(true); }}
                        className="w-10 h-8 rounded text-xs font-medium"
                        style={{ background: hhForm.days.includes(i) ? "#C9A84C" : "hsl(240 12% 10%)", color: hhForm.days.includes(i) ? "#030305" : "hsl(36 29% 60%)" }}>
                        {d}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="flex gap-4">
                  <div>
                    <label className="text-xs block mb-1" style={{ color: "hsl(36 29% 60%)" }}>Start Time</label>
                    <input type="time" value={hhForm.startTime} onChange={(e) => { setHhForm(f => ({...f, startTime: e.target.value})); setEditingHH(true); }}
                      className="px-3 py-2 rounded text-sm" style={{ background: "hsl(240 12% 8%)", border: "1px solid hsl(240 8% 18%)", color: "hsl(36 29% 93%)" }} />
                  </div>
                  <div>
                    <label className="text-xs block mb-1" style={{ color: "hsl(36 29% 60%)" }}>End Time</label>
                    <input type="time" value={hhForm.endTime} onChange={(e) => { setHhForm(f => ({...f, endTime: e.target.value})); setEditingHH(true); }}
                      className="px-3 py-2 rounded text-sm" style={{ background: "hsl(240 12% 8%)", border: "1px solid hsl(240 8% 18%)", color: "hsl(36 29% 93%)" }} />
                  </div>
                </div>
                <div>
                  <label className="text-xs block mb-1" style={{ color: "hsl(36 29% 60%)" }}>Discount %</label>
                  <input type="number" value={hhForm.discountPercent} onChange={(e) => { setHhForm(f => ({...f, discountPercent: Number(e.target.value)})); setEditingHH(true); }}
                    className="px-3 py-2 rounded text-sm w-24" style={{ background: "hsl(240 12% 8%)", border: "1px solid hsl(240 8% 18%)", color: "hsl(36 29% 93%)" }} />
                </div>
                <p className="text-xs" style={{ color: "hsl(36 29% 50%)" }}>Applies to all food and drink items during active hours.</p>
                {editingHH && (
                  <button onClick={handleSaveHappyHour} className="w-full py-2 rounded-lg text-sm font-semibold" style={{ background: "#C9A84C", color: "#030305" }}>
                    Save Happy Hour Settings
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

        {tab === "tablet" && (
          <div className="max-w-xl space-y-4">
            <div className="p-4 rounded-lg" style={{ background: "hsl(240 12% 5%)", border: "1px solid hsl(240 8% 18%)" }}>
              <h3 className="text-sm font-semibold mb-2" style={{ color: "#C9A84C" }}>🖨 Set This Tablet's Floor</h3>
              <p className="text-xs mb-4" style={{ color: "hsl(36 29% 60%)" }}>
                When a captain on this tablet fires a KOT, drinks print to <b>this floor's bar printer</b> and bills print to <b>this floor's bill printer</b>. Food always goes to the kitchen. Set this once per tablet.
              </p>
              <div className="grid grid-cols-3 gap-2 mb-3">
                {(["ground", "first", "rooftop"] as const).map((f) => {
                  const isSel = tabletFloor === f;
                  const label = f === "ground" ? "Ground Floor" : f === "first" ? "First Floor" : "Rooftop";
                  return (
                    <button key={f} onClick={() => { setTabletFloor(f); setTabletFloorState(f); }}
                      className="px-3 py-3 rounded-lg text-sm font-semibold"
                      style={{ background: isSel ? "#C9A84C" : "hsl(240 12% 10%)", color: isSel ? "#030305" : "hsl(36 29% 70%)", border: isSel ? "2px solid #C9A84C" : "1px solid hsl(240 8% 18%)" }}>
                      {label}
                    </button>
                  );
                })}
              </div>
              <div className="text-xs p-3 rounded" style={{ background: "hsl(240 12% 3%)", color: tabletFloor ? "#22c55e" : "#ef4444" }}>
                {tabletFloor
                  ? `✅ This tablet is bound to ${tabletFloor === "ground" ? "Ground Floor" : tabletFloor === "first" ? "First Floor" : "Rooftop"}. Drink/bill destinations will route to ${tabletFloor === "ground" ? "GF" : tabletFloor === "first" ? "FF" : "RT"} printers.`
                  : "⚠️ No floor set. Drinks/bills will default to FF printers. Pick a floor above."}
              </div>
            </div>
            <div className="p-4 rounded-lg text-xs space-y-2" style={{ background: "hsl(240 12% 3%)", border: "1px dashed hsl(240 8% 18%)", color: "hsl(36 29% 60%)" }}>
              <div><b style={{ color: "#C9A84C" }}>How printing works (Cloud-Routed):</b></div>
              <div>1. Captain hits Fire KOT → KOT written to Firestore with item destination tags.</div>
              <div>2. Each floor's PC runs <code>print-server</code>, subscribes to Firestore, claims items for its destinations, prints over TCP to local Ethernet printers.</div>
              <div>3. Mixed orders auto-split: e.g. 1 beer + 1 tikka on a Rooftop tablet → beer prints at RT bar, tikka prints in kitchen, no duplication.</div>
              <div>4. Works offline (Firestore SDK queues writes); recovers if a floor PC reboots.</div>
              <div className="pt-2 border-t" style={{ borderColor: "hsl(240 8% 13%)" }}>Full architecture: see <code>replit.md → 🖨 KOT PRINTING ARCHITECTURE</code>.</div>
            </div>
          </div>
        )}

        {tab === "settings" && (
          <div className="max-w-xl space-y-4">
            <div className="p-4 rounded-lg" style={{ background: "hsl(240 12% 5%)", border: "1px solid hsl(240 8% 18%)" }}>
              <h3 className="text-sm font-semibold mb-1" style={{ color: "#C9A84C" }}>💳 Default Card Machine</h3>
              <p className="text-xs mb-3" style={{ color: "hsl(36 29% 60%)" }}>
                Venue-wide default for Door Mode card swipes. Takes effect on the next bouncer who opens Door Mode — no rebuild needed. Tablets that have been individually paired to a specific machine keep their per-device override.
                {!FEATURES.edc && <><br /><span style={{ color: "#EF4444" }}>⚠️ EDC feature flag (<code>VITE_EDC</code>) is OFF — this setting is ignored until EDC is enabled in the build.</span></>}
              </p>
              <div className="grid grid-cols-2 gap-2 mb-3">
                {(["razorpay", "pinelabs"] as const).map((v) => {
                  const sel = edcDefaultVendor === v;
                  const label = v === "razorpay" ? "Razorpay POS" : "Pine Labs Plutus";
                  return (
                    <button key={v} onClick={() => handleEdcVendorChange(v)} disabled={edcSaving}
                      className="px-3 py-3 rounded-lg text-sm font-semibold"
                      style={{ background: sel ? "#C9A84C" : "hsl(240 12% 10%)", color: sel ? "#030305" : "hsl(36 29% 70%)", border: sel ? "2px solid #C9A84C" : "1px solid hsl(240 8% 18%)", cursor: edcSaving ? "wait" : "pointer", opacity: edcSaving ? 0.7 : 1 }}>
                      {label}{sel ? " ✓" : ""}
                    </button>
                  );
                })}
              </div>
              <div className="text-xs p-3 rounded" style={{ background: "hsl(240 12% 3%)", color: edcDefaultVendor ? "#22c55e" : "hsl(36 29% 60%)" }}>
                {edcSaveMsg
                  ? edcSaveMsg
                  : edcDefaultVendor
                    ? `✅ Venue default: ${edcDefaultVendor === "razorpay" ? "Razorpay POS" : "Pine Labs Plutus"}.`
                    : `No venue default set yet — Door Mode falls back to the build-time default (${(import.meta.env.VITE_EDC_VENDOR as string) === "pinelabs" ? "Pine Labs" : "Razorpay POS"}).`}
              </div>
            </div>
          </div>
        )}

        {tab === "aggregator" && (
          <div className="space-y-4">
            {aggSettings.map((agg) => (
              <div key={agg.name} className="p-4 rounded-lg" style={{ background: "hsl(240 12% 5%)", border: "1px solid hsl(240 8% 18%)" }}>
                <h3 className="text-sm font-semibold mb-3" style={{ color: "#C9A84C" }}>{agg.displayName}</h3>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs block mb-1" style={{ color: "hsl(36 29% 60%)" }}>Commission %</label>
                    <input type="number" value={agg.commissionPercent}
                      onChange={(e) => updateAggregatorSettings(agg.name, { ...agg, commissionPercent: Number(e.target.value) })}
                      className="px-3 py-2 rounded text-sm w-full" style={{ background: "hsl(240 12% 8%)", border: "1px solid hsl(240 8% 18%)", color: "hsl(36 29% 93%)" }} />
                  </div>
                  <div>
                    <label className="text-xs block mb-1" style={{ color: "hsl(36 29% 60%)" }}>Current Discount Tier %</label>
                    <input type="number" value={agg.currentDiscountTier}
                      onChange={(e) => updateAggregatorSettings(agg.name, { ...agg, currentDiscountTier: Number(e.target.value) })}
                      className="px-3 py-2 rounded text-sm w-full" style={{ background: "hsl(240 12% 8%)", border: "1px solid hsl(240 8% 18%)", color: "hsl(36 29% 93%)" }} />
                  </div>
                  <div>
                    <label className="text-xs block mb-1" style={{ color: "hsl(36 29% 60%)" }}>Monthly Ad Budget</label>
                    <input type="number" value={agg.monthlyAdBudget}
                      onChange={(e) => updateAggregatorSettings(agg.name, { ...agg, monthlyAdBudget: Number(e.target.value) })}
                      className="px-3 py-2 rounded text-sm w-full" style={{ background: "hsl(240 12% 8%)", border: "1px solid hsl(240 8% 18%)", color: "hsl(36 29% 93%)" }} />
                  </div>
                  <div>
                    <label className="text-xs block mb-1" style={{ color: "hsl(36 29% 60%)" }}>GST on Commission %</label>
                    <input type="number" value={agg.commissionGstPercent}
                      onChange={(e) => updateAggregatorSettings(agg.name, { ...agg, commissionGstPercent: Number(e.target.value) })}
                      className="px-3 py-2 rounded text-sm w-full" style={{ background: "hsl(240 12% 8%)", border: "1px solid hsl(240 8% 18%)", color: "hsl(36 29% 93%)" }} />
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════
// V3 2026-05-10 — CAPTAIN VOID LOCKS TAB (Anti-Fraud #A2)
// ────────────────────────────────────────────────────────────────────────
// Lists every captain auto-suspended from voiding tonight (5 voids OR
// ₹3000 cap). Admin (PIN 9999) can unlock per-captain. The unlock event
// resets the night counter to 0 and is recorded with admin name + ts on
// the same captainVoidStats doc.
// Fallback: if Firestore read fails, show a clear empty state + Refresh.
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
      // V3 2026-05-10 — friendly path for the rules-not-yet-deployed case so
      // Khushi sees an actionable copy-paste block instead of a red wall.
      // Clear rows on rules-missing so a previous successful load doesn't
      // leave stale suspended-captain cards stuck under the new banner.
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
          <h3 className="text-lg font-semibold" style={{ color: "#C9A84C" }}>🔓 Captain Void Locks</h3>
          <p className="text-xs" style={{ color: "hsl(36 29% 60%)" }}>
            Auto-suspended captains for tonight (cap: 5 voids OR ₹3000). Admin PIN required to unlock.
          </p>
        </div>
        <button onClick={load} className="px-3 py-1.5 rounded text-xs font-medium"
          style={{ background: "rgba(201,168,76,.12)", border: "1px solid #C9A84C", color: "#C9A84C" }}>
          🔄 Refresh
        </button>
      </div>

      {loading && <div className="text-center py-12 text-sm" style={{ color: "hsl(36 29% 60%)" }}>Loading...</div>}
      {error && (
        <div className="p-3 rounded mb-3" style={{ background: "rgba(239,68,68,.1)", border: "1px solid #EF4444", color: "#EF4444", fontSize: 13 }}>
          ⚠ {error}
        </div>
      )}
      {rulesMissing && (
        <div className="p-4 rounded mb-3" style={{ background: "rgba(245,158,11,.08)", border: "1px solid rgba(245,158,11,.4)" }}>
          <div style={{ fontSize: 14, fontWeight: 900, color: "#F59E0B", marginBottom: 6 }}>
            🛠 ONE-TIME FIRESTORE RULES PATCH NEEDED
          </div>
          <div style={{ fontSize: 12, color: "rgba(255,255,255,.75)", marginBottom: 10, lineHeight: 1.5 }}>
            The Captain Void Cap (anti-fraud #A2) needs <strong>2 small Firestore rule blocks</strong> deployed once.
            Until then, voids still work fine — there's just no nightly cap and this tab can't list locks.
            <br /><br />
            <strong>WHAT TO DO:</strong> Open Firebase Console → Firestore → Rules. Paste the blocks below into your <code>match /databases/&#123;db&#125;/documents</code> section, then click <strong>Publish</strong>.
          </div>
          <pre style={{ background: "#000", border: "1px solid rgba(245,158,11,.3)", borderRadius: 8, padding: 12, fontSize: 11, color: "#C9A84C", overflow: "auto", lineHeight: 1.5, fontFamily: "monospace" }}>
{`// HOD anti-fraud collections — POS captain void cap + customer notify queue
match /captainVoidStats/{docId} {
  allow read, write: if request.auth != null;
}
match /voidNotificationsQueue/{docId} {
  allow create, read: if request.auth != null;
  allow update: if request.auth != null;
}`}
          </pre>
          <div style={{ fontSize: 11, color: "rgba(255,255,255,.5)", marginTop: 8 }}>
            Full copy-paste with context lives in <code>hod-functions-patch/firestore.rules.patch.md</code>.
            After Publish, tap <strong>🔄 Refresh</strong> above — this banner disappears and Locks goes live.
          </div>
        </div>
      )}

      {!loading && !error && !rulesMissing && rows.length === 0 && (
        <div className="text-center py-12 rounded" style={{ border: "1px dashed hsl(240 8% 18%)", color: "hsl(36 29% 50%)" }}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>✅</div>
          <div style={{ fontSize: 14, fontWeight: 700, color: "#fff" }}>NO CAPTAINS LOCKED TONIGHT</div>
          <div style={{ fontSize: 12, marginTop: 4 }}>Everyone's voids are within the daily cap.</div>
        </div>
      )}

      {!loading && !error && !rulesMissing && rows.length > 0 && (
        <div className="flex flex-col gap-2">
          {rows.map((r) => (
            <div key={r.id} className="p-4 rounded" style={{ background: "rgba(239,68,68,.08)", border: "1px solid rgba(239,68,68,.4)" }}>
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div style={{ minWidth: 0 }}>
                  <div className="flex items-center gap-2 mb-1 flex-wrap">
                    <span style={{ fontSize: 16, fontWeight: 900, color: "#fff" }}>{r.captainName.toUpperCase()}</span>
                    <span style={{ background: "rgba(239,68,68,.25)", color: "#EF4444", fontSize: 10, fontWeight: 900, padding: "2px 6px", borderRadius: 4, letterSpacing: .5 }}>
                      🚫 SUSPENDED
                    </span>
                  </div>
                  <div style={{ fontSize: 13, color: "rgba(255,255,255,.85)", marginBottom: 2 }}>
                    {r.voidCount} voids · ₹{r.voidValue.toLocaleString("en-IN")} total
                  </div>
                  <div style={{ fontSize: 11, color: "rgba(255,255,255,.55)" }}>
                    {r.suspendReason || "Cap exceeded"}
                    {r.suspendedAt && ` · at ${new Date(r.suspendedAt).toLocaleString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false })}`}
                  </div>
                </div>
                <button
                  onClick={() => handleUnlock(r)}
                  disabled={unlocking === r.id}
                  style={{
                    padding: "10px 18px", borderRadius: 10,
                    background: "rgba(0,200,100,.15)", border: "1px solid #00C864",
                    color: "#00C864", fontSize: 13, fontWeight: 800, cursor: "pointer",
                    opacity: unlocking === r.id ? .6 : 1,
                  }}>
                  {unlocking === r.id ? "Unlocking..." : "🔓 Unlock"}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="mt-6 p-3 rounded text-xs" style={{ background: "hsl(240 12% 6%)", border: "1px solid hsl(240 8% 18%)", color: "hsl(36 29% 60%)" }}>
        <div style={{ color: "#C9A84C", fontWeight: 700, marginBottom: 4 }}>HOW THIS WORKS</div>
        <div style={{ lineHeight: 1.6 }}>
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
