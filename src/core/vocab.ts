// The closed POI vocabulary shared by every plan in the organization. Changing
// it is a code change + redeploy, so all exports stay consistent for the
// consuming app and the backend linker. Legacy values on old files are
// preserved (never rewritten) and flagged at export time.
//
// There is ONE list. A room is just a POI with an area attached: its type
// defaults to "room" but can be anything else here (a stairwell, an escalator
// hall, a restroom…). Doors are POIs with a wall span.
import type { Poi } from "./model";

export interface VocabEntry {
  id: string;
  label: string;
  color: string;
}

export const POI_TYPES: VocabEntry[] = [
  { id: "room", label: "Room", color: "#7e57c2" },
  { id: "solid", label: "Solid (filled-in wall)", color: "#263238" },
  { id: "door", label: "Door", color: "#8d6e63" },
  { id: "entrance", label: "Entrance", color: "#e53935" },
  { id: "stairs", label: "Stairs", color: "#5c6bc0" },
  { id: "elevator", label: "Elevator", color: "#8e24aa" },
  { id: "escalator", label: "Escalator", color: "#3949ab" },
  { id: "restroom_male", label: "Restroom (male)", color: "#00897b" },
  { id: "restroom_female", label: "Restroom (female)", color: "#26a69a" },
  { id: "restroom_neutral", label: "Restroom (all-gender)", color: "#43a047" },
  { id: "drinking_fountain", label: "Drinking fountain", color: "#039be5" },
  { id: "vending_machine", label: "Vending machine", color: "#f4511e" },
  { id: "food", label: "Food", color: "#ef6c00" },
  { id: "printer", label: "Printer", color: "#546e7a" },
  { id: "info_desk", label: "Info desk", color: "#f9a825" },
  { id: "other", label: "Other", color: "#6d4c41" },
];

/** Door access restrictions. `undefined` on a POI means a normal door. Open enum:
 *  add entries (e.g. staff_only) without touching the model. */
export const POI_ACCESS: Array<{ id: Poi["access"] & string; label: string }> = [
  { id: "emergency_only", label: "Emergency exit only" },
];

/** Kinds for connections to another building (what the linker edge is tagged with). */
export const EXTERNAL_LINK_KINDS = ["door", "bridge", "tunnel", "path"];

export const isPoiType = (t: string): boolean => POI_TYPES.some((e) => e.id === t);

/** Area-only types: they describe a traced region, never a lone point. "solid"
 *  marks a block the map should draw as filled-in wall (pillars, shafts, chases). */
export const AREA_ONLY_TYPES = new Set(["room", "solid"]);

/** The choices offered for a given POI — the one list, minus what can't apply:
 *  an area can't be a door (doors are wall spans) and a lone point isn't an area. */
export function typeOptionsFor(poi: Pick<Poi, "roomId">): VocabEntry[] {
  return POI_TYPES.filter((e) => (poi.roomId ? e.id !== "door" : !AREA_ONLY_TYPES.has(e.id)));
}

export function vocabLabel(id: string): string {
  return POI_TYPES.find((e) => e.id === id)?.label ?? `(legacy) ${id}`;
}
