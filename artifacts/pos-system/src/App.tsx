import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { StaffProvider, useStaff } from "@/lib/staff-context";
import { IdleLockOverlay, ModePickerOverlay } from "@/components/SessionOverlays";
import LoginPage from "@/pages/LoginPage";
// 🆕 2026-05-27 v3.105 (Khushi) — FloorView (legacy table-grid POS) RETIRED.
// Root "/" now redirects to /admin which is the new BOSS MODE landing
// (Reports + Audit + Admin tabs). Kept the FloorView component file on disk
// for code archeology; just no longer imported / routed.
import TablePOS from "@/pages/TablePOS";
import BillView from "@/pages/BillView";
import Reports from "@/pages/Reports";
import KOTView from "@/pages/KOTView";
import ShiftView from "@/pages/ShiftView";
import AdminPage from "@/pages/AdminPage";
import MenuMode from "@/pages/MenuMode";
import AuditPage from "@/pages/AuditPage";
// 🆕 2026-05-27 v3.106 (Khushi LIVE) — AggregatorPage RETIRED. Tab removed
// from Boss Mode + /aggregator route dropped. File kept on disk for code
// archeology (same as FloorView). Cloud Function `pollAggregatorEmails`
// owns aggregator booking ingestion now.
import CaptainMode from "@/pages/CaptainMode";
import BarMode from "@/pages/BarMode";
import DoorMode from "@/pages/DoorMode";
import KitchenMode from "@/pages/KitchenMode";
import NotFound from "@/pages/not-found";
import { FEATURES, IS_PHASE_1_ONLY } from "@/lib/feature-flags";
import { useEffect } from "react";
import { useLocation } from "wouter";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false },
  },
});

function AuthGate() {
  const { isLoggedIn } = useStaff();
  if (!isLoggedIn) return <LoginPage />;
  return <POSRouter />;
}

function POSRouter() {
  // In Phase 1 venues, FloorView/TablePOS/BillView/KOT/Shift/Reports/Audit are hidden.
  // Root path "/" redirects to /door so a Phase 1 venue lands directly on Door Mode.
  const [, setLocation] = useLocation();
  useEffect(() => {
    if (IS_PHASE_1_ONLY && window.location.pathname.replace(import.meta.env.BASE_URL.replace(/\/$/, ""), "") === "/") {
      setLocation("/door");
    }
  }, [setLocation]);
  return (
    <Switch>
      {/* 🆕 v3.105 — "/" now renders the 5-tile mode picker (was FloorView).
          Was briefly a Redirect → /admin, but every mode page has a "← BACK"
          link to "/" and non-admin staff would land on AdminPage's
          "Access denied". LoginPage works whether logged in (tile picker
          shown; PIN UI inert for logged-in users — admins auto-route to
          /admin via its own useEffect) or logged out (PIN gate). */}
      <Route path="/" component={LoginPage} />
      {FEATURES.tablePos && <Route path="/table/:tableId" component={TablePOS} />}
      {FEATURES.billing && <Route path="/bill/:tableId" component={BillView} />}
      {FEATURES.reports && <Route path="/reports"><Reports /></Route>}
      {FEATURES.kot && <Route path="/kot" component={KOTView} />}
      {FEATURES.shift && <Route path="/shift" component={ShiftView} />}
      {FEATURES.admin && <Route path="/admin" component={AdminPage} />}
      {/* 🆕 v3.239 — MENU mode (Menu Editor + Menu CRM moved out of Boss Mode).
          Gated behind the admin feature flag, same as the Boss tabs were. */}
      {FEATURES.admin && <Route path="/menu" component={MenuMode} />}
      {FEATURES.audit && <Route path="/audit"><AuditPage /></Route>}
      <Route component={NotFound} />
    </Switch>
  );
}

function AppRoutes() {
  return (
    <Switch>
      {FEATURES.captainMode && <Route path="/captain" component={CaptainMode} />}
      {FEATURES.barMode && <Route path="/bar" component={BarMode} />}
      {FEATURES.doorMode && <Route path="/door" component={DoorMode} />}
      {FEATURES.kitchenMode && <Route path="/kitchen" component={KitchenMode} />}
      <Route><AuthGate /></Route>
    </Switch>
  );
}

// 🛠️ One-click tablet floor switcher via URL.
// Visit ?setFloor=ground | ?setFloor=first | ?setFloor=rooftop to set & reload.
// Bypasses admin page entirely — useful during multi-floor printer setup.
if (typeof window !== "undefined") {
  const params = new URLSearchParams(window.location.search);
  const f = params.get("setFloor");
  if (f && ["ground", "first", "rooftop"].includes(f)) {
    localStorage.setItem("hod_tablet_floor", f);
    params.delete("setFloor");
    const clean = window.location.pathname + (params.toString() ? "?" + params.toString() : "");
    window.history.replaceState({}, "", clean);
    alert(`✅ This tablet is now set to: ${f.toUpperCase()} FLOOR\n\nDrinks → ${f === "ground" ? "gf_bar" : f === "first" ? "ff_bar" : "rt_bar"}\nBills → ${f === "ground" ? "gf_bill" : f === "first" ? "ff_bill" : "rt_bill"}`);
  }
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <StaffProvider>
          <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
            <AppRoutes />
            {/* 🆕 2026-05-25 — Multi-role picker + 25-min idle lock overlays. */}
            <ModePickerOverlay />
            <IdleLockOverlay />
          </WouterRouter>
          <Toaster />
        </StaffProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
