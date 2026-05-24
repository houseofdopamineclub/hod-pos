import { useState, useEffect } from "react";
import { db } from "@/lib/firebase";
import { collection, onSnapshot, query, where, orderBy, Timestamp } from "firebase/firestore";

interface AttendanceRecord {
  id: string;
  staffId: string;
  staffName: string;
  staffRole: string;
  phone: string;
  date: string;
  clockIn: Timestamp | null;
  clockInLocation: { lat: number; lng: number } | null;
  clockInDistance: number | null;
  clockInVideo: string | null;
  clockOut: Timestamp | null;
  clockOutLocation: { lat: number; lng: number } | null;
  clockOutDistance: number | null;
  clockOutVideo: string | null;
  createdAt: Timestamp | null;
}

const GOLD = "#C9A84C";
const CARD_BG = "hsl(240 12% 5%)";
const INPUT_BG = "hsl(240 12% 8%)";
const BORDER = "1px solid hsl(240 8% 18%)";
const TEXT_DIM = "hsl(36 29% 60%)";
const TEXT_MAIN = "hsl(36 29% 93%)";

function formatTime(ts: Timestamp | null): string {
  if (!ts) return "—";
  const d = ts.toDate();
  return d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true });
}

function formatDate(ts: Timestamp | null): string {
  if (!ts) return "—";
  const d = ts.toDate();
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

function getTodayStr(): string {
  const d = new Date();
  return d.toISOString().split("T")[0];
}

function getDuration(inTs: Timestamp | null, outTs: Timestamp | null): string {
  if (!inTs || !outTs) return "—";
  const diff = outTs.toMillis() - inTs.toMillis();
  if (diff <= 0) return "—";
  const hrs = Math.floor(diff / 3600000);
  const mins = Math.floor((diff % 3600000) / 60000);
  return `${hrs}h ${mins}m`;
}

export default function AttendanceAdmin() {
  const [records, setRecords] = useState<AttendanceRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [dateFilter, setDateFilter] = useState(getTodayStr());
  const [roleFilter, setRoleFilter] = useState("all");
  const [nameFilter, setNameFilter] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    const q = query(
      collection(db, "attendance"),
      where("date", "==", dateFilter),
      orderBy("createdAt", "desc")
    );
    const unsub = onSnapshot(q, (snap) => {
      const list: AttendanceRecord[] = snap.docs.map((d) => {
        const data = d.data();
        return {
          id: d.id,
          staffId: data.staffId || "",
          staffName: data.staffName || "Unknown",
          staffRole: data.staffRole || "",
          phone: data.phone || "",
          date: data.date || "",
          clockIn: data.clockIn || null,
          clockInLocation: data.clockInLocation || null,
          clockInDistance: data.clockInDistance || null,
          clockInVideo: data.clockInVideo || null,
          clockOut: data.clockOut || null,
          clockOutLocation: data.clockOutLocation || null,
          clockOutDistance: data.clockOutDistance || null,
          clockOutVideo: data.clockOutVideo || null,
          createdAt: data.createdAt || null,
        };
      });
      setRecords(list);
      setLoading(false);
    }, (err) => {
      console.error("[AttendanceAdmin] Firestore error:", err);
      // Fallback without orderBy if index missing
      const fallbackQ = query(collection(db, "attendance"), where("date", "==", dateFilter));
      const unsub2 = onSnapshot(fallbackQ, (snap2) => {
        const list: AttendanceRecord[] = snap2.docs.map((d) => {
          const data = d.data();
          return {
            id: d.id,
            staffId: data.staffId || "",
            staffName: data.staffName || "Unknown",
            staffRole: data.staffRole || "",
            phone: data.phone || "",
            date: data.date || "",
            clockIn: data.clockIn || null,
            clockInLocation: data.clockInLocation || null,
            clockInDistance: data.clockInDistance || null,
            clockInVideo: data.clockInVideo || null,
            clockOut: data.clockOut || null,
            clockOutLocation: data.clockOutLocation || null,
            clockOutDistance: data.clockOutDistance || null,
            clockOutVideo: data.clockOutVideo || null,
            createdAt: data.createdAt || null,
          };
        });
        setRecords(list.sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0)));
        setLoading(false);
      });
      return () => unsub2();
    });
    return () => unsub();
  }, [dateFilter]);

  const roles = Array.from(new Set(records.map((r) => r.staffRole).filter(Boolean)));

  const filtered = records.filter((r) => {
    if (roleFilter !== "all" && r.staffRole !== roleFilter) return false;
    if (nameFilter && !r.staffName.toLowerCase().includes(nameFilter.toLowerCase())) return false;
    return true;
  });

  const loggedInCount = records.filter((r) => r.clockIn && !r.clockOut).length;
  const loggedOutCount = records.filter((r) => r.clockIn && r.clockOut).length;

  const exportCSV = () => {
    const headers = ["Name", "Role", "Phone", "Date", "Login Time", "Logout Time", "Duration", "Login Distance(m)", "Logout Distance(m)"];
    const rows = filtered.map((r) => [
      r.staffName,
      r.staffRole,
      r.phone,
      r.date,
      formatTime(r.clockIn),
      formatTime(r.clockOut),
      getDuration(r.clockIn, r.clockOut),
      r.clockInDistance != null ? Math.round(r.clockInDistance) + "m" : "—",
      r.clockOutDistance != null ? Math.round(r.clockOutDistance) + "m" : "—",
    ]);
    const csv = [headers.join(","), ...rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(","))].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `hod-attendance-${dateFilter}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div>
      {/* Filters Row */}
      <div className="flex gap-3 mb-4 flex-wrap items-end">
        <div>
          <label className="text-xs block mb-1" style={{ color: TEXT_DIM }}>Date</label>
          <input
            type="date"
            value={dateFilter}
            onChange={(e) => setDateFilter(e.target.value)}
            className="px-3 py-2 rounded text-sm"
            style={{ background: INPUT_BG, border: BORDER, color: TEXT_MAIN }}
          />
        </div>
        <div>
          <label className="text-xs block mb-1" style={{ color: TEXT_DIM }}>Role</label>
          <select
            value={roleFilter}
            onChange={(e) => setRoleFilter(e.target.value)}
            className="px-3 py-2 rounded text-sm"
            style={{ background: INPUT_BG, border: BORDER, color: TEXT_MAIN }}
          >
            <option value="all">All Roles</option>
            {roles.map((r) => (
              <option key={r} value={r}>{r.charAt(0).toUpperCase() + r.slice(1)}</option>
            ))}
          </select>
        </div>
        <div className="flex-1 min-w-[150px]">
          <label className="text-xs block mb-1" style={{ color: TEXT_DIM }}>Search Name</label>
          <input
            type="text"
            placeholder="Search staff name..."
            value={nameFilter}
            onChange={(e) => setNameFilter(e.target.value)}
            className="w-full px-3 py-2 rounded text-sm"
            style={{ background: INPUT_BG, border: BORDER, color: TEXT_MAIN }}
          />
        </div>
        <button
          onClick={exportCSV}
          className="px-4 py-2 rounded-lg text-sm font-medium"
          style={{ background: "rgba(34,197,94,.15)", border: "1px solid rgba(34,197,94,.45)", color: "#22c55e" }}
        >
          📥 Export CSV
        </button>
      </div>

      {/* Summary */}
      <div className="flex gap-3 mb-4 flex-wrap">
        <div className="px-4 py-2 rounded-lg text-sm" style={{ background: CARD_BG, border: BORDER }}>
          <span style={{ color: TEXT_DIM }}>Total Records: </span>
          <span className="font-bold" style={{ color: GOLD }}>{filtered.length}</span>
        </div>
        <div className="px-4 py-2 rounded-lg text-sm" style={{ background: CARD_BG, border: BORDER }}>
          <span style={{ color: TEXT_DIM }}>Currently Logged In: </span>
          <span className="font-bold" style={{ color: "#22c55e" }}>{loggedInCount}</span>
        </div>
        <div className="px-4 py-2 rounded-lg text-sm" style={{ background: CARD_BG, border: BORDER }}>
          <span style={{ color: TEXT_DIM }}>Logged Out: </span>
          <span className="font-bold" style={{ color: "#ef4444" }}>{loggedOutCount}</span>
        </div>
      </div>

      {/* Records List */}
      {loading ? (
        <div className="text-center py-12 text-sm" style={{ color: TEXT_DIM }}>Loading attendance records...</div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-12 rounded-lg" style={{ border: "1px dashed hsl(240 8% 18%)", color: TEXT_DIM }}>
          No attendance records for {dateFilter}.
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((r) => {
            const isExpanded = expandedId === r.id;
            const isComplete = r.clockIn && r.clockOut;
            const isActive = r.clockIn && !r.clockOut;
            return (
              <div
                key={r.id}
                className="rounded-lg overflow-hidden"
                style={{ background: CARD_BG, border: BORDER }}
              >
                {/* Main Row */}
                <div
                  className="flex items-center justify-between px-4 py-3 cursor-pointer"
                  onClick={() => setExpandedId(isExpanded ? null : r.id)}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium" style={{ color: TEXT_MAIN }}>{r.staffName}</span>
                      <span
                        className="text-xs px-2 py-0.5 rounded"
                        style={{ background: "hsl(240 12% 10%)", color: GOLD }}
                      >
                        {r.staffRole}
                      </span>
                      {isActive && (
                        <span className="text-xs px-2 py-0.5 rounded" style={{ background: "rgba(34,197,94,.2)", color: "#22c55e" }}>
                          🟢 Logged In
                        </span>
                      )}
                      {isComplete && (
                        <span className="text-xs px-2 py-0.5 rounded" style={{ background: "rgba(100,100,100,.2)", color: "#888" }}>
                          ✅ Completed
                        </span>
                      )}
                    </div>
                    <div className="text-xs mt-1" style={{ color: TEXT_DIM }}>
                      📱 {r.phone || "No phone"} · 📅 {r.date}
                    </div>
                  </div>
                  <div className="flex items-center gap-4 ml-3 text-xs" style={{ color: TEXT_DIM }}>
                    <div className="text-center">
                      <div className="text-xs" style={{ color: "#22c55e" }}>LOGIN</div>
                      <div className="font-medium" style={{ color: TEXT_MAIN }}>{formatTime(r.clockIn)}</div>
                    </div>
                    <div style={{ color: "hsl(240 8% 25%)" }}>→</div>
                    <div className="text-center">
                      <div className="text-xs" style={{ color: "#ef4444" }}>LOGOUT</div>
                      <div className="font-medium" style={{ color: TEXT_MAIN }}>{formatTime(r.clockOut)}</div>
                    </div>
                    <div className="text-xs ml-2" style={{ color: GOLD }}>
                      {isExpanded ? "▲" : "▼"}
                    </div>
                  </div>
                </div>

                {/* Expanded Details */}
                {isExpanded && (
                  <div className="px-4 pb-4" style={{ borderTop: "1px solid hsl(240 8% 13%)" }}>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-3">
                      {/* Login Details */}
                      <div className="p-3 rounded" style={{ background: "hsl(240 12% 3%)" }}>
                        <div className="text-xs font-semibold mb-2" style={{ color: "#22c55e" }}>🟢 LOGIN DETAILS</div>
                        <div className="space-y-1 text-xs" style={{ color: TEXT_DIM }}>
                          <div>Time: <span style={{ color: TEXT_MAIN }}>{formatTime(r.clockIn)}</span></div>
                          <div>Date: <span style={{ color: TEXT_MAIN }}>{formatDate(r.clockIn)}</span></div>
                          {r.clockInLocation && (
                            <div>Location: <span style={{ color: TEXT_MAIN }}>{r.clockInLocation.lat.toFixed(6)}, {r.clockInLocation.lng.toFixed(6)}</span></div>
                          )}
                          {r.clockInDistance != null && (
                            <div>Distance from HOD: <span style={{ color: r.clockInDistance <= 200 ? "#22c55e" : "#ef4444" }}>{Math.round(r.clockInDistance)}m</span></div>
                          )}
                          {r.clockInVideo && (
                            <div>
                              <a
                                href={r.clockInVideo}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-block mt-1 px-3 py-1 rounded text-xs font-medium"
                                style={{ background: "rgba(201,168,76,.15)", border: "1px solid rgba(201,168,76,.4)", color: GOLD }}
                              >
                                🎥 View Login Video
                              </a>
                            </div>
                          )}
                        </div>
                      </div>

                      {/* Logout Details */}
                      <div className="p-3 rounded" style={{ background: "hsl(240 12% 3%)" }}>
                        <div className="text-xs font-semibold mb-2" style={{ color: "#ef4444" }}>🔴 LOGOUT DETAILS</div>
                        <div className="space-y-1 text-xs" style={{ color: TEXT_DIM }}>
                          {r.clockOut ? (
                            <>
                              <div>Time: <span style={{ color: TEXT_MAIN }}>{formatTime(r.clockOut)}</span></div>
                              <div>Date: <span style={{ color: TEXT_MAIN }}>{formatDate(r.clockOut)}</span></div>
                              {r.clockOutLocation && (
                                <div>Location: <span style={{ color: TEXT_MAIN }}>{r.clockOutLocation.lat.toFixed(6)}, {r.clockOutLocation.lng.toFixed(6)}</span></div>
                              )}
                              {r.clockOutDistance != null && (
                                <div>Distance from HOD: <span style={{ color: r.clockOutDistance <= 200 ? "#22c55e" : "#ef4444" }}>{Math.round(r.clockOutDistance)}m</span></div>
                              )}
                              <div>Duration: <span className="font-bold" style={{ color: GOLD }}>{getDuration(r.clockIn, r.clockOut)}</span></div>
                              {r.clockOutVideo && (
                                <div>
                                  <a
                                    href={r.clockOutVideo}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="inline-block mt-1 px-3 py-1 rounded text-xs font-medium"
                                    style={{ background: "rgba(201,168,76,.15)", border: "1px solid rgba(201,168,76,.4)", color: GOLD }}
                                  >
                                    🎥 View Logout Video
                                  </a>
                                </div>
                              )}
                            </>
                          ) : (
                            <div style={{ color: "#888" }}>Not logged out yet</div>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
