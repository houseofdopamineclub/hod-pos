import { useEffect, useMemo, useRef, useState } from "react";
import {
  subscribeToHodEvents, createHodEvent, updateHodEvent, updateHodEventImageOnly,
  toggleHodEventPublished, deleteHodEvent, type HodEvent,
} from "../lib/firestore-hod";

type Tab = "list" | "form";
type StatusFilter = "upcoming" | "past" | "all";

const todayStr = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const fmtDate = (iso: string): string => {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" });
};

const inr = (n?: number) => `₹${(n || 0).toLocaleString("en-IN")}`;

const emptyForm = (): Partial<HodEvent> => ({
  title: "", dj: "", date: "", time: "9:00 PM", endTime: "3:00 AM",
  venue: "HOD Rooftop — Koramangala, 7th Block", genre: "",
  capacity: 150, price: 999, stagPrice: 999, couplePrice: 1499,
  groupPrice: 2999, groupPerHeadPrice: 500, entryOnlyPrice: 599,
  table4Price: 5000, vipPrice: 15000, gf4Stock: 4, vvipStock: 2,
  description: "", color: "#C9A84C", image: "", published: false,
});

/** Detect WebP encode support (modern browsers; Safari 14+, all Chrome/Firefox/Edge). */
function _webpSupported(): boolean {
  try {
    const cv = document.createElement("canvas");
    cv.width = 1; cv.height = 1;
    return cv.toDataURL("image/webp").startsWith("data:image/webp");
  } catch { return false; }
}

/** Compress poster aggressively for PageSpeed: cap width 800px, WebP if supported, target ~120KB. */
async function compressImage(file: File | string, maxBytes = 140_000, maxWidth = 800): Promise<string> {
  const dataUrl = typeof file === "string"
    ? file
    : await new Promise<string>((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(String(r.result));
        r.onerror = rej;
        r.readAsDataURL(file);
      });
  const img = await new Promise<HTMLImageElement>((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = rej;
    i.src = dataUrl;
  });
  const scale = Math.min(1, maxWidth / Math.max(img.width, 1));
  const w = Math.floor(img.width * scale);
  const h = Math.floor(img.height * scale);
  const cv = document.createElement("canvas");
  cv.width = w; cv.height = h;
  const ctx = cv.getContext("2d")!;
  ctx.drawImage(img, 0, 0, w, h);
  const fmt = _webpSupported() ? "image/webp" : "image/jpeg";
  let q = 0.82;
  let out = cv.toDataURL(fmt, q);
  while (out.length > maxBytes && q > 0.35) {
    q -= 0.08;
    out = cv.toDataURL(fmt, q);
  }
  return out;
}

