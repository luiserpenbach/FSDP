/**
 * P&ID canvas node components: symbol, section, text label, and comment.
 *
 * Symbol nodes place their React Flow handles at the symbol's declared port
 * coordinates (inside the glyph box), so connections attach exactly where the
 * pipe stubs are drawn — including after rotation, because the handles live
 * inside the rotated element and React Flow measures their true DOM position.
 */
import { useEffect, useRef, useState, type CSSProperties } from "react";
import {
  Handle,
  NodeResizer,
  Position,
  useReactFlow,
  useUpdateNodeInternals,
  type NodeProps
} from "reactflow";
import {
  PidGlyph,
  getSymbolPorts,
  getSymbolViewBox,
  useCustomSymbol
} from "../PidSymbols";
import type { SymbolPortSide } from "../../types";

export type PidNodeData = {
  label: string;
  symbolType: string;
  rotation: number;
  hasComponent?: boolean;
  color?: string;
};

export type SectionNodeData = {
  label: string;
  color?: string;
};

export type TextNodeData = {
  text: string;
  fontSize?: number;
  color?: string;
};

export type CommentNodeData = {
  text: string;
  author?: string;
  created_at?: string;
};

export type NodeCallbacks = {
  onDirty: () => void;
  onHistory: () => void;
};

const SIDE_TO_POSITION: Record<SymbolPortSide, Position> = {
  left: Position.Left,
  right: Position.Right,
  top: Position.Top,
  bottom: Position.Bottom
};

const SIDE_ORDER: SymbolPortSide[] = ["left", "top", "right", "bottom"];

function rotateSide(side: SymbolPortSide, rotation: number): SymbolPortSide {
  const steps = Math.round(((rotation % 360) + 360) % 360 / 90);
  return SIDE_ORDER[(SIDE_ORDER.indexOf(side) + steps) % 4];
}

export const SECTION_COLORS = ["#7da2d8", "#74b8a2", "#dcae5e", "#c98a9c", "#9b8ed8", "#8fa3b8"];
export const SYMBOL_COLORS = ["#22344c", "#2257c4", "#0f766e", "#b3261e", "#8a5b00", "#6d28d9"];

export function PidSymbolNode({ id, data, selected, onDirty, onHistory }: NodeProps<PidNodeData> & NodeCallbacks) {
  const { setNodes } = useReactFlow();
  const updateNodeInternals = useUpdateNodeInternals();
  const custom = useCustomSymbol(data.symbolType);
  const ports = getSymbolPorts(data.symbolType, custom);
  const viewBox = getSymbolViewBox(custom);
  const rotation = Number(data.rotation ?? 0);

  // Handles move whenever the glyph rotates or the port set changes; tell
  // React Flow to re-measure so edges follow.
  useEffect(() => {
    updateNodeInternals(id);
  }, [id, rotation, data.symbolType, ports.length, updateNodeInternals]);

  function rotateSymbol() {
    onHistory();
    setNodes((currentNodes) =>
      currentNodes.map((node) =>
        node.id === id
          ? { ...node, data: { ...node.data, rotation: (Number(node.data?.rotation ?? 0) + 90) % 360 } }
          : node
      )
    );
    onDirty();
  }

  const glyphStyle: CSSProperties = {
    aspectRatio: `${viewBox.width} / ${viewBox.height}`,
    transform: rotation ? `rotate(${rotation}deg)` : undefined,
    color: data.color
  };

  return (
    <div className={selected ? "pidSymbolNode selected" : "pidSymbolNode"}>
      <NodeResizer
        isVisible={selected}
        minWidth={80}
        minHeight={56}
        onResizeEnd={() => {
          updateNodeInternals(id);
          onDirty();
        }}
      />
      <div className="pidSymbolBody">
        <div className="pidGlyphBox" style={glyphStyle}>
          <PidGlyph type={data.symbolType} />
          {ports.map((port) => (
            <Handle
              key={port.id}
              id={port.id}
              type="source"
              position={SIDE_TO_POSITION[rotateSide(port.side, rotation)]}
              className="pidPortHandle"
              style={{
                left: `${((port.x - viewBox.x) / viewBox.width) * 100}%`,
                top: `${((port.y - viewBox.y) / viewBox.height) * 100}%`,
                transform: "translate(-50%, -50%)"
              }}
            />
          ))}
        </div>
      </div>
      {data.hasComponent && <span className="componentDot" title="Catalog part placed" />}
      <button className="rotateHandle" onClick={rotateSymbol} title="Rotate symbol 90 degrees" type="button">
        &#8635;
      </button>
      <div className="pidSymbolLabel">{data.label}</div>
    </div>
  );
}

