# Safety features: manual testing guide

Status: written 2026-09-12 for safety phases A–D (`docs/safety-requirements-implementation-plan.md`). Every step below was exercised by the automated suites (`backend/tests/test_safety_phase_{a,b,c,d}.py`, the frontend page tests); this guide is the hands-on pass through the real UI.

## 0. Setup

```bash
docker compose up -d --build
docker compose exec api python -m app.seed   # demo project with hazards, requirements, an analysis
```

Sign in as the bootstrap admin (`FSDP_ADMIN_EMAIL` / `FSDP_ADMIN_PASSWORD` in `.env`). Pick the project **Amphora Demo Vehicle** in the top bar. The seed has no drawing; steps that need one tell you to draw a small sheet first (about five minutes).

For a local dev loop instead: `cd backend && alembic upgrade head && uvicorn app.main:app --reload` and `cd frontend && npm run dev`.

Automated checks, if you want to run them first:

```bash
cd backend && python -m ruff check . && python -m pytest -q      # 93 tests
cd frontend && npm run lint && npx vitest run && npm run build     # 181 tests
```

## 1. Phase A: hazard log, evidence, requirements

**Safety page → Overview.** Tiles show hazards by state and safety requirements verified. The risk matrix (initial and residual) counts the three seeded hazards. Click a matrix cell: the hazard log below filters to it.

**Safety page → Hazard log.**
1. HZ-001 shows `controlled`: its two controls (AMPH-REQ-001 and -002) are verified and the fault-tolerance policy for severity I asks for two independent controls.
2. Open HZ-003 (trapped helium). Its control AMPH-REQ-004 is a derived requirement in `draft` with `planned` verification, so the hazard stays `open`.
3. Press **New hazard**, give it a title, severity II, likelihood C. It gets the next key (HZ-004) and the default fault-tolerance requirement for severity II.
4. In the drawer, **Add control** → pick a requirement. **Derive requirement** creates a new requirement pre-linked with `mitigates`. **Accept** asks for a justification and stamps your user.

**Requirements page.**
1. Tabs: Requirements (tree by derivation, filters by category, safety-critical, verification status), Verification matrix, Coverage.
2. Open AMPH-REQ-004: the drawer shows its parent, rationale ("Controls HZ-003"), applicability, constraint builder (a `relief_required` rule), trace links, evidence, and history.
3. Add evidence to it (kind `analysis`, status `pass`): the requirement rolls up to `verified`, and back on the Safety page HZ-003 becomes `controlled` once the policy is met.
4. **Export** the list or the matrix as XLSX; **Import** the same file with the dry run: it reports zero changes.
5. Coverage lists untraced requirements, safety-critical requirements without evidence, hazards without controls, and hardware controls with no covering requirement.

**Settings page → Safety Policy.** Change the fault-tolerance number for severity I to 3, save: HZ-001 turns `open` on the Safety page; set it back to 2.

## 2. Phase B: FMEA worksheets

You need a drawing. On the **Drafting** page create a drawing (any size), and place and tag a handful of symbols on one process line: a pneumatic valve, a check valve, a relief valve, a filter, a pressure transmitter. Save the sheet; the DRC runs on save.

**Safety page → FMEA.**
1. **New worksheet** bound to the drawing. It records the drawing's current revision label.
2. **Generate rows…** with the categories `valve`, `inline`, `instrument`: one row per failure mode per tagged item. Rows already present are skipped when you generate again. The detecting instrument is suggested from the transmitter on the same line.
3. In the grid, rate S/O/D with the keyboard (arrow keys move, Enter edits, Escape cancels). RPN updates; rows at or above the RPN threshold (Settings, default 100) are highlighted. Ctrl+Z undoes the last bulk save.
4. Set a severity of 8 or more on a row without a hazard: the gate summary lists it. Pick a hazard from the hazard picker; the row clears.
5. Set detection to `none` without a reason: blocked. Add a reason: clears.
6. **Release** while blocked: refused with the list. Fix every blocker, then release rev 1 with a note. Rows are frozen; the worksheet status flips to `released`.
7. Back on **Drafting**, change the tag of one item and save. On the FMEA tab a stale banner names the row (`retagged`). **Confirm and clear** or **Confirm all** re-binds it. Reassign a part on an item: the row shows `part_changed`.
8. **Diff against rev 1** lists the changed rows. Export **XLSX** and **PDF**. Add a comment to a row and resolve it.

