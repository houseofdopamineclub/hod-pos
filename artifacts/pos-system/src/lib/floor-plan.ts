// AUTO-PORTED from hodclub-patched/index.html (_HOD_TABLES).
// Khushi 2026-05-20 — Captain Mode floor-plan dashboard reuses the exact
// same SVG layout the customer sees on hodclub.in/?book=table, so what
// captain taps == what the guest booked. Keep this file in lockstep with
// hodclub-patched: if you edit one, edit the other.
//
// 🎨 2026-06-03 (Khushi) — the `bg` SVG layer was AUTO-PORTED from the DARK
// customer site (near-black panel rgba(12,8,22,.95) + translucent-white
// labels). Captain Mode is now Gumroad-brutalist (white panel, beige zone
// boxes, 2px black borders, INK text), so the bg layer below is recolored to
// match Door/Bar. The TABLE TILES themselves are colored at runtime by
// CaptainMode's colorFor() — only this static room layout lives here.
// NOTE: this is the POS copy ONLY; the customer site bg stays dark.
//
// Floor keys: 'dance' (= Ground Floor), 'dining', 'rooftop'.

export type FloorTable = {
  id: string;
  seats: number;
  sh: 'circle' | 'rect' | 'diamond';
  cx?: number; cy?: number; r?: number;
  x?: number; y?: number; w?: number; h?: number;
  vip?: boolean;
};
export type FloorData = { label: string; icon: string; vb: string; tables: FloorTable[]; bg: string };
export type FloorKey = 'dance' | 'dining' | 'rooftop';

