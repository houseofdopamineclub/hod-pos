/**
 * HOD WhatsApp Cloud Functions
 * =============================
 * Replaces the Replit-hosted /api/whatsapp/* endpoints.
 *
 * Deploy to: `hod-tickets` Firebase project
 * Region: asia-south1 (matches existing functions)
 *
 * Secrets required (set once via Firebase CLI):
 *   firebase functions:secrets:set WHATSAPP_TOKEN
 *   firebase functions:secrets:set WHATSAPP_PHONE_ID
 *   firebase functions:secrets:set WHATSAPP_API_VERSION   (optional, defaults to v21.0)
 *
 * Response format matches the old Replit API:
 *   Success: { ok: true, recipient: "+91XXXXX" }
 *   Error:   { ok: false, error: "...", code: 132001 }
 */

import * as functions from "firebase-functions";

// ── Secrets ──────────────────────────────────────────────────────────────────
// Set via: firebase functions:secrets:set <NAME>
const cfg = functions.config();
const WHATSAPP_TOKEN       = process.env.WHATSAPP_TOKEN       || "";
const WHATSAPP_PHONE_ID    = process.env.WHATSAPP_PHONE_ID    || "";
const WHATSAPP_API_VERSION = process.env.WHATSAPP_API_VERSION || "v21.0";

// ── Helper: call Meta WhatsApp Cloud API ─────────────────────────────────────
async function metaApi(opts: {
  phoneId: string;
  token: string;
  version: string;
  body: unknown;
}): Promise<{ ok: boolean; data?: any; error?: string; code?: number; status: number }> {
  const url = `https://graph.facebook.com/${opts.version}/${opts.phoneId}/messages`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${opts.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(opts.body),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data?.messages?.[0]?.id) {
      return { ok: true, data, status: res.status };
    }
    const metaErr = data?.error;
    return {
      ok: false,
      error: metaErr?.message || data?.message || `Meta API HTTP ${res.status}`,
      code: metaErr?.code || metaErr?.error_subcode,
      status: res.status,
    };
  } catch (e: any) {
    return { ok: false, error: e?.message || "Network error calling Meta API", status: 0 };
  }
}

// ── CORS helper ──────────────────────────────────────────────────────────────
function setCorsHeaders(res: functions.Response) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

// ══════════════════════════════════════════════════════════════════════════════
// 1) sendWhatsAppTemplate — sends approved Meta templates (works outside 24h)
// ══════════════════════════════════════════════════════════════════════════════
export const sendWhatsAppTemplate = functions
  .runWith({ secrets: ["WHATSAPP_TOKEN", "WHATSAPP_PHONE_ID", "WHATSAPP_API_VERSION"] })
  .https.onRequest(async (req, res) => {
    setCorsHeaders(res);
    if (req.method === "OPTIONS") { res.status(204).end(); return; }
    if (req.method !== "POST") { res.status(405).json({ ok: false, error: "Method not allowed" }); return; }

    const { to, template, language, params } = req.body || {};
    const digits = String(to || "").replace(/\D/g, "");
    if (!digits || digits.length < 10) {
      res.status(400).json({ ok: false, error: "Invalid phone number" });
      return;
    }
    if (!template) {
      res.status(400).json({ ok: false, error: "Missing template name" });
      return;
    }

    const token    = WHATSAPP_TOKEN;
    const phoneId  = WHATSAPP_PHONE_ID;
    const version  = WHATSAPP_API_VERSION || "v21.0";

    if (!token || !phoneId) {
      res.status(500).json({ ok: false, error: "WhatsApp secrets not configured" });
      return;
    }

    const templateParams = (Array.isArray(params) ? params : []).map((p: unknown) => ({
      type: "text",
      text: String(p),
    }));

    const body = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: digits,
      type: "template",
      template: {
        name: template,
        language: { code: language || "en" },
        components: templateParams.length > 0
          ? [{ type: "body", parameters: templateParams }]
          : undefined,
      },
    };

    const result = await metaApi({ phoneId, token, version, body });
    res.status(result.ok ? 200 : 400).json({
      ok: result.ok,
      recipient: `+${digits}`,
      ...(result.ok ? {} : { error: result.error, code: result.code }),
    });
  });

// ══════════════════════════════════════════════════════════════════════════════
// 2) sendWhatsAppText — sends free-form text (only works inside 24h window)
// ══════════════════════════════════════════════════════════════════════════════
export const sendWhatsAppText = functions
  .runWith({ secrets: ["WHATSAPP_TOKEN", "WHATSAPP_PHONE_ID", "WHATSAPP_API_VERSION"] })
  .https.onRequest(async (req, res) => {
    setCorsHeaders(res);
    if (req.method === "OPTIONS") { res.status(204).end(); return; }
    if (req.method !== "POST") { res.status(405).json({ ok: false, error: "Method not allowed" }); return; }

    const { to, message } = req.body || {};
    const digits = String(to || "").replace(/\D/g, "");
    if (!digits || digits.length < 10) {
      res.status(400).json({ ok: false, error: "Invalid phone number" });
      return;
    }
    if (!message || !String(message).trim()) {
      res.status(400).json({ ok: false, error: "Missing message" });
      return;
    }

    const token    = WHATSAPP_TOKEN;
    const phoneId  = WHATSAPP_PHONE_ID;
    const version  = WHATSAPP_API_VERSION || "v21.0";

    if (!token || !phoneId) {
      res.status(500).json({ ok: false, error: "WhatsApp secrets not configured" });
      return;
    }

    const body = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: digits,
      type: "text",
      text: { body: String(message).trim(), preview_url: true },
    };

    const result = await metaApi({ phoneId, token, version, body });
    res.status(result.ok ? 200 : 400).json({
      ok: result.ok,
      recipient: `+${digits}`,
      ...(result.ok ? {} : { error: result.error, code: result.code }),
    });
  });
