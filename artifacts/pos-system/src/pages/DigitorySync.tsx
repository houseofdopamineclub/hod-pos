// 🆕 2026-05-28 v3.140 — DIGITORY (DigiPoS) item-code mapping admin tab.
import { useEffect, useMemo, useState } from "react";
import { HOD_MENU_ITEMS, HOD_CATEGORY_LABELS } from "@/lib/hod-menu";
import { menuOverrideKey } from "@/lib/firestore";
import {
  subscribeToDigitoryMappings,
  upsertDigitoryMapping,
  deleteDigitoryMapping,
  type DigitoryItemMapping,
} from "@/lib/firestore-hod";
import { formatINR } from "@/lib/utils-pos";

const RED = "#ef4444";
const GREEN = "#22c55e";
const SHADOW_SM = "2px 2px 0px #000";
const SHADOW_MD = "3px 3px 0px #000";

interface Props { currentStaff?: { name?: string } | null }

export default function DigitorySync({ currentStaff }: Props) {
  const [mappings, setMappings] = useState<Record<string, DigitoryItemMapping>>({});
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "unmapped" | "mapped">("all");
  const [dirty, setDirty] = useState<Record<string, string>>({});
  const [savingSlug, setSavingSlug] = useState<string | null>(null);
  const [errBySlug, setErrBySlug] = useState<Record<string, string>>({});
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkText, setBulkText] = useState("");
  const [bulkResult, setBulkResult] = useState<string | null>(null);

  useEffect(() => subscribeToDigitoryMappings(setMappings), []);

  const staffName = currentStaff?.name || "admin";

  const rows = useMemo(() => {
    return HOD_MENU_ITEMS.map((item: any) => {
      const slug = menuOverrideKey(item.name);
      const mapping = mappings[slug];
      const code = dirty[slug] !== undefined ? dirty[slug] : (mapping?.digitoryItemNumber || "");
      return { item, slug, mapping, code, mapped: !!mapping?.digitoryItemNumber };
    });
  }, [mappings, dirty]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (filter === "unmapped" && r.mapped) return false;
      if (filter === "mapped" && !r.mapped) return false;
      if (!q) return true;
      return r.item.name.toLowerCase().includes(q) || r.slug.includes(q) || (r.code && r.code.toLowerCase().includes(q));
    });
  }, [rows, search, filter]);

  const totals = useMemo(() => {
    const mapped = rows.filter((r) => r.mapped).length;
    return { mapped, unmapped: rows.length - mapped, total: rows.length };
  }, [rows]);

  async function saveRow(slug: string, hodName: string, code: string) {
    setSavingSlug(slug);
    setErrBySlug((e) => { const { [slug]: _, ...rest } = e; return rest; });
    try {
      const trimmed = code.trim();
      if (!trimmed) await deleteDigitoryMapping(slug);
      else await upsertDigitoryMapping(slug, { hodName, digitoryItemNumber: trimmed }, staffName);
      setDirty((d) => { const { [slug]: _, ...rest } = d; return rest; });
    } catch (err: any) {
      setErrBySlug((e) => ({ ...e, [slug]: err?.message || "Save failed" }));
    } finally { setSavingSlug(null); }
  }

  async function runBulkImport() {
    setBulkResult(null);
    const lines = bulkText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    let ok = 0, skip = 0, err = 0;
    const errs: string[] = [];
    const bySlug = new Map<string, { slug: string; name: string }>();
    const byName = new Map<string, { slug: string; name: string }>();
    HOD_MENU_ITEMS.forEach((item: any) => {
      const slug = menuOverrideKey(item.name);
      bySlug.set(slug, { slug, name: item.name });
      byName.set(item.name.trim().toLowerCase(), { slug, name: item.name });
    });
    for (const line of lines) {
      const parts = line.split(/[,\t]/).map((p) => p.trim());
      if (parts.length < 2) { skip++; continue; }
      const [keyRaw, codeRaw] = parts;
      const key = keyRaw.toLowerCase();
      const code = codeRaw;
      const hit = bySlug.get(key) || byName.get(key);
      if (!hit) { skip++; errs.push(`No HOD item: "${keyRaw}"`); continue; }
      try {
        if (!code) await deleteDigitoryMapping(hit.slug);
        else await upsertDigitoryMapping(hit.slug, { hodName: hit.name, digitoryItemNumber: code }, staffName);
        ok++;
      } catch (e: any) { err++; errs.push(`${hit.name}: ${e?.message || "save error"}`); }
    }
    setBulkResult(`✅ ${ok} saved · ⚠️ ${skip} skipped · ❌ ${err} failed` +
      (errs.length ? `\n\nIssues:\n${errs.slice(0, 10).join("\n")}${errs.length > 10 ? `\n…and ${errs.length - 10} more` : ""}` : ""));
  }

  return (
    <div className="space-y-3" style={{ color: "#000" }}>
      {/* HEADER + STATUS */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div style={{ fontSize: 20, fontWeight: 900, color: "#000", textTransform: "uppercase", letterSpacing: "-.5px" }}>
          🔗 Digitory Sync — Item Mapping
        </div>
        <div className="flex gap-2 items-center text-xs">
          <span style={{ padding: "4px 10px", fontWeight: 700, background: "#E8FFF5", color: GREEN, border: `2px solid ${GREEN}` }}>
            ✓ {totals.mapped} MAPPED
          </span>
          <span style={{ padding: "4px 10px", fontWeight: 700, background: "#FFF0EE", color: RED, border: `2px solid ${RED}` }}>
            ⚠ {totals.unmapped} UNMAPPED
          </span>
          <span style={{ fontSize: 11, color: "#888", fontWeight: 500 }}>of {totals.total} items</span>
        </div>
      </div>

      {/* INTRO BANNER */}
      <div style={{ padding: 12, background: "#fff", border: "2px solid #000", fontSize: 12, color: "#444", lineHeight: 1.6, fontWeight: 500 }}>
        <b style={{ color: "#000" }}>WHAT THIS IS:</b> Digitory identifies items by numeric code (<code>item_number</code>). HOD identifies items by name. This screen maps the two. ✏️ Type each item's Digitory code (find it in your Digitory dashboard → Menu → click an item → see ID). Use the <b>📋 Bulk Import</b> button to paste a whole CSV at once.<br />
        <b style={{ color: "#000" }}>🛟 SAFE:</b> Nothing is pushed to Digitory yet — this just stores the mapping. The Cloud Function that uses it ships next week after Digitory shares prod URL + auth.
      </div>

      {/* CONTROLS */}
      <div className="flex flex-wrap gap-2 items-center">
        <input
          type="text" placeholder="Search by item name, slug, or Digitory code…"
          value={search} onChange={(e) => setSearch(e.target.value)}
          style={{ flex: 1, minWidth: 200, padding: "8px 12px", fontSize: 13, background: "#fff", border: "2px solid #000", color: "#000" }}
        />
        <div className="flex gap-1">
          {(["all", "unmapped", "mapped"] as const).map((f) => (
            <button key={f} onClick={() => setFilter(f)}
              style={{
                padding: "7px 12px", fontSize: 12, fontWeight: 700, textTransform: "uppercase", cursor: "pointer",
                background: filter === f ? "#FF90E8" : "#fff",
                color: "#000",
                border: "2px solid #000",
                boxShadow: filter === f ? SHADOW_MD : SHADOW_SM,
                transform: filter === f ? "translate(-1px,-1px)" : "none",
              }}>
              {f}
            </button>
          ))}
        </div>
        <button onClick={() => setBulkOpen((v) => !v)}
          style={{ padding: "7px 14px", fontSize: 12, fontWeight: 700, cursor: "pointer", background: "#FFFBEB", color: "#000", border: "2px solid #F2C744", boxShadow: SHADOW_SM }}>
          📋 BULK IMPORT (CSV)
        </button>
      </div>

      {/* BULK IMPORT PANEL */}
      {bulkOpen && (
        <div style={{ padding: 14, background: "#fff", border: "2px solid #000", display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ fontSize: 12, color: "#555", fontWeight: 500 }}>
            Paste two columns separated by <b>comma</b> or <b>tab</b>: <code>HOD ITEM NAME, DIGITORY CODE</code> — one per line. Empty code = remove mapping. Slug also accepted (e.g. <code>old-monk-90ml</code>).
          </div>
          <textarea value={bulkText} onChange={(e) => setBulkText(e.target.value)}
            placeholder={"OLD MONK 90ML, 10234\nCHICKEN TIKKA, 20188\nPEPSI, 30002"}
            rows={6}
            style={{ width: "100%", padding: "8px 10px", fontSize: 12, fontFamily: "monospace", background: "#F4F4F0", border: "2px solid #000", color: "#000", boxSizing: "border-box" }}
          />
          <div className="flex gap-2 items-center">
            <button onClick={runBulkImport} disabled={!bulkText.trim()}
              style={{ padding: "8px 16px", fontSize: 12, fontWeight: 900, cursor: "pointer", background: "#F2C744", color: "#000", border: "2px solid #000", boxShadow: SHADOW_SM, opacity: !bulkText.trim() ? .4 : 1 }}>
              IMPORT
            </button>
            <button onClick={() => { setBulkText(""); setBulkResult(null); }}
              style={{ padding: "8px 12px", fontSize: 12, cursor: "pointer", background: "#F4F4F0", color: "#000", border: "2px solid #000", boxShadow: SHADOW_SM }}>
              CLEAR
            </button>
          </div>
          {bulkResult && (
            <pre style={{ fontSize: 12, whiteSpace: "pre-wrap", padding: 10, background: "#F4F4F0", border: "2px solid #000", color: "#333" }}>{bulkResult}</pre>
          )}
        </div>
      )}

      {/* ITEM LIST */}
      <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: "70vh", overflowY: "auto" }}>
        {filtered.length === 0 && (
          <div style={{ textAlign: "center", padding: 32, fontSize: 13, color: "#888", fontWeight: 500, border: "2px dashed #ccc" }}>
            No items match.
          </div>
        )}
        {filtered.map((r) => {
          const isDirty = dirty[r.slug] !== undefined;
          const isSaving = savingSlug === r.slug;
          const rowErr = errBySlug[r.slug];
          return (
            <div key={r.slug}
              style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", background: "#fff", border: `2px solid ${r.mapped ? "#23A094" : RED}` }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, color: "#000", fontWeight: 600 }}>{r.item.name}</div>
                <div style={{ fontSize: 11, color: "#666", fontWeight: 500 }}>
                  {HOD_CATEGORY_LABELS[r.item.category] || r.item.category} · {formatINR(r.item.price)} · <code>{r.slug}</code>
                </div>
                {rowErr && <div style={{ fontSize: 11, marginTop: 2, color: RED, fontWeight: 600 }}>❌ {rowErr}</div>}
              </div>
              <input
                type="text" placeholder="Digitory code"
                value={r.code}
                onChange={(e) => setDirty((d) => ({ ...d, [r.slug]: e.target.value }))}
                style={{
                  padding: "6px 10px", fontSize: 13, fontFamily: "monospace", width: 140,
                  background: "#fff",
                  border: `2px solid ${isDirty ? "#F2C744" : "#ccc"}`,
                  color: r.mapped || isDirty ? "#000" : "#aaa",
                }}
              />
              <button
                onClick={() => saveRow(r.slug, r.item.name, r.code)}
                disabled={!isDirty || isSaving}
                style={{
                  padding: "6px 12px", fontSize: 12, fontWeight: 900, cursor: "pointer",
                  background: isDirty ? "#F2C744" : "#F4F4F0",
                  color: "#000",
                  border: "2px solid #000",
                  boxShadow: isDirty ? SHADOW_SM : "none",
                  opacity: !isDirty || isSaving ? .35 : 1,
                }}>
                {isSaving ? "…" : "SAVE"}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
