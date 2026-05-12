import { useEffect, useState, useCallback } from "react";
import { useLocation } from "wouter";
import { Users, Clock, ChefHat, BarChart3, Briefcase, Settings, Truck, LogOut, ScrollText } from "lucide-react";
import { subscribeToTableReservations, subscribeToActiveOrders, subscribeToCurrentShift } from "@/lib/firestore";
import { useStaff } from "@/lib/staff-context";
import type { POSShift } from "@/lib/types";
import { GROUND_TABLES, DINING_TABLES, SMOKING_TABLES, ROOFTOP_TABLES, SECTION_LABELS } from "@/lib/tables-config";
import { formatINR, getDuration, formatTime, formatDate, getDurationMinutes } from "@/lib/utils-pos";
import type { TableReservation, POSOrder, TableConfig } from "@/lib/types";
import { cn } from "@/lib/utils";

type FloorTab = "ground" | "dining" | "rooftop";

export default function FloorView() {
  const [, setLocation] = useLocation();
  const { currentStaff, hasRole, logout } = useStaff();
  const [tab, setTab] = useState<FloorTab>("dining");
  const [reservations, setReservations] = useState<Record<string, TableReservation>>({});
  const [orders, setOrders] = useState<POSOrder[]>([]);
  const [shift, setShift] = useState<POSShift | null>(null);
  const [now, setNow] = useState(new Date());

  useEffect(() => {
    const unsub1 = subscribeToTableReservations(setReservations);
    const unsub2 = subscribeToActiveOrders(setOrders);
    const unsub3 = subscribeToCurrentShift(setShift);
    return () => { unsub1(); unsub2(); unsub3(); };
  }, []);

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30000);
    return () => clearInterval(t);
  }, []);

  const getOrderForTable = useCallback(
    (tableId: string) => orders.find((o) => o.tableId === tableId),
    [orders]
  );

  const stats = {
    occupied: Object.values(reservations).filter((r) => r.status === "occupied").length,
    totalRevenue: orders.reduce((s, o) => s + o.items.filter(i => i.status !== "void").reduce((a, i) => a + i.price * i.qty, 0), 0),
    totalCovers: Object.values(reservations).reduce((s, r) => s + (r.partySize || 0), 0),
    pendingKOTs: orders.reduce((s, o) => s + o.items.filter(i => i.status === "pending").length, 0),
    apc: 0,
  };
  stats.apc = stats.totalCovers > 0 ? Math.round(stats.totalRevenue / stats.totalCovers) : 0;

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <header className="border-b border-border bg-card px-4 md:px-6 py-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div>
              <h1 className="font-serif text-2xl text-primary">HOD</h1>
              <p className="text-[10px] text-muted-foreground uppercase tracking-widest">House of Dopamine</p>
            </div>
          </div>
          <div className="hidden lg:flex items-center gap-5 text-sm">
            <div className="text-center">
              <div className="text-primary font-semibold text-lg">{stats.occupied}</div>
              <div className="text-muted-foreground text-[10px] uppercase tracking-wider">Tables</div>
            </div>
            <div className="w-px h-8 bg-border" />
            <div className="text-center">
              <div className="text-primary font-semibold text-lg">{stats.totalCovers}</div>
              <div className="text-muted-foreground text-[10px] uppercase tracking-wider">Covers</div>
            </div>
            <div className="w-px h-8 bg-border" />
            <div className="text-center">
              <div className="text-primary font-semibold text-lg">{formatINR(stats.totalRevenue)}</div>
              <div className="text-muted-foreground text-[10px] uppercase tracking-wider">Revenue</div>
            </div>
            <div className="w-px h-8 bg-border" />
            <div className="text-center">
              <div className="text-primary font-semibold text-lg">{formatINR(stats.apc)}</div>
              <div className="text-muted-foreground text-[10px] uppercase tracking-wider">APC</div>
            </div>
            {stats.pendingKOTs > 0 && (
              <>
                <div className="w-px h-8 bg-border" />
                <div className="text-center">
                  <div className="text-destructive font-semibold text-lg animate-pulse">{stats.pendingKOTs}</div>
                  <div className="text-muted-foreground text-[10px] uppercase tracking-wider">Unsent</div>
                </div>
              </>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            <div className="text-right text-xs text-muted-foreground hidden sm:block mr-2">
              <div className="font-medium text-foreground">{currentStaff?.name}</div>
              <div className="capitalize">{currentStaff?.role}</div>
            </div>
            <button
              onClick={() => setLocation("/shift")}
              className={cn(
                "relative px-2.5 py-2 rounded-lg border transition-colors flex items-center gap-1.5 text-xs",
                shift
                  ? "border-green-500/40 text-green-400 hover:border-green-400"
                  : "border-yellow-500/40 text-yellow-400 hover:border-yellow-400"
              )}
            >
              <Briefcase size={14} />
              <span className="hidden md:inline font-medium">
                {shift ? shift.cashierName : "Open Shift"}
              </span>
              {shift && <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />}
            </button>
            <button
              onClick={() => setLocation("/kot")}
              className="relative px-2.5 py-2 rounded-lg border border-border hover:border-primary/50 transition-colors flex items-center gap-1.5 text-xs"
              aria-label="KOT"
            >
              <ChefHat size={14} className="text-muted-foreground" />
              <span className="hidden md:inline font-medium text-muted-foreground">KOT</span>
              {stats.pendingKOTs > 0 && (
                <span className="absolute -top-1 -right-1 bg-destructive text-destructive-foreground text-[10px] rounded-full w-4 h-4 flex items-center justify-center">
                  {stats.pendingKOTs}
                </span>
              )}
            </button>
            <button onClick={() => setLocation("/aggregator")} className="px-2.5 py-2 rounded-lg border border-border hover:border-primary/50 transition-colors flex items-center gap-1.5 text-xs" aria-label="Aggregators">
              <Truck size={14} className="text-muted-foreground" />
              <span className="hidden md:inline font-medium text-muted-foreground">Aggregators</span>
            </button>
            <button onClick={() => setLocation("/reports")} className="px-2.5 py-2 rounded-lg border border-border hover:border-primary/50 transition-colors flex items-center gap-1.5 text-xs" aria-label="Reports">
              <BarChart3 size={14} className="text-muted-foreground" />
              <span className="hidden md:inline font-medium text-muted-foreground">Reports</span>
            </button>
            <button onClick={() => setLocation("/audit")} className="px-2.5 py-2 rounded-lg border border-primary/40 hover:border-primary transition-colors flex items-center gap-1.5 text-xs bg-primary/5" aria-label="Bill Audit" title="Bill Print Audit Log">
              <ScrollText size={14} className="text-primary" />
              <span className="hidden md:inline font-bold text-primary">Audit</span>
            </button>
            {hasRole("admin", "manager") && (
              <button onClick={() => setLocation("/admin")} className="px-2.5 py-2 rounded-lg border border-border hover:border-primary/50 transition-colors flex items-center gap-1.5 text-xs" aria-label="Admin">
                <Settings size={14} className="text-muted-foreground" />
                <span className="hidden md:inline font-medium text-muted-foreground">Admin</span>
              </button>
            )}
            <button onClick={logout} className="px-2.5 py-2 rounded-lg border border-border hover:border-destructive/50 transition-colors flex items-center gap-1.5 text-xs" aria-label="Logout">
              <LogOut size={14} className="text-muted-foreground" />
              <span className="hidden md:inline font-medium text-muted-foreground">Logout</span>
            </button>
          </div>
        </div>
      </header>

      <div className="px-4 md:px-6 pt-3 flex items-center gap-1 border-b border-border">
        {(["ground", "dining", "rooftop"] as FloorTab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={cn(
              "px-4 py-2 text-sm font-medium rounded-t-lg transition-all capitalize border-b-2 -mb-px",
              tab === t
                ? "border-primary text-primary bg-card"
                : "border-transparent text-muted-foreground hover:text-foreground"
            )}
          >
            {t === "ground" ? "Ground Floor" : t === "dining" ? "2nd Floor" : "Rooftop"}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-3 text-[10px] text-muted-foreground pb-2">
          {[
            { color: "bg-green-500/70", label: "Free" },
            { color: "bg-primary/70", label: "Occupied" },
            { color: "bg-purple-500/70", label: "Reserved" },
            { color: "bg-red-500/70", label: "Billing" },
          ].map((l) => (
            <div key={l.label} className="flex items-center gap-1">
              <div className={cn("w-2 h-2 rounded-full", l.color)} />
              {l.label}
            </div>
          ))}
        </div>
      </div>

      <div className="flex-1 p-4 md:p-6 overflow-y-auto">
        {tab === "ground" && (
          <div className="space-y-6">
            <TableGrid
              title="Ground Floor"
              tables={GROUND_TABLES.filter(t => !t.isVIP)}
              reservations={reservations}
              getOrderForTable={getOrderForTable}
              now={now}
              onTableClick={(tid) => setLocation(`/table/${tid}`)}
            />
            <TableGrid
              title="Ground VVIP"
              tables={GROUND_TABLES.filter(t => t.isVIP)}
              reservations={reservations}
              getOrderForTable={getOrderForTable}
              now={now}
              onTableClick={(tid) => setLocation(`/table/${tid}`)}
              isVIP
            />
          </div>
        )}
        {tab === "dining" && (
          <div className="space-y-6">
            <TableGrid
              title="Dining Section"
              tables={DINING_TABLES}
              reservations={reservations}
              getOrderForTable={getOrderForTable}
              now={now}
              onTableClick={(tid) => setLocation(`/table/${tid}`)}
            />
            <TableGrid
              title="Smoking Section"
              tables={SMOKING_TABLES}
              reservations={reservations}
              getOrderForTable={getOrderForTable}
              now={now}
              onTableClick={(tid) => setLocation(`/table/${tid}`)}
            />
          </div>
        )}
        {tab === "rooftop" && (
          <div className="space-y-6">
            <TableGrid
              title="Rooftop Tables"
              tables={ROOFTOP_TABLES.filter((t) => !t.isVIP)}
              reservations={reservations}
              getOrderForTable={getOrderForTable}
              now={now}
              onTableClick={(tid) => setLocation(`/table/${tid}`)}
            />
            <TableGrid
              title="Rooftop VIP & Exclusive"
              tables={ROOFTOP_TABLES.filter((t) => t.isVIP)}
              reservations={reservations}
              getOrderForTable={getOrderForTable}
              now={now}
              onTableClick={(tid) => setLocation(`/table/${tid}`)}
              isVIP
            />
          </div>
        )}
      </div>

      <div className="lg:hidden border-t border-border bg-card px-4 py-2">
        <div className="flex items-center justify-around text-[10px]">
          <div className="text-center">
            <div className="text-primary font-bold">{stats.occupied}</div>
            <div className="text-muted-foreground">Tables</div>
          </div>
          <div className="text-center">
            <div className="text-primary font-bold">{stats.totalCovers}</div>
            <div className="text-muted-foreground">Covers</div>
          </div>
          <div className="text-center">
            <div className="text-primary font-bold">{formatINR(stats.totalRevenue)}</div>
            <div className="text-muted-foreground">Revenue</div>
          </div>
          <div className="text-center">
            <div className="text-primary font-bold">{formatINR(stats.apc)}</div>
            <div className="text-muted-foreground">APC</div>
          </div>
        </div>
      </div>
    </div>
  );
}

function TableGrid({
  title,
  tables,
  reservations,
  getOrderForTable,
  now,
  onTableClick,
  isVIP = false,
}: {
  title: string;
  tables: TableConfig[];
  reservations: Record<string, TableReservation>;
  getOrderForTable: (id: string) => POSOrder | undefined;
  now: Date;
  onTableClick: (id: string) => void;
  isVIP?: boolean;
}) {
  return (
    <div>
      <h2 className={cn("text-xs font-medium mb-3 uppercase tracking-widest", isVIP ? "text-primary" : "text-muted-foreground")}>
        {title} ({tables.length})
      </h2>
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
        {tables.map((table) => (
          <TableCard
            key={table.id}
            table={table}
            reservation={reservations[table.id]}
            order={getOrderForTable(table.id)}
            now={now}
            onClick={() => onTableClick(table.id)}
          />
        ))}
      </div>
    </div>
  );
}

function TableCard({
  table,
  reservation,
  order,
  now,
  onClick,
}: {
  table: TableConfig;
  reservation?: TableReservation;
  order?: POSOrder;
  now: Date;
  onClick: () => void;
}) {
  const status = reservation?.status || "available";
  const seatedAt = reservation?.seatedAt?.toDate?.();
  const orderTotal = order
    ? order.items.filter((i) => i.status !== "void").reduce((s, i) => s + i.price * i.qty, 0)
    : 0;
  const pendingItems = order ? order.items.filter((i) => i.status === "pending").length : 0;
  const durationMins = seatedAt ? getDurationMinutes(seatedAt) : 0;
  const isLongStay = durationMins >= 45 && status === "occupied";

  const statusStyles: Record<string, string> = {
    available: "table-available border",
    occupied: "table-occupied border",
    reserved: "table-reserved border",
    billing: "table-billing border",
    cleaning: "border border-muted",
  };

  const statusDot: Record<string, string> = {
    available: "bg-green-500",
    occupied: "bg-primary",
    reserved: "bg-purple-500",
    billing: "bg-red-500",
    cleaning: "bg-muted-foreground",
  };

  return (
    <button
      onClick={onClick}
      className={cn(
        "relative rounded-xl p-3 text-left transition-all duration-200 hover:scale-[1.02] active:scale-[0.98]",
        "min-h-[110px] flex flex-col justify-between group",
        statusStyles[status] || "border border-border",
        status === "occupied" && pendingItems > 0 ? "pulse-gold" : "",
        table.isVIP ? "border-primary/40" : "",
        table.shape === "round" ? "rounded-2xl" : ""
      )}
    >
      <div className={cn("absolute top-2.5 right-2.5 w-2 h-2 rounded-full", statusDot[status] || "bg-muted-foreground")} />

      {table.isVIP && (
        <div className="absolute top-2 left-2 text-[9px] font-bold text-primary uppercase tracking-widest">
          {table.section === "ground-vvip" ? "VVIP" : "VIP"}
        </div>
      )}

      <div className={cn("mt-1", table.isVIP ? "mt-4" : "")}>
        <div className="font-semibold text-base text-foreground">{table.name}</div>
        <div className="flex items-center gap-1 text-xs text-muted-foreground mt-0.5">
          <Users size={10} />
          <span>{table.capacity}</span>
          {reservation?.partySize && (
            <span className="text-foreground font-medium">/{reservation.partySize}</span>
          )}
        </div>
      </div>

      <div className="space-y-0.5">
        {reservation?.guestName && (
          <div className="text-xs font-medium text-foreground truncate">{reservation.guestName}</div>
        )}
        {seatedAt && status === "occupied" && (
          <div className={cn("flex items-center gap-1 text-xs", isLongStay ? "text-muted-foreground/80 italic" : "text-muted-foreground")}>
            <Clock size={9} />
            <span>{getDuration(seatedAt)}</span>
          </div>
        )}
        {orderTotal > 0 && (
          <div className="text-xs font-semibold text-primary">{formatINR(orderTotal)}</div>
        )}
        {pendingItems > 0 && (
          <div className="text-[10px] text-destructive font-medium">
            {pendingItems} unsent
          </div>
        )}
        {status === "available" && (
          <div className="text-xs text-muted-foreground">Available</div>
        )}
        {status === "reserved" && (
          <div className="text-xs text-purple-400">Reserved</div>
        )}
      </div>
    </button>
  );
}
