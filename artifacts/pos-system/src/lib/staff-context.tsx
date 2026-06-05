import { createContext, useContext, useState, useCallback, useEffect, useRef, type ReactNode } from "react";
import type { StaffMember, StaffRole } from "./types";
import { subscribeToStaff, logAudit } from "./firestore";

// 🆕 2026-05-25 (Khushi) — Per-staff login v2:
//   • 10-hour absolute session (was 9hr) — auto-logout 10h after first login.
//   • 25-min idle lock — re-PIN required if no activity (NOT full logout, so
//     the absolute 10hr clock keeps ticking and the user just unlocks fast).
//   • Multi-role support via `roles[]` on StaffMember (e.g. Tejas R = door +
//     captain + bar). Multi-role users see a Mode Picker after PIN entry.
//   • activeMode persisted across browser close so a captain stays on the
//     captain side after closing the tablet.
//   • Fail-open: any localStorage failure (private mode / quota) still allows
//     login in-memory.
const SESSION_KEY = "hod_staff_session";
const SESSION_TTL_MS = 10 * 60 * 60 * 1000;          // 🆕 10 hours absolute (Khushi 2026-05-25)
// 🆕 2026-06-05 v3.227 (Khushi) — SECURITY: 15-min inactivity OR tab-away →
// FULL LOGOUT (was a 25-min re-PIN "lock"). Staff must log back in with
// Employee ID + PIN. Both the idle timer and a visibilitychange check enforce
// this so a tablet left unattended or backgrounded can't be picked up later.
const IDLE_LOGOUT_MS = 15 * 60 * 1000;               // 🆕 15 min idle/away → logout

type PersistedSession = {
  staffId: string;
  expiresAt: number;
  activeMode?: StaffRole | null;
};

function readSession(): PersistedSession | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as PersistedSession;
    if (!s.staffId || !s.expiresAt) return null;
    if (Date.now() >= s.expiresAt) { localStorage.removeItem(SESSION_KEY); return null; }
    return s;
  } catch { return null; }
}

function writeSession(staffId: string, expiresAt: number, activeMode: StaffRole | null) {
  try { localStorage.setItem(SESSION_KEY, JSON.stringify({ staffId, expiresAt, activeMode })); } catch {}
}

function clearSession() {
  try { localStorage.removeItem(SESSION_KEY); } catch {}
}

/**
 * 🆕 2026-05-25 (Khushi GO-LIVE) — Full staff roster with random 4-digit PINs.
 * IDs are CAPITALISED, NO DASH (HOD001 not hod-001) per Khushi's spec.
 * Multi-role users (Ganesh, Tejas) use `roles: [...]`.
 * Admin tier (Muniraju/Manjunatha/Santhosh/Satish) gets FULL access (door +
 * captain + bar + KDS + admin dashboard) via the "admin" role's implicit
 * grant in hasRole().
 */
const FALLBACK_STAFF: StaffMember[] = [
  // 🔴 Owner — universal backdoor, PIN 0000. Rotate via Admin → Staff.
  { id: "OWNER111", name: "Owner", pin: "0000", role: "admin", active: true },
  // 🔴 Admin tier — full access to every mode + admin dashboard.
  { id: "HOD001", name: "Muniraju N", pin: "4729", role: "admin", active: true },
  { id: "HOD002", name: "Manjunatha R K", pin: "8316", role: "admin", active: true },
  { id: "HOD003", name: "Santhosh S", pin: "5274", role: "admin", active: true },
  { id: "HOD146", name: "Satish Kumar", pin: "9183", role: "admin", active: true },
  // 🚪 Door only (hostess role)
  { id: "HOD129", name: "Lhaipichong Kipgen (Zaneth)", pin: "3856", role: "hostess", active: true },
  { id: "HOD133", name: "Ragini Jamatia", pin: "6471", role: "hostess", active: true },
  // 👨‍✈️ Captain only
  { id: "HOD013", name: "Amber Chettri", pin: "5639", role: "captain", active: true },
  { id: "HOD019", name: "Sachin Thapa", pin: "8174", role: "captain", active: true },
  { id: "HOD145", name: "Rabindranath Saren", pin: "4528", role: "captain", active: true },
  { id: "HOD077", name: "Sumith J D", pin: "7963", role: "captain", active: true },
  { id: "HOD084", name: "Adarsh Gurung", pin: "3815", role: "captain", active: true },
  { id: "HOD009", name: "Zholuto Venuh", pin: "6294", role: "captain", active: true },
  { id: "HOD108", name: "Pemba Tshering Tamang", pin: "9527", role: "captain", active: true },
  // 🍸 Bar only (bartender role)
  { id: "HOD150", name: "Aman Chettri", pin: "4762", role: "bartender", active: true },
  { id: "HOD151", name: "Prakash", pin: "8395", role: "bartender", active: true },
  { id: "HOD168", name: "Deepak Sha", pin: "5148", role: "bartender", active: true },
  { id: "HOD172", name: "Atsa", pin: "7236", role: "bartender", active: true },
  // 🔀 Multi-role (captain + bar)
  { id: "HOD005", name: "Ganesh Poojary", pin: "2947", role: "captain", roles: ["captain", "bartender"], active: true },
  // 🔀 Multi-role (door + captain + bar)
  { id: "HOD086", name: "Tejas R", pin: "3691", role: "hostess", roles: ["hostess", "captain", "bartender"], active: true },
];

