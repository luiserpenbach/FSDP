/**
 * Draggable panel resizing, persisted to localStorage so panel widths
 * survive reloads. Used by the app sidebar and the diagram inspector.
 */
import { useCallback, useState, type PointerEvent as ReactPointerEvent } from "react";

export function useStoredWidth(storageKey: string, initial: number, min: number, max: number) {
  const [width, setWidth] = useState(() => {
    const stored = Number(localStorage.getItem(storageKey));
    return Number.isFinite(stored) && stored >= min && stored <= max ? stored : initial;
  });

  const update = useCallback(
    (next: number) => {
      const clamped = Math.min(max, Math.max(min, Math.round(next)));
      setWidth(clamped);
      localStorage.setItem(storageKey, String(clamped));
    },
    [storageKey, min, max]
  );

  return [width, update] as const;
}

export function PanelResizer({
  width,
  onResize,
  /** +1 when dragging right grows the panel, -1 when dragging left grows it. */
  direction,
  label
}: {
  width: number;
  onResize: (width: number) => void;
  direction: 1 | -1;
  label: string;
}) {
  function beginResize(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = width;

    function move(moveEvent: PointerEvent) {
      onResize(startWidth + direction * (moveEvent.clientX - startX));
    }

    function stop() {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      document.body.classList.remove("isResizing");
    }

    document.body.classList.add("isResizing");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  }

  return (
    <div
      className="panelResizer"
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      title={label}
      onPointerDown={beginResize}
    />
  );
}
