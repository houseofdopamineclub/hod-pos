type Ev =
  | { kind: "round"; n: number; items: { n: string; qty: number; p: number }[]; total: number; time: string; staff: string; voided?: boolean }
  | { kind: "recharge"; amount: number; time: string; staff: string }
  | { kind: "bill"; amount: number; time: string; staff: string }
  | { kind: "paid"; method: string; amount: number; time: string; staff: string };

const events: Ev[] = [
  { kind: "round", n: 1, items: [{ n: "Toit Tint Wit (330ml)", qty: 1, p: 444 }], total: 444, time: "04:52pm", staff: "Arjun" },
  { kind: "round", n: 2, items: [{ n: "Tomato Basil Soup", qty: 1, p: 185 }, { n: "Innocent Passion", qty: 1, p: 345 }], total: 595, time: "04:56pm", staff: "Arjun" },
  { kind: "recharge", amount: 1000, time: "05:00pm", staff: "Arjun" },
  { kind: "round", n: 3, items: [{ n: "Tomato Basil Soup", qty: 1, p: 185 }, { n: "Manchow Soup - Veg", qty: 1, p: 185 }], total: 427, time: "05:08pm", staff: "Arjun" },
  { kind: "round", n: 4, items: [{ n: "Toit Tint Wit (330ml)", qty: 1, p: 444 }], total: 444, time: "06:35pm", staff: "Arjun", voided: true },
  { kind: "round", n: 5, items: [{ n: "Toit Tint Wit (330ml)", qty: 1, p: 444 }], total: 444, time: "06:39pm", staff: "Arjun" },
  { kind: "round", n: 6, items: [{ n: "Tomato Basil Soup", qty: 1, p: 185 }], total: 214, time: "07:02pm", staff: "Siddharth" },
  { kind: "round", n: 7, items: [{ n: "Innocent Passion", qty: 2, p: 345 }], total: 753, time: "07:45pm", staff: "Siddharth" },
];

const newestFirst = [...events].reverse();

let runningBal = 523;
const balanceAfter = new Map<number, number>();
let bal = 0;
for (let i = 0; i < events.length; i++) {
  const e = events[i];
  if (e.kind === "recharge") bal += e.amount;
  else if (e.kind === "round" && !e.voided) bal -= e.total;
  balanceAfter.set(i, bal);
}
const finalSpent = events.filter(e => e.kind === "round" && !(e as any).voided).reduce((s, e: any) => s + e.total, 0);
const finalRecharges = events.filter(e => e.kind === "recharge").reduce((s, e: any) => s + e.amount, 0);

