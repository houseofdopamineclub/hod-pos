import { createContext, useContext, useState, useCallback, useEffect, useRef, type ReactNode } from "react";
import type { StaffMember, StaffRole } from "./types";
import { subscribeToStaff } from "./firestore";

const FALLBACK_STAFF: StaffMember[] = [
  { id: "fb-admin", name: "Admin", pin: "0000", role: "admin", active: true },
  { id: "fb-gm1", name: "Manjunatha (GM)", pin: "1001", role: "manager", active: true },
  { id: "fb-gm2", name: "Satish (GM)", pin: "1002", role: "manager", active: true },
  { id: "fb-mgr1", name: "Sumith (Manager)", pin: "1003", role: "manager", active: true },
  { id: "fb-mgr2", name: "Adarsh (Manager)", pin: "1004", role: "manager", active: true },
  { id: "fb-cash1", name: "Sreekanth (Cashier)", pin: "2001", role: "cashier", active: true },
  { id: "fb-cash2", name: "Santhosh (Cashier)", pin: "2002", role: "cashier", active: true },
  { id: "fb-cash3", name: "Pemba (Cashier)", pin: "2003", role: "cashier", active: true },
  { id: "fb-cap1", name: "Captain 1", pin: "3001", role: "captain", active: true },
  { id: "fb-cap2", name: "Captain 2", pin: "3002", role: "captain", active: true },
  { id: "fb-cap3", name: "Captain 3", pin: "3003", role: "captain", active: true },
  { id: "fb-stw1", name: "Steward 1", pin: "4001", role: "steward", active: true },
  { id: "fb-bar1", name: "Bartender 1", pin: "5001", role: "bartender", active: true },
];

interface StaffContextValue {
  currentStaff: StaffMember | null;
  allStaff: StaffMember[];
  login: (pin: string) => boolean;
  logout: () => void;
  isLoggedIn: boolean;
  hasRole: (...roles: StaffRole[]) => boolean;
  verifyManagerPin: (pin: string) => StaffMember | null;
}

const StaffContext = createContext<StaffContextValue | null>(null);

export function StaffProvider({ children }: { children: ReactNode }) {
  const [currentStaff, setCurrentStaff] = useState<StaffMember | null>(null);
  const [firestoreStaff, setFirestoreStaff] = useState<StaffMember[]>([]);
  const [firestoreFailed, setFirestoreFailed] = useState(false);
  const fallbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let receivedData = false;
    fallbackTimer.current = setTimeout(() => {
      if (!receivedData) setFirestoreFailed(true);
    }, 3000);

    const unsub = subscribeToStaff((staff) => {
      receivedData = true;
      if (fallbackTimer.current) clearTimeout(fallbackTimer.current);
      setFirestoreStaff(staff);
      if (staff.length > 0) setFirestoreFailed(false);
    }, () => {
      if (fallbackTimer.current) clearTimeout(fallbackTimer.current);
      setFirestoreFailed(true);
    });
    return () => {
      unsub();
      if (fallbackTimer.current) clearTimeout(fallbackTimer.current);
    };
  }, []);

  const allStaff = firestoreStaff.length > 0 ? firestoreStaff : (firestoreFailed ? FALLBACK_STAFF : []);

  const login = useCallback((pin: string): boolean => {
    const found = allStaff.find((s) => s.pin === pin && s.active);
    if (found) {
      setCurrentStaff(found);
      return true;
    }
    return false;
  }, [allStaff]);

  const logout = useCallback(() => {
    setCurrentStaff(null);
  }, []);

  const hasRole = useCallback((...roles: StaffRole[]): boolean => {
    if (!currentStaff) return false;
    return roles.includes(currentStaff.role);
  }, [currentStaff]);

  const verifyManagerPin = useCallback((pin: string): StaffMember | null => {
    const found = allStaff.find(
      (s) => s.pin === pin && s.active && (s.role === "manager" || s.role === "admin")
    );
    return found || null;
  }, [allStaff]);

  return (
    <StaffContext.Provider
      value={{
        currentStaff,
        allStaff,
        login,
        logout,
        isLoggedIn: !!currentStaff,
        hasRole,
        verifyManagerPin,
      }}
    >
      {children}
    </StaffContext.Provider>
  );
}

export function useStaff(): StaffContextValue {
  const ctx = useContext(StaffContext);
  if (!ctx) throw new Error("useStaff must be used within StaffProvider");
  return ctx;
}
