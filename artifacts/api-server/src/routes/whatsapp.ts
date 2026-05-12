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
    res.status(200).json({
      ok: false,
      error: err instanceof Error ? err.message : "Network error",
    });
    return;
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
    res.status(200).json({
      ok: false,
      error: message,
      ...(typeof errObj?.code === "number" ? { code: errObj.code } : {}),
    });
    return;
  }

  const messageId =
    (parsed as { messages?: Array<{ id?: string }> } | null)?.messages?.[0]?.id;
  req.log.info({ messageId }, "[wa] Meta send ok");
  res.status(200).json({
    ok: true,
    ...(messageId ? { messageId } : {}),
  });
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

  await callMeta(req, res, {
    messaging_product: "whatsapp",
    to: phone,
    type: "template",
    template: {
      name: template,
      language: { code: language || "en" },
      ...(components ? { components } : {}),
    },
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
