import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import type { Project, ProjectAccess } from "../types";
import { ProjectAccessPanel } from "./ProjectAccessPanel";

const project = { id: "p1", name: "Ship 31", restricted: false } as Project;
const lead = { user_id: "u1", email: "lead@fsdp.test", name: "Lead", role: "owner" as const, account_role: "engineer", is_active: true };
const watcher = { user_id: "u2", email: "watch@fsdp.test", name: "Watcher", role: "engineer" as const, account_role: "viewer", is_active: true };

function access(patch: Partial<ProjectAccess> = {}): ProjectAccess {
  return { project_id: "p1", restricted: false, members: [lead], can_manage: true, can_write: true, ...patch };
}

describe("ProjectAccessPanel", () => {
  beforeEach(() => {
    vi.spyOn(api, "userDirectory").mockResolvedValue([
      { id: "u1", email: "lead@fsdp.test", name: "Lead", role: "engineer" },
      { id: "u3", email: "new@fsdp.test", name: "Newcomer", role: "engineer" }
    ]);
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("asks for a project when none is selected", () => {
    render(<ProjectAccessPanel project={null} onProjectChanged={() => {}} />);
    expect(screen.getByText("Select a project to manage who can see it.")).toBeInTheDocument();
  });

  it("makes a project members only after confirmation and tells the workspace", async () => {
    vi.spyOn(api, "getProjectAccess").mockResolvedValue(access());
    const restrict = vi.spyOn(api, "setProjectRestricted").mockResolvedValue(access({ restricted: true }));
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValue(true);
    const onProjectChanged = vi.fn();
    render(<ProjectAccessPanel project={project} onProjectChanged={onProjectChanged} />);

    const button = await screen.findByRole("button", { name: "Make members only" });
    expect(screen.getByText(/Every signed-in user can see this project/)).toBeInTheDocument();
    fireEvent.click(button);
    expect(confirm.mock.calls[0][0]).toContain("will no longer see the project");
    expect(restrict).not.toHaveBeenCalled();

    fireEvent.click(button);
    await waitFor(() => expect(restrict).toHaveBeenCalledWith("p1", true));
    expect(await screen.findByRole("button", { name: "Open to all users" })).toBeInTheDocument();
    expect(onProjectChanged).toHaveBeenCalledWith({ ...project, restricted: true });
  });

  it("adds, re-roles, and removes members, offering only users who are not members yet", async () => {
    vi.spyOn(api, "getProjectAccess").mockResolvedValue(access({ restricted: true, members: [lead, watcher] }));
    const setMember = vi.spyOn(api, "setProjectMember").mockResolvedValue(access({ restricted: true, members: [lead, watcher] }));
    const remove = vi.spyOn(api, "removeProjectMember").mockResolvedValue();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<ProjectAccessPanel project={{ ...project, restricted: true }} onProjectChanged={() => {}} />);

    // A viewer account stays read-only even as an engineer member; say so.
    expect(await screen.findByText("read-only account")).toBeInTheDocument();
    const picker = screen.getByLabelText("Add member") as HTMLSelectElement;
    await waitFor(() => expect(Array.from(picker.options).map((option) => option.textContent)).toEqual(["Choose a user…", "Newcomer · new@fsdp.test"]));
    expect(screen.getByRole("button", { name: "Add" })).toBeDisabled();

    fireEvent.change(picker, { target: { value: "u3" } });
    fireEvent.change(screen.getByLabelText("Role"), { target: { value: "viewer" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(setMember).toHaveBeenCalledWith("p1", "u3", "viewer"));

    fireEvent.change(screen.getByLabelText("Role of Watcher"), { target: { value: "viewer" } });
    await waitFor(() => expect(setMember).toHaveBeenCalledWith("p1", "u2", "viewer"));

    fireEvent.click(screen.getAllByRole("button", { name: "Remove" })[1]);
    await waitFor(() => expect(remove).toHaveBeenCalledWith("p1", "u2"));
  });

  it("is read-only for members who cannot manage access and reports refusals", async () => {
    vi.spyOn(api, "getProjectAccess").mockResolvedValue(access({ restricted: true, can_manage: false }));
    render(<ProjectAccessPanel project={{ ...project, restricted: true }} onProjectChanged={() => {}} />);
    expect(await screen.findByText("An owner of the project or an administrator can change this.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open to all users" })).toBeNull();
    expect(screen.queryByLabelText("Add member")).toBeNull();
    expect(screen.getByText("Owner (edits and manages access)")).toBeInTheDocument();
    expect(api.userDirectory).not.toHaveBeenCalled();
  });

  it("shows why access could not be loaded", async () => {
    vi.spyOn(api, "getProjectAccess").mockRejectedValue(new Error("Project not found"));
    render(<ProjectAccessPanel project={project} onProjectChanged={() => {}} />);
    expect(await screen.findByText("Project not found")).toBeInTheDocument();
  });
});