export default function EventsAdmin() {
  const [events, setEvents] = useState<HodEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>("list");
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState<Partial<HodEvent>>(emptyForm());
  const [busy, setBusy] = useState<string>("");
  const [filter, setFilter] = useState<StatusFilter>("upcoming");
  const [query, setQuery] = useState("");
  const optimizeRunning = useRef(false);

  // Live Firestore subscription — same collection hodclub.in customers read
  useEffect(() => {
    const unsub = subscribeToHodEvents((evs) => {
      setEvents(evs);
      setLoading(false);
    });
    return unsub;
  }, []);

  const editing = useMemo(() => events.find((e) => e.id === editId) || null, [events, editId]);

  const startEdit = (ev: HodEvent) => {
    setForm({ ...ev });
    setEditId(ev.id);
    setTab("form");
  };
  const startNew = () => {
    setForm(emptyForm());
    setEditId(null);
    setTab("form");
  };
  const cancelForm = () => {
    setTab("list");
    setEditId(null);
    setForm(emptyForm());
  };

  const handleSave = async (publish: boolean) => {
    if (!form.title?.trim()) { alert("Event title is required."); return; }
    if (!form.date) { alert("Event date is required."); return; }
    setBusy("save");
    try {
      const data = { ...form, published: publish ? true : !!form.published };
      if (editId) await updateHodEvent(editId, data);
      else await createHodEvent(data);
      cancelForm();
    } catch (e: any) {
      alert("Save failed: " + (e?.message || String(e)));
    }
    setBusy("");
  };

  const handleTogglePublish = async (ev: HodEvent) => {
    setBusy(`pub-${ev.id}`);
    try { await toggleHodEventPublished(ev.id, !ev.published); }
    catch (e: any) { alert("Toggle failed: " + (e?.message || String(e))); }
    setBusy("");
  };

  const handleDelete = async (ev: HodEvent) => {
    const sold = ev.sold || 0;
    const warn = sold > 0
      ? `⚠️ "${ev.title}" already has ${sold} booking(s). Deleting will NOT refund customers.\n\nType DELETE to confirm:`
      : `Delete "${ev.title}" (${fmtDate(ev.date)})? This cannot be undone.\n\nType DELETE to confirm:`;
    const ans = window.prompt(warn);
    if (ans !== "DELETE") return;
    setBusy(`del-${ev.id}`);
    try { await deleteHodEvent(ev.id); }
    catch (e: any) { alert("Delete failed: " + (e?.message || String(e))); }
    setBusy("");
  };

  const handleImageFile = async (file: File) => {
    setBusy("img");
    try {
      const url = await compressImage(file);
      setForm((f) => ({ ...f, image: url }));
    } catch (e: any) {
      alert("Image processing failed: " + (e?.message || String(e)));
    }
    setBusy("");
  };

  /** One-click bulk re-compress: shrinks every existing poster on hodclub.in.
   *  Skips posters already small (<150KB) or missing. Writes back to same
   *  Firestore docs the customer site reads — instant page-speed win.
   *  ⚠️ Uses updateHodEventImageOnly (image-only patch) to avoid clobbering
   *  live-booking-mutated stock fields. Re-entrancy guarded by optimizeRunning. */
  const handleOptimizeAll = async () => {
    if (optimizeRunning.current) return;
    optimizeRunning.current = true;
    const targets = events.filter((e) =>
      e.image && (e.image.startsWith("data:") || e.image.startsWith("http")) &&
      e.image.length > 150_000
    );
    if (targets.length === 0) {
      optimizeRunning.current = false;
      alert("All posters are already optimized — nothing to do.");
      return;
    }
    const totalKb = Math.round(targets.reduce((s, e) => s + (e.image?.length || 0), 0) / 1024);
    const ok = window.confirm(
      `Optimize ${targets.length} poster(s)?\n\n` +
      `Current total: ~${totalKb} KB\n` +
      `Will resize to max 800px wide + WebP, target ~120 KB each.\n\n` +
      `Customer-facing site will load much faster.\n` +
      `Existing bookings/stock are NOT touched.`
    );
    if (!ok) { optimizeRunning.current = false; return; }
    setBusy("optimize-all");
    let done = 0, failed = 0, savedKb = 0;
    for (const ev of targets) {
      try {
        let src = ev.image!;
        // For external URLs, fetch + convert to data URL first
        if (src.startsWith("http")) {
          const r = await fetch(src);
          const blob = await r.blob();
          src = await new Promise<string>((res, rej) => {
            const fr = new FileReader();
            fr.onload = () => res(String(fr.result));
            fr.onerror = rej;
            fr.readAsDataURL(blob);
          });
        }
        const before = src.length;
        const out = await compressImage(src);
        if (out.length < before * 0.9) {
          // Image-only patch — never overwrite live stock/sold fields.
          await updateHodEventImageOnly(ev.id, out);
          savedKb += Math.round((before - out.length) / 1024);
          done++;
        }
      } catch (e) {
        console.error("Optimize failed for", ev.id, e);
        failed++;
      }
      setBusy(`optimize-${done + failed}/${targets.length}`);
    }
    setBusy("");
    optimizeRunning.current = false;
    alert(`✅ Done: ${done} optimized, ${failed} failed.\nSaved ~${savedKb} KB on the live site.`);
  };

  // ── List view filtering
  const tStr = todayStr();
  const filtered = useMemo(() => {
    let xs = events.slice();
    if (filter === "upcoming") xs = xs.filter((e) => (e.date || "") >= tStr);
    else if (filter === "past") xs = xs.filter((e) => (e.date || "") < tStr);
    if (query.trim()) {
      const q = query.toLowerCase();
      xs = xs.filter((e) =>
        (e.title || "").toLowerCase().includes(q) ||
        (e.dj || "").toLowerCase().includes(q) ||
        (e.genre || "").toLowerCase().includes(q)
      );
    }
    xs.sort((a, b) => (a.date || "").localeCompare(b.date || ""));
    return xs;
  }, [events, filter, query, tStr]);

  const tonightEvs = useMemo(
    () => events.filter((e) => e.published && e.date === tStr),
    [events, tStr]
  );

  // ─────────────────────────────── RENDER ───────────────────────────────

  if (tab === "form") {
    return (
      <FormView
        form={form}
        setForm={setForm}
        editing={editing}
        busy={busy}
        onCancel={cancelForm}
        onSave={() => handleSave(false)}
        onPublish={() => handleSave(true)}
        onImageFile={handleImageFile}
      />
    );
  }

  return (
    <div>
      {/* Header bar */}
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <div>
          <div className="text-lg font-bold" style={{ color: "#C9A84C" }}>🎟 Events</div>
          <div className="text-xs" style={{ color: "hsl(36 29% 55%)" }}>
            Same data as hodclub.in — edits go live instantly on the customer site.
          </div>
        </div>
        <div className="flex gap-2 flex-wrap">
          <button onClick={handleOptimizeAll} disabled={busy.startsWith("optimize")}
            className="px-3 py-2 rounded-lg text-xs font-bold disabled:opacity-60"
            style={{ background: "hsl(240 12% 8%)", color: "#C9A84C", border: "1px solid rgba(201,168,76,.4)" }}
            title="Re-compress all event posters to <150 KB WebP — speeds up hodclub.in">
            {busy.startsWith("optimize-") ? `⏳ ${busy.replace("optimize-", "")}` :
             busy === "optimize-all" ? "⏳ Starting…" : "🚀 Optimize Posters"}
          </button>
          <button onClick={startNew}
            className="px-4 py-2 rounded-lg text-sm font-bold"
            style={{ background: "#C9A84C", color: "#030305" }}>
            + Add Event
          </button>
        </div>
      </div>

      {/* Tonight summary */}
      {tonightEvs.length > 0 && (
        <div className="rounded-xl p-4 mb-4"
          style={{ background: "linear-gradient(135deg,rgba(201,168,76,.12),rgba(123,47,190,.06))",
            border: "1px solid rgba(201,168,76,.3)" }}>
          <div className="text-[10px] font-bold tracking-widest mb-2" style={{ color: "#C9A84C" }}>
            🔥 TONIGHT
          </div>
          {tonightEvs.map((ev, i) => {
            const pct = (ev.capacity || 0) > 0 ? Math.round(((ev.sold || 0) / (ev.capacity || 1)) * 100) : 0;
            return (
              <div key={ev.id}
                className="flex items-center justify-between gap-3 py-2"
                style={{ borderBottom: i < tonightEvs.length - 1 ? "1px solid rgba(255,255,255,.05)" : "none" }}>
                <div className="min-w-0 flex-1">
                  <div className="font-bold text-sm truncate">{ev.title}</div>
                  <div className="text-xs" style={{ color: "hsl(36 29% 55%)" }}>
                    {ev.dj || "—"} · {ev.time || ""}
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <div className="text-lg font-bold" style={{ color: "#C9A84C" }}>
                    {ev.sold || 0}
                    <span className="text-xs font-semibold" style={{ color: "hsl(36 29% 55%)" }}>
                      /{ev.capacity || 0}
                    </span>
                  </div>
                  <div className="text-[10px]" style={{ color: "hsl(36 29% 55%)" }}>{pct}% sold</div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Filter bar */}
      <div className="flex gap-2 mb-3 flex-wrap">
        {(["upcoming", "past", "all"] as StatusFilter[]).map((f) => (
          <button key={f} onClick={() => setFilter(f)}
            className="px-3 py-1.5 rounded-lg text-xs font-bold uppercase tracking-wider"
            style={{
              background: filter === f ? "#C9A84C" : "hsl(240 12% 8%)",
              color: filter === f ? "#030305" : "hsl(36 29% 70%)",
            }}>
            {f}
            <span className="ml-1.5 opacity-60">
              ({f === "upcoming" ? events.filter((e) => (e.date || "") >= tStr).length
                : f === "past" ? events.filter((e) => (e.date || "") < tStr).length
                : events.length})
            </span>
          </button>
        ))}
        <input type="text" value={query} onChange={(e) => setQuery(e.target.value)}
          placeholder="Search title / DJ / genre…"
          className="flex-1 min-w-[200px] px-3 py-1.5 rounded-lg text-xs"
          style={{ background: "hsl(240 12% 8%)", border: "1px solid hsl(240 8% 18%)", color: "#fff" }} />
      </div>

      {/* List */}
      {loading ? (
        <div className="text-center py-20 text-sm" style={{ color: "hsl(36 29% 55%)" }}>
          Loading events from Firestore…
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-20 text-sm" style={{ color: "hsl(36 29% 55%)" }}>
          {query ? `No events match "${query}"` : `No ${filter} events.`}
        </div>
      ) : (
        <div className="grid gap-2">
          {filtered.map((ev) => (
            <EventRow key={ev.id} ev={ev} busy={busy}
              onEdit={() => startEdit(ev)}
              onTogglePublish={() => handleTogglePublish(ev)}
              onDelete={() => handleDelete(ev)} />
          ))}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────── ROW ───────────────────────────────

function EventRow({ ev, busy, onEdit, onTogglePublish, onDelete }: {
  ev: HodEvent; busy: string;
  onEdit: () => void; onTogglePublish: () => void; onDelete: () => void;
}) {
  const pct = (ev.capacity || 0) > 0 ? Math.round(((ev.sold || 0) / (ev.capacity || 1)) * 100) : 0;
  const isPub = !!ev.published;
  return (
    <div className="rounded-lg p-3 flex items-center gap-3 flex-wrap"
      style={{ background: "hsl(240 12% 8%)", border: `1px solid ${isPub ? "rgba(0,200,100,.25)" : "hsl(240 8% 18%)"}` }}>
      {ev.image ? (
        <img src={ev.image} alt="" className="w-16 h-16 rounded object-cover shrink-0"
          style={{ background: "#0a0a0a" }} />
      ) : (
        <div className="w-16 h-16 rounded shrink-0 flex items-center justify-center text-2xl"
          style={{ background: ev.color || "#1a1a1a" }}>🎵</div>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <div className="font-bold text-sm truncate">{ev.title}</div>
          <span className="text-[10px] px-1.5 py-0.5 rounded font-bold uppercase tracking-wider"
            style={{
              background: isPub ? "rgba(0,200,100,.15)" : "rgba(245,158,11,.15)",
              color: isPub ? "#00C864" : "#F59E0B",
            }}>
            {isPub ? "● LIVE" : "○ DRAFT"}
          </span>
        </div>
        <div className="text-xs mt-1" style={{ color: "hsl(36 29% 60%)" }}>
          {fmtDate(ev.date)} · {ev.time || "—"} · {ev.dj || "no DJ"} · {ev.genre || "—"}
        </div>
        <div className="text-[11px] mt-1" style={{ color: "hsl(36 29% 50%)" }}>
          Stag {inr(ev.stagPrice)} · Couple {inr(ev.couplePrice)} · Entry {inr(ev.entryOnlyPrice)} ·
          T4 {inr(ev.table4Price)} · VVIP {inr(ev.vipPrice)}
        </div>
      </div>
      <div className="text-right shrink-0">
        <div className="font-bold" style={{ color: "#C9A84C" }}>
          {ev.sold || 0}<span className="text-xs opacity-60">/{ev.capacity || 0}</span>
        </div>
        <div className="text-[10px]" style={{ color: "hsl(36 29% 55%)" }}>{pct}% sold</div>
      </div>
      <div className="flex gap-1 shrink-0">
        <button onClick={onEdit} disabled={!!busy}
          className="px-3 py-1.5 rounded text-xs font-bold"
          style={{ background: "rgba(201,168,76,.15)", color: "#C9A84C", border: "1px solid rgba(201,168,76,.35)" }}>
          ✎ Edit
        </button>
        <button onClick={onTogglePublish} disabled={busy === `pub-${ev.id}`}
          className="px-3 py-1.5 rounded text-xs font-bold"
          style={{
            background: isPub ? "rgba(245,158,11,.15)" : "rgba(0,200,100,.15)",
            color: isPub ? "#F59E0B" : "#00C864",
            border: `1px solid ${isPub ? "rgba(245,158,11,.35)" : "rgba(0,200,100,.35)"}`,
          }}>
          {busy === `pub-${ev.id}` ? "…" : isPub ? "Unpublish" : "Publish"}
        </button>
        <button onClick={onDelete} disabled={busy === `del-${ev.id}`}
          className="px-3 py-1.5 rounded text-xs font-bold"
          style={{ background: "rgba(239,68,68,.1)", color: "#EF4444", border: "1px solid rgba(239,68,68,.3)" }}>
          🗑
        </button>
      </div>
    </div>
  );
}

// ─────────────────────────────── FORM ───────────────────────────────

function FormView({ form, setForm, editing, busy, onCancel, onSave, onPublish, onImageFile }: {
  form: Partial<HodEvent>; setForm: (f: Partial<HodEvent>) => void;
  editing: HodEvent | null; busy: string;
  onCancel: () => void; onSave: () => void; onPublish: () => void;
  onImageFile: (f: File) => void;
}) {
  const set = <K extends keyof HodEvent>(k: K, v: HodEvent[K]) =>
    setForm({ ...form, [k]: v });
  const setN = (k: keyof HodEvent, raw: string) => {
    const n = raw === "" ? undefined : Number(raw);
    setForm({ ...form, [k]: n as any });
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <div>
          <div className="text-lg font-bold" style={{ color: "#C9A84C" }}>
            {editing ? `✎ Edit: ${editing.title}` : "+ New Event"}
          </div>
          <div className="text-xs" style={{ color: "hsl(36 29% 55%)" }}>
            {editing
              ? `Saved changes appear on hodclub.in within seconds (${editing.sold || 0} bookings exist).`
              : "Filled? Save as Draft to preview, or Publish to go live immediately."}
          </div>
        </div>
        <button onClick={onCancel}
          className="px-3 py-1.5 rounded text-xs font-bold"
          style={{ background: "hsl(240 12% 10%)", color: "hsl(36 29% 70%)", border: "1px solid hsl(240 8% 18%)" }}>
          ← Back to list
        </button>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* LEFT — basic info */}
        <Section title="Basic Info">
          <Field label="Event Title *">
            <input type="text" value={form.title || ""} onChange={(e) => set("title", e.target.value)}
              placeholder="e.g. NEON NIGHTS — DJ ARYAN" className={inputCls} />
          </Field>
          <Row>
            <Field label="DJ Name">
              <input type="text" value={form.dj || ""} onChange={(e) => set("dj", e.target.value)}
                placeholder="e.g. DJ Aryan" className={inputCls} />
            </Field>
            <Field label="Genre">
              <input type="text" value={form.genre || ""} onChange={(e) => set("genre", e.target.value)}
                placeholder="e.g. Techno / House" className={inputCls} />
            </Field>
          </Row>
          <Row>
            <Field label="Date *">
              <input type="date" value={form.date || ""} onChange={(e) => set("date", e.target.value)}
                className={inputCls} />
            </Field>
            <Field label="Capacity">
              <input type="number" value={form.capacity ?? ""} onChange={(e) => setN("capacity", e.target.value)}
                placeholder="150" className={inputCls} />
            </Field>
          </Row>
          <Row>
            <Field label="Start Time">
              <input type="text" value={form.time || ""} onChange={(e) => set("time", e.target.value)}
                placeholder="9:00 PM" className={inputCls} />
            </Field>
            <Field label="End Time">
              <input type="text" value={form.endTime || ""} onChange={(e) => set("endTime", e.target.value)}
                placeholder="3:00 AM" className={inputCls} />
            </Field>
          </Row>
          <Field label="Venue">
            <input type="text" value={form.venue || ""} onChange={(e) => set("venue", e.target.value)}
              className={inputCls} />
          </Field>
          <Field label="Description">
            <textarea value={form.description || ""} onChange={(e) => set("description", e.target.value)}
              placeholder="Describe the night, DJ style, special guests…"
              rows={4} className={inputCls + " resize-y"} />
          </Field>
        </Section>

        {/* RIGHT — pricing + stock + image */}
        <Section title="Pricing">
          <Row>
            <Field label="Cover (base) ₹">
              <input type="number" value={form.price ?? ""} onChange={(e) => setN("price", e.target.value)}
                placeholder="999" className={inputCls} />
            </Field>
            <Field label="Stag ₹">
              <input type="number" value={form.stagPrice ?? ""} onChange={(e) => setN("stagPrice", e.target.value)}
                placeholder="999" className={inputCls} />
            </Field>
          </Row>
          <Row>
            <Field label="Couple ₹">
              <input type="number" value={form.couplePrice ?? ""} onChange={(e) => setN("couplePrice", e.target.value)}
                placeholder="1499" className={inputCls} />
            </Field>
            <Field label="Group per-head ₹">
              <input type="number" value={form.groupPerHeadPrice ?? ""} onChange={(e) => setN("groupPerHeadPrice", e.target.value)}
                placeholder="500" className={inputCls} />
            </Field>
          </Row>
          <Field label="Entry Only ₹ (door, NOT redeemable on F&B)">
            <input type="number" value={form.entryOnlyPrice ?? ""} onChange={(e) => setN("entryOnlyPrice", e.target.value)}
              placeholder="599" className={inputCls} />
          </Field>
          <Row>
            <Field label="Table for 4 (GF) ₹">
              <input type="number" value={form.table4Price ?? ""} onChange={(e) => setN("table4Price", e.target.value)}
                placeholder="5000" className={inputCls} />
            </Field>
            <Field label="VVIP Table ₹">
              <input type="number" value={form.vipPrice ?? ""} onChange={(e) => setN("vipPrice", e.target.value)}
                placeholder="15000" className={inputCls} />
            </Field>
          </Row>

          <SectionSub title="Nightly Stock (auto-resets at 6 AM)" />
          <Row>
            <Field label="GF Table-for-4 stock">
              <input type="number" value={form.gf4Stock ?? ""} onChange={(e) => setN("gf4Stock", e.target.value)}
                placeholder="4" className={inputCls} />
            </Field>
            <Field label="VVIP stock">
              <input type="number" value={form.vvipStock ?? ""} onChange={(e) => setN("vvipStock", e.target.value)}
                placeholder="2" className={inputCls} />
            </Field>
          </Row>

          <SectionSub title="Poster Image" />
          <Field label="Image URL or paste a link">
            <input type="text" value={(form.image || "").startsWith("data:") ? "" : (form.image || "")}
              onChange={(e) => set("image", e.target.value)}
              placeholder="https://…/poster.jpg" className={inputCls} />
          </Field>
          <Field label="Or upload from device (auto-compressed to 700KB)">
            <input type="file" accept="image/*"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) onImageFile(f); }}
              className={inputCls} />
          </Field>
          {form.image && (
            <div className="mt-2 flex items-center gap-2">
              <img src={form.image} alt="poster preview" className="h-20 rounded"
                style={{ background: "#0a0a0a" }} />
              <button type="button" onClick={() => set("image", "")}
                className="text-xs px-2 py-1 rounded"
                style={{ background: "rgba(239,68,68,.1)", color: "#EF4444" }}>
                Remove
              </button>
            </div>
          )}

          <SectionSub title="Card accent color" />
          <Field label="Hex (e.g. #C9A84C)">
            <input type="text" value={form.color || ""} onChange={(e) => set("color", e.target.value)}
              placeholder="#C9A84C" className={inputCls} />
          </Field>
        </Section>
      </div>

      {/* Save bar */}
      <div className="mt-6 flex gap-2 justify-end flex-wrap">
        <button onClick={onCancel} disabled={!!busy}
          className="px-4 py-2 rounded-lg text-sm font-bold"
          style={{ background: "hsl(240 12% 10%)", color: "hsl(36 29% 70%)", border: "1px solid hsl(240 8% 18%)" }}>
          Cancel
        </button>
        <button onClick={onSave} disabled={busy === "save"}
          className="px-4 py-2 rounded-lg text-sm font-bold"
          style={{ background: "rgba(201,168,76,.15)", color: "#C9A84C", border: "1px solid rgba(201,168,76,.4)" }}>
          {busy === "save" ? "Saving…" : "Save as Draft"}
        </button>
        <button onClick={onPublish} disabled={busy === "save"}
          className="px-4 py-2 rounded-lg text-sm font-bold"
          style={{ background: "#00C864", color: "#030305" }}>
          {busy === "save" ? "Saving…" : "💾 Save & Publish (LIVE)"}
        </button>
      </div>
    </div>
  );
}

// ─────────────────────────────── small UI helpers ───────────────────────────────

const inputCls = "w-full px-3 py-2 rounded-lg text-sm bg-[hsl(240,12%,8%)] text-white border border-[hsl(240,8%,18%)] focus:outline-none focus:border-[#C9A84C]";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl p-4" style={{ background: "hsl(240 12% 6%)", border: "1px solid hsl(240 8% 13%)" }}>
      <div className="text-[10px] font-bold tracking-widest mb-3" style={{ color: "#C9A84C" }}>
        {title.toUpperCase()}
      </div>
      <div className="grid gap-3">{children}</div>
    </div>
  );
}

function SectionSub({ title }: { title: string }) {
  return (
    <div className="text-[10px] font-bold tracking-widest mt-2 pt-2"
      style={{ color: "hsl(36 29% 55%)", borderTop: "1px solid hsl(240 8% 13%)" }}>
      {title.toUpperCase()}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="text-[11px] font-semibold mb-1" style={{ color: "hsl(36 29% 65%)" }}>{label}</div>
      {children}
    </label>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-2 gap-3">{children}</div>;
}
