import type { Timestamp } from "firebase/firestore";

export type TableStatus = "available" | "occupied" | "reserved" | "billing" | "cleaning";
export type TableSection = "ground" | "ground-vvip" | "dining" | "smoking" | "rooftop" | "rooftop-vip";

export interface TableConfig {
  id: string;
  name: string;
  capacity: number;
  section: TableSection;
  isVIP?: boolean;
  shape?: "round" | "rect";
}

export interface TableReservation {
  tableId: string;
  status: TableStatus;
  guestName?: string;
  partySize?: number;
  seatedAt?: Timestamp;
  bookingId?: string;
  phone?: string;
  reservationType?: "walkin" | "reservation" | "vip" | "aggregator";
  coverAmount?: number;
  coversPaid?: number;
  orderId?: string;
}

export type MenuCategory =
  | "food-soups"
  | "food-salads"
  | "food-bar-bites"
  | "food-chargrilled"
  | "food-platters"
  | "food-oriental"
  | "food-international"
  | "food-pasta-pizza"
  | "food-coastal"
  | "food-mains"
  | "food-biryani-rice"
  | "food-noodles"
  | "food-breads"
  | "food-desserts"
  | "beer-craft"
  | "beer"
  | "wine"
  | "spirits-single-malt"
  | "spirits-scotch"
  | "spirits-whiskey"
  | "spirits-vodka"
  | "spirits-gin"
  | "spirits-rum"
  | "spirits-tequila"
  | "spirits-brandy"
  | "spirits-liqueur"
  | "cocktails"
  | "mocktails"
  | "shooters"
  | "soft-drinks";

export type MenuCategoryGroup = "spirits" | "beer-wine" | "cocktails" | "soft" | "food";

export interface MenuItem {
  id: string;
  name: string;
  category: MenuCategory;
  group: MenuCategoryGroup;
  price: number;
  unit?: string;
  isAlcohol: boolean;
  available: boolean;
  isVeg?: boolean;
  costPrice?: number;
  bottlePrice?: number;
  pitcherPrice?: number;
  floor?: string;
  servingSizes?: Record<string, number>;
  description?: string;
  popular?: boolean;
}

export type ServingSize = "30ml" | "60ml" | "90ml" | "bottle" | "330ml" | "500ml" | "pitcher" | "tower" | "glass" | "each";

export interface OrderItem {
  id: string;
  menuItemId: string;
  name: string;
  category: MenuCategory;
  group: MenuCategoryGroup;
  price: number;
  qty: number;
  notes?: string;
  isAlcohol: boolean;
  servingSize?: ServingSize;
  isBottle?: boolean;
  bottleDiscount?: number;
  status: "pending" | "sent" | "ready" | "served" | "void";
  voidReason?: string;
  voidBy?: string;
  voidAt?: Timestamp;
  sentAt?: Timestamp;
  servedAt?: Timestamp;
}

export interface POSOrder {
  id?: string;
  tableId: string;
  tableName: string;
  section: TableSection;
  items: OrderItem[];
  status: "open" | "billed" | "paid" | "void";
  guestName?: string;
  partySize?: number;
  kotNumbers: number[];
  captainId?: string;
  captainName?: string;
  captainNote?: string;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
  coverAmount?: number;
  isAggregator?: boolean;
  aggregatorName?: string;
  aggregatorBookingId?: string;
}

export type PaymentMethod = "cash" | "card" | "upi" | "cover_wallet" | "complimentary";

export interface BillPayment {
  method: PaymentMethod;
  amount: number;
}

export interface POSBill {
  id?: string;
  orderId: string;
  tableId: string;
  tableName: string;
  guestName?: string;
  partySize?: number;
  items: OrderItem[];
  subtotal: number;
  foodSubtotal: number;
  alcSubtotal: number;
  nabSubtotal: number;
  cgst: number;
  sgst: number;
  serviceCharge: number;
  serviceChargeRate: number;
  discount: number;
  discountType: "percent" | "flat";
  discountValue: number;
  discountReason?: string;
  discountBy?: string;
  isHappyHour?: boolean;
  happyHourDiscount?: number;
  roundOff: number;
  total: number;
  payments: BillPayment[];
  status: "pending" | "paid" | "void";
  billNumber?: string;
  shiftId?: string;
  printCount?: number;
  createdAt?: Timestamp;
  paidAt?: Timestamp;
  captainId?: string;
  captainName?: string;
}

export interface KOTTicket {
  id?: string;
  orderId: string;
  tableId: string;
  tableName: string;
  kotNumber: number;
  destination: "kitchen" | "bar";
  items: Array<{
    name: string;
    qty: number;
    notes?: string;
    category: MenuCategory;
    servingSize?: string;
  }>;
  sentAt?: Timestamp;
  sentBy?: string;
  status: "pending" | "in-progress" | "ready";
  printCount?: number;
}

export type StaffRole = "admin" | "manager" | "cashier" | "captain" | "steward" | "bartender" | "hostess" | "chef";

