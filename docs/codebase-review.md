# FSDP Codebase Review — Quality, Bugs, Simplicity, and the "Better than Excel" Test

Date: 2026-10-04
Scope: full backend (`backend/app`), frontend application layer (`App.tsx`, pages, components), and the schematic engine (`frontend/src/engine`), reviewed against `docs/requirements.md`.

Verification state: backend `pytest` 74/74 passing, `ruff` clean; frontend `vitest` 164/164 passing, lint 0 errors / 5 warnings, build succeeds (single 728 kB JS chunk, 222 kB gzip). Findings marked **[T]** were reproduced with throwaway tests; the rest were confirmed by reading the code. As in the August gap analysis, a green suite does not mean the product is healthy.

---

## 1. Verdict

The engineering core is strong: the drafting engine (connectivity, tag schemes, line classes, DRC, generated lists, drawing BoM, PDF/SVG export) does things a spreadsheet cannot. The product, though, has **not yet earned the switch from Excel**, for three reasons:

1. **Two products in one.** The legacy React Flow "Diagrams" editor and the new "Drafting" engine run side by side. They have two tag systems, two part-assignment models, two BoM pipelines, two undo stacks, and three storage formats for a legacy diagram. BoM release/diff, change impact, component trace links, and custom-symbol authoring still only work on the legacy path. A user cannot follow one workflow from start to finish.
2. **Trust bugs.** Unsaved drawing work is lost on in-app navigation. A save during a sheet switch can overwrite the wrong sheet. Trace links break on the next save. "Released" is only a label. An engineer will not move data out of Excel into a tool that loses or silently corrupts it.
3. **Tables are weaker than Excel.** No table can be sorted, edited inline, multi-selected, or pasted into, and parts and requirements cannot be imported. For the data-entry half of the job, Excel is currently faster.

The fix is mostly **subtraction and consolidation**, not new features.

---

## 2. Product definition (proposed canonical scope)

### 2.1 What FSDP is

> The single source of truth for a fluid system's **P&ID, parts, requirements, and BoM**. Lists, checks, BoMs, and traceability are **derived from the drawing**, so they can never disagree with it.

That last clause is the whole case against Excel. In Excel the valve list, line list, BoM, and verification matrix are hand-maintained copies that drift. In FSDP they are views of one model.

### 2.2 The one workflow

Every feature should serve one step of this flow. Anything that does not should be hidden until it does.

| # | Step | Where | Output | Excel equivalent it replaces |
|---|------|-------|--------|------------------------------|
| 1 | **Set up project**: tag scheme, line classes, part-number prefix | Settings → Project | Rules every later step validates against | A "conventions" tab nobody enforces |
| 2 | **Load catalog**: import parts (CSV/XLSX/paste), qualification status, documents | Parts | Qualified, searchable part library | Parts-list workbook |
| 3 | **Draft P&ID**: drawings, sheets, symbols, lines with classes, auto-tags | Drafting | Controlled drawing with title block and revisions | Visio/AutoCAD + manual tag log |
| 4 | **Assign parts**: from canvas or in bulk from the valve/instrument list | Drafting (lists drawer) | Tag → part binding with rating/material warnings | VLOOKUP column in the valve list |
| 5 | **Capture requirements**: import, constraints (e.g. min pressure rating), trace to tags | Requirements | Requirements with machine-checkable constraints | Requirements workbook |
| 6 | **Check**: DRC + requirement checks + BoM readiness | Drafting → Checks | One list of open issues, with waivers | Manual review checklist |
| 7 | **Generate**: instrument/line/valve/equipment lists, BoM, verification matrix | Drafting → Lists / BoM | XLSX/CSV/PDF exports, always current | The hand-maintained tabs themselves |
| 8 | **Release**: drawing revision + BoM, signed by authenticated users, locked | Drafting → Release | Immutable released baseline + diff to previous | "_v7_FINAL_checked.xlsx" |
| 9 | **Change**: impact analysis → new revision → diff | Reviews | What a part/requirement change touches | Ctrl+F across five workbooks |

### 2.3 Feature disposition

