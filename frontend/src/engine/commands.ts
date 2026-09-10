/**
 * Serializable document commands and their inverses.
 *
 * Every edit is a plain-data command applied by `applyCommand`. The inverse is
 * computed against the document *before* the command runs, so undo is exact
 * and the command log can later be shipped to collaborators or replayed on
 * the server.
 */
import { add } from "./geometry";
import type { Item, Point, SchematicDocument, Sheet } from "./types";

export type Command =
  | { type: "add"; items: Item[]; indices?: number[] }
  | { type: "remove"; ids: string[] }
  | { type: "update"; id: string; patch: Record<string, unknown> }
  | { type: "replace"; items: Item[] }
  | { type: "move"; ids: string[]; delta: Point }
  | { type: "set-points"; id: string; points: Point[] }
  | { type: "sheet"; sheet: Sheet }
  | { type: "batch"; commands: Command[]; label?: string };

export function translateItem(item: Item, delta: Point): Item {
  switch (item.kind) {
    case "line":
      return { ...item, points: item.points.map((point) => add(point, delta)) };
    default:
      return { ...item, position: add(item.position, delta) };
  }
}

export function applyCommand(doc: SchematicDocument, command: Command): SchematicDocument {
  switch (command.type) {
    case "add": {
      const items = [...doc.items];
      if (command.indices && command.indices.length === command.items.length) {
        const ordered = command.items
          .map((item, index) => ({ item, at: command.indices![index] }))
          .sort((a, b) => a.at - b.at);
        for (const entry of ordered) items.splice(Math.min(entry.at, items.length), 0, entry.item);
      } else {
        items.push(...command.items);
      }
      return { ...doc, items };
    }
    case "remove": {
      const ids = new Set(command.ids);
      return { ...doc, items: doc.items.filter((item) => !ids.has(item.id)) };
    }
    case "update":
      return {
        ...doc,
        items: doc.items.map((item) => (item.id === command.id ? ({ ...item, ...command.patch } as Item) : item))
      };
    case "replace": {
      const byId = new Map(command.items.map((item) => [item.id, item]));
      return { ...doc, items: doc.items.map((item) => byId.get(item.id) ?? item) };
    }
    case "move": {
      const ids = new Set(command.ids);
      return {
        ...doc,
        items: doc.items.map((item) => (ids.has(item.id) ? translateItem(item, command.delta) : item))
      };
    }
    case "set-points":
      return {
        ...doc,
        items: doc.items.map((item) =>
          item.id === command.id && item.kind === "line" ? { ...item, points: command.points } : item
        )
      };
    case "sheet":
      return { ...doc, sheet: command.sheet };
    case "batch":
      return command.commands.reduce(applyCommand, doc);
  }
}

/** Inverse of `command` relative to `doc` (the state before it is applied). */
export function invertCommand(doc: SchematicDocument, command: Command): Command {
  switch (command.type) {
    case "add":
      return { type: "remove", ids: command.items.map((item) => item.id) };
    case "remove": {
      const ids = new Set(command.ids);
      const items: Item[] = [];
      const indices: number[] = [];
      doc.items.forEach((item, index) => {
        if (ids.has(item.id)) {
          items.push(item);
          indices.push(index);
        }
      });
      return { type: "add", items, indices };
    }
    case "update": {
      const current = doc.items.find((item) => item.id === command.id);
      if (!current) return { type: "batch", commands: [] };
      const patch: Record<string, unknown> = {};
      for (const key of Object.keys(command.patch)) {
        patch[key] = (current as unknown as Record<string, unknown>)[key];
      }
      return { type: "update", id: command.id, patch };
    }
    case "replace": {
      const ids = new Set(command.items.map((item) => item.id));
      return { type: "replace", items: doc.items.filter((item) => ids.has(item.id)) };
    }
    case "move":
      return { type: "move", ids: command.ids, delta: { x: -command.delta.x, y: -command.delta.y } };
    case "set-points": {
      const current = doc.items.find((item) => item.id === command.id);
      if (!current || current.kind !== "line") return { type: "batch", commands: [] };
      return { type: "set-points", id: command.id, points: current.points };
    }
    case "sheet":
      return { type: "sheet", sheet: doc.sheet };
    case "batch": {
      const inverses: Command[] = [];
      let working = doc;
      for (const inner of command.commands) {
        inverses.unshift(invertCommand(working, inner));
        working = applyCommand(working, inner);
      }
      return { type: "batch", commands: inverses, label: command.label };
    }
  }
}

export function isNoop(command: Command): boolean {
  switch (command.type) {
    case "batch":
      return command.commands.every(isNoop);
    case "add":
    case "remove":
      return ("items" in command ? command.items : command.ids).length === 0;
    case "move":
      return command.ids.length === 0 || (command.delta.x === 0 && command.delta.y === 0);
    default:
      return false;
  }
}
