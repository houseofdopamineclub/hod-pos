import {
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  addDoc,
  deleteDoc,
  onSnapshot,
  query,
  where,
  orderBy,
  limit,
  runTransaction,
  serverTimestamp,
  Timestamp,
  type Unsubscribe,
} from "firebase/firestore";

function stripUndefined<T extends Record<string, unknown>>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    out[k] = v;
  }
  return out as T;
}

import { db } from "./firebase";
import type {
  POSOrder, POSBill, KOTTicket, TableReservation, OrderItem,
  POSShift, PaymentMethod, StaffMember, AuditLogEntry, CompRecord,
  WastageRecord, HappyHourConfig, AggregatorSettings, AggregatorOrder,
  MenuOverride,
} from "./types";
import { nanoid } from "./utils-pos";

const ORDERS_COL = "posOrders";
const BILLS_COL = "posBills";
const KOT_COL = "posKOTs";
const TABLE_RES_COL = "tableReservations";
const BILL_COUNTER_COL = "posConfig";
const SHIFTS_COL = "posShifts";
const STAFF_COL = "posStaff";
const AUDIT_COL = "posAuditLog";
const COMP_COL = "posComps";
const WASTAGE_COL = "posWastage";
const HAPPY_HOUR_COL = "posHappyHour";
const AGG_SETTINGS_COL = "posAggregatorSettings";
const AGG_ORDERS_COL = "posAggregatorOrders";
const MENU_OVERRIDES_COL = "posMenuOverrides";

export function subscribeToTableReservations(
  cb: (data: Record<string, TableReservation>) => void
): Unsubscribe {
  const col = collection(db, TABLE_RES_COL);
  return onSnapshot(col, (snap) => {
    const result: Record<string, TableReservation> = {};
    snap.forEach((d) => {
      result[d.id] = { tableId: d.id, ...d.data() } as TableReservation;
    });
    cb(result);
  }, () => { cb({}); });
}