| Feature | Decision |
|---|---|
| Drafting page (schematic engine) | **Canonical editor.** Every workflow step anchors here. |
| Legacy Diagrams page (React Flow) | **Retire.** Move custom-symbol authoring, BoM release/diff, impact, and trace links to drawings first, then convert existing diagrams and remove the page. About 4.4k lines go. |
| `/bom` page | Rebuild on **drawing** BoM snapshots (release, diff, CSV/XLSX). Legacy diagram BoMs become read-only history. |
| Dashboard | Make it actionable: open DRC errors, unready BoM rows, unverified requirements, drawings awaiting release, each linking to the item. |
| Safety, Certification pages | **Hide** until they do something. Empty nav entries cost credibility. |
| Reviews / change impact | Keep; extend to drawings (currently legacy-only). |
| Global project switcher | **Add** to the header. Today the active project can only be set on the Systems page. |

### 2.4 The "better than Excel" bar

Two rules, applied to every table in the app:

1. **Parity:** anything a user does to that data in Excel works here too: sort, filter, multi-select, inline edit, paste a block from Excel, import CSV/XLSX, export XLSX, keyboard navigation.
2. **Advantage:** at least one thing Excel cannot do: derived from the drawing, validated against the project rules, linked (click a row → locate on sheet), or versioned (diff against the last release).

Current scorecard:

| Table | Sort | Filter | Inline edit | Multi-select / bulk | Paste / import | XLSX export | Advantage |
|---|---|---|---|---|---|---|---|
| Parts catalog | ✗ | ✓ | ✗ | ✗ | ✗ | ✗ (CSV only) | where-used, documents |
| Requirements | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | DRC constraints, verification matrix |
| Drafting lists | ✗ | ✓ | ✗ (read-only) | ✗ | n/a | ✓ | derived, locate-on-sheet |
| Line classes | ✗ | ✗ | ✗ (no update in UI) | ✗ | ✓ (textarea) | ✗ | enforced on lines |
| BoM | ✗ | ✗ | n/a | ✗ | n/a | ✗ (CSV only) | readiness, diff (legacy only) |
| Verification matrix | ✗ | ✗ | ✗ | ✗ | n/a | ✗ | derived from DRC |

**Highest-leverage build:** one shared `DataGrid` component (sort, filter, multi-select, inline edit, paste-from-clipboard, CSV/XLSX import/export, keyboard navigation), used for all six tables. Pair it with bulk actions: assign one part to N tags, set line class on N lines, change lifecycle on N parts. That turns every Excel-parity cell above into ✓ in one piece of work.

---

## 3. Bugs, ranked

### Critical: data loss or corruption

| ID | Finding | Location |
|---|---|---|
| C1 | **Unsaved drafting/diagram work is lost on in-app navigation.** Only `beforeunload` is guarded. Sidebar `NavLink`s, sign-out, and a 401 discard the editor with no prompt. | `DraftingPage.tsx:255,467`, `AppShell.tsx:220`, `api.ts:74` |
| C2 | **Save during a sheet switch writes sheet A's document into sheet B.** `sheetId` updates before the new editor loads, and `save()` pairs the old editor with the new id. Generate BoM and list export (`ensureSaved`) take the same path. | `DraftingPage.tsx:489,533,654` |
| C3 | **Editing a custom symbol's metadata throws away the open sheet.** The sheet-load effect depends on `registry`, which is rebuilt when symbols refresh, and there is no dirty check. | `DraftingPage.tsx:278,456,731` |
| C4 | **Trace links dangle after the next save [T].** `SheetItem`/`SheetLine` rows are deleted and re-inserted with new PKs on every save, while trace links reference those PKs. Drawing/project delete also leaves orphan links. | `sheet_index.py:22-49`, `routes.py:170-176,1276`, `drawing_routes.py:248` |
| C5 | **Stored XSS via custom symbol SVG [T].** The event-attribute regex needs whitespace before `on`, so `<img/src=x/onerror=…>` passes. The engine renders `custom.svg` with `dangerouslySetInnerHTML` without the sanitizer the legacy path uses. Any engineer can make an admin's browser create accounts. | `schemas.py:406`, `library.ts:82`, `SchematicCanvas.tsx:61`, `LibraryPanel.tsx:29` |
| C6 | **Default JWT secret ships in `docker-compose.yml`** and the app only warns at startup, so sessions can be forged on any deployment that forgot to set it. | `docker-compose.yml`, `core/bootstrap.py:12` |

