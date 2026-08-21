import { describe, expect, it } from "vitest";
import {
  angleDeltaDeg,
  dist,
  nearest45,
  pointInPolygon,
  polygonCentroid,
  polygonSignedArea,
  projectPointOnSegment,
  raySegmentIntersection,
  segSegIntersection,
} from "./geometry";

describe("projectPointOnSegment", () => {
  it("projects onto the interior", () => {
    const r = projectPointOnSegment({ x: 5, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 });
    expect(r.point).toEqual({ x: 5, y: 0 });
    expect(r.t).toBeCloseTo(0.5);
  });
  it("clamps to the endpoints", () => {
    const r = projectPointOnSegment({ x: -4, y: 2 }, { x: 0, y: 0 }, { x: 10, y: 0 });
    expect(r.point).toEqual({ x: 0, y: 0 });
    expect(r.t).toBe(0);
    const r2 = projectPointOnSegment({ x: 14, y: 2 }, { x: 0, y: 0 }, { x: 10, y: 0 });
    expect(r2.t).toBe(1);
  });
  it("handles zero-length segments", () => {
    const r = projectPointOnSegment({ x: 3, y: 3 }, { x: 1, y: 1 }, { x: 1, y: 1 });
    expect(r.point).toEqual({ x: 1, y: 1 });
  });
});

describe("raySegmentIntersection", () => {
  it("finds a forward hit", () => {
    const hit = raySegmentIntersection(
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 5, y: -2 },
      { x: 5, y: 2 },
    );
    expect(hit).not.toBeNull();
    expect(hit!.point.x).toBeCloseTo(5);
    expect(hit!.point.y).toBeCloseTo(0);
    expect(hit!.rayT).toBeCloseTo(5);
    expect(hit!.segT).toBeCloseTo(0.5);
  });
  it("rejects hits behind the origin", () => {
    const hit = raySegmentIntersection(
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: -5, y: -2 },
      { x: -5, y: 2 },
    );
    expect(hit).toBeNull();
  });
  it("rejects misses beyond the segment ends", () => {
    const hit = raySegmentIntersection(
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 5, y: 2 },
      { x: 5, y: 6 },
    );
    expect(hit).toBeNull();
  });
  it("rejects parallels", () => {
    const hit = raySegmentIntersection(
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 1 },
      { x: 9, y: 1 },
    );
    expect(hit).toBeNull();
  });
});

describe("segSegIntersection", () => {
  it("finds a proper crossing", () => {
    const hit = segSegIntersection(
      { x: 0, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
      { x: 10, y: 0 },
    );
    expect(hit).not.toBeNull();
    expect(hit!.point.x).toBeCloseTo(5);
    expect(hit!.point.y).toBeCloseTo(5);
    expect(hit!.t).toBeCloseTo(0.5);
    expect(hit!.u).toBeCloseTo(0.5);
  });
  it("a shared endpoint is not a crossing", () => {
    const hit = segSegIntersection(
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    );
    expect(hit).toBeNull();
  });
  it("an end merely touching the other segment's interior is not a crossing", () => {
    const hit = segSegIntersection(
      { x: 0, y: 0 },
      { x: 5, y: 5 },
      { x: 0, y: 10 },
      { x: 10, y: 0 },
    );
    expect(hit).toBeNull(); // t would be 1 exactly
  });
  it("parallels do not intersect", () => {
    const hit = segSegIntersection(
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 0, y: 5 },
      { x: 10, y: 5 },
    );
    expect(hit).toBeNull();
  });
});

describe("nearest45 / angleDeltaDeg (y-down)", () => {
  it("snaps to the horizontal", () => {
    const { angleDeg, dir } = nearest45({ x: 100, y: 5 });
    expect(angleDeg).toBe(0);
    expect(dir.x).toBeCloseTo(1);
    expect(dir.y).toBeCloseTo(0);
  });
  it("snaps to the y-down diagonal", () => {
    const { angleDeg, dir } = nearest45({ x: 10, y: 11 });
    expect(angleDeg).toBe(45);
    expect(dir.x).toBeCloseTo(Math.SQRT1_2);
    expect(dir.y).toBeCloseTo(Math.SQRT1_2);
  });
  it("snaps to 270 for straight up (negative y)", () => {
    const { angleDeg } = nearest45({ x: 1, y: -50 });
    expect(angleDeg).toBe(270);
  });
  it("measures angular deltas", () => {
    expect(angleDeltaDeg({ x: 100, y: 5 }, { x: 1, y: 0 })).toBeCloseTo(2.862, 2);
    expect(angleDeltaDeg({ x: 1, y: 0 }, { x: -1, y: 0 })).toBeCloseTo(180);
  });
});

describe("polygon helpers", () => {
  const square = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
  ];
  it("signed area is positive for our face winding", () => {
    expect(polygonSignedArea(square)).toBe(100);
  });
  it("centroid of a square", () => {
    const c = polygonCentroid(square);
    expect(c.x).toBeCloseTo(5);
    expect(c.y).toBeCloseTo(5);
  });
  it("point-in-polygon", () => {
    expect(pointInPolygon({ x: 5, y: 5 }, square)).toBe(true);
    expect(pointInPolygon({ x: 15, y: 5 }, square)).toBe(false);
  });
  it("dist", () => {
    expect(dist({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
  });
});