export async function createOrder(order: Omit<POSOrder, "id">): Promise<string> {
  const cleanOrder = stripUndefined({ ...order });
  if (cleanOrder.items) cleanOrder.items = cleanItems(cleanOrder.items);
  const ref = await addDoc(collection(db, ORDERS_COL), {
    ...cleanOrder,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  await setDoc(
    doc(db, TABLE_RES_COL, order.tableId),
    { status: "occupied", orderId: ref.id, updatedAt: serverTimestamp() },
    { merge: true }
  );
  return ref.id;
}

export async function getOrder(orderId: string): Promise<POSOrder | null> {
  const snap = await getDoc(doc(db, ORDERS_COL, orderId));
  if (!snap.exists()) return null;
  return { id: snap.id, ...snap.data() } as POSOrder;
}

export function subscribeToOrder(
  orderId: string,
  cb: (order: POSOrder | null) => void
): Unsubscribe {
  return onSnapshot(doc(db, ORDERS_COL, orderId), (snap) => {
    if (!snap.exists()) { cb(null); return; }
    cb({ id: snap.id, ...snap.data() } as POSOrder);
  }, () => { cb(null); });
}

export function subscribeToTableOrder(
  tableId: string,
  cb: (order: POSOrder | null) => void
): Unsubscribe {
  const q = query(
    collection(db, ORDERS_COL),
    where("tableId", "==", tableId),
    where("status", "==", "open"),
    orderBy("createdAt", "desc"),
    limit(1)
  );
  return onSnapshot(q, (snap) => {
    if (snap.empty) { cb(null); return; }
    const d = snap.docs[0];
    cb({ id: d.id, ...d.data() } as POSOrder);
  }, () => { cb(null); });
}

export function subscribeToActiveOrders(
  cb: (orders: POSOrder[]) => void
): Unsubscribe {
  const q = query(
    collection(db, ORDERS_COL),
    where("status", "==", "open"),
    orderBy("createdAt", "desc")
  );
  return onSnapshot(q, (snap) => {
    cb(snap.docs.map((d) => ({ id: d.id, ...d.data() } as POSOrder)));
  }, () => { cb([]); });
}

export async function addItemsToOrder(
  orderId: string,
  newItems: OrderItem[]
): Promise<void> {
  const snap = await getDoc(doc(db, ORDERS_COL, orderId));
  if (!snap.exists()) throw new Error("Order not found");
  const order = snap.data() as POSOrder;
  const merged = [...(order.items || []), ...cleanItems(newItems)];
  await updateDoc(doc(db, ORDERS_COL, orderId), {
    items: merged,
    updatedAt: serverTimestamp(),
  });
}

export async function updateOrderItems(
  orderId: string,
  items: OrderItem[]
): Promise<void> {
  await updateDoc(doc(db, ORDERS_COL, orderId), {
    items: cleanItems(items),
    updatedAt: serverTimestamp(),
  });
}

export async function updateOrderStatus(
  orderId: string,
  status: POSOrder["status"]
): Promise<void> {
  await updateDoc(doc(db, ORDERS_COL, orderId), {
    status,
    updatedAt: serverTimestamp(),
  });
}

export async function voidOrderItem(
  orderId: string,
  itemId: string,
  reason: string,
  staffName: string
): Promise<void> {
  const snap = await getDoc(doc(db, ORDERS_COL, orderId));
  if (!snap.exists()) throw new Error("Order not found");
  const order = snap.data() as POSOrder;
  const items = order.items.map((item: OrderItem) => {
    if (item.id === itemId) {
      return { ...item, status: "void" as const, voidReason: reason, voidBy: staffName, voidAt: Timestamp.now() };
    }
    return item;
  });
  await updateDoc(doc(db, ORDERS_COL, orderId), { items, updatedAt: serverTimestamp() });
}

export async function sendKOT(kot: Omit<KOTTicket, "id">): Promise<string> {
  const ref = await addDoc(collection(db, KOT_COL), {
    ...kot,
    sentAt: serverTimestamp(),
    printCount: 1,
  });
  const snap = await getDoc(doc(db, ORDERS_COL, kot.orderId));
  if (snap.exists()) {
    const order = snap.data() as POSOrder;
    const kotItemNames = new Set(kot.items.map((ki) => ki.name));
    const updatedItems = order.items.map((item: OrderItem) => {
      if (kotItemNames.has(item.name) && item.status === "pending") {
        return { ...item, status: "sent" as const, sentAt: Timestamp.now() };
      }
      return item;
    });
    const kotNumbers = [...(order.kotNumbers || []), kot.kotNumber];
    await updateDoc(doc(db, ORDERS_COL, kot.orderId), {
      items: updatedItems,
      kotNumbers,
      updatedAt: serverTimestamp(),
    });
  }
  return ref.id;
}

export function subscribeToKOTs(
  cb: (kots: KOTTicket[]) => void
): Unsubscribe {
  const q = query(
    collection(db, KOT_COL),
    where("status", "in", ["pending", "in-progress"]),
    orderBy("sentAt", "asc")
  );
  return onSnapshot(q, (snap) => {
    cb(snap.docs.map((d) => ({ id: d.id, ...d.data() } as KOTTicket)));
  }, () => { cb([]); });
}

export async function updateKOTStatus(
  kotId: string,
  status: KOTTicket["status"]
): Promise<void> {
  await updateDoc(doc(db, KOT_COL, kotId), { status });
}

async function getNextBillNumber(): Promise<string> {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const configRef = doc(db, BILL_COUNTER_COL, "billCounter");
  const key = `count_${today}`;
  const count = await runTransaction(db, async (tx) => {
    const snap = await tx.get(configRef);
    const data = snap.exists() ? snap.data() : {};
    const next = ((data[key] as number) || 0) + 1;
    tx.set(configRef, { [key]: next }, { merge: true });
    return next;
  });
  return `HOD-${today}-${String(count).padStart(4, "0")}`;
}

export async function createBill(bill: Omit<POSBill, "id" | "billNumber">): Promise<string> {
  const billNumber = await getNextBillNumber();
  const activeShift = await getCurrentOpenShift().catch(() => null);
  const ref = await addDoc(collection(db, BILLS_COL), stripUndefined({
    ...bill,
    billNumber,
    shiftId: activeShift?.id ?? null,
    printCount: 1,
    createdAt: serverTimestamp(),
  }));
  return ref.id;
}

export async function getBill(billId: string): Promise<POSBill | null> {
  const snap = await getDoc(doc(db, BILLS_COL, billId));
  if (!snap.exists()) return null;
  return { id: snap.id, ...snap.data() } as POSBill;
}

export async function incrementBillPrintCount(billId: string): Promise<void> {
  const snap = await getDoc(doc(db, BILLS_COL, billId));
  if (!snap.exists()) return;
  const current = (snap.data().printCount as number) || 1;
  await updateDoc(doc(db, BILLS_COL, billId), { printCount: current + 1 });
}

export async function markBillPaid(
  billId: string,
  orderId: string,
  tableId: string
): Promise<void> {
  await updateDoc(doc(db, BILLS_COL, billId), {
    status: "paid",
    paidAt: serverTimestamp(),
  });
  await updateDoc(doc(db, ORDERS_COL, orderId), {
    status: "paid",
    updatedAt: serverTimestamp(),
  });
  await setDoc(
    doc(db, TABLE_RES_COL, tableId),
    { status: "available", orderId: null, guestName: null, partySize: null, seatedAt: null, updatedAt: serverTimestamp() },
    { merge: true }
  );
}

export function subscribeToStaff(cb: (staff: StaffMember[]) => void, onError?: (err: Error) => void): Unsubscribe {
  const q = query(collection(db, STAFF_COL), orderBy("name", "asc"));
  return onSnapshot(q, (snap) => {
    cb(snap.docs.map((d) => ({ id: d.id, ...d.data() } as StaffMember)));
  }, (err) => {
    cb([]);
    onError?.(err);
  });
}

export async function addStaffMember(staff: Omit<StaffMember, "id">): Promise<string> {
  const ref = await addDoc(collection(db, STAFF_COL), {
    ...staff,
    createdAt: serverTimestamp(),
  });
  return ref.id;
}

export async function updateStaffMember(id: string, data: Partial<StaffMember>): Promise<void> {
  await updateDoc(doc(db, STAFF_COL, id), stripUndefined(data as Record<string, unknown>));
}

export async function deleteStaffMember(id: string): Promise<void> {
  await deleteDoc(doc(db, STAFF_COL, id));
}

export async function logAudit(entry: Omit<AuditLogEntry, "id">): Promise<void> {
  await addDoc(collection(db, AUDIT_COL), {
    ...entry,
    timestamp: serverTimestamp(),
  });
}

export async function addCompRecord(record: Omit<CompRecord, "id">): Promise<string> {
  const ref = await addDoc(collection(db, COMP_COL), {
    ...record,
    createdAt: serverTimestamp(),
  });
  return ref.id;
}

export async function getTodayComps(captainId: string): Promise<CompRecord[]> {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const q = query(
    collection(db, COMP_COL),
    where("captainId", "==", captainId),
    where("createdAt", ">=", Timestamp.fromDate(startOfDay))
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() } as CompRecord));
}

