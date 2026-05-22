import { useState, useEffect } from "react";
import { db } from "@/lib/firebase";
import { collection, doc, setDoc, updateDoc, deleteDoc, onSnapshot, query, where, getDocs } from "firebase/firestore";

type StaffRole = "manager" | "captain" | "runner" | "steward" | "bartender" | "cashier" | "admin";

interface StaffMember {
  id: string;
  name: string;
  phone: string;
  pin: string;
  role: StaffRole;
  active: boolean;
  createdAt?: Date;
}

const ROLE_LABELS: Record<string, string> = {
  admin: "Admin",
  manager: "Manager",
  captain: "Captain",
  runner: "Runner",
  steward: "Steward",
  bartender: "Bartender",
  cashier: "Cashier",
};

const ROLE_COLORS: Record<string, string> = {
  admin: "bg-purple-500",
  manager: "bg-blue-500",
  captain: "bg-cyan-500",
  runner: "bg-orange-500",
  steward: "bg-green-500",
  bartender: "bg-pink-500",
  cashier: "bg-yellow-500",
};

export default function StaffManagement() {
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({
    name: "",
    phone: "",
    pin: "",
    role: "steward" as StaffRole,
    active: true,
  });
  const [error, setError] = useState("");

  // Real-time staff list from 'staff' collection
  useEffect(() => {
    const q = query(collection(db, "staff"));
    const unsub = onSnapshot(
      q,
      (snap) => {
        const list: StaffMember[] = [];
        snap.forEach((doc) => {
          const d = doc.data();
          list.push({
            id: doc.id,
            name: d.name || "",
            phone: d.phone || "",
            pin: d.pin || "",
            role: (d.role as StaffRole) || "steward",
            active: d.active !== false,
          });
        });
        list.sort((a, b) => a.name.localeCompare(b.name));
        setStaff(list);
        setLoading(false);
      },
      (err) => {
        console.error("Staff listener error:", err);
        setError("Failed to load staff: " + err.message);
        setLoading(false);
      }
    );
    return unsub;
  }, []);

  const resetForm = () => {
    setForm({ name: "", phone: "", pin: "", role: "steward", active: true });
    setEditingId(null);
    setError("");
  };

  const openAdd = () => {
    resetForm();
    setShowForm(true);
  };

  const openEdit = (member: StaffMember) => {
    setForm({
      name: member.name,
      phone: member.phone,
      pin: member.pin,
      role: member.role,
      active: member.active,
    });
    setEditingId(member.id);
    setShowForm(true);
  };

  const handleSave = async () => {
    setError("");

    // Validation
    if (!form.name.trim() || form.name.length < 2) {
      setError("Enter a valid name (min 2 characters)");
      return;
    }
    if (!form.phone.match(/^\d{10}$/)) {
      setError("Enter a valid 10-digit phone number");
      return;
    }
    if (!form.pin.match(/^\d{4}$/)) {
      setError("PIN must be exactly 4 digits");
      return;
    }

    setSaving(true);
    try {
      const cleanPhone = form.phone.replace(/\D/g, "").slice(-10);

      // Check duplicate phone (skip if editing same record)
      const dupQuery = query(collection(db, "staff"), where("phone", "==", cleanPhone));
      const dupSnap = await getDocs(dupQuery);
      const isDuplicate = dupSnap.docs.some((d) => d.id !== editingId);
      if (isDuplicate) {
        setError("Phone number already registered to another staff");
        setSaving(false);
        return;
      }

      const data = {
        name: form.name.trim(),
        phone: cleanPhone,
        pin: form.pin,
        role: form.role,
        active: form.active,
        updatedAt: new Date(),
      };

      if (editingId) {
        await updateDoc(doc(db, "staff", editingId), data);
      } else {
        const newId = doc(collection(db, "staff")).id;
        await setDoc(doc(db, "staff", newId), {
          ...data,
          createdAt: new Date(),
        });
      }

      setShowForm(false);
      resetForm();
    } catch (err: any) {
      setError("Save failed: " + err.message);
    }
    setSaving(false);
  };

  const handleDeactivate = async (member: StaffMember) => {
    if (!confirm(`Deactivate ${member.name}? They won't be able to clock in.`)) return;
    try {
      await updateDoc(doc(db, "staff", member.id), {
        active: false,
        updatedAt: new Date(),
      });
    } catch (err: any) {
      setError("Deactivate failed: " + err.message);
    }
  };

  const handleDelete = async (member: StaffMember) => {
    if (!confirm(`DELETE ${member.name} permanently? This cannot be undone.`)) return;
    try {
      await deleteDoc(doc(db, "staff", member.id));
    } catch (err: any) {
      setError("Delete failed: " + err.message);
    }
  };

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-sm font-semibold" style={{ color: "#C9A84C" }}>
            👥 Staff Management ({staff.filter((s) => s.active).length} active)
          </h3>
          <p className="text-xs" style={{ color: "hsl(36 29% 50%)" }}>
            Add staff for attendance tracking. Each staff needs name, phone, 4-digit PIN, and role.
          </p>
        </div>
        <button
          onClick={openAdd}
          className="px-4 py-2 rounded text-sm font-bold"
          style={{ background: "#C9A84C", color: "#030305" }}
        >
          + Add Staff
        </button>
      </div>

      {/* Error */}
      {error && (
        <div
          className="mb-3 p-3 rounded-lg text-xs font-bold"
          style={{ background: "rgba(239,68,68,.1)", border: "1px solid #EF4444", color: "#EF4444" }}
        >
          ⚠ {error}
        </div>
      )}

      {/* Add/Edit Form */}
      {showForm && (
        <div
          className="mb-4 p-4 rounded-lg"
          style={{ background: "hsl(240 12% 5%)", border: "1px solid hsl(240 8% 18%)" }}
        >
          <h4 className="text-sm font-semibold mb-3" style={{ color: "#C9A84C" }}>
            {editingId ? "✏️ Edit Staff" : "➕ Add New Staff"}
          </h4>
          <div className="grid grid-cols-2 gap-3 mb-3">
            <div>
              <label className="text-xs block mb-1" style={{ color: "hsl(36 29% 60%)" }}>
                Full Name *
              </label>
              <input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="e.g. Rajesh Kumar"
                className="w-full px-3 py-2 rounded text-sm"
                style={{
                  background: "hsl(240 12% 8%)",
                  border: "1px solid hsl(240 8% 18%)",
                  color: "hsl(36 29% 93%)",
                }}
              />
            </div>
            <div>
              <label className="text-xs block mb-1" style={{ color: "hsl(36 29% 60%)" }}>
                Phone Number *
              </label>
              <div className="flex gap-2">
                <span
                  className="flex items-center px-2 rounded text-sm"
                  style={{
                    background: "hsl(240 12% 8%)",
                    border: "1px solid hsl(240 8% 18%)",
                    color: "hsl(36 29% 60%)",
                  }}
                >
                  +91
                </span>
                <input
                  type="tel"
                  value={form.phone}
                  onChange={(e) =>
                    setForm({ ...form, phone: e.target.value.replace(/\D/g, "").slice(0, 10) })
                  }
                  placeholder="9876543210"
                  maxLength={10}
                  className="flex-1 px-3 py-2 rounded text-sm"
                  style={{
                    background: "hsl(240 12% 8%)",
                    border: "1px solid hsl(240 8% 18%)",
                    color: "hsl(36 29% 93%)",
                  }}
                />
              </div>
            </div>
            <div>
              <label className="text-xs block mb-1" style={{ color: "hsl(36 29% 60%)" }}>
                4-Digit PIN *
              </label>
              <input
                type="password"
                value={form.pin}
                onChange={(e) => setForm({ ...form, pin: e.target.value.replace(/\D/g, "").slice(0, 4) })}
                placeholder="1234"
                maxLength={4}
                className="w-full px-3 py-2 rounded text-sm"
                style={{
                  background: "hsl(240 12% 8%)",
                  border: "1px solid hsl(240 8% 18%)",
                  color: "hsl(36 29% 93%)",
                  letterSpacing: "4px",
                }}
              />
            </div>
            <div>
              <label className="text-xs block mb-1" style={{ color: "hsl(36 29% 60%)" }}>
                Role *
              </label>
              <select
                value={form.role}
                onChange={(e) => setForm({ ...form, role: e.target.value as StaffRole })}
                className="w-full px-3 py-2 rounded text-sm"
                style={{
                  background: "hsl(240 12% 8%)",
                  border: "1px solid hsl(240 8% 18%)",
                  color: "hsl(36 29% 93%)",
                }}
              >
                {Object.entries(ROLE_LABELS).map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="flex gap-2">
            <button
              onClick={handleSave}
              disabled={saving}
              className="px-4 py-2 rounded text-sm font-bold"
              style={{ background: "#C9A84C", color: "#030305", opacity: saving ? 0.5 : 1 }}
            >
              {saving ? "Saving..." : editingId ? "Update Staff" : "Add Staff"}
            </button>
            <button
              onClick={() => { setShowForm(false); resetForm(); }}
              className="px-4 py-2 rounded text-sm"
              style={{
                background: "transparent",
                border: "1px solid hsl(240 8% 18%)",
                color: "hsl(36 29% 60%)",
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Staff List */}
      {loading ? (
        <div className="text-center py-10 text-sm" style={{ color: "hsl(36 29% 60%)" }}>
          Loading staff...
        </div>
      ) : staff.length === 0 ? (
        <div
          className="text-center py-10 rounded-lg"
          style={{ border: "1px dashed hsl(240 8% 18%)", color: "hsl(36 29% 50%)" }}
        >
          <div style={{ fontSize: 32, marginBottom: 8 }}>👤</div>
          <div style={{ fontSize: 14, fontWeight: 700, color: "#fff" }}>No staff added yet</div>
          <div style={{ fontSize: 12, marginTop: 4 }}>
            Click "+ Add Staff" to register your first team member.
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          {staff.map((member) => (
            <div
              key={member.id}
              className="flex items-center justify-between px-3 py-3 rounded-lg"
              style={{ background: "hsl(240 12% 5%)", border: "1px solid hsl(240 8% 13%)" }}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-sm font-medium truncate">{member.name}</span>
                  <span
                    className="text-xs px-2 py-0.5 rounded font-bold"
                    style={{
                      background: member.role === "admin" ? "rgba(156,39,176,.2)" :
                                  member.role === "manager" ? "rgba(30,136,229,.2)" :
                                  member.role === "captain" ? "rgba(6,182,212,.2)" :
                                  member.role === "bartender" ? "rgba(236,72,153,.2)" :
                                  member.role === "cashier" ? "rgba(234,179,8,.2)" :
                                  "rgba(34,197,94,.2)",
                      color: member.role === "admin" ? "#CE93D8" :
                             member.role === "manager" ? "#64B5F6" :
                             member.role === "captain" ? "#22D3EE" :
                             member.role === "bartender" ? "#F472B6" :
                             member.role === "cashier" ? "#FACC15" :
                             "#4ADE80",
                    }}
                  >
                    {ROLE_LABELS[member.role] || member.role}
                  </span>
                  {!member.active && (
                    <span
                      className="text-xs px-2 py-0.5 rounded"
                      style={{ background: "rgba(239,68,68,.2)", color: "#EF4444" }}
                    >
                      INACTIVE
                    </span>
                  )}
                </div>
                <div className="text-xs" style={{ color: "hsl(36 29% 50%)" }}>
                  📱 +91 {member.phone} · 🔐 PIN: ••••
                </div>
              </div>
              <div className="flex gap-2 ml-2">
                <button
                  onClick={() => openEdit(member)}
                  className="text-xs px-3 py-1.5 rounded font-medium"
                  style={{
                    background: "rgba(201,168,76,.12)",
                    border: "1px solid rgba(201,168,76,.3)",
                    color: "#C9A84C",
                  }}
                >
                  Edit
                </button>
                <button
                  onClick={() => handleDeactivate(member)}
                  className="text-xs px-3 py-1.5 rounded font-medium"
                  style={{
                    background: member.active ? "rgba(239,68,68,.12)" : "rgba(34,197,94,.12)",
                    border: "1px solid " + (member.active ? "rgba(239,68,68,.3)" : "rgba(34,197,94,.3)"),
                    color: member.active ? "#EF4444" : "#22C55E",
                  }}
                >
                  {member.active ? "Deactivate" : "Activate"}
                </button>
                <button
                  onClick={() => handleDelete(member)}
                  className="text-xs px-3 py-1.5 rounded font-medium"
                  style={{
                    background: "rgba(107,107,138,.12)",
                    border: "1px solid rgba(107,107,138,.3)",
                    color: "#888",
                  }}
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
