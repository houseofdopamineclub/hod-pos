import { useState, useEffect } from "react";
import { db } from "@/lib/firebase";
import {
  collection, addDoc, updateDoc, deleteDoc, doc,
  query, orderBy, onSnapshot, serverTimestamp,
} from "firebase/firestore";
import { sha256 } from "@/lib/firestore-hod";

const MANAGER_HASH = "2926a2731f4b312c08982cacf8061eb14bf65c1a87cc5d70e864e079c6220731";

async function requireManagerPin(reason: string): Promise<boolean> {
  const pin = window.prompt(`🔒 MANAGER PIN REQUIRED\n\n${reason}\n\nENTER 4-DIGIT MANAGER PIN:`);
  if (!pin) return false;
  const h = await sha256(pin.trim());
  if (h !== MANAGER_HASH) { alert("❌ WRONG MANAGER PIN."); return false; }
  return true;
}

interface KnowledgeEntry {
  id: string;
  question: string;
  answer: string;
  keywords: string;
  category: string;
  createdAt?: any;
  updatedAt?: any;
}

const CATEGORIES = [
  "General", "Events", "Menu", "Policies", "Location", "Timing",
  "Pricing", "Tables", "VIP", "FAQs",
];

const STARTER_PACK: { q: string; a: string; k: string; c: string }[] = [
  { c: "Timing", q: "What are your opening hours?",
    a: "🕗 We're open every night from 8 PM to 2 AM.\nKitchen serves till 1:30 AM.\nLast entry: 1 AM sharp.",
    k: "timing, hours, open, close, when, what time, opening, shut, closing time" },
  { c: "Timing", q: "What time should I come?",
    a: "🌙 Crowd builds after 10:30 PM. Best vibe: 11 PM – 1:30 AM.\nIf you want a chill start, come by 9 PM for the early-bird pricing.",
    k: "what time, when to come, peak, best time, crowd, busy" },
  { c: "Location", q: "Where are you located?",
    a: "📍 *House of Dopamine*\n36, 4th B Cross, 5th Block\nKoramangala, Bengaluru\nKarnataka 560095\n\nGoogle Maps: https://maps.google.com/?q=House+of+Dopamine+Koramangala",
    k: "location, address, where, reach, place, find, koramangala, bangalore, bengaluru" },
  { c: "Location", q: "How do I reach by metro?",
    a: "🚇 Nearest metro: Indiranagar (Purple Line) — 10 min cab.\nOr take a cab/Uber/Rapido straight to '5th Block Koramangala'.",
    k: "metro, reach, how to come, cab, uber, ola, rapido, transport" },
  { c: "Location", q: "Is parking available?",
    a: "🚗 Valet parking available at the entrance (₹100).\nFree street parking after 9 PM along 5th Block. Bike parking inside the building.",
    k: "parking, valet, car, bike, vehicle, where to park" },
  { c: "Pricing", q: "What is the entry price?",
    a: "💸 *ENTRY COVER (after 9 PM):*\n\n🗓️ *WEEKDAYS (Mon–Thu):*\n👤 Stag: ₹500\n💑 Couple: ₹999\n💃 Ladies: FREE\n\n🎉 *WEEKENDS (Fri/Sat/Sun):*\n👤 Stag: ₹999\n💑 Couple: ₹1,499\n💃 Ladies: FREE\n\n🆓 *BEFORE 9 PM* = FREE ENTRY for everyone (guestlist).\n\n✅ All cover charges are 100% redeemable on food & drinks. Reply *BOOK* to reserve.",
    k: "price, entry, cover, cost, stag, couple, charge, fee, how much, weekday, weekend, ladies, free" },
  { c: "Pricing", q: "Is cover redeemable?",
    a: "✅ YES — your entire entry cover is 100% redeemable on food and drinks at the bar. You don't lose a rupee!",
    k: "redeemable, cover, refund, adjust, drinks, food, money back" },
  { c: "Pricing", q: "What are VIP table prices?",
    a: "🪑 *VIP TABLES* (min spend, fully redeemable):\n• Ground Floor: ₹5,000 (4 pax)\n• First Floor: ₹8,000 (6 pax)\n• Rooftop: ₹12,000 (8 pax)\n• Private cabana: ₹15,000 (10-12 pax)\n\nReply *TABLE* to reserve.",
    k: "vip, table, premium, cabana, private, minimum spend, floor, rooftop, terrace" },
  { c: "Pricing", q: "Are there any discounts?",
    a: "🎁 *FREEBIES & DISCOUNTS:*\n🆓 *Before 9 PM = FREE entry for EVERYONE* (guestlist)\n💃 Ladies always FREE (any day, any time)\n🎂 Birthday person: complimentary cake + bottle\n👥 Groups of 8+: special table offers — ask us",
    k: "discount, offer, ladies free, early bird, birthday, group, deal, promo, free, guestlist" },
  { c: "Pricing", q: "Is there free entry / guestlist?",
    a: "🆓 *YES — GUESTLIST IS FREE FOR EVERYONE BEFORE 9 PM.*\n\nWalk in any day before 9 PM and entry is on us. After 9 PM, normal cover applies (but it's 100% redeemable on food & drinks).\n\n💃 Ladies always FREE, even after 9 PM.",
    k: "free, guestlist, gl, entry free, no cover, complimentary, before 9, before nine" },
  { c: "Policies", q: "What is the dress code?",
    a: "👔 *SMART CASUAL.* Strictly no:\n❌ Shorts, slippers, sportswear\n❌ Sleeveless on men\n❌ Damaged jeans\n\n✅ Closed shoes, collared shirts, dresses, smart casuals all welcome.",
    k: "dress code, what to wear, shoes, shorts, tshirt, sleeveless, sneakers, clothes" },
  { c: "Policies", q: "What is the age limit?",
    a: "🪪 *21+ ONLY* (Karnataka legal drinking age).\nValid government ID mandatory for everyone — Aadhaar / Passport / Driving License / Voter ID. PAN card NOT accepted.",
    k: "age, age limit, 18, 21, minimum age, id, kid, minor, allowed, under" },
  { c: "Policies", q: "Do I need to bring ID?",
    a: "🪪 YES — original government ID required at the door. Aadhaar / Passport / Driving License / Voter ID. Soft copies on phone are NOT accepted. No ID = no entry, no refund.",
    k: "id, identification, aadhaar, passport, driving license, dl, voter, proof, document" },
  { c: "Policies", q: "Can I bring outside food or drinks?",
    a: "❌ Sorry, no outside food or alcohol allowed. Our bar is fully stocked with premium spirits, cocktails, mocktails & a full kitchen menu till 1:30 AM.",
    k: "outside food, outside drink, byob, bring, own, food, alcohol" },
  { c: "Policies", q: "Is smoking allowed?",
    a: "🚬 Designated smoking zone on the Rooftop only. No smoking inside the club (Karnataka law).",
    k: "smoking, cigarette, smoke, vape, hookah, allowed, zone, area" },
  { c: "Policies", q: "Can I take photos and videos?",
    a: "📸 YES — capture your night! Just please don't film other guests without consent. Our in-house photographer will share event pics on @hodclub.in (Insta) next day.",
    k: "photo, video, camera, instagram, reels, photography, record, film" },
  { c: "Events", q: "What's happening tonight?",
    a: "🎵 Tonight's lineup updates live! Reply *EVENTS* and I'll show you all live events with cover prices.\nOr check: https://hodclub.in/events",
    k: "tonight, event, today, happening, party, lineup, show, schedule, dj" },
  { c: "Events", q: "Do you have ladies night?",
    a: "💃 *LADIES NIGHT — every Wed & Thu*\n• FREE entry for women till 11 PM\n• 50% off on cocktails for ladies all night\n• Live DJ from 10 PM",
    k: "ladies, women, girls, free, wednesday, thursday, ladies night" },
  { c: "Events", q: "Do you have live music?",
    a: "🎤 Yes! Friday = Live Band (8-10 PM) followed by DJ.\nSaturday = Resident DJs spin house/techno/Bollywood.\nSunday = Acoustic chill set.",
    k: "live, band, music, dj, acoustic, genre, performance, artist" },
  { c: "Events", q: "Can I book a private event or birthday?",
    a: "🎂 ABSOLUTELY!\n• Birthday cakes complimentary (book 24 hrs ahead)\n• Private cabana: ₹15,000 (10-12 pax, all redeemable)\n• Buyout for full venue/floor available\n\nReply *PRIVATE* or call us at +91-9611111261 to plan.",
    k: "birthday, private, event, cake, celebration, anniversary, party, book private" },
  { c: "Menu", q: "What food do you serve?",
    a: "🍕 *KITCHEN OPEN TILL 1:30 AM*\nWood-fired pizzas, burgers, pasta, finger foods, biryanis, Asian bowls, charcuterie, desserts.\nReply *MENU* for full menu (coming soon).",
    k: "food, menu, kitchen, eat, serve, pizza, biryani, dishes, veg, vegetarian" },
  { c: "Menu", q: "Do you have vegetarian/vegan options?",
    a: "🥗 YES — full veg menu including vegan pizzas, paneer dishes, Asian bowls, jain options on request. Just ask the server.",
    k: "veg, vegetarian, vegan, jain, plant, paneer, no meat" },
  { c: "Menu", q: "What drinks do you serve?",
    a: "🍸 Full bar — premium spirits (single malts, top vodka/gin/tequila), 30+ signature cocktails, mocktails, craft beer on tap, sparkling wine, sheesha (rooftop only). Last call: 1:45 AM.",
    k: "drinks, alcohol, cocktail, mocktail, beer, wine, whiskey, vodka, sheesha, bar" },
  { c: "Tables", q: "How do I book a table?",
    a: "🪑 Easy! Just reply *TABLE* and I'll walk you through it in 2 steps:\n1. Your details (name, phone, email)\n2. Date, guests, preferred floor\n\nYou'll get an instant confirmation with table ID.",
    k: "table, book, reserve, reservation, vip, booking, how" },
  { c: "Tables", q: "Can I cancel my table booking?",
    a: "✅ Cancel anytime up to 4 hours before your reservation — free of charge. After that, 50% retention. Reply with your TABLE-ID and *CANCEL* to start.",
    k: "cancel, cancellation, refund, table, booking, change" },
  { c: "Tables", q: "Which floor should I pick?",
    a: "🏢 *FLOORS:*\n• Ground (GF) — main dance floor, loudest, full energy\n• First (FF) — bar lounge + cabanas, chill vibe + dance\n• Rooftop (RT) — open-air, hookah, best for groups, sunset views before 8 PM",
    k: "floor, ground, first, rooftop, terrace, gf, ff, rt, where, which" },
  { c: "Pricing", q: "What payment methods do you accept?",
    a: "💳 We accept: Cash, all major Cards (Visa/Master/Amex/Rupay), UPI (GPay/PhonePe/Paytm), Razorpay link for online pre-pay. NO cheques.",
    k: "payment, card, upi, cash, gpay, phonepe, paytm, razorpay, pay, accept" },
  { c: "Pricing", q: "Can I pay online before arriving?",
    a: "✅ YES! When you book via me, I'll send a secure Razorpay payment link. Pay online, skip the door queue, walk straight in with your QR.",
    k: "online, pay, razorpay, prepay, advance, link, qr, queue, skip" },
  { c: "FAQs", q: "Do you allow stags on weekends?",
    a: "👥 *STAG ENTRY — ALL DAYS WELCOME:*\n• Mon–Thu: ₹500 (after 9 PM)\n• Fri / Sat / Sun: ₹999 (after 9 PM)\n• Before 9 PM any day: FREE (guestlist)\n\n✅ 100% cover redeemable on food & drinks.",
    k: "stag, single, men, guys, weekend, friday, saturday, sunday, allowed, entry" },
  { c: "FAQs", q: "Are pets allowed?",
    a: "🐶 Sorry, no pets allowed inside (FSSAI rules). Service animals exempt — please notify in advance.",
    k: "pet, dog, animal, service, allowed" },
  { c: "FAQs", q: "How do I contact you?",
    a: "📞 *CONTACT HOD:*\n• WhatsApp (this number) — fastest\n• Phone: +91 96864 44906\n• Website: hodclub.in\n\nFor table reservations or events — reply *TABLE* or *BOOK* and I'll take care of it instantly. 🎯",
    k: "contact, phone, number, email, instagram, social, call, reach, manager, customer care" },
];

