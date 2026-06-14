// ════════════════════════════════════════════════════════════════════════
// EFFECTIVE ORDERING MENU — single source of truth = the editable Menu Editor
// (venueMenu) merged over the static hod-menu.ts baseline.
//
// WHY: historically Bar / Captain / Menu CRM read the FROZEN static list
// (HOD_MENU_ITEMS) while the customer wallet read the editable venueMenu.
// So an item Khushi added in the Menu Editor showed on the customer phone but
// was NOT selectable in Menu CRM nor orderable on Bar/Captain. This module
// makes all three POS surfaces read the SAME menu the customer sees.
//
// MERGE RULES (per tab — mirrors the customer wallet exactly):
//  • If a venueMenu tab doc LOADED  → it is AUTHORITATIVE for that tab:
//      - price / OOS / veg edits apply,
//      - brand-new items are added,
//      - items removed in the editor disappear (delete propagates).
//  • If a venueMenu tab did NOT load (null — read error / not published yet)
//    → fall back to the STATIC items for that tab so nothing ever vanishes
//    (fail-open safety net).
//
// IDENTITY: existing items are matched to the static list by lowercased name
// so they KEEP their original `id` / `category` / `group` — Bar/Captain carts,
// KOT and reporting that key off those fields are untouched. Only brand-new
// items get a synthesized `vm-<slug>` id and a derived group/category.
//
// PRICE: the venueMenu price is the BASE (pre-discount) price. Category
// discounts (filterMenuByLiveCategories) and per-item overrides (effectivePrice)
// still apply downstream exactly as before — this module changes the item POOL,
// never the money math.
// ════════════════════════════════════════════════════════════════════════
import { HOD_MENU_ITEMS, type HodMenuItem } from "./hod-menu";
import {
  VENUE_MENU_TAB_ORDER,
  defaultVenueMenuTab,
  type VenueMenuItem,
  type VenueMenuTab,
  type VenueMenuTabId,
} from "./venue-menu";
import type { MenuCategoryGroup } from "./types";

/** Canonical cross-surface name key (matches filterMenuByLiveCategories). */
export function menuNameSlug(name: string): string {
  return (name || "").toLowerCase().trim();
}

/** Group for a brand-new venueMenu item (no static match). Must be a valid union. */
function deriveGroup(tabId: VenueMenuTabId, it: VenueMenuItem): MenuCategoryGroup {
  if (tabId === "food" || it.t === "food") return "food";
  if (tabId === "liquor" || it.alc) return "spirits";
  return "soft"; // nab + smoke → non-alcoholic group
}

/** Display/search category for a brand-new venueMenu item. `category` is free string. */
function deriveCategory(tabId: VenueMenuTabId, it: VenueMenuItem): string {
  if (tabId === "food" || it.t === "food") return "food-misc";
  if (tabId === "liquor" || it.alc) return "spirits-liqueurs";
  if (tabId === "smoke") return "smoke-misc"; // "smoke-" prefix → Captain routes to SMOKE tab
  return "soft-soft-drinks";
}

function venueItemToHod(
  it: VenueMenuItem,
  tabId: VenueMenuTabId,
  staticBySlug: Map<string, HodMenuItem>,
): HodMenuItem {
  const slug = menuNameSlug(it.n);
  const base = staticBySlug.get(slug);
  return {
    id: base?.id ?? `vm-${slug || Math.random().toString(36).slice(2)}`,
    name: it.n,
    category: base?.category ?? deriveCategory(tabId, it),
    group: base?.group ?? deriveGroup(tabId, it),
    price: it.p, // venueMenu price = base source of truth
    isAlcohol: it.alc,
    available: it.oos ? false : (base?.available ?? true),
    isVeg: it.v ?? base?.isVeg,
  };
}

/**
 * Build the effective ordering menu from the (possibly partial) set of loaded
 * venueMenu tab docs, merged over the static baseline per the rules above.
 * Pure + synchronous; safe to call on every change.
 */
export function buildEffectiveMenu(
  venueTabs: Partial<Record<VenueMenuTabId, VenueMenuTab | null>>,
): HodMenuItem[] {
  const staticBySlug = new Map<string, HodMenuItem>();
  for (const i of HOD_MENU_ITEMS) staticBySlug.set(menuNameSlug(i.name), i);

  const out: HodMenuItem[] = [];
  const seen = new Set<string>();

  for (const tabId of VENUE_MENU_TAB_ORDER) {
    const loaded = venueTabs[tabId];
    // Loaded tab is authoritative. Otherwise fall back to the SAME baseline the
    // first-publish seed uses (defaultVenueMenuTab) — for food/liquor/nab that
    // is the static HOD_MENU_ITEMS list (so those items keep their static
    // id/category/group via the slug match below), and for smoke it is the
    // venue-menu placeholder. Smoke has NO representation in HOD_MENU_ITEMS, so
    // a static-filter fallback would silently drop it; this default path keeps
    // every tab fail-open and non-empty.
    const tab: VenueMenuTab =
      loaded && Array.isArray(loaded.categories) ? loaded : defaultVenueMenuTab(tabId);
    for (const cat of tab.categories || []) {
      for (const it of cat?.items || []) {
        if (!it || !it.n) continue;
        const slug = menuNameSlug(it.n);
        if (!slug || seen.has(slug)) continue; // dedupe across tabs
        seen.add(slug);
        out.push(venueItemToHod(it, tabId, staticBySlug));
      }
    }
  }
  return out;
}
