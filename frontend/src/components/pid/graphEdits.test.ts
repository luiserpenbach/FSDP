import { describe, expect, it } from "vitest";
import type { Edge, Node } from "reactflow";
import { removeNodesKeepingSectionContents } from "./graphEdits";

function node(partial: Partial<Node> & Pick<Node, "id">): Node {
  return {
    position: { x: 0, y: 0 },
    data: {},
    ...partial
  };
}

function edge(partial: Partial<Edge> & Pick<Edge, "id" | "source" | "target">): Edge {
  return { ...partial };
}

describe("removeNodesKeepingSectionContents", () => {
  it("deletes a section while keeping children and their edges", () => {
    const nodes = [
      node({ id: "section-1", type: "pidSection", position: { x: 100, y: 50 } }),
      node({
        id: "valve-1",
        type: "pidSymbol",
        parentNode: "section-1",
        position: { x: 20, y: 30 }
      }),
      node({
        id: "pump-1",
        type: "pidSymbol",
        parentNode: "section-1",
        position: { x: 80, y: 30 }
      })
    ];
    const edges = [edge({ id: "line-1", source: "valve-1", target: "pump-1" })];

    const result = removeNodesKeepingSectionContents(nodes, edges, ["section-1"]);

    expect(result.nodes.map((entry) => entry.id)).toEqual(["valve-1", "pump-1"]);
    expect(result.nodes[0].parentNode).toBeUndefined();
    expect(result.nodes[0].position).toEqual({ x: 120, y: 80 });
    expect(result.nodes[1].parentNode).toBeUndefined();
    expect(result.nodes[1].position).toEqual({ x: 180, y: 80 });
    expect(result.edges).toEqual(edges);
  });

  it("still deletes explicitly selected children with the section", () => {
    const nodes = [
      node({ id: "section-1", type: "pidSection", position: { x: 10, y: 10 } }),
      node({ id: "keep", type: "pidSymbol", parentNode: "section-1", position: { x: 5, y: 5 } }),
      node({ id: "drop", type: "pidSymbol", parentNode: "section-1", position: { x: 15, y: 5 } })
    ];

    const result = removeNodesKeepingSectionContents(nodes, [], ["section-1", "drop"]);

    expect(result.nodes.map((entry) => entry.id)).toEqual(["keep"]);
    expect(result.nodes[0].position).toEqual({ x: 15, y: 15 });
  });

  it("removes edges connected to deleted non-section nodes", () => {
    const nodes = [
      node({ id: "a", type: "pidSymbol" }),
      node({ id: "b", type: "pidSymbol" }),
      node({ id: "c", type: "pidSymbol" })
    ];
    const edges = [
      edge({ id: "ab", source: "a", target: "b" }),
      edge({ id: "bc", source: "b", target: "c" })
    ];

    const result = removeNodesKeepingSectionContents(nodes, edges, ["b"]);

    expect(result.nodes.map((entry) => entry.id)).toEqual(["a", "c"]);
    expect(result.edges).toEqual([]);
  });
});
