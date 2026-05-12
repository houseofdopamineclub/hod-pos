import { useEffect, useState, useCallback, useRef } from "react";
import { useParams, useLocation } from "wouter";
import {
  ArrowLeft, Plus, Minus, Trash2, Send, FileText, Search,
  Edit3, Users, MessageSquare, X, Flame, Wine, Leaf, RefreshCw
} from "lucide-react";
import {
  subscribeToTableOrder, createOrder, addItemsToOrder, updateOrderItems, sendKOT,
  voidOrderItem, logAudit, subscribeToMenuOverrides, subscribeToHappyHour,
} from "@/lib/firestore";
import { getTableById } from "@/lib/tables-config";
import {
  MENU_ITEMS, CATEGORY_LABELS, GROUP_LABELS, GROUP_CATEGORIES, searchMenu,
} from "@/lib/menu-data";
import { makeOrderItem } from "@/lib/firestore";
import { formatINR, nanoid, isHappyHourActive, get60mlPrice, SERVICE_CHARGE_RATE } from "@/lib/utils-pos";
import { useStaff } from "@/lib/staff-context";
import type { POSOrder, OrderItem, MenuItem, MenuCategory, MenuCategoryGroup, MenuOverride, HappyHourConfig, ServingSize } from "@/lib/types";
import { cn } from "@/lib/utils";

const GROUPS: Array<MenuCategoryGroup | "all"> = ["food", "spirits", "beer-wine", "cocktails", "soft"];