export default function KnowledgeBaseAdmin() {
  const [entries, setEntries] = useState<KnowledgeEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [keywords, setKeywords] = useState("");
  const [category, setCategory] = useState("General");
  const [search, setSearch] = useState("");
  const [saving, setSaving] = useState(false);
  const gold = "#C9A84C";

  useEffect(() => {
    const unsub = onSnapshot(
      query(collection(db, "posBotKnowledge"), orderBy("updatedAt", "desc")),
      (snap) => {
        setEntries(snap.docs.map((d) => ({ id: d.id, ...d.data() } as KnowledgeEntry)));
        setLoading(false);
      },
      (e) => console.error("[kb] failed", e)
    );
    return unsub;
  }, []);

  const resetForm = () => {
    setQuestion("");
    setAnswer("");
    setKeywords("");
    setCategory("General");
    setShowForm(false);
    setEditingId(null);
  };

  const handleSave = async () => {
    if (!question.trim() || !answer.trim()) { alert("Question and answer required"); return; }
    if (!(await requireManagerPin(editingId ? "Update knowledge" : "Add knowledge"))) return;

    setSaving(true);
    try {
      if (editingId) {
        await updateDoc(doc(db, "posBotKnowledge", editingId), {
          question: question.trim(),
          answer: answer.trim(),
          keywords: keywords.trim(),
          category,
          updatedAt: serverTimestamp(),
        });
      } else {
        await addDoc(collection(db, "posBotKnowledge"), {
          question: question.trim(),
          answer: answer.trim(),
          keywords: keywords.trim(),
          category,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }
      resetForm();
    } catch (e: any) { alert("Error: " + e?.message); }
    setSaving(false);
  };

  const [bulkLoading, setBulkLoading] = useState(false);
  const handleBulkSeed = async () => {
    const existingQuestions = new Set(entries.map((e) => e.question.trim().toLowerCase()));
    const toAdd = STARTER_PACK.filter((s) => !existingQuestions.has(s.q.trim().toLowerCase()));
    if (toAdd.length === 0) {
      alert("✅ All starter entries already loaded! Bot KB is fully seeded.");
      return;
    }
    if (!confirm(`Add ${toAdd.length} curated HOD knowledge entries to the bot?\n\n(Duplicates skipped automatically.)`)) return;
    if (!(await requireManagerPin(`Bulk-add ${toAdd.length} starter entries`))) return;
    setBulkLoading(true);
    let ok = 0, fail = 0;
    for (const s of toAdd) {
      try {
        await addDoc(collection(db, "posBotKnowledge"), {
          question: s.q, answer: s.a, keywords: s.k, category: s.c,
          createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
        });
        ok++;
      } catch (e) { console.error("[kb][bulk] add failed:", e); fail++; }
    }
    setBulkLoading(false);
    alert(`✅ DONE!\n\nAdded: ${ok} entries\n${fail > 0 ? `Failed: ${fail}\n` : ""}Bot will use them on the next message — no redeploy needed.`);
  };

  const handleDelete = async (id: string, q: string) => {
    if (!confirm(`Delete "${q}"?`)) return;
    if (!(await requireManagerPin(`Delete knowledge`))) return;
    try { await deleteDoc(doc(db, "posBotKnowledge", id)); } catch (e: any) { alert("Error: " + e?.message); }
  };

  const startEdit = (entry: KnowledgeEntry) => {
    setEditingId(entry.id);
    setQuestion(entry.question);
    setAnswer(entry.answer);
    setKeywords(entry.keywords || "");
    setCategory(entry.category || "General");
    setShowForm(true);
  };

  const filtered = entries.filter((e) => {
    if (!search) return true;
    const s = search.toLowerCase();
    return e.question.toLowerCase().includes(s) ||
      e.answer.toLowerCase().includes(s) ||
      e.keywords.toLowerCase().includes(s) ||
      e.category.toLowerCase().includes(s);
  });

  return (
    <div style={{ padding: 16, color: "#fff", maxWidth: 900, margin: "0 auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 800, color: gold }}>🧠 BOT KNOWLEDGE BASE</h2>
        {!showForm && (
          <button onClick={() => setShowForm(true)} style={{
            padding: "10px 20px", borderRadius: 10, border: "none", background: gold, color: "#030305",
            fontWeight: 800, cursor: "pointer", fontSize: 14,
          }}>➕ ADD KNOWLEDGE</button>
        )}
      </div>

      {/* Search */}
      <input value={search} onChange={(e) => setSearch(e.target.value)}
        placeholder="Search knowledge base..."
        style={{ width: "100%", padding: 10, borderRadius: 8, border: "1px solid rgba(255,255,255,.15)", background: "rgba(255,255,255,.05)", color: "#fff", fontSize: 14, marginBottom: 12, boxSizing: "border-box" }} />

      {/* 🚀 Bulk seed button */}
      {!showForm && (
        <button onClick={handleBulkSeed} disabled={bulkLoading} style={{
          width: "100%", padding: 14, borderRadius: 12, border: `2px solid ${gold}`,
          background: `linear-gradient(135deg, ${gold}25, ${gold}10)`, color: gold,
          fontWeight: 800, fontSize: 14, cursor: bulkLoading ? "wait" : "pointer", marginBottom: 16,
          letterSpacing: 0.5,
        }}>
          {bulkLoading ? "⏳ ADDING..." : `🚀 ADD HOD STARTER PACK (${STARTER_PACK.length} CURATED ENTRIES)`}
        </button>
      )}

      {/* Form */}
      {showForm && (
        <div style={{ background: "hsl(240 12% 8%)", border: `1px solid ${gold}40`, borderRadius: 14, padding: 20, marginBottom: 24 }}>
          <h3 style={{ margin: "0 0 16px", fontSize: 16, color: gold }}>
            {editingId ? "✏️ EDIT KNOWLEDGE" : "➕ ADD KNOWLEDGE"}
          </h3>

          <div style={{ marginBottom: 12 }}>
            <label style={{ fontSize: 12, color: "rgba(255,255,255,.5)", display: "block", marginBottom: 6 }}>QUESTION / TOPIC</label>
            <input value={question} onChange={(e) => setQuestion(e.target.value)}
              placeholder="e.g. What are your opening hours?"
              style={{ width: "100%", padding: 10, borderRadius: 8, border: "1px solid rgba(255,255,255,.15)", background: "rgba(255,255,255,.05)", color: "#fff", fontSize: 14, boxSizing: "border-box" }} />
          </div>

          <div style={{ marginBottom: 12 }}>
            <label style={{ fontSize: 12, color: "rgba(255,255,255,.5)", display: "block", marginBottom: 6 }}>ANSWER</label>
            <textarea value={answer} onChange={(e) => setAnswer(e.target.value)}
              placeholder="e.g. We open at 8 PM and close at 2 AM. Kitchen serves till 1:30 AM."
              rows={4}
              style={{ width: "100%", padding: 10, borderRadius: 8, border: "1px solid rgba(255,255,255,.15)", background: "rgba(255,255,255,.05)", color: "#fff", fontSize: 14, boxSizing: "border-box", resize: "vertical" }} />
          </div>

          <div style={{ display: "flex", gap: 12, marginBottom: 12 }}>
            <div style={{ flex: 1 }}>
              <label style={{ fontSize: 12, color: "rgba(255,255,255,.5)", display: "block", marginBottom: 6 }}>KEYWORDS (comma separated)</label>
              <input value={keywords} onChange={(e) => setKeywords(e.target.value)}
                placeholder="e.g. timing, hours, open, close"
                style={{ width: "100%", padding: 10, borderRadius: 8, border: "1px solid rgba(255,255,255,.15)", background: "rgba(255,255,255,.05)", color: "#fff", fontSize: 14, boxSizing: "border-box" }} />
            </div>
            <div style={{ flex: 1 }}>
              <label style={{ fontSize: 12, color: "rgba(255,255,255,.5)", display: "block", marginBottom: 6 }}>CATEGORY</label>
              <select value={category} onChange={(e) => setCategory(e.target.value)}
                style={{ width: "100%", padding: 10, borderRadius: 8, border: "1px solid rgba(255,255,255,.15)", background: "rgba(255,255,255,.05)", color: "#fff", fontSize: 14, boxSizing: "border-box" }}>
                {CATEGORIES.map((c) => <option key={c} value={c} style={{ background: "#1a1a1a" }}>{c}</option>)}
              </select>
            </div>
          </div>

          <div style={{ display: "flex", gap: 10 }}>
            <button onClick={handleSave} disabled={saving} style={{
              flex: 1, padding: 12, borderRadius: 10, border: "none", background: gold, color: "#030305",
              fontWeight: 800, cursor: saving ? "wait" : "pointer", fontSize: 14,
            }}>{saving ? "SAVING..." : (editingId ? "💾 UPDATE" : "➕ ADD")}</button>
            <button onClick={resetForm} style={{
              padding: "12px 20px", borderRadius: 10, border: "1px solid rgba(255,255,255,.2)",
              background: "transparent", color: "#fff", fontWeight: 700, cursor: "pointer",
            }}>CANCEL</button>
          </div>
        </div>
      )}

      {/* List */}
      {loading ? (
        <div style={{ textAlign: "center", padding: 40, color: "rgba(255,255,255,.4)" }}>Loading...</div>
      ) : filtered.length === 0 ? (
        <div style={{ textAlign: "center", padding: 40, color: "rgba(255,255,255,.4)" }}>
          {search ? "No matches." : "No knowledge entries yet. Click ➕ ADD KNOWLEDGE to start."}
        </div>
      ) : (
        <div>
          {filtered.map((entry) => (
            <div key={entry.id} style={{
              background: "hsl(240 12% 8%)", border: "1px solid rgba(255,255,255,.08)",
              borderRadius: 12, padding: "14px 18px", marginBottom: 10,
            }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: gold, marginBottom: 4 }}>{entry.question}</div>
                  <div style={{ fontSize: 13, color: "rgba(255,255,255,.8)", lineHeight: 1.5, marginBottom: 8 }}>{entry.answer}</div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <span style={{ fontSize: 10, padding: "2px 8px", borderRadius: 6, background: "rgba(201,168,76,.15)", color: gold }}>{entry.category}</span>
                    {entry.keywords && entry.keywords.split(",").map((kw) => (
                      <span key={kw} style={{ fontSize: 10, padding: "2px 8px", borderRadius: 6, background: "rgba(255,255,255,.06)", color: "rgba(255,255,255,.5)" }}>{kw.trim()}</span>
                    ))}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 6, marginLeft: 10 }}>
                  <button onClick={() => startEdit(entry)} style={{
                    padding: "4px 10px", borderRadius: 6, border: `1px solid ${gold}40`, background: `${gold}10`, color: gold,
                    fontSize: 11, fontWeight: 700, cursor: "pointer",
                  }}>✏️</button>
                  <button onClick={() => handleDelete(entry.id, entry.question)} style={{
                    padding: "4px 10px", borderRadius: 6, border: "1px solid rgba(239,68,68,.3)", background: "rgba(239,68,68,.08)", color: "#EF4444",
                    fontSize: 11, fontWeight: 700, cursor: "pointer",
                  }}>🗑️</button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Default Knowledge Suggestions */}
      {!showForm && entries.length < 5 && (
        <div style={{ marginTop: 24, padding: 16, borderRadius: 12, background: "rgba(201,168,76,.08)", border: `1px solid ${gold}20` }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: gold, marginBottom: 10 }}>📝 SUGGESTED KNOWLEDGE TO ADD</div>
          {[
            { q: "What are your opening hours?", a: "We open at 8 PM and close at 2 AM. Kitchen serves till 1:30 AM. Last entry is 1 AM.", k: "timing, hours, open, close", c: "Timing" },
            { q: "Where are you located?", a: "House of Dopamine is at 5th Block, Koramangala, Bangalore — above Starbucks, near Sony Signal.", k: "location, address, where, reach", c: "Location" },
            { q: "What is the entry price?", a: "Stag entry: ₹500 | Couple entry: ₹800 | VIP tables: ₹5,000-15,000 minimum spend.", k: "price, entry, cover, cost, stag, couple", c: "Pricing" },
            { q: "What events are happening tonight?", a: "Check our events at hodclub.in/events or ask me to book! Every night is different — from Techno Tuesdays to Ladies Nights.", k: "event, tonight, happening, party", c: "Events" },
            { q: "Do you serve food?", a: "Yes! Our kitchen serves till 1:30 AM. Pizzas, finger food, and gourmet bites available.", k: "food, menu, kitchen, eat, serve", c: "Menu" },
          ].map((s, i) => (
            <div key={i} onClick={() => { setQuestion(s.q); setAnswer(s.a); setKeywords(s.k); setCategory(s.c); setShowForm(true); }}
              style={{ padding: "8px 12px", borderRadius: 8, background: "rgba(255,255,255,.03)", marginBottom: 8, cursor: "pointer", fontSize: 13, color: "rgba(255,255,255,.7)" }}>
              <span style={{ color: gold }}>+</span> {s.q}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
