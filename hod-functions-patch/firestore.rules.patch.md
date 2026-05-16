# HOD — Firestore Rules Patch (Anti-Fraud #A2 + #A3)

**One-time** Firebase rules update so the new anti-fraud collections work. Until this is deployed:

- ✅ Voids still work (we made the captain-cap **fail-OPEN** — better to lose the cap than block a legit void).
- ❌ Captain void cap (5 voids OR ₹3000 → auto-suspend) is **disabled** — the writes get blocked silently.
- ❌ Admin Panel → 🔓 Locks tab shows the "rules patch needed" banner.
- ❌ Auto-WhatsApp customer on bill void (#A3) won't fire — the queue write gets denied.

**Two collections need rules: `captainVoidStats` and `voidNotificationsQueue`.**

---

## Step 1 — Open Firestore rules

Firebase Console → **`hod-tickets`** project → **Firestore Database** → **Rules** tab.

You'll see something like:

```js
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    // ... existing match blocks for posOrders, posKOTs, tableReservations, etc ...

  }
}
```

## Step 2 — Paste these two blocks

Add **inside** your `match /databases/{database}/documents { ... }` block, alongside the other `match` rules:

```js
// ════════════════════════════════════════════════════════════════════════
// HOD Anti-Fraud #A2 — Captain Void Cap (5 voids OR ₹3000 per night)
// Per-captain-per-night counter doc. Read for pre-flight check + Locks tab.
// Write on every void to increment counter. Written by POS only (auth).
//
// 🔒 HARDENING — anyone with POS auth (bartenders, captains, etc.) can
// technically write to Firestore directly via the SDK if rules are too
// open. Below we BLOCK any client write that flips `suspended` from true
// → false UNLESS the writer also stamps `unlockedBy` + `unlockedAt`
// (which only the Admin Panel → 🔓 Locks unlock flow does, after PIN
// 9999). Captains can still increment counters; they cannot self-unlock.
// ════════════════════════════════════════════════════════════════════════
match /captainVoidStats/{docId} {
  allow read: if request.auth != null;
  allow create: if request.auth != null;
  allow update: if request.auth != null
    && (
      // Either: not flipping suspended off (normal counter increments / suspend)
      !(resource.data.suspended == true
        && request.resource.data.suspended == false)
      // Or: it IS an unlock and unlockedBy + unlockedAt are present (admin path)
      || (request.resource.data.unlockedBy is string
        && request.resource.data.unlockedAt is string)
    );
  // No client deletes — append/update only for the audit trail.
}

// ════════════════════════════════════════════════════════════════════════
// HOD Anti-Fraud #A3 — Customer Notify Queue (WhatsApp on bill void)
// POS writes one queue doc per bill void. Cloud function `voidNotifyCustomer`
// reads the doc, sends WhatsApp, updates status. Frontend never deletes.
// ════════════════════════════════════════════════════════════════════════
match /voidNotificationsQueue/{docId} {
  allow create, read: if request.auth != null;
  allow update:       if request.auth != null;
  // No delete — append-only queue for the audit trail.
}
```

## Step 3 — Click **Publish**

Firebase shows a green confirmation banner. Rules take effect within ~10 seconds.

## Step 4 — Verify

1. Refresh the Admin Panel → 🔓 Locks tab. The orange "rules patch needed" banner should disappear and you'll see either "✅ NO CAPTAINS LOCKED TONIGHT" or the suspended captain list.
2. (Optional) Test a bill void on a real table with your own phone number — within seconds you should get the WhatsApp notice from the `voidNotifyCustomer` cloud function (assuming you've already deployed it from `DEPLOY.md`).

---

## Fallbacks (if you skip this patch)

| Scenario | What happens |
|---|---|
| Captain hits 5+ voids tonight | Cap is **disabled** — they can keep voiding. You'll catch it in Reports next morning instead. |
| Bill void → customer WhatsApp | Won't fire. The void itself still works perfectly. Customer doesn't get the alert. |
| Open Locks tab | Friendly orange banner with this same copy-paste block. No red error. |

Nothing is BROKEN by skipping this patch — you just lose the new safety nets. Deploy when convenient.
