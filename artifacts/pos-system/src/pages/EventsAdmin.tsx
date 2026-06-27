import { useEffect, useMemo, useRef, useState } from "react";
import {
  subscribeToHodEvents, createHodEvent, updateHodEvent, updateHodEventImageOnly,
  toggleHodEventPublished, deleteHodEvent, deleteExpiredHodEvents, uploadEventPoster, type HodEvent,
} from "../lib/firestore-hod";

type Tab = "list" | "form";
type StatusFilter = "upcoming" | "past" | "all";

const SHADOW_SM = "2px 2px 0px #000";
const SHADOW_MD = "3px 3px 0px #000";

// 🆕 2026-06-27 (Khushi) — in-app (Gumroad) popup styles. These replace every
// native browser alert()/confirm()/prompt() in Events with branded modals.
const modalBackdrop: React.CSSProperties = {
  position: "fixed", inset: 0, zIndex: 99999, background: "rgba(0,0,0,.45)",
  display: "flex", alignItems: "center", justifyContent: "center", padding: 20,
};
const modalCard: React.CSSProperties = {
  width: "100%", maxWidth: 420, background: "#fff", border: "2px solid #000",
  boxShadow: "6px 6px 0px #000", overflow: "hidden",
};
const modalHeader: React.CSSProperties = {
  padding: "12px 16px", color: "#fff", fontWeight: 900, fontSize: 15, textTransform: "uppercase", letterSpacing: 0.5,
};
const modalBody: React.CSSProperties = {
  padding: "16px", fontSize: 14, lineHeight: 1.5, color: "#000", whiteSpace: "pre-wrap",
};
const modalFooter: React.CSSProperties = {
  padding: "0 16px 16px", display: "flex", justifyContent: "flex-end",
};
const btnPrimary: React.CSSProperties = {
  padding: "9px 20px", fontSize: 13, fontWeight: 900, cursor: "pointer",
  background: "#FF90E8", color: "#000", border: "2px solid #000", boxShadow: SHADOW_SM,
};
const btnGhost: React.CSSProperties = {
  padding: "9px 18px", fontSize: 13, fontWeight: 700, cursor: "pointer",
  background: "#fff", color: "#000", border: "2px solid #000", boxShadow: SHADOW_SM,
};
const btnDanger: React.CSSProperties = {
  padding: "9px 20px", fontSize: 13, fontWeight: 900, cursor: "pointer",
  background: "#FF4D4D", color: "#fff", border: "2px solid #000", boxShadow: SHADOW_SM,
};

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

