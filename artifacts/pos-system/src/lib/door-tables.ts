// 🆕 2026-06-02 (Khushi) — SHARED door table config + real-time occupancy.
// Extracted from DoorMode.tsx so BOTH the door table-picker (NewTableBookingModal)
// AND the WAITLIST "ASSIGN A TABLE" picker (WaitlistView) read from ONE source —
// no drift between the two pickers (a table edited here updates both).
//
// 🔴 Authoritative floor layout per Khushi:
//   GROUND: C1-C4 + 2 VVIP (CVIP1/2)
//   FIRST / DINING: all FD* (FD13 excluded — phantom)
//   SMOKING ZONE: SMK* (SMK3 excluded — phantom)
//   ROOFTOP: T1-T11 + TVIP1-7 + TEX1
// Plus 3 flexible "PROXY 1/2/3" per floor (floor-unique ids GR-PX1… so
// availability never collides across floors; DISPLAY label is just "PROXY N").
// Proxies live ONLY in the door/waitlist picker — NOT in tables-config — so
// Captain/Admin floor plans are untouched.
import { ALL_TABLES } from "./tables-config";
import type { HodTableReservation } from "./firestore-hod";

export const DOOR_TABLE_OPTIONS = [
  { floor: "ground",  label: "Ground",        tables: ["C1","C2","C3","C4","CVIP1","CVIP2","GR-PX1","GR-PX2","GR-PX3"] },
  { floor: "dining",  label: "First / Dining", tables: ["FD1","FD2","FD3","FD4","FD5","FD6","FD7","FD8","FD9","FD10","FD11","FD12","FD14","FD15","FD16","FD17","FD18","FD-PX1","FD-PX2","FD-PX3"] },
  { floor: "smoking", label: "Smoking Zone",   tables: ["SMK1","SMK2","SMK4","SMK5","SMK6","SMK7","SMK8","SM-PX1","SM-PX2","SM-PX3"] },
  { floor: "rooftop", label: "Rooftop",        tables: ["T1","T2","T3","T4","T5","T6","T7","T8","T9","T10","T11","TVIP1","TVIP2","TVIP3","TVIP4","TVIP5","TVIP6","TVIP7","TEX1","RF-PX1","RF-PX2","RF-PX3"] },
];

// proxy id → friendly display label ("PROXY 1" …). A door table id is a proxy
// iff it ends in "-PX<n>".
export function doorProxyLabel(id: string): string | null {
  const m = id.match(/-PX(\d+)$/);
  return m ? `PROXY ${m[1]}` : null;
}

// Capacity lookup for the door table grid. Proxies return 0 → flexible (Captain
// assigns the real seats). Falls back to 0 for any unknown id.
export function doorTableCapacity(id: string): number {
  if (doorProxyLabel(id)) return 0;
  return ALL_TABLES.find((t) => t.id === id)?.capacity ?? 0;
}

// floor + label for a given door table id (from DOOR_TABLE_OPTIONS).
export function doorFloorForTable(id: string): { floor: string; label: string } | null {
  for (const g of DOOR_TABLE_OPTIONS) {
    if (g.tables.includes(id)) return { floor: g.floor, label: g.label };
  }
  return null;
}

// Time-aware occupancy — mirrors CaptainMode.tsx so a table booked for an
// unrelated slot (e.g. 7pm dinner) doesn't block a fresh 11pm booking on the
// same table. Paid bookings are released immediately.
export const DOOR_SLOT_MINUTES = 120;
export const DOOR_SLOT_LEAD_IN_MIN = 30;

export function doorParseClockToMinutes(t?: string): number | null {
  if (!t) return null;
  const s = String(t).trim();
  const m = s.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  if (Number.isNaN(h) || Number.isNaN(mm)) return null;
  const ampm = m[3]?.toUpperCase();
  if (ampm === "PM" && h < 12) h += 12;
  if (ampm === "AM" && h === 12) h = 0;
  return h * 60 + mm;
}

export function doorNowMinutesIST(): number {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

/**
 * 🆕 2026-06-07 (Khushi) — CANONICAL "is the bill truly settled?" gate.
 * A table-cover booking PREPAID online carries `paymentStatus:"paid"` from the
 * COVER deposit while its FOOD TAB is still OPEN and the guest keeps ordering.
 * `markTablePaid` is the SOLE writer of `paymentMode` / `paidAt`, so a table is
 * genuinely SETTLED (free / lock ordering/editing/reassign/occupancy) ONLY once
 * one of those stamps is present.
 *
 * This lives in `door-tables.ts` — a LOW-LEVEL, dependency-safe lib (it only
 * TYPE-imports `firestore-hod`) — so `firestore-hod.ts` (`isTableBillSettled`)
 * and `kot-bill-tally.ts` can both reuse ONE rule with no circular import and no
 * drift between copies.
 */
export function isTableReservationSettled(
  data: { paymentStatus?: string; paymentMode?: string; paidAt?: string } | null | undefined
): boolean {
  return !!data && data.paymentStatus === "paid" && (!!data.paymentMode || !!data.paidAt);
}

export function doorTableOccupantAt(
  tableId: string, targetMin: number, reservations: HodTableReservation[]
): HodTableReservation | null {
  for (const r of reservations) {
    if (r.tableId !== tableId) continue;
    // Settled-only release: a prepaid-cover table whose tab is still open stays
    // OCCUPIED so reassign/occupancy never treats a seated guest as free.
    if (isTableReservationSettled(r as any)) continue;
    const start = doorParseClockToMinutes(r.arrivalTime);
    if (start == null) return r;
    const winStart = start - DOOR_SLOT_LEAD_IN_MIN;
    const winEnd   = start + DOOR_SLOT_MINUTES;
    if (targetMin >= winStart && targetMin <= winEnd) return r;
  }
  return null;
}