/** 🚪 Exposed for the "Seed Staff" button in AdminPage. */
export const DOOR_STAFF_SEED: StaffMember[] = FALLBACK_STAFF;

/** Helper — collapse roles[] OR role to a Set for O(1) membership checks. */
function rolesOf(s: StaffMember): Set<StaffRole> {
  const list = s.roles && s.roles.length > 0 ? s.roles : [s.role];
  return new Set(list);
}

interface StaffContextValue {
  currentStaff: StaffMember | null;
  allStaff: StaffMember[];
  /** Legacy: log in by PIN only (used by AdminPage). Kept for back-compat. */
  login: (pin: string, preferMode?: StaffRole | null) => boolean;
  /**
   * Preferred: log in by exact staffId + PIN. Returns the matched staff on
   * success so the caller can decide if a mode-picker is needed.
   */
  loginByStaffId: (staffId: string, pin: string, preferMode?: StaffRole | null) => StaffMember | null;
  logout: () => void;
  isLoggedIn: boolean;
  /**
   * True if the current staff has ANY of the requested roles.
   * `admin` role implicitly satisfies every check (full access).
   */
  hasRole: (...roles: StaffRole[]) => boolean;
  verifyManagerPin: (pin: string) => StaffMember | null;
  /** ms remaining in current session (null when logged out). */
  sessionExpiresAt: number | null;

  // 🆕 2026-05-25 — Mode picker for multi-role users.
  /** The mode the user has chosen for this session, e.g. "captain". */
  activeMode: StaffRole | null;
  setActiveMode: (mode: StaffRole | null) => void;
  /** Number of distinct mode-roles this user has (door/captain/bar). */
  /** True iff staff has >1 mode roles and hasn't picked one yet. */
  needsModePicker: boolean;

  // 🆕 2026-05-25 — Idle re-PIN lock (does NOT reset 10hr absolute session).
  /** True when the screen is idle-locked and currentStaff must re-enter PIN. */
  isIdleLocked: boolean;
  /** Attempt to clear idle lock by re-entering currentStaff's PIN. */
  unlockIdle: (pin: string) => boolean;
}

const StaffContext = createContext<StaffContextValue | null>(null);

/** Only door/captain/bar count as "modes" for picker purposes. Admin is full-access. */
const MODE_ROLES: StaffRole[] = ["hostess", "captain", "bartender"];

// 🆕 2026-06-05 v3.229 (Khushi) — When a staffer logs in via LoginPage they have
// ALREADY tapped a specific mode tile, so we honour that choice as the session's
// activeMode → the app-level ModePickerOverlay ("PICK YOUR MODE") never fires a
// redundant second pick. We only honour a preferred mode the staffer is actually
// allowed (their role, an admin's universal access, or the admin/boss tile for a
// manager). Otherwise we fall back to the legacy auto: single-mode users get
// their one mode; true multi-mode users (no explicit pick) still see the picker.
function resolveActiveMode(found: StaffMember, preferMode: StaffRole | null): StaffRole | null {
  const mine = rolesOf(found);
  const canBe = (m: StaffRole | null): m is StaffRole =>
    !!m && (
      mine.has(m) ||
      mine.has("admin") ||
      ((m === "admin" || m === "manager") && mine.has("manager"))
    );
  if (canBe(preferMode)) return preferMode;
  const modeRoles = Array.from(mine).filter((r) => MODE_ROLES.includes(r));
  return modeRoles.length === 1 ? modeRoles[0] : null;
}

