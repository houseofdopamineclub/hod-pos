import { Router, type IRouter, type Request, type Response } from "express";
import {
  WhatsappSendTemplateBody,
  WhatsappSendTextBody,
} from "@workspace/api-zod";
import { whatsappGuard } from "../middleware/whatsappGuard";

const router: IRouter = Router();

// Access control: same-origin only (REPLIT_DOMAINS) + per-IP rate limit.
// Applied before route handlers so abuse is rejected before we burn Meta quota.
router.use("/whatsapp", whatsappGuard);

const DEFAULT_API_VERSION = "v21.0";

function normalisePhone(input: string): string {
  const digits = (input || "").replace(/\D/g, "");
  if (!digits) return "";
  // If 10 digits, prepend India country code (matches the door-mode flow).
  if (digits.length === 10) return `91${digits}`;
  return digits;
}

type MetaErrorShape = {
  message?: string;
  code?: number;
  error_subcode?: number;
  error_data?: { details?: string };
};

type MetaCallResult =
  | { ok: true; messageId?: string }
  | { ok: false; status: number; code?: number; message: string };

async function postToMeta(
  req: Request,
  body: Record<string, unknown>,
  token: string,
  phoneId: string,
  version: string,
): Promise<MetaCallResult> {
  const url = `https://graph.facebook.com/${version}/${encodeURIComponent(phoneId)}/messages`;

  let upstream: globalThis.Response;
  try {
    upstream = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    req.log.error({ err }, "[wa] Meta request failed (network)");
    return {
      ok: false,
      status: 0,
      message: err instanceof Error ? err.message : "Network error",
    };
  }

  const text = await upstream.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }

  if (!upstream.ok) {
    const errObj =
      (parsed as { error?: MetaErrorShape } | null)?.error ?? null;
    const message =
      errObj?.message ||
      errObj?.error_data?.details ||
      `Meta API HTTP ${upstream.status}`;
    req.log.warn(
      { status: upstream.status, code: errObj?.code, message },
      "[wa] Meta returned error",
    );
    return {
      ok: false,
      status: upstream.status,
      code: typeof errObj?.code === "number" ? errObj.code : undefined,
      message,
    };
  }

  const messageId =
    (parsed as { messages?: Array<{ id?: string }> } | null)?.messages?.[0]?.id;
  req.log.info({ messageId }, "[wa] Meta send ok");
  return { ok: true, messageId };
}

async function callMeta(
  req: Request,
  res: Response,
  body: Record<string, unknown>,
): Promise<void> {
  const token = process.env.META_WHATSAPP_TOKEN;
  const phoneId = process.env.META_WHATSAPP_PHONE_NUMBER_ID;
  const version = process.env.META_WHATSAPP_API_VERSION || DEFAULT_API_VERSION;

  if (!token || !phoneId) {
    req.log.warn(
      { hasToken: !!token, hasPhoneId: !!phoneId },
      "[wa] WhatsApp not configured",
    );
    res
      .status(503)
      .json({ ok: false, error: "WhatsApp not configured" });
    return;
  }

  const result = await postToMeta(req, body, token, phoneId, version);
  if (result.ok) {
    res.status(200).json({
      ok: true,
      ...(result.messageId ? { messageId: result.messageId } : {}),
    });
    return;
  }
  res.status(200).json({
    ok: false,
    error: result.message,
    ...(typeof result.code === "number" ? { code: result.code } : {}),
  });
}

// Meta error 132001 = "Template name does not exist in the translation".
// Templates are registered against a specific locale (en_US, en_IN, etc.)
// and Meta rejects sends that name a locale the template wasn't approved
// in — even if the template name itself exists. Door/Captain/Bar all pass
// language="en" today; we transparently retry common English variants so
// staff don't have to know which locale the admin used in Meta Manager.
// Order: caller's choice → en_US → en_IN → en_GB → en. Skip duplicates.
function templateLanguageFallbacks(initial: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const code of [initial, "en_US", "en_IN", "en_GB", "en"]) {
    const c = (code || "").trim();
    if (!c || seen.has(c)) continue;
    seen.add(c);
    out.push(c);
  }
  return out;
}

router.post("/whatsapp/send-template", async (req, res) => {
  const parsed = WhatsappSendTemplateBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      ok: false,
      error: `Invalid request: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
    });
    return;
  }
  const { to, template, language, params } = parsed.data;
  const phone = normalisePhone(to);
  if (!phone || phone.length < 10) {
    res.status(400).json({ ok: false, error: "Invalid phone" });
    return;
  }

  const components =
    params && params.length > 0
      ? [
          {
            type: "body",
            parameters: params.map((text) => ({ type: "text", text })),
          },
        ]
      : undefined;

  const token = process.env.META_WHATSAPP_TOKEN;
  const phoneId = process.env.META_WHATSAPP_PHONE_NUMBER_ID;
  const version = process.env.META_WHATSAPP_API_VERSION || DEFAULT_API_VERSION;
  if (!token || !phoneId) {
    req.log.warn(
      { hasToken: !!token, hasPhoneId: !!phoneId },
      "[wa] WhatsApp not configured",
    );
    res.status(503).json({ ok: false, error: "WhatsApp not configured" });
    return;
  }

  const languages = templateLanguageFallbacks(language || "en");
  let lastError: { message: string; code?: number } | null = null;
  for (const code of languages) {
    const result = await postToMeta(
      req,
      {
        messaging_product: "whatsapp",
        to: phone,
        type: "template",
        template: {
          name: template,
          language: { code },
          ...(components ? { components } : {}),
        },
      },
      token,
      phoneId,
      version,
    );
    if (result.ok) {
      if (code !== languages[0]) {
        req.log.info(
          { template, requested: languages[0], delivered: code },
          "[wa] template language fallback succeeded",
        );
      }
      res.status(200).json({
        ok: true,
        ...(result.messageId ? { messageId: result.messageId } : {}),
      });
      return;
    }
    lastError = { message: result.message, code: result.code };
    // Only iterate on the locale-mismatch error (132001). For anything else
    // (rate limit, auth, recipient block, template paused, etc.) the next
    // attempt will fail identically — break and surface the real error.
    if (result.code !== 132001) break;
  }

  res.status(200).json({
    ok: false,
    error: lastError?.message || "Template send failed",
    ...(typeof lastError?.code === "number" ? { code: lastError.code } : {}),
  });
});

router.post("/whatsapp/send", async (req, res) => {
  const parsed = WhatsappSendTextBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      ok: false,
      error: `Invalid request: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
    });
    return;
  }
  const { to, message } = parsed.data;
  const phone = normalisePhone(to);
  if (!phone || phone.length < 10) {
    res.status(400).json({ ok: false, error: "Invalid phone" });
    return;
  }

  await callMeta(req, res, {
    messaging_product: "whatsapp",
    to: phone,
    type: "text",
    text: { body: message, preview_url: false },
  });
});

export default router;
