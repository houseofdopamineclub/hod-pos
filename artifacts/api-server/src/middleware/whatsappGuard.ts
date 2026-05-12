import type { Request, Response, NextFunction } from "express";

function allowedOrigins(): string[] {
  const domains = (process.env.REPLIT_DOMAINS || "")
    .split(",")
    .map((d) => d.trim())
    .filter(Boolean);
  const origins = domains.flatMap((d) => [`https://${d}`, `http://${d}`]);
  if (process.env.NODE_ENV !== "production") {
    origins.push(
      "http://localhost",
      "http://localhost:80",
      "http://127.0.0.1",
      "http://127.0.0.1:80",
    );
  }
  return origins;
}

function originAllowed(origin: string | undefined): boolean {
  if (!origin) return false;
  return allowedOrigins().some((o) => origin === o || origin.startsWith(`${o}:`) || origin.startsWith(`${o}/`));
}

const WINDOW_MS = 5 * 60 * 1000;
const MAX_PER_WINDOW = 30;
const hits = new Map<string, { count: number; resetAt: number }>();

function rateLimit(ip: string): { ok: true } | { ok: false; retryAfter: number } {
  const now = Date.now();
  const entry = hits.get(ip);
  if (!entry || entry.resetAt < now) {
    hits.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return { ok: true };
  }
  if (entry.count >= MAX_PER_WINDOW) {
    return { ok: false, retryAfter: Math.ceil((entry.resetAt - now) / 1000) };
  }
  entry.count += 1;
  return { ok: true };
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of hits) if (v.resetAt < now) hits.delete(k);
}, WINDOW_MS).unref?.();

export function whatsappGuard(req: Request, res: Response, next: NextFunction): void {
  // Origin pinning: browser requests from the door tablet always send Origin
  // (it's a POST). Reject anything that doesn't come from our own preview /
  // production domain — blocks curl/scripted abuse with stolen URL.
  const origin = (req.headers.origin as string | undefined) || undefined;
  const referer = (req.headers.referer as string | undefined) || undefined;
  const refererOrigin = (() => {
    if (!referer) return undefined;
    try {
      const u = new URL(referer);
      return `${u.protocol}//${u.host}`;
    } catch {
      return undefined;
    }
  })();

  if (!originAllowed(origin) && !originAllowed(refererOrigin)) {
    req.log.warn(
      { origin, refererOrigin },
      "[wa] rejected: origin not in REPLIT_DOMAINS",
    );
    res.status(403).json({ ok: false, error: "Forbidden origin" });
    return;
  }

  const ip = req.ip || req.socket.remoteAddress || "unknown";
  const rl = rateLimit(ip);
  if (!rl.ok) {
    req.log.warn({ ip, retryAfter: rl.retryAfter }, "[wa] rate limit exceeded");
    res.setHeader("Retry-After", String(rl.retryAfter));
    res.status(429).json({
      ok: false,
      error: `Too many WhatsApp send requests — try again in ${rl.retryAfter}s`,
    });
    return;
  }

  next();
}