export async function addWastage(record: Omit<WastageRecord, "id">): Promise<string> {
  const ref = await addDoc(collection(db, WASTAGE_COL), {
    ...record,
    createdAt: serverTimestamp(),
  });
  return ref.id;
}

export function subscribeToHappyHour(cb: (config: HappyHourConfig | null) => void): Unsubscribe {
  return onSnapshot(doc(db, HAPPY_HOUR_COL, "current"), (snap) => {
    if (!snap.exists()) { cb(null); return; }
    cb({ id: snap.id, ...snap.data() } as HappyHourConfig);
  }, () => { cb(null); });
}

export async function updateHappyHour(config: Partial<HappyHourConfig>): Promise<void> {
  await setDoc(doc(db, HAPPY_HOUR_COL, "current"), {
    ...config,
    updatedAt: serverTimestamp(),
  }, { merge: true });
}

export function subscribeToAggregatorSettings(
  cb: (settings: AggregatorSettings[]) => void
): Unsubscribe {
  return onSnapshot(collection(db, AGG_SETTINGS_COL), (snap) => {
    cb(snap.docs.map((d) => ({ id: d.id, ...d.data() } as AggregatorSettings)));
  }, () => { cb([]); });
}

export async function updateAggregatorSettings(
  name: string,
  data: Partial<AggregatorSettings>
): Promise<void> {
  await setDoc(doc(db, AGG_SETTINGS_COL, name), {
    ...data,
    updatedAt: serverTimestamp(),
  }, { merge: true });
}

export async function addAggregatorOrder(order: Omit<AggregatorOrder, "id">): Promise<string> {
  const activeShift = await getCurrentOpenShift().catch(() => null);
  const ref = await addDoc(collection(db, AGG_ORDERS_COL), {
    ...order,
    shiftId: activeShift?.id ?? null,
    createdAt: serverTimestamp(),
  });
  return ref.id;
}

