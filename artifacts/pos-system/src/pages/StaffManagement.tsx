import { useState, useEffect, useRef } from "react";
import { db, storage } from "@/lib/firebase";
import { collection, onSnapshot, doc, setDoc, updateDoc, deleteDoc, Timestamp } from "firebase/firestore";
import { ref, uploadBytes, getDownloadURL } from "firebase/storage";
import type { StaffRole } from "@/lib/types";
import { Camera, Upload, X } from "lucide-react";

interface StaffRecord {
  id: string;
  name: string;
  phone: string;
  pin: string;
  role: StaffRole;
  active: boolean;
  facePhotoUrl?: string;
  faceDescriptor?: number[];
  createdAt?: Timestamp;
}

const ROLE_OPTIONS: StaffRole[] = ["manager", "captain", "runner", "steward", "bartender", "cashier", "chef", "hostess"];

const GOLD = "#C9A84C";
const BG = "#030305";
const CARD_BG = "hsl(240 12% 5%)";
const INPUT_BG = "hsl(240 12% 8%)";
const BORDER = "1px solid hsl(240 8% 18%)";
const TEXT_DIM = "hsl(36 29% 60%)";
const TEXT_MAIN = "hsl(36 29% 93%)";

export default function StaffManagement() {
  const [staffList, setStaffList] = useState<StaffRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

  // Form state
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [formName, setFormName] = useState("");
  const [formPhone, setFormPhone] = useState("");
  const [formPin, setFormPin] = useState("");
  const [formRole, setFormRole] = useState<StaffRole>("steward");
  const [formActive, setFormActive] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [showCamera, setShowCamera] = useState(false);
  const [camStream, setCamStream] = useState<MediaStream | null>(null);

  useEffect(() => {
    return () => { if (camStream) camStream.getTracks().forEach((t) => t.stop()); };
  }, [camStream]);

  useEffect(() => {
    const unsub = onSnapshot(
      collection(db, "staff"),
      (snap) => {
        const list = snap.docs.map((d) => {
          const data = d.data();
          return {
            id: d.id,
            name: data.name || "",
            phone: data.phone || "",
            pin: data.pin || "",
            role: (data.role || "steward") as StaffRole,
            active: data.active !== false,
            facePhotoUrl: data.facePhotoUrl || "",
            faceDescriptor: data.faceDescriptor || undefined,
            createdAt: data.createdAt,
          };
        });
        setStaffList(list.sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0)));
        setLoading(false);
      },
      (err) => {
        console.error("[StaffManagement] Firestore error:", err);
        setLoading(false);
      }
    );
    return () => unsub();
  }, []);

  const resetForm = () => {
    setFormName("");
    setFormPhone("");
    setFormPin("");
    setFormRole("steward");
    setFormActive(true);
    setEditId(null);
    setShowForm(false);
    setMessage("");
    setPhotoFile(null);
    setPhotoPreview(null);
    setUploadingPhoto(false);
    stopCamera();
  };

  const openNew = () => {
    resetForm();
    setShowForm(true);
  };

  const openEdit = (s: StaffRecord) => {
    setFormName(s.name);
    setFormPhone(s.phone);
    setFormPin(s.pin);
    setFormRole(s.role);
    setFormActive(s.active);
    setEditId(s.id);
    setShowForm(true);
    setMessage("");
    setPhotoFile(null);
    setPhotoPreview(s.facePhotoUrl || null);
    setUploadingPhoto(false);
  };

  const handlePhotoSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) { setMessage("❌ Please select an image file"); return; }
    if (file.size > 5 * 1024 * 1024) { setMessage("❌ Image must be under 5MB"); return; }
    setPhotoFile(file);
    setPhotoPreview(URL.createObjectURL(file));
    setMessage("");
  };

  const uploadPhoto = async (staffId: string): Promise<string | null> => {
    if (!photoFile) return null;
    setUploadingPhoto(true);
    try {
      const ext = photoFile.name.split(".").pop() || "jpg";
      const path = `staff-photos/${staffId}_reference.${ext}`;
      const storageRef = ref(storage, path);
      await uploadBytes(storageRef, photoFile);
      const url = await getDownloadURL(storageRef);
      await updateDoc(doc(db, "staff", staffId), { facePhotoUrl: url, updatedAt: Timestamp.now() });
      return url;
    } catch (e: any) {
      console.error("[StaffManagement] Photo upload error:", e);
      setMessage(`⚠️ Photo upload failed: ${e?.message || "Unknown error"}`);
      return null;
    } finally {
      setUploadingPhoto(false);
    }
  };

  const startCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } },
        audio: false,
      });
      setCamStream(stream);
      setShowCamera(true);
      setTimeout(() => {
        if (videoRef.current) videoRef.current.srcObject = stream;
      }, 100);
    } catch (e: any) {
      setMessage("❌ Camera error: " + e.message);
    }
  };

  const stopCamera = () => {
    if (camStream) {
      camStream.getTracks().forEach((t) => t.stop());
      setCamStream(null);
    }
    setShowCamera(false);
  };

  const capturePhoto = () => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;
    canvas.width = video.videoWidth || 640;
    canvas.height = video.videoHeight || 480;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob(
      (blob) => {
        if (!blob) return;
        const file = new File([blob], `staff-photo-${Date.now()}.jpg`, { type: "image/jpeg" });
        setPhotoFile(file);
        setPhotoPreview(URL.createObjectURL(file));
        stopCamera();
      },
      "image/jpeg",
      0.9
    );
  };

  const handleSave = async () => {
    if (!formName.trim()) { setMessage("❌ Name is required"); return; }
    if (!formPhone.trim()) { setMessage("❌ Phone number is required"); return; }
    if (!formPin || formPin.length !== 4) { setMessage("❌ PIN must be exactly 4 digits"); return; }

    setSaving(true);
    setMessage("");
    try {
      const payload = {
        name: formName.trim(),
        phone: formPhone.trim(),
        pin: formPin,
        role: formRole,
        active: formActive,
        updatedAt: Timestamp.now(),
      };

      let staffId = editId;

      if (editId) {
        await updateDoc(doc(db, "staff", editId), payload);
        if (photoFile) await uploadPhoto(editId);
        setMessage("✅ Staff updated successfully");
      } else {
        const newRef = doc(collection(db, "staff"));
        await setDoc(newRef, { ...payload, createdAt: Timestamp.now() });
        staffId = newRef.id;
        if (photoFile) await uploadPhoto(newRef.id);
        setMessage("✅ Staff added successfully");
      }

      setTimeout(() => {
        resetForm();
      }, 1200);
    } catch (e: any) {
      console.error("[StaffManagement] Save error:", e);
      setMessage(`❌ Save failed: ${e?.message || "Unknown error"}`);
    }
    setSaving(false);
  };

  const handleDelete = async (id: string, name: string) => {
    if (!window.confirm(`Delete ${name}? This cannot be undone.`)) return;
    try {
      await deleteDoc(doc(db, "staff", id));
      setMessage(`✅ ${name} deleted`);
      setTimeout(() => setMessage(""), 2000);
    } catch (e: any) {
      setMessage(`❌ Delete failed: ${e?.message || "Unknown error"}`);
    }
  };

  const filtered = staffList.filter((s) =>
    s.name.toLowerCase().includes(search.toLowerCase()) ||
    s.phone.includes(search) ||
    s.role.toLowerCase().includes(search.toLowerCase())
  );

  const activeCount = staffList.filter((s) => s.active).length;
  const inactiveCount = staffList.filter((s) => !s.active).length;

  return (
    <div>
      {/* Stats Row */}
      <div className="flex gap-3 mb-4 flex-wrap">
        <div className="px-4 py-2 rounded-lg text-sm" style={{ background: CARD_BG, border: BORDER }}>
          <span style={{ color: TEXT_DIM }}>Total Staff: </span>
          <span className="font-bold" style={{ color: GOLD }}>{staffList.length}</span>
        </div>
        <div className="px-4 py-2 rounded-lg text-sm" style={{ background: CARD_BG, border: BORDER }}>
          <span style={{ color: TEXT_DIM }}>Active: </span>
          <span className="font-bold" style={{ color: "#22c55e" }}>{activeCount}</span>
        </div>
        <div className="px-4 py-2 rounded-lg text-sm" style={{ background: CARD_BG, border: BORDER }}>
          <span style={{ color: TEXT_DIM }}>Inactive: </span>
          <span className="font-bold" style={{ color: "#ef4444" }}>{inactiveCount}</span>
        </div>
        <div className="flex-1" />
        <button
          onClick={openNew}
          className="px-4 py-2 rounded-lg text-sm font-medium"
          style={{ background: GOLD, color: BG }}
        >
          + Add Staff
        </button>
      </div>

      {/* Search */}
      <input
        type="text"
        placeholder="Search by name, phone, or role..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="w-full px-4 py-2 rounded-lg text-sm mb-3"
        style={{ background: INPUT_BG, border: BORDER, color: TEXT_MAIN }}
      />

      {/* Add/Edit Form */}
      {showForm && (
        <div className="p-4 rounded-lg mb-4" style={{ background: CARD_BG, border: BORDER }}>
          <h3 className="text-sm font-semibold mb-3" style={{ color: GOLD }}>
            {editId ? "Edit Staff" : "Add New Staff"}
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">
            <div>
              <label className="text-xs block mb-1" style={{ color: TEXT_DIM }}>Full Name *</label>
              <input
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                placeholder="e.g. Rahul Sharma"
                className="w-full px-3 py-2 rounded text-sm"
                style={{ background: INPUT_BG, border: BORDER, color: TEXT_MAIN }}
              />
            </div>
            <div>
              <label className="text-xs block mb-1" style={{ color: TEXT_DIM }}>Phone Number *</label>
              <input
                value={formPhone}
                onChange={(e) => setFormPhone(e.target.value.replace(/\D/g, "").slice(0, 10))}
                placeholder="e.g. 9876543210"
                className="w-full px-3 py-2 rounded text-sm"
                style={{ background: INPUT_BG, border: BORDER, color: TEXT_MAIN }}
              />
            </div>
            <div>
              <label className="text-xs block mb-1" style={{ color: TEXT_DIM }}>4-Digit PIN *</label>
              <input
                type="password"
                value={formPin}
                onChange={(e) => setFormPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
                placeholder="****"
                maxLength={4}
                className="w-full px-3 py-2 rounded text-sm"
                style={{ background: INPUT_BG, border: BORDER, color: TEXT_MAIN }}
              />
            </div>
            <div>
              <label className="text-xs block mb-1" style={{ color: TEXT_DIM }}>Role *</label>
              <select
                value={formRole}
                onChange={(e) => setFormRole(e.target.value as StaffRole)}
                className="w-full px-3 py-2 rounded text-sm"
                style={{ background: INPUT_BG, border: BORDER, color: TEXT_MAIN }}
              >
                {ROLE_OPTIONS.map((r) => (
                  <option key={r} value={r}>{r.charAt(0).toUpperCase() + r.slice(1)}</option>
                ))}
              </select>
            </div>
          </div>
          {/* Reference Photo — Camera Capture + File Upload */}
          <div className="mb-3 p-3 rounded" style={{ background: "hsl(240 12% 3%)", border: BORDER }}>
            <label className="text-xs block mb-2" style={{ color: TEXT_DIM }}>📸 Reference Photo (for face recognition login)</label>
            <input type="file" ref={fileInputRef} accept="image/*" onChange={handlePhotoSelect} className="hidden" />
            <canvas ref={canvasRef} className="hidden" />

            {showCamera ? (
              <div className="space-y-2">
                <div className="relative rounded-lg overflow-hidden bg-black" style={{ aspectRatio: "3/4", maxHeight: 450, width: "100%" }}>
                  <video ref={videoRef} autoPlay playsInline muted className="w-full h-full object-cover" />
                  <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                    <div style={{ width: 220, height: 260, border: "3px dashed rgba(201,168,76,.7)", borderRadius: "50%" }} />
                  </div>
                  <div className="absolute top-2 left-1/2 -translate-x-1/2 text-xs font-bold px-3 py-1 rounded-full" style={{ background: "rgba(0,0,0,.75)", color: GOLD }}>
                    Center face in the oval
                  </div>
                </div>
                <div className="flex gap-2">
                  <button onClick={capturePhoto} className="flex-1 px-3 py-2 rounded text-xs font-bold" style={{ background: GOLD, color: BG }}>
                    📸 Capture
                  </button>
                  <button onClick={stopCamera} className="px-3 py-2 rounded text-xs" style={{ background: "hsl(240 12% 10%)", color: TEXT_DIM, border: BORDER }}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : photoPreview ? (
              <div className="flex items-center gap-3">
                <img src={photoPreview} alt="Preview" className="w-16 h-16 rounded-lg object-cover" style={{ border: "1px solid hsl(240 8% 18%)" }} />
                <div className="flex-1">
                  <div className="text-xs mb-1" style={{ color: "#22c55e" }}>✅ Photo captured</div>
                  <button
                    onClick={() => { setPhotoFile(null); setPhotoPreview(null); if (fileInputRef.current) fileInputRef.current.value = ""; }}
                    className="text-xs px-2 py-1 rounded"
                    style={{ background: "rgba(239,68,68,.15)", color: "#ef4444" }}
                  >
                    Remove
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex gap-2">
                <button onClick={startCamera} className="flex items-center gap-1.5 px-3 py-2 rounded text-xs font-medium" style={{ background: GOLD, color: BG }}>
                  <Camera size={14} /> Capture Live
                </button>
                <button onClick={() => fileInputRef.current?.click()} className="flex items-center gap-1.5 px-3 py-2 rounded text-xs" style={{ background: INPUT_BG, border: BORDER, color: TEXT_DIM }}>
                  <Upload size={14} /> Upload File
                </button>
              </div>
            )}
            <p className="text-xs mt-2" style={{ color: "#666" }}>
              Tip: Ask staff to look straight at the camera. Good lighting = better face match.
            </p>
            {uploadingPhoto && <div className="text-xs mt-1" style={{ color: GOLD }}>Uploading photo...</div>}
          </div>

          <div className="flex items-center gap-3 mb-3">
            <label className="flex items-center gap-2 text-sm cursor-pointer" style={{ color: TEXT_DIM }}>
              <input
                type="checkbox"
                checked={formActive}
                onChange={(e) => setFormActive(e.target.checked)}
                className="w-4 h-4"
              />
              Active (can login to attendance)
            </label>
          </div>
          {message && (
            <div className="text-xs mb-3" style={{
              color: message.startsWith("✅") ? "#22c55e" : "#ef4444",
              background: message.startsWith("✅") ? "rgba(34,197,94,.1)" : "rgba(239,68,68,.1)",
              padding: "8px 12px",
              borderRadius: 6,
            }}>
              {message}
            </div>
          )}
          <div className="flex gap-2">
            <button
              onClick={handleSave}
              disabled={saving}
              className="px-4 py-2 rounded-lg text-sm font-medium"
              style={{ background: GOLD, color: BG, opacity: saving ? 0.6 : 1 }}
            >
              {saving ? "Saving..." : editId ? "Update Staff" : "Add Staff"}
            </button>
            <button
              onClick={resetForm}
              className="px-4 py-2 rounded-lg text-sm"
              style={{ background: "hsl(240 12% 10%)", color: TEXT_DIM, border: BORDER }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Staff List */}
      {loading ? (
        <div className="text-center py-12 text-sm" style={{ color: TEXT_DIM }}>Loading staff...</div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-12 rounded-lg" style={{ border: "1px dashed hsl(240 8% 18%)", color: TEXT_DIM }}>
          {search ? "No staff match your search." : "No staff added yet. Click + Add Staff to get started."}
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((s) => (
            <div
              key={s.id}
              className="flex items-center justify-between px-4 py-3 rounded-lg"
              style={{ background: CARD_BG, border: BORDER, opacity: s.active ? 1 : 0.6 }}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-medium" style={{ color: TEXT_MAIN }}>{s.name}</span>
                  <span
                    className="text-xs px-2 py-0.5 rounded"
                    style={{
                      background: s.active ? "rgba(34,197,94,.15)" : "rgba(239,68,68,.15)",
                      color: s.active ? "#22c55e" : "#ef4444",
                    }}
                  >
                    {s.active ? "Active" : "Inactive"}
                  </span>
                  {s.faceDescriptor ? (
                    <span className="text-xs px-2 py-0.5 rounded" style={{ background: "rgba(201,168,76,.15)", color: GOLD }}>👤 Face enrolled</span>
                  ) : s.facePhotoUrl ? (
                    <span className="text-xs px-2 py-0.5 rounded" style={{ background: "rgba(245,158,11,.15)", color: "#f59e0b" }}>📸 Photo only</span>
                  ) : (
                    <span className="text-xs px-2 py-0.5 rounded" style={{ background: "rgba(100,100,100,.1)", color: "#666" }}>No face</span>
                  )}
                </div>
                <div className="text-xs mt-1" style={{ color: TEXT_DIM }}>
                  📱 {s.phone || "No phone"} · 🏷️ {s.role}
                  {s.createdAt && ` · Added ${new Date(s.createdAt.toMillis()).toLocaleDateString("en-IN")}`}
                </div>
              </div>
              <div className="flex gap-2 ml-3">
                <button
                  onClick={() => openEdit(s)}
                  className="px-3 py-1 rounded text-xs font-medium"
                  style={{ background: "rgba(201,168,76,.15)", border: "1px solid rgba(201,168,76,.4)", color: GOLD }}
                >
                  Edit
                </button>
                <button
                  onClick={() => handleDelete(s.id, s.name)}
                  className="px-3 py-1 rounded text-xs"
                  style={{ background: "rgba(239,68,68,.15)", color: "#ef4444" }}
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
