// Editable customer-menu data — backs the "📋 Menu Editor" admin tab and the
// hodclub.in customer wallet (see ../../../customer-wallet/menu-firestore.js).
//
// Storage: one Firestore doc per tab at `venueMenu/{tabId}`. Tabs match the
// 4-tab layout in the customer wallet (FOOD / LIQUOR / NAB / SMOKE).
//
// Why per-tab docs (not per-item)? The wallet renders one tab at a time, so
// a single subscription per tab is the cheapest read pattern. Each tab doc
// stays well under Firestore's 1 MiB limit (current full menu ≈ 90 KB).
import { HOD_MENU_ITEMS, HOD_CATEGORY_LABELS, type HodMenuItem } from "./hod-menu";

export type VenueMenuTabId = "food" | "liquor" | "nab" | "smoke";

export const VENUE_MENU_TAB_LABELS: Record<VenueMenuTabId, string> = {
  food: "🍽 FOOD",
  liquor: "🥃 LIQUOR",
  nab: "🥤 NAB",
  smoke: "🚬 SMOKE",
};

export const VENUE_MENU_TAB_ORDER: VenueMenuTabId[] = ["food", "liquor", "nab", "smoke"];

// One menu line. `n` / `p` / `t` / `alc` / `v` mirror the customer wallet's
// shorthand keys so the wallet can render straight off `categories[].items[]`
// without a transform.
export interface VenueMenuItem {
  n: string;            // name
  p: number;            // price (₹)
  t: "food" | "drink";  // type
  alc: boolean;         // is alcohol
  v?: boolean;          // is veg (food only)
  oos?: boolean;        // out of stock — hides item in wallet
  sub?: string;         // optional sub-category label (e.g. "30ml" / "Bottle")
}

export interface VenueMenuCategory {
  cat: string;
  items: VenueMenuItem[];
}

export interface VenueMenuTab {
  tabId: VenueMenuTabId;
  categories: VenueMenuCategory[];
  updatedBy?: string;
  // updatedAt is a Firestore Timestamp at rest; left untyped here to avoid a
  // hard import for the customer wallet snippet which has no firebase types.
}

// ── Seed defaults ────────────────────────────────────────────────────────
// First-time publish populates each tab from the canonical hardcoded source
// (hod-menu.ts) so the manager starts with the real menu, not a blank slate.

function tabFor(item: HodMenuItem): VenueMenuTabId {
  if (item.group === "food") return "food";
  if (item.isAlcohol) return "liquor";
  return "nab";
}

function defaultCategoriesFor(tabId: VenueMenuTabId): VenueMenuCategory[] {
  if (tabId === "smoke") {
    // Placeholder smoke menu — venue uploads real list later (see task #fill-smoke-tab).
    return [{ cat: "Cigarettes", items: [
      { n: "Cigarette 10 pc", p: 460, t: "drink", alc: false },
    ]}];
  }
  const byCat = new Map<string, VenueMenuItem[]>();
  for (const it of HOD_MENU_ITEMS) {
    if (tabFor(it) !== tabId) continue;
    const catLabel = HOD_CATEGORY_LABELS[it.category] || it.category;
    if (!byCat.has(catLabel)) byCat.set(catLabel, []);
    byCat.get(catLabel)!.push({
      n: it.name,
      p: it.price,
      t: it.group === "food" ? "food" : "drink",
      alc: it.isAlcohol,
      ...(it.group === "food" ? { v: !!it.isVeg } : {}),
    });
  }
  return Array.from(byCat.entries()).map(([cat, items]) => ({ cat, items }));
}

export function defaultVenueMenuTab(tabId: VenueMenuTabId): VenueMenuTab {
  return { tabId, categories: defaultCategoriesFor(tabId) };
}
