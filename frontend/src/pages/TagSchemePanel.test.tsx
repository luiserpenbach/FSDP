import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "../types";
import { DEFAULT_TAG_SCHEME, REFERENCE_TAG_SCHEME } from "../engine/tags";

const apiMock = vi.hoisted(() => ({
  getTagScheme: vi.fn(),
  updateTagScheme: vi.fn()
}));

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return { ...actual, api: { ...actual.api, ...apiMock } };
});

import { TagSchemePanel } from "./TagSchemePanel";

const projectA = { id: "p1", name: "Vehicle A" } as Project;
const projectB = { id: "p2", name: "Vehicle B" } as Project;

const schemeA = {
  ...REFERENCE_TAG_SCHEME,
  systems: [{ digit: "9", name: "Project A only" }],
  sequenceLength: 3
};

const schemeB = {
  ...DEFAULT_TAG_SCHEME,
  separator: " ",
  sequenceLength: 2
};

describe("TagSchemePanel", () => {
  beforeEach(() => {
    Object.values(apiMock).forEach((fn) => fn.mockReset());
  });

  afterEach(() => {
    cleanup();
  });

  it("loads and saves the selected project's scheme", async () => {
    apiMock.getTagScheme.mockResolvedValue({ project_id: "p1", scheme: schemeA });
    apiMock.updateTagScheme.mockResolvedValue({ project_id: "p1", scheme: schemeA });
    render(<TagSchemePanel project={projectA} canWrite />);

    await waitFor(() => expect(apiMock.getTagScheme).toHaveBeenCalledWith("p1"));
    expect(await screen.findByDisplayValue("3")).toBeInTheDocument();
    expect(screen.getByDisplayValue("9=Project A only")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Save tag scheme" }));
    await waitFor(() =>
      expect(apiMock.updateTagScheme).toHaveBeenCalledWith(
        "p1",
        expect.objectContaining({ kind: "structured", sequenceLength: 3, systems: [{ digit: "9", name: "Project A only" }] })
      )
    );
    expect(await screen.findByText("Tag scheme saved.")).toBeInTheDocument();
  });

  it("refuses Save until the new project's scheme has loaded after a workspace switch", async () => {
    let resolveB: (value: { project_id: string; scheme: typeof schemeB }) => void = () => undefined;
    apiMock.getTagScheme.mockImplementation((id: string) => {
      if (id === "p1") return Promise.resolve({ project_id: "p1", scheme: schemeA });
      return new Promise((resolve) => {
        resolveB = resolve;
      });
    });

    const view = render(<TagSchemePanel project={projectA} canWrite />);
    await waitFor(() => expect(screen.getByDisplayValue("9=Project A only")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Save tag scheme" })).toBeEnabled();

    view.rerender(<TagSchemePanel project={projectB} canWrite />);
    expect(screen.getByText("Tag Scheme · Vehicle B")).toBeInTheDocument();
    // Previous project's fields must not remain editable under B's title.
    expect(screen.queryByDisplayValue("9=Project A only")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save tag scheme" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Save tag scheme" }));
    expect(apiMock.updateTagScheme).not.toHaveBeenCalled();

    resolveB({ project_id: "p2", scheme: schemeB });
    await waitFor(() => expect(screen.getByRole("button", { name: "Save tag scheme" })).toBeEnabled());
    expect(screen.getByDisplayValue("2")).toBeInTheDocument();
  });

  it("ignores a late getTagScheme response from the previous project", async () => {
    let resolveA: (value: { project_id: string; scheme: typeof schemeA }) => void = () => undefined;
    apiMock.getTagScheme.mockImplementation((id: string) => {
      if (id === "p1") {
        return new Promise((resolve) => {
          resolveA = resolve;
        });
      }
      return Promise.resolve({ project_id: "p2", scheme: schemeB });
    });

    const view = render(<TagSchemePanel project={projectA} canWrite />);
    await waitFor(() => expect(apiMock.getTagScheme).toHaveBeenCalledWith("p1"));

    view.rerender(<TagSchemePanel project={projectB} canWrite />);
    await waitFor(() => expect(apiMock.getTagScheme).toHaveBeenCalledWith("p2"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Save tag scheme" })).toBeEnabled());
    expect(screen.getByDisplayValue("2")).toBeInTheDocument();

    resolveA({ project_id: "p1", scheme: schemeA });
    // Give the stale response a turn; B's scheme must stay.
    await waitFor(() => expect(screen.getByDisplayValue("2")).toBeInTheDocument());
    expect(screen.queryByDisplayValue("9=Project A only")).not.toBeInTheDocument();
    expect(screen.getByText("Tag Scheme · Vehicle B")).toBeInTheDocument();
  });

  it("binds Save to the project id captured when the form became ready", async () => {
    apiMock.getTagScheme.mockImplementation(async (id: string) =>
      id === "p1" ? { project_id: "p1", scheme: schemeA } : { project_id: "p2", scheme: schemeB }
    );
    apiMock.updateTagScheme.mockResolvedValue({ project_id: "p2", scheme: schemeB });

    const view = render(<TagSchemePanel project={projectA} canWrite />);
    await waitFor(() => expect(screen.getByDisplayValue("9=Project A only")).toBeInTheDocument());

    view.rerender(<TagSchemePanel project={projectB} canWrite />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Save tag scheme" })).toBeEnabled());
    expect(screen.getByDisplayValue("2")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Save tag scheme" }));
    await waitFor(() =>
      expect(apiMock.updateTagScheme).toHaveBeenCalledWith(
        "p2",
        expect.objectContaining({ kind: "simple", sequenceLength: 2, separator: " " })
      )
    );
    expect(apiMock.updateTagScheme).not.toHaveBeenCalledWith("p1", expect.anything());
  });
});
