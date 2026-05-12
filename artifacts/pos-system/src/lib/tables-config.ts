import type { TableConfig } from "./types";

export const GROUND_TABLES: TableConfig[] = [
  { id: "C1", name: "C 1", capacity: 4, section: "ground", shape: "round" },
  { id: "C2", name: "C 2", capacity: 4, section: "ground", shape: "round" },
  { id: "C3", name: "C 3", capacity: 4, section: "ground", shape: "round" },
  { id: "C4", name: "C 4", capacity: 4, section: "ground", shape: "round" },
  { id: "CVIP1", name: "CVIP 1", capacity: 6, section: "ground-vvip", isVIP: true, shape: "rect" },
  { id: "CVIP2", name: "CVIP 2", capacity: 6, section: "ground-vvip", isVIP: true, shape: "rect" },
];

export const DINING_TABLES: TableConfig[] = [
  { id: "FD1", name: "FD 1", capacity: 4, section: "dining" },
  { id: "FD2", name: "FD 2", capacity: 4, section: "dining" },
  { id: "FD3", name: "FD 3", capacity: 4, section: "dining" },
  { id: "FD4", name: "FD 4", capacity: 6, section: "dining" },
  { id: "FD5", name: "FD 5", capacity: 4, section: "dining" },
  { id: "FD6", name: "FD 6", capacity: 4, section: "dining" },
  { id: "FD7", name: "FD 7", capacity: 6, section: "dining" },
  { id: "FD8", name: "FD 8", capacity: 4, section: "dining" },
  { id: "FD9", name: "FD 9", capacity: 4, section: "dining" },
  { id: "FD10", name: "FD 10", capacity: 6, section: "dining" },
  { id: "FD11", name: "FD 11", capacity: 4, section: "dining" },
  { id: "FD12", name: "FD 12", capacity: 4, section: "dining" },
  { id: "FD13", name: "FD 13", capacity: 4, section: "dining" },
  { id: "FD14", name: "FD 14", capacity: 6, section: "dining" },
  { id: "FD15", name: "FD 15", capacity: 4, section: "dining" },
  { id: "FD16", name: "FD 16", capacity: 4, section: "dining" },
  { id: "FD17", name: "FD 17", capacity: 6, section: "dining" },
  { id: "FD18", name: "FD 18", capacity: 8, section: "dining" },
];

export const SMOKING_TABLES: TableConfig[] = [
  { id: "SMK1", name: "SMK 1", capacity: 4, section: "smoking" },
  { id: "SMK2", name: "SMK 2", capacity: 4, section: "smoking" },
  { id: "SMK3", name: "SMK 3", capacity: 4, section: "smoking" },
  { id: "SMK4", name: "SMK 4", capacity: 4, section: "smoking" },
  { id: "SMK5", name: "SMK 5", capacity: 6, section: "smoking" },
  { id: "SMK6", name: "SMK 6", capacity: 4, section: "smoking" },
  { id: "SMK7", name: "SMK 7", capacity: 4, section: "smoking" },
  { id: "SMK8", name: "SMK 8", capacity: 6, section: "smoking" },
];

export const ROOFTOP_TABLES: TableConfig[] = [
  { id: "T1", name: "T 1", capacity: 4, section: "rooftop" },
  { id: "T2", name: "T 2", capacity: 4, section: "rooftop" },
  { id: "T3", name: "T 3", capacity: 4, section: "rooftop" },
  { id: "T4", name: "T 4", capacity: 6, section: "rooftop" },
  { id: "T5", name: "T 5", capacity: 4, section: "rooftop" },
  { id: "T6", name: "T 6", capacity: 4, section: "rooftop" },
  { id: "T7", name: "T 7", capacity: 6, section: "rooftop" },
  { id: "T8", name: "T 8", capacity: 4, section: "rooftop" },
  { id: "T9", name: "T 9", capacity: 4, section: "rooftop" },
  { id: "T10", name: "T 10", capacity: 6, section: "rooftop" },
  { id: "T11", name: "T 11", capacity: 8, section: "rooftop" },
  { id: "TVIP1", name: "VIP 1", capacity: 6, section: "rooftop-vip", isVIP: true },
  { id: "TVIP2", name: "VIP 2", capacity: 6, section: "rooftop-vip", isVIP: true },
  { id: "TVIP3", name: "VIP 3", capacity: 6, section: "rooftop-vip", isVIP: true },
  { id: "TVIP4", name: "VIP 4", capacity: 8, section: "rooftop-vip", isVIP: true },
  { id: "TVIP5", name: "VIP 5", capacity: 6, section: "rooftop-vip", isVIP: true },
  { id: "TVIP6", name: "VIP 6", capacity: 6, section: "rooftop-vip", isVIP: true },
  { id: "TVIP7", name: "VIP 7", capacity: 8, section: "rooftop-vip", isVIP: true },
  { id: "TEX1", name: "EX 1", capacity: 12, section: "rooftop-vip", isVIP: true },
];

export const ALL_TABLES: TableConfig[] = [
  ...GROUND_TABLES,
  ...DINING_TABLES,
  ...SMOKING_TABLES,
  ...ROOFTOP_TABLES,
];

export const SECTION_LABELS: Record<string, string> = {
  ground: "Ground Floor",
  "ground-vvip": "Ground Floor VVIP",
  dining: "2nd Floor Dining",
  smoking: "2nd Floor Smoking",
  rooftop: "Rooftop",
  "rooftop-vip": "Rooftop VIP",
};

export function getTableById(id: string): TableConfig | undefined {
  return ALL_TABLES.find((t) => t.id === id);
}

export function getTablesBySection(section: string): TableConfig[] {
  return ALL_TABLES.filter((t) => t.section === section);
}
