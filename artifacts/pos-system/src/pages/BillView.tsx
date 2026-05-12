import { useEffect, useState, useCallback } from "react";
import { useParams, useLocation } from "wouter";
import {
  ArrowLeft, Printer, CheckCircle, CreditCard, Banknote, Smartphone,
  Wallet, Gift, Percent, Minus, Plus, ChevronDown, ChevronUp, Split,
  Shield, AlertTriangle, Lock, X
} from "lucide-react";
import { subscribeToTableOrder, createBill, markBillPaid, updateOrderStatus, logAudit, addCompRecord, getTodayComps, getBill, incrementBillPrintCount } from "@/lib/firestore";
import { printBill as printBillThermal } from "@/lib/firestore-hod";
import { getTableById } from "@/lib/tables-config";
import { calcBillAmounts, formatINR, formatINRDecimal, formatTime, formatDate, nanoid, GSTIN, VENUE_NAME, VENUE_ADDRESS, COMP_MAX_PER_NIGHT, COMP_LIMIT_PER_CAPTAIN, DISCOUNT_PIN_THRESHOLD, SERVICE_CHARGE_RATE } from "@/lib/utils-pos";
import { useStaff } from "@/lib/staff-context";
import type { POSOrder, PaymentMethod, BillPayment, OrderItem } from "@/lib/types";
import { cn } from "@/lib/utils";

type DiscountType = "percent" | "flat";
type SplitMode = "none" | "equal" | "custom";

