import { useState, useEffect } from "react";
import {
  createMenuCategory, updateMenuCategory,
  deleteMenuCategory, toggleMenuCategoryLive, subscribeToMenuCategories,
  type MenuCategory, type MenuCategoryItem,
  sha256,
} from "@/lib/firestore-hod";
import { type HodMenuItem, HOD_CATEGORY_LABELS } from "@/lib/hod-menu";
import { useEffectiveMenu } from "@/lib/use-effective-menu";

// Same manager hash as the rest of the admin pages (PIN 8888).
const MANAGER_HASH = "2926a2731f4b312c08982cacf8061eb14bf65c1a87cc5d70e864e079c6220731";

async function requireManagerPin(reason: string): Promise<boolean> {
  const pin = window.prompt(`🔒 MANAGER PIN REQUIRED\n\n${reason}\n\nENTER 4-DIGIT MANAGER PIN:`);
  if (!pin) return false;
  const h = await sha256(pin.trim());
  if (h !== MANAGER_HASH) { alert("❌ WRONG MANAGER PIN."); return false; }
  return true;
}

// 🆕 2026-06-08 v3.240 — FULL Gumroad light restyle (cream/white, bold 2px black
// borders, pink/orange/teal accents, bold uppercase) so MENU mode matches Door &
// Captain. ALL logic/handlers are unchanged — only the inline styles changed.
const INK = "#000";
const PINK = "#FF90E8";
const ORANGE = "#FF5733";
const TEAL = "#23A094";
const RED = "#E11900";
const BLUE = "#2563EB";

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
  // Live effective menu = items added in the Menu Editor (venueMenu) merged
  // over the static baseline, so anything created in Menu Editor is selectable.
  const menuItems = useEffectiveMenu();

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

  // HodMenuItem shape: { id, name, price, category, group, isVeg, isAlcohol, available }
  const toMenuCategoryItem = (item: HodMenuItem): MenuCategoryItem => ({
    id: item.id,
    name: item.name,
    price: item.price,
    categoryType: item.group === "food" ? "food" : "drink",
    veg: item.isVeg,
    alc: item.isAlcohol,
  });

  const toggleItem = (item: HodMenuItem) => {
    const key = item.id;
    const exists = selectedItems.find((si) => si.id === key);
    if (exists) {
      setSelectedItems(selectedItems.filter((si) => si.id !== key));
    } else {
      setSelectedItems([...selectedItems, toMenuCategoryItem(item)]);
    }
  };

  const filteredItems = menuItems.filter((it) => {
    if (!itemSearch) return true;
    const s = itemSearch.toLowerCase();
    return it.name.toLowerCase().includes(s)
      || (HOD_CATEGORY_LABELS[it.category] || "").toLowerCase().includes(s);
  });

  // Select All adds every item matching the current search (all items when the
  // search box is empty); existing selections are preserved (de-duped by id).
  const selectAllFiltered = () => {
    setSelectedItems((prev) => {
      const byId = new Map(prev.map((si) => [si.id, si]));
      for (const it of filteredItems) {
        if (!byId.has(it.id)) byId.set(it.id, toMenuCategoryItem(it));
      }
      return Array.from(byId.values());
    });
  };
  const clearAllSelected = () => setSelectedItems([]);

  const isItemSelected = (id: string) => selectedItems.some((si) => si.id === id);

  const startEdit = (cat: MenuCategory) => {
    setEditingId(cat.id);
    setName(cat.name);
    setDiscount(cat.discountPercent || 0);
    setSelectedItems([...(cat.items || [])]);
    setShowCreate(true);
  };

  return (
    <div style={{ padding: 16, color: INK, maxWidth: 900, margin: "0 auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 900, letterSpacing: 0.5, color: INK, textTransform: "uppercase" }}>📋 MENU CRM</h2>
        {!showCreate && (
          <button onClick={() => setShowCreate(true)} style={{
            padding: "10px 20px", borderRadius: 10, border: `2px solid ${INK}`, background: PINK, color: INK,
            fontWeight: 900, cursor: "pointer", fontSize: 14, letterSpacing: 0.4, textTransform: "uppercase",
          }}>➕ NEW CATEGORY</button>
        )}
      </div>

      {/* Create / Edit Form */}
      {showCreate && (
        <div style={{ background: "#fff", border: `2px solid ${INK}`, borderRadius: 14, padding: 20, marginBottom: 24 }}>
          <h3 style={{ margin: "0 0 16px", fontSize: 16, color: INK, fontWeight: 900, letterSpacing: 0.4, textTransform: "uppercase" }}>
            {editingId ? "✏️ EDIT CATEGORY" : "➕ CREATE CATEGORY"}
          </h3>

          <div style={{ marginBottom: 14 }}>
            <label style={{ fontSize: 12, color: "#3D3D3D", display: "block", marginBottom: 6, fontWeight: 800, letterSpacing: 0.4 }}>CATEGORY NAME</label>
            <input value={name} onChange={(e) => setName(e.target.value)}
              placeholder="e.g. FRIDAY NIGHT SPECIAL"
              style={{ width: "100%", padding: 10, borderRadius: 8, border: `2px solid ${INK}`, background: "#fff", color: INK, fontSize: 14, fontWeight: 600, boxSizing: "border-box" }} />
          </div>

          <div style={{ marginBottom: 14 }}>
            <label style={{ fontSize: 12, color: "#3D3D3D", display: "block", marginBottom: 6, fontWeight: 800, letterSpacing: 0.4 }}>
              DISCOUNT: <strong style={{ color: TEAL }}>{discount}%</strong>
            </label>
            <input type="range" min={0} max={50} value={discount}
              onChange={(e) => setDiscount(Number(e.target.value))}
              style={{ width: "100%", accentColor: INK }} />
          </div>

          <div style={{ marginBottom: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6, gap: 8 }}>
              <label style={{ fontSize: 12, color: "#3D3D3D", fontWeight: 800, letterSpacing: 0.4 }}>
                ITEMS ({selectedItems.length} selected)
              </label>
              <div style={{ display: "flex", gap: 6 }}>
                <button type="button" onClick={selectAllFiltered} style={{
                  padding: "5px 12px", borderRadius: 8, border: `2px solid ${INK}`, background: TEAL, color: "#fff",
                  fontSize: 11, fontWeight: 900, cursor: "pointer", textTransform: "uppercase", letterSpacing: 0.3,
                }}>✓ SELECT ALL{itemSearch ? " (FILTERED)" : ""}</button>
                <button type="button" onClick={clearAllSelected} disabled={selectedItems.length === 0} style={{
                  padding: "5px 12px", borderRadius: 8, border: `2px solid ${INK}`, background: "#fff",
                  color: selectedItems.length === 0 ? "#9A9A92" : INK,
                  fontSize: 11, fontWeight: 900, cursor: selectedItems.length === 0 ? "default" : "pointer",
                  textTransform: "uppercase", letterSpacing: 0.3,
                }}>CLEAR ALL</button>
              </div>
            </div>
            <input value={itemSearch} onChange={(e) => setItemSearch(e.target.value)}
              placeholder="Search menu items..."
              style={{ width: "100%", padding: 10, borderRadius: 8, border: `2px solid ${INK}`, background: "#fff", color: INK, fontSize: 14, fontWeight: 600, boxSizing: "border-box", marginBottom: 10 }} />
            <div style={{ maxHeight: 240, overflow: "auto", border: `2px solid ${INK}`, borderRadius: 8, padding: 8, background: "#fff" }}>
              {filteredItems.slice(0, 200).map((it) => (
                <label key={it.id} style={{
                  display: "flex", alignItems: "center", gap: 8, padding: "6px 8px",
                  borderRadius: 6, cursor: "pointer",
                  background: isItemSelected(it.id) ? "#FFE9FB" : "transparent",
                }}>
                  <input type="checkbox" checked={isItemSelected(it.id)}
                    onChange={() => toggleItem(it)} style={{ cursor: "pointer", accentColor: INK }} />
                  <span style={{ flex: 1, fontSize: 13, fontWeight: 600, color: INK }}>{it.name}</span>
                  <span style={{ fontSize: 11, color: "#6B6B63", fontWeight: 700 }}>₹{it.price}</span>
                  <span style={{
                    fontSize: 10, padding: "2px 6px", borderRadius: 4, fontWeight: 800,
                    background: it.group === "food" ? TEAL : BLUE,
                    color: "#fff",
                  }}>
                    {it.group === "food" ? "food" : "drink"}
                  </span>
                </label>
              ))}
              {filteredItems.length > 200 && (
                <div style={{ padding: 8, fontSize: 11, color: "#6B6B63", textAlign: "center", fontWeight: 600 }}>
                  Showing first 200 of {filteredItems.length} — refine search to see more.
                </div>
              )}
            </div>
          </div>

          <div style={{ display: "flex", gap: 10 }}>
            {editingId ? (
              <button onClick={handleUpdate} disabled={saving} style={{
                flex: 1, padding: 12, borderRadius: 10, border: `2px solid ${INK}`, background: INK, color: "#fff",
                fontWeight: 900, cursor: saving ? "wait" : "pointer", fontSize: 14, letterSpacing: 0.4, textTransform: "uppercase",
              }}>{saving ? "SAVING..." : "💾 UPDATE CATEGORY"}</button>
            ) : (
              <button onClick={handleCreate} disabled={saving} style={{
                flex: 1, padding: 12, borderRadius: 10, border: `2px solid ${INK}`, background: INK, color: "#fff",
                fontWeight: 900, cursor: saving ? "wait" : "pointer", fontSize: 14, letterSpacing: 0.4, textTransform: "uppercase",
              }}>{saving ? "SAVING..." : "➕ CREATE CATEGORY"}</button>
            )}
            <button onClick={resetForm} style={{
              padding: "12px 20px", borderRadius: 10, border: `2px solid ${INK}`,
              background: "#fff", color: INK, fontWeight: 900, cursor: "pointer", letterSpacing: 0.4, textTransform: "uppercase",
            }}>CANCEL</button>
          </div>
        </div>
      )}

      {/* Category List */}
      {loading ? (
        <div style={{ textAlign: "center", padding: 40, color: "#6B6B63", fontWeight: 700 }}>Loading...</div>
      ) : categories.length === 0 ? (
        <div style={{ textAlign: "center", padding: 40, color: "#6B6B63", fontWeight: 700, background: "#fff", border: `2px solid ${INK}`, borderRadius: 12 }}>
          No categories yet. Click "➕ NEW CATEGORY" to create one.
        </div>
      ) : (
        <div>
          {categories.map((cat) => (
            <div key={cat.id} style={{
              background: "#fff",
              border: `2px solid ${cat.isLive ? TEAL : INK}`,
              borderRadius: 12, padding: "14px 18px", marginBottom: 12,
            }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <button onClick={() => handleToggleLive(cat.id, cat.isLive)} style={{
                    width: 46, height: 26, borderRadius: 13, border: `2px solid ${INK}`, cursor: "pointer",
                    background: cat.isLive ? TEAL : "#E8E8E2",
                    display: "flex", alignItems: "center",
                    justifyContent: cat.isLive ? "flex-end" : "flex-start",
                    padding: 2, transition: "all .2s",
                  }}>
                    <div style={{ width: 18, height: 18, borderRadius: 9, background: "#fff", border: `1px solid ${INK}` }} />
                  </button>
                  <div>
                    <div style={{ fontSize: 15, fontWeight: 900, color: INK, letterSpacing: 0.3 }}>
                      {cat.name} {cat.isLive && <span style={{ color: TEAL, fontSize: 11, fontWeight: 900 }}>● LIVE</span>}
                    </div>
                    <div style={{ fontSize: 12, color: "#6B6B63", marginTop: 2, fontWeight: 700 }}>
                      {(cat.items || []).length} items · {(cat.discountPercent || 0)}% discount
                    </div>
                  </div>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={() => startEdit(cat)} style={{
                    padding: "6px 12px", borderRadius: 8, border: `2px solid ${INK}`,
                    background: "#fff", color: INK,
                    fontSize: 12, fontWeight: 900, cursor: "pointer", textTransform: "uppercase",
                  }}>✏️ EDIT</button>
                  <button onClick={() => handleDelete(cat.id, cat.name)} style={{
                    padding: "6px 12px", borderRadius: 8, border: `2px solid ${INK}`,
                    background: ORANGE, color: INK,
                    fontSize: 12, fontWeight: 900, cursor: "pointer",
                  }}>🗑️</button>
                </div>
              </div>

              {cat.items && cat.items.length > 0 && (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 10 }}>
                  {cat.items.slice(0, 8).map((it) => (
                    <span key={it.id} style={{
                      fontSize: 11, padding: "3px 8px", borderRadius: 6,
                      background: "#F4F4F0", color: INK, border: `1px solid ${INK}`, fontWeight: 700,
                    }}>
                      {it.name} ₹{it.price}
                      {(cat.discountPercent || 0) > 0 && (
                        <span style={{ color: TEAL, marginLeft: 4, fontWeight: 900 }}>-{cat.discountPercent}%</span>
                      )}
                    </span>
                  ))}
                  {cat.items.length > 8 && (
                    <span style={{ fontSize: 11, color: "#6B6B63", fontWeight: 700 }}>+{cat.items.length - 8} more</span>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <div style={{ marginTop: 24, padding: 14, borderRadius: 10, background: "#fff", border: `2px solid ${INK}`, fontSize: 12, color: "#3D3D3D", lineHeight: 1.6, fontWeight: 600 }}>
        <strong style={{ color: INK, fontWeight: 900, letterSpacing: 0.3 }}>How it works:</strong><br/>
        🟢 Toggle a category LIVE — items appear on Captain/Bar/Wallet menus instantly<br/>
        ⚪ Toggle OFF — items disappear<br/>
        💰 Discount applies to ALL items in the category automatically<br/>
        🔒 Manager PIN (8888) required for create/edit/delete<br/>
        No auto-expiry — you control everything manually
      </div>
    </div>
  );
}
