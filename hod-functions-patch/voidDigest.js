// ════════════════════════════════════════════════════════════════════════
// HOD — DAILY VOID ANOMALY DIGEST (Anti-Fraud #B4)
// ────────────────────────────────────────────────────────────────────────
// Runs every day at 11:00 IST. Scans the previous operational night's
// voidLog entries across tableReservations + posCovers, aggregates by
// captain + by item, and sends a single WhatsApp message to Khushi.
//
// Drop-in for hod-functions-backend (Khushi's Mac repo).
// Deploy:
//   1. Copy this file → hod-functions-backend/voidDigest.js
//   2. In hod-functions-backend/index.js, append:
//        const { dailyVoidDigest } = require("./voidDigest");
//        exports.dailyVoidDigest = dailyVoidDigest;
//   3. Set the secrets (one-time). For ONE recipient (Khushi only):
//        firebase functions:config:set \
//          whatsapp.token="EAAxxx..." \
//          whatsapp.phone_id="123456789" \
//          khushi.phone="91XXXXXXXXXX"     # 91 prefix, no '+', no spaces
//
//      For MULTIPLE managers (Khushi + 2-3 managers), use this instead:
//        firebase functions:config:set \
//          whatsapp.token="EAAxxx..." \
//          whatsapp.phone_id="123456789" \
//          digest.recipients="91XXXXXXXXXX,91YYYYYYYYYY,91ZZZZZZZZZZ"
//
//      digest.recipients (if set) wins over khushi.phone. Each number gets
//      the SAME WhatsApp text. Order doesn't matter. No spaces around commas.
//   4. firebase deploy --only functions:dailyVoidDigest
//
// FALLBACK: if WhatsApp send fails, the digest is still written to
// Firestore at `_meta/lastVoidDigest` so Khushi can read it manually.
// If there are zero voids in the window, NO message is sent (no spam).
// ════════════════════════════════════════════════════════════════════════
const functions = require("firebase-functions");
const admin = require("firebase-admin");
if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

// ── Operational-night helpers (6am-to-6am Asia/Kolkata, matches POS) ──
function getOperationalNightStr(d = new Date()) {
  // Convert to IST
  const ist = new Date(d.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  // If before 6am IST, the operational night is YESTERDAY's date.
  if (ist.getHours() < 6) ist.setDate(ist.getDate() - 1);
  return ist.toISOString().split("T")[0];
}
function yesterdayNightStr() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return getOperationalNightStr(d);
}

// ── WhatsApp Cloud API send (best-effort; never throws) ──
// 2026-05-10: Read from process.env FIRST (loaded from functions/.env at deploy),
// then fall back to functions.config() (legacy, breaks intermittently).
async function sendWhatsAppText(to, body) {
  const cfg = functions.config();
  const token = process.env.WHATSAPP_TOKEN || cfg?.whatsapp?.token;
  const phoneId = process.env.WHATSAPP_PHONE_ID || cfg?.whatsapp?.phone_id;
  if (!token || !phoneId || !to) {
    console.warn("[voidDigest] missing WhatsApp config or recipient", { hasToken: !!token, hasPhoneId: !!phoneId, to, source: process.env.WHATSAPP_TOKEN ? "env" : "cfg" });
    return { ok: false, reason: "missing-config" };
  }
  const url = `https://graph.facebook.com/v18.0/${phoneId}/messages`;
  try {
    const fetch = (await import("node-fetch")).default;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { preview_url: false, body },
      }),
    });
    const j = await res.json();
    return { ok: res.ok, body: j };
  } catch (e) {
    console.error("[voidDigest] whatsapp send failed", e);
    return { ok: false, reason: String(e) };
  }
}