export function Timeline() {
  return (
    <div style={{ minHeight: "100vh", background: "#1A1A1A", fontFamily: "'Space Grotesk', system-ui, sans-serif", color: "#fff", padding: "0" }}>
      {/* TOP TAB HEADER (mimics wallet header) */}
      <div style={{ padding: "12px 14px", background: "#0A0A0A", borderBottom: "1px solid rgba(255,255,255,.06)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 900, color: "#F2C744" }}>buy covers 1</div>
          <div style={{ fontSize: 10, color: "rgba(255,255,255,.45)" }}>HODTIC147212 · Standard</div>
        </div>
        <button style={{ background: "rgba(34,197,94,.15)", border: "1.5px solid #22C55E", color: "#22C55E", padding: "6px 10px", borderRadius: 8, fontSize: 11, fontWeight: 900 }}>
          ₹523<br/>+ RECHARGE
        </button>
      </div>

      <div style={{ padding: 12 }}>
        {/* PANEL HEADER */}
        <div style={{ background: "#F2EBD3", borderRadius: 12, overflow: "hidden", color: "#0A0A0A" }}>
          <div style={{ padding: "12px 14px", display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "1px solid rgba(0,0,0,.08)" }}>
            <div style={{ fontSize: 12, fontWeight: 900, letterSpacing: 0.6 }}>🧾 WALLET TIMELINE — 7 ROUNDS</div>
            <div style={{ fontSize: 10, color: "rgba(0,0,0,.5)" }}>newest ↓ oldest</div>
          </div>

          {/* STICKY BALANCE BAR */}
          <div style={{ position: "sticky", top: 0, background: "rgba(34,197,94,.18)", borderBottom: "1.5px solid #22C55E", padding: "10px 14px", display: "flex", justifyContent: "space-between", alignItems: "center", zIndex: 5 }}>
            <div style={{ fontSize: 11, fontWeight: 800, color: "#0A0A0A", letterSpacing: 0.5 }}>💰 AVAILABLE BALANCE</div>
            <div style={{ fontSize: 20, fontWeight: 900, color: "#0A6E32" }}>₹523</div>
          </div>

          {/* EVENTS */}
          <div style={{ padding: "8px 10px", display: "flex", flexDirection: "column", gap: 6 }}>
            {newestFirst.map((e, idxRev) => {
              const origIdx = events.length - 1 - idxRev;
              const balAfter = balanceAfter.get(origIdx) ?? 0;

              if (e.kind === "recharge") {
                return (
                  <div key={idxRev} style={{
                    borderLeft: "4px solid #22C55E",
                    background: "rgba(34,197,94,.08)",
                    borderRadius: 6,
                    padding: "8px 10px",
                    display: "flex", justifyContent: "space-between", alignItems: "center",
                  }}>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 800, color: "#0A6E32" }}>💵 RECHARGE</div>
                      <div style={{ fontSize: 10, color: "rgba(0,0,0,.55)" }}>{e.time} · {e.staff}</div>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <div style={{ fontSize: 15, fontWeight: 900, color: "#0A6E32" }}>+₹{e.amount}</div>
                      <div style={{ fontSize: 10, color: "rgba(0,0,0,.5)" }}>bal ₹{balAfter} →</div>
                    </div>
                  </div>
                );
              }

              if (e.kind === "round") {
                const voided = e.voided;
                return (
                  <div key={idxRev} style={{
                    borderLeft: `4px solid ${voided ? "#EF4444" : "#C9A84C"}`,
                    background: voided ? "rgba(239,68,68,.07)" : "#FFFFFF",
                    borderRadius: 6,
                    padding: "8px 10px",
                    display: "flex", justifyContent: "space-between", alignItems: "flex-start",
                    opacity: voided ? 0.7 : 1,
                  }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 2 }}>
                        <div style={{
                          width: 22, height: 22, borderRadius: "50%",
                          background: voided ? "#EF4444" : "#C9A84C",
                          color: "#FFF", fontSize: 11, fontWeight: 900,
                          display: "flex", alignItems: "center", justifyContent: "center",
                        }}>{e.n}</div>
                        <div style={{ fontSize: 12, fontWeight: 800, color: "#0A0A0A", textDecoration: voided ? "line-through" : "none" }}>
                          ROUND {e.n}{voided ? " · VOIDED" : ""}
                        </div>
                      </div>
                      {e.items.map((it, i) => (
                        <div key={i} style={{ fontSize: 12, color: "#0A0A0A", paddingLeft: 30 }}>
                          {it.qty}× <strong>{it.n}</strong> <span style={{ color: "rgba(0,0,0,.45)" }}>₹{it.p}</span>
                        </div>
                      ))}
                      <div style={{ fontSize: 10, color: "rgba(0,0,0,.55)", paddingLeft: 30, marginTop: 2 }}>{e.time} · {e.staff}</div>
                    </div>
                    <div style={{ textAlign: "right", marginLeft: 8 }}>
                      <div style={{ fontSize: 15, fontWeight: 900, color: voided ? "#EF4444" : "#0A0A0A" }}>
                        {voided ? "−" : "−"}₹{e.total}
                      </div>
                      <div style={{ fontSize: 10, color: "rgba(0,0,0,.5)" }}>bal ₹{balAfter} →</div>
                    </div>
                  </div>
                );
              }
              return null;
            })}
          </div>

          {/* FOOTER SUMMARY */}
          <div style={{ borderTop: "1.5px dashed rgba(0,0,0,.15)", padding: "12px 14px", background: "rgba(0,0,0,.03)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#0A0A0A", padding: "3px 0" }}>
              <span>TOTAL SPENT</span><span style={{ fontWeight: 800 }}>₹{finalSpent}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#0A0A0A", padding: "3px 0" }}>
              <span>RECHARGES</span><span style={{ fontWeight: 800, color: "#0A6E32" }}>+₹{finalRecharges}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14, color: "#0A0A0A", padding: "6px 0 0", borderTop: "1px solid rgba(0,0,0,.1)", marginTop: 4 }}>
              <span style={{ fontWeight: 900 }}>BALANCE</span><span style={{ fontWeight: 900, color: "#0A6E32" }}>₹523</span>
            </div>
          </div>
        </div>

        <div style={{ marginTop: 12, padding: 10, background: "rgba(255,255,255,.04)", borderRadius: 8, fontSize: 11, color: "rgba(255,255,255,.55)", lineHeight: 1.5 }}>
          🎨 Color key: <span style={{ color: "#C9A84C" }}>● Round</span> · <span style={{ color: "#22C55E" }}>● Recharge</span> · <span style={{ color: "#EF4444" }}>● Voided</span>
        </div>
      </div>
    </div>
  );
}