export function subscribeToAggregatorOrders(
  cb: (orders: AggregatorOrder[]) => void
): Unsubscribe {
  const q = query(
    collection(db, AGG_ORDERS_COL),
    orderBy("createdAt", "desc"),
    limit(50)
  );
  return onSnapshot(q, (snap) => {
    cb(snap.docs.map((d) => ({ id: d.id, ...d.data() } as AggregatorOrder)));
  }, () => { cb([]); });
}

export function subscribeToMenuOverrides(
  cb: (overrides: Record<string, MenuOverride>) => void
): Unsubscribe {
  return onSnapshot(collection(db, MENU_OVERRIDES_COL), (snap) => {
    const result: Record<string, MenuOverride> = {};
    snap.docs.forEach((d) => {
      const data = d.data() as MenuOverride;
      result[data.menuItemId] = { id: d.id, ...data };
    });
    cb(result);
  }, () => { cb({}); });
}

/**
 * 🔴 2026-05-09 — CANONICAL OVERRIDE KEY HELPER.
 *
 * Slugifies an item name into a stable Firestore doc id used for
 * `posMenuOverrides`. We key by NAME (not by m1 / hod1) because the menu data
 * exists in 3 separate places — menu-data.ts (admin + captain, prefix `m`),
 * hod-menu.ts (bar, prefix `hod`), and hodclub-patched/index.html (customer
 * wallet, NO ids at all). Names are the only common denominator.
 *
 * E.g. "Mushroom Cappuccino Soup" → "mushroom-cappuccino-soup"
 */
