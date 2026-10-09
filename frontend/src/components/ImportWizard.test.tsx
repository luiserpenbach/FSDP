import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ImportOptions, ImportReport, ImportRowsBody } from "../types";
import { ImportWizard, pastedRows, type ImportWizardProps } from "./ImportWizard";

function report(overrides: Partial<ImportReport> = {}): ImportReport {
  return {
    entity: "part",
    mode: "upsert",
    dry_run: true,
    committed: false,
    mapping: { "Part #": "part_number", Desc: "description", "Mat'l": "material", Colour: null },
    warnings: [],
    rows: [
      {
        row: 1,
        action: "create",
        key: "PV-1",
        id: null,
        errors: [],
        changes: { part_number: [null, "PV-1"], description: [null, "Ball valve"] }
      },
      { row: 2, action: "update", key: "PV-2", id: "p2", errors: [], changes: { material: ["SS316", "316L"] } },
      { row: 3, action: "unchanged", key: "PV-3", id: "p3", errors: [], changes: {} }
    ],
    summary: { create: 1, update: 1, unchanged: 1, error: 0 },
    ...overrides
  };
}

const errorReport = report({
  rows: [
    { row: 1, action: "create", key: "PV-1", id: null, errors: [], changes: { part_number: [null, "PV-1"] } },
    {
      row: 2,
      action: "error",
      key: "PV-9",
      id: null,
      errors: [{ field: "lifecycle_status", message: "must be one of: active, draft" }],
      changes: {}
    }
  ],
  summary: { create: 1, update: 0, unchanged: 0, error: 1 }
});

const PASTE = "Part #\tDesc\tMat'l\tColour\nPV-1\tBall valve\t\tred\nPV-2\t\t316L\t\n";

function renderWizard(props: Partial<ImportWizardProps> = {}) {
  const runImport = vi.fn<(source: File | ImportRowsBody, options: ImportOptions) => Promise<ImportReport>>();
  const onImported = vi.fn();
  const onClose = vi.fn();
  render(
    <ImportWizard
      canWrite
      downloadTemplate={vi.fn()}
      entityLabel="parts"
      fieldLabels={{ part_number: "Part number" }}
      keyLabel="part number"
      onClose={onClose}
      onImported={onImported}
      runImport={runImport}
      {...props}
    />
  );
  return { runImport, onImported, onClose, dialog: screen.getByRole("dialog", { name: "Import parts" }) };
}

