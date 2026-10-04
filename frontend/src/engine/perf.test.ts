/**
 * Drafting engine benchmark on the 300-symbol / 450-line sheet.
 *
 * Skipped by default so CI timing noise cannot fail the suite. Run with
 *   FSDP_BENCH=1 npx vitest run src/engine/perf.test.ts
 * to print median timings for each hot path.
 */
import { describe, expect, it } from "vitest";
import { computeConnectivity } from "./connectivity";
import { runDrc } from "./drc";
import { Editor } from "./editor";
import { benchmarkDocument } from "./fixtures";
import { buildSheetIndex } from "./index";
import { SymbolRegistry } from "./library";
import { computeCrossings } from "./lines";
import { DocumentStore } from "./store";
import { DEFAULT_TAG_SCHEME } from "./tags";
import type { LineItem } from "./types";

type NodeProcess = { env?: Record<string, string | undefined>; stdout?: { write(text: string): void } };
const nodeProcess = (globalThis as { process?: NodeProcess }).process;
const env = nodeProcess?.env ?? {};
const BENCH = Boolean(env.FSDP_BENCH);

function median(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function time(run: () => void, repeat = 10): number {
  run(); // warm up
  const samples: number[] = [];
  for (let index = 0; index < repeat; index += 1) {
    const start = performance.now();
    run();
    samples.push(performance.now() - start);
  }
  return median(samples);
}

const fmt = (ms: number) => `${ms.toFixed(2)} ms`;

describe.skipIf(!BENCH)("drafting engine benchmark (300 symbols / 450 lines)", () => {
  const registry = SymbolRegistry.withBuiltins();
  const doc = benchmarkDocument(300, 450);
  const lines = doc.items.filter((item): item is LineItem => item.kind === "line");

  it("measures the hot paths", () => {
    const connectivity = computeConnectivity(doc, registry);
    const results: Record<string, number> = {
      computeConnectivity: time(() => computeConnectivity(doc, registry)),
      computeCrossings: time(() => computeCrossings(lines)),
      "buildSheetIndex (own connectivity)": time(() => buildSheetIndex(doc, registry)),
      "buildSheetIndex (given connectivity)": time(() => buildSheetIndex(doc, registry, { connectivity })),
      "runDrc (own connectivity)": time(() => runDrc({ doc, registry, tagScheme: DEFAULT_TAG_SCHEME })),
      "runDrc (given connectivity)": time(() => runDrc({ doc, registry, connectivity, tagScheme: DEFAULT_TAG_SCHEME }))
    };

    // Simulated 20-step move drag of a symbol with attached lines, through the Editor.
    const store = new DocumentStore(benchmarkDocument(300, 450));
    const editor = new Editor(store, registry, { makeId: (() => { let n = 0; return () => `new${++n}`; })() });
    const origin = { x: 510, y: 180 }; // s137
    editor.pointerDown(origin);
    expect(editor.state.drag?.kind).toBe("move");
    const steps: number[] = [];
    for (let step = 1; step <= 20; step += 1) {
      const start = performance.now();
      editor.pointerMove({ x: origin.x + step * 2.5, y: origin.y + (step % 2) * 2.5 });
      steps.push(performance.now() - start);
    }
    const upStart = performance.now();
    editor.pointerUp({ x: origin.x + 50, y: origin.y });
    const up = performance.now() - upStart;
    // Pointer-up must leave connectivity current for the final document.
    const settled = computeConnectivity(store.doc, registry);
    expect(editor.connectivity.junctions).toEqual(settled.junctions);
    expect(editor.connectivity.danglingEnds.length).toBe(settled.danglingEnds.length);
    results["drag step (median of 20)"] = median(steps);
    results["drag step (max of 20)"] = Math.max(...steps);
    results["pointer-up"] = up;
    editor.dispose();

    // Worst case per animation frame: one pointer step plus a fresh connectivity
    // (what the frame-coalesced recompute costs when every frame has a step).
    const frameStore = new DocumentStore(benchmarkDocument(300, 450));
    const frameEditor = new Editor(frameStore, registry);
    frameEditor.pointerDown(origin);
    const frames: number[] = [];
    for (let step = 1; step <= 20; step += 1) {
      const start = performance.now();
      frameEditor.pointerMove({ x: origin.x + step * 2.5, y: origin.y + (step % 2) * 2.5 });
      void frameEditor.connectivity;
      frames.push(performance.now() - start);
    }
    frameEditor.pointerUp({ x: origin.x + 50, y: origin.y });
    frameEditor.dispose();
    results["drag step + connectivity (median of 20)"] = median(frames);

    nodeProcess?.stdout?.write(
      ["", "benchmark (300 symbols / 450 lines):", ...Object.entries(results).map(([name, ms]) => `  ${name.padEnd(40)} ${fmt(ms)}`), ""].join("\n")
    );
  }, 120_000);
});