export function menuOverrideKey(itemName: string): string {
  return itemName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export async function setMenuOverride(
  itemName: string,
  override: Partial<MenuOverride>
): Promise<void> {
  const key = menuOverrideKey(itemName);
  await setDoc(doc(db, MENU_OVERRIDES_COL, key), stripUndefined({
    menuItemId: key,
    name: itemName,
    ...override,
    updatedAt: serverTimestamp(),
  }), { merge: true });
}

export async function getCurrentOpenShift(): Promise<POSShift | null> {
  const q = query(
    collection(db, SHIFTS_COL),
    where("status", "==", "open"),
    orderBy("openedAt", "desc"),
    limit(1)
  );
  const snap = await getDocs(q);
  if (snap.empty) return null;
  const d = snap.docs[0];
  return { id: d.id, ...d.data() } as POSShift;
}

export function subscribeToCurrentShift(
  cb: (shift: POSShift | null, error?: Error) => void
): Unsubscribe {
  const q = query(
    collection(db, SHIFTS_COL),
    where("status", "==", "open"),
    orderBy("openedAt", "desc"),
    limit(1)
  );
  return onSnapshot(
    q,
    (snap) => {
      if (snap.empty) { cb(null); return; }
      const d = snap.docs[0];
      cb({ id: d.id, ...d.data() } as POSShift);
    },
    (err) => { cb(null, err); }
  );
}

const ACTIVE_SHIFT_PTR = "activeShiftPointer";

export async function openShift(shift: {
  shiftType: POSShift["shiftType"];
  cashierName: string;
  cashierId?: string;
  managerName?: string;
  openingCash: number;
  openingNote?: string;
}): Promise<string> {
  const ptrRef = doc(db, BILL_COUNTER_COL, ACTIVE_SHIFT_PTR);
  return await runTransaction(db, async (tx) => {
    const ptrSnap = await tx.get(ptrRef);
    const currentId = ptrSnap.exists() ? (ptrSnap.data().shiftId as string | undefined) : undefined;
    if (currentId) {
      const activeRef = doc(db, SHIFTS_COL, currentId);
      const activeSnap = await tx.get(activeRef);
      if (activeSnap.exists() && (activeSnap.data() as POSShift).status === "open") {
        const a = activeSnap.data() as POSShift;
        throw new Error(`A shift is already open (${a.shiftType}, ${a.cashierName})`);
      }
    }
    const newRef = doc(collection(db, SHIFTS_COL));
    tx.set(newRef, stripUndefined({
      ...shift,
      status: "open",
      openedAt: serverTimestamp(),
    }));
    tx.set(ptrRef, { shiftId: newRef.id });
    return newRef.id;
  });
}

export async function getShiftBills(shiftId: string): Promise<POSBill[]> {
  const q = query(
    collection(db, BILLS_COL),
    where("shiftId", "==", shiftId),
    where("status", "==", "paid")
  );
  const billsSnap = await getDocs(q);
  return billsSnap.docs
    .map((d) => ({ id: d.id, ...d.data() } as POSBill))
    .sort((a, b) => (a.paidAt?.toMillis?.() ?? 0) - (b.paidAt?.toMillis?.() ?? 0));
}

export function subscribeToShiftBills(
  shiftId: string,
  cb: (bills: POSBill[]) => void
): Unsubscribe {
  const q = query(
    collection(db, BILLS_COL),
    where("shiftId", "==", shiftId),
    where("status", "==", "paid")
  );
  return onSnapshot(
    q,
    (snap) => {
      const bills = snap.docs
        .map((d) => ({ id: d.id, ...d.data() } as POSBill))
        .sort((a, b) => (a.paidAt?.toMillis?.() ?? 0) - (b.paidAt?.toMillis?.() ?? 0));
      cb(bills);
    },
    () => { cb([]); }
  );
}

export async function closeShift(
  shiftId: string,
  closing: {
    closingCashCounted: number;
    closingDenominations?: import("./types").ShiftCashDenomination;
    closingNote?: string;
  }
): Promise<{ shift: POSShift; bills: POSBill[] }> {
  const bills = await getShiftBills(shiftId);
  const snap = await getDoc(doc(db, SHIFTS_COL, shiftId));
  if (!snap.exists()) throw new Error("Shift not found");
  const shift = snap.data() as POSShift;

  const paymentBreakdown: Record<PaymentMethod, number> = {
    cash: 0, card: 0, upi: 0, cover_wallet: 0, complimentary: 0,
  };
  const categoryBreakdown: Record<string, number> = {
    food: 0, liquor: 0, nab: 0, smoke: 0,
  };
  let totalRevenue = 0;
  let totalCovers = 0;
  let voidCount = 0;
  let discountTotal = 0;
  let compTotal = 0;

  for (const b of bills) {
    if (b.status !== "paid") continue;
    totalRevenue += b.total || 0;
    totalCovers += b.partySize || 0;
    discountTotal += b.discount || 0;
    categoryBreakdown.food += b.foodSubtotal || 0;
    categoryBreakdown.liquor += b.alcSubtotal || 0;
    categoryBreakdown.nab += b.nabSubtotal || 0;
    voidCount += (b.items || []).filter((i) => i.status === "void").length;
    for (const p of b.payments || []) {
      paymentBreakdown[p.method] = (paymentBreakdown[p.method] || 0) + (p.amount || 0);
    }
    if (b.payments?.some(p => p.method === "complimentary")) {
      compTotal += b.total || 0;
    }
  }

  const expectedCash = (shift.openingCash || 0) + (paymentBreakdown.cash || 0);
  const cashVariance = closing.closingCashCounted - expectedCash;

  const closedShift: Partial<POSShift> = {
    status: "closed",
    closedAt: Timestamp.now(),
    closingCashCounted: closing.closingCashCounted,
    closingDenominations: closing.closingDenominations,
    closingNote: closing.closingNote,
    expectedCash,
    cashVariance,
    totalBills: bills.length,
    totalCovers,
    totalRevenue,
    paymentBreakdown,
    categoryBreakdown,
    voidCount,
    discountTotal,
    compTotal,
  };
  await updateDoc(doc(db, SHIFTS_COL, shiftId), stripUndefined(closedShift as Record<string, unknown>));
  await setDoc(doc(db, BILL_COUNTER_COL, ACTIVE_SHIFT_PTR), { shiftId: null }, { merge: true });

  return {
    shift: { ...shift, ...closedShift, id: shiftId } as POSShift,
    bills,
  };
}

export async function getRecentShifts(limitCount: number = 10): Promise<POSShift[]> {
  const q = query(
    collection(db, SHIFTS_COL),
    where("status", "==", "closed"),
    orderBy("closedAt", "desc"),
    limit(limitCount)
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() } as POSShift));
}

export async function getDailyBills(dateStr: string): Promise<POSBill[]> {
  const startOfDay = new Date(dateStr + "T00:00:00");
  const endOfDay = new Date(dateStr + "T23:59:59");
  const q = query(
    collection(db, BILLS_COL),
    where("status", "==", "paid"),
    where("paidAt", ">=", Timestamp.fromDate(startOfDay)),
    where("paidAt", "<=", Timestamp.fromDate(endOfDay)),
    orderBy("paidAt", "asc")
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() } as POSBill));
}

