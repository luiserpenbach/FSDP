import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Editor } from "../../engine/editor";
import { smallPanelDocument } from "../../engine/fixtures";
import { SymbolRegistry } from "../../engine/library";
import { DocumentStore } from "../../engine/store";
import { SETTLE_INTERVAL_MS, useSettledSnapshot } from "./useSettledSnapshot";

const registry = SymbolRegistry.withBuiltins();

afterEach(() => {
  vi.useRealTimers();
});

describe("useSettledSnapshot", () => {
  it("throttles document changes, ignores hover, and settles at once when a drag ends", () => {
    vi.useFakeTimers();
    const store = new DocumentStore(smallPanelDocument());
    const editor = new Editor(store, registry);
    const { result } = renderHook(() => useSettledSnapshot(editor));
    const initial = result.current;
    expect(initial.doc).toBe(store.doc);

    // Hover-only changes leave the settled value alone.
    act(() => editor.pointerMove({ x: 80, y: 120 }));
    expect(result.current).toBe(initial);

    // First edit after a quiet period goes through immediately...
    act(() => editor.updateItem("hv", { tag: "HV-1" }));
    expect(result.current.doc).toBe(store.doc);
    const afterFirst = result.current;
    // ...rapid follow-ups are coalesced into one trailing update.
    act(() => editor.updateItem("hv", { tag: "HV-2" }));
    act(() => editor.updateItem("hv", { tag: "HV-3" }));
    expect(result.current).toBe(afterFirst);
    act(() => vi.advanceTimersByTime(SETTLE_INTERVAL_MS));
    expect(result.current.doc).toBe(store.doc);
    expect(result.current.connectivity).toBe(editor.connectivity);

    // A drag that ends inside the interval is reported at pointer-up.
    act(() => editor.pointerDown({ x: 80, y: 120 }));
    act(() => editor.pointerMove({ x: 80, y: 110 }));
    act(() => editor.pointerUp({ x: 80, y: 110 }));
    expect(result.current.doc).toBe(store.doc);
    expect(result.current.connectivity).toBe(editor.connectivity);
    editor.dispose();
  });
});