**Settings page → Failure-mode library** (admin only): edit an effect template, generate again on a new worksheet: the new rows use the template.

## 3. Phase C: analyses, overlay, auto-hazards

**Drafting page.**
1. Draw an isolable volume: two valves on one line with nothing relieving the section between them. Save. The DRC panel reports a `relief_coverage` finding.
2. With the Settings switch "Create a trapped-fluid hazard for every relief-coverage finding" on, saving creates a hazard linked to the volume; the finding shows its key. With the switch off, the finding offers **Create hazard**.
3. Turn on **Show safety overlay on the sheet**: items with FMEA rows get a badge (count, stale marker, max RPN), volumes with hazards are shaded by risk.
4. Select an item: the **Safety** inspector panel lists its FMEA rows, hazards, and controls, with **Add failure mode** (drops a row into the drawing's draft worksheet) and **Open Safety page**.
5. Waive the relief finding in the DRC panel: refused while the hazard is open; accept the hazard on the Safety page first.

**Safety page → Analyses.**
1. **New analysis** of kind `trapped_volume` on the sheet: the result lists each isolable volume with service, line numbers, isolating items, relief and vent coverage, and a verdict. `relief_scenario` checks set pressure against line design pressure; `single_point_failure` lists items whose failure alone loses a function; `fault_tolerance` counts independent controls per hazard against the policy.
2. Change the sheet (move an item) and save: the analysis shows `outdated`. **Run** again clears it.
3. **Attach as evidence** on a passing analysis records `analysis` evidence on the requirements it covers; refused while outdated.

**Safety page → Design rules.** Every open and waived finding across the project's drawings, grouped by rule, with **Go** to the item on the Drafting page (the URL carries drawing, sheet, and item).

**Reviews page → Change Impact.** Select a part used on the drawing, **Inspect impact**: the list walks items → FMEA rows → hazards → requirements → analyses.

## 4. Phase D: packages, approvers, certification

**Reviews page → Safety Review Packages.**
1. Leave the scope unchecked (everything) or tick drawings and worksheets. **Generate package**. The status line shows the wall-clock time (a few seconds for the demo).
2. **PDF**: cover with scope and summary, two risk matrices, hazard log, FMEA rows by RPN, verification matrix, open actions, design rule findings and waivers, change log. **XLSX**: the same as sheets.
3. Change something (rename a hazard), generate again: the second package's change log starts at the first package and lists the rename. **Delete** removes the row and its files.

**Settings page → Safety Policy → Safety approvers.** Tick one engineer user (create one on the Settings page first). Sign in as another engineer: **Accept** on a hazard and **Release** on a worksheet return 403; the ticked user and admins pass. Empty the list: any engineer passes again.

**Certification page.** Tiles and panels: gaps (severity I–II hazards not accepted, safety-critical requirements not verified or waived, worksheets never released or released against an older drawing revision, outdated or failed analyses, open design rule errors, no package), accepted hazards, verified safety requirements, released worksheets (with "behind drawing" once you add a drawing revision), analyses, packages. Each gap has **Open**. The page reads "no gaps" once everything is closed.

## 5. Things to look at critically

- The failure-mode library defaults are a starting set for GSE fluid systems; check the severities and effect templates against your standard.
- Volume keys hash the sorted line ids; splitting a line inside a volume changes the key and marks rows `moved_volume`. If that is noisy in practice, keying by the isolating items is the planned fallback.
- The `relief_scenario` analysis checks presence and set pressure against line design pressure; it does not size relief capacity.
- Package files live under `var/safety-packages` in the API container; the compose file mounts `/app/var` as a named volume so they survive rebuilds.
- Approver grant matches by e-mail or user id; renaming a user's e-mail drops the grant.
