import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FittingSelector } from "./FittingsPage";
import { bomStorageKey } from "../fittings/fittingBom";
import type { Part } from "../types";

function jsonResponse(body: unknown, status = 200): Promise<Response> {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
}

const catalogTee: Part = {
  id: "p1",
  part_number: "SS-400-3",
  description: "Union tee",
  part_type: "fitting",
  source_type: "vendor",
  qualification_status: "unqualified",
  certification_status: "unreviewed",
  lifecycle_status: "draft",
  preferred: false
};

function renderSelector(parts: Part[] = [], onPartsChanged = vi.fn()) {
  render(
    <FittingSelector projectId="pr1" projectName="Vehicle" canWrite parts={parts} onPartsChanged={onPartsChanged} />
  );
  return onPartsChanged;
}

function typeDescription(text: string) {
  fireEvent.change(screen.getByPlaceholderText(/3\/8 tube to 1\/4 male NPT elbow/), { target: { value: text } });
}

beforeEach(() => localStorage.clear());

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("FittingSelector", () => {
  it("shows the best match with its specs and product image for a description", async () => {
    renderSelector();
    typeDescription("3/8 tube to 1/4 male NPT elbow");
    const detail = await screen.findByRole("article", { name: "Selected fitting" });
    expect(within(detail).getByRole("heading", { name: /SS-600-2-4/ })).toBeInTheDocument();
    expect(within(detail).getByText("Stainless Steel Swagelok Tube Fitting, Male Elbow, 3/8 in. Tube OD x 1/4 in. Male NPT")).toBeInTheDocument();
    expect(within(detail).getByRole("img", { name: /Illustration of/ })).toBeInTheDocument();
    expect(within(detail).getByText("Rated to the tubing")).toBeInTheDocument();
    expect(within(detail).getByRole("link", { name: /swagelok\.com/ })).toHaveAttribute(
      "href",
      "https://products.swagelok.com/en/c/straights/p/SS-600-2-4"
    );
  });

  it("re-derives the ordering number when the configuration changes", async () => {
    renderSelector();
    typeDescription("1/4 union");
    const detail = await screen.findByRole("article", { name: "Selected fitting" });
    fireEvent.change(within(detail).getByLabelText("Material"), { target: { value: "B" } });
    expect(within(detail).getByRole("heading", { name: /B-400-6/ })).toBeInTheDocument();
    fireEvent.change(within(detail).getByLabelText("Type"), { target: { value: "male_connector" } });
    expect(within(detail).getByRole("heading", { name: /B-400-1-4/ })).toBeInTheDocument();
  });

  it("adds fittings to the list, merging repeats, and keeps it per project", async () => {
    renderSelector();
    typeDescription("SS-400-6");
    const add = await screen.findByRole("button", { name: "Add to fitting list" });
    fireEvent.change(screen.getByLabelText("Qty"), { target: { value: "4" } });
    fireEvent.click(add);
    fireEvent.click(add);
    const stored = JSON.parse(localStorage.getItem(bomStorageKey("pr1")) ?? "[]");
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ partNumber: "SS-400-6", qty: 8 });
    expect(screen.getByText("1 line · 8 pieces")).toBeInTheDocument();
  });

  it("adds list fittings that are not yet in the catalog as Swagelok vendor parts", async () => {
    const calls: Array<{ path: string; method: string; body: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: RequestInit) => {
        const path = String(url).replace("http://localhost:8000", "");
        calls.push({ path, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
        if (path === "/parts" && init?.method === "POST") return jsonResponse({ ...catalogTee, id: "p2" });
        return jsonResponse([catalogTee]);
      })
    );
    const onPartsChanged = renderSelector([catalogTee]);
    for (const text of ["SS-400-3", "SS-600-6-4"]) {
      typeDescription(text);
      fireEvent.click(await screen.findByRole("button", { name: "Add to fitting list" }));
    }
    fireEvent.click(screen.getByRole("button", { name: "Add all to catalog" }));
    await waitFor(() => expect(onPartsChanged).toHaveBeenCalled());
    const posts = calls.filter((call) => call.method === "POST");
    // SS-400-3 is already in the catalog; only the reducing union is created.
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toMatchObject({
      part_number: "SS-600-6-4",
      part_type: "fitting",
      source_type: "vendor",
      manufacturer: "Swagelok",
      material: "316 SS",
      metadata: { swagelok: { config: { kind: "reducing_union", tube: "3/8in", tube2: "1/4in" } } }
    });
    expect(posts[0].body).not.toHaveProperty("pressure_rating_bar");
    expect(await screen.findByText("Added 1 fitting to the parts catalog.")).toBeInTheDocument();
  });

  it("explains a description it cannot read", () => {
    renderSelector();
    typeDescription("solenoid valve");
    expect(screen.getByText(/Name a fitting type/)).toBeInTheDocument();
  });
});