### High: wrong results the user will trust

| ID | Finding | Location |
|---|---|---|
| H1 | **Pressure parsing:** `"1,000 psig"` → 0.069 bar (comma read as decimal), `"10 mbar"` → 10 bar. Part-rating warnings and `pressure_rating_min` requirement checks pass under-rated parts. | `engine/parts.ts:41-50` |
| H2 | **Tags are unique per sheet only.** Suggestion, renumber, and the `duplicate_tag` DRC ignore other sheets, so HV-1 can exist on every sheet and lists/BoM show duplicates. | `editor.ts:403`, `tags.ts:228-245` |
| H3 | **Equipment tags are ignored** by numbering and duplicate checks: `TK-1` equipment + `TK-1` symbol is not flagged. | `tags.ts:221` |
| H4 | **Structured tags overflow into duplicates.** With 2-digit sequences, after 99 the next tag doesn't parse and the same tag is suggested again. | `tags.ts:171` |
| H5 | **Paste rewrites structured tags into the wrong system/class** (e.g. helium `PT 3222` → vacuum `PT 0101`). | `editor.ts:327` |
| H6 | **Release is only a label [T].** A BoM with blocking readiness issues can be released and un-released. Drawing status is free text (`"banana"` accepted). Released drawings/sheets stay editable. `approved_by`/`checked_by` are free text any engineer can set. | `routes.py:1414`, `schemas.py:1055`, `drawing_routes.py:214-414` |
| H7 | **Deleting sheet 1 fails ~2/3 of the time [T].** Renumbering in one flush violates `uq_drawing_sheet_no` depending on UUID order. | `drawing_routes.py:347-349` |
| H8 | **BoM diff is wrong [T].** It compares `diagram_id` (always `None` for drawings), so cross-project snapshots compare happily. Bulk rows key on their first line ref, so tube and fitting rows collide and a 2 m→10 m tube change produces an empty diff. | `routes.py:1485-1496` |
| H9 | **Stale async responses overwrite the current selection.** Trace links, BoM readiness, verification matrix, the drawings list, and part usage have no cancellation. The trace-link "Remove" button can delete another requirement's link. | `App.tsx:591-631`, `DraftingPage.tsx:299`, `PartsCatalog.tsx:339` |
| H10 | **Legacy keyboard handler runs on every route.** Ctrl+Z on Drafting also undoes the hidden legacy canvas. Delete on /parts deletes legacy nodes that are still selected. | `App.tsx:1157-1187` |
| H11 | **Lists, BoM, and verification matrix miss new or converted sheets** until someone opens and saves them, because index/DRC rows are only written by the client on save. DRC also goes stale when parts or requirements change. | `drawing_routes.py:159,262,300` |

### Medium

- **Shortcuts:** Ctrl+S switches to the Select tool instead of saving (the button advertises Ctrl+S); Ctrl+X mirrors; Ctrl+R rotates. `editor.ts:834-866`.
- **Viewers can edit drafting canvases.** `canWrite` is never passed to the editor; the server rejects the save, but only after the edit.
- **"Create" forms are prefilled with the selected record,** so clicking Create on /requirements re-submits an existing key. `App.tsx:687-699`.
- **Requirement status cannot be changed** anywhere in the UI.
- **Part catalog errors are invisible** when the edit modal is closed (failed delete/obsolete/upload). `PartsCatalog.tsx:806`.
- **API reports a different lifecycle than the DB [T].** `PartRead` inherits `PartCreate`'s validator, so `preferred=true` on a draft reads back as `active`. `schemas.py:207,289`.
- **XLSX formula injection [T].** CSV is escaped but XLSX writes `=HYPERLINK(...)` as a live formula. `lists.py:313`.
- **Change impact ignores drawings** (legacy `ComponentInstance` only). `change_impact.py:13`.
- **Races with no DB constraint:** part-name generation, BoM revision numbers, requirement keys, and sheet saves (last writer wins, no version check).
- **Cross-project references accepted [T]:** trace links, `source_diagram_id`, DRC requirement ids.
- **A viewer can tie up the server through export:** `POST /sheets/{id}/export` has no writer check, runs synchronously, and accepts a client-sized page at 1200 dpi.
- **Geometry:** tees jump to the wrong segment after a symbol move (`edit.ts:91`); dragging a segment or moving a line disconnects teed lines (`editor.ts:553`, `edit.ts:121`); off-page connectors on sheets cloned from the same schematic don't pair (`connectors.ts:101`).
- **Undo history nests one level per drag step** and overflows the stack at around 5k steps, losing that entry. `store.ts:367`.

