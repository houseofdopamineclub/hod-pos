import { useState, useEffect } from "react";
import { db } from "@/lib/firebase";
import { collection, doc, setDoc, updateDoc, deleteDoc, onSnapshot, query, where, getDocs } from "firebase/firestore";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { Plus, Pencil, Trash2, Phone, UserCircle, ShieldCheck } from "lucide-react";

// ═══════════════════════════════════════════
// STAFF MANAGEMENT — Add/Edit/Delete Staff
// ═══════════════════════════════════════════

type StaffRole = "manager" | "captain" | "runner" | "steward";

interface StaffMember {
  id?: string;
  name: string;
  phone: string;
  role: StaffRole;
  active: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}

const ROLE_LABELS: Record<StaffRole, string> = {
  manager: "Manager",
  captain: "Captain",
  runner: "Runner",
  steward: "Steward",
};

const ROLE_COLORS: Record<StaffRole, string> = {
  manager: "bg-purple-500",
  captain: "bg-blue-500",
  runner: "bg-orange-500",
  steward: "bg-green-500",
};

export default function StaffManagement() {
  const { toast } = useToast();
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<StaffMember | null>(null);
  const [form, setForm] = useState<StaffMember>({
    name: "",
    phone: "",
    role: "steward",
    active: true,
  });

  // Real-time staff list
  useEffect(() => {
    const q = query(collection(db, "staff"), where("active", "==", true));
    const unsub = onSnapshot(q, (snap) => {
      const list: StaffMember[] = [];
      snap.forEach((doc) => list.push({ id: doc.id, ...doc.data() } as StaffMember));
      setStaff(list.sort((a, b) => a.name.localeCompare(b.name)));
      setLoading(false);
    });
    return unsub;
  }, []);

  const resetForm = () => {
    setForm({ name: "", phone: "", role: "steward", active: true });
    setEditing(null);
  };

  const openAdd = () => {
    resetForm();
    setDialogOpen(true);
  };

  const openEdit = (member: StaffMember) => {
    setEditing(member);
    setForm({ ...member });
    setDialogOpen(true);
  };

  const handleSubmit = async () => {
    // Validation
    if (!form.name.trim() || form.name.length < 2) {
      toast({ title: "Error", description: "Enter a valid name (min 2 characters)", variant: "destructive" });
      return;
    }
    if (!form.phone.match(/^\d{10}$/)) {
      toast({ title: "Error", description: "Enter a valid 10-digit phone number", variant: "destructive" });
      return;
    }

    try {
      const cleanPhone = form.phone.replace(/\D/g, "").slice(-10);

      // Check duplicate phone
      const dupQuery = query(collection(db, "staff"), where("phone", "==", cleanPhone));
      const dupSnap = await getDocs(dupQuery);
      const isDuplicate = dupSnap.docs.some((d) => d.id !== editing?.id);
      if (isDuplicate) {
        toast({ title: "Error", description: "Phone number already registered", variant: "destructive" });
        return;
      }

      const data = {
        name: form.name.trim(),
        phone: cleanPhone,
        role: form.role,
        active: true,
        updatedAt: new Date(),
      };

      if (editing?.id) {
        await updateDoc(doc(db, "staff", editing.id), data);
        toast({ title: "✅ Updated", description: `${form.name}'s details updated` });
      } else {
        const newId = doc(collection(db, "staff")).id;
        await setDoc(doc(db, "staff", newId), {
          ...data,
          id: newId,
          createdAt: new Date(),
        });
        toast({ title: "✅ Staff Added", description: `${form.name} registered as ${ROLE_LABELS[form.role]}` });
      }

      setDialogOpen(false);
      resetForm();
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    }
  };

  const handleDeactivate = async (member: StaffMember) => {
    if (!confirm(`Deactivate ${member.name}? They won't be able to clock in.`)) return;
    try {
      await updateDoc(doc(db, "staff", member.id!), { active: false, updatedAt: new Date() });
      toast({ title: "✅ Deactivated", description: `${member.name} has been deactivated` });
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    }
  };

  return (
    <div className="p-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-[#F2C744]">👥 Staff Management</h1>
          <p className="text-sm text-gray-400 mt-1">Add and manage staff for attendance tracking</p>
        </div>
        <Button onClick={openAdd} className="bg-[#F2C744] text-black hover:bg-[#B8963E] font-bold">
          <Plus className="w-4 h-4 mr-2" /> Add Staff
        </Button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        {(["manager", "captain", "runner", "steward"] as StaffRole[]).map((role) => (
          <Card key={role} className="bg-[#111] border-[#2A2A2A]">
            <CardContent className="p-4 text-center">
              <div className={`w-3 h-3 rounded-full mx-auto mb-2 ${ROLE_COLORS[role]}`} />
              <div className="text-2xl font-bold text-[#F2C744]">
                {staff.filter((s) => s.role === role).length}
              </div>
              <div className="text-xs text-gray-400 uppercase tracking-wider">{ROLE_LABELS[role]}s</div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Staff Table */}
      <Card className="bg-[#111] border-[#2A2A2A]">
        <CardHeader>
          <CardTitle className="text-[#F2C744] text-lg">All Staff Members</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="text-center py-10 text-gray-400">Loading staff...</div>
          ) : staff.length === 0 ? (
            <div className="text-center py-10 text-gray-400">
              No staff added yet. Click "Add Staff" to register your first team member.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="border-[#2A2A2A] hover:bg-transparent">
                  <TableHead className="text-gray-400">Name</TableHead>
                  <TableHead className="text-gray-400">Phone</TableHead>
                  <TableHead className="text-gray-400">Role</TableHead>
                  <TableHead className="text-gray-400 text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {staff.map((member) => (
                  <TableRow key={member.id} className="border-[#2A2A2A] hover:bg-[#1A1A1A]">
                    <TableCell className="font-medium text-white">{member.name}</TableCell>
                    <TableCell className="text-gray-300">+91 {member.phone}</TableCell>
                    <TableCell>
                      <Badge className={`${ROLE_COLORS[member.role]} text-white text-xs`}>
                        {ROLE_LABELS[member.role]}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => openEdit(member)}
                          className="text-blue-400 hover:text-blue-300 hover:bg-blue-500/10"
                        >
                          <Pencil className="w-4 h-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleDeactivate(member)}
                          className="text-red-400 hover:text-red-300 hover:bg-red-500/10"
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Add/Edit Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="bg-[#111] border-[#2A2A2A] text-white max-w-md">
          <DialogHeader>
            <DialogTitle className="text-[#F2C744]">
              {editing ? "✏️ Edit Staff" : "➕ Add New Staff"}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 pt-4">
            <div>
              <Label className="text-gray-400 text-xs uppercase tracking-wider">Full Name</Label>
              <div className="relative mt-1">
                <UserCircle className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
                <Input
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="e.g. Rajesh Kumar"
                  className="pl-10 bg-[#1A1A1A] border-[#2A2A2A] text-white"
                />
              </div>
            </div>
            <div>
              <Label className="text-gray-400 text-xs uppercase tracking-wider">Phone Number</Label>
              <div className="relative mt-1">
                <Phone className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
                <Input
                  value={form.phone}
                  onChange={(e) => setForm({ ...form, phone: e.target.value.replace(/\D/g, "").slice(0, 10) })}
                  placeholder="9876543210"
                  maxLength={10}
                  className="pl-10 bg-[#1A1A1A] border-[#2A2A2A] text-white"
                />
              </div>
            </div>
            <div>
              <Label className="text-gray-400 text-xs uppercase tracking-wider">Role</Label>
              <Select value={form.role} onValueChange={(v) => setForm({ ...form, role: v as StaffRole })}>
                <SelectTrigger className="mt-1 bg-[#1A1A1A] border-[#2A2A2A] text-white">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-[#1A1A1A] border-[#2A2A2A]">
                  {(Object.keys(ROLE_LABELS) as StaffRole[]).map((role) => (
                    <SelectItem key={role} value={role} className="text-white">
                      {ROLE_LABELS[role]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button
              onClick={handleSubmit}
              className="w-full bg-[#F2C744] text-black hover:bg-[#B8963E] font-bold mt-2"
            >
              <ShieldCheck className="w-4 h-4 mr-2" />
              {editing ? "Update Staff" : "Register Staff"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