export interface StaffMember {
  id?: string;
  name: string;
  pin: string;
  /** Primary role (back-compat). Falls back to roles[0] when roles[] is set. */
  role: StaffRole;
  /**
   * 🆕 2026-05-25 — Multi-role support (Khushi). When present, the staff member
   * has access to ALL listed roles (e.g. Tejas R = hostess + captain + bartender;
   * Ganesh Poojary = captain + bartender). When absent, behave as single-role
   * using `role`. Admin role implicitly grants access to every mode.
   */
  roles?: StaffRole[];
  /**
   * 🆕 2026-06-25 (Khushi) — per-staff "Can settle bills" permission. When TRUE
   * (or role is admin/manager, which always can), a captain may SETTLE BILL and
   * sees the blinking SETTLE BILL tab in Captain Mode. When falsy, a captain can
   * only "NOTIFY SUPERVISOR TO SETTLE BILL" and cannot collect/settle.
   */
  canSettle?: boolean;
  phone?: string;
  active: boolean;
  createdAt?: Timestamp;
}

export type ShiftType = "morning" | "evening" | "night";
export type ShiftStatus = "open" | "closed";

export interface ShiftCashDenomination {
  d2000?: number;
  d500?: number;
  d200?: number;
  d100?: number;
  d50?: number;
  d20?: number;
  d10?: number;
}

export interface POSShift {
  id?: string;
  shiftType: ShiftType;
  status: ShiftStatus;
  cashierName: string;
  cashierId?: string;
  managerName?: string;
  openingCash: number;
  openingNote?: string;
  openedAt?: Timestamp;
  closedAt?: Timestamp;
  closingCashCounted?: number;
  closingDenominations?: ShiftCashDenomination;
  closingNote?: string;
  expectedCash?: number;
  cashVariance?: number;
  totalBills?: number;
  totalCovers?: number;
  totalRevenue?: number;
  paymentBreakdown?: Record<PaymentMethod, number>;
  categoryBreakdown?: Record<string, number>;
  voidCount?: number;
  discountTotal?: number;
  compTotal?: number;
  wastageTotal?: number;
}

export interface AuditLogEntry {
  id?: string;
  action: string;
  staffId: string;
  staffName: string;
  staffRole: StaffRole;
  tableId?: string;
  orderId?: string;
  billId?: string;
  details: Record<string, unknown>;
  timestamp?: Timestamp;
}

export interface CompRecord {
  id?: string;
  orderId: string;
  tableId: string;
  itemName: string;
  itemPrice: number;
  qty: number;
  reason: string;
  captainId: string;
  captainName: string;
  approvedByManager: boolean;
  managerId?: string;
  managerName?: string;
  createdAt?: Timestamp;
}

export interface WastageRecord {
  id?: string;
  itemName: string;
  category: MenuCategory;
  qty: number;
  reason: string;
  reportedBy: string;
  reportedByName: string;
  createdAt?: Timestamp;
}

export interface HappyHourConfig {
  id?: string;
  enabled: boolean;
  days: number[];
  startTime: string;
  endTime: string;
  discountPercent: number;
  appliesTo: "all" | "food" | "drinks";
  updatedBy?: string;
  updatedAt?: Timestamp;
}

export type AggregatorName = "zomato" | "swiggy-dineout" | "swiggy-scenes" | "eazydiner";

export interface AggregatorSettings {
  id?: string;
  name: AggregatorName;
  displayName: string;
  commissionPercent: number;
  commissionGstPercent: number;
  currentDiscountTier: number;
  discountFundedBy: "restaurant" | "aggregator" | "split";
  monthlyAdBudget: number;
  tdsPercent: number;
  active: boolean;
  updatedAt?: Timestamp;
}

export interface AggregatorOrder {
  id?: string;
  aggregator: AggregatorName;
  bookingId: string;
  customerName?: string;
  customerPhone?: string;
  billAmount: number;
  covers: number;
  discountPercent: number;
  discountAmount: number;
  commissionAmount: number;
  netReceivable: number;
  notes?: string;
  enteredBy: string;
  enteredByName: string;
  shiftId?: string;
  createdAt?: Timestamp;
}

export interface DailyReport {
  date: string;
  totalRevenue: number;
  totalCovers: number;
  totalBills: number;
  avgTicket: number;
  categoryBreakdown: Record<string, number>;
  hourlyRevenue: Record<number, number>;
  topItems: Array<{ name: string; qty: number; revenue: number }>;
  paymentBreakdown: Record<PaymentMethod, number>;
  aggregatorBreakdown?: Record<AggregatorName, { revenue: number; commission: number; covers: number }>;
  compTotal?: number;
  voidTotal?: number;
  wastageTotal?: number;
}

export interface MenuOverride {
  id?: string;
  // 🔴 2026-05-09 — KEY IS A SLUGIFIED ITEM NAME (e.g. "mushroom-cappuccino-soup")
  // NOT the menu data row's `m1` / `hod1` id. Names are the only thing
  // shared between menu-data.ts (admin/captain), hod-menu.ts (bar), AND
  // hodclub.in customer wallet (which has no IDs). Use `menuOverrideKey(name)`.
  menuItemId: string;
  // Human-readable item name, stored alongside for audit/debug visibility.
  name?: string;
  outOfStock: boolean;
  // Legacy — flat price override, rarely used. Discount fields below are preferred.
  priceOverride?: number;
  // Manager-set discount (either % OR flat ₹ — never both). Applied at cart-add time
  // in CaptainMode/BarMode and at render time in customer wallet.
  discountPercent?: number;
  discountAmount?: number;
  discountReason?: string;
  updatedBy?: string;
  updatedAt?: Timestamp;
}