### Low

Explicit `null` on required fields returns a misleading 409; over-length strings return a 500 on Postgres; JWTs are not revocable and login has no rate limit; uploads are read fully before the size check and the client's content type is stored and served back; `GET /catalog/settings` writes to the DB; OpenAPI docs are public; SQLite doesn't enable `PRAGMA foreign_keys`, so cascades silently don't run there.

---

## 4. Simplicity and maintainability

1. **Retire the legacy diagram stack** (§2.3). This is the single biggest simplification: it removes the second tag system, symbol library, BoM pipeline, part-assignment model, and undo stack, and fixes H10 and the change-impact gap as side effects. `engine/convert.ts` currently imports from `components/PidSymbols`, so the engine depends on legacy UI.
2. **Break up `App.tsx`** (2,398 lines, 53 `useState`, 22 `useEffect`). Give each route its own page component and data hooks, and put the active project/system in a context. Every keystroke in any form currently re-renders the whole app, including the React Flow canvas.
3. **Split `routes.py`** (1,588 lines) into routers for projects/systems, parts, requirements/trace, and BoM. Move `require_model`/`record_change` to `api/deps.py` so `drawing_routes.py` stops importing from `routes.py`. Replace the ~12 copies of the uniqueness check with one `ensure_unique()` plus `lower(name)` unique indexes.
4. **Schemas:** stop Read models inheriting Create validators (the cause of the lifecycle mismatch). Replace duplicated enum validators with `Literal`/`Annotated` types.
5. **One source of truth per computation.** DRC exists only in TypeScript and the server stores whatever the client sends. List column specs are hand-copied between `lists.ts` and `lists.py` and will drift. Either move list/index generation server-side, or have the server validate the client payload against shared specs.
6. **Engine dedup:** one tag-identity helper covering symbols and equipment; one union-find; merge `lineEndpoints`/`describeEnd`; flatten coalesced undo entries.
7. **Dead code:** `edit.suggestTag`, `lineWithPoints`, `rowsToCsv`, `GeneratePartNameRequest`, `DrawingRevision.status`, BoM `alternates`, and unused API functions (`saveSchematic`, `getDrawing`, `getDrawingDrc`, `getDrawingList`, `listDrawingBoms`, `updateLineClass`).
8. **Migrations aren't tested.** Tests use `create_all`; five indexes exist only in migrations; `alembic upgrade` fails on SQLite.

## 5. Performance

- **Drafting drag runs at about 6 fps on a 300-symbol / 450-line sheet** (~150 ms per step). `computeConnectivity` is O(lines² · segments) and runs on every document change. Use the existing `SpatialIndex` in `locateOnLine` and `computeCrossings`, or recompute only on pointer-up.
- The lists drawer rebuilds every sheet's index (and connectivity) on every edit; the DRC panel re-runs DRC on every change. Memoize them per sheet.
- Backend: `selectinload(Drawing.sheets)` loads every sheet's full document JSON for list endpoints (defer `document`). There are N+1 queries in BoM readiness, BoM generation, part usage, and the verification matrix. Indexes are missing on `trace_links` endpoints, `change_events.created_at`, and several FKs. `list_parts` has no pagination.
- Frontend ships as one 728 kB chunk; route-split React Flow and html-to-image (or delete them with the legacy editor).

---

## 6. Prioritized plan

**Phase A: make it trustworthy (about 1 week).** Nothing else matters if data is lost.

