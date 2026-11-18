import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Analysis, PressureDropResults, ReliefSizingResults } from "../types";

const apiMock = vi.hoisted(() => ({ listDrawings: vi.fn(), getDrawingList: vi.fn() }));
const analysisApi = vi.hoisted(() => ({ list: vi.fn(), get: vi.fn(), preview: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn() }));

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return { ...actual, api: apiMock, analysisApi };
});

const workspace = vi.hoisted(() => ({
  busy: false,
  canWrite: true,
  formErrors: {} as Record<string, string>,
  runAction: vi.fn(),
  selectedProjectId: "p1",
  selectedProject: { id: "p1", name: "Vehicle" }
}));

vi.mock("../workspace/WorkspaceContext", () => ({ useWorkspace: () => workspace }));

import { AnalysisPage, buildPressureDropInputs, buildReliefInputs, formatNumber, resultSummary } from "./AnalysisPage";

const pressureDropResults: PressureDropResults = {
  calc_version: 1,
  kind: "pressure_drop",
  flow: { mass_flow_kg_s: 0.9982, volumetric_flow_l_min: 60 },
  segments: [
    {
      name: "L1",
      velocity_m_s: 2.03718,
      reynolds: 50736.4,
      flow_regime: "turbulent",
      relative_roughness: 0.0018,
      friction_factor: 0.026255,
      dp_friction_kpa: 21.753,
      dp_minor_kpa: 0,
      dp_components_kpa: 0,
      dp_elevation_kpa: 0,
      dp_total_kpa: 21.753
    }
  ],
  totals: { dp_friction_kpa: 21.753, dp_minor_kpa: 0, dp_components_kpa: 0, dp_elevation_kpa: 0, dp_total_kpa: 21.753, dp_total_bar: 0.21753, head_loss_m: 2.2222 },
  warnings: ["L1: velocity 4.07 m/s is above the limit of 3 m/s set for this analysis."],
  assumptions: ["Steady, single-phase, incompressible flow."]
};

const reliefResults: ReliefSizingResults = {
  calc_version: 1,
  kind: "relief_sizing",
  service: "gas",
  flow_regime: "critical",
  relieving_pressure_kpag: 568.7,
  relieving_pressure_kpa_abs: 670.025,
  back_pressure_kpa_abs: 101.325,
  critical_flow_pressure_kpa_abs: 390.2,
  coefficient_c: 0.02489,
  factors: { kd: 0.975, kb: 1, kc: 1 },
  required_area_mm2: 3698.9,
  required_area_in2: 5.7333,
  orifice: { letter: "P", area_mm2: 4116.12, area_in2: 6.38 },
  warnings: [],
  assumptions: ["API Standard 520 Part I preliminary sizing in SI units."]
};

const stored: Analysis = {
  id: "a1",
  project_id: "p1",
  drawing_id: "d1",
  kind: "pressure_drop",
  name: "Fill line",
  inputs: {
    fluid_name: "Water",
    density_kg_m3: 998.2,
    viscosity_mpa_s: 1.002,
    mass_flow_kg_s: null,
    volumetric_flow_l_min: 60,
    velocity_limit_m_s: 3,
    segments: [{ name: "L1", inner_diameter_mm: 25, length_m: 10, roughness_mm: 0.045, k_sum: 0, elevation_change_m: 0, cv_items: [{ name: "", cv: 5 }] }]
  },
  results: pressureDropResults,
  status: "checked",
  created_by: "ana@fsdp.test",
  created_at: "2026-11-17T10:00:00Z",
  updated_at: "2026-11-17T10:00:00Z"
};

const drawings = [{ id: "d1", project_id: "p1", number: "DWG-0001", title: "LN2 fill panel" }];

