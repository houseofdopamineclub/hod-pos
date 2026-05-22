import { useState, useEffect } from "react";
import { db } from "@/lib/firebase";
import { collection, onSnapshot, query, where, orderBy } from "firebase/firestore";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { Calendar, Clock, MapPin, Camera, Search, Download, Users, CheckCircle, AlertTriangle } from "lucide-react";

// ═══════════════════════════════════════════
// ATTENDANCE ADMIN — View all records, export
// ═══════════════════════════════════════════

type StaffRole = "manager" | "captain" | "runner" | "steward";

interface AttendanceRecord {
  id: string;
  staffId: string;
  staffName: string;
  staffRole: StaffRole;
  phone: string;
  date: string;
  clockIn: any; // Firestore Timestamp
  clockInLocation: { lat: number; lng: number } | null;
  clockInDistance: number;
  clockInPhoto: string;
  clockOut: any; // Firestore Timestamp
  clockOutLocation: { lat: number; lng: number } | null;
  clockOutDistance: number;
  clockOutPhoto: string;
  createdAt: any;
}

const ROLE_COLORS: Record<string, string> = {
  manager: "bg-purple-500",
  captain: "bg-blue-500",
  runner: "bg-orange-500",
  steward: "bg-green-500",
};

const ROLE_LABELS: Record<string, string> = {
  manager: "Manager",
  captain: "Captain",
  runner: "Runner",
  steward: "Steward",
};

