import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { useStaff } from "@/lib/staff-context";
import type { AggregatorSettings, AggregatorOrder, AggregatorName } from "@/lib/types";
import {
  subscribeToAggregatorSettings, subscribeToAggregatorOrders,
  addAggregatorOrder, logAudit,
} from "@/lib/firestore";
import {
  subscribeToUnparsedBookings, resolveUnparsedBooking, dismissUnparsedBooking,
  type HodUnparsedBooking,
} from "@/lib/firestore-hod";
import { formatINR } from "@/lib/utils-pos";

export default function AggregatorPage() {
  const { currentStaff } = useStaff();
  const [, navigate] = useLocation();
  const [settings, setSettings] = useState<AggregatorSettings[]>([]);
  const [orders, setOrders] = useState<AggregatorOrder[]>([]);
  const [selectedAgg, setSelectedAgg] = useState<AggregatorName>("zomato");
  const [form, setForm] = useState({
    bookingId: "",
    customerName: "",
    customerPhone: "",
    billAmount: 0,
    covers: 1,
    notes: "",
  });
  const [saving, setSaving] = useState(false);
  const [unparsed, setUnparsed] = useState<HodUnparsedBooking[]>([]);

  useEffect(() => {
    const unsubs = [
      subscribeToAggregatorSettings(setSettings),
      subscribeToAggregatorOrders(setOrders),
      subscribeToUnparsedBookings(setUnparsed),
    ];
    return () => unsubs.forEach(u => u());
  }, []);

  const currentSettings = settings.find(s => s.name === selectedAgg);
  const discountPercent = currentSettings?.currentDiscountTier || 0;
  const commissionPercent = currentSettings?.commissionPercent || 0;

  const discountAmount = Math.round(form.billAmount * discountPercent / 100);
  const afterDiscount = form.billAmount - discountAmount;
  const commissionAmount = Math.round(afterDiscount * commissionPercent / 100);
  const commissionGst = Math.round(commissionAmount * (currentSettings?.commissionGstPercent || 18) / 100);
  const netReceivable = afterDiscount - commissionAmount - commissionGst;

  const handleSubmit = async () => {
    if (!form.bookingId || !form.billAmount || !currentStaff) return;
    setSaving(true);
    try {
      await addAggregatorOrder({
        aggregator: selectedAgg,
        bookingId: form.bookingId,
        customerName: form.customerName,
        customerPhone: form.customerPhone,
        billAmount: form.billAmount,
        covers: form.covers,
        discountPercent,
        discountAmount,
        commissionAmount: commissionAmount + commissionGst,
        netReceivable,
        notes: form.notes,
        enteredBy: currentStaff.id || "",
        enteredByName: currentStaff.name,
      });
      await logAudit({
        action: "aggregator_order_added",
        staffId: currentStaff.id || "", staffName: currentStaff.name, staffRole: currentStaff.role,
        details: { aggregator: selectedAgg, bookingId: form.bookingId, billAmount: form.billAmount },
      });
      setForm({ bookingId: "", customerName: "", customerPhone: "", billAmount: 0, covers: 1, notes: "" });
    } finally {
      setSaving(false);
    }
  };

  const handleResolve = async (
    item: HodUnparsedBooking,
    edits: { customerName: string; phone: string; partySize: number; date: string; arrivalTime: string },
  ) => {
    if (!currentStaff) return;
    try {
      const ref = await resolveUnparsedBooking(item, edits, currentStaff.name);
      await logAudit({
        action: "unparsed_booking_resolved",
        staffId: currentStaff.id || "", staffName: currentStaff.name, staffRole: currentStaff.role,
        details: { unparsedId: item.id, source: item.source || "unknown", tableReservationId: ref },
      }).catch(() => {});
      alert(`✓ ADDED TO TABLES\n\nRef: ${ref}\n${edits.customerName} · ${edits.partySize} pax · ${edits.date} ${edits.arrivalTime}`);
    } catch (e: any) {
      alert(`Could not add booking: ${e?.message || e}`);
    }
  };

  const handleDismiss = async (item: HodUnparsedBooking) => {
    if (!currentStaff) return;
    if (!confirm(`Dismiss this? It will be removed from Needs Review (not added as a booking).`)) return;
    try {
      await dismissUnparsedBooking(item.id, currentStaff.name);
      await logAudit({
        action: "unparsed_booking_dismissed",
        staffId: currentStaff.id || "", staffName: currentStaff.name, staffRole: currentStaff.role,
        details: { unparsedId: item.id, source: item.source || "unknown" },
      }).catch(() => {});
    } catch (e: any) {
      alert(`Could not dismiss: ${e?.message || e}`);
    }
  };

  const aggLabels: Record<AggregatorName, string> = {
    zomato: "Zomato",
    "swiggy-dineout": "Swiggy Dineout",
    "swiggy-scenes": "Swiggy Scenes",
    eazydiner: "EazyDiner",
  };

  return (
    <div className="min-h-screen" style={{ background: "#030305", color: "hsl(36 29% 93%)" }}>
      <header className="flex items-center justify-between px-4 py-3" style={{ borderBottom: "1px solid hsl(240 8% 13%)" }}>
        <div className="flex items-center gap-4">
          <button onClick={() => navigate("/")} className="text-sm" style={{ color: "#C9A84C" }}>← Floor</button>
          <h1 className="text-lg font-semibold" style={{ color: "#C9A84C" }}>Aggregator Orders</h1>
        </div>
      </header>

      <div className="p-4 max-w-lg mx-auto">
        {unparsed.length > 0 && (
          <div className="mb-4 rounded-lg overflow-hidden" style={{ border: "1px solid #ef4444" }}>
            <div className="px-3 py-2 flex items-center justify-between" style={{ background: "rgba(239,68,68,0.14)" }}>
              <span className="text-sm font-bold" style={{ color: "#ef4444" }}>⚠️ NEEDS REVIEW ({unparsed.length})</span>
              <span className="text-[10px]" style={{ color: "hsl(36 29% 55%)" }}>AI couldn't fully read — check &amp; add</span>
            </div>
            <div className="p-2 space-y-2" style={{ background: "hsl(240 12% 5%)", maxHeight: "46vh", overflowY: "auto" }}>
              {unparsed.map((item) => (
                <UnparsedCard key={item.id} item={item} onResolve={handleResolve} onDismiss={handleDismiss} />
              ))}
            </div>
          </div>
        )}

        <div className="flex gap-2 mb-4">
          {(Object.keys(aggLabels) as AggregatorName[]).map((a) => (
            <button key={a} onClick={() => setSelectedAgg(a)}
              className="px-3 py-2 rounded-lg text-xs font-medium flex-1 transition-colors"
              style={{ background: selectedAgg === a ? "#C9A84C" : "hsl(240 12% 8%)", color: selectedAgg === a ? "#030305" : "hsl(36 29% 70%)" }}>
              {aggLabels[a]}
            </button>
          ))}
        </div>

        <div className="p-4 rounded-lg mb-4" style={{ background: "hsl(240 12% 5%)", border: "1px solid hsl(240 8% 18%)" }}>
          <h3 className="text-sm font-semibold mb-3" style={{ color: "#C9A84C" }}>New {aggLabels[selectedAgg]} Order</h3>
          <div className="space-y-3">
            <div className="flex gap-2">
              <input placeholder="Booking ID *" value={form.bookingId} onChange={(e) => setForm(f => ({...f, bookingId: e.target.value}))}
                className="px-3 py-2 rounded text-sm flex-1" style={{ background: "hsl(240 12% 8%)", border: "1px solid hsl(240 8% 18%)", color: "hsl(36 29% 93%)" }} />
              <input placeholder="Covers" type="number" value={form.covers} onChange={(e) => setForm(f => ({...f, covers: Number(e.target.value)}))}
                className="px-3 py-2 rounded text-sm w-20" style={{ background: "hsl(240 12% 8%)", border: "1px solid hsl(240 8% 18%)", color: "hsl(36 29% 93%)" }} />
            </div>
            <input placeholder="Customer Name" value={form.customerName} onChange={(e) => setForm(f => ({...f, customerName: e.target.value}))}
              className="px-3 py-2 rounded text-sm w-full" style={{ background: "hsl(240 12% 8%)", border: "1px solid hsl(240 8% 18%)", color: "hsl(36 29% 93%)" }} />
            <input placeholder="Bill Amount *" type="number" value={form.billAmount || ""} onChange={(e) => setForm(f => ({...f, billAmount: Number(e.target.value)}))}
              className="px-3 py-2 rounded text-sm w-full" style={{ background: "hsl(240 12% 8%)", border: "1px solid hsl(240 8% 18%)", color: "hsl(36 29% 93%)" }} />

            {form.billAmount > 0 && (
              <div className="p-3 rounded-lg text-xs space-y-1" style={{ background: "hsl(240 12% 8%)" }}>
                <div className="flex justify-between"><span>Bill Amount</span><span>{formatINR(form.billAmount)}</span></div>
                <div className="flex justify-between" style={{ color: "#ef4444" }}><span>Discount ({discountPercent}%)</span><span>-{formatINR(discountAmount)}</span></div>
                <div className="flex justify-between"><span>After Discount</span><span>{formatINR(afterDiscount)}</span></div>
                <div className="flex justify-between" style={{ color: "#ef4444" }}><span>Commission ({commissionPercent}%)</span><span>-{formatINR(commissionAmount)}</span></div>
                <div className="flex justify-between" style={{ color: "#ef4444" }}><span>GST on Commission</span><span>-{formatINR(commissionGst)}</span></div>
                <div className="flex justify-between font-semibold pt-1" style={{ borderTop: "1px solid hsl(240 8% 18%)", color: "#C9A84C" }}>
                  <span>Net Receivable</span><span>{formatINR(netReceivable)}</span>
                </div>
              </div>
            )}

            <button onClick={handleSubmit} disabled={saving || !form.bookingId || !form.billAmount}
              className="w-full py-2 rounded-lg text-sm font-semibold disabled:opacity-50"
              style={{ background: "#C9A84C", color: "#030305" }}>
              {saving ? "Saving..." : "Add Order"}
            </button>
          </div>
        </div>

        <div>
          <h3 className="text-sm font-semibold mb-2" style={{ color: "#C9A84C" }}>Recent Orders</h3>
          <div className="space-y-1 max-h-[40vh] overflow-y-auto">
            {orders.map((o) => (
              <div key={o.id} className="flex items-center justify-between px-3 py-2 rounded-lg" style={{ background: "hsl(240 12% 5%)" }}>
                <div>
                  <span className="text-xs font-medium" style={{ color: "#C9A84C" }}>{aggLabels[o.aggregator]}</span>
                  <span className="text-xs ml-2">{o.bookingId}</span>
                  {o.customerName && <span className="text-xs ml-2" style={{ color: "hsl(36 29% 60%)" }}>{o.customerName}</span>}
                </div>
                <div className="text-right">
                  <div className="text-sm">{formatINR(o.billAmount)}</div>
                  <div className="text-xs" style={{ color: "#22c55e" }}>Net: {formatINR(o.netReceivable)}</div>
                </div>
              </div>
            ))}
            {orders.length === 0 && (
              <p className="text-xs text-center py-4" style={{ color: "hsl(36 29% 50%)" }}>No aggregator orders today</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// One editable Needs-Review card. AI guesses pre-fill the fields; the staffer
// corrects anything wrong, then taps ADD (writes a tableReservation) or DISMISS.
function UnparsedCard({
  item, onResolve, onDismiss,
}: {
  item: HodUnparsedBooking;
  onResolve: (item: HodUnparsedBooking, edits: { customerName: string; phone: string; partySize: number; date: string; arrivalTime: string }) => Promise<void>;
  onDismiss: (item: HodUnparsedBooking) => Promise<void>;
}) {
  const [customerName, setName] = useState(item.guessGuestName || "");
  const [phone, setPhone] = useState(item.guessGuestPhone || "");
  const [partySize, setPax] = useState<number>(item.guessPartySize || 2);
  const [date, setDate] = useState(item.guessBookingDate || "");
  const [arrivalTime, setTime] = useState(item.guessArrivalTime || "");
  const [showRaw, setShowRaw] = useState(false);
  const [busy, setBusy] = useState(false);

  const inputCls = "px-2 py-1.5 rounded text-xs w-full";
  const inputStyle = { background: "hsl(240 12% 8%)", border: "1px solid hsl(240 8% 22%)", color: "hsl(36 29% 93%)" } as const;
  const conf = typeof item.aiConfidence === "number" ? Math.round(item.aiConfidence * 100) : null;
  const srcLabel = (item.source || "unknown").toUpperCase();
  const reasonLabel = item.reason === "ai_unavailable" ? "AI was offline" : item.reason === "low_confidence" ? "AI unsure" : (item.reason || "review");

  const add = async () => {
    setBusy(true);
    try { await onResolve(item, { customerName, phone, partySize, date, arrivalTime }); }
    finally { setBusy(false); }
  };

  return (
    <div className="rounded-lg p-2.5" style={{ background: "hsl(240 12% 8%)", border: "1px solid hsl(240 8% 18%)" }}>
      <div className="flex items-center justify-between mb-2">
        <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded" style={{ background: "rgba(201,168,76,0.15)", color: "#C9A84C" }}>
          {srcLabel} · {item.channel === "sms" ? "SMS" : "EMAIL"}
        </span>
        <span className="text-[10px]" style={{ color: "hsl(36 29% 50%)" }}>
          {reasonLabel}{conf !== null ? ` · ${conf}%` : ""}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <input value={customerName} onChange={(e) => setName(e.target.value)} placeholder="Name *" className={inputCls + " col-span-2"} style={inputStyle} />
        <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Phone" inputMode="numeric" className={inputCls} style={inputStyle} />
        <input value={partySize} onChange={(e) => setPax(Number(e.target.value) || 0)} placeholder="Pax" type="number" className={inputCls} style={inputStyle} />
        <input value={date} onChange={(e) => setDate(e.target.value)} placeholder="Date YYYY-MM-DD *" type="date" className={inputCls} style={inputStyle} />
        <input value={arrivalTime} onChange={(e) => setTime(e.target.value)} placeholder="Time *" className={inputCls} style={inputStyle} />
      </div>

      {item.rawSubject && <div className="text-[10px] mt-2" style={{ color: "hsl(36 29% 55%)" }}>✉️ {item.rawSubject}</div>}
      {item.rawBody && (
        <button onClick={() => setShowRaw((s) => !s)} className="text-[10px] mt-1" style={{ color: "#C9A84C" }}>
          {showRaw ? "▲ Hide original message" : "▼ Show original message"}
        </button>
      )}
      {showRaw && item.rawBody && (
        <pre className="text-[10px] mt-1 p-2 rounded whitespace-pre-wrap" style={{ background: "hsl(240 12% 4%)", color: "hsl(36 29% 65%)", maxHeight: "30vh", overflowY: "auto" }}>
          {item.rawBody}
        </pre>
      )}

      <div className="flex gap-2 mt-2">
        <button onClick={add} disabled={busy || !customerName.trim() || !date || !arrivalTime.trim()}
          className="flex-1 py-1.5 rounded text-xs font-semibold disabled:opacity-40"
          style={{ background: "#C9A84C", color: "#030305" }}>
          {busy ? "Adding..." : "✓ ADD TO TABLES"}
        </button>
        <button onClick={() => onDismiss(item)} disabled={busy}
          className="px-3 py-1.5 rounded text-xs font-medium disabled:opacity-40"
          style={{ background: "transparent", border: "1px solid hsl(0 60% 40%)", color: "#ef4444" }}>
          Dismiss
        </button>
      </div>
    </div>
  );
}
