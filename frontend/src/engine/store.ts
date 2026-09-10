/**
 * Document store: holds the current document, the undo/redo stacks of inverse
 * commands, and a change counter so hosts can track dirtiness cheaply.
 */
import { applyCommand, invertCommand, isNoop, type Command } from "./commands";
import type { SchematicDocument } from "./types";

type HistoryEntry = { forward: Command; inverse: Command; coalesceKey?: string };

export type StoreListener = (doc: SchematicDocument) => void;

export class DocumentStore {
  private document: SchematicDocument;
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private listeners = new Set<StoreListener>();
  /** Increments on every document change, including undo/redo and load. */
  version = 0;
  /** Version at last save/load; `dirty` compares against it. */
  savedVersion = 0;

  constructor(document: SchematicDocument, readonly historyLimit = 200) {
    this.document = document;
  }

  get doc(): SchematicDocument {
    return this.document;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  get dirty(): boolean {
    return this.version !== this.savedVersion;
  }

  subscribe(listener: StoreListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Replace the document and clear history (load from server). */
  load(document: SchematicDocument): void {
    this.document = document;
    this.undoStack = [];
    this.redoStack = [];
    this.version += 1;
    this.savedVersion = this.version;
    this.emit();
  }

  markSaved(): void {
    this.savedVersion = this.version;
  }

  /** Flag the document as needing a save without recording an undo step (e.g. after conversion). */
  markDirty(): void {
    this.version += 1;
    this.emit();
  }

  /**
   * Apply a command. Consecutive commands sharing `coalesceKey` (e.g. the
   * steps of one drag) fold into a single undo entry.
   */
  dispatch(command: Command, options: { coalesceKey?: string } = {}): void {
    if (isNoop(command)) return;
    const inverse = invertCommand(this.document, command);
    this.document = applyCommand(this.document, command);
    const previous = this.undoStack[this.undoStack.length - 1];
    if (options.coalesceKey && previous && previous.coalesceKey === options.coalesceKey) {
      previous.forward = { type: "batch", commands: [previous.forward, command] };
      previous.inverse = { type: "batch", commands: [inverse, previous.inverse] };
    } else {
      this.undoStack.push({ forward: command, inverse, coalesceKey: options.coalesceKey });
      if (this.undoStack.length > this.historyLimit) this.undoStack.shift();
    }
    this.redoStack = [];
    this.version += 1;
    this.emit();
  }

  /** Close the current coalescing group so the next command starts a new undo entry. */
  endCoalescing(): void {
    const previous = this.undoStack[this.undoStack.length - 1];
    if (previous) previous.coalesceKey = undefined;
  }

  undo(): boolean {
    const entry = this.undoStack.pop();
    if (!entry) return false;
    this.document = applyCommand(this.document, entry.inverse);
    this.redoStack.push(entry);
    this.version += 1;
    this.emit();
    return true;
  }

  redo(): boolean {
    const entry = this.redoStack.pop();
    if (!entry) return false;
    // Re-derive the inverse: the forward command may include coalesced steps.
    entry.inverse = invertCommand(this.document, entry.forward);
    this.document = applyCommand(this.document, entry.forward);
    this.undoStack.push(entry);
    this.version += 1;
    this.emit();
    return true;
  }

  private emit(): void {
    this.listeners.forEach((listener) => listener(this.document));
  }
}
