import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { ArrowLeft, CheckCircle, Clock, ChefHat, AlertCircle, RefreshCw, Wine, UtensilsCrossed } from "lucide-react";
import { subscribeToKOTs, updateKOTStatus } from "@/lib/firestore";
import { formatTime } from "@/lib/utils-pos";
import type { KOTTicket } from "@/lib/types";
import { cn } from "@/lib/utils";

type DestinationTab = "all" | "kitchen" | "bar";

export default function KOTView() {
  const [, setLocation] = useLocation();
  const [kots, setKOTs] = useState<KOTTicket[]>([]);
  const [updating, setUpdating] = useState<string | null>(null);
  const [tab, setTab] = useState<DestinationTab>("all");

  useEffect(() => {
    const unsub = subscribeToKOTs(setKOTs);
    return unsub;
  }, []);

  const filteredKOTs = tab === "all" ? kots : kots.filter((k) => k.destination === tab);
  const pendingKOTs = kots.filter((k) => k.status === "pending");
  const inProgressKOTs = kots.filter((k) => k.status === "in-progress");
  const kitchenCount = kots.filter((k) => k.destination === "kitchen" && k.status !== "ready").length;
  const barCount = kots.filter((k) => k.destination === "bar" && k.status !== "ready").length;

  const handleStatusUpdate = async (kotId: string, newStatus: KOTTicket["status"]) => {
    if (!kotId) return;
    setUpdating(kotId);
    try {
      await updateKOTStatus(kotId, newStatus);
    } finally {
      setUpdating(null);
    }
  };

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <header className="flex items-center gap-3 px-4 py-3 border-b border-border bg-card">
        <button onClick={() => setLocation("/")} className="p-1.5 rounded-lg hover:bg-secondary">
          <ArrowLeft size={18} className="text-muted-foreground" />
        </button>
        <div className="flex items-center gap-2 flex-1">
          <ChefHat size={18} className="text-primary" />
          <h2 className="font-serif text-xl text-primary">KOT Queue</h2>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {pendingKOTs.length > 0 && (
            <span className="flex items-center gap-1 text-destructive font-medium">
              <AlertCircle size={12} />
              {pendingKOTs.length} pending
            </span>
          )}
          {inProgressKOTs.length > 0 && (
            <span className="flex items-center gap-1 text-yellow-400 font-medium">
              <Clock size={12} />
              {inProgressKOTs.length} in progress
            </span>
          )}
        </div>
      </header>

      <div className="px-4 pt-3 flex items-center gap-1 border-b border-border">
        {([
          { key: "all" as DestinationTab, label: "All", count: kots.length, icon: null },
          { key: "kitchen" as DestinationTab, label: "Kitchen", count: kitchenCount, icon: UtensilsCrossed },
          { key: "bar" as DestinationTab, label: "Bar", count: barCount, icon: Wine },
        ]).map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={cn(
              "px-4 py-2 text-sm font-medium rounded-t-lg transition-all border-b-2 -mb-px flex items-center gap-1.5",
              tab === t.key
                ? "border-primary text-primary bg-card"
                : "border-transparent text-muted-foreground hover:text-foreground"
            )}
          >
            {t.icon && <t.icon size={13} />}
            {t.label}
            {t.count > 0 && (
              <span className={cn(
                "text-[10px] px-1.5 py-0.5 rounded-full font-bold",
                tab === t.key ? "bg-primary/20 text-primary" : "bg-secondary text-muted-foreground"
              )}>
                {t.count}
              </span>
            )}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {filteredKOTs.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-[60vh] text-muted-foreground">
            {tab === "bar" ? (
              <Wine size={64} className="text-primary/20 mb-4" />
            ) : tab === "kitchen" ? (
              <UtensilsCrossed size={64} className="text-primary/20 mb-4" />
            ) : (
              <ChefHat size={64} className="text-primary/20 mb-4" />
            )}
            <p className="font-semibold text-foreground">All clear!</p>
            <p className="text-sm mt-1">No pending {tab === "all" ? "" : tab} orders</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {filteredKOTs.map((kot) => (
              <KOTCard
                key={kot.id}
                kot={kot}
                updating={updating === kot.id}
                onMarkInProgress={() => handleStatusUpdate(kot.id!, "in-progress")}
                onMarkReady={() => handleStatusUpdate(kot.id!, "ready")}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function KOTCard({
  kot,
  updating,
  onMarkInProgress,
  onMarkReady,
}: {
  kot: KOTTicket;
  updating: boolean;
  onMarkInProgress: () => void;
  onMarkReady: () => void;
}) {
  const sentAt = kot.sentAt?.toDate?.();
  const diffMins = sentAt ? Math.floor((Date.now() - sentAt.getTime()) / 60000) : 0;
  const isUrgent = diffMins >= 10;

  const statusColor = {
    pending: "border-yellow-500/50 bg-yellow-500/5",
    "in-progress": "border-blue-500/50 bg-blue-500/5",
    ready: "border-green-500/50 bg-green-500/5",
  }[kot.status];

  const destBadge = kot.destination === "bar"
    ? { icon: Wine, color: "bg-purple-500/20 text-purple-400", label: "BAR" }
    : { icon: UtensilsCrossed, color: "bg-orange-500/20 text-orange-400", label: "KITCHEN" };

  return (
    <div className={cn("rounded-2xl border p-4 transition-all", statusColor)}>
      <div className="flex items-start justify-between mb-3">
        <div>
          <div className="flex items-center gap-2">
            <span className="font-bold text-lg text-foreground">KOT #{kot.kotNumber}</span>
            <span className={cn("text-[9px] px-1.5 py-0.5 rounded font-bold uppercase flex items-center gap-1", destBadge.color)}>
              <destBadge.icon size={9} />
              {destBadge.label}
            </span>
            {isUrgent && (
              <span className="text-[10px] bg-red-500/20 text-red-400 px-1.5 py-0.5 rounded font-bold uppercase animate-pulse">
                URGENT
              </span>
            )}
          </div>
          <div className="text-sm font-medium text-primary mt-0.5">{kot.tableName}</div>
        </div>
        <div className="text-right">
          {sentAt && (
            <div className="text-xs text-muted-foreground flex items-center gap-1">
              <Clock size={10} />
              {formatTime(sentAt)}
            </div>
          )}
          <div className={cn("text-xs font-medium mt-0.5", isUrgent ? "text-red-400" : "text-muted-foreground")}>
            {diffMins}m ago
          </div>
        </div>
      </div>

      <div className="space-y-2 mb-4">
        {kot.items.map((item, i) => (
          <div key={i} className="flex items-start gap-2">
            <div className="w-7 h-7 rounded-lg bg-card border border-border flex items-center justify-center text-sm font-bold text-primary shrink-0">
              {item.qty}
            </div>
            <div>
              <div className="text-sm font-medium text-foreground">{item.name}</div>
              {item.servingSize && (
                <div className="text-[10px] text-muted-foreground">{item.servingSize}</div>
              )}
              {item.notes && (
                <div className="text-[11px] text-yellow-400 italic">⚠ {item.notes}</div>
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="flex gap-2">
        {kot.status === "pending" && (
          <button
            onClick={onMarkInProgress}
            disabled={updating}
            className="flex-1 py-2 rounded-xl bg-blue-500/20 border border-blue-500/40 text-blue-400 text-xs font-semibold hover:bg-blue-500/30 transition-colors"
          >
            {updating ? <RefreshCw size={12} className="animate-spin mx-auto" /> : "Start Preparing"}
          </button>
        )}
        {(kot.status === "pending" || kot.status === "in-progress") && (
          <button
            onClick={onMarkReady}
            disabled={updating}
            className={cn(
              "py-2 rounded-xl text-xs font-semibold transition-colors",
              kot.status === "pending" ? "w-auto px-3" : "flex-1",
              "bg-green-500/20 border border-green-500/40 text-green-400 hover:bg-green-500/30"
            )}
          >
            {updating ? (
              <RefreshCw size={12} className="animate-spin mx-auto" />
            ) : (
              <span className="flex items-center justify-center gap-1">
                <CheckCircle size={12} /> Ready
              </span>
            )}
          </button>
        )}
        {kot.status === "ready" && (
          <div className="flex-1 py-2 rounded-xl bg-green-500/10 border border-green-500/30 text-green-400 text-xs font-semibold text-center flex items-center justify-center gap-1">
            <CheckCircle size={12} /> Ready to Serve
          </div>
        )}
      </div>
    </div>
  );
}
