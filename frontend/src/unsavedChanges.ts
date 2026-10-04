/**
 * App-wide registry of editors holding edits that are not on the server yet.
 *
 * Editors register a dirty check; the router's navigation blocker, the
 * header project/system switcher, and the sign-out button consult it before
 * discarding work. `routeScoped` sources live only while their page is
 * mounted (the drafting and legacy diagram editors), so leaving the route
 * loses them; the rest survive navigation and are only lost on sign-out.
 * `scope` says which workspace selection the edits belong to: changing the
 * selected project discards "project" and "system" sources, changing the
 * selected system discards "system" sources.
 */
import { createContext, useContext, useEffect, useRef } from "react";

export type UnsavedSource = {
  /** Short noun for the confirm prompt, e.g. "drafting" or "diagram". */
  label: string;
  isDirty: () => boolean;
  routeScoped: boolean;
  scope?: UnsavedScope;
};

export type UnsavedScope = "project" | "system";

export type UnsavedChangesRegistry = {
  register: (source: UnsavedSource) => () => void;
  /**
   * Labels of the sources that are dirty now; `routeScoped` limits to those
   * lost by navigating, `selection` to those lost by changing that selection.
   */
  pending: (options?: { routeScoped?: boolean; selection?: UnsavedScope }) => string[];
};

export function createUnsavedChangesRegistry(): UnsavedChangesRegistry {
  const sources = new Set<UnsavedSource>();
  return {
    register(source) {
      sources.add(source);
      return () => {
        sources.delete(source);
      };
    },
    pending(options) {
      const labels: string[] = [];
      sources.forEach((source) => {
        if (options?.routeScoped && !source.routeScoped) return;
        if (options?.selection && !discardedBy(source.scope, options.selection)) return;
        if (source.isDirty() && !labels.includes(source.label)) labels.push(source.label);
      });
      return labels;
    }
  };
}

function discardedBy(scope: UnsavedScope | undefined, selection: UnsavedScope): boolean {
  if (!scope) return false;
  return selection === "project" || scope === "system";
}

/** Confirm text naming what would be lost, e.g. "You have unsaved diagram and drafting changes. Sign out and discard them?" */
export function unsavedPrompt(labels: string[], action: string): string {
  return `You have unsaved ${labels.join(" and ")} changes. ${action} and discard them?`;
}

// Pages rendered outside the workspace (unit tests) register into a detached registry.
export const UnsavedChangesContext = createContext<UnsavedChangesRegistry>(createUnsavedChangesRegistry());

export function useUnsavedChangesRegistry(): UnsavedChangesRegistry {
  return useContext(UnsavedChangesContext);
}

/** Register a dirty check for as long as the calling component is mounted. */
export function useUnsavedChanges(
  label: string,
  isDirty: () => boolean,
  options?: { routeScoped?: boolean; scope?: UnsavedScope }
): void {
  const registry = useUnsavedChangesRegistry();
  const isDirtyRef = useRef(isDirty);
  useEffect(() => {
    isDirtyRef.current = isDirty;
  });
  const routeScoped = options?.routeScoped ?? false;
  const scope = options?.scope;
  useEffect(
    () => registry.register({ label, routeScoped, scope, isDirty: () => isDirtyRef.current() }),
    [registry, label, routeScoped, scope]
  );
}
