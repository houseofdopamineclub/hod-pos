// ════════════════════════════════════════════════════════════════════════
// HOD — WHATSAPP SEND (Firebase Cloud Functions)
// (Khushi ask Wed 14 May 2026 — kill Replit dependency for booking WAs)
// ────────────────────────────────────────────────────────────────────────
//
// WHY THIS EXISTS:
//   The customer site (hodclub.in) sends WhatsApp confirmations for:
//     • cover_confirmed   (event ticket bookings — HOD-xxx)
//     • booking_confirmed (table reservations    — TBL-xxx)
//     • guestlist_confirmed (guestlist signups   — GL-xxx)
//   Until today, those calls hit a Replit api-server (dev preview URL).
//   When the Replit tab was closed/sleeping, customers got NO WhatsApp.
//
//   This drop moves the same logic into Firebase Cloud Functions
//   (asia-south1) so it runs always-on, free, and with no Replit
//   dependency. Same Meta Cloud API call, same body shape — only the
//   URL the customer site hits changes.
//
// ENDPOINTS:
//   POST /sendWhatsAppTemplate
//     Body: { to, template, language?, params? }
//     Resp: { ok:true, recipient, data } on success
//   POST /sendWhatsAppText
//     Body: { to, message }
//     Resp: { ok:true, recipient, data } on success
//
// SECRETS (set ONCE before first deploy):
//   firebase functions:secrets:set WHATSAPP_ACCESS_TOKEN
//   firebase functions:secrets:set WHATSAPP_PHONE_NUMBER_ID
//
// FAIL-OPEN PHILOSOPHY (Khushi's rule):
//   - Bad input (missing to/template) → 400 (caller bug)
//   - Secrets missing → 500 (deploy issue)
//   - Meta API error → forward Meta's status code + error body
//   - WhatsApp send failure NEVER blocks the booking — the customer
//     site fires this fetch async and the booking is already saved
//     to Firestore by the time this is even called.
// ════════════════════════════════════════════════════════════════════════

const { onRequest } = require('firebase-functions/v2/https');

// Indian phone normalisation: strip non-digits, prepend 91 if 10-digit.
function normalisePhone(to) {
  const digits = String(to || '').replace(/\D/g, '');
  if (digits.length === 10) return '91' + digits;
  return digits;
}

// ════════════════════════════════════════════════════════════════════
// 1) sendWhatsAppTemplate — fires a Meta-approved template message.
//    THIS is what hodclub.in calls for cover_confirmed / booking_confirmed
//    / guestlist_confirmed and bypasses the 24-hr engagement window.
//    Body: { to, template, language?, params? }
// ════════════════════════════════════════════════════════════════════
exports.sendWhatsAppTemplate = onRequest(
  {
    region: 'asia-south1',
    secrets: ['WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID'],
    cors: true,
    timeoutSeconds: 30,
    memory: '256MiB',
  },
  async (req, res) => {
    try {
      if (req.method === 'OPTIONS') return res.status(204).send('');
      if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });

      const { to, template, language, params } = req.body || {};
      if (typeof to !== 'string' || typeof template !== 'string') {
        return res.status(400).json({ ok: false, error: 'to and template are required strings' });
      }

      const token = process.env.WHATSAPP_ACCESS_TOKEN;
      const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
      if (!token || !phoneNumberId) {
        console.error('[sendWhatsAppTemplate] secrets missing');
        return res.status(500).json({ ok: false, error: 'WhatsApp not configured on server' });
      }

      const recipient = normalisePhone(to);
      if (recipient.length < 10) {
        return res.status(400).json({ ok: false, error: 'Invalid phone number' });
      }

      const components = [];
      if (Array.isArray(params) && params.length > 0) {
        components.push({
          type: 'body',
          parameters: params.map((p) => ({ type: 'text', text: String(p) })),
        });
      }

      const url = `https://graph.facebook.com/v21.0/${phoneNumberId}/messages`;
      const r = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: recipient,
          type: 'template',
          template: {
            name: template,
            language: { code: typeof language === 'string' ? language : 'en' },
            ...(components.length > 0 ? { components } : {}),
          },
        }),
      });
      const data = await r.json();
      if (!r.ok) {
        const errObj = (data && data.error) || {};
        console.warn('[sendWhatsAppTemplate] Meta API error', { status: r.status, recipient, template, err: errObj });
        return res.status(r.status).json({
          ok: false,
          error: errObj.message || 'WhatsApp API error',
          code: errObj.code,
          details: data,
        });
      }
      const messageId = (data && data.messages && data.messages[0] && data.messages[0].id) || null;
      console.log('[sendWhatsAppTemplate] sent', { recipient, template, messageId });
      return res.json({ ok: true, recipient, data });
    } catch (e) {
      console.error('[sendWhatsAppTemplate] fatal:', e);
      return res.status(500).json({ ok: false, error: 'Failed to reach WhatsApp API' });
    }
  }
);

// ════════════════════════════════════════════════════════════════════
// 2) sendWhatsAppText — plain text message (NOT templated).
//    Only works if recipient messaged the business in last 24 hrs.
//    Used by admin tools / void notifier / debug.
//    Body: { to, message }
// ════════════════════════════════════════════════════════════════════
exports.sendWhatsAppText = onRequest(
  {
    region: 'asia-south1',
    secrets: ['WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID'],
    cors: true,
    timeoutSeconds: 30,
    memory: '256MiB',
  },
  async (req, res) => {
    try {
      if (req.method === 'OPTIONS') return res.status(204).send('');
      if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });

      const { to, message } = req.body || {};
      if (typeof to !== 'string' || typeof message !== 'string') {
        return res.status(400).json({ ok: false, error: 'to and message are required strings' });
      }

      const token = process.env.WHATSAPP_ACCESS_TOKEN;
      const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
      if (!token || !phoneNumberId) {
        console.error('[sendWhatsAppText] secrets missing');
        return res.status(500).json({ ok: false, error: 'WhatsApp not configured on server' });
      }

      const recipient = normalisePhone(to);
      if (recipient.length < 10) {
        return res.status(400).json({ ok: false, error: 'Invalid phone number' });
      }

      const url = `https://graph.facebook.com/v21.0/${phoneNumberId}/messages`;
      const r = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: recipient,
          type: 'text',
          text: { preview_url: true, body: message },
        }),
      });
      const data = await r.json();
      if (!r.ok) {
        const errObj = (data && data.error) || {};
        console.warn('[sendWhatsAppText] Meta API error', { status: r.status, recipient, err: errObj });
        return res.status(r.status).json({
          ok: false,
          error: errObj.message || 'WhatsApp API error',
          code: errObj.code,
          details: data,
        });
      }
      const messageId = (data && data.messages && data.messages[0] && data.messages[0].id) || null;
      console.log('[sendWhatsAppText] sent', { recipient, messageId });
      return res.json({ ok: true, recipient, data });
    } catch (e) {
      console.error('[sendWhatsAppText] fatal:', e);
      return res.status(500).json({ ok: false, error: 'Failed to reach WhatsApp API' });
    }
  }
);
