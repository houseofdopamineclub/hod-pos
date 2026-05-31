// 🆕 2026-05-28 v3.140 — DIGITORY (DigiPoS) item-code mapping admin tab.
// ─────────────────────────────────────────────────────────────────────
// Maps each HOD menu item (keyed by slug(name) via menuOverrideKey) to
// Digitory's numeric item_number. Required BEFORE the Cloud Function
// can push closed bills, because Digitory's /sale/.../editItem/{N} API
// rejects unknown numbers. Built ahead of Digitory auth/URL so Khushi
// can populate mapping during downtime without waiting for backend.
//
// 🛟 FAIL-OPEN: read errors render an empty list (banner shows count=0
// so unmapped items still flag red). Write errors surface inline per
// row — never silent. No live POS code path depends on this collection.
// ─────────────────────────────────────────────────────────────────────
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

const GOLD = "#C9A84C";
const RED = "#ef4444";
const GREEN = "#22c55e";

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

  // Decorate every HOD item with its slug + current mapping state.
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
      return r.item.name.toLowerCase().includes(q)
        || r.slug.includes(q)
        || (r.code && r.code.toLowerCase().includes(q));
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
      if (!trimmed) {
        await deleteDigitoryMapping(slug);
      } else {
        await upsertDigitoryMapping(slug, { hodName, digitoryItemNumber: trimmed }, staffName);
      }
      setDirty((d) => { const { [slug]: _, ...rest } = d; return rest; });
    } catch (err: any) {
      setErrBySlug((e) => ({ ...e, [slug]: err?.message || "Save failed" }));
    } finally {
      setSavingSlug(null);
    }
  }

  async function runBulkImport() {
    setBulkResult(null);
    const lines = bulkText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    let ok = 0, skip = 0, err = 0;
    const errs: string[] = [];
    // Build name → slug lookup for fast match.
    const bySlug = new Map<string, { slug: string; name: string }>();
    const byName = new Map<string, { slug: string; name: string }>();
    HOD_MENU_ITEMS.forEach((item: any) => {
      const slug = menuOverrideKey(item.name);
      bySlug.set(slug, { slug, name: item.name });
      byName.set(item.name.trim().toLowerCase(), { slug, name: item.name });
    });
    for (const line of lines) {
      // Accept "name,code" OR "slug,code" OR tab-separated.
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
      } catch (e: any) {
        err++; errs.push(`${hit.name}: ${e?.message || "save error"}`);
      }
    }
    setBulkResult(`✅ ${ok} saved · ⚠️ ${skip} skipped · ❌ ${err} failed` + (errs.length ? `\n\nIssues:\n${errs.slice(0, 10).join("\n")}${errs.length > 10 ? `\n…and ${errs.length - 10} more` : ""}` : ""));
  }

  return (
    <div className="space-y-3">
      {/* HEADER + STATUS */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div style={{ fontSize: 20, fontWeight: 900, color: GOLD, fontFamily: "'Playfair Display', serif" }}>
          🔗 Digitory Sync — Item Mapping
        </div>
        <div className="flex gap-2 items-center text-xs">
          <span className="px-3 py-1 rounded-full font-bold" style={{ background: "rgba(34,197,94,.15)", color: GREEN, border: `1px solid ${GREEN}55` }}>
            ✓ {totals.mapped} MAPPED
          </span>
          <span className="px-3 py-1 rounded-full font-bold" style={{ background: "rgba(239,68,68,.15)", color: RED, border: `1px solid ${RED}55` }}>
            ⚠ {totals.unmapped} UNMAPPED
          </span>
          <span className="text-[11px]" style={{ color: "hsl(36 29% 50%)" }}>of {totals.total} items</span>
        </div>
      </div>

      {/* INTRO BANNER */}
      <div className="text-xs p-3 rounded-lg" style={{ background: "hsl(240 12% 8%)", border: `1px solid ${GOLD}33`, color: "hsl(36 29% 70%)" }}>
        <b style={{ color: GOLD }}>WHAT THIS IS:</b> Digitory identifies items by numeric code (<code>item_number</code>). HOD identifies items by name. This screen maps the two. ✏️ Type each item's Digitory code (find it in your Digitory dashboard → Menu → click an item → see ID). Use the <b>📋 Bulk Import</b> button to paste a whole CSV at once. <br />
        <b style={{ color: GOLD }}>🛟 SAFE:</b> Nothing is pushed to Digitory yet — this just stores the mapping. The Cloud Function that uses it ships next week after Digitory shares prod URL + auth.
      </div>

      {/* CONTROLS */}
      <div className="flex flex-wrap gap-2 items-center">
        <input
          type="text" placeholder="Search by item name, slug, or Digitory code…"
          value={search} onChange={(e) => setSearch(e.target.value)}
          className="flex-1 min-w-[200px] px-4 py-2 rounded-lg text-sm"
          style={{ background: "hsl(240 12% 8%)", border: "1px solid hsl(240 8% 18%)", color: "hsl(36 29% 93%)" }}
        />
        <div className="flex gap-1">
          {(["all", "unmapped", "mapped"] as const).map((f) => (
            <button key={f} onClick={() => setFilter(f)}
              className="px-3 py-2 rounded-lg text-xs font-bold uppercase"
              style={{ background: filter === f ? GOLD : "hsl(240 12% 8%)", color: filter === f ? "#030305" : "hsl(36 29% 70%)", border: "1px solid hsl(240 8% 18%)" }}>
              {f}
            </button>
          ))}
        </div>
        <button onClick={() => setBulkOpen((v) => !v)}
          className="px-3 py-2 rounded-lg text-xs font-bold"
          style={{ background: "rgba(201,168,76,.15)", color: GOLD, border: `1px solid ${GOLD}55` }}>
          📋 BULK IMPORT (CSV)
        </button>
      </div>

      {/* BULK IMPORT PANEL */}
      {bulkOpen && (
        <div className="p-3 rounded-lg space-y-2" style={{ background: "hsl(240 12% 6%)", border: `1px solid ${GOLD}55` }}>
          <div className="text-xs" style={{ color: "hsl(36 29% 70%)" }}>
            Paste two columns separated by <b>comma</b> or <b>tab</b>: <code>HOD ITEM NAME, DIGITORY CODE</code> — one per line. Empty code = remove mapping. Slug also accepted (e.g. <code>old-monk-90ml</code>).
          </div>
          <textarea value={bulkText} onChange={(e) => setBulkText(e.target.value)}
            placeholder={"OLD MONK 90ML, 10234\nCHICKEN TIKKA, 20188\nPEPSI, 30002"}
            rows={6}
            className="w-full px-3 py-2 rounded-lg text-xs font-mono"
            style={{ background: "hsl(240 12% 4%)", border: "1px solid hsl(240 8% 18%)", color: "hsl(36 29% 93%)" }}
          />
          <div className="flex gap-2 items-center">
            <button onClick={runBulkImport} disabled={!bulkText.trim()}
              className="px-4 py-2 rounded-lg text-xs font-bold disabled:opacity-40"
              style={{ background: GOLD, color: "#030305" }}>
              IMPORT
            </button>
            <button onClick={() => { setBulkText(""); setBulkResult(null); }}
              className="px-3 py-2 rounded-lg text-xs"
              style={{ background: "hsl(240 12% 8%)", color: "hsl(36 29% 70%)" }}>
              CLEAR
            </button>
          </div>
          {bulkResult && (
            <pre className="text-xs whitespace-pre-wrap p-2 rounded" style={{ background: "hsl(240 12% 4%)", color: "hsl(36 29% 70%)" }}>{bulkResult}</pre>
          )}
        </div>
      )}

      {/* ITEM LIST */}
      <div className="space-y-1 max-h-[70vh] overflow-y-auto">
        {filtered.length === 0 && (
          <div className="text-center py-8 text-sm" style={{ color: "hsl(36 29% 50%)" }}>
            No items match.
          </div>
        )}
        {filtered.map((r) => {
          const isDirty = dirty[r.slug] !== undefined;
          const isSaving = savingSlug === r.slug;
          const rowErr = errBySlug[r.slug];
          return (
            <div key={r.slug}
              className="flex items-center gap-2 px-3 py-2 rounded-lg"
              style={{ background: "hsl(240 12% 5%)", border: `1px solid ${r.mapped ? "transparent" : `${RED}33`}` }}>
              <div className="flex-1 min-w-0">
                <div className="text-sm truncate" style={{ color: "hsl(36 29% 93%)" }}>{r.item.name}</div>
                <div className="text-[11px]" style={{ color: "hsl(36 29% 50%)" }}>
                  {HOD_CATEGORY_LABELS[r.item.category] || r.item.category} · {formatINR(r.item.price)} · <code>{r.slug}</code>
                </div>
                {rowErr && <div className="text-[11px] mt-0.5" style={{ color: RED }}>❌ {rowErr}</div>}
              </div>
              <input
                type="text" placeholder="Digitory code"
                value={r.code}
                onChange={(e) => setDirty((d) => ({ ...d, [r.slug]: e.target.value }))}
                className="px-3 py-1.5 rounded-lg text-sm font-mono w-40"
                style={{
                  background: "hsl(240 12% 3%)",
                  border: `1px solid ${isDirty ? GOLD : "hsl(240 8% 18%)"}`,
                  color: r.mapped || isDirty ? "hsl(36 29% 93%)" : "hsl(36 29% 50%)",
                }}
              />
              <button
                onClick={() => saveRow(r.slug, r.item.name, r.code)}
                disabled={!isDirty || isSaving}
                className="px-3 py-1.5 rounded-lg text-xs font-bold disabled:opacity-30"
                style={{ background: isDirty ? GOLD : "hsl(240 12% 8%)", color: isDirty ? "#030305" : "hsl(36 29% 50%)" }}>
                {isSaving ? "…" : "SAVE"}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