export default function TablePOS() {
  const { tableId } = useParams<{ tableId: string }>();
  const [, setLocation] = useLocation();
  const { currentStaff } = useStaff();
  const table = getTableById(tableId || "");

  const [order, setOrder] = useState<POSOrder | null>(null);
  const [orderId, setOrderId] = useState<string | null>(null);
  const [localItems, setLocalItems] = useState<OrderItem[]>([]);
  const [selectedGroup, setSelectedGroup] = useState<MenuCategoryGroup | "all">("food");
  const [selectedCategory, setSelectedCategory] = useState<MenuCategory | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [guestName, setGuestName] = useState("");
  const [partySize, setPartySize] = useState(2);
  const [noteItem, setNoteItem] = useState<string | null>(null);
  const [noteText, setNoteText] = useState("");
  const [sendingKOT, setSendingKOT] = useState(false);
  const [showGuestForm, setShowGuestForm] = useState(false);
  const [menuOverrides, setMenuOverrides] = useState<Record<string, MenuOverride>>({});
  const [happyHour, setHappyHour] = useState<HappyHourConfig | null>(null);
  const [servingSizeModal, setServingSizeModal] = useState<MenuItem | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!tableId) return;
    const unsub = subscribeToTableOrder(tableId, (o) => {
      if (o) {
        setOrder(o);
        setOrderId(o.id || null);
        setLocalItems(o.items || []);
        if (o.guestName) setGuestName(o.guestName);
        if (o.partySize) setPartySize(o.partySize);
      } else {
        setOrder(null);
        setOrderId(null);
        setLocalItems([]);
        setShowGuestForm(true);
      }
    });
    return unsub;
  }, [tableId]);

  useEffect(() => {
    const unsubs = [
      subscribeToMenuOverrides(setMenuOverrides),
      subscribeToHappyHour(setHappyHour),
    ];
    return () => unsubs.forEach(u => u());
  }, []);

  const isHH = isHappyHourActive(happyHour);

  const getAvailableItems = useCallback((): MenuItem[] => {
    return MENU_ITEMS.filter(i => !menuOverrides[i.id]?.outOfStock);
  }, [menuOverrides]);

  const displayedItems: MenuItem[] = searchQuery
    ? searchMenu(searchQuery).filter(i => !menuOverrides[i.id]?.outOfStock)
    : selectedCategory
    ? getAvailableItems().filter((i) => i.category === selectedCategory)
    : selectedGroup === "all"
    ? getAvailableItems()
    : getAvailableItems().filter((i) => GROUP_CATEGORIES[selectedGroup as MenuCategoryGroup]?.includes(i.category));

  const subtotal = localItems
    .filter((i) => i.status !== "void")
    .reduce((s, i) => s + i.price * i.qty, 0);

  const pendingItems = localItems.filter((i) => i.status === "pending");
  const foodPending = pendingItems.filter(i => !i.isAlcohol && i.group === "food");
  const drinkPending = pendingItems.filter(i => i.isAlcohol || i.group !== "food");

  const addItem = useCallback(
    async (menuItem: MenuItem, servingSize?: ServingSize, customPrice?: number) => {
      const price = customPrice || menuItem.price;
      const existing = localItems.find(
        (i) => i.menuItemId === menuItem.id && i.status === "pending" && !i.notes && i.servingSize === servingSize && i.price === price
      );
      let newItems: OrderItem[];
      if (existing) {
        newItems = localItems.map((i) =>
          i.id === existing.id ? { ...i, qty: i.qty + 1 } : i
        );
      } else {
        const oi = makeOrderItem(menuItem, 1, undefined, servingSize);
        oi.price = price;
        newItems = [...localItems, oi];
      }
      setLocalItems(newItems);

      if (orderId) {
        await updateOrderItems(orderId, newItems).catch(() => {});
      } else if (guestName || partySize) {
        if (!tableId || !table) return;
        try {
          const oid = await createOrder({
            tableId,
            tableName: table.name,
            section: table.section,
            items: newItems,
            status: "open",
            guestName: guestName || "Walk-in",
            partySize,
            kotNumbers: [],
            captainId: currentStaff?.id || "",
            captainName: currentStaff?.name || "",
          });
          setOrderId(oid);
        } catch {
          setOrderId(`local-${nanoid()}`);
        }
        setShowGuestForm(false);
      }
    },
    [localItems, orderId, guestName, partySize, tableId, table, currentStaff]
  );

  const handleItemClick = (menuItem: MenuItem) => {
    if (menuItem.category.startsWith("spirits-") || menuItem.servingSizes || menuItem.category === "beer-craft") {
      setServingSizeModal(menuItem);
    } else {
      addItem(menuItem);
    }
  };

  const updateQty = useCallback(
    async (itemId: string, delta: number) => {
      let newItems = localItems
        .map((i) => (i.id === itemId ? { ...i, qty: i.qty + delta } : i))
        .filter((i) => i.qty > 0);
      setLocalItems(newItems);
      if (orderId) await updateOrderItems(orderId, newItems).catch(() => {});
    },
    [localItems, orderId]
  );

  const handleVoidItem = useCallback(
    async (itemId: string) => {
      const newItems = localItems.map((i) =>
        i.id === itemId ? { ...i, status: "void" as const } : i
      );
      setLocalItems(newItems);
      if (orderId) {
        await updateOrderItems(orderId, newItems).catch(() => {});
        if (currentStaff) {
          await logAudit({
            action: "item_voided",
            staffId: currentStaff.id || "",
            staffName: currentStaff.name,
            staffRole: currentStaff.role,
            orderId,
            tableId,
            details: { itemId },
          }).catch(() => {});
        }
      }
    },
    [localItems, orderId, currentStaff, tableId]
  );

  const addNote = useCallback(
    async () => {
      if (!noteItem) return;
      const newItems = localItems.map((i) =>
        i.id === noteItem ? { ...i, notes: noteText } : i
      );
      setLocalItems(newItems);
      setNoteItem(null);
      setNoteText("");
      if (orderId) await updateOrderItems(orderId, newItems).catch(() => {});
    },
    [localItems, orderId, noteItem, noteText]
  );

  const handleSendKOT = async () => {
    if (!orderId || pendingItems.length === 0) return;
    setSendingKOT(true);
    try {
      const kotNumber = (order?.kotNumbers?.length || 0) + 1;
      if (foodPending.length > 0) {
        await sendKOT({
          orderId,
          tableId: tableId!,
          tableName: table?.name || tableId!,
          kotNumber,
          destination: "kitchen",
          items: foodPending.map((i) => ({
            name: i.name,
            qty: i.qty,
            notes: i.notes,
            category: i.category,
            servingSize: i.servingSize,
          })),
          sentBy: currentStaff?.name,
          status: "pending",
        });
      }
      if (drinkPending.length > 0) {
        await sendKOT({
          orderId,
          tableId: tableId!,
          tableName: table?.name || tableId!,
          kotNumber: foodPending.length > 0 ? kotNumber + 1 : kotNumber,
          destination: "bar",
          items: drinkPending.map((i) => ({
            name: i.name,
            qty: i.qty,
            notes: i.notes,
            category: i.category,
            servingSize: i.servingSize,
          })),
          sentBy: currentStaff?.name,
          status: "pending",
        });
      }
      if (currentStaff) {
        await logAudit({
          action: "kot_sent",
          staffId: currentStaff.id || "",
          staffName: currentStaff.name,
          staffRole: currentStaff.role,
          orderId,
          tableId,
          details: { itemCount: pendingItems.length, kotNumber },
        });
      }
    } finally {
      setSendingKOT(false);
    }
  };

  const handleSameAgain = async () => {
    if (!orderId) return;
    const sentItems = localItems.filter(i => i.status === "sent" || i.status === "served");
    if (sentItems.length === 0) return;
    const newItems = sentItems.map(i => ({
      ...i,
      id: nanoid(),
      status: "pending" as const,
    }));
    const merged = [...localItems, ...newItems];
    setLocalItems(merged);
    await updateOrderItems(orderId, merged).catch(() => {});
  };

  const handleStartOrder = async () => {
    if (!tableId || !table) return;
    try {
      const oid = await createOrder({
        tableId,
        tableName: table.name,
        section: table.section,
        items: localItems,
        status: "open",
        guestName: guestName || "Walk-in",
        partySize,
        kotNumbers: [],
        captainId: currentStaff?.id || "",
        captainName: currentStaff?.name || "",
      });
      setOrderId(oid);
    } catch {
      setOrderId(`local-${nanoid()}`);
    }
    setShowGuestForm(false);
  };

  if (!table) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center">
          <p className="text-muted-foreground">Table not found</p>
          <button onClick={() => setLocation("/")} className="mt-4 text-primary underline text-sm">
            Back to Floor
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background flex flex-col h-screen overflow-hidden">
      <header className="flex items-center gap-3 px-4 py-3 border-b border-border bg-card shrink-0">
        <button onClick={() => setLocation("/")} className="p-1.5 rounded-lg hover:bg-secondary transition-colors">
          <ArrowLeft size={18} className="text-muted-foreground" />
        </button>
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <h2 className="font-serif text-xl text-primary">{table.name}</h2>
            {table.isVIP && (
              <span className="text-[10px] bg-primary/20 text-primary px-1.5 py-0.5 rounded font-bold uppercase tracking-wide">
                {table.section === "ground-vvip" ? "VVIP" : "VIP"}
              </span>
            )}
            {isHH && (
              <span className="text-[10px] bg-green-500/20 text-green-400 px-1.5 py-0.5 rounded font-bold uppercase tracking-wide animate-pulse">
                Happy Hour
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground capitalize">{table.section.replace(/-/g, " ")} · {table.capacity} seats</p>
        </div>
        <div className="flex items-center gap-2">
          {guestName && (
            <div className="text-right text-xs">
              <div className="text-foreground font-medium">{guestName}</div>
              <div className="text-muted-foreground flex items-center gap-1 justify-end"><Users size={9}/> {partySize}</div>
            </div>
          )}
          {orderId && localItems.filter(i => i.status === "sent" || i.status === "served").length > 0 && (
            <button
              onClick={handleSameAgain}
              className="px-2.5 py-1.5 rounded-lg border border-primary/30 text-primary text-xs font-medium hover:bg-primary/10 flex items-center gap-1"
            >
              <RefreshCw size={11} /> Same Again
            </button>
          )}
          <button
            onClick={() => setShowGuestForm(!showGuestForm)}
            className="p-1.5 rounded-lg hover:bg-secondary transition-colors"
          >
            <Edit3 size={16} className="text-muted-foreground" />
          </button>
        </div>
      </header>

      {showGuestForm && (
        <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4">
          <div className="bg-card rounded-2xl border border-border p-6 w-full max-w-sm">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-serif text-lg">Table Details</h3>
              {orderId && (
                <button onClick={() => setShowGuestForm(false)}>
                  <X size={18} className="text-muted-foreground" />
                </button>
              )}
            </div>
            <div className="space-y-4">
              <div>
                <label className="text-xs text-muted-foreground uppercase tracking-wide mb-1.5 block">Guest Name</label>
                <input
                  value={guestName}
                  onChange={(e) => setGuestName(e.target.value)}
                  placeholder="Walk-in"
                  className="w-full bg-secondary border border-border rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:border-primary"
                />
              </div>
              <div>
                <label className="text-xs text-muted-foreground uppercase tracking-wide mb-1.5 block">Party Size</label>
                <div className="flex items-center gap-3">
                  <button onClick={() => setPartySize(Math.max(1, partySize - 1))} className="w-10 h-10 rounded-lg bg-secondary border border-border flex items-center justify-center">
                    <Minus size={16} />
                  </button>
                  <span className="text-2xl font-semibold w-8 text-center">{partySize}</span>
                  <button onClick={() => setPartySize(Math.min(30, partySize + 1))} className="w-10 h-10 rounded-lg bg-secondary border border-border flex items-center justify-center">
                    <Plus size={16} />
                  </button>
                </div>
              </div>
              <button
                onClick={orderId ? () => setShowGuestForm(false) : handleStartOrder}
                className="w-full bg-primary text-primary-foreground rounded-xl py-3 font-semibold text-sm"
              >
                {orderId ? "Update" : "Start Order"}
              </button>
            </div>
          </div>
        </div>
      )}

      {noteItem && (
        <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4">
          <div className="bg-card rounded-2xl border border-border p-5 w-full max-w-sm">
            <h3 className="font-semibold mb-3">Add Note</h3>
            <textarea
              value={noteText}
              onChange={(e) => setNoteText(e.target.value)}
              placeholder="e.g. no ice, extra spicy, allergy..."
              className="w-full bg-secondary border border-border rounded-lg p-3 text-sm min-h-[80px] focus:outline-none focus:border-primary resize-none"
              autoFocus
            />
            <div className="flex gap-2 mt-3">
              <button onClick={() => { setNoteItem(null); setNoteText(""); }} className="flex-1 py-2 rounded-lg border border-border text-sm">Cancel</button>
              <button onClick={addNote} className="flex-1 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium">Save</button>
            </div>
          </div>
        </div>
      )}

      {servingSizeModal && (
        <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4">
          <div className="bg-card rounded-2xl border border-border p-5 w-full max-w-sm">
            <h3 className="font-semibold mb-1">{servingSizeModal.name}</h3>
            <p className="text-xs text-muted-foreground mb-4">{CATEGORY_LABELS[servingSizeModal.category]}</p>
            <div className="space-y-2">
              {servingSizeModal.servingSizes ? (
                Object.entries(servingSizeModal.servingSizes).map(([size, price]) => (
                  <button key={size} onClick={() => { addItem(servingSizeModal, size as ServingSize, price); setServingSizeModal(null); }}
                    className="w-full flex items-center justify-between px-4 py-3 rounded-xl border border-border hover:border-primary/50 transition-colors">
                    <span className="text-sm font-medium capitalize">{size.replace('s','')}</span>
                    <span className="text-primary font-semibold">{formatINR(price)}</span>
                  </button>
                ))
              ) : (
                <>
                  <button onClick={() => { addItem(servingSizeModal, "30ml"); setServingSizeModal(null); }}
                    className="w-full flex items-center justify-between px-4 py-3 rounded-xl border border-border hover:border-primary/50">
                    <span className="text-sm font-medium">30ml (Single)</span>
                    <span className="text-primary font-semibold">{formatINR(servingSizeModal.price)}</span>
                  </button>
                  <button onClick={() => { addItem(servingSizeModal, "60ml", get60mlPrice(servingSizeModal.price)); setServingSizeModal(null); }}
                    className="w-full flex items-center justify-between px-4 py-3 rounded-xl border border-border hover:border-primary/50">
                    <span className="text-sm font-medium">60ml (Double)</span>
                    <span className="text-primary font-semibold">{formatINR(get60mlPrice(servingSizeModal.price))}</span>
                  </button>
                  {servingSizeModal.bottlePrice && (
                    <button onClick={() => { addItem(servingSizeModal, "bottle", servingSizeModal.bottlePrice!); setServingSizeModal(null); }}
                      className="w-full flex items-center justify-between px-4 py-3 rounded-xl border border-primary/30 hover:border-primary/60 bg-primary/5">
                      <div>
                        <span className="text-sm font-medium">Full Bottle</span>
                        <span className="text-[10px] text-green-400 ml-2">20% OFF</span>
                      </div>
                      <span className="text-primary font-semibold">{formatINR(servingSizeModal.bottlePrice)}</span>
                    </button>
                  )}
                </>
              )}
            </div>
            <button onClick={() => setServingSizeModal(null)} className="w-full mt-3 py-2 rounded-lg border border-border text-sm text-muted-foreground">Cancel</button>
          </div>
        </div>
      )}

      <div className="flex-1 flex overflow-hidden">
        <div className="flex-1 flex flex-col min-w-0 border-r border-border">
          <div className="p-3 space-y-2 shrink-0 border-b border-border">
            <div className="relative">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <input
                ref={searchRef}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search menu..."
                className="w-full pl-8 pr-3 py-2 bg-secondary border border-border rounded-lg text-sm focus:outline-none focus:border-primary"
              />
              {searchQuery && (
                <button onClick={() => setSearchQuery("")} className="absolute right-2 top-1/2 -translate-y-1/2">
                  <X size={14} className="text-muted-foreground" />
                </button>
              )}
            </div>
            {!searchQuery && (
              <div className="flex gap-1.5 overflow-x-auto no-scrollbar">
                {GROUPS.map((g) => (
                  <button
                    key={g}
                    onClick={() => { setSelectedGroup(g); setSelectedCategory(null); }}
                    className={cn(
                      "px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-colors shrink-0",
                      selectedGroup === g
                        ? "bg-primary text-primary-foreground"
                        : "bg-secondary text-muted-foreground hover:text-foreground"
                    )}
                  >
                    {g === "all" ? "All" : GROUP_LABELS[g as MenuCategoryGroup] || g}
                  </button>
                ))}
              </div>
            )}
            {!searchQuery && selectedGroup !== "all" && (
              <div className="flex gap-1.5 overflow-x-auto no-scrollbar">
                <button
                  onClick={() => setSelectedCategory(null)}
                  className={cn(
                    "px-2.5 py-1 rounded-md text-[11px] font-medium whitespace-nowrap shrink-0",
                    !selectedCategory ? "bg-muted text-foreground" : "text-muted-foreground"
                  )}
                >
                  All
                </button>
                {(GROUP_CATEGORIES[selectedGroup as MenuCategoryGroup] || []).map((cat) => (
                  <button
                    key={cat}
                    onClick={() => setSelectedCategory(cat)}
                    className={cn(
                      "px-2.5 py-1 rounded-md text-[11px] font-medium whitespace-nowrap shrink-0",
                      selectedCategory === cat ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    {CATEGORY_LABELS[cat]}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="flex-1 overflow-y-auto p-3 grid grid-cols-2 xl:grid-cols-3 gap-2 content-start">
            {displayedItems.map((item) => (
              <MenuItemCard key={item.id} item={item} onAdd={() => handleItemClick(item)} isOOS={!!menuOverrides[item.id]?.outOfStock} />
            ))}
            {displayedItems.length === 0 && (
              <div className="col-span-2 text-center py-12 text-muted-foreground text-sm">
                No items found
              </div>
            )}
          </div>
        </div>

        <div className="w-72 xl:w-80 flex flex-col shrink-0">
          <div className="flex-1 overflow-y-auto p-3 space-y-1.5">
            {localItems.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-muted-foreground text-sm gap-2">
                <Flame size={32} className="text-primary/30" />
                <p>Tap items to add</p>
              </div>
            ) : (
              localItems.map((item) => (
                <OrderItemRow
                  key={item.id}
                  item={item}
                  onInc={() => updateQty(item.id, 1)}
                  onDec={() => updateQty(item.id, -1)}
                  onVoid={() => handleVoidItem(item.id)}
                  onNote={() => { setNoteItem(item.id); setNoteText(item.notes || ""); }}
                />
              ))
            )}
          </div>

          <div className="border-t border-border p-3 space-y-2 shrink-0">
            <div className="flex justify-between items-center text-sm">
              <span className="text-muted-foreground">Subtotal ({localItems.filter(i => i.status !== "void").length} items)</span>
              <span className="font-semibold text-foreground">{formatINR(subtotal)}</span>
            </div>
            <div className="flex gap-2">
              <button
                onClick={handleSendKOT}
                disabled={sendingKOT || pendingItems.length === 0}
                className={cn(
                  "flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-semibold transition-all",
                  pendingItems.length > 0
                    ? "bg-secondary border border-primary/40 text-primary hover:bg-primary/10"
                    : "bg-secondary text-muted-foreground cursor-not-allowed"
                )}
              >
                <Send size={14} />
                {sendingKOT ? "Sending..." : `KOT${pendingItems.length > 0 ? ` (${pendingItems.length})` : ""}`}
              </button>
              <button
                onClick={() => setLocation(`/bill/${tableId}`)}
                disabled={localItems.filter(i => i.status !== "void").length === 0}
                className={cn(
                  "flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-semibold transition-all",
                  localItems.filter(i => i.status !== "void").length > 0
                    ? "bg-primary text-primary-foreground"
                    : "bg-primary/30 text-primary-foreground/50 cursor-not-allowed"
                )}
              >
                <FileText size={14} />
                Bill
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function MenuItemCard({ item, onAdd, isOOS }: { item: MenuItem; onAdd: () => void; isOOS: boolean }) {
  const isSpirit = item.category.startsWith("spirits-") || item.category === "beer-craft";
  return (
    <button
      onClick={onAdd}
      disabled={isOOS}
      className={cn(
        "group relative bg-card border border-border rounded-xl p-3 text-left hover:border-primary/50 active:scale-[0.97] transition-all",
        isOOS && "opacity-40 cursor-not-allowed"
      )}
    >
      {item.isVeg !== undefined && (
        <div className="absolute top-1.5 right-1.5">
          {item.isVeg
            ? <Leaf size={10} className="text-green-500" />
            : <div className="w-2.5 h-2.5 border border-red-500 flex items-center justify-center rounded-sm"><div className="w-1.5 h-1.5 rounded-full bg-red-500" /></div>}
        </div>
      )}
      <div className="text-[10px] text-muted-foreground mb-0.5 truncate">{CATEGORY_LABELS[item.category]}</div>
      <div className="text-sm font-medium text-foreground leading-tight mb-1.5 pr-4">{item.name}</div>
      <div className="flex items-center justify-between">
        <span className="text-primary font-semibold text-sm">{formatINR(item.price)}</span>
        <span className="text-[10px] text-muted-foreground">{item.unit || "each"}</span>
      </div>
      {isSpirit && (
        <div className="text-[9px] text-primary/60 mt-0.5">Tap for sizes</div>
      )}
      {isOOS && (
        <div className="absolute inset-0 flex items-center justify-center bg-background/60 rounded-xl">
          <span className="text-xs font-bold text-destructive uppercase">Out of Stock</span>
        </div>
      )}
      {!isOOS && (
        <div className="absolute inset-0 flex items-center justify-center bg-primary/10 opacity-0 group-hover:opacity-100 rounded-xl transition-opacity">
          <Plus size={20} className="text-primary" />
        </div>
      )}
    </button>
  );
}

function OrderItemRow({
  item, onInc, onDec, onVoid, onNote,
}: {
  item: OrderItem; onInc: () => void; onDec: () => void; onVoid: () => void; onNote: () => void;
}) {
  const isVoid = item.status === "void";
  const statusColor = {
    pending: "bg-yellow-500/20 text-yellow-400",
    sent: "bg-blue-500/20 text-blue-400",
    ready: "bg-green-500/20 text-green-400",
    served: "bg-muted text-muted-foreground",
    void: "bg-red-500/20 text-red-400",
  }[item.status];

  return (
    <div className={cn("bg-secondary rounded-xl p-2.5 transition-opacity", isVoid && "opacity-40")}>
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-sm font-medium text-foreground truncate">{item.name}</span>
            <span className={cn("text-[9px] px-1 py-0.5 rounded uppercase font-bold shrink-0", statusColor)}>
              {item.status}
            </span>
          </div>
          {item.servingSize && (
            <span className="text-[10px] text-muted-foreground">{item.servingSize}</span>
          )}
          {item.notes && (
            <p className="text-[11px] text-muted-foreground mt-0.5 italic">"{item.notes}"</p>
          )}
          <div className="text-xs text-primary mt-0.5">{formatINR(item.price * item.qty)}</div>
        </div>
        {!isVoid && (
          <div className="flex items-center gap-1 shrink-0">
            {item.status === "pending" ? (
              <>
                <button onClick={onDec} className="w-6 h-6 rounded bg-card border border-border flex items-center justify-center hover:border-primary/50">
                  <Minus size={10} />
                </button>
                <span className="text-sm font-semibold w-5 text-center">{item.qty}</span>
                <button onClick={onInc} className="w-6 h-6 rounded bg-card border border-border flex items-center justify-center hover:border-primary/50">
                  <Plus size={10} />
                </button>
              </>
            ) : (
              <span className="text-sm font-semibold w-5 text-center">×{item.qty}</span>
            )}
          </div>
        )}
      </div>
      {!isVoid && item.status === "pending" && (
        <div className="flex gap-2 mt-1.5">
          <button onClick={onNote} className="text-[10px] text-muted-foreground hover:text-primary flex items-center gap-0.5">
            <MessageSquare size={9} /> Note
          </button>
          <button onClick={onVoid} className="text-[10px] text-muted-foreground hover:text-destructive flex items-center gap-0.5 ml-auto">
            <Trash2 size={9} /> Void
          </button>
        </div>
      )}
    </div>
  );
}