export async function getDailyAggregatorOrders(dateStr: string): Promise<AggregatorOrder[]> {
  const startOfDay = new Date(dateStr + "T00:00:00");
  const endOfDay = new Date(dateStr + "T23:59:59");
  const q = query(
    collection(db, AGG_ORDERS_COL),
    where("createdAt", ">=", Timestamp.fromDate(startOfDay)),
    where("createdAt", "<=", Timestamp.fromDate(endOfDay)),
    orderBy("createdAt", "asc")
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() } as AggregatorOrder));
}

function cleanItems(items: OrderItem[]): OrderItem[] {
  return items.map((i) => {
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(i)) {
      if (v !== undefined) clean[k] = v;
    }
    return clean as unknown as OrderItem;
  });
}

export function makeOrderItem(
  menuItem: {
    id: string; name: string;
    category: import("./types").MenuCategory;
    group: import("./types").MenuCategoryGroup;
    price: number; isAlcohol: boolean;
  },
  qty: number = 1,
  notes?: string,
  servingSize?: string
): OrderItem {
  const item: OrderItem = {
    id: nanoid(),
    menuItemId: menuItem.id,
    name: menuItem.name,
    category: menuItem.category,
    group: menuItem.group,
    price: menuItem.price,
    qty,
    isAlcohol: menuItem.isAlcohol,
    status: "pending",
  };
  if (notes) item.notes = notes;
  if (servingSize) item.servingSize = servingSize as import("./types").ServingSize;
  return item;
}

export async function seedDefaultAggregatorSettings(): Promise<void> {
  const defaults: Array<Omit<AggregatorSettings, "id">> = [
    { name: "zomato", displayName: "Zomato Dining", commissionPercent: 0, commissionGstPercent: 18, currentDiscountTier: 30, discountFundedBy: "restaurant", monthlyAdBudget: 242143, tdsPercent: 0, active: true },
    { name: "swiggy-dineout", displayName: "Swiggy Dineout", commissionPercent: 5, commissionGstPercent: 18, currentDiscountTier: 30, discountFundedBy: "restaurant", monthlyAdBudget: 90000, tdsPercent: 0, active: true },
    { name: "swiggy-scenes", displayName: "Swiggy Scenes", commissionPercent: 5, commissionGstPercent: 18, currentDiscountTier: 0, discountFundedBy: "restaurant", monthlyAdBudget: 0, tdsPercent: 0, active: true },
    { name: "eazydiner", displayName: "EazyDiner", commissionPercent: 5, commissionGstPercent: 18, currentDiscountTier: 0, discountFundedBy: "restaurant", monthlyAdBudget: 15000, tdsPercent: 0, active: true },
  ];
  for (const s of defaults) {
    const ref = doc(db, AGG_SETTINGS_COL, s.name);
    const snap = await getDoc(ref);
    if (!snap.exists()) {
      await setDoc(ref, { ...s, updatedAt: serverTimestamp() });
    }
  }
}

export async function seedDefaultStaff(): Promise<void> {
  const q = query(collection(db, STAFF_COL), limit(1));
  const snap = await getDocs(q);
  if (!snap.empty) return;

  const defaultStaff: Array<Omit<StaffMember, "id">> = [
    { name: "Admin", pin: "0000", role: "admin", active: true },
    { name: "Manjunatha (GM)", pin: "1001", role: "manager", active: true },
    { name: "Satish (GM)", pin: "1002", role: "manager", active: true },
    { name: "Sumith (Manager)", pin: "1003", role: "manager", active: true },
    { name: "Adarsh (Manager)", pin: "1004", role: "manager", active: true },
    { name: "Sreekanth (Cashier)", pin: "2001", role: "cashier", active: true },
    { name: "Santhosh (Cashier)", pin: "2002", role: "cashier", active: true },
    { name: "Pemba (Cashier)", pin: "2003", role: "cashier", active: true },
    { name: "Captain 1", pin: "3001", role: "captain", active: true },
    { name: "Captain 2", pin: "3002", role: "captain", active: true },
    { name: "Captain 3", pin: "3003", role: "captain", active: true },
    { name: "Steward 1", pin: "4001", role: "steward", active: true },
    { name: "Bartender 1", pin: "5001", role: "bartender", active: true },
  ];

  for (const s of defaultStaff) {
    await addDoc(collection(db, STAFF_COL), { ...s, createdAt: serverTimestamp() });
  }
}