export function SectionNode({ id, data, selected, onDirty, onHistory }: NodeProps<SectionNodeData> & NodeCallbacks) {
  const { setNodes } = useReactFlow();
  const color = data.color ?? SECTION_COLORS[0];
  const editedRef = useRef(false);

  function renameSection(label: string) {
    if (!editedRef.current) {
      editedRef.current = true;
      onHistory();
    }
    setNodes((currentNodes) =>
      currentNodes.map((node) => (node.id === id ? { ...node, data: { ...node.data, label } } : node))
    );
    onDirty();
  }

  return (
    <div
      className={selected ? "pidSectionNode selected" : "pidSectionNode"}
      style={{ borderColor: color, background: `${color}1f` }}
    >
      <NodeResizer isVisible={selected} minWidth={180} minHeight={120} onResizeEnd={onDirty} />
      <input
        className="pidSectionTitle nodrag"
        style={{ color }}
        value={data.label}
        placeholder="Section"
        onChange={(event) => renameSection(event.target.value)}
        onBlur={() => {
          editedRef.current = false;
        }}
      />
    </div>
  );
}

export function TextNode({ id, data, selected, onDirty, onHistory }: NodeProps<TextNodeData> & NodeCallbacks) {
  const { setNodes } = useReactFlow();
  const [editing, setEditing] = useState(() => !data.text);
  const editedRef = useRef(false);
  const fontSize = data.fontSize ?? 14;

  function updateText(text: string) {
    if (!editedRef.current) {
      editedRef.current = true;
      onHistory();
    }
    setNodes((currentNodes) =>
      currentNodes.map((node) => (node.id === id ? { ...node, data: { ...node.data, text } } : node))
    );
    onDirty();
  }

  const style: CSSProperties = { fontSize, color: data.color };

  return (
    <div
      className={selected ? "pidTextNode selected" : "pidTextNode"}
      onDoubleClick={() => setEditing(true)}
    >
      {editing ? (
        <textarea
          className="pidTextInput nodrag"
          style={style}
          value={data.text}
          placeholder="Label…"
          autoFocus
          onChange={(event) => updateText(event.target.value)}
          onBlur={() => {
            setEditing(false);
            editedRef.current = false;
          }}
        />
      ) : (
        <div className="pidTextContent" style={style}>
          {data.text || "Double-click to edit"}
        </div>
      )}
    </div>
  );
}

export function CommentNode({ id, data, selected, onDirty, onHistory }: NodeProps<CommentNodeData> & NodeCallbacks) {
  const { setNodes } = useReactFlow();
  const editedRef = useRef(false);

  function updateText(text: string) {
    if (!editedRef.current) {
      editedRef.current = true;
      onHistory();
    }
    setNodes((currentNodes) =>
      currentNodes.map((node) => (node.id === id ? { ...node, data: { ...node.data, text } } : node))
    );
    onDirty();
  }

  return (
    <div className={selected ? "pidCommentNode selected" : "pidCommentNode"}>
      <span className="pidCommentPin" title={data.text || "Comment"}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 11.5a8.38 8.38 0 0 1-8.5 8.3 8.9 8.9 0 0 1-3.2-.6L3 21l1.8-5.2a8 8 0 0 1-1.3-4.3A8.38 8.38 0 0 1 12 3.2a8.38 8.38 0 0 1 9 8.3z" />
        </svg>
      </span>
      {selected && (
        <div className="pidCommentBubble nodrag nowheel">
          <textarea
            className="nodrag"
            value={data.text}
            placeholder="Add a comment…"
            autoFocus={!data.text}
            onChange={(event) => updateText(event.target.value)}
            onBlur={() => {
              editedRef.current = false;
            }}
          />
          <div className="pidCommentMeta">
            {data.author ?? "Unknown"}
            {data.created_at ? ` · ${new Date(data.created_at).toLocaleDateString()}` : ""}
          </div>
        </div>
      )}
    </div>
  );
}