export const HOD_TABLES: Record<FloorKey, FloorData> = {
  dance:{
    label:'Dance Floor',icon:'🎧',
    vb:'0 0 500 430',
    tables:[
      {id:'C1',seats:4,sh:'circle',cx:115,cy:215,r:34},
      {id:'C2',seats:4,sh:'circle',cx:225,cy:165,r:34},
      {id:'C3',seats:4,sh:'circle',cx:335,cy:215,r:34},
      {id:'C4',seats:4,sh:'circle',cx:225,cy:295,r:34},
      {id:'CVIP1',seats:8,sh:'rect',x:390,y:120,w:90,h:80,vip:true},
      {id:'CVIP2',seats:8,sh:'rect',x:390,y:260,w:90,h:80,vip:true}
    ],
    bg:'<defs><filter id="tglow"><feGaussianBlur stdDeviation="3" result="blur"/><feComposite in="SourceGraphic" in2="blur" operator="over"/></filter></defs>'
      +'<rect x="8" y="8" width="484" height="414" rx="12" fill="#fff" stroke="#000" stroke-width="2"/>'
      +'<rect x="165" y="14" width="175" height="52" rx="6" fill="#F4F4F0" stroke="#000" stroke-width="1"/>'
      +'<text x="252" y="44" text-anchor="middle" fill="#000" font-size="10" font-weight="800" font-family="sans-serif" letter-spacing="2">DJ BOOTH</text>'
      +'<rect x="390" y="14" width="92" height="95" rx="6" fill="#FBF3D6" stroke="#000" stroke-width="1"/>'
      +'<text x="436" y="55" text-anchor="middle" fill="#000" font-size="10" font-weight="800" font-family="sans-serif">🍸 BAR</text>'
      +'<rect x="390" y="345" width="92" height="55" rx="6" fill="#F4F4F0" stroke="#000" stroke-width="1"/>'
      +'<text x="436" y="376" text-anchor="middle" fill="#6B6B6B" font-size="9" font-weight="700" font-family="sans-serif">ENTRANCE</text>'
      +'<text x="226" y="400" text-anchor="middle" fill="rgba(0,0,0,.06)" font-size="48" font-weight="900" font-family="sans-serif" letter-spacing="4">DANCE</text>'
  },
  dining:{
    label:'Dining',icon:'🍽️',
    vb:'0 0 520 780',
    tables:[
      {id:'FD6', seats:6,sh:'rect',   x:14, y:140,w:110,h:60},
      {id:'FD7', seats:3,sh:'rect',   x:136,y:140,w:88, h:60},
      {id:'FD5', seats:4,sh:'rect',   x:14, y:218,w:62, h:78},
      {id:'FD8', seats:2,sh:'circle', cx:168,cy:258,r:28},
      {id:'FD4', seats:6,sh:'rect',   x:14, y:335,w:110,h:60},
      {id:'FD3', seats:3,sh:'rect',   x:136,y:335,w:88, h:60},
      {id:'FD9', seats:2,sh:'rect',   x:292,y:164,w:44, h:58},
      {id:'FD15',seats:4,sh:'diamond',cx:392,cy:193,r:36},
      {id:'FD16',seats:3,sh:'circle', cx:468,cy:181,r:26},
      {id:'FD10',seats:2,sh:'rect',   x:292,y:281,w:44, h:58},
      {id:'FD14',seats:4,sh:'diamond',cx:392,cy:310,r:36},
      {id:'FD17',seats:3,sh:'circle', cx:468,cy:300,r:26},
      {id:'FD11',seats:2,sh:'rect',   x:292,y:398,w:44, h:58},
      {id:'FD12',seats:4,sh:'diamond',cx:392,cy:427,r:36},
      {id:'FD18',seats:3,sh:'circle', cx:468,cy:417,r:26},
      {id:'FD2', seats:4,sh:'rect',   x:252,y:512,w:84, h:58},
      {id:'FD1', seats:4,sh:'rect',   x:252,y:590,w:84, h:58},
      {id:'SMK4',seats:2,sh:'circle', cx:76, cy:522,r:22},
      {id:'SMK5',seats:2,sh:'circle', cx:76, cy:587,r:22},
      {id:'SMK6',seats:2,sh:'circle', cx:76, cy:652,r:22},
      {id:'SMK7',seats:2,sh:'circle', cx:76, cy:717,r:22},
      {id:'SMK2',seats:8,sh:'rect',   x:148,y:500,w:72, h:82},
      {id:'SMK1',seats:4,sh:'rect',   x:148,y:598,w:68, h:48},
      {id:'SMK8',seats:4,sh:'rect',   x:148,y:658,w:68, h:48}
    ],
    bg:'<defs><filter id="tglow"><feGaussianBlur stdDeviation="3" result="blur"/><feComposite in="SourceGraphic" in2="blur" operator="over"/></filter></defs>'
      +'<rect x="8" y="8" width="504" height="764" rx="12" fill="#fff" stroke="#000" stroke-width="2"/>'
      /* STORE */
      +'<rect x="11" y="11" width="185" height="118" rx="5" fill="#F4F4F0" stroke="#000" stroke-width="1"/>'
      +'<text x="103" y="74" text-anchor="middle" fill="#000" font-size="11" font-weight="800" font-family="sans-serif" letter-spacing="2">STORE</text>'
      /* BAR + BILLER */
      +'<rect x="250" y="11" width="254" height="118" rx="5" fill="#FBF3D6" stroke="#000" stroke-width="1"/>'
      +'<text x="377" y="58" text-anchor="middle" fill="#000" font-size="13" font-weight="900" font-family="sans-serif" letter-spacing="3">🍸 BAR</text>'
      +'<rect x="430" y="100" width="70" height="22" rx="3" fill="#fff" stroke="#000" stroke-width="1"/>'
      +'<text x="465" y="115" text-anchor="middle" fill="#000" font-size="8" font-weight="800" font-family="sans-serif" letter-spacing="1.5">BILLER</text>'
      /* SOFA LOUNGE label */
      +'<text x="110" y="308" text-anchor="middle" fill="#6B6B6B" font-size="11" font-weight="800" font-family="sans-serif" letter-spacing="2">SOFA LOUNGE</text>'
      /* GARDEN + SMOKING */
      +'<rect x="10" y="478" width="240" height="270" rx="8" fill="#E6F5F2" stroke="#23A094" stroke-width="1.5"/>'
      +'<text x="28" y="610" text-anchor="middle" fill="#23A094" font-size="9" font-weight="800" font-family="sans-serif" transform="rotate(-90,28,610)" letter-spacing="2">🌿 GARDEN AREA</text>'
      +'<text x="155" y="494" text-anchor="middle" fill="#FF5733" font-size="8" font-weight="800" font-family="sans-serif" letter-spacing="1.5">🚬 SMOKING ZONE</text>'
      /* STANDING COUNTER bottom-left */
      +'<rect x="10" y="752" width="240" height="20" rx="3" fill="#F4F4F0" stroke="#000" stroke-width="1"/>'
      +'<text x="130" y="766" text-anchor="middle" fill="#000" font-size="8" font-weight="800" font-family="sans-serif" letter-spacing="2">STANDING COUNTER</text>'
      /* STAIRS — actual staircase illustration */
      +'<rect x="346" y="478" width="164" height="118" rx="6" fill="#FBF3D6" stroke="#000" stroke-width="1"/>'
      +'<g stroke="#6B6B6B" stroke-width="1" fill="none">'
      +'<line x1="360" y1="498" x2="496" y2="498"/>'
      +'<line x1="360" y1="510" x2="496" y2="510"/>'
      +'<line x1="360" y1="522" x2="496" y2="522"/>'
      +'<line x1="360" y1="534" x2="496" y2="534"/>'
      +'<line x1="360" y1="546" x2="496" y2="546"/>'
      +'<line x1="360" y1="558" x2="496" y2="558"/>'
      +'<line x1="360" y1="570" x2="496" y2="570"/>'
      +'</g>'
      +'<text x="428" y="588" text-anchor="middle" fill="#000" font-size="9" font-weight="800" font-family="sans-serif" letter-spacing="2">↓ STAIRS</text>'
      /* LIFT */
      +'<rect x="346" y="608" width="50" height="78" rx="6" fill="#FBF3D6" stroke="#000" stroke-width="1"/>'
      +'<text x="371" y="643" text-anchor="middle" fill="#000" font-size="18" font-weight="700">⬍</text>'
      +'<text x="371" y="673" text-anchor="middle" fill="#000" font-size="8" font-weight="800" font-family="sans-serif" letter-spacing="2">LIFT</text>'
      /* MEN WASHROOM */
      +'<rect x="400" y="608" width="54" height="78" rx="6" fill="rgba(96,165,250,.15)" stroke="#60A5FA" stroke-width="1"/>'
      +'<text x="427" y="640" text-anchor="middle" fill="#2563EB" font-size="22" font-weight="700">♂</text>'
      +'<text x="427" y="664" text-anchor="middle" fill="#000" font-size="8" font-weight="800" font-family="sans-serif" letter-spacing="1">MEN</text>'
      +'<text x="427" y="678" text-anchor="middle" fill="#6B6B6B" font-size="6" font-weight="700" font-family="sans-serif" letter-spacing=".8">WASHROOM</text>'
      /* WOMEN WASHROOM */
      +'<rect x="458" y="608" width="54" height="78" rx="6" fill="rgba(255,144,232,.25)" stroke="#FF90E8" stroke-width="1"/>'
      +'<text x="485" y="640" text-anchor="middle" fill="#000" font-size="22" font-weight="700">♀</text>'
      +'<text x="485" y="664" text-anchor="middle" fill="#000" font-size="8" font-weight="800" font-family="sans-serif" letter-spacing="1">WOMEN</text>'
      +'<text x="485" y="678" text-anchor="middle" fill="#6B6B6B" font-size="6" font-weight="700" font-family="sans-serif" letter-spacing=".8">WASHROOM</text>'
      /* SECOND FLOOR watermark */
      +'<text x="430" y="755" text-anchor="middle" fill="rgba(0,0,0,.06)" font-size="13" font-weight="900" font-family="sans-serif" letter-spacing="3">SECOND FLOOR</text>'
  },
  rooftop:{
    label:'Rooftop',icon:'🌿',
    vb:'0 0 540 820',
    tables:[
      {id:'T3', seats:2, sh:'circle', cx:190,cy:175,r:26},
      {id:'T4', seats:4, sh:'rect',   x:296,y:148,w:65,h:55},
      {id:'T11',seats:4, sh:'rect',   x:412,y:145,w:82,h:62},
      {id:'T2', seats:2, sh:'circle', cx:190,cy:268,r:26},
      {id:'T5', seats:4, sh:'rect',   x:296,y:240,w:65,h:58},
      {id:'T10',seats:6, sh:'rect',   x:412,y:230,w:82,h:78},
      {id:'T1', seats:2, sh:'circle', cx:190,cy:362,r:26},
      {id:'T6', seats:4, sh:'diamond',cx:330,cy:362,r:30},
      {id:'T9', seats:5, sh:'rect',   x:412,y:322,w:82,h:80},
      {id:'T7', seats:4, sh:'rect',   x:296,y:427,w:80,h:56},
      {id:'T8', seats:5, sh:'rect',   x:412,y:418,w:82,h:74},
      {id:'TVIP7',seats:2,sh:'rect',  x:28, y:504,w:78,h:42,vip:true},
      {id:'TEX1', seats:2,sh:'rect',  x:130,y:504,w:78,h:42,vip:true},
      {id:'TVIP6',seats:6,sh:'rect',  x:20, y:584,w:88,h:58,vip:true},
      {id:'TVIP1',seats:6,sh:'rect',  x:118,y:584,w:88,h:58,vip:true},
      {id:'TVIP5',seats:6,sh:'rect',  x:20, y:656,w:88,h:58,vip:true},
      {id:'TVIP2',seats:6,sh:'rect',  x:118,y:656,w:88,h:58,vip:true},
      {id:'TVIP3',seats:7,sh:'rect',  x:20, y:728,w:88,h:62,vip:true},
      {id:'TVIP4',seats:7,sh:'rect',  x:118,y:728,w:88,h:62,vip:true}
    ],
    bg:'<defs><filter id="tglow"><feGaussianBlur stdDeviation="3" result="blur"/><feComposite in="SourceGraphic" in2="blur" operator="over"/></filter></defs>'
      +'<rect x="8" y="8" width="524" height="804" rx="12" fill="#fff" stroke="#000" stroke-width="2"/>'
      /* DJ TABLE */
      +'<rect x="435" y="10" width="97" height="68" rx="5" fill="rgba(123,47,190,.12)" stroke="rgba(168,85,247,.7)" stroke-width="1"/>'
      +'<text x="483" y="48" text-anchor="middle" fill="#6B21A8" font-size="11" font-weight="900" font-family="sans-serif" letter-spacing="2">🎧 DJ</text>'
      /* BAR COUNTER */
      +'<rect x="10" y="10" width="55" height="380" rx="5" fill="#FBF3D6" stroke="#000" stroke-width="1"/>'
      +'<text x="37" y="205" text-anchor="middle" fill="#000" font-size="10" font-weight="900" font-family="sans-serif" transform="rotate(-90,37,205)" letter-spacing="2">🍸 BAR COUNTER</text>'
      /* COUNTER TABLE (vertical) */
      +'<rect x="70" y="10" width="52" height="380" rx="5" fill="#F4F4F0" stroke="#000" stroke-width="1"/>'
      +'<text x="96" y="210" text-anchor="middle" fill="#000" font-size="9" font-weight="800" font-family="sans-serif" transform="rotate(-90,96,210)" letter-spacing="2">COUNTER TABLE</text>'
      /* BILLER */
      +'<rect x="68" y="365" width="56" height="22" rx="3" fill="#fff" stroke="#000" stroke-width="1"/>'
      +'<text x="96" y="380" text-anchor="middle" fill="#000" font-size="8" font-weight="800" font-family="sans-serif" letter-spacing="1.5">BILLER</text>'
      /* COUNTER TABLE (horizontal, holds TVIP7/TEX1) */
      +'<rect x="16" y="484" width="208" height="76" rx="5" fill="#F4F4F0" stroke="#000" stroke-width="1"/>'
      +'<text x="116" y="498" text-anchor="middle" fill="#000" font-size="8" font-weight="800" font-family="sans-serif" letter-spacing="2">COUNTER TABLE</text>'
      /* GLASS FLOOR */
      +'<rect x="16" y="562" width="208" height="242" rx="8" fill="#E6F5F2" stroke="#23A094" stroke-width="1.5"/>'
      +'<text x="120" y="578" text-anchor="middle" fill="#23A094" font-size="10" font-weight="900" font-family="sans-serif" letter-spacing="2.5">✦ GLASS FLOOR ✦</text>'
      /* STAIRS — actual staircase */
      +'<rect x="246" y="508" width="210" height="140" rx="6" fill="#FBF3D6" stroke="#000" stroke-width="1"/>'
      +'<g stroke="#6B6B6B" stroke-width="1" fill="none">'
      +'<line x1="262" y1="528" x2="440" y2="528"/>'
      +'<line x1="262" y1="540" x2="440" y2="540"/>'
      +'<line x1="262" y1="552" x2="440" y2="552"/>'
      +'<line x1="262" y1="564" x2="440" y2="564"/>'
      +'<line x1="262" y1="576" x2="440" y2="576"/>'
      +'<line x1="262" y1="588" x2="440" y2="588"/>'
      +'<line x1="262" y1="600" x2="440" y2="600"/>'
      +'<line x1="262" y1="612" x2="440" y2="612"/>'
      +'<line x1="262" y1="624" x2="440" y2="624"/>'
      +'</g>'
      +'<text x="351" y="640" text-anchor="middle" fill="#000" font-size="10" font-weight="900" font-family="sans-serif" letter-spacing="2">↓ STAIRS</text>'
      /* LIFT */
      +'<rect x="246" y="660" width="56" height="80" rx="6" fill="#FBF3D6" stroke="#000" stroke-width="1"/>'
      +'<text x="274" y="697" text-anchor="middle" fill="#000" font-size="20" font-weight="700">⬍</text>'
      +'<text x="274" y="725" text-anchor="middle" fill="#000" font-size="8" font-weight="800" font-family="sans-serif" letter-spacing="2">LIFT</text>'
      /* MEN WASHROOM */
      +'<rect x="310" y="660" width="68" height="80" rx="6" fill="rgba(96,165,250,.15)" stroke="#60A5FA" stroke-width="1"/>'
      +'<text x="344" y="694" text-anchor="middle" fill="#2563EB" font-size="24" font-weight="700">♂</text>'
      +'<text x="344" y="717" text-anchor="middle" fill="#000" font-size="8" font-weight="800" font-family="sans-serif" letter-spacing="1">MEN</text>'
      +'<text x="344" y="730" text-anchor="middle" fill="#6B6B6B" font-size="6" font-weight="700" font-family="sans-serif" letter-spacing=".8">WASHROOM</text>'
      /* WOMEN WASHROOM */
      +'<rect x="386" y="660" width="68" height="80" rx="6" fill="rgba(255,144,232,.25)" stroke="#FF90E8" stroke-width="1"/>'
      +'<text x="420" y="694" text-anchor="middle" fill="#000" font-size="24" font-weight="700">♀</text>'
      +'<text x="420" y="717" text-anchor="middle" fill="#000" font-size="8" font-weight="800" font-family="sans-serif" letter-spacing="1">WOMEN</text>'
      +'<text x="420" y="730" text-anchor="middle" fill="#6B6B6B" font-size="6" font-weight="700" font-family="sans-serif" letter-spacing=".8">WASHROOM</text>'
      /* THIRD FLOOR / ROOFTOP watermark */
      +'<text x="380" y="790" text-anchor="middle" fill="rgba(0,0,0,.06)" font-size="22" font-weight="900" font-family="sans-serif" letter-spacing="6">ROOFTOP</text>'
  }
};

