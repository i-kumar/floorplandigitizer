// Deterministic entity colors, shared by the canvas renderer and the UI chrome.

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

const ROOM_PALETTE = ["#7e57c2", "#26a69a", "#ef6c00", "#5c6bc0", "#9ccc65", "#ec407a"];

export function roomColor(id: string): string {
  return ROOM_PALETTE[hashStr(id) % ROOM_PALETTE.length];
}

// Distinct, saturated hues that read on the light canvas. A few common types get
// stable assignments; everything else hashes into the palette.
const POI_PALETTE = [
  "#e53935", // red
  "#8e24aa", // purple
  "#3949ab", // indigo
  "#0097a7", // teal
  "#43a047", // green
  "#f9a825", // amber
  "#6d4c41", // brown
  "#d81b60", // pink
  "#00838f", // cyan-dark
  "#7cb342", // light green
];

const FIXED_POI_COLORS: Record<string, string> = {
  room: "#7e57c2",
  door: "#8d6e63",
  drinking_fountain: "#039be5",
  vending_machine: "#f4511e",
  restroom: "#00897b",
  exit: "#e53935",
};

export function poiColor(type: string): string {
  return FIXED_POI_COLORS[type] ?? POI_PALETTE[hashStr(type) % POI_PALETTE.length];
}