function fill(label: string | RegExp, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

beforeEach(() => {
  workspace.canWrite = true;
  workspace.runAction.mockImplementation(async (_message: string, action: () => Promise<void>) => {
    await action();
  });
  analysisApi.list.mockResolvedValue([]);
  analysisApi.preview.mockResolvedValue({ kind: "pressure_drop", inputs: {}, results: pressureDropResults });
  apiMock.listDrawings.mockResolvedValue(drawings);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("analysis helpers", () => {
  it("formats numbers to four significant figures", () => {
    expect(formatNumber(21.7530068)).toBe("21.75");
    expect(formatNumber(0.026255)).toBe("0.02626");
    expect(formatNumber(50736.4)).toBe("50,736");
    expect(formatNumber(0)).toBe("0");
    expect(formatNumber(1.2e-6)).toBe("1.200e-6");
    expect(formatNumber(null)).toBe("–");
  });

  it("summarises stored results", () => {
    expect(resultSummary(pressureDropResults)).toBe("21.75 kPa");
    expect(resultSummary(reliefResults)).toBe("3699 mm², orifice P");
    expect(resultSummary({ ...reliefResults, orifice: null })).toBe("3699 mm², above orifice T");
  });

  it("builds pressure-drop inputs and names what is missing", () => {
    const segment = { id: 1, name: " L1 ", diameter: "25", length: "10", roughness: "", k: "1,5", elevation: "-2", cv: "5, 12.5" };
    const complete = buildPressureDropInputs({ fluidName: "Water", density: "998.2", viscosity: "1.002", flowBasis: "mass", flow: "0.5", velocityLimit: "", segments: [segment] });
    expect(complete.missing).toEqual([]);
    expect(complete.inputs).toEqual({
      fluid_name: "Water",
      density_kg_m3: 998.2,
      viscosity_mpa_s: 1.002,
      mass_flow_kg_s: 0.5,
      velocity_limit_m_s: 3,
      segments: [{ name: "L1", inner_diameter_mm: 25, length_m: 10, roughness_mm: 0, k_sum: 1.5, elevation_change_m: -2, cv_items: [{ name: "", cv: 5 }, { name: "", cv: 12.5 }] }]
    });
    const empty = buildPressureDropInputs({ fluidName: "", density: "", viscosity: "", flowBasis: "volumetric", flow: "", velocityLimit: "3", segments: [{ ...segment, diameter: "" }] });
    expect(empty.missing).toEqual(["density", "viscosity", "flow", "inner diameter of segment 1"]);
    expect(empty.inputs).toHaveProperty("volumetric_flow_l_min");
  });

  it("builds relief inputs per service", () => {
    const form = {
      service: "gas" as const,
      fluidName: "",
      setPressure: "517",
      overpressure: "10",
      backPressure: "0",
      atmosphere: "101.325",
      kd: "",
      kc: "1",
      massRate: "24270",
      temperature: "74.85",
      molarMass: "51",
      k: "1.11",
      z: "0.9",
      kb: "1",
      volumeRate: "",
      density: "",
      viscosity: "",
      kw: "1"
    };
    const gas = buildReliefInputs(form);
    expect(gas.missing).toEqual([]);
    expect(gas.inputs).toMatchObject({ service: "gas", set_pressure_kpag: 517, kd: null, mass_rate_kg_h: 24270, relieving_temperature_c: 74.85, k: 1.11, z: 0.9 });
    expect(gas.inputs).not.toHaveProperty("volume_rate_l_min");
    const liquid = buildReliefInputs({ ...form, service: "liquid" });
    expect(liquid.missing).toEqual(["relieving rate", "density"]);
    expect(liquid.inputs).toMatchObject({ service: "liquid", viscosity_mpa_s: null, kw: 1 });
    expect(liquid.inputs).not.toHaveProperty("mass_rate_kg_h");
  });
});

describe("AnalysisPage", () => {
  it("asks for the missing inputs before previewing", async () => {
    render(<AnalysisPage />);
    expect(await screen.findByText("No stored analyses yet. Fill in a calculator below and save it.")).toBeInTheDocument();
    expect(screen.getByText("Enter density, viscosity, flow, inner diameter of segment 1 to see the result.")).toBeInTheDocument();
    expect(analysisApi.preview).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Save analysis" })).toBeDisabled();
  });

  it("previews a pressure drop with units and warnings, then saves it", async () => {
    analysisApi.create.mockResolvedValue({ ...stored, id: "a2" });
    render(<AnalysisPage />);

    fill("Analysis name", "Fill line");
    fill(/^Density/, "998.2");
    fill(/^Dynamic viscosity/, "1.002");
    fill(/^Flow \(/, "60");
    fill("Inner diameter, segment 1", "25");
    fill("Length, segment 1", "10");
    fill("Roughness, segment 1", "0.045");

    expect(await screen.findByText("Total pressure drop")).toBeInTheDocument();
    const expectedInputs = {
      fluid_name: "",
      density_kg_m3: 998.2,
      viscosity_mpa_s: 1.002,
      volumetric_flow_l_min: 60,
      velocity_limit_m_s: 3,
      segments: [{ name: "", inner_diameter_mm: 25, length_m: 10, roughness_mm: 0.045, k_sum: 0, elevation_change_m: 0, cv_items: [] }]
    };
    expect(analysisApi.preview).toHaveBeenLastCalledWith("pressure_drop", expectedInputs, expect.anything());
    expect(screen.getByText("Total pressure drop").parentElement).toHaveTextContent("21.75 kPa");
    expect(screen.getByText("0.2175 bar")).toBeInTheDocument();
    const table = screen.getByRole("table", { name: "Pressure drop by segment" });
    expect(within(table).getByText("Friction (kPa)")).toBeInTheDocument();
    expect(within(table).getByText("50,736")).toBeInTheDocument();
    expect(within(table).getByText("turbulent")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("L1: velocity 4.07 m/s is above the limit of 3 m/s set for this analysis.");
    expect(screen.getByText("Steady, single-phase, incompressible flow.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Save analysis" }));
    await waitFor(() =>
      expect(analysisApi.create).toHaveBeenCalledWith("p1", { kind: "pressure_drop", name: "Fill line", inputs: expectedInputs, drawing_id: null, status: "draft" })
    );
    await waitFor(() => expect(analysisApi.list).toHaveBeenCalledTimes(2));
  });

  it("shows the server's message when the inputs cannot be computed", async () => {
    analysisApi.preview.mockRejectedValue(new Error("segments.0.inner_diameter_mm: Input should be greater than 0"));
    render(<AnalysisPage />);

    fill("Analysis name", "Bad");
    fill(/^Density/, "998.2");
    fill(/^Dynamic viscosity/, "1.002");
    fill(/^Flow \(/, "60");
    fill("Inner diameter, segment 1", "0");

    expect(await screen.findByText("segments.0.inner_diameter_mm: Input should be greater than 0")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save analysis" })).toBeDisabled();
  });

  it("sizes a gas relief valve and shows the orifice", async () => {
    analysisApi.preview.mockResolvedValue({ kind: "relief_sizing", inputs: {}, results: reliefResults });
    render(<AnalysisPage />);

    fireEvent.click(screen.getByRole("button", { name: "New relief valve sizing" }));
    expect(screen.getByText("Enter set pressure, relieving rate, relieving temperature, molar mass, k to see the result.")).toBeInTheDocument();
    fill(/^Set pressure/, "517");
    fill(/^Required relieving rate/, "24270");
    fill(/^Relieving temperature/, "74.85");
    fill(/^Molar mass/, "51");
    fill(/^Ratio of specific heats/, "1.11");
    fill(/^Compressibility/, "0.9");

    expect(await screen.findByText("Required effective area")).toBeInTheDocument();
    expect(analysisApi.preview).toHaveBeenLastCalledWith(
      "relief_sizing",
      {
        service: "gas",
        fluid_name: "",
        set_pressure_kpag: 517,
        overpressure_pct: 10,
        back_pressure_kpag: 0,
        atmospheric_pressure_kpa: 101.325,
        kd: null,
        kc: 1,
        mass_rate_kg_h: 24270,
        relieving_temperature_c: 74.85,
        molar_mass_kg_kmol: 51,
        k: 1.11,
        z: 0.9,
        kb: 1
      },
      expect.anything()
    );
    expect(screen.getByText("3699")).toBeInTheDocument();
    expect(screen.getByText("5.733 in²")).toBeInTheDocument();
    expect(screen.getByText("P")).toBeInTheDocument();
    expect(screen.getByText("4116 mm² (6.38 in²)")).toBeInTheDocument();
    expect(screen.getByText("Critical (choked)")).toBeInTheDocument();
    expect(screen.getByText("Kd = 0.975, Kb = 1, Kc = 1")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("lists stored analyses, reopens one with its inputs, and saves changes", async () => {
    analysisApi.list.mockResolvedValue([stored]);
    analysisApi.update.mockResolvedValue(stored);
    render(<AnalysisPage />);

    const row = (await screen.findByRole("button", { name: "Fill line" })).closest("tr")!;
    expect(within(row).getByText("21.75 kPa")).toBeInTheDocument();
    expect(within(row).getByText("checked")).toBeInTheDocument();
    expect(await within(row).findByText("DWG-0001")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Fill line" }));
    expect(screen.getByLabelText("Analysis name")).toHaveValue("Fill line");
    expect(screen.getByLabelText(/^Density/)).toHaveValue("998.2");
    expect(screen.getByLabelText("Inner diameter, segment 1")).toHaveValue("25");
    expect(screen.getByLabelText("Valve Cv, segment 1")).toHaveValue("5");
    expect(screen.getByLabelText("Status")).toHaveValue("checked");

    fill("Length, segment 1", "12");
    await screen.findByText("Total pressure drop");
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(analysisApi.update).toHaveBeenCalledTimes(1));
    const [id, body] = analysisApi.update.mock.calls[0];
    expect(id).toBe("a1");
    expect(body).toMatchObject({ name: "Fill line", drawing_id: "d1", status: "checked" });
    expect(body.inputs.segments[0]).toMatchObject({ length_m: 12, cv_items: [{ name: "", cv: 5 }] });
  });

  it("fills the segments from the drawing's line list", async () => {
    apiMock.getDrawingList.mockResolvedValue({
      rows: [
        { line_number: "1001", size: '1/2"', length_m: 4.5 },
        { line_number: "1002", size: "12 mm", length_m: null },
        { line_number: null, size: '1/4"', length_m: 1 },
        { line_number: "1003", size: null, length_m: 2 }
      ]
    });
    render(<AnalysisPage />);

    const fillButton = screen.getByRole("button", { name: "Fill from the drawing's line list" });
    expect(fillButton).toBeDisabled();
    await screen.findByRole("option", { name: "DWG-0001 · LN2 fill panel" });
    fireEvent.change(screen.getByLabelText("Drawing (optional)"), { target: { value: "d1" } });
    fireEvent.click(fillButton);

    expect(await screen.findByText(/^Loaded 3 lines \(1 without a size, 1 without a length\)\. Diameters are the nominal line sizes/)).toBeInTheDocument();
    expect(apiMock.getDrawingList).toHaveBeenCalledWith("d1", "line");
    expect(screen.getByLabelText("Name, segment 1")).toHaveValue("1001");
    expect(screen.getByLabelText("Inner diameter, segment 1")).toHaveValue("12.7");
    expect(screen.getByLabelText("Length, segment 1")).toHaveValue("4.5");
    expect(screen.getByLabelText("Inner diameter, segment 2")).toHaveValue("12");
    expect(screen.getByLabelText("Length, segment 2")).toHaveValue("");
    expect(screen.getByLabelText("Inner diameter, segment 3")).toHaveValue("");
  });

  it("adds and removes segments", () => {
    render(<AnalysisPage />);
    expect(screen.getByRole("button", { name: "Remove segment 1" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Add segment" }));
    fill("Name, segment 2", "Outlet");
    fireEvent.click(screen.getByRole("button", { name: "Remove segment 1" }));
    expect(screen.getByLabelText("Name, segment 1")).toHaveValue("Outlet");
    expect(screen.queryByLabelText("Name, segment 2")).not.toBeInTheDocument();
  });

  it("lets viewers preview but not save or delete", async () => {
    workspace.canWrite = false;
    analysisApi.list.mockResolvedValue([stored]);
    render(<AnalysisPage />);

    await screen.findByRole("button", { name: "Fill line" });
    expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save analysis" })).not.toBeInTheDocument();
    expect(screen.getByText("This account is read-only: results can be previewed but not saved.")).toBeInTheDocument();
  });

  it("deletes a stored analysis after confirmation", async () => {
    analysisApi.list.mockResolvedValue([stored]);
    analysisApi.remove.mockResolvedValue(undefined);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<AnalysisPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    await waitFor(() => expect(analysisApi.remove).toHaveBeenCalledWith("a1"));
    expect(window.confirm).toHaveBeenCalledWith('Delete the analysis "Fill line"?');
  });
});
