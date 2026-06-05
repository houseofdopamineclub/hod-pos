import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import {
  ArrowLeft,
  Banknote,
  CreditCard,
  Smartphone,
  Wallet,
  Gift,
  Clock,
  TrendingUp,
  Users,
  Receipt,
  AlertTriangle,
  CheckCircle2,
  Lock,
  Unlock,
  Printer,
  History,
} from "lucide-react";
import {
  subscribeToCurrentShift,
  subscribeToShiftBills,
  openShift,
  closeShift,
  getRecentShifts,
} from "@/lib/firestore";
import { formatINR, formatINRDecimal, formatTime, formatDate, getDuration } from "@/lib/utils-pos";
import type { POSBill, POSShift, PaymentMethod, ShiftCashDenomination } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Timestamp } from "firebase/firestore";
import { useToast } from "@/hooks/use-toast";

interface LiveStats {
  breakdown: Record<PaymentMethod, number>;
  totalRevenue: number;
  totalCovers: number;
  totalBills: number;
  avgTicket: number;
  discountTotal: number;
  expectedCash: number;
}

const DENOMS: { key: keyof ShiftCashDenomination; value: number; label: string }[] = [
  { key: "d2000", value: 2000, label: "₹2000" },
  { key: "d500", value: 500, label: "₹500" },
  { key: "d200", value: 200, label: "₹200" },
  { key: "d100", value: 100, label: "₹100" },
  { key: "d50", value: 50, label: "₹50" },
  { key: "d20", value: 20, label: "₹20" },
  { key: "d10", value: 10, label: "₹10" },
];

export default function ShiftView() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [shift, setShift] = useState<POSShift | null>(null);
  const [bills, setBills] = useState<POSBill[]>([]);
  const [permissionError, setPermissionError] = useState<string | null>(null);
  const [recentShifts, setRecentShifts] = useState<POSShift[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [now, setNow] = useState(new Date());

  useEffect(() => {
    const unsub = subscribeToCurrentShift((s, err) => {
      setShift(s);
      if (err) {
        setPermissionError(
          err.message.includes("permission")
            ? "Your Firestore rules don't yet allow access to the posShifts collection. Add the rule shown below in your Firebase console, then refresh this page."
            : err.message
        );
      } else {
        setPermissionError(null);
      }
    });
    return () => unsub();
  }, []);

  useEffect(() => {
    if (!shift?.id) {
      setBills([]);
      return;
    }
    const unsub = subscribeToShiftBills(shift.id, setBills);
    return () => unsub();
  }, [shift?.id]);

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (showHistory) {
      getRecentShifts(20).then(setRecentShifts).catch(() => {});
    }
  }, [showHistory]);

  const live: LiveStats = useMemo(() => {
    const breakdown: Record<PaymentMethod, number> = {
      cash: 0, card: 0, upi: 0, cover_wallet: 0, complimentary: 0,
    };
    let totalRevenue = 0;
    let totalCovers = 0;
    let discountTotal = 0;
    for (const b of bills) {
      totalRevenue += b.total || 0;
      totalCovers += b.partySize || 0;
      discountTotal += b.discount || 0;
      for (const p of b.payments || []) {
        breakdown[p.method] = (breakdown[p.method] || 0) + (p.amount || 0);
      }
    }
    const expectedCash = (shift?.openingCash || 0) + breakdown.cash;
    return {
      breakdown,
      totalRevenue,
      totalCovers,
      totalBills: bills.length,
      avgTicket: bills.length ? Math.round(totalRevenue / bills.length) : 0,
      discountTotal,
      expectedCash,
    };
  }, [bills, shift?.openingCash]);

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <header className="border-b border-border bg-card px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            onClick={() => setLocation("/")}
            className="p-2 hover:bg-secondary rounded-lg transition-colors"
          >
            <ArrowLeft size={18} />
          </button>
          <div>
            <h1 className="font-serif text-xl text-primary">Shift Management</h1>
            <p className="text-xs text-muted-foreground uppercase tracking-widest">
              {shift ? "Active Shift" : "No Open Shift"}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowHistory((v) => !v)}
            className="p-2 rounded-lg border border-border hover:border-primary/50 transition-colors flex items-center gap-2 text-sm"
          >
            <History size={16} className="text-muted-foreground" />
            <span className="hidden sm:inline text-muted-foreground">History</span>
          </button>
          <div className="text-right text-xs text-muted-foreground hidden sm:block">
            <div className="font-medium text-foreground">{formatTime(now)}</div>
            <div>{formatDate(now)}</div>
          </div>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto p-6">
        {permissionError && (
          <div className="max-w-3xl mx-auto mb-6 bg-yellow-500/10 border border-yellow-500/30 rounded-xl p-4">
            <div className="flex items-start gap-3">
              <AlertTriangle className="text-yellow-400 flex-shrink-0 mt-0.5" size={18} />
              <div className="flex-1 text-sm">
                <div className="font-semibold text-yellow-400 mb-1">Firestore rules need updating</div>
                <div className="text-muted-foreground mb-3">{permissionError}</div>
                <div className="bg-secondary/50 border border-border rounded p-3 font-mono text-xs text-foreground overflow-x-auto whitespace-pre">{`match /posShifts/{id} {
  allow read, write: if true;
}`}</div>
                <div className="text-xs text-muted-foreground mt-2">
                  Add this to <span className="text-foreground">firestore.rules</span> in your Firebase console (Firestore → Rules), inside the existing <span className="text-foreground">match /databases/.../documents</span> block.
                </div>
              </div>
            </div>
          </div>
        )}
        {showHistory ? (
          <ShiftHistory shifts={recentShifts} onClose={() => setShowHistory(false)} />
        ) : shift ? (
          <ActiveShiftView
            shift={shift}
            bills={bills}
            live={live}
            onClosed={() => {
              toast({ title: "Shift closed", description: "Reconciliation report generated." });
            }}
          />
        ) : (
          <OpenShiftForm
            onOpened={() => {
              toast({ title: "Shift opened", description: "Cashier shift is now live." });
            }}
          />
        )}
      </div>
    </div>
  );
}