export default function BillView() {
  const { tableId } = useParams<{ tableId: string }>();
  const [, setLocation] = useLocation();
  const { currentStaff, verifyManagerPin } = useStaff();
  const table = getTableById(tableId || "");

  const [order, setOrder] = useState<POSOrder | null>(null);
  const [orderId, setOrderId] = useState<string | null>(null);
  const [serviceChargeRate, setServiceChargeRate] = useState(SERVICE_CHARGE_RATE);
  const [discountType, setDiscountType] = useState<DiscountType>("percent");
  const [discountValue, setDiscountValue] = useState(0);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("cash");
  const [splitMode, setSplitMode] = useState<SplitMode>("none");
  const [splitCovers, setSplitCovers] = useState(2);
  const [paying, setPaying] = useState(false);
  const [paid, setPaid] = useState(false);
  const [billId, setBillId] = useState<string | null>(null);
  const [captainNote, setCaptainNote] = useState("");
  const [showDiscount, setShowDiscount] = useState(false);
  const [compReason, setCompReason] = useState("");
  const [showCompModal, setShowCompModal] = useState(false);
  const [managerPinModal, setManagerPinModal] = useState<{ reason: string; onSuccess: (managerName: string) => void; onCancel: () => void } | null>(null);
  const [managerPinInput, setManagerPinInput] = useState("");
  const [managerPinError, setManagerPinError] = useState("");
  const [isDuplicate, setIsDuplicate] = useState(false);
  const [discountApprovedBy, setDiscountApprovedBy] = useState<string | null>(null);

  useEffect(() => {
    if (!tableId) return;
    const unsub = subscribeToTableOrder(tableId, (o) => {
      if (o) {
        setOrder(o);
        setOrderId(o.id || null);
        if (o.partySize) setSplitCovers(o.partySize);
      }
    });
    return unsub;
  }, [tableId]);

  const activeItems = order?.items.filter((i) => i.status !== "void") || [];
  const amounts = calcBillAmounts(
    activeItems.map((i) => ({ ...i })),
    serviceChargeRate,
    discountType,
    discountValue
  );

  const perCover = splitMode !== "none" ? amounts.total / splitCovers : 0;

  const requireManagerPin = useCallback((reason: string): Promise<string> => {
    return new Promise((resolve, reject) => {
      setManagerPinModal({
        reason,
        onSuccess: (managerName: string) => {
          setManagerPinModal(null);
          setManagerPinInput("");
          setManagerPinError("");
          resolve(managerName);
        },
        onCancel: () => {
          setManagerPinModal(null);
          setManagerPinInput("");
          setManagerPinError("");
          reject(new Error("Manager approval cancelled"));
        },
      });
    });
  }, []);

  const handleManagerPinSubmit = () => {
    const manager = verifyManagerPin(managerPinInput);
    if (manager) {
      managerPinModal?.onSuccess(manager.name);
    } else {
      setManagerPinError("Invalid manager PIN");
      setManagerPinInput("");
    }
  };

  const handleDiscountChange = async (value: number) => {
    if (discountType === "percent" && value > DISCOUNT_PIN_THRESHOLD) {
      try {
        const managerName = await requireManagerPin(`Discount above ${DISCOUNT_PIN_THRESHOLD}% requires manager approval`);
        setDiscountApprovedBy(managerName);
        setDiscountValue(value);
        if (currentStaff) {
          await logAudit({
            action: "high_discount_applied",
            staffId: currentStaff.id || "",
            staffName: currentStaff.name,
            staffRole: currentStaff.role,
            orderId: orderId || undefined,
            tableId,
            details: { discountType, discountValue: value, approvedBy: managerName },
          });
        }
      } catch {
        return;
      }
    } else {
      setDiscountValue(value);
      setDiscountApprovedBy(null);
    }
  };

  const handleComplimentary = async () => {
    if (!currentStaff || !orderId) return;
    const captainId = currentStaff.id || "";
    const todayComps = await getTodayComps(captainId);

    if (todayComps.length >= COMP_LIMIT_PER_CAPTAIN || amounts.total > COMP_MAX_PER_NIGHT) {
      try {
        const managerName = await requireManagerPin(
          `Comp limit exceeded (${todayComps.length}/${COMP_LIMIT_PER_CAPTAIN} tonight, ₹${amounts.total} > ₹${COMP_MAX_PER_NIGHT} cap). Manager approval required.`
        );
        await addCompRecord({
          orderId,
          tableId: tableId || "",
          itemName: "Full bill comp",
          itemPrice: amounts.total,
          qty: 1,
          reason: compReason || "Complimentary",
          captainId,
          captainName: currentStaff.name,
          approvedByManager: true,
          managerName,
        });
      } catch {
        return;
      }
    } else {
      await addCompRecord({
        orderId,
        tableId: tableId || "",
        itemName: "Full bill comp",
        itemPrice: amounts.total,
        qty: 1,
        reason: compReason || "Complimentary",
        captainId,
        captainName: currentStaff.name,
        approvedByManager: false,
      });
    }

    await logAudit({
      action: "bill_comp",
      staffId: captainId,
      staffName: currentStaff.name,
      staffRole: currentStaff.role,
      orderId,
      tableId,
      details: { amount: amounts.total, reason: compReason },
    });

    setPaymentMethod("complimentary");
    setShowCompModal(false);
    setCompReason("");
  };

  const handleSettleBill = async () => {
    if (!order || !orderId || !tableId) return;
    setPaying(true);
    try {
      const bid = await createBill({
        orderId,
        tableId,
        tableName: table?.name || tableId,
        guestName: order.guestName,
        partySize: order.partySize,
        items: activeItems,
        ...amounts,
        serviceChargeRate,
        discountType,
        discountValue,
        discountReason: discountValue > 0 ? captainNote : undefined,
        discountBy: discountApprovedBy || currentStaff?.name,
        payments: [{ method: paymentMethod, amount: amounts.total }],
        status: "paid",
        captainId: currentStaff?.id,
        captainName: currentStaff?.name,
      });
      setBillId(bid);
      await markBillPaid(bid, orderId, tableId);

      if (currentStaff) {
        await logAudit({
          action: "bill_settled",
          staffId: currentStaff.id || "",
          staffName: currentStaff.name,
          staffRole: currentStaff.role,
          orderId,
          billId: bid,
          tableId,
          details: { total: amounts.total, paymentMethod, discountValue, discountType },
        });
      }

      setPaid(true);
    } finally {
      setPaying(false);
    }
  };

  const handleThermalBillPrint = async (isDuplicate = false) => {
    if (!order || !activeItems.length) {
      alert("No items to print");
      return;
    }
    const ok = await printBillThermal({
      tableId: tableId || "",
      floorLabel: table?.name || "",
      customerName: order.guestName,
      partySize: order.partySize,
      staff: currentStaff?.name || "Staff",
      items: activeItems.map((i) => ({ n: i.name, p: i.price, qty: i.qty })),
      amounts: {
        subtotal: amounts.subtotal,
        serviceCharge: amounts.serviceCharge,
        cgst: amounts.cgst,
        sgst: amounts.sgst,
        discount: amounts.discount,
        roundOff: amounts.roundOff,
        total: amounts.total,
        happyHourDiscount: amounts.happyHourDiscount || 0,
      },
      paymentMethod: paid ? paymentMethod : undefined,
      billNumber: billId || undefined,
      isDuplicate,
    });
    alert(ok
      ? "🖨 Bill sent to thermal printer.\nWatch the bill printer for paper."
      : "❌ Failed to enqueue bill print. Check internet."
    );
    if (ok && billId && isDuplicate) {
      await incrementBillPrintCount(billId);
      setIsDuplicate(true);
    }
  };

  const handleReprint = async () => {
    if (billId) {
      await incrementBillPrintCount(billId);
      setIsDuplicate(true);
      if (currentStaff) {
        await logAudit({
          action: "bill_reprinted",
          staffId: currentStaff.id || "",
          staffName: currentStaff.name,
          staffRole: currentStaff.role,
          billId,
          tableId,
          details: {},
        });
      }
      window.print();
    } else {
      window.print();
    }
  };

  if (paid) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-6">
        <div className="text-center space-y-4 max-w-xs">
          <div className="w-16 h-16 bg-green-500/20 rounded-full flex items-center justify-center mx-auto">
            <CheckCircle size={36} className="text-green-400" />
          </div>
          <h2 className="font-serif text-2xl text-primary">Bill Settled</h2>
          <p className="text-muted-foreground text-sm">
            {table?.name} · {formatINR(amounts.total)} via {paymentMethod.toUpperCase()}
          </p>
          <div className="text-3xl font-bold text-foreground">{formatINR(amounts.total)}</div>
          <div className="flex flex-col gap-2 pt-2">
            <button
              onClick={() => handleThermalBillPrint(isDuplicate)}
              className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl bg-primary text-primary-foreground text-sm font-semibold"
              data-testid="button-thermal-bill-settled"
            >
              <Printer size={14} /> 🖨 {isDuplicate ? "Reprint Thermal Bill" : "Print Thermal Bill"}
            </button>
            <div className="flex gap-3">
            <button
              onClick={handleReprint}
              className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl border border-border text-sm hover:border-primary/50"
            >
              <Printer size={14} /> Browser {isDuplicate ? "Reprint" : "Print"}
            </button>
            <button
              onClick={() => setLocation("/")}
              className="flex-1 py-2.5 rounded-xl bg-primary text-primary-foreground text-sm font-semibold"
            >
              Done
            </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (!order) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center">
          <p className="text-muted-foreground">No open order found</p>
          <button onClick={() => setLocation(`/table/${tableId}`)} className="mt-4 text-primary underline text-sm">
            Go to Table
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <header className="flex items-center gap-3 px-4 py-3 border-b border-border bg-card">
        <button onClick={() => setLocation(`/table/${tableId}`)} className="p-1.5 rounded-lg hover:bg-secondary">
          <ArrowLeft size={18} className="text-muted-foreground" />
        </button>
        <div>
          <h2 className="font-serif text-xl text-primary">Bill — {table?.name}</h2>
          <p className="text-xs text-muted-foreground">{order.guestName} · {order.partySize} pax</p>
        </div>
        <button
          onClick={() => handleThermalBillPrint(false)}
          className="ml-auto px-3 py-2 rounded-lg bg-primary text-primary-foreground text-xs font-semibold flex items-center gap-1.5"
          title="Print bill on thermal printer (.15)"
          data-testid="button-thermal-bill"
        >
          <Printer size={14} /> Thermal Bill
        </button>
        <button
          onClick={() => window.print()}
          className="p-2 rounded-lg border border-border hover:border-primary/50"
          title="Browser print (paper via Mac printer)"
        >
          <Printer size={16} className="text-muted-foreground" />
        </button>
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-xl mx-auto p-4 space-y-4">
          <div className="hidden print:block text-center py-4">
            <div className="font-serif text-3xl text-primary">HOD</div>
            <p className="text-xs text-muted-foreground">{VENUE_NAME} · {VENUE_ADDRESS}</p>
            <p className="text-xs mt-1">GSTIN: {GSTIN}</p>
            <hr className="my-2 border-border" />
            <p className="text-sm">Table: {table?.name} | {formatTime(new Date())} | {order.guestName}</p>
            {isDuplicate && (
              <div className="mt-2 py-1 px-3 border-2 border-destructive text-destructive text-sm font-bold uppercase tracking-widest inline-block transform -rotate-3">
                DUPLICATE
              </div>
            )}
          </div>

          <div className="bg-card rounded-2xl border border-border overflow-hidden">
            <div className="px-4 py-3 border-b border-border flex items-center justify-between">
              <span className="text-sm font-semibold">Order Items</span>
              <span className="text-xs text-muted-foreground">{activeItems.length} items</span>
            </div>
            <div className="divide-y divide-border">
              {activeItems.map((item) => (
                <div key={item.id} className="px-4 py-2.5 flex items-center justify-between">
                  <div className="flex-1 min-w-0">
                    <span className="text-sm text-foreground">{item.name}</span>
                    {item.servingSize && (
                      <span className="text-[10px] text-muted-foreground ml-1">({item.servingSize})</span>
                    )}
                    {item.notes && <p className="text-[11px] text-muted-foreground italic">"{item.notes}"</p>}
                  </div>
                  <div className="flex items-center gap-4 shrink-0">
                    <span className="text-xs text-muted-foreground">×{item.qty}</span>
                    <span className="text-sm font-medium w-20 text-right">{formatINR(item.price * item.qty)}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="bg-card rounded-2xl border border-border overflow-hidden">
            <button
              onClick={() => setShowDiscount(!showDiscount)}
              className="w-full px-4 py-3 flex items-center justify-between text-sm font-semibold"
            >
              <span>Charges & Discounts</span>
              {showDiscount ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
            </button>
            {showDiscount && (
              <div className="px-4 pb-4 space-y-3 border-t border-border pt-3">
                <div className="flex items-center justify-between gap-4">
                  <label className="text-sm text-muted-foreground">Service Charge</label>
                  <div className="flex items-center gap-2">
                    {[0, 5, 10].map((v) => (
                      <button
                        key={v}
                        onClick={() => setServiceChargeRate(v)}
                        className={cn(
                          "px-3 py-1 rounded-lg text-xs font-medium border transition-colors",
                          serviceChargeRate === v
                            ? "bg-primary text-primary-foreground border-primary"
                            : "border-border text-muted-foreground hover:border-primary/50"
                        )}
                      >
                        {v}%
                      </button>
                    ))}
                  </div>
                </div>
                <div className="flex items-center justify-between gap-4">
                  <label className="text-sm text-muted-foreground">Discount</label>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setDiscountType("percent")}
                      className={cn(
                        "px-2.5 py-1 rounded-lg text-xs font-medium border transition-colors",
                        discountType === "percent" ? "bg-primary text-primary-foreground border-primary" : "border-border text-muted-foreground"
                      )}
                    >
                      %
                    </button>
                    <button
                      onClick={() => setDiscountType("flat")}
                      className={cn(
                        "px-2.5 py-1 rounded-lg text-xs font-medium border transition-colors",
                        discountType === "flat" ? "bg-primary text-primary-foreground border-primary" : "border-border text-muted-foreground"
                      )}
                    >
                      ₹
                    </button>
                    <input
                      type="number"
                      min="0"
                      value={discountValue || ""}
                      onChange={(e) => handleDiscountChange(Number(e.target.value) || 0)}
                      placeholder="0"
                      className="w-20 bg-secondary border border-border rounded-lg px-2 py-1 text-sm text-right focus:outline-none focus:border-primary"
                    />
                  </div>
                </div>
                {discountValue > DISCOUNT_PIN_THRESHOLD && discountType === "percent" && discountApprovedBy && (
                  <div className="flex items-center gap-1.5 text-xs text-green-400">
                    <Shield size={11} />
                    Approved by {discountApprovedBy}
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="bg-card rounded-2xl border border-border overflow-hidden">
            <div className="px-4 py-3 border-b border-border flex items-center justify-between">
              <span className="text-sm font-semibold">Bill Summary</span>
              <span className="text-[10px] text-muted-foreground">GSTIN: {GSTIN}</span>
            </div>
            <div className="px-4 py-3 space-y-2.5">
              <BillRow label="Food" value={formatINR(amounts.foodSubtotal)} />
              <BillRow label="Liquor" value={formatINR(amounts.alcSubtotal)} />
              {amounts.nabSubtotal > 0 && (
                <BillRow label="NAB / Soft Drinks" value={formatINR(amounts.nabSubtotal)} />
              )}
              <div className="h-px bg-border" />
              <BillRow label="Subtotal" value={formatINR(amounts.subtotal)} />
              {amounts.serviceCharge > 0 && (
                <BillRow label={`Service Charge (${serviceChargeRate}%)`} value={formatINR(amounts.serviceCharge)} />
              )}
              {amounts.discount > 0 && (
                <BillRow label="Discount" value={`-${formatINR(amounts.discount)}`} valueClass="text-green-400" />
              )}
              {amounts.happyHourDiscount > 0 && (
                <BillRow label="Happy Hour Discount" value={`-${formatINR(amounts.happyHourDiscount)}`} valueClass="text-green-400" />
              )}
              <div className="h-px bg-border" />
              <BillRow label="CGST (2.5% on Food+NAB)" value={formatINRDecimal(amounts.cgst)} />
              <BillRow label="SGST (2.5% on Food+NAB)" value={formatINRDecimal(amounts.sgst)} />
              <div className="text-[10px] text-muted-foreground italic">GST applies to food & non-alcoholic beverages only. Alcohol is GST exempt.</div>
              {amounts.roundOff !== 0 && (
                <BillRow label="Round Off" value={formatINRDecimal(amounts.roundOff)} />
              )}
              <div className="border-t border-border pt-2.5">
                <div className="flex justify-between items-center">
                  <span className="font-bold text-foreground">Total</span>
                  <span className="font-bold text-primary text-xl">{formatINR(amounts.total)}</span>
                </div>
              </div>
            </div>
          </div>

          <div className="bg-card rounded-2xl border border-border overflow-hidden">
            <div className="px-4 py-3 border-b border-border flex items-center gap-2">
              <Split size={14} className="text-muted-foreground" />
              <span className="text-sm font-semibold">Split Bill</span>
            </div>
            <div className="px-4 py-3 space-y-3">
              <div className="flex gap-2">
                {(["none", "equal"] as SplitMode[]).map((m) => (
                  <button
                    key={m}
                    onClick={() => setSplitMode(m)}
                    className={cn(
                      "px-3 py-1.5 rounded-lg text-xs font-medium border capitalize transition-colors",
                      splitMode === m
                        ? "bg-primary text-primary-foreground border-primary"
                        : "border-border text-muted-foreground"
                    )}
                  >
                    {m === "none" ? "No Split" : "Split Equally"}
                  </button>
                ))}
              </div>
              {splitMode !== "none" && (
                <div>
                  <div className="flex items-center gap-3 mb-2">
                    <button onClick={() => setSplitCovers(Math.max(2, splitCovers - 1))} className="w-8 h-8 rounded-lg bg-secondary border border-border flex items-center justify-center">
                      <Minus size={12} />
                    </button>
                    <span className="font-semibold">{splitCovers} ways</span>
                    <button onClick={() => setSplitCovers(Math.min(20, splitCovers + 1))} className="w-8 h-8 rounded-lg bg-secondary border border-border flex items-center justify-center">
                      <Plus size={12} />
                    </button>
                  </div>
                  <div className="bg-secondary rounded-xl p-3 text-center">
                    <div className="text-xs text-muted-foreground mb-1">Per Person</div>
                    <div className="text-2xl font-bold text-primary">{formatINR(perCover)}</div>
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="bg-card rounded-2xl border border-border overflow-hidden">
            <div className="px-4 py-3 border-b border-border">
              <span className="text-sm font-semibold">Payment Mode</span>
            </div>
            <div className="px-4 py-3 grid grid-cols-2 sm:grid-cols-3 gap-2">
              {[
                { method: "cash" as PaymentMethod, label: "Cash", icon: Banknote },
                { method: "card" as PaymentMethod, label: "Card", icon: CreditCard },
                { method: "upi" as PaymentMethod, label: "UPI", icon: Smartphone },
                { method: "cover_wallet" as PaymentMethod, label: "HOD Wallet", icon: Wallet },
              ].map(({ method, label, icon: Icon }) => (
                <button
                  key={method}
                  onClick={() => setPaymentMethod(method)}
                  className={cn(
                    "flex flex-col items-center gap-2 py-3 px-2 rounded-xl border text-xs font-medium transition-all",
                    paymentMethod === method
                      ? "border-primary bg-primary/10 text-primary gold-glow"
                      : "border-border text-muted-foreground hover:border-primary/30"
                  )}
                >
                  <Icon size={20} />
                  {label}
                </button>
              ))}
              <button
                onClick={() => setShowCompModal(true)}
                className={cn(
                  "flex flex-col items-center gap-2 py-3 px-2 rounded-xl border text-xs font-medium transition-all",
                  paymentMethod === "complimentary"
                    ? "border-primary bg-primary/10 text-primary gold-glow"
                    : "border-border text-muted-foreground hover:border-primary/30"
                )}
              >
                <Gift size={20} />
                Comp
              </button>
            </div>
          </div>

          <div className="bg-card rounded-2xl border border-border overflow-hidden">
            <div className="px-4 py-3">
              <label className="text-xs text-muted-foreground uppercase tracking-wide block mb-2">Captain Note (optional)</label>
              <input
                value={captainNote}
                onChange={(e) => setCaptainNote(e.target.value)}
                placeholder="Add any note..."
                className="w-full bg-secondary border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-primary"
              />
            </div>
          </div>

          <button
            onClick={handleSettleBill}
            disabled={paying || activeItems.length === 0}
            className={cn(
              "w-full py-4 rounded-2xl font-bold text-lg transition-all",
              !paying && activeItems.length > 0
                ? "bg-primary text-primary-foreground gold-glow hover:opacity-90 active:scale-[0.98]"
                : "bg-primary/30 text-primary-foreground/50 cursor-not-allowed"
            )}
          >
            {paying ? "Processing..." : `Collect ${formatINR(amounts.total)}`}
          </button>
          <div className="h-4" />
        </div>
      </div>

      {managerPinModal && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-card rounded-2xl border border-border p-6 w-full max-w-sm">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <Lock size={18} className="text-primary" />
                <h3 className="font-serif text-lg">Manager Approval</h3>
              </div>
              <button onClick={() => managerPinModal?.onCancel()}>
                <X size={18} className="text-muted-foreground" />
              </button>
            </div>
            <div className="flex items-start gap-2 mb-4 p-3 bg-yellow-500/10 border border-yellow-500/30 rounded-lg">
              <AlertTriangle size={14} className="text-yellow-400 shrink-0 mt-0.5" />
              <p className="text-xs text-muted-foreground">{managerPinModal.reason}</p>
            </div>
            <div>
              <label className="text-xs text-muted-foreground uppercase tracking-wide mb-1.5 block">Manager PIN</label>
              <input
                type="password"
                maxLength={4}
                value={managerPinInput}
                onChange={(e) => { setManagerPinInput(e.target.value.slice(0, 4)); setManagerPinError(""); }}
                placeholder="••••"
                className="w-full bg-secondary border border-border rounded-lg px-3 py-3 text-center text-2xl tracking-[0.5em] font-mono focus:outline-none focus:border-primary"
                autoFocus
                onKeyDown={(e) => e.key === "Enter" && managerPinInput.length === 4 && handleManagerPinSubmit()}
              />
              {managerPinError && (
                <p className="text-xs text-destructive mt-1.5">{managerPinError}</p>
              )}
            </div>
            <button
              onClick={handleManagerPinSubmit}
              disabled={managerPinInput.length !== 4}
              className="w-full mt-4 py-2.5 rounded-xl bg-primary text-primary-foreground font-semibold text-sm disabled:opacity-50"
            >
              Verify
            </button>
          </div>
        </div>
      )}

      {showCompModal && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-card rounded-2xl border border-border p-6 w-full max-w-sm">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-serif text-lg">Complimentary Bill</h3>
              <button onClick={() => setShowCompModal(false)}>
                <X size={18} className="text-muted-foreground" />
              </button>
            </div>
            <p className="text-xs text-muted-foreground mb-3">
              Amount: <span className="text-primary font-semibold">{formatINR(amounts.total)}</span>.
              Comp limit: ₹{COMP_MAX_PER_NIGHT}/night, {COMP_LIMIT_PER_CAPTAIN} per captain.
            </p>
            <div>
              <label className="text-xs text-muted-foreground uppercase tracking-wide mb-1.5 block">Reason *</label>
              <textarea
                value={compReason}
                onChange={(e) => setCompReason(e.target.value)}
                placeholder="Owner's guest, birthday, complaint resolution..."
                className="w-full bg-secondary border border-border rounded-lg p-3 text-sm min-h-[60px] focus:outline-none focus:border-primary resize-none"
                autoFocus
              />
            </div>
            <button
              onClick={handleComplimentary}
              disabled={!compReason.trim()}
              className="w-full mt-4 py-2.5 rounded-xl bg-primary text-primary-foreground font-semibold text-sm disabled:opacity-50"
            >
              Apply Complimentary
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function BillRow({ label, value, valueClass = "" }: { label: string; value: string; valueClass?: string }) {
  return (
    <div className="flex justify-between items-center text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className={cn("font-medium", valueClass || "text-foreground")}>{value}</span>
    </div>
  );
}
