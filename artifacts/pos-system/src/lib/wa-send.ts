// 🆕 2026-06-02 (Khushi) — Shared free-form WhatsApp text sender (Meta Cloud
// API via the HOD Cloud Function). Used for WAITLIST notifications, which have
// no pre-approved template. Fire-and-forget + fail-open: a messaging failure
// must NEVER block a door action (add-to-waitlist / assign-table).
//
// NOTE: free-form text is only DELIVERED by Meta if the customer messaged HOD
// within the last 24h ("customer-service window"). Outside that window Meta
// silently drops it. This is fine for the waitlist (the door girl can still
// CALL / open WhatsApp manually) but worth knowing — for guaranteed delivery a
// pre-approved template would be needed.
const WA_CF_BASE = "https://asia-south1-hod-tickets.cloudfunctions.net";

export async function sendWhatsAppTextMessage(
  phone: string,
  message: string,
): Promise<{ ok: boolean; error?: string }> {
  let digits = (phone || "").replace(/\D/g, "");
  if (digits.length === 10) digits = "91" + digits;
  if (digits.length < 10) return { ok: false, error: "Invalid phone" };
  try {
    const r = await fetch(`${WA_CF_BASE}/sendWhatsAppText`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: digits, message }),
    });
    let data: any = null;
    try { data = await r.json(); } catch { /* ignore non-JSON */ }
    if (r.ok && data?.ok) return { ok: true };
    return { ok: false, error: data?.error || `HTTP ${r.status}` };
  } catch (e: any) {
    return { ok: false, error: e?.message || "Network error" };
  }
}

// 🆕 2026-06-02 (Khushi) — template-first sender (mirrors DoorMode's
// sendWhatsAppViaMeta) so the WAITLIST "assign table" flow can fire the SAME
// `table_confirmed` approved template a normal door table booking sends —
// reliably delivered OUTSIDE Meta's 24h window. Falls back to free-form text.
// Fail-open: never throws; a messaging problem must never block the door.
export async function sendWhatsAppViaMetaShared(opts: {
  phone: string;
  template?: { name: string; params: string[]; language?: string };
  fallbackText: string;
}): Promise<{ ok: boolean; via?: "template" | "text"; error?: string }> {
  let digits = (opts.phone || "").replace(/\D/g, "");
  if (digits.length === 10) digits = "91" + digits;
  if (digits.length < 10) return { ok: false, error: "Invalid phone" };

  // 1) Approved template (works outside the 24h customer-service window).
  if (opts.template) {
    try {
      const r = await fetch(`${WA_CF_BASE}/sendWhatsAppTemplate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          to: digits, template: opts.template.name,
          language: opts.template.language || "en", params: opts.template.params,
        }),
      });
      let data: any = null;
      try { data = await r.json(); } catch { /* ignore non-JSON */ }
      if (r.ok && data?.ok) return { ok: true, via: "template" };
      console.warn("[waitlist][wa] template send failed, trying text:", data);
    } catch (e) { console.warn("[waitlist][wa] template request error", e); }
  }

  // 2) Free-form text fallback (only delivered inside the 24h window).
  try {
    const r = await fetch(`${WA_CF_BASE}/sendWhatsAppText`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: digits, message: opts.fallbackText }),
    });
    let data: any = null;
    try { data = await r.json(); } catch { /* ignore non-JSON */ }
    if (r.ok && data?.ok) return { ok: true, via: "text" };
    return { ok: false, error: data?.error || `HTTP ${r.status}` };
  } catch (e: any) {
    return { ok: false, error: e?.message || "Network error" };
  }
}
