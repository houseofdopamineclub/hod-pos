# 🔒 FIRESTORE RULES PATCH — LOCK DOWN WALLET RECHARGES

## What this fixes (Mon 11 May 2026)
Today the customer site runs this DIRECTLY from the browser:
```js
firestore.collection('covers').doc(ref).update({
  coverBalance: FieldValue.increment(amount), ...
});
```
That works because Firestore rules currently allow any authed user to update
any field on a `covers` doc. **Anyone with browser DevTools can credit any
wallet any amount with NO Razorpay payment needed.**

This patch denies client-side writes to the money fields. After this lands:
- Money fields (`coverBalance`, `coverActivated`, `coverUsed`, `coverPaid`,
  `topUpTotal`, `transactions`, `voidLog`) become SERVER-ONLY.
  Cloud functions (admin SDK) bypass rules → still work.
- Customer site can still write `pendingOrder`, `tabRounds[status='preparing']`
  (placing an order from the menu), `feedback`, etc. — those are not money.
- Bartender POS continues to write everything via cloud-function-like flows
  (POS uses Firebase Auth as a privileged tier — see role check below).

## How to apply

In `firestore.rules` (Firebase Console → Firestore → Rules), find your
existing `covers` rule block. It probably looks something like:
```
match /covers/{coverId} {
  allow read: if true;
  allow create, update, delete: if request.auth != null;
}
```

Replace with:
```
match /covers/{coverId} {
  allow read: if true;
  allow create: if request.auth != null;
  allow delete: if request.auth != null;

  // Update — deny any change to money/audit fields from the client.
  // Cloud functions (admin SDK) bypass these rules and remain free.
  // POS bartender app can mutate money fields ONLY when authenticated as a
  // privileged "pos" user (role claim set via custom-claims at PIN login).
  allow update: if request.auth != null && (
    // Privileged path — POS bartender / captain.
    request.auth.token.pos == true
    ||
    // Customer-facing path — block changes to money + audit fields.
    !(request.resource.data.diff(resource.data).affectedKeys()
        .hasAny([
          'coverBalance', 'coverActivated', 'coverUsed', 'coverPaid',
          'topUpTotal', 'transactions', 'voidLog', 'pendingTopUp',
          'diffPaidAmount', 'diffPaidAt', 'diffMethod',
          'lastVerifiedTopUpAt', 'serverVerified',
        ]))
  );
}
```

## ⚠️ MANDATORY PRE-REQ — POS app currently has NO `pos == true` claim

**Verified Mon 11 May:** the POS app signs in anonymously (see
`artifacts/pos-system/src/lib/firebase.ts`) — anonymous users have NO
custom claim. **If you publish this rule before setting custom claims,
the bartender's cash/UPI/card recharge button (`rechargeCover` in
`firestore-hod.ts`) will start failing with PERMISSION_DENIED — the
manager will call you within minutes.**

You MUST do EITHER Option A or Option B below FIRST, smoke-test the
bartender recharge, THEN publish the rule.

### Option A (fastest) — temporary email allow-list
Replace `request.auth.token.pos == true` with:
```
request.auth.token.email in ['houseofdopamineclub@gmail.com', 'darshan@hodclub.in', 'manager@hodclub.in']
```
Replace those emails with the actual ones the POS users sign in with.
Rotate to custom-claims later.

### Option B (correct) — set a custom claim once
On Khushi's Mac, run this Node script ONCE per POS user
(needs `firebase-admin` initialized with service account):
```js
// claim-pos-user.js
const admin = require('firebase-admin');
admin.initializeApp({ credential: admin.credential.cert(require('./service-account.json')) });
const email = process.argv[2];
admin.auth().getUserByEmail(email)
  .then(u => admin.auth().setCustomUserClaims(u.uid, { pos: true }))
  .then(() => console.log('✅', email, 'is now POS-privileged'))
  .catch(e => { console.error(e); process.exit(1); });
```
Run: `node claim-pos-user.js darshan@hodclub.in`. POS user must sign out + back in for the claim to take effect.

## Test BEFORE you publish (Firestore Rules Playground)

1. Open Firebase Console → Firestore → Rules → "Rules Playground" tab.
2. Set:
   - **Type:** update
   - **Authenticated:** Yes (any UID, NO `pos` claim)
   - **Path:** `/covers/SOME_REAL_REF`
   - **Document:** existing data of that cover doc
   - **New data:** same JSON but with `coverBalance` doubled
3. Click "Run". Should show **❌ Denied**. ✅ Patch works.
4. Repeat with `pos: true` token claim → should show **✅ Allowed**.

## Rollback

If after publish the bartender app or customer site breaks (e.g. customers
report "can't update wallet"), revert the rules to the old version in the
Firebase Console → Firestore → Rules → History tab → click the previous
version → Publish. Takes ~30 seconds.

The new cloud function `verifyRechargePayment` does NOT depend on this rules
patch — it works either way (admin SDK bypasses rules). So it's safe to
deploy the function FIRST, point the customer site at it, verify ₹100 test
recharges work end-to-end, THEN apply the rules lock as the final step.