function pasteRows(dialog: HTMLElement, text = PASTE) {
  fireEvent.click(within(dialog).getByLabelText("Paste from Excel"));
  fireEvent.change(within(dialog).getByLabelText("Pasted rows"), { target: { value: text } });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("pastedRows", () => {
  it("splits the header row from data rows and drops blank lines", () => {
    expect(pastedRows("A\tB\r\n1\t2\r\n\t\r\n3\t4\r\n")).toEqual({ headers: ["A", "B"], rows: [["1", "2"], ["3", "4"]] });
    expect(pastedRows("A\tB\n")).toBeNull();
  });
});

describe("ImportWizard", () => {
  it("runs a dry run, shows mapping, summary and changes, then commits and reports", async () => {
    const { runImport, onImported, dialog } = renderWizard();
    runImport.mockResolvedValueOnce(report());
    runImport.mockResolvedValueOnce(report({ dry_run: false, committed: true }));

    // Nothing to import before a dry run.
    expect(within(dialog).getByRole("button", { name: /^Import/ })).toBeDisabled();
    pasteRows(dialog);
    fireEvent.click(within(dialog).getByLabelText("Create or update (match on part number)"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Check (dry run)" }));

    expect(await within(dialog).findByText("1 create")).toBeInTheDocument();
    expect(runImport).toHaveBeenCalledWith(
      {
        headers: ["Part #", "Desc", "Mat'l", "Colour"],
        rows: [
          ["PV-1", "Ball valve", "", "red"],
          ["PV-2", "", "316L", ""]
        ]
      },
      { dryRun: true, mode: "upsert" }
    );
    const summary = within(dialog).getByRole("status", { name: "Dry run summary" });
    expect(summary).toHaveTextContent("1 create1 update1 unchanged0 errors");

    const mapping = within(dialog).getByRole("list", { name: "Column mapping" });
    expect(within(mapping).getByText("Part #").closest("li")).toHaveTextContent("Part # → Part number");
    const ignored = within(mapping).getByText("Colour").closest("li");
    expect(ignored).toHaveClass("importIgnored");
    expect(ignored).toHaveTextContent("Colour → ignored");

    const preview = within(dialog).getByRole("grid", { name: "Import preview" });
    expect(within(preview).getByText("PV-2")).toBeInTheDocument();
    const change = within(preview).getByText("SS316").closest(".importChange");
    expect(change).toHaveTextContent("material SS316 → 316L");

    fireEvent.click(within(dialog).getByRole("button", { name: "Import 2 rows" }));
    expect(await within(dialog).findByText("Imported parts: 1 created, 1 updated, 1 unchanged.")).toBeInTheDocument();
    expect(runImport).toHaveBeenLastCalledWith(expect.objectContaining({ headers: ["Part #", "Desc", "Mat'l", "Colour"] }), {
      dryRun: false,
      mode: "upsert"
    });
    expect(onImported).toHaveBeenCalledWith(expect.objectContaining({ committed: true }));
    expect(within(dialog).getByRole("button", { name: "Done" })).toBeInTheDocument();
  });

  it("blocks the import while rows have errors and filters the preview to them", async () => {
    const { runImport, dialog } = renderWizard();
    runImport.mockResolvedValueOnce(errorReport);
    pasteRows(dialog);
    fireEvent.click(within(dialog).getByRole("button", { name: "Check (dry run)" }));

    expect(await within(dialog).findByText("1 errors")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Import 1 row" })).toBeDisabled();
    expect(within(dialog).getByText(/nothing is imported while errors remain/)).toBeInTheDocument();

    const preview = within(dialog).getByRole("grid", { name: "Import preview" });
    // Errors-only is on by default when there are errors.
    expect(within(dialog).getByLabelText("Only rows with errors (1)")).toBeChecked();
    expect(within(preview).getByText("PV-9")).toBeInTheDocument();
    expect(within(preview).queryByText("PV-1")).not.toBeInTheDocument();
    expect(within(preview).getByText("lifecycle status: must be one of: active, draft")).toBeInTheDocument();

    fireEvent.click(within(dialog).getByLabelText("Only rows with errors (1)"));
    expect(within(preview).getAllByText("PV-1").length).toBeGreaterThan(0);
    expect(runImport).toHaveBeenCalledTimes(1);
  });

  it("shows the refusal when the server rejects the commit, and invalidates the check on edits", async () => {
    const { runImport, onImported, dialog } = renderWizard();
    runImport.mockResolvedValueOnce(report());
    runImport.mockResolvedValueOnce({ ...errorReport, dry_run: false });
    pasteRows(dialog);
    fireEvent.click(within(dialog).getByRole("button", { name: "Check (dry run)" }));
    fireEvent.click(await within(dialog).findByRole("button", { name: "Import 2 rows" }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Nothing was imported: 1 row(s) have errors.");
    expect(onImported).not.toHaveBeenCalled();
    expect(within(dialog).getByRole("button", { name: "Import 1 row" })).toBeDisabled();

    // Editing the source drops the stale check.
    fireEvent.change(within(dialog).getByLabelText("Pasted rows"), { target: { value: PASTE + "PV-4\t\t\t\n" } });
    expect(within(dialog).queryByRole("grid", { name: "Import preview" })).not.toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Import 0 rows" })).toBeDisabled();
  });

  it("uploads a file as the source", async () => {
    const { runImport, dialog } = renderWizard();
    runImport.mockResolvedValueOnce(report());
    const file = new File(["part_number\nPV-1\n"], "parts.csv", { type: "text/csv" });
    fireEvent.change(within(dialog).getByLabelText("Import file"), { target: { files: [file] } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Check (dry run)" }));
    await waitFor(() => expect(runImport).toHaveBeenCalledWith(file, { dryRun: true, mode: "create_only" }));
  });

  it("asks for a source instead of calling the server with nothing", () => {
    const { runImport, dialog } = renderWizard();
    fireEvent.click(within(dialog).getByRole("button", { name: "Check (dry run)" }));
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Choose a .csv or .xlsx file first.");
    expect(runImport).not.toHaveBeenCalled();
  });

  it("starts from prefilled rows with a dry run", async () => {
    const runImport = vi.fn().mockResolvedValue(report());
    renderWizard({ runImport, initialRows: { headers: ["part_number", "description"], rows: [["PV-1", "Ball valve"]] } });
    await waitFor(() =>
      expect(runImport).toHaveBeenCalledWith(
        { headers: ["part_number", "description"], rows: [["PV-1", "Ball valve"]] },
        { dryRun: true, mode: "create_only" }
      )
    );
    expect(await screen.findByText("1 create")).toBeInTheDocument();
  });

  it("downloads the template", async () => {
    const downloadTemplate = vi.fn().mockResolvedValue({ blob: new Blob(["x"]), filename: "parts-import-template.xlsx" });
    const createObjectURL = vi.fn(() => "blob:t");
    vi.stubGlobal("URL", { ...URL, createObjectURL, revokeObjectURL: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    const { dialog } = renderWizard({ downloadTemplate });
    fireEvent.click(within(dialog).getByRole("button", { name: "XLSX" }));
    expect(downloadTemplate).toHaveBeenCalledWith("xlsx");
    await waitFor(() => expect(click).toHaveBeenCalled());
    vi.unstubAllGlobals();
  });

  it("is closed for viewers", () => {
    const { dialog } = renderWizard({ canWrite: false });
    expect(within(dialog).getByText(/Importing needs an engineer or admin account/)).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: /^Import/ })).not.toBeInTheDocument();
  });
});
