import { describe, expect, it } from "vitest";
import { DocStore } from "./store";

describe("DocStore history", () => {
  it("transact/undo/redo round-trip", () => {
    const s = new DocStore();
    const original = s.project.building;
    s.transact((p) => {
      p.building = "Science Hall";
    });
    expect(s.project.building).toBe("Science Hall");
    expect(s.canUndo).toBe(true);
    s.undo();
    expect(s.project.building).toBe(original);
    expect(s.canRedo).toBe(true);
    s.redo();
    expect(s.project.building).toBe("Science Hall");
  });

  it("a new transact clears the redo stack", () => {
    const s = new DocStore();
    s.transact((p) => {
      p.building = "One";
    });
    s.undo();
    s.transact((p) => {
      p.building = "Two";
    });
    expect(s.canRedo).toBe(false);
    expect(s.project.building).toBe("Two");
  });

  it("caps the undo stack at 20 (oldest evicted)", () => {
    const s = new DocStore();
    for (let i = 1; i <= 25; i++) {
      s.transact((p) => {
        p.building = `v${i}`;
      });
    }
    expect(s.undoStack).toHaveLength(20);
    let steps = 0;
    while (s.undo()) steps++;
    expect(steps).toBe(20);
    expect(s.project.building).toBe("v5"); // 25 versions, 20 undoable → lands after v5
  });

  it("a gesture commits as a single undo step", () => {
    const s = new DocStore();
    s.beginGesture();
    for (let i = 0; i < 5; i++) {
      s.mutate((p) => {
        p.building = `drag-${i}`;
      });
    }
    s.endGesture();
    expect(s.project.building).toBe("drag-4");
    s.undo();
    expect(s.project.building).toBe("Building");
    expect(s.canUndo).toBe(false);
  });

  it("abortGesture restores the checkpoint without history", () => {
    const s = new DocStore();
    s.beginGesture();
    s.mutate((p) => {
      p.building = "half-dragged";
    });
    s.abortGesture();
    expect(s.project.building).toBe("Building");
    expect(s.canUndo).toBe(false);
  });

  it("replace clears both stacks", () => {
    const s = new DocStore();
    s.transact((p) => {
      p.building = "X";
    });
    s.undo();
    const fresh = new DocStore().project;
    s.replace(fresh);
    expect(s.canUndo).toBe(false);
    expect(s.canRedo).toBe(false);
    expect(s.project).toBe(fresh);
  });

  it("undo preserves node ids across snapshots", () => {
    const s = new DocStore();
    s.transact((p) => {
      p.floors[0].walls.nodes.n1 = { id: "n1", x: 1, y: 2 };
    });
    s.transact((p) => {
      p.floors[0].walls.nodes.n2 = { id: "n2", x: 3, y: 4 };
    });
    s.undo();
    expect(s.project.floors[0].walls.nodes.n1).toEqual({ id: "n1", x: 1, y: 2 });
    expect(s.project.floors[0].walls.nodes.n2).toBeUndefined();
    s.redo();
    expect(s.project.floors[0].walls.nodes.n2).toEqual({ id: "n2", x: 3, y: 4 });
  });
});
