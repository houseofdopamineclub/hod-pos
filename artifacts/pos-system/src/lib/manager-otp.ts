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

// ════════════════════════════════════════════════════════════════════════
// SINGLE-CODE GUARD (2026-06-25 — Khushi: "I keep getting 2 OTPs, only one
// works"). requireManagerApproval used to mint a FRESH code on every call,
// and it fires from BOTH the discount-field onBlur AND the bill-confirm gate
// (and onBlur can fire on every focus loss). That sprayed several codes; only
// the one bound to the currently-open prompt's otpId verified, so the captain
// saw "incorrect" on the others. The server cooldown was meant to dedupe but
// is a 45s read-then-write race.
//
// Fix: cache the live otpId PER TABLE on the client and REUSE it (no new
// request, no new WhatsApp, same code) for the whole approval session, plus an
// in-flight promise so a near-simultaneous onBlur+confirm share ONE request.
// Cleared the moment a code is successfully burned, so the next discount mints
// fresh. Fail-open: a failed mint is never cached, so the PIN fallback applies.
// ════════════════════════════════════════════════════════════════════════
interface OtpCacheEntry {
  otpId: string;
  sentTo: number;
  mintedAt: number;
}
// Reuse a live code for up to 8 min (server TTL is 10 min — leaves a margin so
// a reused code can't verify after it has already expired server-side).
const OTP_REUSE_WINDOW_MS = 8 * 60 * 1000;
const otpCache = new Map<string, OtpCacheEntry>();
const otpInflight = new Map<string, Promise<OtpRequestResult>>();

function otpKeyOf(ctx: OtpContext): string {
  const t = ctx && typeof ctx.tableId === "string" ? ctx.tableId.trim() : "";
  return t ? t.slice(0, 60) : "global";
}

/** Get a manager OTP, REUSING the table's live code if one was minted recently.
 *  Collapses the onBlur + confirm double-request (and rapid double-taps) into a
 *  single code so the captain only ever has ONE code to enter. Never throws. */
export async function getManagerDiscountOtp(ctx: OtpContext): Promise<OtpRequestResult> {
  const key = otpKeyOf(ctx);
  const now = Date.now();

  const cached = otpCache.get(key);
  if (cached && cached.otpId && now - cached.mintedAt < OTP_REUSE_WINDOW_MS) {
    return { ok: true, otpId: cached.otpId, sentTo: cached.sentTo };
  }

  // Share an already-running request so two gates firing together send once.
  const pending = otpInflight.get(key);
  if (pending) return pending;

  const p = (async (): Promise<OtpRequestResult> => {
    const res = await requestManagerDiscountOtp(ctx);
    if (res.ok && res.otpId) {
      otpCache.set(key, { otpId: res.otpId, sentTo: res.sentTo, mintedAt: Date.now() });
    }
    return res;
  })();
  otpInflight.set(key, p);
  try {
    return await p;
  } finally {
    otpInflight.delete(key);
  }
}

/** Drop a table's cached code — call right after a code is successfully burned
 *  so the NEXT discount on that table mints a fresh one. */
export function clearManagerDiscountOtp(ctx: OtpContext | string): void {
  const key = typeof ctx === "string" ? (ctx.trim().slice(0, 60) || "global") : otpKeyOf(ctx);
  otpCache.delete(key);
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
