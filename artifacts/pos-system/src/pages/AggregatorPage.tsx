import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { useStaff } from "@/lib/staff-context";
import type { AggregatorSettings, AggregatorOrder, AggregatorName } from "@/lib/types";
import {
  subscribeToAggregatorSettings, subscribeToAggregatorOrders,
  addAggregatorOrder, logAudit,
} from "@/lib/firestore";
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

  useEffect(() => {
    const unsubs = [
      subscribeToAggregatorSettings(setSettings),
      subscribeToAggregatorOrders(setOrders),
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