// 🆕 2026-06-27 (Khushi) — quality raised for the carousel. Posters now live in
// Firebase Storage (CDN, lazy-loaded), NOT inside the Firestore event doc, so a
// bigger/sharper poster costs ZERO extra Firestore reads. maxWidth 800→1600,
// maxBytes 140KB→520KB, start quality 0.82→0.9.
async function compressImage(file: File | string, maxBytes = 520_000, maxWidth = 1600): Promise<string> {
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
  let q = 0.9;
  let out = cv.toDataURL(fmt, q);
  while (out.length > maxBytes && q > 0.45) { q -= 0.08; out = cv.toDataURL(fmt, q); }
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
  // 🆕 2026-06-27 (Khushi) — in-app popup state. The old delete used
  // window.prompt("type DELETE") which SILENTLY failed when she typed lowercase
  // "delete" — a confirm BUTTON (no typing) fixes that bug too.
  const [notice, setNotice] = useState<{ kind: "ok" | "err"; title: string; msg: string } | null>(null);
  const [confirmState, setConfirmState] = useState<
    { title: string; msg: string; confirmLabel: string; danger: boolean; onConfirm: () => void } | null
  >(null);
  const notify = (kind: "ok" | "err", title: string, msg: string) => setNotice({ kind, title, msg });
  const askConfirm = (opts: { title: string; msg: string; confirmLabel?: string; danger?: boolean; onConfirm: () => void }) =>
    setConfirmState({ title: opts.title, msg: opts.msg, confirmLabel: opts.confirmLabel || "Confirm", danger: !!opts.danger, onConfirm: opts.onConfirm });

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
    if (!form.title?.trim()) { notify("err", "Missing title", "Event title is required."); return; }
    if (!form.date) { notify("err", "Missing date", "Event date is required."); return; }
    setBusy("save");
    try {
      const data = { ...form, published: publish ? true : !!form.published };
      if (editId) await updateHodEvent(editId, data);
      else await createHodEvent(data);
      cancelForm();
    } catch (e: any) { notify("err", "Save failed", e?.message || String(e)); }
    setBusy("");
  };

  const handleTogglePublish = async (ev: HodEvent) => {
    const doToggle = async () => {
      setBusy(`pub-${ev.id}`);
      try { await toggleHodEventPublished(ev.id, !ev.published); }
      catch (e: any) { notify("err", "Toggle failed", e?.message || String(e)); }
      setBusy("");
    };
    // Unpublishing a LIVE event hides it from hodclub.in immediately — confirm
    // first (this is the popup Khushi saw on unpublish, now in-app). Publishing
    // a hidden event needs no confirm.
    if (ev.published) {
      askConfirm({
        title: "Unpublish event?",
        msg: `"${ev.title}" will be hidden from hodclub.in immediately. Existing bookings are NOT affected — you can publish it again anytime.`,
        confirmLabel: "Unpublish",
        danger: true,
        onConfirm: doToggle,
      });
    } else {
      doToggle();
    }
  };

  const handleDelete = async (ev: HodEvent) => {
    const sold = ev.sold || 0;
    const msg = sold > 0
      ? `⚠️ "${ev.title}" already has ${sold} booking(s). Deleting will NOT refund customers.\n\nThis cannot be undone.`
      : `Delete "${ev.title}" (${fmtDate(ev.date)})?\n\nThis cannot be undone.`;
    askConfirm({
      title: "Delete event?",
      msg,
      confirmLabel: "Delete",
      danger: true,
      onConfirm: async () => {
        setBusy(`del-${ev.id}`);
        try { await deleteHodEvent(ev.id); }
        catch (e: any) { notify("err", "Delete failed", e?.message || String(e)); }
        setBusy("");
      },
    });
  };

  // 🆕 2026-06-27 (Khushi) — multi-poster (carousel) upload. Accepts 1..N files,
  // appends to form.images (cap 5), keeps image=images[0] for back-compat.
  // Each poster is compressed → uploaded to Firebase Storage (only the short URL
  // is stored, so event docs stay tiny → hodclub.in paints instantly). Fail-open:
  // a single upload failure falls back to the inline base64 so the owner is never
  // blocked from saving the event.
  const handleImageFiles = async (files: File[]) => {
    if (!files.length) return;
    setBusy("img");
    try {
      const existing = (Array.isArray(form.images) && form.images.length)
        ? form.images.slice()
        : (form.image ? [form.image] : []);
      const room = Math.max(0, 5 - existing.length);
      const take = files.slice(0, room);
      for (const file of take) {
        try {
          const dataUrl = await compressImage(file);
          let stored = dataUrl;
          try { stored = await uploadEventPoster(dataUrl); }
          catch (up) { console.error("Poster upload to Storage failed — keeping inline image", up); }
          existing.push(stored);
        } catch (e) { console.error("Poster compress failed for one file", e); }
      }
      const images = existing.slice(0, 5);
      setForm((f) => ({ ...f, images, image: images[0] || "" }));
      if (files.length > room) {
        notify("ok", "Poster limit reached", `Up to 5 posters per event — added ${room}, skipped ${files.length - room}.`);
      }
    }
    catch (e: any) { notify("err", "Image processing failed", e?.message || String(e)); }
    setBusy("");
  };

  const handleOptimizeAll = async () => {
    if (optimizeRunning.current) return;
    // Target every poster still stored as a base64 data: URI INSIDE the event
    // doc — those are what bloat the events query and cause the slow load.
    // http(s) images are already on Storage (or external) → nothing to move.
    const targets = events.filter((e) => !!e.image && e.image!.startsWith("data:"));
    if (targets.length === 0) { notify("ok", "Nothing to optimize", "All posters are already on fast storage — nothing to do."); return; }
    const totalKb = Math.round(targets.reduce((s, e) => s + (e.image?.length || 0), 0) / 1024);
    askConfirm({
      title: "Speed up hodclub.in?",
      msg: `${targets.length} poster(s) (~${totalKb} KB) are stored INSIDE the event records, which slows the customer site's event loading.\n\nThis moves them to fast image storage — posters look identical — and is safe to run during live bookings. Existing bookings/stock are NOT touched.`,
      confirmLabel: "Optimize",
      onConfirm: async () => {
        optimizeRunning.current = true;
        setBusy("optimize-all");
        let done = 0, failed = 0, savedKb = 0;
        for (const ev of targets) {
          try {
            const before = ev.image!.length;
            const out = await compressImage(ev.image!);   // shrink first
            const url = await uploadEventPoster(out);       // move OUT of the doc → Storage
            await updateHodEventImageOnly(ev.id, url);       // store only the short URL
            savedKb += Math.round(before / 1024);            // the whole base64 leaves the doc
            done++;
          } catch (e) { console.error("Optimize failed for", ev.id, e); failed++; }
          setBusy(`optimize-${done + failed}/${targets.length}`);
        }
        setBusy(""); optimizeRunning.current = false;
        notify("ok", "Optimize complete", `✅ ${done} moved to fast storage, ${failed} failed.\nEvent records are now ~${savedKb} KB lighter — hodclub.in loads much faster.`);
      },
    });
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

  // 🆕 in-app (Gumroad) popups — rendered in BOTH the list and form views so a
  // notice/confirm fired from the form (e.g. Save validation) is always visible.
  const modals = (
    <>
      {notice && (
        <div onClick={() => setNotice(null)} style={modalBackdrop}>
          <div onClick={(e) => e.stopPropagation()} style={modalCard}>
            <div style={{ ...modalHeader, background: notice.kind === "ok" ? "#23A094" : "#FF4D4D" }}>
              {notice.kind === "ok" ? "✅ " : "⚠️ "}{notice.title}
            </div>
            <div style={modalBody}>{notice.msg}</div>
            <div style={modalFooter}>
              <button onClick={() => setNotice(null)} style={btnPrimary}>OK</button>
            </div>
          </div>
        </div>
      )}
      {confirmState && (
        <div onClick={() => setConfirmState(null)} style={modalBackdrop}>
          <div onClick={(e) => e.stopPropagation()} style={modalCard}>
            <div style={{ ...modalHeader, background: confirmState.danger ? "#FF4D4D" : "#23A094" }}>
              {confirmState.danger ? "⚠️ " : ""}{confirmState.title}
            </div>
            <div style={modalBody}>{confirmState.msg}</div>
            <div style={{ ...modalFooter, gap: 10 }}>
              <button onClick={() => setConfirmState(null)} style={btnGhost}>Cancel</button>
              <button
                onClick={() => { const fn = confirmState.onConfirm; setConfirmState(null); fn(); }}
                style={confirmState.danger ? btnDanger : btnPrimary}
              >
                {confirmState.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );

  if (tab === "form") {
    return (
      <>
        <FormView
          form={form} setForm={setForm} editing={editing} busy={busy}
          onCancel={cancelForm} onSave={() => handleSave(false)}
          onPublish={() => handleSave(true)} onImageFiles={handleImageFiles}
        />
        {modals}
      </>
    );
  }

  return (
    <>
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
            title="Move event posters to fast image storage — speeds up hodclub.in event loading">
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
    {modals}
    </>
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
        <div style={{ fontSize: 12, color: "#1A1A1A", fontWeight: 600, marginBottom: 2 }}>
          {fmtDate(ev.date)} · {ev.time || "—"} · {ev.dj || "no DJ"} · {ev.genre || "—"}
        </div>
        <div style={{ fontSize: 11, color: "#3D3D3D", fontWeight: 600 }}>
          Stag {inr(ev.stagPrice)} · Couple {inr(ev.couplePrice)} · Entry {inr(ev.entryOnlyPrice)} · T4 {inr(ev.table4Price)} · VVIP {inr(ev.vipPrice)}
        </div>
      </div>
      <div style={{ textAlign: "right", flexShrink: 0 }}>
        <div style={{ fontWeight: 900, fontSize: 15, color: "#000" }}>
          {ev.sold || 0}<span style={{ fontSize: 11, color: "#888" }}>/{ev.capacity || 0}</span>
        </div>
        <div style={{ fontSize: 10, color: "#3D3D3D", fontWeight: 700 }}>{pct}% sold</div>
      </div>
      <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
        <button onClick={onEdit} disabled={!!busy}
          style={{ padding: "7px 14px", fontSize: 12, fontWeight: 900, cursor: "pointer", background: "#FF90E8", color: "#000", border: "2px solid #000", boxShadow: "3px 3px 0px #000" }}>
          ✎ Edit
        </button>
        <button onClick={onTogglePublish} disabled={busy === `pub-${ev.id}`}
          style={{ padding: "7px 14px", fontSize: 12, fontWeight: 900, cursor: "pointer",
            background: "#FF90E8", color: "#000", border: "2px solid #000",
            boxShadow: "3px 3px 0px #000",
          }}>
          {busy === `pub-${ev.id}` ? "…" : isPub ? "Unpublish" : "Publish"}
        </button>
        <button onClick={onDelete} disabled={busy === `del-${ev.id}`}
          style={{ padding: "7px 12px", fontSize: 12, fontWeight: 900, cursor: "pointer", background: "#fff", color: "#EF4444", border: "2px solid #000", boxShadow: "3px 3px 0px #000" }}>
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

function FormView({ form, setForm, editing, busy, onCancel, onSave, onPublish, onImageFiles }: {
  form: Partial<HodEvent>; setForm: (f: Partial<HodEvent>) => void;
  editing: HodEvent | null; busy: string;
  onCancel: () => void; onSave: () => void; onPublish: () => void;
  onImageFiles: (files: File[]) => void;
}) {
  const set = <K extends keyof HodEvent>(k: K, v: HodEvent[K]) => setForm({ ...form, [k]: v });
  const setN = (k: keyof HodEvent, raw: string) => {
    const n = raw === "" ? undefined : Number(raw);
    setForm({ ...form, [k]: n as any });
  };
  // 🆕 carousel posters. Fall back to the legacy single `image` if `images` is
  // empty so editing an old event still shows its poster.
  const posters = (form.images && form.images.length) ? form.images : (form.image ? [form.image] : []);
  const removePoster = (i: number) => {
    const next = posters.filter((_, idx) => idx !== i);
    setForm({ ...form, images: next, image: next[0] || "" });
  };
  const makeCover = (i: number) => {
    if (i <= 0) return;
    const next = posters.slice();
    const [picked] = next.splice(i, 1);
    next.unshift(picked);
    setForm({ ...form, images: next, image: next[0] || "" });
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

          <Section title="Poster Images (up to 5)">
            <div>
              {posters.length > 0 && (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(90px,1fr))", gap: 8, marginBottom: 10 }}>
                  {posters.map((src, i) => (
                    <div key={i} style={{ position: "relative", border: "2px solid #000", aspectRatio: "4 / 5", overflow: "hidden", background: "#000" }}>
                      <img src={src} alt={`Poster ${i + 1}`} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                      {i === 0 && (
                        <div style={{ position: "absolute", top: 0, left: 0, background: "#FF90E8", color: "#000", fontSize: 9, fontWeight: 900, padding: "2px 5px", borderRight: "1px solid #000", borderBottom: "1px solid #000" }}>COVER</div>
                      )}
                      <button type="button" onClick={() => removePoster(i)} title="Remove poster"
                        style={{ position: "absolute", top: 2, right: 2, width: 22, height: 22, lineHeight: "16px", textAlign: "center", background: "#FF4D4D", color: "#fff", border: "1px solid #000", cursor: "pointer", fontWeight: 900, fontSize: 14, padding: 0 }}>×</button>
                      {i !== 0 && (
                        <button type="button" onClick={() => makeCover(i)} title="Make this the cover"
                          style={{ position: "absolute", bottom: 2, right: 2, background: "#fff", color: "#000", border: "1px solid #000", cursor: "pointer", fontSize: 9, fontWeight: 900, padding: "1px 4px" }}>★ cover</button>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {posters.length < 5 ? (
                <input type="file" accept="image/*" multiple disabled={busy === "img"}
                  onChange={(e) => { const fs = Array.from(e.target.files || []); if (fs.length) onImageFiles(fs); e.currentTarget.value = ""; }}
                  style={{ width: "100%", padding: 8, border: "2px solid #000", background: "#F4F4F0", color: "#000", cursor: "pointer", fontSize: 12 }} />
              ) : (
                <div style={{ fontSize: 11, color: "#888" }}>Maximum 5 posters — remove one to add another.</div>
              )}
              {busy === "img" && <div style={{ fontSize: 11, color: "#888", marginTop: 4 }}>⏳ Uploading poster(s)…</div>}
              <div style={{ fontSize: 10, color: "#999", marginTop: 6 }}>
                {posters.length}/5 — pick several at once. The first (COVER) is shown on the events list; all of them appear as a swipeable carousel on hodclub.in.
              </div>
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
