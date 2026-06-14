import { useEffect, useState } from "react";
import { subscribeToEffectiveMenu } from "./firestore";
import { HOD_MENU_ITEMS, type HodMenuItem } from "./hod-menu";

// React hook: the live effective ordering menu (editable venueMenu merged over
// the static baseline). Seeds with the static list so first paint is never
// empty, then updates when a manager publishes a menu change. Backed by ONE
// shared ref-counted subscription (see subscribeToEffectiveMenu) so N callers
// cost 4 tiny doc reads total.
export function useEffectiveMenu(): HodMenuItem[] {
  const [items, setItems] = useState<HodMenuItem[]>(HOD_MENU_ITEMS);
  useEffect(() => subscribeToEffectiveMenu(setItems), []);
  return items;
}
