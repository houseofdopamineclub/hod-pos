import { Router, type IRouter } from "express";

const router: IRouter = Router();

router.post("/whatsapp/send", async (req, res) => {
  const { to, message } = req.body ?? {};

  if (typeof to !== "string" || typeof message !== "string") {
    return res.status(400).json({ ok: false, error: "to and message are required strings" });
  }

  const token = process.env["WHATSAPP_ACCESS_TOKEN"];
  const phoneNumberId = process.env["WHATSAPP_PHONE_NUMBER_ID"];

  if (!token || !phoneNumberId) {
    req.log.error("WhatsApp credentials missing");
    return res.status(500).json({ ok: false, error: "WhatsApp not configured on server" });
  }

  const digits = to.replace(/\D/g, "");
  const recipient = digits.length === 10 ? `91${digits}` : digits;

  if (recipient.length < 10) {
    return res.status(400).json({ ok: false, error: "Invalid phone number" });
  }

  try {
    const url = `https://graph.facebook.com/v21.0/${phoneNumberId}/messages`;
    const r = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: recipient,
        type: "text",
        text: { preview_url: true, body: message },
      }),
    });

    const data = (await r.json()) as Record<string, unknown>;

    if (!r.ok) {
      req.log.warn({ status: r.status, data, recipient }, "WhatsApp send failed");
      const errObj = (data["error"] as Record<string, unknown> | undefined) ?? {};
      return res.status(r.status).json({
        ok: false,
        error: (errObj["message"] as string) || "WhatsApp API error",
        code: errObj["code"],
        details: data,
      });
    }

    req.log.info({ recipient, messageId: (data["messages"] as Array<{ id: string }> | undefined)?.[0]?.id }, "WhatsApp sent");
    return res.json({ ok: true, recipient, data });
  } catch (err) {
    req.log.error({ err }, "WhatsApp send exception");
    return res.status(500).json({ ok: false, error: "Failed to reach WhatsApp API" });
  }
});

router.post("/whatsapp/send-template", async (req, res) => {
  const { to, template, language, params } = req.body ?? {};

  if (typeof to !== "string" || typeof template !== "string") {
    return res.status(400).json({ ok: false, error: "to and template are required strings" });
  }

  const token = process.env["WHATSAPP_ACCESS_TOKEN"];
  const phoneNumberId = process.env["WHATSAPP_PHONE_NUMBER_ID"];

  if (!token || !phoneNumberId) {
    req.log.error("WhatsApp credentials missing");
    return res.status(500).json({ ok: false, error: "WhatsApp not configured on server" });
  }

  const digits = to.replace(/\D/g, "");
  const recipient = digits.length === 10 ? `91${digits}` : digits;
  if (recipient.length < 10) {
    return res.status(400).json({ ok: false, error: "Invalid phone number" });
  }

  const components: Array<Record<string, unknown>> = [];
  if (Array.isArray(params) && params.length > 0) {
    components.push({
      type: "body",
      parameters: params.map((p: unknown) => ({ type: "text", text: String(p) })),
    });
  }

  try {
    const url = `https://graph.facebook.com/v21.0/${phoneNumberId}/messages`;
    const r = await fetch(url, {
      method: "POST",
      headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: recipient,
        type: "template",
        template: {
          name: template,
          language: { code: typeof language === "string" ? language : "en" },
          ...(components.length > 0 ? { components } : {}),
        },
      }),
    });
    const data = (await r.json()) as Record<string, unknown>;
    if (!r.ok) {
      req.log.warn({ status: r.status, data, recipient, template }, "WhatsApp template send failed");
      const errObj = (data["error"] as Record<string, unknown> | undefined) ?? {};
      return res.status(r.status).json({
        ok: false,
        error: (errObj["message"] as string) || "WhatsApp API error",
        code: errObj["code"],
        details: data,
      });
    }
    req.log.info({ recipient, template, messageId: (data["messages"] as Array<{ id: string }> | undefined)?.[0]?.id }, "WhatsApp template sent");
    return res.json({ ok: true, recipient, data });
  } catch (err) {
    req.log.error({ err }, "WhatsApp template send exception");
    return res.status(500).json({ ok: false, error: "Failed to reach WhatsApp API" });
  }
});

router.get("/whatsapp/templates", async (req, res) => {
  const token = process.env["WHATSAPP_ACCESS_TOKEN"];
  if (!token) return res.status(500).json({ ok: false, error: "WhatsApp not configured" });
  try {
    const r = await fetch(
      "https://graph.facebook.com/v21.0/26697741056573741/message_templates?fields=name,status,category,language",
      { headers: { "Authorization": `Bearer ${token}` } },
    );
    const data = await r.json();
    return res.status(r.ok ? 200 : r.status).json(data);
  } catch (err) {
    req.log.error({ err }, "List templates failed");
    return res.status(500).json({ ok: false, error: "Failed to list templates" });
  }
});

const WEBHOOK_VERIFY_TOKEN = "hod_pos_webhook_2026";

router.get("/whatsapp/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === WEBHOOK_VERIFY_TOKEN) {
    req.log.info("WhatsApp webhook verified");
    return res.status(200).send(challenge);
  }
  req.log.warn({ mode, token }, "WhatsApp webhook verification failed");
  return res.sendStatus(403);
});

router.post("/whatsapp/webhook", (req, res) => {
  try {
    const body = req.body as Record<string, unknown>;
    const entries = (body["entry"] as Array<Record<string, unknown>> | undefined) ?? [];
    for (const entry of entries) {
      const changes = (entry["changes"] as Array<Record<string, unknown>> | undefined) ?? [];
      for (const change of changes) {
        const value = (change["value"] as Record<string, unknown> | undefined) ?? {};
        const statuses = (value["statuses"] as Array<Record<string, unknown>> | undefined) ?? [];
        const messages = (value["messages"] as Array<Record<string, unknown>> | undefined) ?? [];
        for (const s of statuses) {
          req.log.info({
            event: "whatsapp_status",
            id: s["id"],
            status: s["status"],
            recipient: s["recipient_id"],
            timestamp: s["timestamp"],
            errors: s["errors"],
          }, "WA status update");
        }
        for (const m of messages) {
          req.log.info({
            event: "whatsapp_inbound",
            from: m["from"],
            id: m["id"],
            type: m["type"],
            text: (m["text"] as Record<string, unknown> | undefined)?.["body"],
          }, "WA inbound message");
        }
      }
    }
    return res.sendStatus(200);
  } catch (err) {
    req.log.error({ err }, "WhatsApp webhook handler error");
    return res.sendStatus(200);
  }
});

export default router;