// ── Aggregator: pull voidLog from tableReservations within window ──
async function collectVoidsFromCollection(collectionName, sinceISO) {
  // We can't filter on array-element timestamp server-side; fetch docs whose
  // `date` field overlaps last 8 days (covers operational-night drift) and
  // then filter the embedded log entries client-side.
  const out = [];
  const dates = [];
  for (let i = 0; i < 8; i++) {
    const d = new Date(); d.setDate(d.getDate() - i);
    dates.push(d.toISOString().split("T")[0]);
  }
  // Firestore "in" cap = 10
  const snap = await db.collection(collectionName)
    .where("date", "in", dates.slice(0, 10))
    .get()
    .catch(() => null);
  if (!snap) return out;
  snap.forEach((doc) => {
    const data = doc.data() || {};
    const log = Array.isArray(data.voidLog) ? data.voidLog : [];
    for (const v of log) {
      if (!v || !v.at || v.at < sinceISO) continue;
      out.push({
        at: v.at,
        by: v.by || "unknown",
        kind: v.kind || "items-void",
        valueLost: Number(v.valueLost || v.billTotal || 0),
        voided: Array.isArray(v.voided) ? v.voided : [],
        reason: v.reason || "",
        tableId: v.tableId || data.tableId || "",
        customerName: v.customerName || data.customerName || "",
      });
    }
  });
  return out;
}

// ── Roll up: top voiders + repeat-voided dishes (7-day window) ──
function rollupVoids(events) {
  const byCaptain = {};        // { name: { count, value, isBill, isItem } }
  const dishCounts = {};       // { dishName: { count, captains:Set } }
  for (const e of events) {
    const cap = e.by || "unknown";
    if (!byCaptain[cap]) byCaptain[cap] = { name: cap, count: 0, value: 0, bills: 0, items: 0 };
    byCaptain[cap].count += 1;
    byCaptain[cap].value += e.valueLost;
    if (e.kind === "bill-void") byCaptain[cap].bills += 1; else byCaptain[cap].items += 1;
    for (const v of e.voided) {
      const n = String(v.n || "").trim();
      if (!n) continue;
      if (!dishCounts[n]) dishCounts[n] = { name: n, count: 0, captains: new Set() };
      dishCounts[n].count += Number(v.qty || 1);
      dishCounts[n].captains.add(cap);
    }
  }
  const topVoiders = Object.values(byCaptain)
    .sort((a, b) => b.value - a.value)
    .slice(0, 3);
  const repeatDishes = Object.values(dishCounts)
    .filter((d) => d.count >= 3)
    .sort((a, b) => b.count - a.count)
    .slice(0, 3)
    .map((d) => ({ name: d.name, count: d.count, captains: [...d.captains] }));
  return { topVoiders, repeatDishes };
}

function formatDigest(nightStr, lastNightEvents, weekRollup) {
  const nightVoids = lastNightEvents.length;
  const nightValue = lastNightEvents.reduce((s, e) => s + e.valueLost, 0);
  const niceDate = new Date(nightStr).toLocaleDateString("en-IN", {
    weekday: "short", day: "numeric", month: "short",
  });
  const lines = [];
  lines.push(`🔴 *HOD VOID DIGEST — ${niceDate.toUpperCase()}*`);
  lines.push("");
  if (nightVoids === 0) {
    lines.push("✅ ZERO voids last night. Clean operational night.");
  } else {
    lines.push(`📊 *Last night:* ${nightVoids} voids · ₹${nightValue.toLocaleString("en-IN")} leakage`);
    lines.push("");
    if (weekRollup.topVoiders.length) {
      lines.push("👤 *TOP VOIDERS (7-day):*");
      weekRollup.topVoiders.forEach((c, i) => {
        lines.push(`${i + 1}. ${c.name} — ₹${c.value.toLocaleString("en-IN")} (${c.bills} bills · ${c.items} item-voids)`);
      });
      lines.push("");
    }
    if (weekRollup.repeatDishes.length) {
      lines.push("🍽 *REPEAT-VOIDED DISHES (7-day, ≥3):*");
      weekRollup.repeatDishes.forEach((d) => {
        lines.push(`• ${d.name} — voided ${d.count}× by ${d.captains.join(", ")}`);
      });
      lines.push("");
    }
  }
  lines.push("🔍 Review: https://hodclub.in/admin/audit");
  return lines.join("\n");
}