// 🆕 2026-05-26 v3.10 (Khushi — Fix #1 Listener Scoping support).
// Look up which floor a tableId belongs to using the HOD_TABLES map.
// Returns null for tableIds NOT in the map — caller MUST fail-open and KEEP
// those rows visible (walk-in / proxy / aggregator / typo IDs etc.), never
// silently drop them.
let _floorIndex: Map<string, FloorKey> | null = null;
export function getFloorFromTableId(tableId: string): FloorKey | null {
  if (!_floorIndex) {
    _floorIndex = new Map();
    (Object.keys(HOD_TABLES) as FloorKey[]).forEach((fk) => {
      HOD_TABLES[fk].tables.forEach((t) => {
        _floorIndex!.set(t.id.toUpperCase(), fk);
      });
    });
  }
  if (!tableId) return null;
  return _floorIndex.get(tableId.toUpperCase()) || null;
}

// TabletFloor (firestore-hod.ts) uses ground/first/rooftop for printer routing,
// FloorKey (floor-plan.ts) uses dance/dining/rooftop for the SVG layout.
// Single source-of-truth mapping so we don't drift.
export const TABLET_FLOOR_TO_FLOORKEY: Record<"ground" | "first" | "rooftop", FloorKey> = {
  ground: "dance",
  first: "dining",
  rooftop: "rooftop",
};
