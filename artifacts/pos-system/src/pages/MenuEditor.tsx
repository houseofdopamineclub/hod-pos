import { useEffect, useState } from "react";
import {
  subscribeToVenueMenuTab,
  saveVenueMenuTab,
  logAudit,
  setMenuOverride,
  subscribeToMenuOverrides,
  menuOverrideKey,
} from "@/lib/firestore";
import {
  VENUE_MENU_TAB_LABELS,
  VENUE_MENU_TAB_ORDER,
  defaultVenueMenuTab,
  type VenueMenuTabId,
  type VenueMenuCategory,
  type VenueMenuItem,
  type VenueMenuTab,
} from "@/lib/venue-menu";
import { sha256 } from "@/lib/firestore-hod";
import type { StaffMember, MenuOverride } from "@/lib/types";

// Same MGR PIN gate used elsewhere in AdminPage. Duplicated here so the
// MenuEditor page is self-contained and doesn't reach back into the parent.
const MANAGER_HASH = "2926a2731f4b312c08982cacf8061eb14bf65c1a87cc5d70e864e079c6220731";
async function requireManagerPin(reason: string): Promise<boolean> {
  const pin = window.prompt(`🔒 MANAGER PIN REQUIRED\n\n${reason}\n\nENTER 4-DIGIT MANAGER PIN:`);
  if (!pin) return false;
  const h = await sha256(pin.trim());
  if (h !== MANAGER_HASH) { alert("❌ WRONG MANAGER PIN."); return false; }
  return true;
}

interface Props {
  currentStaff: StaffMember | null;
}

// 🆕 2026-06-08 v3.240 — FULL Gumroad light restyle (cream/white, bold 2px black
// borders, pink #FF90E8 / orange #FF5733 / teal #23A094 accents, bold uppercase)
// so MENU mode matches Door & Captain. ALL logic/handlers are unchanged — only
// the inline styles changed.
const INK = "#000";
const PINK = "#FF90E8";
const ORANGE = "#FF5733";
const TEAL = "#23A094";
const RED = "#E11900";

