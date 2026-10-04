/**
 * A throttled view of the editor's document and connectivity for derived
 * panels (DRC, engineering lists) that are too costly to rebuild on every
 * pointer step. It updates at most once per `intervalMs`, immediately when a
 * drag ends, and never for changes that leave the document alone (hover,
 * selection, cursor).
 */
import { useMemo, useSyncExternalStore } from "react";
import type { Connectivity } from "../../engine/connectivity";
import type { Editor } from "../../engine/editor";
import type { SchematicDocument } from "../../engine/types";

export type SettledSnapshot = { doc: SchematicDocument; connectivity: Connectivity };

export const SETTLE_INTERVAL_MS = 250;

function isDragging(editor: Editor): boolean {
  const drag = editor.state.drag;
  return drag?.kind === "move" || drag?.kind === "segment";
}

class SettledStore {
  private value: SettledSnapshot;
  private last = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private wasDragging = false;

  constructor(
    private readonly editor: Editor,
    private readonly intervalMs: number
  ) {
    this.value = { doc: editor.doc, connectivity: editor.connectivity };
  }

  /** Take the editor's current document; true when it differs from the held one. */
  private take(): boolean {
    const doc = this.editor.doc;
    // Always current for `doc`: mid-drag this brings the deferred recompute forward.
    const connectivity = this.editor.connectivity;
    if (doc === this.value.doc && connectivity === this.value.connectivity) return false;
    this.value = { doc, connectivity };
    this.last = Date.now();
    return true;
  }

  subscribe = (listener: () => void): (() => void) => {
    const flush = () => {
      if (this.timer !== null) clearTimeout(this.timer);
      this.timer = null;
      if (this.take()) listener();
    };
    const unsubscribe = this.editor.subscribe(() => {
      const dragging = isDragging(this.editor);
      const dragEnded = this.wasDragging && !dragging;
      this.wasDragging = dragging;
      if (dragEnded || Date.now() - this.last >= this.intervalMs) {
        flush();
      } else if (this.timer === null) {
        this.timer = setTimeout(flush, Math.max(0, this.last + this.intervalMs - Date.now()));
      }
    });
    // Catch up on changes made before this subscription.
    this.wasDragging = isDragging(this.editor);
    this.take();
    return () => {
      unsubscribe();
      if (this.timer !== null) clearTimeout(this.timer);
      this.timer = null;
    };
  };

  getSnapshot = (): SettledSnapshot => this.value;
}

export function useSettledSnapshot(editor: Editor, intervalMs = SETTLE_INTERVAL_MS): SettledSnapshot {
  const store = useMemo(() => new SettledStore(editor, intervalMs), [editor, intervalMs]);
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
