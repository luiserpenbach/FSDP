import type { PidDocument } from "../model/types";
import { cloneDocument } from "../model/types";

export type HistoryState = {
  past: PidDocument[];
  present: PidDocument;
  future: PidDocument[];
};

export function createHistory(present: PidDocument): HistoryState {
  return { past: [], present: cloneDocument(present), future: [] };
}

export function commit(history: HistoryState, next: PidDocument, merge = false): HistoryState {
  if (merge) {
    // Live edits (drag) must not deep-clone — that remounts the canvas every frame.
    return { past: history.past, present: next, future: [] };
  }
  return {
    past: [...history.past, cloneDocument(history.present)].slice(-100),
    present: cloneDocument(next),
    future: []
  };
}

export function undo(history: HistoryState): HistoryState {
  if (history.past.length === 0) return history;
  const previous = history.past[history.past.length - 1];
  return {
    past: history.past.slice(0, -1),
    present: cloneDocument(previous),
    future: [cloneDocument(history.present), ...history.future]
  };
}

export function redo(history: HistoryState): HistoryState {
  if (history.future.length === 0) return history;
  const [next, ...rest] = history.future;
  return {
    past: [...history.past, cloneDocument(history.present)],
    present: cloneDocument(next),
    future: rest
  };
}

export function canUndo(history: HistoryState): boolean {
  return history.past.length > 0;
}

export function canRedo(history: HistoryState): boolean {
  return history.future.length > 0;
}
