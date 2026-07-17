import type { Node } from "reactflow";
import { allSymbols, nodeSize, portWorldPosition } from "../model/document";
import type { DrcIssue, LineClassId, PidDocument, PidEdgeData, PidNodeData, Point } from "../model/types";
import { connectedPortKeys } from "../connectivity/nets";
import { resolveWaypoints, segmentClearanceOk } from "../routing/orthogonal";

export function runDrc(doc: PidDocument): DrcIssue[] {
  const issues: DrcIssue[] = [];
  const symbols = allSymbols(doc);
  const connected = connectedPortKeys(doc.edges);

  for (const node of doc.nodes) {
    if (node.data.kind === "junction" || node.data.kind === "terminal") continue;
    const def = symbols.find((s) => s.id === node.data.symbolType);
    if (!def) {
      issues.push({
        id: `missing-symbol-${node.id}`,
        severity: "error",
        code: "MISSING_SYMBOL",
        message: `Symbol definition "${node.data.symbolType}" not found for ${node.data.label}`,
        nodeIds: [node.id]
      });
      continue;
    }
    for (const port of def.ports) {
      if (port.required === false) continue;
      const key = `${node.id}:${port.id}`;
      if (!connected.has(key)) {
        issues.push({
          id: `unconnected-${node.id}-${port.id}`,
          severity: port.required === true ? "error" : "warning",
          code: "UNCONNECTED_PORT",
          message: `Unconnected port "${port.name}" on ${node.data.label || node.id}`,
          nodeIds: [node.id]
        });
      }
    }
  }

  // Symbol overlap
  for (let i = 0; i < doc.nodes.length; i += 1) {
    const a = doc.nodes[i];
    if (a.data.kind === "junction" || a.data.kind === "terminal") continue;
    const as = nodeSize(a);
    for (let j = i + 1; j < doc.nodes.length; j += 1) {
      const b = doc.nodes[j];
      if (b.data.kind === "junction" || b.data.kind === "terminal") continue;
      const bs = nodeSize(b);
      const overlap =
        a.position.x < b.position.x + bs.width &&
        a.position.x + as.width > b.position.x &&
        a.position.y < b.position.y + bs.height &&
        a.position.y + as.height > b.position.y;
      if (overlap) {
        issues.push({
          id: `overlap-${a.id}-${b.id}`,
          severity: "warning",
          code: "SYMBOL_OVERLAP",
          message: `Symbols overlap: ${a.data.label} and ${b.data.label}`,
          nodeIds: [a.id, b.id]
        });
      }
    }
  }

  // Dangling edges (missing endpoints)
  for (const edge of doc.edges) {
    const sourceOk = doc.nodes.some((n) => n.id === edge.source);
    const targetOk = doc.nodes.some((n) => n.id === edge.target);
    if (!sourceOk || !targetOk) {
      issues.push({
        id: `dangling-${edge.id}`,
        severity: "error",
        code: "DANGLING_LINE",
        message: `Line ${edge.data?.tag ?? edge.id} has a missing endpoint`,
        edgeIds: [edge.id]
      });
    }
  }

  // Non-orthogonal segments
  for (const edge of doc.edges) {
    const points = edgePolyline(edge, doc.nodes, symbols);
    for (let i = 0; i < points.length - 1; i += 1) {
      const a = points[i];
      const b = points[i + 1];
      if (Math.abs(a.x - b.x) > 0.75 && Math.abs(a.y - b.y) > 0.75) {
        issues.push({
          id: `nonortho-${edge.id}-${i}`,
          severity: "error",
          code: "NON_ORTHOGONAL",
          message: `Non-orthogonal segment on ${edge.data?.tag ?? edge.id}`,
          edgeIds: [edge.id]
        });
        break;
      }
    }
  }

  // Line class connect rules (edge class vs allowConnect peers on same net ends)
  for (const edge of doc.edges) {
    const cls = doc.lineClasses.find((c) => c.id === edge.data?.lineClass);
    if (!cls || !edge.data?.lineClass) continue;
    const siblings = doc.edges.filter(
      (other) => other.id !== edge.id && other.data?.netId && other.data.netId === edge.data?.netId
    );
    for (const sibling of siblings) {
      const otherClass = sibling.data?.lineClass as LineClassId | undefined;
      if (!otherClass || otherClass === edge.data.lineClass) continue;
      if (!cls.allowConnect.includes(otherClass)) {
        issues.push({
          id: `class-connect-${edge.id}-${sibling.id}`,
          severity: "warning",
          code: "LINE_CLASS_CONNECT",
          message: `${cls.name} should not join ${otherClass} on the same net (${edge.data?.tag ?? edge.id})`,
          edgeIds: [edge.id, sibling.id]
        });
      }
    }
  }

  // Orphan / under-connected junctions
  for (const junction of doc.junctions) {
    const count = doc.edges.filter((edge) => edge.source === junction.id || edge.target === junction.id).length;
    if (count < 3) {
      issues.push({
        id: `junction-legs-${junction.id}`,
        severity: "warning",
        code: "JUNCTION_LEGS",
        message: `Junction has ${count} connection(s) — expected 3+`,
        nodeIds: [junction.id]
      });
    }
  }

  // Off-page connector pairing
  const offPages = doc.nodes.filter(
    (node) => node.data.symbolType === "off_page_from" || node.data.symbolType === "off_page_to"
  );
  for (const node of offPages) {
    const ref = node.data.offPageRef?.trim();
    if (!ref) {
      issues.push({
        id: `offpage-ref-${node.id}`,
        severity: "warning",
        code: "OFFPAGE_REF",
        message: `Off-page connector "${node.data.label || node.id}" has no reference id`,
        nodeIds: [node.id]
      });
      continue;
    }
    const mates = offPages.filter((other) => other.id !== node.id && other.data.offPageRef?.trim() === ref);
    if (!mates.length) {
      issues.push({
        id: `offpage-unpaired-${node.id}`,
        severity: "warning",
        code: "OFFPAGE_UNPAIRED",
        message: `No matching off-page connector for reference "${ref}"`,
        nodeIds: [node.id]
      });
    }
  }

  // Clearance between segments of different nets
  const polylines = doc.edges.map((edge) => ({
    edge,
    points: edgePolyline(edge, doc.nodes, symbols)
  }));
  for (let i = 0; i < polylines.length; i += 1) {
    for (let j = i + 1; j < polylines.length; j += 1) {
      const a = polylines[i];
      const b = polylines[j];
      if (a.edge.data?.netId && a.edge.data.netId === b.edge.data?.netId) continue;
      const clearance = Math.max(
        doc.lineClasses.find((c) => c.id === a.edge.data?.lineClass)?.clearance ?? 8,
        doc.lineClasses.find((c) => c.id === b.edge.data?.lineClass)?.clearance ?? 8
      );
      for (let si = 0; si < a.points.length - 1; si += 1) {
        for (let sj = 0; sj < b.points.length - 1; sj += 1) {
          if (!segmentClearanceOk(a.points[si], a.points[si + 1], b.points[sj], b.points[sj + 1], clearance * 0.35)) {
            const aH = a.points[si].y === a.points[si + 1].y;
            const bH = b.points[sj].y === b.points[sj + 1].y;
            if (aH !== bH) continue;
            const dist = aH
              ? Math.abs(a.points[si].y - b.points[sj].y)
              : Math.abs(a.points[si].x - b.points[sj].x);
            if (dist < clearance && dist > 0.5) {
              issues.push({
                id: `clearance-${a.edge.id}-${b.edge.id}-${si}-${sj}`,
                severity: "warning",
                code: "CLEARANCE",
                message: `Clearance violation between ${a.edge.data?.tag ?? a.edge.id} and ${b.edge.data?.tag ?? b.edge.id}`,
                edgeIds: [a.edge.id, b.edge.id]
              });
            }
          }
        }
      }
    }
  }

  // Port / line class soft check: instrument bubbles prefer instrument class
  for (const edge of doc.edges) {
    const ends = [edge.source, edge.target]
      .map((id) => doc.nodes.find((n) => n.id === id))
      .filter(Boolean) as Node<PidNodeData>[];
    const hasInstrument = ends.some((n) => {
      const def = symbols.find((s) => s.id === n.data.symbolType);
      return def?.category === "instrument";
    });
    if (hasInstrument && edge.data?.lineClass === "process") {
      issues.push({
        id: `class-mismatch-${edge.id}`,
        severity: "warning",
        code: "LINE_CLASS_MISMATCH",
        message: `Process line connected to instrument — consider Instrument class (${edge.data?.tag ?? edge.id})`,
        edgeIds: [edge.id],
        nodeIds: ends.map((n) => n.id)
      });
    }
  }

  const seen = new Set<string>();
  return issues.filter((issue) => {
    if (seen.has(issue.id)) return false;
    seen.add(issue.id);
    return true;
  });
}

function edgePolyline(
  edge: { source: string; target: string; sourceHandle?: string | null; targetHandle?: string | null; data?: PidEdgeData },
  nodes: Node<PidNodeData>[],
  symbols: ReturnType<typeof allSymbols>
): Point[] {
  const source = nodes.find((n) => n.id === edge.source);
  const target = nodes.find((n) => n.id === edge.target);
  if (!source || !target) return [];
  const start = portWorldPosition(source, edge.sourceHandle, symbols, 100);
  const end = portWorldPosition(target, edge.targetHandle, symbols, 0);
  return resolveWaypoints(start, end, edge.data?.waypoints);
}