export default function MenuEditor({ currentStaff }: Props) {
  const [tabId, setTabId] = useState<VenueMenuTabId>("food");
  const [remote, setRemote] = useState<VenueMenuTab | null>(null);
  // Local working copy — edits live here until "Publish" writes them back.
  const [draft, setDraft] = useState<VenueMenuCategory[]>([]);
  const [search, setSearch] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string>("");
  const [loaded, setLoaded] = useState(false);
  // 🆕 2026-06-14 v3.288 — live posMenuOverrides, the AUTHORITATIVE out-of-stock
  // source every OTHER mode (Bar/Captain/customer) reads. The venueMenu `oos`
  // draft flag is in-memory until PUBLISH, so without merging this the editor
  // showed an item back "IN STOCK" on re-entry even though the override (and
  // every other mode) still had it OUT. Keyed by name-slug (menuItemId).
  const [overrides, setOverrides] = useState<Record<string, MenuOverride>>({});

  // Subscribe to current tab. Whenever the remote doc changes we reset the
  // draft to it — the editor explicitly does NOT try to merge concurrent
  // edits (rare here, single-manager workflow) and instead trusts last write.
  useEffect(() => {
    setLoaded(false);
    setMessage("");
    const unsub = subscribeToVenueMenuTab(tabId, (t) => {
      setRemote(t);
      setDraft(t ? deepClone(t.categories) : deepClone(defaultVenueMenuTab(tabId).categories));
      setLoaded(true);
    });
    return unsub;
  }, [tabId]);

  // Authoritative OOS feed — independent of the per-tab venueMenu draft so the
  // displayed IN STOCK / OUT badge always reflects what Bar/Captain see.
  useEffect(() => subscribeToMenuOverrides(setOverrides), []);

  const dirty = loaded && JSON.stringify(draft) !== JSON.stringify(remote?.categories || []);

  // ── Mutators ─────────────────────────────────────────────────────────
  const updateItem = (ci: number, ii: number, patch: Partial<VenueMenuItem>) => {
    setDraft((d) => {
      const next = deepClone(d);
      next[ci].items[ii] = { ...next[ci].items[ii], ...patch };
      return next;
    });
  };
  const deleteItem = (ci: number, ii: number) => {
    const item = draft[ci].items[ii];
    if (!window.confirm(`Delete "${item.n}" from ${draft[ci].cat}?`)) return;
    setDraft((d) => {
      const next = deepClone(d);
      next[ci].items.splice(ii, 1);
      return next;
    });
  };
  const addItem = (ci: number) => {
    const isFood = tabId === "food";
    const isDrink = tabId === "liquor" || tabId === "nab";
    setDraft((d) => {
      const next = deepClone(d);
      next[ci].items.push({
        n: "New item",
        p: 0,
        t: isFood ? "food" : "drink",
        alc: tabId === "liquor",
        ...(isFood ? { v: true } : {}),
        ...(isDrink ? {} : {}),
      });
      return next;
    });
  };
  const renameCategory = (ci: number) => {
    const next = window.prompt("Rename category", draft[ci].cat);
    if (next === null) return;
    const trimmed = next.trim();
    if (!trimmed) return;
    setDraft((d) => {
      const out = deepClone(d);
      out[ci].cat = trimmed;
      return out;
    });
  };
  const deleteCategory = (ci: number) => {
    if (!window.confirm(`Delete entire category "${draft[ci].cat}" and its ${draft[ci].items.length} items?`)) return;
    setDraft((d) => {
      const out = deepClone(d);
      out.splice(ci, 1);
      return out;
    });
  };
  const addCategory = () => {
    const name = window.prompt("New category name (e.g. Cigarettes, Hookah, Mocktails)");
    if (!name) return;
    setDraft((d) => [...d, { cat: name.trim(), items: [] }]);
  };
  const restoreDefaults = async () => {
    if (!window.confirm(
      `Restore the default ${VENUE_MENU_TAB_LABELS[tabId]} menu? This wipes the current draft and seeds it from the canonical hardcoded list. You still have to Publish to push it live.`
    )) return;
    setDraft(deepClone(defaultVenueMenuTab(tabId).categories));
  };

  const publish = async () => {
    const itemCount = draft.reduce((n, c) => n + c.items.length, 0);
    // Sanity: catch obviously bad prices BEFORE the manager-PIN prompt.
    for (const c of draft) {
      for (const it of c.items) {
        if (!it.n.trim()) { alert(`❌ Item with empty name in "${c.cat}". Fix or delete it.`); return; }
        if (!isFinite(it.p) || it.p < 0) { alert(`❌ "${it.n}" has invalid price (${it.p}).`); return; }
      }
    }
    if (!(await requireManagerPin(
      `PUBLISH ${VENUE_MENU_TAB_LABELS[tabId]} menu — ${draft.length} categories, ${itemCount} items, live to hodclub.in immediately.`
    ))) return;
    setSaving(true);
    setMessage("");
    try {
      await saveVenueMenuTab(tabId, draft, currentStaff?.name || "admin");
      if (currentStaff) {
        await logAudit({
          action: "venue_menu_published",
          staffId: currentStaff.id || "",
          staffName: currentStaff.name,
          staffRole: currentStaff.role,
          details: { tabId, categoryCount: draft.length, itemCount },
        });
      }
      setMessage(`✅ Published ${itemCount} items to ${VENUE_MENU_TAB_LABELS[tabId]} — live on hodclub.in.`);
    } catch (e: any) {
      setMessage(`❌ Publish failed: ${e?.message || e}`);
    }
    setSaving(false);
  };

  // ── Filter for the search box ────────────────────────────────────────
  const q = search.trim().toLowerCase();
  const visible = q
    ? draft
        .map((c) => ({ ...c, items: c.items.filter((it) => it.n.toLowerCase().includes(q) || c.cat.toLowerCase().includes(q)) }))
        .filter((c) => c.items.length > 0)
    : draft;

  // Belt-and-braces role gate (declared AFTER all hooks so React's hook order
  // stays stable across renders). Parent AdminPage already enforces
  // hasRole("admin","manager") at the page level — this is a defence-in-depth
  // fallback if the role ever changes mid-session.
  const role = currentStaff?.role;
  if (role && role !== "admin" && role !== "manager") {
    return (
      <div className="p-6 text-center rounded-lg" style={{ background: "#fff", border: `2px solid ${INK}`, color: RED, fontWeight: 800 }}>
        🔒 Menu Editor is restricted to admin / manager roles.
      </div>
    );
  }

  return (
    <div>
      {/* Tab selector */}
      <div className="flex gap-2 mb-3 flex-wrap">
        {VENUE_MENU_TAB_ORDER.map((t) => (
          <button
            key={t}
            onClick={() => {
              if (dirty && !window.confirm("You have unsaved changes. Discard them and switch tabs?")) return;
              setTabId(t);
            }}
            className="px-4 py-2 rounded-lg text-sm"
            style={{
              background: tabId === t ? INK : "#fff",
              color: tabId === t ? "#fff" : INK,
              border: `2px solid ${INK}`,
              fontWeight: 900,
              letterSpacing: 0.4,
              textTransform: "uppercase",
            }}>
            {VENUE_MENU_TAB_LABELS[t]}
          </button>
        ))}
      </div>

      {/* Action bar */}
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <input
          type="text"
          placeholder="Search items / categories..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="px-3 py-2 rounded text-sm flex-1 min-w-[200px]"
          style={{ background: "#fff", border: `2px solid ${INK}`, color: INK, fontWeight: 600 }}
        />
        <button
          onClick={addCategory}
          className="px-3 py-2 rounded text-xs"
          style={{ background: PINK, border: `2px solid ${INK}`, color: INK, fontWeight: 900, letterSpacing: 0.3, textTransform: "uppercase" }}>
          + Add Category
        </button>
        <button
          onClick={restoreDefaults}
          className="px-3 py-2 rounded text-xs"
          style={{ background: "#fff", color: INK, border: `2px solid ${INK}`, fontWeight: 800, letterSpacing: 0.3, textTransform: "uppercase" }}>
          ↺ Restore Defaults
        </button>
        <button
          onClick={publish}
          disabled={!dirty || saving}
          className="px-4 py-2 rounded text-sm"
          style={{
            background: dirty && !saving ? TEAL : "#E8E8E2",
            color: dirty && !saving ? "#fff" : "#9A9A93",
            border: `2px solid ${dirty && !saving ? INK : "#CFCFC8"}`,
            fontWeight: 900,
            letterSpacing: 0.4,
            textTransform: "uppercase",
            cursor: dirty && !saving ? "pointer" : "not-allowed",
          }}>
          {saving ? "Publishing..." : dirty ? "💾 PUBLISH" : "✓ Saved"}
        </button>
      </div>

      <div className="text-xs mb-3" style={{ color: "#3D3D3D", fontWeight: 600 }}>
        💡 Edits stay local until you tap PUBLISH. Manager PIN required.
        Live on hodclub.in within seconds of publish (Firestore listener).
        {remote?.updatedBy && (
          <span> · Last published by <b style={{ color: INK }}>{remote.updatedBy}</b>.</span>
        )}
        {!remote && loaded && (
          <span style={{ color: ORANGE, fontWeight: 800 }}> · This tab has never been published — current view is the seeded default.</span>
        )}
      </div>

      {/* Categories + items */}
      {!loaded && <div style={{ color: "#3D3D3D", fontWeight: 700 }}>Loading…</div>}
      {loaded && visible.length === 0 && (
        <div className="p-6 text-center rounded-lg" style={{ background: "#fff", border: `2px solid ${INK}`, color: "#3D3D3D", fontWeight: 700 }}>
          {q ? "No items match your search." : "No categories yet — tap + Add Category."}
        </div>
      )}
      <div className="space-y-4 max-h-[65vh] overflow-y-auto">
        {visible.map((cat) => {
          // Map filtered category back to its real index in the draft so
          // mutators target the correct row even when search hides others.
          const realCi = draft.findIndex((c) => c.cat === cat.cat);
          return (
            <div key={cat.cat + realCi} className="rounded-lg p-3" style={{ background: "#fff", border: `2px solid ${INK}` }}>
              <div className="flex items-center gap-2 mb-2">
                <h3 className="text-sm flex-1" style={{ color: INK, fontWeight: 900, letterSpacing: 0.3, textTransform: "uppercase" }}>{cat.cat}</h3>
                <span className="text-xs" style={{ color: "#6B6B63", fontWeight: 700 }}>{cat.items.length} items</span>
                <button onClick={() => renameCategory(realCi)} className="text-xs px-2 py-1 rounded"
                  style={{ background: "#fff", color: INK, border: `2px solid ${INK}`, fontWeight: 800 }}>Rename</button>
                <button onClick={() => deleteCategory(realCi)} className="text-xs px-2 py-1 rounded"
                  style={{ background: ORANGE, color: INK, border: `2px solid ${INK}`, fontWeight: 800 }}>Delete</button>
                <button onClick={() => addItem(realCi)} className="text-xs px-2 py-1 rounded"
                  style={{ background: TEAL, color: "#fff", border: `2px solid ${INK}`, fontWeight: 800 }}>+ Item</button>
              </div>
              <div className="space-y-1">
                {cat.items.map((item) => {
                  // Same trick as above for item index inside the unfiltered draft.
                  const realIi = draft[realCi]?.items.findIndex((x) => x === draft[realCi].items.find((y) => y.n === item.n && y.p === item.p)) ?? -1;
                  // Fallback: find by reference identity via index in the visible cat.
                  const ii = draft[realCi]?.items.indexOf(item) ?? realIi;
                  // Effective OOS = authoritative override if one exists for this
                  // item name, else the local draft flag. This makes the badge
                  // survive leaving + re-entering the editor (the bug Khushi hit).
                  const liveOos = overrides[menuOverrideKey(item.n)]?.outOfStock;
                  const effOos = liveOos !== undefined ? liveOos : !!item.oos;
                  return (
                    <div key={ii + item.n} className="flex items-center gap-2 px-2 py-1 rounded"
                      style={{ background: "#FBFBF9", border: `1px solid ${INK}`, opacity: effOos ? 0.5 : 1 }}>
                      <input
                        value={item.n}
                        onChange={(e) => updateItem(realCi, ii, { n: e.target.value })}
                        className="flex-1 px-2 py-1 rounded text-sm"
                        style={{ background: "#fff", border: `1px solid ${INK}`, color: INK, fontWeight: 600 }}
                      />
                      <input
                        type="text"
                        value={item.sub || ""}
                        placeholder="sub-cat (e.g. 30ml)"
                        onChange={(e) => updateItem(realCi, ii, { sub: e.target.value || undefined })}
                        className="w-32 px-2 py-1 rounded text-xs"
                        style={{ background: "#fff", border: `1px solid ${INK}`, color: "#3D3D3D", fontWeight: 600 }}
                        title="Optional sub-category label (serving size, variant, etc.)"
                      />
                      <input
                        type="number"
                        min={0}
                        value={item.p}
                        onChange={(e) => updateItem(realCi, ii, { p: Number(e.target.value) })}
                        className="w-24 px-2 py-1 rounded text-sm text-right"
                        style={{ background: "#fff", border: `1px solid ${INK}`, color: INK, fontWeight: 700 }}
                      />
                      <span className="text-xs" style={{ color: INK, fontWeight: 800 }}>₹</span>
                      {tabId === "food" && (
                        <button
                          onClick={() => updateItem(realCi, ii, { v: !item.v })}
                          className="text-xs px-2 py-1 rounded"
                          style={{
                            background: item.v ? TEAL : ORANGE,
                            color: item.v ? "#fff" : INK,
                            border: `2px solid ${INK}`,
                            fontWeight: 900,
                            minWidth: 50,
                          }}
                          title="Veg / Non-veg flag">
                          {item.v ? "● VEG" : "● NV"}
                        </button>
                      )}
                      <button
                        onClick={async () => {
                          // 🔴 2026-05-25 (Khushi GO-LIVE fix) — the OOS button used
                          // to ONLY flip a local draft flag that needed Publish to
                          // reach hodclub.in, and NEVER reached Bar/Captain (which
                          // read posMenuOverrides, not venueMenu). Now it does BOTH:
                          //   (1) flips local draft (so Publish still propagates to
                          //       customer wallet's structural list), AND
                          //   (2) instantly writes posMenuOverrides → Bar + Captain
                          //       see it in <2s, AND hodclub.in wallet sees it via
                          //       the posMenuOverrides live listener (re-enabled
                          //       same night with a per-doc limit safety cap).
                          // Manager PIN gated so a misclick can't 86 an item.
                          const goingOOS = !effOos;
                          if (!(await requireManagerPin(
                            `${goingOOS ? "MARK OUT OF STOCK" : "MARK BACK IN STOCK"}: ${item.n}`
                          ))) return;
                          updateItem(realCi, ii, { oos: goingOOS });
                          try {
                            await setMenuOverride(item.n, {
                              outOfStock: goingOOS,
                              updatedBy: currentStaff?.name || "menu-editor",
                            });
                            if (currentStaff) {
                              await logAudit({
                                action: goingOOS ? "menu_out_of_stock" : "menu_back_in_stock",
                                staffId: currentStaff.id || "",
                                staffName: currentStaff.name,
                                staffRole: currentStaff.role,
                                details: { itemName: item.n, source: "menu_editor" },
                              });
                            }
                          } catch (e: any) {
                            // 🛟 FALLBACK — local draft flip already applied, so
                            // Publish would still eventually push it. Surface error.
                            alert(`⚠ OOS saved LOCALLY only — sync to Bar/Captain failed: ${e?.message || e}\nClick PUBLISH to retry, or use OOS/Discount tab.`);
                          }
                        }}
                        className="text-xs px-2 py-1 rounded"
                        style={{
                          background: effOos ? RED : "#fff",
                          color: effOos ? "#fff" : INK,
                          border: `2px solid ${INK}`,
                          fontWeight: 900,
                          minWidth: 90,
                        }}>
                        {effOos ? "OUT" : "IN STOCK"}
                      </button>
                      <button
                        onClick={() => deleteItem(realCi, ii)}
                        className="text-xs px-2 py-1 rounded"
                        style={{ background: ORANGE, color: INK, border: `2px solid ${INK}`, fontWeight: 900 }}>✕</button>
                    </div>
                  );
                })}
                {cat.items.length === 0 && (
                  <div className="text-xs italic px-2 py-2" style={{ color: "#6B6B63", fontWeight: 600 }}>
                    Empty category — add items or delete it.
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {message && (
        <div className="mt-3 px-3 py-2 rounded text-sm"
          style={{
            background: message.startsWith("✅") ? TEAL : RED,
            color: "#fff",
            border: `2px solid ${INK}`,
            fontWeight: 800,
          }}>
          {message}
        </div>
      )}
    </div>
  );
}

function deepClone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x));
}
