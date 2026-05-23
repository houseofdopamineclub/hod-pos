import { useState, useEffect } from "react";
import { db } from "@/lib/firebase";
import { collection, doc, setDoc, updateDoc, deleteDoc, onSnapshot, query, where, getDocs } from "firebase/firestore";

type StaffRole = "admin" | "manager" | "captain" | "runner" | "steward" | "bartender" | "cashier";

interface StaffRecord {
  id: string;
  name: string;
  phone: string;
  pin: string;
  role: StaffRole;
  active: boolean;
}

const ROLE_OPTIONS: StaffRole[] = ["manager", "captain", "runner", "steward", "bartender", "cashier"];

export default function StaffManagement() {
  const [staffList, setStaffList] = useState<StaffRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formName, setFormName] = useState("");
  const [formPhone, setFormPhone] = useState("");
  const [formPin, setFormPin] = useState("");
  const [formRole, setFormRole] = useState<StaffRole>("steward");
  const [errMsg, setErrMsg] = useState("");

  // Real-time staff from 'staff' collection
  useEffect(() => {
    const q = query(collection(db, "staff"));
    const unsub = onSnapshot(q, (snap) => {
      const list: StaffRecord[] = [];
      snap.forEach((d) => {
        const data = d.data();
        list.push({
          id: d.id,
          name: data.name || "",
          phone: data.phone || "",
          pin: data.pin || "",
          role: (data.role as StaffRole) || "steward",
          active: data.active !== false,
        });
      });
      list.sort((a, b) => a.name.localeCompare(b.name));
      setStaffList(list);
      setLoading(false);
    }, () => { setLoading(false); });
    return unsub;
  }, []);

  const resetForm = () => {
    setFormName(""); setFormPhone(""); setFormPin(""); setFormRole("steward");
    setEditingId(null); setErrMsg("");
  };

  const openAdd = () => { resetForm(); setShowForm(true); };

  const openEdit = (s: StaffRecord) => {
    setFormName(s.name); setFormPhone(s.phone); setFormPin(s.pin);
    setFormRole(s.role); setEditingId(s.id); setShowForm(true); setErrMsg("");
  };

  const handleSave = async () => {
    setErrMsg("");
    if (!formName.trim() || formName.length < 2) { setErrMsg("Enter a valid name (min 2 chars)"); return; }
    if (!formPhone.match(/^\d{10}$/)) { setErrMsg("Enter a valid 10-digit phone number"); return; }
    if (!formPin.match(/^\d{4}$/)) { setErrMsg("PIN must be exactly 4 digits"); return; }

    try {
      // Check duplicate phone
      const dupQ = query(collection(db, "staff"), where("phone", "==", formPhone));
      const dupSnap = await getDocs(dupQ);
      if (dupSnap.docs.some((d) => d.id !== editingId)) {
        setErrMsg("Phone number already registered to another staff"); return;
      }

      const data = { name: formName.trim(), phone: formPhone, pin: formPin, role: formRole, active: true, updatedAt: new Date() };

      if (editingId) {
        await updateDoc(doc(db, "staff", editingId), data);
      } else {
        const newId = doc(collection(db, "staff")).id;
        await setDoc(doc(db, "staff", newId), { ...data, createdAt: new Date() });
      }
      setShowForm(false); resetForm();
    } catch (e: any) { setErrMsg("Save failed: " + e.message); }
  };

  const toggleActive = async (s: StaffRecord) => {
    await updateDoc(doc(db, "staff", s.id), { active: !s.active, updatedAt: new Date() });
  };

  const handleDelete = async (s: StaffRecord) => {
    if (!confirm(`DELETE ${s.name} permanently?`)) return;
    await deleteDoc(doc(db, "staff", s.id));
  };

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-sm font-semibold" style={{ color: "#C9A84C" }}>
            👥 Staff Management ({staffList.filter((s) => s.active).length} active)
          </h3>
          <p className="text-xs" style={{ color: "hsl(36 29% 50%)" }}>
            Add staff for attendance. Each needs: Name, Phone, 4-digit PIN, Role.
          </p>
        </div>
        <button onClick={openAdd} className="px-4 py-2 rounded text-sm font-bold" style={{ background: "#C9A84C", color: "#030305" }}>
          + Add Staff
        </button>
      </div>

      {/* Error */}
      {errMsg && (
        <div className="mb-3 p-3 rounded-lg text-xs font-bold" style={{ background: "rgba(239,68,68,.1)", border: "1px solid #EF4444", color: "#EF4444" }}>
          ⚠ {errMsg}
        </div>
      )}

      {/* Add/Edit Form */}
      {showForm && (
        <div className="mb-4 p-4 rounded-lg" style={{ background: "hsl(240 12% 5%)", border: "1px solid hsl(240 8% 18%)" }}>
          <h4 className="text-sm font-semibold mb-3" style={{ color: "#C9A84C" }}>
            {editingId ? "✏️ Edit Staff" : "➕ Add New Staff"}
          </h4>
          <div className="grid grid-cols-2 gap-3 mb-3">
            <div>
              <label className="text-xs block mb-1" style={{ color: "hsl(36 29% 60%)" }}>Full Name *</label>
              <input value={formName} onChange={(e) => setFormName(e.target.value)} placeholder="Rajesh Kumar"
                className="w-full px-3 py-2 rounded text-sm" style={{ background: "hsl(240 12% 8%)", border: "1px solid hsl(240 8% 18%)", color: "hsl(36 29% 93%)" }} />
            </div>
            <div>
              <label className="text-xs block mb-1" style={{ color: "hsl(36 29% 60%)" }}>Phone *</label>
              <div className="flex gap-2">
                <span className="flex items-center px-2 rounded text-sm" style={{ background: "hsl(240 12% 8%)", border: "1px solid hsl(240 8% 18%)", color: "hsl(36 29% 60%)" }}>+91</span>
                <input type="tel" value={formPhone} onChange={(e) => setFormPhone(e.target.value.replace(/\D/g, "").slice(0, 10))} placeholder="9876543210" maxLength={10}
                  className="flex-1 px-3 py-2 rounded text-sm" style={{ background: "hsl(240 12% 8%)", border: "1px solid hsl(240 8% 18%)", color: "hsl(36 29% 93%)" }} />
              </div>
            </div>
            <div>
              <label className="text-xs block mb-1" style={{ color: "hsl(36 29% 60%)" }}>4-Digit PIN *</label>
              <input type="password" value={formPin} onChange={(e) => setFormPin(e.target.value.replace(/\D/g, "").slice(0, 4))} placeholder="1234" maxLength={4}
                className="w-full px-3 py-2 rounded text-sm" style={{ background: "hsl(240 12% 8%)", border: "1px solid hsl(240 8% 18%)", color: "hsl(36 29% 93%)", letterSpacing: "4px" }} />
            </div>
            <div>
              <label className="text-xs block mb-1" style={{ color: "hsl(36 29% 60%)" }}>Role *</label>
              <select value={formRole} onChange={(e) => setFormRole(e.target.value as StaffRole)}
                className="w-full px-3 py-2 rounded text-sm" style={{ background: "hsl(240 12% 8%)", border: "1px solid hsl(240 8% 18%)", color: "hsl(36 29% 93%)" }}>
                {ROLE_OPTIONS.map((r) => <option key={r} value={r}>{r.charAt(0).toUpperCase() + r.slice(1)}</option>)}
              </select>
            </div>
          </div>
          <div className="flex gap-2">
            <button onClick={handleSave} className="px-4 py-2 rounded text-sm font-bold" style={{ background: "#C9A84C", color: "#030305" }}>
              {editingId ? "Update Staff" : "Add Staff"}
            </button>
            <button onClick={() => { setShowForm(false); resetForm(); }}
              className="px-4 py-2 rounded text-sm" style={{ background: "transparent", border: "1px solid hsl(240 8% 18%)", color: "hsl(36 29% 60%)" }}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Staff List */}
      {loading ? (
        <div className="text-center py-10 text-sm" style={{ color: "hsl(36 29% 60%)" }}>Loading staff...</div>
      ) : staffList.length === 0 ? (
        <div className="text-center py-10 rounded-lg" style={{ border: "1px dashed hsl(240 8% 18%)", color: "hsl(36 29% 50%)" }}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>👤</div>
          <div style={{ fontSize: 14, fontWeight: 700, color: "#fff" }}>No staff added yet</div>
          <div style={{ fontSize: 12, marginTop: 4 }}>Click "+ Add Staff" to register your first team member.</div>
        </div>
      ) : (
        <div className="space-y-2">
          {staffList.map((s) => (
            <div key={s.id} className="flex items-center justify-between px-3 py-3 rounded-lg" style={{ background: "hsl(240 12% 5%)", border: "1px solid hsl(240 8% 13%)" }}>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-sm font-medium truncate">{s.name}</span>
                  <span className="text-xs px-2 py-0.5 rounded font-bold" style={{ background: "hsl(240 12% 10%)", color: "#C9A84C" }}>{s.role}</span>
                  {!s.active && <span className="text-xs px-2 py-0.5 rounded" style={{ background: "rgba(239,68,68,.2)", color: "#EF4444" }}>INACTIVE</span>}
                </div>
                <div className="text-xs" style={{ color: "hsl(36 29% 50%)" }}>
                  📱 +91 {s.phone} · 🔐 PIN: ••••
                </div>
              </div>
              <div className="flex gap-2 ml-2">
                <button onClick={() => openEdit(s)}
                  className="text-xs px-3 py-1.5 rounded font-medium" style={{ background: "rgba(201,168,76,.12)", border: "1px solid rgba(201,168,76,.3)", color: "#C9A84C" }}>Edit</button>
                <button onClick={() => toggleActive(s)}
                  className="text-xs px-3 py-1.5 rounded font-medium" style={{ background: s.active ? "rgba(239,68,68,.12)" : "rgba(34,197,94,.12)", border: "1px solid " + (s.active ? "rgba(239,68,68,.3)" : "rgba(34,197,94,.3)"), color: s.active ? "#EF4444" : "#22C55E" }}>
                  {s.active ? "Deactivate" : "Activate"}
                </button>
                <button onClick={() => handleDelete(s)}
                  className="text-xs px-3 py-1.5 rounded font-medium" style={{ background: "rgba(107,107,138,.12)", border: "1px solid rgba(107,107,138,.3)", color: "#888" }}>Delete</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
