import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { App } from "./App";

vi.stubGlobal(
  "fetch",
  vi.fn((url: string) => {
    const body = url.includes("/projects") || url.includes("/parts") ? [] : {};
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve(body)
    });
  })
);

describe("App", () => {
  it("renders the production navigation shell", async () => {
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Dashboard" })).toBeInTheDocument();
    expect(screen.getByText("Parts Catalog")).toBeInTheDocument();
    expect(screen.getByText("BoM & Procurement")).toBeInTheDocument();
    expect(screen.getByText("Search parts, requirements, diagrams...")).toBeInTheDocument();
  });
});
