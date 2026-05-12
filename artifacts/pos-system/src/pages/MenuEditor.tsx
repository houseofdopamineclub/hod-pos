import { useEffect, useState } from "react";
import {
  subscribeToVenueMenuTab,
  saveVenueMenuTab,
  logAudit,
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
import type { StaffMember } from "@/lib/types";

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

export default function MenuEditor({ currentStaff }: Props) {
  const [tabId, setTabId] = useState<VenueMenuTabId>("food");
  const [remote, setRemote] = useState<VenueMenuTab | null>(null);
  // Local working copy — edits live here until "Publish" writes them back.
  const [draft, setDraft] = useState<VenueMenuCategory[]>([]);
  const [search, setSearch] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string>("");
  const [loaded, setLoaded] = useState(false);

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
      <div className="p-6 text-center rounded-lg" style={{ background: "hsl(240 12% 5%)", color: "#ef4444" }}>
        🔒 Menu Editor is restricted to admin / manager roles.
      </div>
    );
  }

  return (
    <div>
      {/* Tab selector */}
      <div className="flex gap-1 mb-3 flex-wrap">
        {VENUE_MENU_TAB_ORDER.map((t) => (
          <button
            key={t}
            onClick={() => {
              if (dirty && !window.confirm("You have unsaved changes. Discard them and switch tabs?")) return;
              setTabId(t);
            }}
            className="px-4 py-2 rounded-lg text-sm font-medium"
            style={{
              background: tabId === t ? "#C9A84C" : "hsl(240 12% 8%)",
              color: tabId === t ? "#030305" : "hsl(36 29% 70%)",
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
          style={{ background: "hsl(240 12% 8%)", border: "1px solid hsl(240 8% 18%)", color: "hsl(36 29% 93%)" }}
        />
        <button
          onClick={addCategory}
          className="px-3 py-2 rounded text-xs font-bold"
          style={{ background: "rgba(201,168,76,.15)", border: "1px solid rgba(201,168,76,.45)", color: "#C9A84C" }}>
          + Add Category
        </button>
        <button
          onClick={restoreDefaults}
          className="px-3 py-2 rounded text-xs font-medium"
          style={{ background: "hsl(240 12% 10%)", color: "hsl(36 29% 70%)", border: "1px solid hsl(240 8% 18%)" }}>
          ↺ Restore Defaults
        </button>
        <button
          onClick={publish}
          disabled={!dirty || saving}
          className="px-4 py-2 rounded text-sm font-bold"
          style={{
            background: dirty && !saving ? "#22c55e" : "hsl(240 12% 10%)",
            color: dirty && !saving ? "#030305" : "hsl(36 29% 50%)",
            cursor: dirty && !saving ? "pointer" : "not-allowed",
          }}>
          {saving ? "Publishing..." : dirty ? "💾 PUBLISH" : "✓ Saved"}
        </button>
      </div>

      <div className="text-xs mb-3" style={{ color: "hsl(36 29% 50%)" }}>
        💡 Edits stay local until you tap PUBLISH. Manager PIN required.
        Live on hodclub.in within seconds of publish (Firestore listener).
        {remote?.updatedBy && (
          <span> · Last published by <b>{remote.updatedBy}</b>.</span>
        )}
        {!remote && loaded && (
          <span style={{ color: "#C9A84C" }}> · This tab has never been published — current view is the seeded default.</span>
        )}
      </div>

      {/* Categories + items */}
      {!loaded && <div style={{ color: "hsl(36 29% 50%)" }}>Loading…</div>}
      {loaded && visible.length === 0 && (
        <div className="p-6 text-center rounded-lg" style={{ background: "hsl(240 12% 5%)", color: "hsl(36 29% 50%)" }}>
          {q ? "No items match your search." : "No categories yet — tap + Add Category."}
        </div>
      )}
      <div className="space-y-4 max-h-[65vh] overflow-y-auto">
        {visible.map((cat) => {
          // Map filtered category back to its real index in the draft so
          // mutators target the correct row even when search hides others.
          const realCi = draft.findIndex((c) => c.cat === cat.cat);
          return (
            <div key={cat.cat + realCi} className="rounded-lg p-3" style={{ background: "hsl(240 12% 5%)", border: "1px solid hsl(240 8% 15%)" }}>
              <div className="flex items-center gap-2 mb-2">
                <h3 className="text-sm font-bold flex-1" style={{ color: "#C9A84C" }}>{cat.cat}</h3>
                <span className="text-xs" style={{ color: "hsl(36 29% 50%)" }}>{cat.items.length} items</span>
                <button onClick={() => renameCategory(realCi)} className="text-xs px-2 py-1 rounded"
                  style={{ background: "hsl(240 12% 10%)", color: "hsl(36 29% 70%)" }}>Rename</button>
                <button onClick={() => deleteCategory(realCi)} className="text-xs px-2 py-1 rounded"
                  style={{ background: "rgba(239,68,68,.15)", color: "#ef4444" }}>Delete</button>
                <button onClick={() => addItem(realCi)} className="text-xs px-2 py-1 rounded font-bold"
                  style={{ background: "rgba(34,197,94,.15)", color: "#22c55e" }}>+ Item</button>
              </div>
              <div className="space-y-1">
                {cat.items.map((item) => {
                  // Same trick as above for item index inside the unfiltered draft.
                  const realIi = draft[realCi]?.items.findIndex((x) => x === draft[realCi].items.find((y) => y.n === item.n && y.p === item.p)) ?? -1;
                  // Fallback: find by reference identity via index in the visible cat.
                  const ii = draft[realCi]?.items.indexOf(item) ?? realIi;
                  return (
                    <div key={ii + item.n} className="flex items-center gap-2 px-2 py-1 rounded"
                      style={{ background: "hsl(240 12% 8%)", opacity: item.oos ? 0.5 : 1 }}>
                      <input
                        value={item.n}
                        onChange={(e) => updateItem(realCi, ii, { n: e.target.value })}
                        className="flex-1 px-2 py-1 rounded text-sm"
                        style={{ background: "hsl(240 12% 4%)", border: "1px solid hsl(240 8% 15%)", color: "hsl(36 29% 93%)" }}
                      />
                      <input
                        type="text"
                        value={item.sub || ""}
                        placeholder="sub-cat (e.g. 30ml)"
                        onChange={(e) => updateItem(realCi, ii, { sub: e.target.value || undefined })}
                        className="w-32 px-2 py-1 rounded text-xs"
                        style={{ background: "hsl(240 12% 4%)", border: "1px solid hsl(240 8% 15%)", color: "hsl(36 29% 75%)" }}
                        title="Optional sub-category label (serving size, variant, etc.)"
                      />
                      <input
                        type="number"
                        min={0}
                        value={item.p}
                        onChange={(e) => updateItem(realCi, ii, { p: Number(e.target.value) })}
                        className="w-24 px-2 py-1 rounded text-sm text-right"
                        style={{ background: "hsl(240 12% 4%)", border: "1px solid hsl(240 8% 15%)", color: "hsl(36 29% 93%)" }}
                      />
                      <span className="text-xs" style={{ color: "hsl(36 29% 50%)" }}>₹</span>
                      {tabId === "food" && (
                        <button
                          onClick={() => updateItem(realCi, ii, { v: !item.v })}
                          className="text-xs px-2 py-1 rounded font-bold"
                          style={{
                            background: item.v ? "rgba(34,197,94,.15)" : "rgba(239,68,68,.15)",
                            color: item.v ? "#22c55e" : "#ef4444",
                            minWidth: 50,
                          }}
                          title="Veg / Non-veg flag">
                          {item.v ? "● VEG" : "● NV"}
                        </button>
                      )}
                      <button
                        onClick={() => updateItem(realCi, ii, { oos: !item.oos })}
                        className="text-xs px-2 py-1 rounded"
                        style={{
                          background: item.oos ? "#ef4444" : "rgba(34,197,94,.15)",
                          color: item.oos ? "#fff" : "#22c55e",
                          minWidth: 90,
                        }}>
                        {item.oos ? "OUT" : "IN STOCK"}
                      </button>
                      <button
                        onClick={() => deleteItem(realCi, ii)}
                        className="text-xs px-2 py-1 rounded"
                        style={{ background: "rgba(239,68,68,.15)", color: "#ef4444" }}>✕</button>
                    </div>
                  );
                })}
                {cat.items.length === 0 && (
                  <div className="text-xs italic px-2 py-2" style={{ color: "hsl(36 29% 40%)" }}>
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
            background: message.startsWith("✅") ? "rgba(34,197,94,.1)" : "rgba(239,68,68,.1)",
            color: message.startsWith("✅") ? "#22c55e" : "#ef4444",
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