> **Status (2026-10-04): Phase A delivered.** Fixed: C1–C6, H1–H5, H7–H10, the drafting shortcuts, invisible parts-catalog errors, and XLSX formula injection, each with regression tests.
>
> Phase A follow-ups resolved in Phase B: versioned saves (`markSaved(version)`), and client-side stripping of editor metadata from symbol SVGs. Still open: tag uniqueness is per drawing rather than per project, and Compose refuses to start without `FSDP_SECRET_KEY`, even for the database alone.

1. Navigation guard for dirty editors (`createBrowserRouter` + `useBlocker`); fix save-to-wrong-sheet (C2); stop recreating the editor when the registry changes (C3).
2. Sanitize symbol SVG on server (allowlist parser) and client (C5); refuse to boot with the default secret (C6).
3. Stable trace-link targets `(sheet_id, item_id)` and cleanup on delete (C4).
4. Pressure parser, project-wide tag uniqueness including equipment, tag overflow, paste tags (H1–H5).
5. Sheet renumber fix, BoM diff keying, cancellation guards, scope the legacy keyboard handler (H7–H10).

**Phase B: one workflow (about 2 weeks).**
1. Real release: status enum, readiness gate, server-side lock on released drawings/BoMs, approvals stamped from the authenticated user, revision diff (H6).
2. Server computes index/DRC on create/convert/part/requirement change (H11).
3. Drawing BoM page (release, diff, XLSX); change impact and trace links on drawings; custom-symbol editor in Drafting.
4. Global project switcher; actionable dashboard; hide Safety/Certification.
5. Delete the legacy Diagrams editor and its backend paths.

**Phase C: beat Excel (about 2 weeks).**
1. Shared `DataGrid`: sort, filter, multi-select, inline edit, paste-from-Excel, CSV/XLSX import/export, keyboard navigation.
2. Roll it out to parts, requirements, line classes, drafting lists, BoM, and the verification matrix.
3. Bulk actions: assign part to N tags from the valve/instrument list; set line class/service on N lines; bulk lifecycle changes.
4. Connectivity performance (spatial index) so 300-symbol sheets drag smoothly.

> **Status (2026-10-04): Phases B and C delivered.**
>
> - **Phase B, one workflow:** draft → in review → released, with server-stamped approvals, an immutable snapshot on release, a lock on released drawings, and a gate that blocks release on stale sheets or open DRC errors. Stale-index tracking with background re-indexing. A drawing BoM page with release gate, diff, and CSV/XLSX. A global project switcher and an actionable dashboard. The legacy Diagrams editor is retired; Drafting is the only editor, and legacy diagrams can only be imported, keeping their tags and parts. `App.tsx` went from 2,398 to 160 lines, and the main bundle from 788 kB to 320 kB.
> - **Phase C, beat Excel:** a shared `DataGrid` (sort, filter, multi-select, inline edit, paste from Excel, CSV/XLSX export, keyboard navigation, virtualization) used for parts, requirements, the verification matrix, line classes, BoMs, and the drafting lists. An import wizard (CSV/XLSX/paste with a dry-run diff, all-or-nothing commit) for parts and requirements. Bulk edit and delete. List cells write back into the drawing, including across sheets, and bulk part, line class, and service edits work from the lists or a canvas multi-selection. Drag on a 300-symbol sheet: about 140 ms → 4 ms per step.
>
> Open items:
> - The lists drawer is short, showing about 3 rows; make it resizable.
> - Legacy requirement→component trace links are not migrated to drawing items on conversion.
> - The Reviews page still shows a "Review workflows" placeholder.
> - Requirement status and verification-method values are a fixed UI list; the backend stores free text.
> - Tag uniqueness is per drawing, not per project.
> - Run the acceptance test below with a real Excel-managed system.

**Acceptance test for "better than Excel":** take a real Excel-managed system (valve list, line list, BoM, requirements). Time an engineer (a) importing it, (b) changing a line's design pressure and finding every affected part and requirement, and (c) producing a released BoM with a diff to the previous release. FSDP is ready when (a) takes no longer than the Excel setup and (b) and (c) are at least 5× faster, which matches the PRD targets of a BoM in under 5 minutes and impact analysis in under 1 minute.
