/**
 * Floating canvas chrome for the P&ID editor:
 *  - CanvasContextMenu: right-click menu (grid/comments toggles, add elements, delete)
 *  - FloatingToolbar: Confluence-style bottom tool panel (symbols, section, label, comment)
 *  - SelectionToolbar: hovering editor bar above the selected node/line
 *    (must be rendered as a <ReactFlow> child — it uses the viewport transform)
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useViewport, type Edge, type Node } from "reactflow";
import { PidGlyph, SYMBOL_LABELS, customSymbolType } from "../PidSymbols";
import type { PidSymbolDef } from "../../types";
import { EDGE_COLORS, type EdgeStrokeStyle, type OrthogonalEdgeData } from "./OrthogonalEdge";
import { SECTION_COLORS, SYMBOL_COLORS } from "./nodes";

export type PlacementTool =
  | { kind: "symbol"; symbolType: string }
  | { kind: "section" }
  | { kind: "text" }
  | { kind: "comment" };

export type ContextMenuState = {
  /** Position within the .diagram container, in px. */
  x: number;
  y: number;
  /** Where the click landed in flow coordinates (pane menus). */
  flowX: number;
  flowY: number;
  kind: "pane" | "node" | "edge";
  targetId?: string;
};

/* ---------- Context menu ---------- */

export function CanvasContextMenu({
  menu,
  showGrid,
  showComments,
  nodeType,
  onToggleGrid,
  onToggleComments,
  onAddElement,
  onRotateNode,
  onDuplicateNode,
  onDeleteNode,
  onDeleteEdge,
  onClose
}: {
  menu: ContextMenuState;
  showGrid: boolean;
  showComments: boolean;
  nodeType?: string;
  onToggleGrid: () => void;
  onToggleComments: () => void;
  onAddElement: (tool: PlacementTool, flowX: number, flowY: number) => void;
  onRotateNode: (id: string) => void;
  onDuplicateNode: (id: string) => void;
  onDeleteNode: (id: string) => void;
  onDeleteEdge: (id: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function dismiss(event: PointerEvent) {
      if (ref.current && !ref.current.contains(event.target as globalThis.Node)) onClose();
    }
    window.addEventListener("pointerdown", dismiss);
    return () => window.removeEventListener("pointerdown", dismiss);
  }, [onClose]);

  function item(label: string, action: () => void, danger = false) {
    return (
      <button
        className={danger ? "contextMenuItem danger" : "contextMenuItem"}
        type="button"
        onClick={() => {
          action();
          onClose();
        }}
      >
        {label}
      </button>
    );
  }

  return (
    <div className="canvasContextMenu" ref={ref} style={{ left: menu.x, top: menu.y }}>
      {menu.kind === "pane" && (
        <>
          {item(showGrid ? "Hide grid" : "Show grid", onToggleGrid)}
          {item(showComments ? "Hide comments" : "Show comments", onToggleComments)}
          <div className="contextMenuDivider" />
          {item("Add section", () => onAddElement({ kind: "section" }, menu.flowX, menu.flowY))}
          {item("Add label", () => onAddElement({ kind: "text" }, menu.flowX, menu.flowY))}
          {item("Add comment", () => onAddElement({ kind: "comment" }, menu.flowX, menu.flowY))}
        </>
      )}
      {menu.kind === "node" && menu.targetId && (
        <>
          {nodeType === "pidSymbol" && item("Rotate 90°", () => onRotateNode(menu.targetId!))}
          {nodeType !== "pidComment" && item("Duplicate", () => onDuplicateNode(menu.targetId!))}
          <div className="contextMenuDivider" />
          {item(nodeType === "pidSection" ? "Delete section (keep contents)" : "Delete", () => onDeleteNode(menu.targetId!), true)}
        </>
      )}
      {menu.kind === "edge" && menu.targetId && item("Delete line", () => onDeleteEdge(menu.targetId!), true)}
    </div>
  );
}

/* ---------- Floating bottom toolbar ---------- */

function ToolIcon({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      {children}
    </svg>
  );
}

