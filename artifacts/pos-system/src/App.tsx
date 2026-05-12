import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { StaffProvider, useStaff } from "@/lib/staff-context";
import LoginPage from "@/pages/LoginPage";
import FloorView from "@/pages/FloorView";
import TablePOS from "@/pages/TablePOS";
import BillView from "@/pages/BillView";
import Reports from "@/pages/Reports";
import KOTView from "@/pages/KOTView";
import ShiftView from "@/pages/ShiftView";
import AdminPage from "@/pages/AdminPage";
import AuditPage from "@/pages/AuditPage";
import AggregatorPage from "@/pages/AggregatorPage";
import CaptainMode from "@/pages/CaptainMode";
import BarMode from "@/pages/BarMode";
import DoorMode from "@/pages/DoorMode";
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
      {FEATURES.floorView && <Route path="/" component={FloorView} />}
      {FEATURES.tablePos && <Route path="/table/:tableId" component={TablePOS} />}
      {FEATURES.billing && <Route path="/bill/:tableId" component={BillView} />}
      {FEATURES.reports && <Route path="/reports" component={Reports} />}
      {FEATURES.kot && <Route path="/kot" component={KOTView} />}
      {FEATURES.shift && <Route path="/shift" component={ShiftView} />}
      {FEATURES.admin && <Route path="/admin" component={AdminPage} />}
      {FEATURES.audit && <Route path="/audit" component={AuditPage} />}
      {FEATURES.aggregatorSync && <Route path="/aggregator" component={AggregatorPage} />}
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
          </WouterRouter>
          <Toaster />
        </StaffProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
