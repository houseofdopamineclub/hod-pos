# Customer wallet (hodclub.in) — Firestore menu integration

The customer-facing wallet at **hodclub.in** is deployed from a separate
repository (not this monorepo). This folder ships a drop-in script the wallet
can include so the menu rendered to customers is the **same Firestore data the
manager edits in the POS** (`artifacts/pos-system` → Admin → 📋 Menu Editor).

## Files

- `menu-firestore.js` — defines `window.HOD_FOOD_MENU`, `HOD_BAR_MENU`,
  `HOD_SMOKE_MENU`, and `hodGetMenuByTab(tab)`. Subscribes live to
  `venueMenu/{food|liquor|nab|smoke}` in the **hod-tickets** Firebase project
  with an instant cache-first paint and an offline fallback to the baked-in
  hardcoded arrays.

## Drop-in steps (in hod-wallet-v3.html / hodclub.in repo)

1. **Replace the hardcoded menu block.** Find the three lines starting
   `var HOD_FOOD_MENU=[…];`, `var HOD_BAR_MENU=[…];`, `var HOD_SMOKE_MENU=[…];`
   (≈lines 649-668 in `hod-wallet-v3-PREVIEW.html`) and the four `.forEach`
   tag-default lines and the `function hodGetMenuByTab(tab){…}` block.
2. **Paste the full hardcoded arrays** into `menu-firestore.js` where the
   `// (Truncated for brevity…)` comment lives — these become the offline
   fallback for fresh devices that have no cache yet.
3. **Include the script** AFTER Firebase initialisation:
   ```html
   <script src="menu-firestore.js"></script>
   ```
4. **Expose Firebase to the script.** The wallet already loads Firebase for
   the wallet-recharge flow; just ensure these two are on `window`:
   ```js
   window.firebaseDb = db;                  // Firestore instance
   window.firebaseFirestore = { doc, onSnapshot };  // modular SDK fns
   ```
5. **Re-render on update.** `menu-firestore.js` dispatches a
   `hod:venueMenuUpdate` event each time a tab refreshes. Wire it to the
   existing tab-render call:
   ```js
   window.addEventListener('hod:venueMenuUpdate', function (e) {
     if (e.detail.tabId === tabState.active ||
         (tabState.active === 'liquor' && e.detail.tabId === 'liquor') ||
         (tabState.active === 'nab' && e.detail.tabId === 'nab')) {
       buildMenu(hodGetMenuByTab(tabState.active));
     }
   });
   ```

## Firestore rules

Add to `firestore.rules` in the **hod-tickets** project (alongside the existing
`posHappyHour` / `venueSettings` blocks):

```
match /venueMenu/{tabId} {
  allow read: if true;  // wallet is anonymous-public

  // ⚠️ Anonymous-auth alone is too weak — any logged-in client could overwrite
  // the menu. Restrict writes to either:
  //   (a) a custom claim set on staff identities by your admin tooling, or
  //   (b) an allowlist of staff UIDs.
  // Choose ONE of the two examples below and delete the other.

  // (a) Custom claim — preferred. Set `request.auth.token.posManager == true`
  //     on the staff member's auth record before they hit the POS.
  allow write: if request.auth != null
               && request.auth.token.posManager == true;

  // (b) UID allowlist — quick to deploy, manual to maintain.
  // allow write: if request.auth != null
  //              && request.auth.uid in [
  //                "POS_TABLET_UID_1", "POS_TABLET_UID_2"
  //              ];
}
```

The POS Menu Editor UI is also gated to `admin` / `manager` staff roles plus
the existing manager-PIN prompt before publish, so authorization is enforced
at three layers (UI role gate → PIN gate → Firestore rule).

## How it stays fast & resilient

| Scenario                              | Behaviour                                                  |
|---------------------------------------|------------------------------------------------------------|
| First load, has network               | Paint from baked-in fallback → Firestore push → cache update |
| Repeat load, has network              | Paint from cache instantly → Firestore push → cache update |
| Repeat load, OFFLINE                  | Paint from cache (last good snapshot) — fully usable       |
| Brand-new device, OFFLINE             | Paint from baked-in fallback (the original hardcoded list) |
| POS publish with `oos: true` items    | Hidden from customer view (kept in cache for transparency) |

## What lives where

- **POS editor (here):** `artifacts/pos-system/src/pages/MenuEditor.tsx` —
  manager-PIN gated CRUD per tab. Audit-logged via `posAuditLog`.
- **Firestore lib (here):** `artifacts/pos-system/src/lib/firestore.ts` —
  `subscribeToVenueMenuTab`, `saveVenueMenuTab`, `getVenueMenuTab`.
- **Default seed (here):** `artifacts/pos-system/src/lib/venue-menu.ts` —
  derives initial categories from the canonical `hod-menu.ts` so the editor
  starts with the real menu, not blank.
- **Customer wallet (separate repo):** loads `menu-firestore.js` from this
  folder and replaces the hardcoded arrays.
