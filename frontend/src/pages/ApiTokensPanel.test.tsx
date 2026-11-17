import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import type { ApiToken } from "../types";
import { ApiTokensPanel } from "./ApiTokensPanel";

const existing: ApiToken = { id: "t1", name: "Nightly BoM export", prefix: "fsdp_pat_abcde", expires_at: null, last_used_at: null, created_at: "2026-11-01T00:00:00Z" };

describe("ApiTokensPanel", () => {
  beforeEach(() => {
    vi.spyOn(api, "listApiTokens").mockResolvedValue([existing]);
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("lists tokens by prefix without their secret", async () => {
    render(<ApiTokensPanel />);
    expect(await screen.findByText("Nightly BoM export")).toBeInTheDocument();
    expect(screen.getByText("fsdp_pat_abcde…")).toBeInTheDocument();
    expect(screen.getAllByText("Never")).toHaveLength(2);
  });

  it("creates a token and shows the secret once", async () => {
    const created = { ...existing, id: "t2", name: "ERP sync", token: "fsdp_pat_secret-value" };
    const create = vi.spyOn(api, "createApiToken").mockResolvedValue(created);
    render(<ApiTokensPanel />);
    await screen.findByText("Nightly BoM export");
    const button = screen.getByRole("button", { name: "Create token" });
    expect(button).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Token name"), { target: { value: " ERP sync " } });
    fireEvent.change(screen.getByLabelText("Expires"), { target: { value: "" } });
    fireEvent.click(button);

    await waitFor(() => expect(create).toHaveBeenCalledWith({ name: "ERP sync", expires_in_days: undefined }));
    expect(await screen.findByLabelText("New API token")).toHaveTextContent("fsdp_pat_secret-value");
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByLabelText("New API token")).toBeNull();
  });

  it("revokes a token after confirmation and reports failures", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValue(true);
    const revoke = vi.spyOn(api, "revokeApiToken").mockRejectedValueOnce(new Error("Token not found")).mockResolvedValue();
    render(<ApiTokensPanel />);
    await screen.findByText("Nightly BoM export");

    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    expect(confirm).toHaveBeenCalled();
    expect(revoke).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    expect(await screen.findByText("Token not found")).toBeInTheDocument();

    vi.mocked(api.listApiTokens).mockResolvedValue([]);
    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(screen.queryByText("Nightly BoM export")).toBeNull());
    expect(revoke).toHaveBeenCalledTimes(2);
  });
});
