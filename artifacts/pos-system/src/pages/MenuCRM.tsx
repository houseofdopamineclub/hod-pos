import { useState, useEffect } from "react";
import {
  createMenuCategory, updateMenuCategory,
  deleteMenuCategory, toggleMenuCategoryLive, subscribeToMenuCategories,
  type MenuCategory, type MenuCategoryItem,
  sha256,
} from "@/lib/firestore-hod";
import { HOD_MENU_ITEMS, HOD_CATEGORY_LABELS } from "@/lib/hod-menu";

// Same manager hash as the rest of the admin pages (PIN 8888).
const MANAGER_HASH = "2926a2731f4b312c08982cacf8061eb14bf65c1a87cc5d70e864e079c6220731";

async function requireManagerPin(reason: string): Promise<boolean> {
  const pin = window.prompt(`🔒 MANAGER PIN REQUIRED\n\n${reason}\n\nENTER 4-DIGIT MANAGER PIN:`);
  if (!pin) return false;
  const h = await sha256(pin.trim());
  if (h !== MANAGER_HASH) { alert("❌ WRONG MANAGER PIN."); return false; }
  return true;
}

export default function MenuCRM() {
  const [categories, setCategories] = useState<MenuCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [discount, setDiscount] = useState(0);
  const [selectedItems, setSelectedItems] = useState<MenuCategoryItem[]>([]);
  const [itemSearch, setItemSearch] = useState("");
  const [saving, setSaving] = useState(false);
  const gold = "#C9A84C";

  useEffect(() => {
    const unsub = subscribeToMenuCategories((cats) => {
      setCategories(cats);
      setLoading(false);
    });
    return unsub;
  }, []);

  const resetForm = () => {
    setName("");
    setDiscount(0);
    setSelectedItems([]);
    setShowCreate(false);
    setEditingId(null);
  };

  const handleCreate = async () => {
    if (!name.trim()) { alert("Category name required"); return; }
    if (selectedItems.length === 0) { alert("Add at least 1 item"); return; }
    if (!(await requireManagerPin(`Create category "${name}"`))) return;
    setSaving(true);
    try {
      await createMenuCategory({
        name: name.trim(),
        discountPercent: discount,
        items: selectedItems,
        isLive: false,
      });
      resetForm();
    } catch (e: any) { alert("Error: " + e?.message); }
    setSaving(false);
  };

  const handleUpdate = async () => {
    if (!editingId || !name.trim()) return;
    if (!(await requireManagerPin(`Update category "${name}"`))) return;
    setSaving(true);
    try {
      await updateMenuCategory(editingId, {
        name: name.trim(),
        discountPercent: discount,
        items: selectedItems,
      });
      resetForm();
    } catch (e: any) { alert("Error: " + e?.message); }
    setSaving(false);
  };

  const handleDelete = async (id: string, catName: string) => {
    if (!confirm(`Delete "${catName}"?`)) return;
    if (!(await requireManagerPin(`Delete category "${catName}"`))) return;
    try { await deleteMenuCategory(id); } catch (e: any) { alert("Error: " + e?.message); }
  };

  const handleToggleLive = async (id: string, current: boolean) => {
    try {
      await toggleMenuCategoryLive(id, !current);
    } catch (e: any) { alert("Error: " + e?.message); }
  };

  // HOD_MENU_ITEMS shape: { id, name, price, category, group, isVeg, isAlcohol, available }
  const toggleItem = (item: typeof HOD_MENU_ITEMS[number]) => {
    const key = item.id;
    const exists = selectedItems.find((si) => si.id === key);
    if (exists) {
      setSelectedItems(selectedItems.filter((si) => si.id !== key));
    } else {
      setSelectedItems([...selectedItems, {
        id: item.id,
        name: item.name,
        price: item.price,
        categoryType: item.group === "food" ? "food" : "drink",
        veg: item.isVeg,
        alc: item.isAlcohol,
      }]);
    }
  };

  const filteredItems = HOD_MENU_ITEMS.filter((it) => {
    if (!itemSearch) return true;
    const s = itemSearch.toLowerCase();
    return it.name.toLowerCase().includes(s)
      || (HOD_CATEGORY_LABELS[it.category] || "").toLowerCase().includes(s);
  });

  const isItemSelected = (id: string) => selectedItems.some((si) => si.id === id);

  const startEdit = (cat: MenuCategory) => {
    setEditingId(cat.id);
    setName(cat.name);
    setDiscount(cat.discountPercent || 0);
    setSelectedItems([...(cat.items || [])]);
    setShowCreate(true);
  };

  return (
    <div style={{ padding: 16, color: "#fff", maxWidth: 900, margin: "0 auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 800, color: gold }}>📋 MENU CRM</h2>
        {!showCreate && (
          <button onClick={() => setShowCreate(true)} style={{
            padding: "10px 20px", borderRadius: 10, border: "none", background: gold, color: "#030305",
            fontWeight: 800, cursor: "pointer", fontSize: 14,
          }}>➕ NEW CATEGORY</button>
        )}
      </div>

      {/* Create / Edit Form */}
      {showCreate && (
        <div style={{ background: "hsl(240 12% 8%)", border: `1px solid ${gold}40`, borderRadius: 14, padding: 20, marginBottom: 24 }}>
          <h3 style={{ margin: "0 0 16px", fontSize: 16, color: gold }}>
            {editingId ? "✏️ EDIT CATEGORY" : "➕ CREATE CATEGORY"}
          </h3>

          <div style={{ marginBottom: 14 }}>
            <label style={{ fontSize: 12, color: "rgba(255,255,255,.5)", display: "block", marginBottom: 6 }}>CATEGORY NAME</label>
            <input value={name} onChange={(e) => setName(e.target.value)}
              placeholder="e.g. FRIDAY NIGHT SPECIAL"
              style={{ width: "100%", padding: 10, borderRadius: 8, border: "1px solid rgba(255,255,255,.15)", background: "rgba(255,255,255,.05)", color: "#fff", fontSize: 14, boxSizing: "border-box" }} />
          </div>

          <div style={{ marginBottom: 14 }}>
            <label style={{ fontSize: 12, color: "rgba(255,255,255,.5)", display: "block", marginBottom: 6 }}>
              DISCOUNT: <strong style={{ color: gold }}>{discount}%</strong>
            </label>
            <input type="range" min={0} max={50} value={discount}
              onChange={(e) => setDiscount(Number(e.target.value))}
              style={{ width: "100%" }} />
          </div>

          <div style={{ marginBottom: 14 }}>
            <label style={{ fontSize: 12, color: "rgba(255,255,255,.5)", display: "block", marginBottom: 6 }}>
              ITEMS ({selectedItems.length} selected)
            </label>
            <input value={itemSearch} onChange={(e) => setItemSearch(e.target.value)}
              placeholder="Search menu items..."
              style={{ width: "100%", padding: 10, borderRadius: 8, border: "1px solid rgba(255,255,255,.15)", background: "rgba(255,255,255,.05)", color: "#fff", fontSize: 14, boxSizing: "border-box", marginBottom: 10 }} />
            <div style={{ maxHeight: 240, overflow: "auto", border: "1px solid rgba(255,255,255,.08)", borderRadius: 8, padding: 8 }}>
              {filteredItems.slice(0, 200).map((it) => (
                <label key={it.id} style={{
                  display: "flex", alignItems: "center", gap: 8, padding: "6px 8px",
                  borderRadius: 6, cursor: "pointer",
                  background: isItemSelected(it.id) ? `${gold}15` : "transparent",
                }}>
                  <input type="checkbox" checked={isItemSelected(it.id)}
                    onChange={() => toggleItem(it)} style={{ cursor: "pointer" }} />
                  <span style={{ flex: 1, fontSize: 13 }}>{it.name}</span>
                  <span style={{ fontSize: 11, color: "rgba(255,255,255,.4)" }}>₹{it.price}</span>
                  <span style={{
                    fontSize: 10, padding: "2px 6px", borderRadius: 4,
                    background: it.group === "food" ? "rgba(34,197,94,.15)" : "rgba(59,130,246,.15)",
                    color: it.group === "food" ? "#22C55E" : "#3B82F6",
                  }}>
                    {it.group === "food" ? "food" : "drink"}
                  </span>
                </label>
              ))}
              {filteredItems.length > 200 && (
                <div style={{ padding: 8, fontSize: 11, color: "rgba(255,255,255,.4)", textAlign: "center" }}>
                  Showing first 200 of {filteredItems.length} — refine search to see more.
                </div>
              )}
            </div>
          </div>

          <div style={{ display: "flex", gap: 10 }}>
            {editingId ? (
              <button onClick={handleUpdate} disabled={saving} style={{
                flex: 1, padding: 12, borderRadius: 10, border: "none", background: gold, color: "#030305",
                fontWeight: 800, cursor: saving ? "wait" : "pointer", fontSize: 14,
              }}>{saving ? "SAVING..." : "💾 UPDATE CATEGORY"}</button>
            ) : (
              <button onClick={handleCreate} disabled={saving} style={{
                flex: 1, padding: 12, borderRadius: 10, border: "none", background: gold, color: "#030305",
                fontWeight: 800, cursor: saving ? "wait" : "pointer", fontSize: 14,
              }}>{saving ? "SAVING..." : "➕ CREATE CATEGORY"}</button>
            )}
            <button onClick={resetForm} style={{
              padding: "12px 20px", borderRadius: 10, border: "1px solid rgba(255,255,255,.2)",
              background: "transparent", color: "#fff", fontWeight: 700, cursor: "pointer",
            }}>CANCEL</button>
          </div>
        </div>
      )}

      {/* Category List */}
      {loading ? (
        <div style={{ textAlign: "center", padding: 40, color: "rgba(255,255,255,.4)" }}>Loading...</div>
      ) : categories.length === 0 ? (
        <div style={{ textAlign: "center", padding: 40, color: "rgba(255,255,255,.4)" }}>
          No categories yet. Click "➕ NEW CATEGORY" to create one.
        </div>
      ) : (
        <div>
          {categories.map((cat) => (
            <div key={cat.id} style={{
              background: "hsl(240 12% 8%)",
              border: `1px solid ${cat.isLive ? "rgba(34,197,94,.3)" : "rgba(255,255,255,.08)"}`,
              borderRadius: 12, padding: "14px 18px", marginBottom: 12,
            }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <button onClick={() => handleToggleLive(cat.id, cat.isLive)} style={{
                    width: 44, height: 24, borderRadius: 12, border: "none", cursor: "pointer",
                    background: cat.isLive ? "#22C55E" : "rgba(255,255,255,.15)",
                    display: "flex", alignItems: "center",
                    justifyContent: cat.isLive ? "flex-end" : "flex-start",
                    padding: 2, transition: "all .2s",
                  }}>
                    <div style={{ width: 20, height: 20, borderRadius: 10, background: "#fff" }} />
                  </button>
                  <div>
                    <div style={{ fontSize: 15, fontWeight: 800, color: cat.isLive ? gold : "#fff" }}>
                      {cat.name} {cat.isLive && <span style={{ color: "#22C55E", fontSize: 11 }}>● LIVE</span>}
                    </div>
                    <div style={{ fontSize: 12, color: "rgba(255,255,255,.4)", marginTop: 2 }}>
                      {(cat.items || []).length} items · {(cat.discountPercent || 0)}% discount
                    </div>
                  </div>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={() => startEdit(cat)} style={{
                    padding: "6px 12px", borderRadius: 8, border: `1px solid ${gold}40`,
                    background: `${gold}10`, color: gold,
                    fontSize: 12, fontWeight: 700, cursor: "pointer",
                  }}>✏️ EDIT</button>
                  <button onClick={() => handleDelete(cat.id, cat.name)} style={{
                    padding: "6px 12px", borderRadius: 8, border: "1px solid rgba(239,68,68,.3)",
                    background: "rgba(239,68,68,.08)", color: "#EF4444",
                    fontSize: 12, fontWeight: 700, cursor: "pointer",
                  }}>🗑️</button>
                </div>
              </div>

              {cat.items && cat.items.length > 0 && (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 10 }}>
                  {cat.items.slice(0, 8).map((it) => (
                    <span key={it.id} style={{
                      fontSize: 11, padding: "3px 8px", borderRadius: 6,
                      background: "rgba(255,255,255,.06)", color: "rgba(255,255,255,.6)",
                    }}>
                      {it.name} ₹{it.price}
                      {(cat.discountPercent || 0) > 0 && (
                        <span style={{ color: "#22C55E", marginLeft: 4 }}>-{cat.discountPercent}%</span>
                      )}
                    </span>
                  ))}
                  {cat.items.length > 8 && (
                    <span style={{ fontSize: 11, color: "rgba(255,255,255,.3)" }}>+{cat.items.length - 8} more</span>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <div style={{ marginTop: 24, padding: 12, borderRadius: 10, background: "rgba(255,255,255,.03)", fontSize: 12, color: "rgba(255,255,255,.4)", lineHeight: 1.6 }}>
        <strong style={{ color: gold }}>How it works:</strong><br/>
        🟢 Toggle a category LIVE — items appear on Captain/Bar/Wallet menus instantly<br/>
        ⚪ Toggle OFF — items disappear<br/>
        💰 Discount applies to ALL items in the category automatically<br/>
        🔒 Manager PIN (8888) required for create/edit/delete<br/>
        No auto-expiry — you control everything manually
      </div>
    </div>
  );
}
