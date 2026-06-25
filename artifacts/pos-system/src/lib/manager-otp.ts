// ════════════════════════════════════════════════════════════════════════
// HOD — Manager discount OTP (client helpers)
// (Khushi 2026-06-25 — captain discounts need a one-time WhatsApp code from a
//  manager, valid 10 min. Code is minted + verified SERVER-side so a captain
//  can't read/self-approve. Manager PIN stays as the silent fallback.)
//
// Both calls are FAIL-OPEN at the call site: the discount gate keeps the
// Manager PIN as a backup, so a network blip here just means "use the PIN".
// ════════════════════════════════════════════════════════════════════════

const OTP_CF_BASE = "https://asia-south1-hod-tickets.cloudfunctions.net";

export interface OtpContext {
  by?: string;
  tableId?: string;
  discountPct?: number;
  amount?: number;
}

export interface OtpRequestResult {
  ok: boolean;
  otpId: string | null;
  sentTo: number; // how many manager phones Meta accepted (0 = couldn't send)
}

// Race a fetch against a wall-clock timeout so a stalled venue-wifi request
// can't hang the discount prompt — we just fall back to the Manager PIN.
async function fetchWithTimeout(url: string, body: unknown, ms: number): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(t);
  }
}

/** Ask the server to mint a 6-digit OTP and WhatsApp it to the managers.
 *  Returns otpId (needed for verify) + how many phones were reached.
 *  Never throws — on any failure returns {ok:false, otpId:null, sentTo:0}. */
export async function requestManagerDiscountOtp(ctx: OtpContext): Promise<OtpRequestResult> {
  try {
    const r = await fetchWithTimeout(`${OTP_CF_BASE}/requestManagerDiscountOtp`, ctx, 9000);
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data || !data.ok || !data.otpId) {
      return { ok: false, otpId: null, sentTo: 0 };
    }
    return { ok: true, otpId: String(data.otpId), sentTo: Number(data.sentTo) || 0 };
  } catch {
    return { ok: false, otpId: null, sentTo: 0 };
  }
}

/** Verify a captain-entered code against the server. Single-use + 10-min
 *  expiry are enforced server-side. Returns true ONLY on a confirmed match.
 *  Never throws — any error returns false (the PIN fallback still applies). */
export async function verifyManagerDiscountOtp(otpId: string, code: string): Promise<boolean> {
  if (!otpId || !code) return false;
  try {
    const r = await fetchWithTimeout(
      `${OTP_CF_BASE}/verifyManagerDiscountOtp`,
      { otpId, code: String(code).trim() },
      9000,
    );
    const data = await r.json().catch(() => ({}));
    return !!(r.ok && data && data.ok === true);
  } catch {
    return false;
  }
}
