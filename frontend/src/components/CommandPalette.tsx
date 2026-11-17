import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { SearchHit, SearchHitKind } from "../types";

const KIND_LABELS: Record<SearchHitKind, string> = {
  tag: "Tag",
  line: "Line",
  drawing: "Drawing",
  part: "Part",
  requirement: "Requirement",
  system: "System",
  project: "Project"
};

const DEBOUNCE_MS = 140;
const MIN_QUERY = 2;

/** True for Ctrl+K / Cmd+K, the shortcut that opens the palette from anywhere. */
export function isPaletteShortcut(event: KeyboardEvent): boolean {
  return (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "k";
}

/**
 * Search across every project (tags, lines, drawings, parts, requirements,
 * systems) and jump to the result. Opened with Ctrl+K; `onOpenHit` navigates.
 */
export function CommandPalette({
  open,
  projectId,
  onClose,
  onOpenHit
}: {
  open: boolean;
  /** Current project: its hits are listed before equally good ones elsewhere. */
  projectId: string;
  onClose: () => void;
  onOpenHit: (hit: SearchHit) => void;
}) {
  if (!open) return null;
  // Mounted per opening, so every search starts from an empty box.
  return <PaletteDialog projectId={projectId} onClose={onClose} onOpenHit={onOpenHit} />;
}

function PaletteDialog({ projectId, onClose, onOpenHit }: { projectId: string; onClose: () => void; onOpenHit: (hit: SearchHit) => void }) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [active, setActive] = useState(0);
  const [state, setState] = useState<"idle" | "loading" | "done" | "error">("idle");
  const listRef = useRef<HTMLUListElement>(null);
  const term = query.trim();

  useEffect(() => {
    if (term.length < MIN_QUERY) return;
    const controller = new AbortController();
    const handle = window.setTimeout(() => {
      setState("loading");
      api
        .search(term, { projectId: projectId || undefined, signal: controller.signal })
        .then((results) => {
          if (controller.signal.aborted) return;
          setHits(results.hits);
          setActive(0);
          setState("done");
        })
        .catch(() => {
          if (!controller.signal.aborted) setState("error");
        });
    }, DEBOUNCE_MS);
    return () => {
      window.clearTimeout(handle);
      controller.abort();
    };
  }, [term, projectId]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView?.({ block: "nearest" });
  }, [active]);

  const ready = term.length >= MIN_QUERY;
  const shown = ready ? hits : [];

  function choose(hit: SearchHit | undefined) {
    if (!hit) return;
    onClose();
    onOpenHit(hit);
  }

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((current) => (shown.length ? (current + 1) % shown.length : 0));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((current) => (shown.length ? (current - 1 + shown.length) % shown.length : 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      choose(shown[active]);
    }
  }

  let status = "";
  if (!ready) status = "Type a tag, line number, drawing, part number, or requirement key.";
  else if (state === "error") status = "Search failed. Check the connection and try again.";
  else if (state === "done" && !shown.length) status = `Nothing matches "${term}".`;
  else if (state === "loading" && !shown.length) status = "Searching…";

  return (
    <div className="modalBackdrop paletteBackdrop" role="presentation" onClick={onClose}>
      <div className="modal palette" role="dialog" aria-modal="true" aria-label="Search" onClick={(event) => event.stopPropagation()} onKeyDown={onKeyDown}>
        <input
          className="paletteInput"
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search tags, lines, drawings, parts, requirements…"
          aria-label="Search everything"
          role="combobox"
          aria-expanded={shown.length > 0}
          aria-controls="palette-results"
          aria-activedescendant={shown[active] ? `palette-hit-${active}` : undefined}
          spellCheck={false}
          autoComplete="off"
        />
        {shown.length > 0 && (
          <ul className="paletteResults" id="palette-results" role="listbox" aria-label="Search results" ref={listRef}>
            {shown.map((hit, index) => (
              <li
                key={`${hit.kind}:${hit.id}`}
                id={`palette-hit-${index}`}
                role="option"
                aria-selected={index === active}
                className={index === active ? "paletteHit active" : "paletteHit"}
                onMouseMove={() => setActive(index)}
                onClick={() => choose(hit)}
              >
                <span className={`paletteKind paletteKind-${hit.kind}`}>{KIND_LABELS[hit.kind]}</span>
                <span className="paletteText">
                  <span className="paletteTitle mono">{hit.title}</span>
                  {hit.subtitle && <span className="paletteSubtitle">{hit.subtitle}</span>}
                </span>
                <span className="paletteMeta">
                  {hit.status === "released" && <span className="paletteReleased">released</span>}
                  {hit.project_name && hit.kind !== "project" && <span className={hit.project_id === projectId ? "paletteProject" : "paletteProject elsewhere"}>{hit.project_name}</span>}
                </span>
              </li>
            ))}
          </ul>
        )}
        {status && <p className="paletteStatus" role="status">{status}</p>}
        <div className="paletteFooter" aria-hidden="true">
          <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
          <span><kbd>Enter</kbd> open</span>
          <span><kbd>Esc</kbd> close</span>
        </div>
      </div>
    </div>
  );
}