export default function AttendanceAdmin() {
  const { toast } = useToast();
  const [records, setRecords] = useState<AttendanceRecord[]>([]);
  const [filtered, setFiltered] = useState<AttendanceRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [dateFilter, setDateFilter] = useState(() => {
    const now = new Date();
    return now.toISOString().split("T")[0];
  });
  const [roleFilter, setRoleFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");

  // Real-time attendance records
  useEffect(() => {
    const q = query(
      collection(db, "attendance"),
      where("date", "==", dateFilter),
      orderBy("clockIn", "desc")
    );
    const unsub = onSnapshot(
      q,
      (snap) => {
        const list: AttendanceRecord[] = [];
        snap.forEach((doc) => list.push({ id: doc.id, ...doc.data() } as AttendanceRecord));
        setRecords(list);
        setLoading(false);
      },
      (err) => {
        console.warn("Attendance listener error (may need index):", err);
        // Fallback: query without orderBy
        const fallbackQ = query(collection(db, "attendance"), where("date", "==", dateFilter));
        onSnapshot(fallbackQ, (snap) => {
          const list: AttendanceRecord[] = [];
          snap.forEach((doc) => list.push({ id: doc.id, ...doc.data() } as AttendanceRecord));
          setRecords(list.sort((a, b) => (b.clockIn?.seconds || 0) - (a.clockIn?.seconds || 0)));
          setLoading(false);
        });
      }
    );
    return unsub;
  }, [dateFilter]);

  // Filter records
  useEffect(() => {
    let result = [...records];
    if (search) {
      const s = search.toLowerCase();
      result = result.filter(
        (r) =>
          r.staffName?.toLowerCase().includes(s) ||
          r.phone?.includes(s)
      );
    }
    if (roleFilter !== "all") {
      result = result.filter((r) => r.staffRole === roleFilter);
    }
    if (statusFilter === "present") {
      result = result.filter((r) => r.clockIn && !r.clockOut);
    } else if (statusFilter === "completed") {
      result = result.filter((r) => r.clockIn && r.clockOut);
    } else if (statusFilter === "late") {
      result = result.filter((r) => {
        if (!r.clockIn) return false;
        const clockInTime = r.clockIn.toDate ? r.clockIn.toDate() : new Date(r.clockIn);
        const hour = clockInTime.getHours();
        return hour >= 20; // Late if after 8 PM
      });
    }
    setFiltered(result);
  }, [records, search, roleFilter, statusFilter]);

  // Stats
  const totalStaff = new Set(records.map((r) => r.staffId)).size;
  const presentNow = records.filter((r) => r.clockIn && !r.clockOut).length;
  const completedShift = records.filter((r) => r.clockIn && r.clockOut).length;
  const lateArrivals = records.filter((r) => {
    if (!r.clockIn) return false;
    const d = r.clockIn.toDate ? r.clockIn.toDate() : new Date(r.clockIn);
    return d.getHours() >= 20;
  }).length;

  function formatTime(ts: any) {
    if (!ts) return "--:--";
    const d = ts.toDate ? ts.toDate() : new Date(ts);
    return d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true });
  }

  function getDuration(inTs: any, outTs: any) {
    if (!inTs) return "--";
    const start = inTs.toDate ? inTs.toDate() : new Date(inTs);
    const end = outTs ? (outTs.toDate ? outTs.toDate() : new Date(outTs)) : new Date();
    const mins = Math.floor((end.getTime() - start.getTime()) / 60000);
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return `${h}h ${m}m`;
  }

  function exportCSV() {
    const headers = ["Date", "Staff Name", "Role", "Phone", "Clock In", "Clock Out", "Duration", "Status"];
    const rows = filtered.map((r) => [
      r.date,
      r.staffName,
      ROLE_LABELS[r.staffRole] || r.staffRole,
      r.phone,
      formatTime(r.clockIn),
      formatTime(r.clockOut),
      getDuration(r.clockIn, r.clockOut),
      r.clockOut ? "Completed" : "Present",
    ]);
    const csv = [headers, ...rows].map((row) => row.map((c) => `"${c}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `hod-attendance-${dateFilter}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast({ title: "✅ Exported", description: `${filtered.length} records downloaded` });
  }

  return (
    <div className="p-6 max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
      <div>
          <h1 className="text-2xl font-bold text-[#F2C744]">📊 Attendance Dashboard</h1>
          <p className="text-sm text-gray-400 mt-1">Track staff clock-in/out with location & selfies</p>
        </div>
        <Button onClick={exportCSV} variant="outline" className="border-[#F2C744] text-[#F2C744] hover:bg-[#F2C744]/10">
          <Download className="w-4 h-4 mr-2" /> Export CSV
        </Button>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        <Card className="bg-[#111] border-[#2A2A2A]">
          <CardContent className="p-4 flex items-center gap-3">
            <Users className="w-8 h-8 text-blue-400" />
            <div>
              <div className="text-2xl font-bold text-white">{totalStaff}</div>
              <div className="text-xs text-gray-400 uppercase">Total Staff</div>
            </div>
          </CardContent>
        </Card>
        <Card className="bg-[#111] border-[#2A2A2A]">
          <CardContent className="p-4 flex items-center gap-3">
            <CheckCircle className="w-8 h-8 text-green-400" />
            <div>
              <div className="text-2xl font-bold text-white">{presentNow}</div>
              <div className="text-xs text-gray-400 uppercase">Present Now</div>
            </div>
          </CardContent>
        </Card>
        <Card className="bg-[#111] border-[#2A2A2A]">
          <CardContent className="p-4 flex items-center gap-3">
            <Clock className="w-8 h-8 text-[#F2C744]" />
            <div>
              <div className="text-2xl font-bold text-white">{completedShift}</div>
              <div className="text-xs text-gray-400 uppercase">Completed</div>
            </div>
          </CardContent>
        </Card>
        <Card className="bg-[#111] border-[#2A2A2A]">
          <CardContent className="p-4 flex items-center gap-3">
            <AlertTriangle className="w-8 h-8 text-red-400" />
            <div>
              <div className="text-2xl font-bold text-white">{lateArrivals}</div>
              <div className="text-xs text-gray-400 uppercase">Late Arrivals</div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <Card className="bg-[#111] border-[#2A2A2A] mb-6">
        <CardContent className="p-4">
          <div className="flex flex-wrap gap-4 items-center">
            <div className="flex items-center gap-2">
              <Calendar className="w-4 h-4 text-[#F2C744]" />
              <Input
                type="date"
                value={dateFilter}
                onChange={(e) => setDateFilter(e.target.value)}
                className="bg-[#1A1A1A] border-[#2A2A2A] text-white w-40"
              />
            </div>
            <div className="flex gap-2">
              {["all", "manager", "captain", "runner", "steward"].map((role) => (
                <Button
                  key={role}
                  variant={roleFilter === role ? "default" : "outline"}
                  size="sm"
                  onClick={() => setRoleFilter(role)}
                  className={
                    roleFilter === role
                      ? "bg-[#F2C744] text-black"
                      : "border-[#2A2A2A] text-gray-400 hover:text-white"
                  }
                >
                  {role === "all" ? "All Roles" : ROLE_LABELS[role]}
                </Button>
              ))}
            </div>
            <div className="flex gap-2">
              {[
                { key: "all", label: "All" },
                { key: "present", label: "Present" },
                { key: "completed", label: "Completed" },
                { key: "late", label: "Late" },
              ].map((s) => (
                <Button
                  key={s.key}
                  variant={statusFilter === s.key ? "default" : "outline"}
                  size="sm"
                  onClick={() => setStatusFilter(s.key)}
                  className={
                    statusFilter === s.key
                      ? "bg-[#F2C744] text-black"
                      : "border-[#2A2A2A] text-gray-400 hover:text-white"
                  }
                >
                  {s.label}
                </Button>
              ))}
            </div>
            <div className="ml-auto relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search staff..."
                className="pl-10 bg-[#1A1A1A] border-[#2A2A2A] text-white w-48"
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Records Table */}
      <Card className="bg-[#111] border-[#2A2A2A]">
        <CardHeader>
          <CardTitle className="text-[#F2C744] text-lg">
            Attendance Records — {dateFilter} ({filtered.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="text-center py-10 text-gray-400">Loading records...</div>
          ) : filtered.length === 0 ? (
            <div className="text-center py-10 text-gray-400">
              No attendance records for this date.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="border-[#2A2A2A] hover:bg-transparent">
                    <TableHead className="text-gray-400">Staff</TableHead>
                    <TableHead className="text-gray-400">Role</TableHead>
                    <TableHead className="text-gray-400">Clock In</TableHead>
                    <TableHead className="text-gray-400">Clock Out</TableHead>
                    <TableHead className="text-gray-400">Duration</TableHead>
                    <TableHead className="text-gray-400">Location</TableHead>
                    <TableHead className="text-gray-400">Photo</TableHead>
                    <TableHead className="text-gray-400">Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((record) => (
                    <TableRow key={record.id} className="border-[#2A2A2A] hover:bg-[#1A1A1A]">
                      <TableCell>
                        <div className="font-medium text-white">{record.staffName}</div>
                        <div className="text-xs text-gray-400">+91 {record.phone}</div>
                      </TableCell>
                      <TableCell>
                        <Badge className={`${ROLE_COLORS[record.staffRole] || "bg-gray-500"} text-white text-xs`}>
                          {ROLE_LABELS[record.staffRole] || record.staffRole}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-gray-300">{formatTime(record.clockIn)}</TableCell>
                      <TableCell className="text-gray-300">{formatTime(record.clockOut)}</TableCell>
                      <TableCell className="text-[#F2C744] font-medium">
                        {getDuration(record.clockIn, record.clockOut)}
                      </TableCell>
                      <TableCell>
                        {record.clockInDistance != null && (
                          <div className="flex items-center gap-1 text-xs text-gray-400">
                            <MapPin className="w-3 h-3" />
                            {record.clockInDistance}m
                            {record.clockInDistance <= 100 ? (
                              <span className="text-green-400">✓</span>
                            ) : (
                              <span className="text-red-400">✗</span>
                            )}
                          </div>
                        )}
                      </TableCell>
                      <TableCell>
                        {record.clockInPhoto && (
                          <a
                            href={record.clockInPhoto}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-[#F2C744] hover:underline text-xs flex items-center gap-1"
                          >
                            <Camera className="w-3 h-3" /> View
                          </a>
                        )}
                      </TableCell>
                      <TableCell>
                        {record.clockOut ? (
                          <Badge className="bg-green-500/20 text-green-400 border-green-500/30">Completed</Badge>
                        ) : (
                          <Badge className="bg-blue-500/20 text-blue-400 border-blue-500/30 animate-pulse">Present</Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
