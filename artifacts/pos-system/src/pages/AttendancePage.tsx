import { useState, useEffect, useRef, useCallback } from "react";
import { db } from "@/lib/firebase";
import { collection, doc, setDoc, updateDoc, getDoc, query, where, getDocs, onSnapshot } from "firebase/firestore";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { Camera, MapPin, Clock, LogIn, LogOut, RotateCcw, ShieldCheck, UserCheck } from "lucide-react";

// ═══════════════════════════════════════════
// ATTENDANCE PAGE — Staff Clock-In/Out (POS)
// ═══════════════════════════════════════════

const HOD_LAT = 12.9279;
const HOD_LNG = 77.6216;
const HOD_RADIUS = 100; // meters

type StaffRole = "manager" | "captain" | "runner" | "steward";
type Screen = "phone" | "selfie" | "preview" | "dashboard";

interface StaffMember {
  id: string;
  name: string;
  phone: string;
  role: StaffRole;
}

interface AttendanceRecord {
  staffId: string;
  staffName: string;
  staffRole: StaffRole;
  phone: string;
  date: string;
  clockIn: any;
  clockInLocation: { lat: number; lng: number } | null;
  clockInDistance: number;
  clockInPhoto: string;
  clockOut: any;
  clockOutLocation: { lat: number; lng: number } | null;
  clockOutDistance: number;
  clockOutPhoto: string;
}

