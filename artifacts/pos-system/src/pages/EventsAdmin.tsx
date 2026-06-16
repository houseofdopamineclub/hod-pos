import { useEffect, useMemo, useRef, useState } from "react";
import {
  subscribeToHodEvents, createHodEvent, updateHodEvent, updateHodEventImageOnly,
  toggleHodEventPublished, deleteHodEvent, deleteExpiredHodEvents, type HodEvent,
} from "../lib/firestore-hod";

type Tab = "list" | "form";
type StatusFilter = "upcoming" | "past" | "all";

const SHADOW_SM = "2px 2px 0px #000";
const SHADOW_MD = "3px 3px 0px #000";

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

function _webpSupported(): boolean {
  try {
    const cv = document.createElement("canvas");
    cv.width = 1; cv.height = 1;
    return cv.toDataURL("image/webp").startsWith("data:image/webp");
  } catch { return false; }
}

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
  while (out.length > maxBytes && q > 0.35) { q -= 0.08; out = cv.toDataURL(fmt, q); }
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

  useEffect(() => {
    const unsub = subscribeToHodEvents((evs) => { setEvents(evs); setLoading(false); });
    return unsub;
  }, []);

  const purgedRef = useRef(false);
  useEffect(() => {
    if (purgedRef.current) return;
    purgedRef.current = true;
    deleteExpiredHodEvents(2)
      .then((r) => {
        if (r.deleted > 0) console.info(`[EventsAdmin] auto-purged ${r.deleted} expired event(s)`);
        if (r.errors.length > 0) console.warn("[EventsAdmin] purge errors", r.errors);
      })
      .catch((e) => console.warn("[EventsAdmin] auto-purge failed", e));
  }, []);

  const editing = useMemo(() => events.find((e) => e.id === editId) || null, [events, editId]);

  const startEdit = (ev: HodEvent) => { setForm({ ...ev }); setEditId(ev.id); setTab("form"); };
  const startNew = () => { setForm(emptyForm()); setEditId(null); setTab("form"); };
  const cancelForm = () => { setTab("list"); setEditId(null); setForm(emptyForm()); };

  const handleSave = async (publish: boolean) => {
    if (!form.title?.trim()) { alert("Event title is required."); return; }
    if (!form.date) { alert("Event date is required."); return; }
    setBusy("save");
    try {
      const data = { ...form, published: publish ? true : !!form.published };
      if (editId) await updateHodEvent(editId, data);
      else await createHodEvent(data);
      cancelForm();
    } catch (e: any) { alert("Save failed: " + (e?.message || String(e))); }
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
    try { const url = await compressImage(file); setForm((f) => ({ ...f, image: url })); }
    catch (e: any) { alert("Image processing failed: " + (e?.message || String(e))); }
    setBusy("");
  };

  const handleOptimizeAll = async () => {
    if (optimizeRunning.current) return;
    optimizeRunning.current = true;
    const targets = events.filter((e) => {
      if (!e.image) return false;
      if (e.image.startsWith("http")) return true;
      if (e.image.startsWith("data:") && e.image.length > 150_000) return true;
      return false;
    });
    if (targets.length === 0) { optimizeRunning.current = false; alert("All posters are already optimized — nothing to do."); return; }
    const totalKb = Math.round(targets.reduce((s, e) => s + (e.image?.length || 0), 0) / 1024);
    const ok = window.confirm(
      `Optimize ${targets.length} poster(s)?\n\nCurrent total: ~${totalKb} KB\nWill resize to max 800px wide + WebP, target ~120 KB each.\n\nCustomer-facing site will load much faster.\nExisting bookings/stock are NOT touched.`
    );
    if (!ok) { optimizeRunning.current = false; return; }
    setBusy("optimize-all");
    let done = 0, failed = 0, savedKb = 0;
    for (const ev of targets) {
      try {
        let src = ev.image!;
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
          await updateHodEventImageOnly(ev.id, out);
          savedKb += Math.round((before - out.length) / 1024);
          done++;
        }
      } catch (e) { console.error("Optimize failed for", ev.id, e); failed++; }
      setBusy(`optimize-${done + failed}/${targets.length}`);
    }
    setBusy(""); optimizeRunning.current = false;
    alert(`✅ Done: ${done} optimized, ${failed} failed.\nSaved ~${savedKb} KB on the live site.`);
  };

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

  const tonightEvs = useMemo(() => events.filter((e) => e.published && e.date === tStr), [events, tStr]);

  if (tab === "form") {
    return (
      <FormView
        form={form} setForm={setForm} editing={editing} busy={busy}
        onCancel={cancelForm} onSave={() => handleSave(false)}
        onPublish={() => handleSave(true)} onImageFile={handleImageFile}
      />
    );
  }

  return (
    <div style={{ color: "#000" }}>
      {/* Header */}
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <div>
          <div style={{ fontSize: 18, fontWeight: 900, color: "#000", textTransform: "uppercase" }}>🎟 Events</div>
          <div style={{ fontSize: 12, color: "#666", marginTop: 2, fontWeight: 500 }}>
            Same data as hodclub.in — edits go live instantly on the customer site.
          </div>
        </div>
        <div className="flex gap-2 flex-wrap">
          <button onClick={handleOptimizeAll} disabled={busy.startsWith("optimize")}
            style={{ padding: "8px 14px", fontSize: 12, fontWeight: 700, cursor: "pointer", background: "#FFFBEB", color: "#000", border: "2px solid #F2C744", boxShadow: SHADOW_SM, opacity: busy.startsWith("optimize") ? 0.6 : 1 }}
            title="Re-compress all event posters to <150 KB WebP — speeds up hodclub.in">
            {busy.startsWith("optimize-") ? `⏳ ${busy.replace("optimize-", "")}` :
             busy === "optimize-all" ? "⏳ Starting…" : "🚀 Optimize Posters"}
          </button>
          <button onClick={startNew}
            style={{ padding: "8px 16px", fontSize: 13, fontWeight: 900, cursor: "pointer", background: "#F2C744", color: "#000", border: "2px solid #000", boxShadow: SHADOW_MD }}>
            + Add Event
          </button>
        </div>
      </div>

      {/* Tonight summary */}
      {tonightEvs.length > 0 && (
        <div style={{ background: "#FFFBEB", border: "2px solid #F2C744", padding: 16, marginBottom: 16 }}>
          <div style={{ fontSize: 10, fontWeight: 900, letterSpacing: 2, marginBottom: 8, color: "#000" }}>🔥 TONIGHT</div>
          {tonightEvs.map((ev, i) => {
            const pct = (ev.capacity || 0) > 0 ? Math.round(((ev.sold || 0) / (ev.capacity || 1)) * 100) : 0;
            return (
              <div key={ev.id} className="flex items-center justify-between gap-3 py-2"
                style={{ borderBottom: i < tonightEvs.length - 1 ? "1px solid #eee" : "none" }}>
                <div className="min-w-0 flex-1">
                  <div style={{ fontWeight: 700, fontSize: 14 }}>{ev.title}</div>
                  <div style={{ fontSize: 12, color: "#666" }}>{ev.dj || "—"} · {ev.time || ""}</div>
                </div>
                <div className="text-right shrink-0">
                  <div style={{ fontSize: 18, fontWeight: 900, color: "#000" }}>
                    {ev.sold || 0}<span style={{ fontSize: 12, color: "#888" }}>/{ev.capacity || 0}</span>
                  </div>
                  <div style={{ fontSize: 10, color: "#888" }}>{pct}% sold</div>
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
            style={{
              padding: "7px 14px", fontSize: 12, fontWeight: 700, textTransform: "uppercase", cursor: "pointer",
              background: filter === f ? "#FF90E8" : "#fff",
              color: "#000",
              border: "2px solid #000",
              boxShadow: filter === f ? SHADOW_MD : SHADOW_SM,
              transform: filter === f ? "translate(-1px,-1px)" : "none",
            }}>
            {f}
            <span style={{ marginLeft: 6, opacity: .7 }}>
              ({f === "upcoming" ? events.filter((e) => (e.date || "") >= tStr).length
                : f === "past" ? events.filter((e) => (e.date || "") < tStr).length
                : events.length})
            </span>
          </button>
        ))}
        <input type="text" value={query} onChange={(e) => setQuery(e.target.value)}
          placeholder="Search title / DJ / genre…"
          style={{ flex: 1, minWidth: 200, padding: "7px 12px", fontSize: 12, background: "#fff", border: "2px solid #000", color: "#000" }} />
      </div>

      {/* List */}
      {loading ? (
        <div style={{ textAlign: "center", padding: 80, fontSize: 14, color: "#888", fontWeight: 500 }}>
          Loading events from Firestore…
        </div>
      ) : filtered.length === 0 ? (
        <div style={{ textAlign: "center", padding: 80, fontSize: 14, color: "#888", fontWeight: 500, border: "2px dashed #ccc" }}>
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

function EventRow({ ev, busy, onEdit, onTogglePublish, onDelete }: {
  ev: HodEvent; busy: string;
  onEdit: () => void; onTogglePublish: () => void; onDelete: () => void;
}) {
  const pct = (ev.capacity || 0) > 0 ? Math.round(((ev.sold || 0) / (ev.capacity || 1)) * 100) : 0;
  const isPub = !!ev.published;
  return (
    <div style={{ padding: 12, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", background: "#fff", border: `2px solid ${isPub ? "#23A094" : "#000"}`, boxShadow: "2px 2px 0px rgba(0,0,0,.12)" }}>
      {ev.image ? (
        <img src={ev.image} alt="" style={{ width: 64, height: 64, objectFit: "cover", flexShrink: 0, border: "2px solid #000" }} />
      ) : (
        <div style={{ width: 64, height: 64, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 24, background: ev.color || "#F4F4F0", border: "2px solid #000" }}>🎵</div>
      )}
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 2 }}>
          <div style={{ fontWeight: 700, fontSize: 14 }}>{ev.title}</div>
          <span style={{ fontSize: 10, padding: "2px 7px", fontWeight: 900, textTransform: "uppercase", letterSpacing: .5, background: isPub ? "#E8FFF5" : "#FFFBEB", color: isPub ? "#23A094" : "#F59E0B", border: `1px solid ${isPub ? "#23A094" : "#F59E0B"}` }}>
            {isPub ? "● LIVE" : "○ DRAFT"}
          </span>
        </div>
        <div style={{ fontSize: 12, color: "#666", marginBottom: 2 }}>
          {fmtDate(ev.date)} · {ev.time || "—"} · {ev.dj || "no DJ"} · {ev.genre || "—"}
        </div>
        <div style={{ fontSize: 11, color: "#888" }}>
          Stag {inr(ev.stagPrice)} · Couple {inr(ev.couplePrice)} · Entry {inr(ev.entryOnlyPrice)} · T4 {inr(ev.table4Price)} · VVIP {inr(ev.vipPrice)}
        </div>
      </div>
      <div style={{ textAlign: "right", flexShrink: 0 }}>
        <div style={{ fontWeight: 900, fontSize: 15, color: "#000" }}>
          {ev.sold || 0}<span style={{ fontSize: 11, color: "#aaa" }}>/{ev.capacity || 0}</span>
        </div>
        <div style={{ fontSize: 10, color: "#888" }}>{pct}% sold</div>
      </div>
      <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
        <button onClick={onEdit} disabled={!!busy}
          style={{ padding: "6px 12px", fontSize: 12, fontWeight: 700, cursor: "pointer", background: "#FFFBEB", color: "#000", border: "2px solid #F2C744", boxShadow: "2px 2px 0px #000" }}>
          ✎ Edit
        </button>
        <button onClick={onTogglePublish} disabled={busy === `pub-${ev.id}`}
          style={{ padding: "6px 12px", fontSize: 12, fontWeight: 700, cursor: "pointer",
            background: isPub ? "#FFFBEB" : "#E8FFF5",
            color: isPub ? "#F59E0B" : "#23A094",
            border: `2px solid ${isPub ? "#F59E0B" : "#23A094"}`,
            boxShadow: "2px 2px 0px rgba(0,0,0,.2)",
          }}>
          {busy === `pub-${ev.id}` ? "…" : isPub ? "Unpublish" : "Publish"}
        </button>
        <button onClick={onDelete} disabled={busy === `del-${ev.id}`}
          style={{ padding: "6px 10px", fontSize: 12, fontWeight: 700, cursor: "pointer", background: "#FFF0EE", color: "#EF4444", border: "2px solid #EF4444", boxShadow: "2px 2px 0px rgba(239,68,68,.3)" }}>
          🗑
        </button>
      </div>
    </div>
  );
}

// ─── FORM ───────────────────────────────────────────────────────────────────

const inputCls = "w-full px-3 py-2 text-sm outline-none";
const inpStyle: React.CSSProperties = {
  background: "#fff", border: "2px solid #000", color: "#000",
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ background: "#fff", border: "2px solid #000", padding: 16 }}>
      <div style={{ fontSize: 11, fontWeight: 900, textTransform: "uppercase", letterSpacing: 1, marginBottom: 12, color: "#555" }}>{title}</div>
      <div className="space-y-3">{children}</div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", display: "block", marginBottom: 4, color: "#555" }}>{label}</label>
      {children}
    </div>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-2 gap-3">{children}</div>;
}

function FormView({ form, setForm, editing, busy, onCancel, onSave, onPublish, onImageFile }: {
  form: Partial<HodEvent>; setForm: (f: Partial<HodEvent>) => void;
  editing: HodEvent | null; busy: string;
  onCancel: () => void; onSave: () => void; onPublish: () => void;
  onImageFile: (f: File) => void;
}) {
  const set = <K extends keyof HodEvent>(k: K, v: HodEvent[K]) => setForm({ ...form, [k]: v });
  const setN = (k: keyof HodEvent, raw: string) => {
    const n = raw === "" ? undefined : Number(raw);
    setForm({ ...form, [k]: n as any });
  };

  return (
    <div style={{ color: "#000" }}>
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <div>
          <div style={{ fontSize: 18, fontWeight: 900, color: "#000", textTransform: "uppercase" }}>
            {editing ? `✎ Edit: ${editing.title}` : "+ New Event"}
          </div>
          <div style={{ fontSize: 12, color: "#666", marginTop: 2 }}>
            {editing
              ? `Saved changes appear on hodclub.in within seconds (${editing.sold || 0} bookings exist).`
              : "Filled? Save as Draft to preview, or Publish to go live immediately."}
          </div>
        </div>
        <button onClick={onCancel}
          style={{ padding: "7px 14px", fontSize: 12, fontWeight: 700, cursor: "pointer", background: "#F4F4F0", color: "#000", border: "2px solid #000", boxShadow: "2px 2px 0px #000" }}>
          ← Back to list
        </button>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="Basic Info">
          <Field label="Event Title *">
            <input type="text" value={form.title || ""} onChange={(e) => set("title", e.target.value)}
              placeholder="e.g. NEON NIGHTS — DJ ARYAN" className={inputCls} style={inpStyle} />
          </Field>
          <Row>
            <Field label="DJ Name">
              <input type="text" value={form.dj || ""} onChange={(e) => set("dj", e.target.value)}
                placeholder="e.g. DJ Aryan" className={inputCls} style={inpStyle} />
            </Field>
            <Field label="Genre">
              <input type="text" value={form.genre || ""} onChange={(e) => set("genre", e.target.value)}
                placeholder="e.g. Techno / House" className={inputCls} style={inpStyle} />
            </Field>
          </Row>
          <Row>
            <Field label="Date *">
              <input type="date" value={form.date || ""} onChange={(e) => set("date", e.target.value)}
                className={inputCls} style={inpStyle} />
            </Field>
            <Field label="Capacity">
              <input type="number" value={form.capacity ?? ""} onChange={(e) => setN("capacity", e.target.value)}
                placeholder="150" className={inputCls} style={inpStyle} />
            </Field>
          </Row>
          <Row>
            <Field label="Start Time">
              <input type="text" value={form.time || ""} onChange={(e) => set("time", e.target.value)}
                placeholder="9:00 PM" className={inputCls} style={inpStyle} />
            </Field>
            <Field label="End Time">
              <input type="text" value={form.endTime || ""} onChange={(e) => set("endTime", e.target.value)}
                placeholder="3:00 AM" className={inputCls} style={inpStyle} />
            </Field>
          </Row>
          <Field label="Venue">
            <input type="text" value={form.venue || ""} onChange={(e) => set("venue", e.target.value)}
              className={inputCls} style={inpStyle} />
          </Field>
          <Field label="Description">
            <textarea value={form.description || ""} onChange={(e) => set("description", e.target.value)}
              placeholder="Describe the night, DJ style, special guests…"
              rows={4} className={inputCls + " resize-y"} style={inpStyle} />
          </Field>
        </Section>

        <div className="space-y-4">
          <Section title="Pricing">
            <Row>
              <Field label="Cover (base) ₹">
                <input type="number" value={form.price ?? ""} onChange={(e) => setN("price", e.target.value)}
                  placeholder="999" className={inputCls} style={inpStyle} />
              </Field>
              <Field label="Entry Only ₹">
                <input type="number" value={form.entryOnlyPrice ?? ""} onChange={(e) => setN("entryOnlyPrice", e.target.value)}
                  placeholder="599" className={inputCls} style={inpStyle} />
              </Field>
            </Row>
            <Row>
              <Field label="Stag ₹">
                <input type="number" value={form.stagPrice ?? ""} onChange={(e) => setN("stagPrice", e.target.value)}
                  placeholder="999" className={inputCls} style={inpStyle} />
              </Field>
              <Field label="Couple ₹">
                <input type="number" value={form.couplePrice ?? ""} onChange={(e) => setN("couplePrice", e.target.value)}
                  placeholder="1499" className={inputCls} style={inpStyle} />
              </Field>
            </Row>
            <Row>
              <Field label="Group (total) ₹">
                <input type="number" value={form.groupPrice ?? ""} onChange={(e) => setN("groupPrice", e.target.value)}
                  placeholder="2999" className={inputCls} style={inpStyle} />
              </Field>
              <Field label="Group (per head) ₹">
                <input type="number" value={form.groupPerHeadPrice ?? ""} onChange={(e) => setN("groupPerHeadPrice", e.target.value)}
                  placeholder="500" className={inputCls} style={inpStyle} />
              </Field>
            </Row>
            <Row>
              <Field label="Table 4-pax ₹">
                <input type="number" value={form.table4Price ?? ""} onChange={(e) => setN("table4Price", e.target.value)}
                  placeholder="5000" className={inputCls} style={inpStyle} />
              </Field>
              <Field label="VVIP ₹">
                <input type="number" value={form.vipPrice ?? ""} onChange={(e) => setN("vipPrice", e.target.value)}
                  placeholder="15000" className={inputCls} style={inpStyle} />
              </Field>
            </Row>
            <Row>
              <Field label="GF4 Stock">
                <input type="number" value={form.gf4Stock ?? ""} onChange={(e) => setN("gf4Stock", e.target.value)}
                  placeholder="4" className={inputCls} style={inpStyle} />
              </Field>
              <Field label="VVIP Stock">
                <input type="number" value={form.vvipStock ?? ""} onChange={(e) => setN("vvipStock", e.target.value)}
                  placeholder="2" className={inputCls} style={inpStyle} />
              </Field>
            </Row>
          </Section>

          <Section title="Poster Image">
            <div>
              {form.image && (
                <img src={form.image} alt="Poster" style={{ width: "100%", maxHeight: 200, objectFit: "cover", marginBottom: 8, border: "2px solid #000" }} />
              )}
              <input type="file" accept="image/*" disabled={busy === "img"}
                onChange={(e) => { const f = e.target.files?.[0]; if (f) onImageFile(f); }}
                style={{ width: "100%", padding: 8, border: "2px solid #000", background: "#F4F4F0", color: "#000", cursor: "pointer", fontSize: 12 }} />
              {busy === "img" && <div style={{ fontSize: 11, color: "#888", marginTop: 4 }}>⏳ Compressing image…</div>}
            </div>
          </Section>
        </div>
      </div>

      <div style={{ display: "flex", gap: 12, marginTop: 20, flexWrap: "wrap" }}>
        <button onClick={onSave} disabled={!!busy}
          style={{ padding: "12px 24px", fontSize: 14, fontWeight: 900, cursor: "pointer", background: "#F4F4F0", color: "#000", border: "2px solid #000", boxShadow: "3px 3px 0px #000" }}>
          💾 Save as Draft
        </button>
        <button onClick={onPublish} disabled={!!busy}
          style={{ padding: "12px 24px", fontSize: 14, fontWeight: 900, cursor: "pointer", background: "#23A094", color: "#fff", border: "2px solid #000", boxShadow: "3px 3px 0px #000" }}>
          🚀 Publish Live
        </button>
        <button onClick={onCancel}
          style={{ padding: "12px 20px", fontSize: 13, fontWeight: 700, cursor: "pointer", background: "#fff", color: "#000", border: "2px solid #000", boxShadow: "2px 2px 0px #000" }}>
          Cancel
        </button>
      </div>
    </div>
  );
}
