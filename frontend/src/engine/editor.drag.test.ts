import { afterEach, describe, expect, it, vi } from "vitest";
import { computeConnectivity } from "./connectivity";
import { Editor } from "./editor";
import { smallPanelDocument } from "./fixtures";
import { SymbolRegistry } from "./library";
import { DocumentStore } from "./store";

const registry = SymbolRegistry.withBuiltins();

function makeEditor() {
  const store = new DocumentStore(smallPanelDocument());
  const editor = new Editor(store, registry, { makeId: () => "new" });
  return { store, editor };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("editor drag performance behaviour", () => {
  it("defers connectivity to one recompute per frame during a drag and settles it at pointer-up", () => {
    vi.useFakeTimers();
    const { store, editor } = makeEditor();
    let emits = 0;
    editor.subscribe(() => (emits += 1));
    editor.pointerDown({ x: 80, y: 120 }); // hand valve body
    expect(editor.state.drag?.kind).toBe("move");
    const before = editor.snapshot.connectivity;
    editor.pointerMove({ x: 80, y: 110 });
    editor.pointerMove({ x: 80, y: 100 });
    // The canvas snapshot keeps the previous connectivity until the frame fires...
    expect(editor.snapshot.connectivity).toBe(before);
    // ...but reading connectivity directly is always current.
    expect(editor.connectivity.junctions).toEqual(computeConnectivity(store.doc, registry).junctions);
    emits = 0;
    vi.advanceTimersByTime(20);
    expect(emits).toBe(1);
    expect(editor.snapshot.connectivity).toBe(editor.connectivity);

    editor.pointerMove({ x: 80, y: 90 });
    editor.pointerUp({ x: 80, y: 90 });
    const settled = computeConnectivity(store.doc, registry);
    expect(editor.snapshot.connectivity.junctions).toEqual(settled.junctions);
    expect(editor.snapshot.connectivity.danglingEnds).toEqual(settled.danglingEnds);
    expect(editor.snapshot.connectivity.danglingEnds).toHaveLength(0);
    // No extra emit from the stale frame once the drag has settled.
    emits = 0;
    vi.advanceTimersByTime(20);
    expect(emits).toBe(0);

    // Undo restores the original connectivity immediately (no drag in progress).
    store.undo();
    expect(editor.snapshot.connectivity.junctions).toEqual(computeConnectivity(smallPanelDocument(), registry).junctions);
    editor.dispose();
  });

  it("does not re-render on pointer moves that keep the same hover target", () => {
    const { editor } = makeEditor();
    let emits = 0;
    editor.subscribe(() => (emits += 1));
    editor.pointerMove({ x: 300, y: 300 });
    editor.pointerMove({ x: 301, y: 300 });
    editor.pointerMove({ x: 302, y: 301 });
    expect(emits).toBe(0);
    expect(editor.state.cursor).toEqual({ x: 302, y: 301 });
    editor.pointerMove({ x: 80, y: 120 });
    expect(editor.state.hover).toBe("hv");
    expect(emits).toBe(1);
    editor.pointerMove({ x: 80.2, y: 120.1 });
    expect(emits).toBe(1);
    editor.pointerMove({ x: 300, y: 300 });
    expect(editor.state.hover).toBeNull();
    expect(emits).toBe(2);
    editor.dispose();
  });
});