export default function AttendancePage() {
  const { toast } = useToast();
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const [screen, setScreen] = useState<Screen>("phone");
  const [phone, setPhone] = useState("");
  const [pin, setPin] = useState("");
  const [staff, setStaff] = useState<StaffMember | null>(null);
  const [selfieUrl, setSelfieUrl] = useState<string | null>(null);
  const [selfieBlob, setSelfieBlob] = useState<Blob | null>(null);
  const [location, setLocation] = useState<{ lat: number; lng: number; distance: number; inside: boolean } | null>(null);
  const [todayRecord, setTodayRecord] = useState<AttendanceRecord | null>(null);
  const [history, setHistory] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [isClockedIn, setIsClockedIn] = useState(false);
  const [duration, setDuration] = useState("0h 0m");

  // ── Haversine distance ──
  const getDistance = useCallback((lat1: number, lon1: number, lat2: number, lon2: number) => {
    const R = 6371000;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLon = ((lon2 - lon1) * Math.PI) / 180;
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos((lat1 * Math.PI) / 180) *
        Math.cos((lat2 * Math.PI) / 180) *
        Math.sin(dLon / 2) *
        Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return Math.round(R * c);
  }, []);

  // ── Get location ──
  const getLocation = useCallback((): Promise<{ lat: number; lng: number; distance: number; inside: boolean }> => {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) {
        reject(new Error("Geolocation not supported"));
        return;
      }
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const dist = getDistance(pos.coords.latitude, pos.coords.longitude, HOD_LAT, HOD_LNG);
          const result = { lat: pos.coords.latitude, lng: pos.coords.longitude, distance: dist, inside: dist <= HOD_RADIUS };
          setLocation(result);
          resolve(result);
        },
        (err) => reject(new Error("Location access denied: " + err.message)),
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
      );
    });
  }, [getDistance]);

  // ── Verify phone + PIN ──
  const verifyPhone = async () => {
    const cleanPhone = phone.replace(/\D/g, "").slice(-10);
    if (cleanPhone.length !== 10) {
      toast({ title: "Error", description: "Enter valid 10-digit phone number", variant: "destructive" });
      return;
    }
    if (pin.length < 4) {
      toast({ title: "Error", description: "Enter your 4-digit PIN", variant: "destructive" });
      return;
    }

    setLoading(true);
    try {
      const q = query(collection(db, "staff"), where("phone", "==", cleanPhone), where("active", "==", true));
      const snap = await getDocs(q);
      if (snap.empty) {
        toast({ title: "Error", description: "Phone not registered. Contact manager.", variant: "destructive" });
        setLoading(false);
        return;
      }

      const doc = snap.docs[0];
      const staffData = { id: doc.id, ...doc.data() } as StaffMember;

      // Verify PIN (stored in staff doc)
      const staffDoc = await getDoc(doc.ref);
      const staffFullData = staffDoc.data();
      if (staffFullData?.pin !== pin) {
        toast({ title: "Error", description: "Incorrect PIN. Try again.", variant: "destructive" });
        setLoading(false);
        return;
      }

      setStaff(staffData);

      // Check today's record
      const today = new Date();
      const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
      const recDoc = await getDoc(doc(db, "attendance", staffData.id + "_" + dateStr));

      if (recDoc.exists()) {
        const rec = recDoc.data() as AttendanceRecord;
        setTodayRecord(rec);
        setIsClockedIn(!!rec.clockIn && !rec.clockOut);
        setScreen("dashboard");
        loadHistory(staffData.id);
      } else {
        // No record today → go to selfie for clock-in
        setScreen("selfie");
      }

      toast({ title: "✅ Welcome", description: staffData.name });
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    }
    setLoading(false);
  };

  // ── Start camera ──
  const startCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" }, audio: false });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
    } catch (err) {
      toast({ title: "Camera Error", description: "Could not access camera. Enable permissions.", variant: "destructive" });
    }
  };

  const stopCamera = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  };

  // ── Capture selfie ──
  const captureSelfie = () => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;

    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d")?.drawImage(video, 0, 0);

    canvas.toBlob(
      (blob) => {
        if (blob) {
          setSelfieBlob(blob);
          setSelfieUrl(canvas.toDataURL("image/jpeg", 0.85));
        }
        stopCamera();
        setScreen("preview");
      },
      "image/jpeg",
      0.85
    );
  };

  // ── Confirm attendance ──
  const confirmAttendance = async () => {
    if (!staff || !selfieBlob) return;

    setLoading(true);
    try {
      // Get location
      const loc = await getLocation();
      if (!loc.inside) {
        toast({ title: "❌ Too far", description: `You are ${loc.distance}m away. Must be within 100m of HOD.`, variant: "destructive" });
        setLoading(false);
        return;
      }

      // Upload selfie to Firebase Storage (using data URL for simplicity)
      const today = new Date();
      const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
      const docId = staff.id + "_" + dateStr;

      // Convert blob to base64 for Firestore storage (or use Firebase Storage)
      const reader = new FileReader();
      reader.readAsDataURL(selfieBlob);
      const base64Photo = await new Promise<string>((resolve) => {
        reader.onloadend = () => resolve(reader.result as string);
      });

      if (isClockedIn && todayRecord) {
        // Clock Out
        await updateDoc(doc(db, "attendance", docId), {
          clockOut: new Date(),
          clockOutLocation: { lat: loc.lat, lng: loc.lng },
          clockOutDistance: loc.distance,
          clockOutPhoto: base64Photo,
          updatedAt: new Date(),
        });
        toast({ title: "✅ Clocked Out", description: `Goodbye, ${staff.name}!` });
        setIsClockedIn(false);
      } else {
        // Clock In
        await setDoc(doc(db, "attendance", docId), {
          staffId: staff.id,
          staffName: staff.name,
          staffRole: staff.role,
          phone: staff.phone,
          date: dateStr,
          clockIn: new Date(),
          clockInLocation: { lat: loc.lat, lng: loc.lng },
          clockInDistance: loc.distance,
          clockInPhoto: base64Photo,
          clockOut: null,
          clockOutLocation: null,
          clockOutPhoto: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        toast({ title: "✅ Clocked In", description: `Welcome, ${staff.name}!` });
        setIsClockedIn(true);
      }

      // Refresh record
      const recDoc = await getDoc(doc(db, "attendance", docId));
      if (recDoc.exists()) setTodayRecord(recDoc.data() as AttendanceRecord);

      setSelfieBlob(null);
      setSelfieUrl(null);
      setScreen("dashboard");
      loadHistory(staff.id);
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    }
    setLoading(false);
  };

  // ── Load history ──
  const loadHistory = async (staffId: string) => {
    const q = query(collection(db, "attendance"), where("staffId", "==", staffId));
    const snap = await getDocs(q);
    const list: any[] = [];
    snap.forEach((d) => list.push({ id: d.id, ...d.data() }));
    list.sort((a, b) => (b.clockIn?.seconds || 0) - (a.clockIn?.seconds || 0));
    setHistory(list.slice(0, 10));
  };

  // ── Duration timer ──
  useEffect(() => {
    if (!isClockedIn || !todayRecord?.clockIn) return;
    const interval = setInterval(() => {
      const start = todayRecord.clockIn.toDate ? todayRecord.clockIn.toDate() : new Date(todayRecord.clockIn);
      const diff = Math.floor((Date.now() - start.getTime()) / 60000);
      const h = Math.floor(diff / 60);
      const m = diff % 60;
      setDuration(`${h}h ${m}m`);
    }, 60000);
    return () => clearInterval(interval);
  }, [isClockedIn, todayRecord]);

  // ── Format time ──
  const fmtTime = (ts: any) => {
    if (!ts) return "--:--";
    const d = ts.toDate ? ts.toDate() : new Date(ts);
    return d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true });
  };

  // ── Screens ──

  // PHONE LOGIN SCREEN
  if (screen === "phone") {
    return (
      <div className="min-h-screen bg-[#0A0A0A] flex items-center justify-center p-4">
        <Card className="bg-[#111] border-[#2A2A2A] w-full max-w-md">
          <CardContent className="p-6 space-y-6">
            <div className="text-center">
              <div className="text-4xl mb-2">📍</div>
              <h1 className="text-xl font-bold text-[#F2C744]">HOD Attendance</h1>
              <p className="text-xs text-gray-400 mt-1">Clock in with your phone number and PIN</p>
            </div>

            <div className="space-y-4">
              <div>
                <label className="text-xs text-gray-400 uppercase tracking-wider">Phone Number</label>
                <div className="flex gap-2 mt-1">
                  <span className="flex items-center px-3 bg-[#1A1A1A] border border-[#2A2A2A] rounded-lg text-sm text-gray-400">
                    🇮🇳 +91
                  </span>
                  <Input
                    type="tel"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value.replace(/\D/g, "").slice(0, 10))}
                    placeholder="9876543210"
                    maxLength={10}
                    className="flex-1 bg-[#1A1A1A] border-[#2A2A2A] text-white"
                    onKeyDown={(e) => e.key === "Enter" && verifyPhone()}
                  />
                </div>
              </div>

              <div>
                <label className="text-xs text-gray-400 uppercase tracking-wider">4-Digit PIN</label>
                <Input
                  type="password"
                  value={pin}
                  onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
                  placeholder="••••"
                  maxLength={4}
                  className="mt-1 bg-[#1A1A1A] border-[#2A2A2A] text-white text-center tracking-[0.5em]"
                  onKeyDown={(e) => e.key === "Enter" && verifyPhone()}
                />
              </div>

              <Button
                onClick={verifyPhone}
                disabled={loading}
                className="w-full bg-[#F2C744] text-black hover:bg-[#B8963E] font-bold h-12"
              >
                {loading ? "Verifying..." : (
                  <>
                    <ShieldCheck className="w-4 h-4 mr-2" /> Verify & Login
                  </>
                )}
              </Button>
            </div>

            <p className="text-[10px] text-gray-500 text-center leading-relaxed">
              🔒 Your phone and PIN are only used for attendance verification.
              <br />📍 Location checked to ensure you're at HOD premises.
              <br />📸 Selfie captured for attendance record.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  // SELFIE SCREEN
  if (screen === "selfie") {
    return (
      <div className="min-h-screen bg-[#0A0A0A] flex flex-col">
        <div className="h-14 bg-[#111] border-b border-[#2A2A2A] flex items-center justify-between px-4">
          <Button variant="ghost" size="sm" onClick={() => { stopCamera(); setScreen(isClockedIn ? "dashboard" : "phone"); }} className="text-gray-400">
            ← Back
          </Button>
          <span className="text-[#F2C744] font-bold">{isClockedIn ? "Clock Out" : "Clock In"} — Selfie</span>
          <div className="w-16" />
        </div>

        <div className="flex-1 p-4 space-y-4 overflow-y-auto">
          <Card className="bg-[#111] border-[#2A2A2A]">
            <CardContent className="p-3">
              <div className="flex items-center justify-center gap-2 mb-2">
                <span className="font-bold text-white">{staff?.name}</span>
                <Badge className="bg-green-500/20 text-green-400">{staff?.role}</Badge>
              </div>
              <div className={`flex items-center gap-2 p-2 rounded-lg text-xs font-bold ${
                location?.inside ? "bg-green-500/10 text-green-400" : location ? "bg-red-500/10 text-red-400" : "bg-blue-500/10 text-blue-400"
              }`}>
                <MapPin className="w-3 h-3" />
                {location?.inside
                  ? `✅ Inside HOD (${location.distance}m)`
                  : location
                  ? `❌ ${location.distance}m away — must be within 100m`
                  : "📍 Getting location..."}
              </div>
            </CardContent>
          </Card>

          <div className="relative aspect-[3/4] bg-black rounded-2xl overflow-hidden border-2 border-[#2A2A2A]">
            <video ref={videoRef} autoPlay playsInline muted className="w-full h-full object-cover" />
            <div className="absolute inset-x-0 bottom-0 p-4 bg-gradient-to-t from-black/80 to-transparent flex flex-col items-center gap-3">
              <span className="text-xs text-white/80">Position your face in the frame</span>
              <button
                onClick={captureSelfie}
                className="w-16 h-16 rounded-full bg-red-500 border-4 border-white shadow-lg hover:scale-105 active:scale-95 transition-transform"
              />
            </div>
          </div>

          <p className="text-[10px] text-gray-500 text-center">
            Tap the red button to capture. Your selfie is stored securely for attendance records only.
          </p>
        </div>

        {useEffect(() => { startCamera(); getLocation(); return () => stopCamera(); }, [])}
      </div>
    );
  }

  // PREVIEW SCREEN
  if (screen === "preview") {
    return (
      <div className="min-h-screen bg-[#0A0A0A] flex flex-col">
        <div className="h-14 bg-[#111] border-b border-[#2A2A2A] flex items-center justify-center">
          <span className="text-[#F2C744] font-bold">Confirm {isClockedIn ? "Clock Out" : "Clock In"}</span>
        </div>

        <div className="flex-1 p-4 space-y-4 overflow-y-auto">
          <div className="text-center">
            <div className="text-3xl mb-1">📸</div>
            <div className="font-bold text-white">{staff?.name}</div>
            <Badge className="bg-green-500/20 text-green-400 mt-1">{staff?.role}</Badge>
          </div>

          {selfieUrl && (
            <img src={selfieUrl} alt="Selfie preview" className="w-full aspect-[3/4] object-cover rounded-2xl border-2 border-[#2A2A2A]" />
          )}

          <div className="grid grid-cols-2 gap-3">
            <Card className="bg-[#1A1A1A] border-[#2A2A2A]">
              <CardContent className="p-3 text-center">
                <div className="text-[10px] text-gray-400 uppercase">Location</div>
                <div className={`text-sm font-bold ${location?.inside ? "text-green-400" : "text-red-400"}`}>
                  {location?.inside ? "✅ Inside" : "❌ Outside"}
                </div>
              </CardContent>
            </Card>
            <Card className="bg-[#1A1A1A] border-[#2A2A2A]">
              <CardContent className="p-3 text-center">
                <div className="text-[10px] text-gray-400 uppercase">Distance</div>
                <div className="text-sm font-bold text-[#F2C744]">{location?.distance}m</div>
              </CardContent>
            </Card>
            <Card className="bg-[#1A1A1A] border-[#2A2A2A]">
              <CardContent className="p-3 text-center">
                <div className="text-[10px] text-gray-400 uppercase">Time</div>
                <div className="text-sm font-bold text-white">
                  {new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true })}
                </div>
              </CardContent>
            </Card>
            <Card className="bg-[#1A1A1A] border-[#2A2A2A]">
              <CardContent className="p-3 text-center">
                <div className="text-[10px] text-gray-400 uppercase">Type</div>
                <div className="text-sm font-bold text-white">{isClockedIn ? "Clock Out" : "Clock In"}</div>
              </CardContent>
            </Card>
          </div>

          <Button
            onClick={confirmAttendance}
            disabled={loading || !location?.inside}
            className="w-full bg-[#F2C744] text-black hover:bg-[#B8963E] font-bold h-12"
          >
            {loading ? "Saving..." : (
              <>
                <UserCheck className="w-4 h-4 mr-2" /> Confirm {isClockedIn ? "Clock Out" : "Clock In"}
              </>
            )}
          </Button>

          <Button
            onClick={() => { setSelfieUrl(null); setSelfieBlob(null); setScreen("selfie"); }}
            variant="outline"
            className="w-full border-[#2A2A2A] text-gray-400 hover:text-white"
          >
            <RotateCcw className="w-4 h-4 mr-2" /> Retake Selfie
          </Button>
        </div>
      </div>
    );
  }

  // DASHBOARD SCREEN
  return (
    <div className="min-h-screen bg-[#0A0A0A]">
      <div className="h-14 bg-[#111] border-b border-[#2A2A2A] flex items-center justify-between px-4">
        <span className="text-[#F2C744] font-bold">My Attendance</span>
        <Button variant="ghost" size="sm" onClick={() => { setStaff(null); setScreen("phone"); setPhone(""); setPin(""); }} className="text-gray-400 text-xs">
          Logout
        </Button>
      </div>

      <div className="p-4 space-y-4 max-w-md mx-auto">
        {/* Staff Info */}
        <Card className="bg-[#111] border-[#2A2A2A]">
          <CardContent className="p-4 text-center">
            <div className="font-bold text-lg text-white">{staff?.name}</div>
            <div className="text-xs text-gray-400">+91 {staff?.phone}</div>
            <Badge className="mt-2 bg-blue-500/20 text-blue-400">{staff?.role}</Badge>
          </CardContent>
        </Card>

        {/* Status */}
        <Card className={`border ${isClockedIn ? "border-green-500/30 bg-green-500/5" : "border-[#2A2A2A] bg-[#111]"}`}>
          <CardContent className="p-4 text-center">
            <div className="text-3xl mb-1">{isClockedIn ? "🟢" : "⚪"}</div>
            <div className={`font-bold ${isClockedIn ? "text-green-400" : "text-gray-400"}`}>
              {isClockedIn ? "Currently Clocked In" : "Not Clocked In"}
            </div>
            {isClockedIn && todayRecord && (
              <div className="text-xs text-gray-400 mt-1">
                Started at {fmtTime(todayRecord.clockIn)} · Duration: {duration}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Action Button */}
        <Button
          onClick={() => setScreen("selfie")}
          className={`w-full h-14 font-bold text-lg ${
            isClockedIn
              ? "bg-red-500 hover:bg-red-600 text-white"
              : "bg-green-500 hover:bg-green-600 text-white"
          }`}
        >
          {isClockedIn ? (
            <><LogOut className="w-5 h-5 mr-2" /> Clock Out</>
          ) : (
            <><LogIn className="w-5 h-5 mr-2" /> Clock In Now</>
          )}
        </Button>

        {/* Recent History */}
        <div>
          <h3 className="text-xs text-gray-400 uppercase tracking-wider mb-3">📋 Recent History</h3>
          {history.length === 0 ? (
            <div className="text-center py-6 text-gray-500 text-sm">No attendance records yet</div>
          ) : (
            <div className="space-y-2">
              {history.map((h) => (
                <Card key={h.id} className="bg-[#1A1A1A] border-[#2A2A2A]">
                  <CardContent className="p-3 flex items-center gap-3">
                    <span className="text-lg">{h.clockOut ? "✅" : "🟢"}</span>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-white truncate">
                        {h.date} · {h.clockOut ? "Completed" : "In Progress"}
                      </div>
                      <div className="text-xs text-gray-400">
                        In: {fmtTime(h.clockIn)} {h.clockOut && `· Out: ${fmtTime(h.clockOut)}`}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