export function FloatingToolbar({
  activeTool,
  builtinSymbols,
  customSymbols,
  onArmTool,
  onOpenSymbolEditor
}: {
  activeTool: PlacementTool | null;
  builtinSymbols: string[];
  customSymbols: PidSymbolDef[];
  onArmTool: (tool: PlacementTool | null) => void;
  onOpenSymbolEditor: () => void;
}) {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!paletteOpen) return;
    function dismiss(event: PointerEvent) {
      if (ref.current && !ref.current.contains(event.target as globalThis.Node)) setPaletteOpen(false);
    }
    window.addEventListener("pointerdown", dismiss);
    return () => window.removeEventListener("pointerdown", dismiss);
  }, [paletteOpen]);

  function toolButton(label: string, tool: PlacementTool, icon: ReactNode) {
    const active = activeTool?.kind === tool.kind;
    return (
      <button
        className={active ? "floatingTool active" : "floatingTool"}
        title={`${label} — click, then click on the canvas to place`}
        type="button"
        onClick={() => {
          setPaletteOpen(false);
          onArmTool(active ? null : tool);
        }}
      >
        {icon}
        <span>{label}</span>
      </button>
    );
  }

  const symbolActive = activeTool?.kind === "symbol";

  return (
    <div className="floatingToolbar" ref={ref}>
      {paletteOpen && (
        <div className="symbolPalettePopover nowheel">
          <div className="symbolPaletteGroup">
            <span className="paletteLabel">Standard symbols</span>
            <div className="symbolPaletteGrid">
              {builtinSymbols.map((kind) => (
                <button
                  className={activeTool?.kind === "symbol" && activeTool.symbolType === kind ? "paletteCell active" : "paletteCell"}
                  key={kind}
                  type="button"
                  onClick={() => {
                    onArmTool({ kind: "symbol", symbolType: kind });
                    setPaletteOpen(false);
                  }}
                >
                  <span className="paletteCellGlyph"><PidGlyph type={kind} /></span>
                  <span className="paletteCellName">{SYMBOL_LABELS[kind] ?? kind}</span>
                </button>
              ))}
            </div>
          </div>
          {customSymbols.length > 0 && (
            <div className="symbolPaletteGroup">
              <span className="paletteLabel">My symbols</span>
              <div className="symbolPaletteGrid">
                {customSymbols.map((symbol) => (
                  <button
                    className="paletteCell"
                    key={symbol.id}
                    type="button"
                    onClick={() => {
                      onArmTool({ kind: "symbol", symbolType: customSymbolType(symbol.id) });
                      setPaletteOpen(false);
                    }}
                  >
                    <span className="paletteCellGlyph"><PidGlyph type={customSymbolType(symbol.id)} /></span>
                    <span className="paletteCellName">{symbol.name}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          <button className="symbolEditorLink" type="button" onClick={() => { setPaletteOpen(false); onOpenSymbolEditor(); }}>
            + Create symbol…
          </button>
        </div>
      )}
      <button
        className={symbolActive || paletteOpen ? "floatingTool active" : "floatingTool"}
        title="Place a P&ID symbol"
        type="button"
        onClick={() => setPaletteOpen((open) => !open)}
      >
        <ToolIcon>
          <path d="M3 12 h4 M6 8 l6 4 -6 4 Z M18 8 l-6 4 6 4 Z M17 12 h4" />
        </ToolIcon>
        <span>Symbols</span>
      </button>
      {toolButton("Section", { kind: "section" }, (
        <ToolIcon>
          <rect x="3" y="5" width="18" height="14" rx="2" />
          <path d="M3 9 h7 V5" />
        </ToolIcon>
      ))}
      {toolButton("Label", { kind: "text" }, (
        <ToolIcon>
          <path d="M5 6 h14 M12 6 v13" />
        </ToolIcon>
      ))}
      {toolButton("Comment", { kind: "comment" }, (
        <ToolIcon>
          <path d="M21 11.5a8.38 8.38 0 0 1-8.5 8.3 8.9 8.9 0 0 1-3.2-.6L3 21l1.8-5.2a8 8 0 0 1-1.3-4.3A8.38 8.38 0 0 1 12 3.2a8.38 8.38 0 0 1 9 8.3z" />
        </ToolIcon>
      ))}
      {activeTool && (
        <span className="placementHint">Click on the canvas to place · Esc to cancel</span>
      )}
    </div>
  );
}

/* ---------- Hovering selection editor bar ---------- */

function Swatches({
  colors,
  current,
  onPick
}: {
  colors: string[];
  current?: string;
  onPick: (color: string) => void;
}) {
  return (
    <span className="swatchRow">
      {colors.map((color) => (
        <button
          key={color}
          className={current === color || (!current && color === colors[0]) ? "swatch active" : "swatch"}
          style={{ background: color }}
          title={color}
          type="button"
          onClick={() => onPick(color)}
        />
      ))}
    </span>
  );
}

function BarButton({ title, onClick, danger, children }: { title: string; onClick: () => void; danger?: boolean; children: ReactNode }) {
  return (
    <button className={danger ? "barButton danger" : "barButton"} title={title} type="button" onClick={onClick}>
      {children}
    </button>
  );
}

export function SelectionToolbar({
  node,
  parent,
  edge,
  edgeEndpoints,
  onUpdateNodeData,
  onUpdateEdge,
  onRotateNode,
  onDuplicateNode,
  onDeleteNode,
  onDeleteEdge
}: {
  node: Node | null;
  parent: Node | null;
  edge: Edge<OrthogonalEdgeData> | null;
  edgeEndpoints: [Node, Node] | null;
  onUpdateNodeData: (id: string, patch: Record<string, unknown>) => void;
  onUpdateEdge: (id: string, patch: Partial<OrthogonalEdgeData>, label?: string) => void;
  onRotateNode: (id: string) => void;
  onDuplicateNode: (id: string) => void;
  onDeleteNode: (id: string) => void;
  onDeleteEdge: (id: string) => void;
}) {
  const { x: viewportX, y: viewportY, zoom } = useViewport();

  let anchorX: number | null = null;
  let anchorY: number | null = null;
  if (node) {
    const absX = (parent?.position.x ?? 0) + node.position.x;
    const absY = (parent?.position.y ?? 0) + node.position.y;
    anchorX = absX + (node.width ?? 0) / 2;
    anchorY = absY;
  } else if (edge && edgeEndpoints) {
    const [source, target] = edgeEndpoints;
    anchorX = (source.position.x + (source.width ?? 0) / 2 + target.position.x + (target.width ?? 0) / 2) / 2;
    anchorY = Math.min(source.position.y, target.position.y);
  }
  if (anchorX == null || anchorY == null) return null;

  const left = anchorX * zoom + viewportX;
  const top = anchorY * zoom + viewportY - 14;

  let content: ReactNode = null;
  if (node?.type === "pidSymbol") {
    content = (
      <>
        <Swatches colors={SYMBOL_COLORS} current={node.data?.color} onPick={(color) => onUpdateNodeData(node.id, { color })} />
        <span className="barDivider" />
        <BarButton title="Rotate 90°" onClick={() => onRotateNode(node.id)}>&#8635;</BarButton>
        <BarButton title="Duplicate" onClick={() => onDuplicateNode(node.id)}>&#10697;</BarButton>
        <span className="barDivider" />
        <BarButton title="Delete" danger onClick={() => onDeleteNode(node.id)}>&#128465;</BarButton>
      </>
    );
  } else if (node?.type === "pidSection") {
    content = (
      <>
        <Swatches colors={SECTION_COLORS} current={node.data?.color} onPick={(color) => onUpdateNodeData(node.id, { color })} />
        <span className="barDivider" />
        <BarButton title="Delete section (keep contents)" danger onClick={() => onDeleteNode(node.id)}>&#128465;</BarButton>
      </>
    );
  } else if (node?.type === "pidText") {
    const fontSize = Number(node.data?.fontSize ?? 14);
    content = (
      <>
        <BarButton title="Smaller text" onClick={() => onUpdateNodeData(node.id, { fontSize: Math.max(10, fontSize - 2) })}>A-</BarButton>
        <BarButton title="Larger text" onClick={() => onUpdateNodeData(node.id, { fontSize: Math.min(40, fontSize + 2) })}>A+</BarButton>
        <span className="barDivider" />
        <Swatches colors={SYMBOL_COLORS} current={node.data?.color} onPick={(color) => onUpdateNodeData(node.id, { color })} />
        <span className="barDivider" />
        <BarButton title="Delete" danger onClick={() => onDeleteNode(node.id)}>&#128465;</BarButton>
      </>
    );
  } else if (node?.type === "pidComment") {
    content = <BarButton title="Delete comment" danger onClick={() => onDeleteNode(node.id)}>&#128465;</BarButton>;
  } else if (edge) {
    const strokeStyle = edge.data?.strokeStyle ?? "solid";
    const strokeButton = (style: EdgeStrokeStyle, title: string, dash?: string) => (
      <button
        className={strokeStyle === style ? "barButton active" : "barButton"}
        title={title}
        type="button"
        onClick={() => onUpdateEdge(edge.id, { strokeStyle: style })}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M3 12 H21" strokeDasharray={dash} />
        </svg>
      </button>
    );
    content = (
      <>
        <input
          className="barLabelInput"
          value={String(edge.label ?? "")}
          placeholder="Line label"
          onChange={(event) => onUpdateEdge(edge.id, {}, event.target.value)}
        />
        <span className="barDivider" />
        <Swatches colors={EDGE_COLORS} current={edge.data?.color} onPick={(color) => onUpdateEdge(edge.id, { color })} />
        <span className="barDivider" />
        {strokeButton("solid", "Solid line")}
        {strokeButton("dashed", "Dashed line", "5 4")}
        {strokeButton("dotted", "Dotted line", "1.5 4")}
        <span className="barDivider" />
        <button
          className={edge.data?.showArrow === false ? "barButton" : "barButton active"}
          title="Toggle flow arrow"
          type="button"
          onClick={() => onUpdateEdge(edge.id, { showArrow: edge.data?.showArrow === false })}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 12 H17 M13 6 l6 6 -6 6" />
          </svg>
        </button>
        <span className="barDivider" />
        <BarButton title="Delete line" danger onClick={() => onDeleteEdge(edge.id)}>&#128465;</BarButton>
      </>
    );
  }
  if (!content) return null;

  return (
    <div
      className="selectionToolbar nodrag nopan"
      style={{ left, top }}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      {content}
    </div>
  );
}
