/**
 * The engine request behind the browser/server parity tests: a two-sheet
 * drawing that exercises everything the server has to gather — a custom
 * symbol, assigned parts, requirement constraints, a waiver, off-page
 * connectors paired across sheets, and a tag repeated on the other sheet.
 *
 * `cli.bundle.test.mjs` checks that the bundled CLI under Node returns for this
 * request what the browser computes, and keeps `testdata/engine-parity.json`
 * (request and expected response) in step; the backend's real-engine test
 * (`backend/tests/test_server_index.py`) loads that file into a database and
 * expects the stored rows to match.
 */
import type { EngineRequest } from "./engineRequest";
import { lineThrough, smallPanelDocument, symbolAt } from "./fixtures";
import { CUSTOM_LIBRARY } from "./library";
import type { LineItem, SymbolItem } from "./types";

export const PARITY_IDS = {
  sheet1: "00000000-0000-4000-8000-0000000000a1",
  sheet2: "00000000-0000-4000-8000-0000000000a2",
  symbol: "00000000-0000-4000-8000-0000000000b1",
  partBrass: "00000000-0000-4000-8000-0000000000c1",
  partSteel: "00000000-0000-4000-8000-0000000000c2",
  reqMaterial: "00000000-0000-4000-8000-0000000000d1",
  reqRelief: "00000000-0000-4000-8000-0000000000d2",
  reqRating: "00000000-0000-4000-8000-0000000000d3",
  reqPlain: "00000000-0000-4000-8000-0000000000d4"
};

export function parityRequest(): EngineRequest {
  const first = smallPanelDocument();
  for (const item of first.items) {
    if (item.id === "hv") (item as SymbolItem).partId = PARITY_IDS.partBrass;
    if (item.id === "pcv") (item as SymbolItem).partId = PARITY_IDS.partSteel;
    if (item.kind === "line") Object.assign(item as LineItem, { service: "GHe", size: '1/4"', lineClass: "HE-1" });
  }
  first.items.push(
    // A custom symbol wired into the panel: its ports come from the stored row.
    { ...symbolAt("flt", "x", { x: 250, y: 120 }, { tag: "F-3205" }), symbol: { library: CUSTOM_LIBRARY, key: PARITY_IDS.symbol, version: 1 } },
    lineThrough("l5", [
      { x: 200, y: 120 },
      { x: 240, y: 120 }
    ]),
    symbolAt("conn", "off_page_connector", { x: 300, y: 60 }, { fields: { ref: "A" } })
  );
  const second = smallPanelDocument();
  second.items = [
    symbolAt("back", "off_page_connector", { x: 40, y: 250 }, { fields: { ref: "A" } }),
    // Repeats a tag of sheet 1: a duplicate on both sheets.
    symbolAt("dup", "hand_valve", { x: 80, y: 80 }, { tag: "HV-3201" }),
    symbolAt("pi", "instrument", { x: 140, y: 80 }, { tag: "PI-3210" })
  ];
  return {
    context: {
      customSymbols: [
        {
          id: PARITY_IDS.symbol,
          name: "Inline filter",
          view_box: "0 0 64 40",
          svg: '<rect x="12" y="8" width="40" height="24"/><path d="M0 20 H12 M52 20 H64"/>',
          ports: [
            { id: "in", x: 0, y: 20, side: "left" },
            { id: "out", x: 64, y: 20, side: "right" }
          ],
          category: "inline",
          legend: "INLINE FILTER",
          tag_prefix: "F"
        }
      ],
      tagScheme: { kind: "simple", separator: "-", sequenceLength: 4 },
      parts: [
        { id: PARITY_IDS.partBrass, part_number: "HV-BR-025", description: "Hand valve, brass", part_type: "valve", material: "Brass", pressure_rating_bar: 200, lifecycle_status: "obsolete", qualification_status: "unqualified", preferred: false },
        { id: PARITY_IDS.partSteel, part_number: "PCV-SS-025", description: "Regulator, 316L", part_type: "regulator", material: "316L", pressure_rating_bar: 350, lifecycle_status: "active", qualification_status: "qualified", preferred: true }
      ],
      requirements: [
        { id: PARITY_IDS.reqMaterial, key: "REQ-7", title: "316L wetted parts", constraint: { kind: "material_in", values: ["316L"], scope: { services: ["GHe"] } } },
        { id: PARITY_IDS.reqRelief, key: "REQ-8", title: "Relief on every volume", constraint: { kind: "relief_required", values: [] } },
        { id: PARITY_IDS.reqRating, key: "REQ-9", title: "Rated 300 bar", constraint: { kind: "pressure_rating_min", values: ["300 bar"], scope: { categories: ["regulator", "valve"] } } },
        { id: PARITY_IDS.reqPlain, key: "REQ-10", title: "No constraint", constraint: null }
      ]
    },
    drawings: [
      {
        frameTemplate: "fsdp-standard",
        sheets: [
          { sheetId: PARITY_IDS.sheet1, sheetNo: 1, document: first, waivers: [{ key: "duplicate_tag:hv", reason: "Shown on both sheets" }] },
          { sheetId: PARITY_IDS.sheet2, sheetNo: 2, document: second }
        ]
      }
    ]
  };
}