// ── Scheduled function: every day 11:00 IST ──
exports.dailyVoidDigest = functions
  .region("asia-south1")
  .pubsub.schedule("0 11 * * *")
  .timeZone("Asia/Kolkata")
  .onRun(async () => {
    const nightStr = yesterdayNightStr();
    // Window: last operational night start (6am yesterday IST) to now.
    // For simplicity we use ISO of nightStr@06:00 IST → +30hrs covers it.
    const sinceLast = new Date(`${nightStr}T00:30:00.000Z`).toISOString(); // ~06:00 IST
    const since7d = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();

    const [lastResv, lastCovers, weekResv, weekCovers] = await Promise.all([
      collectVoidsFromCollection("tableReservations", sinceLast),
      collectVoidsFromCollection("posCovers", sinceLast),
      collectVoidsFromCollection("tableReservations", since7d),
      collectVoidsFromCollection("posCovers", since7d),
    ]);
    // De-dupe last-night cover entries that mirror reservation entries by `at+by+valueLost`.
    const dedupKey = (e) => `${e.at}|${e.by}|${e.valueLost}`;
    const lastSeen = new Set();
    const lastNightEvents = [...lastResv, ...lastCovers].filter((e) => {
      const k = dedupKey(e);
      if (lastSeen.has(k)) return false;
      lastSeen.add(k); return true;
    });
    const weekSeen = new Set();
    const weekEvents = [...weekResv, ...weekCovers].filter((e) => {
      const k = dedupKey(e);
      if (weekSeen.has(k)) return false;
      weekSeen.add(k); return true;
    });

    const weekRollup = rollupVoids(weekEvents);
    const message = formatDigest(nightStr, lastNightEvents, weekRollup);

    // Persist for manual recovery (always — even if WhatsApp fails).
    await db.collection("_meta").doc("lastVoidDigest").set({
      nightStr,
      generatedAt: new Date().toISOString(),
      message,
      stats: {
        lastNightCount: lastNightEvents.length,
        lastNightValue: lastNightEvents.reduce((s, e) => s + e.valueLost, 0),
        weekCount: weekEvents.length,
      },
    }, { merge: true });

    // FALLBACK: skip the WhatsApp send entirely on zero-voids quiet nights
    // (Khushi prefers no spam — she can read _meta/lastVoidDigest if curious).
    if (lastNightEvents.length === 0) {
      console.log("[voidDigest] zero voids, skipping WhatsApp send");
      return null;
    }
    // 2026-05-10 MULTI-RECIPIENT FAN-OUT (with hardcoded fallback):
    // Order of precedence: digest.recipients config > khushi.phone config >
    // HARDCODED_RECIPIENTS (last-resort safety net so the digest NEVER
    // silently fails because of a config-caching flake-out).
    // Each manager gets the same digest text. Failures per-recipient are
    // logged but never throw — one bad number must not block the others.
    const HARDCODED_RECIPIENTS = ["919611111126", "919611111072", "919611111261"];
    const cfg = functions.config();
    const multi = String(cfg?.digest?.recipients || "")
      .split(",").map((s) => s.trim()).filter(Boolean);
    const recipients = multi.length > 0
      ? multi
      : (cfg?.khushi?.phone ? [cfg.khushi.phone] : HARDCODED_RECIPIENTS);
    console.log("[voidDigest] resolving recipients", { source: multi.length > 0 ? "config.digest.recipients" : (cfg?.khushi?.phone ? "config.khushi.phone" : "hardcoded"), count: recipients.length });
    if (recipients.length === 0) {
      console.warn("[voidDigest] no recipients configured (set digest.recipients or khushi.phone)");
      return null;
    }
    const results = await Promise.all(
      recipients.map(async (to) => {
        const r = await sendWhatsAppText(to, message);
        return { to, ok: r.ok };
      })
    );
    console.log("[voidDigest] sent", { recipients: results, nightStr, voids: lastNightEvents.length });
    return null;
  });

// Optional: callable for manual run from the React admin (e.g. test button).
exports.runVoidDigestNow = functions
  .region("asia-south1")
  .https.onCall(async (data, context) => {
    if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "sign-in required");
    // Reuse the scheduled handler logic by invoking it directly.
    await exports.dailyVoidDigest.run();
    return { ok: true };
  });