function OpenShiftForm({ onOpened }: { onOpened: () => void }) {
  const { toast } = useToast();
  const [shiftType, setShiftType] = useState<POSShift["shiftType"]>("evening");
  const [cashierName, setCashierName] = useState("");
  const [managerName, setManagerName] = useState("");
  const [openingCash, setOpeningCash] = useState<string>("5000");
  const [openingNote, setOpeningNote] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function handleOpen() {
    if (!cashierName.trim()) {
      toast({ title: "Cashier name required", variant: "destructive" });
      return;
    }
    const cash = Number(openingCash);
    if (!Number.isFinite(cash) || cash < 0) {
      toast({ title: "Invalid opening cash", variant: "destructive" });
      return;
    }
    setSubmitting(true);
    try {
      await openShift({
        shiftType,
        cashierName: cashierName.trim(),
        managerName: managerName.trim() || undefined,
        openingCash: cash,
        openingNote: openingNote.trim() || undefined,
      });
      onOpened();
    } catch (e) {
      toast({
        title: "Could not open shift",
        description: e instanceof Error ? e.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="max-w-2xl mx-auto">
      <div className="text-center mb-8">
        <Unlock className="mx-auto mb-3 text-primary" size={36} />
        <h2 className="font-serif text-2xl text-foreground mb-1">Open New Shift</h2>
        <p className="text-sm text-muted-foreground">Enter starting cash and cashier details</p>
      </div>

      <div className="bg-card border border-border rounded-xl p-6 space-y-5">
        <div>
          <label className="text-xs uppercase tracking-widest text-muted-foreground mb-2 block">Shift Type</label>
          <div className="grid grid-cols-3 gap-2">
            {(["morning", "evening", "night"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setShiftType(t)}
                className={cn(
                  "py-3 px-3 rounded-lg border text-sm font-medium capitalize transition-all",
                  shiftType === t
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border text-muted-foreground hover:border-primary/40"
                )}
              >
                {t}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="text-xs uppercase tracking-widest text-muted-foreground mb-2 block">Cashier Name *</label>
            <input
              type="text"
              value={cashierName}
              onChange={(e) => setCashierName(e.target.value)}
              placeholder="e.g. Rohan"
              className="w-full bg-secondary border border-border rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:border-primary"
            />
          </div>
          <div>
            <label className="text-xs uppercase tracking-widest text-muted-foreground mb-2 block">Manager</label>
            <input
              type="text"
              value={managerName}
              onChange={(e) => setManagerName(e.target.value)}
              placeholder="Optional"
              className="w-full bg-secondary border border-border rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:border-primary"
            />
          </div>
        </div>

        <div>
          <label className="text-xs uppercase tracking-widest text-muted-foreground mb-2 block">Opening Cash (₹)</label>
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">₹</span>
            <input
              type="number"
              value={openingCash}
              onChange={(e) => setOpeningCash(e.target.value)}
              className="w-full bg-secondary border border-border rounded-lg pl-8 pr-3 py-2.5 text-lg font-semibold text-primary focus:outline-none focus:border-primary"
            />
          </div>
          <p className="text-xs text-muted-foreground mt-1.5">Cash float in the drawer at start of shift</p>
        </div>

        <div>
          <label className="text-xs uppercase tracking-widest text-muted-foreground mb-2 block">Note</label>
          <textarea
            value={openingNote}
            onChange={(e) => setOpeningNote(e.target.value)}
            placeholder="Any handover notes from previous shift..."
            rows={2}
            className="w-full bg-secondary border border-border rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:border-primary resize-none"
          />
        </div>

        <button
          onClick={handleOpen}
          disabled={submitting}
          className="w-full bg-primary text-primary-foreground font-semibold py-3 rounded-lg hover:bg-primary/90 disabled:opacity-50 transition-colors flex items-center justify-center gap-2"
        >
          <Unlock size={16} />
          {submitting ? "Opening Shift…" : "Open Shift"}
        </button>
      </div>
    </div>
  );
}

function ActiveShiftView({
  shift,
  bills,
  live,
  onClosed,
}: {
  shift: POSShift;
  bills: POSBill[];
  live: LiveStats;
  onClosed: () => void;
}) {
  const [showCloseForm, setShowCloseForm] = useState(false);
  const [reportShift, setReportShift] = useState<POSShift | null>(null);
  const [reportBills, setReportBills] = useState<POSBill[]>([]);

  const openedDate = shift.openedAt?.toDate?.();

  if (reportShift) {
    return <ShiftReport shift={reportShift} bills={reportBills} onBack={onClosed} />;
  }

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <div className="bg-card border border-border rounded-xl p-5 flex items-start justify-between flex-wrap gap-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xs uppercase tracking-widest text-primary font-semibold">{shift.shiftType} Shift</span>
            <span className="px-2 py-0.5 rounded-full bg-green-500/10 text-green-400 text-[10px] uppercase tracking-widest font-semibold">Live</span>
          </div>
          <div className="text-xl font-semibold">{shift.cashierName}</div>
          {shift.managerName && (
            <div className="text-xs text-muted-foreground">Manager: {shift.managerName}</div>
          )}
          {openedDate && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground mt-2">
              <Clock size={12} />
              Opened {formatTime(openedDate)} · Running {getDuration(openedDate)}
            </div>
          )}
        </div>
        <button
          onClick={() => setShowCloseForm(true)}
          className="bg-destructive text-destructive-foreground font-semibold px-5 py-2.5 rounded-lg hover:bg-destructive/90 transition-colors flex items-center gap-2"
        >
          <Lock size={16} />
          Close Shift
        </button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatTile icon={<TrendingUp size={16} />} label="Revenue" value={formatINR(live.totalRevenue)} accent="primary" />
        <StatTile icon={<Receipt size={16} />} label="Bills" value={String(live.totalBills)} accent="blue" />
        <StatTile icon={<Users size={16} />} label="Covers" value={String(live.totalCovers)} accent="purple" />
        <StatTile icon={<TrendingUp size={16} />} label="Avg Ticket" value={formatINR(live.avgTicket)} accent="green" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-card border border-border rounded-xl p-5">
          <h3 className="font-serif text-lg mb-4 flex items-center gap-2">
            <Banknote className="text-primary" size={18} />
            Cash Drawer
          </h3>
          <div className="space-y-3 text-sm">
            <Row label="Opening Cash" value={formatINR(shift.openingCash)} />
            <Row label="Cash Sales" value={`+ ${formatINR(live.breakdown.cash)}`} valueClass="text-green-400" />
            <div className="h-px bg-border my-2" />
            <Row label="Expected in Drawer" value={formatINR(live.expectedCash)} bold />
          </div>
          <p className="text-[11px] text-muted-foreground mt-3">
            This is the cash you should have in the drawer right now.
          </p>
        </div>

        <div className="bg-card border border-border rounded-xl p-5">
          <h3 className="font-serif text-lg mb-4 flex items-center gap-2">
            <CreditCard className="text-primary" size={18} />
            Payment Breakdown
          </h3>
          <div className="space-y-3 text-sm">
            <PaymentRow icon={<Banknote size={14} />} label="Cash" amount={live.breakdown.cash} />
            <PaymentRow icon={<CreditCard size={14} />} label="Card" amount={live.breakdown.card} />
            <PaymentRow icon={<Smartphone size={14} />} label="UPI" amount={live.breakdown.upi} />
            <PaymentRow icon={<Wallet size={14} />} label="HOD Wallet" amount={live.breakdown.cover_wallet} />
            <PaymentRow icon={<Gift size={14} />} label="Complimentary" amount={live.breakdown.complimentary} />
            <div className="h-px bg-border my-2" />
            <Row label="Total Collected" value={formatINR(live.totalRevenue)} bold />
          </div>
        </div>
      </div>

      <div className="bg-card border border-border rounded-xl p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-serif text-lg flex items-center gap-2">
            <Receipt className="text-primary" size={18} />
            Bills This Shift ({bills.length})
          </h3>
          {live.discountTotal > 0 && (
            <div className="text-xs text-muted-foreground">
              Discounts: <span className="text-yellow-500 font-semibold">{formatINR(live.discountTotal)}</span>
            </div>
          )}
        </div>
        {bills.length === 0 ? (
          <div className="text-center text-muted-foreground py-8 text-sm">No bills settled yet this shift</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs uppercase tracking-widest text-muted-foreground border-b border-border">
                  <th className="text-left py-2 font-medium">Bill #</th>
                  <th className="text-left py-2 font-medium">Table</th>
                  <th className="text-left py-2 font-medium">Time</th>
                  <th className="text-left py-2 font-medium">Payment</th>
                  <th className="text-right py-2 font-medium">Total</th>
                </tr>
              </thead>
              <tbody>
                {bills.slice().reverse().map((b) => (
                  <tr key={b.id} className="border-b border-border/50">
                    <td className="py-2.5 font-mono text-xs">{b.billNumber || "—"}</td>
                    <td className="py-2.5">{b.tableName}</td>
                    <td className="py-2.5 text-muted-foreground text-xs">
                      {b.paidAt ? formatTime(b.paidAt.toDate()) : "—"}
                    </td>
                    <td className="py-2.5 text-xs">
                      {(b.payments || []).map((p) => p.method).join(", ")}
                    </td>
                    <td className="py-2.5 text-right font-semibold text-primary">{formatINR(b.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {showCloseForm && (
        <CloseShiftDialog
          shift={shift}
          live={live}
          onCancel={() => setShowCloseForm(false)}
          onClosed={(closedShift, closedBills) => {
            setShowCloseForm(false);
            setReportShift(closedShift);
            setReportBills(closedBills);
            onClosed();
          }}
        />
      )}
    </div>
  );
}

function CloseShiftDialog({
  shift,
  live,
  onCancel,
  onClosed,
}: {
  shift: POSShift;
  live: LiveStats;
  onCancel: () => void;
  onClosed: (s: POSShift, b: POSBill[]) => void;
}) {
  const { toast } = useToast();
  const [denoms, setDenoms] = useState<ShiftCashDenomination>({});
  const [manualCash, setManualCash] = useState<string>("");
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [useDenoms, setUseDenoms] = useState(true);

  const denomTotal = useMemo(
    () => DENOMS.reduce((s, d) => s + (denoms[d.key] || 0) * d.value, 0),
    [denoms]
  );

  const counted = useDenoms ? denomTotal : Number(manualCash) || 0;
  const variance = counted - live.expectedCash;
  const ok = Math.abs(variance) < 1;

  async function handleClose() {
    if (!shift.id) return;
    setSubmitting(true);
    try {
      const result = await closeShift(shift.id, {
        closingCashCounted: counted,
        closingDenominations: useDenoms ? denoms : undefined,
        closingNote: note.trim() || undefined,
      });
      onClosed(result.shift, result.bills);
    } catch (e) {
      toast({
        title: "Could not close shift",
        description: e instanceof Error ? e.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-card border border-border rounded-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto">
        <div className="p-6 border-b border-border flex items-center justify-between sticky top-0 bg-card">
          <h2 className="font-serif text-xl text-primary">Close Shift — Cash Reconciliation</h2>
          <button onClick={onCancel} className="text-muted-foreground hover:text-foreground">
            ✕
          </button>
        </div>

        <div className="p-6 space-y-5">
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div className="bg-secondary/50 rounded-lg p-3">
              <div className="text-xs text-muted-foreground uppercase tracking-widest">Opening</div>
              <div className="text-lg font-semibold">{formatINR(shift.openingCash)}</div>
            </div>
            <div className="bg-secondary/50 rounded-lg p-3">
              <div className="text-xs text-muted-foreground uppercase tracking-widest">Cash Sales</div>
              <div className="text-lg font-semibold text-green-400">+ {formatINR(live.breakdown.cash)}</div>
            </div>
          </div>

          <div className="bg-primary/5 border border-primary/20 rounded-lg p-4">
            <div className="text-xs uppercase tracking-widest text-primary mb-1">Expected in Drawer</div>
            <div className="text-3xl font-bold text-primary">{formatINR(live.expectedCash)}</div>
          </div>

          <div className="flex gap-2 text-xs">
            <button
              onClick={() => setUseDenoms(true)}
              className={cn(
                "px-3 py-1.5 rounded border",
                useDenoms ? "border-primary text-primary" : "border-border text-muted-foreground"
              )}
            >
              Count by denomination
            </button>
            <button
              onClick={() => setUseDenoms(false)}
              className={cn(
                "px-3 py-1.5 rounded border",
                !useDenoms ? "border-primary text-primary" : "border-border text-muted-foreground"
              )}
            >
              Enter total
            </button>
          </div>

          {useDenoms ? (
            <div className="space-y-2">
              {DENOMS.map((d) => (
                <div key={d.key} className="flex items-center gap-3">
                  <div className="w-16 text-sm font-medium">{d.label}</div>
                  <span className="text-muted-foreground">×</span>
                  <input
                    type="number"
                    min={0}
                    value={denoms[d.key] ?? ""}
                    onChange={(e) =>
                      setDenoms((prev) => ({
                        ...prev,
                        [d.key]: e.target.value === "" ? undefined : Math.max(0, parseInt(e.target.value, 10)),
                      }))
                    }
                    placeholder="0"
                    className="w-20 bg-secondary border border-border rounded px-2 py-1.5 text-sm focus:outline-none focus:border-primary"
                  />
                  <span className="text-muted-foreground">=</span>
                  <span className="text-sm font-medium">{formatINR((denoms[d.key] || 0) * d.value)}</span>
                </div>
              ))}
              <div className="flex items-center justify-between border-t border-border pt-3 mt-3">
                <span className="text-sm uppercase tracking-widest text-muted-foreground">Counted Total</span>
                <span className="text-xl font-bold text-foreground">{formatINR(denomTotal)}</span>
              </div>
            </div>
          ) : (
            <div>
              <label className="text-xs uppercase tracking-widest text-muted-foreground mb-2 block">Counted Cash (₹)</label>
              <input
                type="number"
                value={manualCash}
                onChange={(e) => setManualCash(e.target.value)}
                placeholder="0"
                className="w-full bg-secondary border border-border rounded-lg px-3 py-3 text-xl font-semibold focus:outline-none focus:border-primary"
              />
            </div>
          )}

          <div
            className={cn(
              "rounded-lg p-4 border",
              ok ? "bg-green-500/10 border-green-500/30" : variance < 0 ? "bg-red-500/10 border-red-500/30" : "bg-yellow-500/10 border-yellow-500/30"
            )}
          >
            <div className="flex items-center gap-2 mb-1">
              {ok ? (
                <CheckCircle2 size={16} className="text-green-400" />
              ) : (
                <AlertTriangle size={16} className={variance < 0 ? "text-red-400" : "text-yellow-400"} />
              )}
              <span className="text-xs uppercase tracking-widest font-semibold">
                {ok ? "Tally Match" : variance < 0 ? "Cash Short" : "Cash Excess"}
              </span>
            </div>
            <div className={cn("text-2xl font-bold", ok ? "text-green-400" : variance < 0 ? "text-red-400" : "text-yellow-400")}>
              {variance > 0 ? "+" : ""}{formatINR(Math.abs(variance) < 0.5 ? 0 : variance)}
            </div>
          </div>

          <div>
            <label className="text-xs uppercase tracking-widest text-muted-foreground mb-2 block">Closing Note</label>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Variance reason, handover note, etc."
              rows={2}
              className="w-full bg-secondary border border-border rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:border-primary resize-none"
            />
          </div>

          <div className="flex gap-3">
            <button
              onClick={onCancel}
              className="flex-1 border border-border py-3 rounded-lg text-muted-foreground hover:text-foreground hover:border-foreground/30 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleClose}
              disabled={submitting}
              className="flex-1 bg-destructive text-destructive-foreground font-semibold py-3 rounded-lg hover:bg-destructive/90 disabled:opacity-50 transition-colors flex items-center justify-center gap-2"
            >
              <Lock size={16} />
              {submitting ? "Closing…" : "Close Shift"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ShiftReport({
  shift,
  bills,
  onBack,
}: {
  shift: POSShift;
  bills: POSBill[];
  onBack: () => void;
}) {
  const opened = shift.openedAt?.toDate?.();
  const closed = shift.closedAt?.toDate?.();
  const variance = shift.cashVariance ?? 0;
  const ok = Math.abs(variance) < 1;

  return (
    <div className="max-w-3xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h2 className="font-serif text-2xl">Shift Closed</h2>
        <div className="flex gap-2">
          <button
            onClick={() => window.print()}
            className="border border-border px-4 py-2 rounded-lg hover:border-primary/50 flex items-center gap-2 text-sm"
          >
            <Printer size={14} />
            Print
          </button>
          <button
            onClick={onBack}
            className="bg-primary text-primary-foreground px-4 py-2 rounded-lg font-medium text-sm"
          >
            Done
          </button>
        </div>
      </div>

      <div className="bg-card border border-border rounded-xl overflow-hidden">
        <div className="p-6 text-center border-b border-border bg-gradient-to-b from-primary/5 to-transparent">
          <div className="font-serif text-3xl text-primary mb-1">HOD</div>
          <div className="text-xs uppercase tracking-widest text-muted-foreground">House of Dopamine — Shift Report</div>
        </div>

        <div className="p-6 grid grid-cols-2 gap-4 text-sm border-b border-border">
          <div>
            <div className="text-xs text-muted-foreground uppercase tracking-widest">Cashier</div>
            <div className="font-semibold">{shift.cashierName}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground uppercase tracking-widest">Shift</div>
            <div className="font-semibold capitalize">{shift.shiftType}</div>
          </div>
          {opened && (
            <div>
              <div className="text-xs text-muted-foreground uppercase tracking-widest">Opened</div>
              <div>{formatDate(opened)} {formatTime(opened)}</div>
            </div>
          )}
          {closed && (
            <div>
              <div className="text-xs text-muted-foreground uppercase tracking-widest">Closed</div>
              <div>{formatDate(closed)} {formatTime(closed)}</div>
            </div>
          )}
        </div>

        <div className="p-6 border-b border-border">
          <h3 className="font-serif text-lg mb-3">Sales Summary</h3>
          <Row label="Total Bills" value={String(shift.totalBills ?? bills.length)} />
          <Row label="Total Covers" value={String(shift.totalCovers ?? 0)} />
          <Row label="Total Revenue" value={formatINR(shift.totalRevenue ?? 0)} bold />
          {shift.discountTotal ? <Row label="Discounts Given" value={formatINR(shift.discountTotal)} valueClass="text-yellow-500" /> : null}
        </div>

        <div className="p-6 border-b border-border">
          <h3 className="font-serif text-lg mb-3">Payment Breakdown</h3>
          {shift.paymentBreakdown && (
            <>
              <PaymentRow icon={<Banknote size={14} />} label="Cash" amount={shift.paymentBreakdown.cash} />
              <PaymentRow icon={<CreditCard size={14} />} label="Card" amount={shift.paymentBreakdown.card} />
              <PaymentRow icon={<Smartphone size={14} />} label="UPI" amount={shift.paymentBreakdown.upi} />
              <PaymentRow icon={<Wallet size={14} />} label="HOD Wallet" amount={shift.paymentBreakdown.cover_wallet} />
              <PaymentRow icon={<Gift size={14} />} label="Complimentary" amount={shift.paymentBreakdown.complimentary} />
            </>
          )}
        </div>

        <div className="p-6">
          <h3 className="font-serif text-lg mb-3">Cash Reconciliation</h3>
          <Row label="Opening Cash" value={formatINR(shift.openingCash)} />
          <Row label="Cash Sales" value={`+ ${formatINR(shift.paymentBreakdown?.cash || 0)}`} />
          <Row label="Expected in Drawer" value={formatINR(shift.expectedCash ?? 0)} bold />
          <Row label="Counted Cash" value={formatINR(shift.closingCashCounted ?? 0)} bold />
          <div className={cn(
            "mt-4 p-4 rounded-lg border flex items-center justify-between",
            ok ? "bg-green-500/10 border-green-500/30 text-green-400" : variance < 0 ? "bg-red-500/10 border-red-500/30 text-red-400" : "bg-yellow-500/10 border-yellow-500/30 text-yellow-400"
          )}>
            <div className="flex items-center gap-2">
              {ok ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />}
              <span className="text-sm uppercase tracking-widest font-semibold">
                {ok ? "Tally" : variance < 0 ? "Short" : "Excess"}
              </span>
            </div>
            <div className="text-xl font-bold">
              {variance > 0 ? "+" : ""}{formatINRDecimal(Math.abs(variance) < 0.5 ? 0 : variance)}
            </div>
          </div>

          {shift.closingNote && (
            <div className="mt-4 text-sm">
              <div className="text-xs text-muted-foreground uppercase tracking-widest mb-1">Note</div>
              <div className="bg-secondary/50 rounded p-3 text-foreground">{shift.closingNote}</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ShiftHistory({ shifts, onClose }: { shifts: POSShift[]; onClose: () => void }) {
  return (
    <div className="max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-4">
        <h2 className="font-serif text-2xl">Recent Shifts</h2>
        <button
          onClick={onClose}
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          Back
        </button>
      </div>

      {shifts.length === 0 ? (
        <div className="text-center text-muted-foreground py-12 text-sm">No closed shifts yet</div>
      ) : (
        <div className="bg-card border border-border rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs uppercase tracking-widest text-muted-foreground border-b border-border bg-secondary/30">
                <th className="text-left px-4 py-3 font-medium">Date</th>
                <th className="text-left px-4 py-3 font-medium">Shift</th>
                <th className="text-left px-4 py-3 font-medium">Cashier</th>
                <th className="text-right px-4 py-3 font-medium">Revenue</th>
                <th className="text-right px-4 py-3 font-medium">Bills</th>
                <th className="text-right px-4 py-3 font-medium">Variance</th>
              </tr>
            </thead>
            <tbody>
              {shifts.map((s) => {
                const v = s.cashVariance ?? 0;
                const closedAt = s.closedAt instanceof Timestamp ? s.closedAt.toDate() : null;
                return (
                  <tr key={s.id} className="border-b border-border/50 hover:bg-secondary/20">
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      {closedAt ? formatDate(closedAt) : "—"}
                    </td>
                    <td className="px-4 py-3 capitalize">{s.shiftType}</td>
                    <td className="px-4 py-3">{s.cashierName}</td>
                    <td className="px-4 py-3 text-right font-semibold text-primary">{formatINR(s.totalRevenue ?? 0)}</td>
                    <td className="px-4 py-3 text-right">{s.totalBills ?? 0}</td>
                    <td
                      className={cn(
                        "px-4 py-3 text-right font-semibold",
                        Math.abs(v) < 1 ? "text-green-400" : v < 0 ? "text-red-400" : "text-yellow-400"
                      )}
                    >
                      {v > 0 ? "+" : ""}{formatINR(Math.abs(v) < 0.5 ? 0 : v)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function StatTile({
  icon,
  label,
  value,
  accent,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  accent: "primary" | "blue" | "purple" | "green";
}) {
  const colors = {
    primary: "text-primary",
    blue: "text-blue-400",
    purple: "text-purple-400",
    green: "text-green-400",
  };
  return (
    <div className="bg-card border border-border rounded-xl p-4">
      <div className="flex items-center justify-between mb-2 text-muted-foreground text-xs uppercase tracking-widest">
        <span>{label}</span>
        <span className={colors[accent]}>{icon}</span>
      </div>
      <div className={cn("text-2xl font-bold", colors[accent])}>{value}</div>
    </div>
  );
}

function Row({
  label,
  value,
  bold = false,
  valueClass,
}: {
  label: string;
  value: string;
  bold?: boolean;
  valueClass?: string;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className={cn("text-muted-foreground", bold && "text-foreground font-medium")}>{label}</span>
      <span className={cn(bold ? "font-bold text-foreground" : "", valueClass)}>{value}</span>
    </div>
  );
}

function PaymentRow({ icon, label, amount }: { icon: React.ReactNode; label: string; amount: number }) {
  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-2 text-muted-foreground">
        <span className="text-primary/70">{icon}</span>
        {label}
      </div>
      <span className="font-medium">{formatINR(amount || 0)}</span>
    </div>
  );
}