export function StaffProvider({ children }: { children: ReactNode }) {
  const [currentStaff, setCurrentStaff] = useState<StaffMember | null>(null);
  const [sessionExpiresAt, setSessionExpiresAt] = useState<number | null>(null);
  const [activeMode, setActiveModeState] = useState<StaffRole | null>(null);
  const [firestoreStaff, setFirestoreStaff] = useState<StaffMember[]>([]);
  const [firestoreFailed, setFirestoreFailed] = useState(false);
  const [isIdleLocked, setIsIdleLocked] = useState(false);
  const fallbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 🆕 v3.227 — latest staff in a ref so logout()/idle timers can read WHO is
  // logged in without re-creating their identity on every staff change.
  const currentStaffRef = useRef<StaffMember | null>(null);
  const logoutRef = useRef<() => void>(() => {});
  useEffect(() => { currentStaffRef.current = currentStaff; }, [currentStaff]);
  const auditAuth = useCallback((action: string, s: StaffMember | null, extra?: Record<string, unknown>) => {
    if (!s) return;
    logAudit({ action, staffId: s.id || "", staffName: s.name, staffRole: s.role, details: { ...(extra || {}) } }).catch(() => {});
  }, []);

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

  // 🆕 2026-05-25 — MERGE Firestore staff with FALLBACK_STAFF roster.
  // Firestore wins on duplicate IDs (admin overrides take effect when Khushi
  // rotates a PIN), but the new HOD### roster ALWAYS exists even if Firestore
  // is empty/slow on a fresh tablet (fail-open per replit.md).
  const allStaff = (() => {
    if (firestoreStaff.length === 0 && !firestoreFailed) return [];  // still loading
    const byId = new Map<string, StaffMember>();
    for (const s of FALLBACK_STAFF) if (s.id) byId.set(s.id, s);
    // 🆕 2026-06-05 v3.228 — FIELD-merge Firestore over the seed roster (was a
    // full replace). Editing a seed staffer (e.g. an active-toggle or a role
    // change) writes only the changed keys to posStaff; a full replace would
    // drop the unwritten name/pin/active and break that staffer's login. Merging
    // keeps the fallback fields and overrides only what Firestore actually wrote.
    for (const s of firestoreStaff) {
      if (!s.id) continue;
      const base = byId.get(s.id);
      byId.set(s.id, base ? { ...base, ...s } : s);
    }
    return Array.from(byId.values());
  })();

  // Restore persisted session once staff list is available.
  useEffect(() => {
    if (currentStaff || allStaff.length === 0) return;
    const s = readSession();
    if (!s) return;
    const found = allStaff.find((m) => m.id === s.staffId && m.active);
    if (found) {
      setCurrentStaff(found);
      setSessionExpiresAt(s.expiresAt);
      setActiveModeState(s.activeMode ?? null);
    } else {
      clearSession();
    }
  }, [allStaff, currentStaff]);

  // Absolute 10-hr watchdog — boot out when window expires, even mid-session.
  useEffect(() => {
    if (!sessionExpiresAt) return;
    const ms = sessionExpiresAt - Date.now();
    if (ms <= 0) { setCurrentStaff(null); setSessionExpiresAt(null); setActiveModeState(null); clearSession(); return; }
    const t = setTimeout(() => {
      setCurrentStaff(null);
      setSessionExpiresAt(null);
      setActiveModeState(null);
      setIsIdleLocked(false);
      clearSession();
    }, ms);
    return () => clearTimeout(t);
  }, [sessionExpiresAt]);

  // 🆕 2026-06-05 v3.227 — Idle/away FULL LOGOUT after 15 min (was a re-PIN
  // lock). Activity = pointer/keyboard/touch. A visibilitychange guard also
  // logs out if the tab was hidden/backgrounded past the window (covers
  // background-throttled timers — when the tablet returns we re-check elapsed).
  useEffect(() => {
    if (!currentStaff) return;
    let lastActive = Date.now();
    const resetIdle = () => {
      lastActive = Date.now();
      if (idleTimer.current) clearTimeout(idleTimer.current);
      idleTimer.current = setTimeout(() => logoutRef.current(), IDLE_LOGOUT_MS);
    };
    resetIdle();
    const onVisibility = () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - lastActive >= IDLE_LOGOUT_MS) logoutRef.current();
      else resetIdle();
    };
    const events: Array<keyof WindowEventMap> = ["mousedown", "keydown", "touchstart", "pointerdown"];
    events.forEach((ev) => window.addEventListener(ev, resetIdle, { passive: true }));
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      events.forEach((ev) => window.removeEventListener(ev, resetIdle));
      document.removeEventListener("visibilitychange", onVisibility);
      if (idleTimer.current) clearTimeout(idleTimer.current);
    };
  }, [currentStaff]);

  const login = useCallback((pin: string, preferMode: StaffRole | null = null): boolean => {
    const found = allStaff.find((s) => s.pin === pin && s.active);
    if (found) {
      setCurrentStaff(found);
      if (found.id) {
        const exp = Date.now() + SESSION_TTL_MS;
        const chosen = resolveActiveMode(found, preferMode);
        writeSession(found.id, exp, chosen);
        setSessionExpiresAt(exp);
        setActiveModeState(chosen);
      }
      auditAuth("login", found, { via: "pin" });
      return true;
    }
    return false;
  }, [allStaff, auditAuth]);

  const loginByStaffId = useCallback((staffId: string, pin: string, preferMode: StaffRole | null = null): StaffMember | null => {
    const found = allStaff.find((s) => s.id === staffId && s.pin === pin && s.active);
    if (found) {
      setCurrentStaff(found);
      const exp = Date.now() + SESSION_TTL_MS;
      const chosen = resolveActiveMode(found, preferMode);
      writeSession(staffId, exp, chosen);
      setSessionExpiresAt(exp);
      setActiveModeState(chosen);
      setIsIdleLocked(false);
      auditAuth("login", found, { via: "id-pin" });
      return found;
    }
    return null;
  }, [allStaff, auditAuth]);

  const setActiveMode = useCallback((mode: StaffRole | null) => {
    setActiveModeState(mode);
    if (currentStaff?.id && sessionExpiresAt) {
      writeSession(currentStaff.id, sessionExpiresAt, mode);
    }
  }, [currentStaff, sessionExpiresAt]);

  const logout = useCallback(() => {
    auditAuth("logout", currentStaffRef.current);
    setCurrentStaff(null);
    setSessionExpiresAt(null);
    setActiveModeState(null);
    setIsIdleLocked(false);
    clearSession();
    // 🔴 2026-05-25 (code review fix) — also nuke ALL legacy per-page session
    // keys that Captain/Bar/Door pages still read on mount. Without this,
    // a 5-wrong-PIN idle-lock logout (or any logout) would leave the
    // mode-page dashboards reachable because their local state was hydrated
    // from sessionStorage. Belt-and-suspenders security.
    try {
      const keys = [
        "hod_captain_auth", "hod_captain_name", "hod_cap_fails", "hod_cap_lock",
        "hod_bar_staff", "hod_bar_fails", "hod_bar_lock",
        "hod_door_auth", "hod_door_name", "hod_door_fails", "hod_door_lock",
      ];
      for (const k of keys) sessionStorage.removeItem(k);
    } catch {}
  }, [auditAuth]);
  logoutRef.current = logout;

  const hasRole = useCallback((...roles: StaffRole[]): boolean => {
    if (!currentStaff) return false;
    const mine = rolesOf(currentStaff);
    if (mine.has("admin")) return true;  // admin = universal access
    return roles.some((r) => mine.has(r));
  }, [currentStaff]);

  const verifyManagerPin = useCallback((pin: string): StaffMember | null => {
    const found = allStaff.find((s) => {
      if (!s.active || s.pin !== pin) return false;
      const mine = rolesOf(s);
      return mine.has("manager") || mine.has("admin");
    });
    return found || null;
  }, [allStaff]);

  const unlockIdle = useCallback((pin: string): boolean => {
    if (!currentStaff) return false;
    if (currentStaff.pin === pin) {
      setIsIdleLocked(false);
      return true;
    }
    return false;
  }, [currentStaff]);

  // Derived values for mode picker.
  // 🔄 2026-05-25 (Khushi fix) — Picker fires ONLY when the user has 2+
  // EXPLICIT mode roles (hostess/captain/bartender). Admin universality is
  // NOT auto-expanded into all-3-modes anymore — owners/admins should land
  // straight on /admin (via LoginPage auto-route) instead of being forced to
  // pick a floor mode they don't actually work.
  const modeRolesForCurrent: StaffRole[] = currentStaff
    ? Array.from(rolesOf(currentStaff)).filter((r) => MODE_ROLES.includes(r))
    : [];
  const needsModePicker = !!currentStaff && modeRolesForCurrent.length > 1 && activeMode === null;

  return (
    <StaffContext.Provider
      value={{
        currentStaff,
        allStaff,
        login,
        loginByStaffId,
        logout,
        isLoggedIn: !!currentStaff,
        hasRole,
        verifyManagerPin,
        sessionExpiresAt,
        activeMode,
        setActiveMode,
        needsModePicker,
        isIdleLocked,
        unlockIdle,
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
