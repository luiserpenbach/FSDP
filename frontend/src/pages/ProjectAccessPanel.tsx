import { useEffect, useState } from "react";
import { api } from "../api";
import { DataTable, FormError, Panel, StatusPill } from "../components/ui";
import type { MemberRole, Project, ProjectAccess, UserDirectoryEntry } from "../types";

const ROLE_LABELS: Record<MemberRole, string> = {
  viewer: "Viewer (read only)",
  engineer: "Engineer (can edit)",
  owner: "Owner (edits and manages access)"
};
const ROLES = Object.keys(ROLE_LABELS) as MemberRole[];

/**
 * Who can see and change the selected project. An open project is visible to every
 * user; a members-only project to its members and administrators.
 */
export function ProjectAccessPanel({ project, onProjectChanged }: { project: Project | null; onProjectChanged: (project: Project) => void }) {
  const [access, setAccess] = useState<ProjectAccess | null>(null);
  const [directory, setDirectory] = useState<UserDirectoryEntry[]>([]);
  const [newUserId, setNewUserId] = useState("");
  const [newRole, setNewRole] = useState<MemberRole>("engineer");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const projectId = project?.id ?? "";

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    api
      .getProjectAccess(projectId)
      .then((next) => {
        if (cancelled) return;
        setAccess(next);
        setError("");
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : "Could not load project access.");
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const shown = access && access.project_id === projectId ? access : null;
  const canManage = Boolean(shown?.can_manage);

  // The user list is only needed, and only allowed, for those who manage access.
  useEffect(() => {
    if (!canManage) return;
    let cancelled = false;
    api
      .userDirectory()
      .then((next) => {
        if (!cancelled) setDirectory(next);
      })
      .catch(() => {
        if (!cancelled) setDirectory([]);
      });
    return () => {
      cancelled = true;
    };
  }, [canManage]);

  if (!project) {
    return (
      <Panel title="Project Access">
        <p className="hint">Select a project to manage who can see it.</p>
      </Panel>
    );
  }

  async function run(action: () => Promise<ProjectAccess>) {
    setBusy(true);
    setError("");
    try {
      setAccess(await action());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Request failed.");
    } finally {
      setBusy(false);
    }
  }

  function setRestricted(restricted: boolean) {
    if (!project) return;
    const prompt = restricted
      ? `Make "${project.name}" members only? Users who are not members will no longer see the project, its drawings, or its tags in search.`
      : `Open "${project.name}" to all users? Every signed-in user will be able to see it.`;
    if (!window.confirm(prompt)) return;
    void run(async () => {
      const next = await api.setProjectRestricted(project.id, restricted);
      onProjectChanged({ ...project, restricted: next.restricted });
      return next;
    });
  }

  function removeMember(userId: string, name: string) {
    if (!project || !window.confirm(`Remove ${name} from "${project.name}"?`)) return;
    void run(async () => {
      await api.removeProjectMember(project.id, userId);
      return api.getProjectAccess(project.id);
    });
  }

  const memberIds = new Set(shown?.members.map((member) => member.user_id));
  const candidates = directory.filter((entry) => !memberIds.has(entry.id));

  return (
    <Panel title={`Project Access · ${project.name}`}>
      {shown ? (
        <>
          <p className="accessState">
            <StatusPill value={shown.restricted ? "members only" : "open"} />
            <span>
              {shown.restricted
                ? "Only the members below and administrators can see this project."
                : "Every signed-in user can see this project, and every engineer can change it."}
            </span>
          </p>
          {canManage ? (
            <button type="button" disabled={busy} onClick={() => setRestricted(!shown.restricted)}>
              {shown.restricted ? "Open to all users" : "Make members only"}
            </button>
          ) : (
            <p className="hint">An owner of the project or an administrator can change this.</p>
          )}
          {(shown.restricted || shown.members.length > 0) && (
            <DataTable
              rows={shown.members}
              getKey={(member) => member.user_id}
              columns={[
                { header: "Name", render: (member) => member.name },
                { header: "Email", render: (member) => <span className="mono">{member.email}</span> },
                {
                  header: "Role",
                  render: (member) =>
                    canManage ? (
                      <select
                        value={member.role}
                        disabled={busy}
                        aria-label={`Role of ${member.name}`}
                        onChange={(event) => void run(() => api.setProjectMember(project.id, member.user_id, event.target.value as MemberRole))}
                      >
                        {ROLES.map((role) => (
                          <option key={role} value={role}>
                            {ROLE_LABELS[role]}
                          </option>
                        ))}
                      </select>
                    ) : (
                      ROLE_LABELS[member.role]
                    )
                },
                {
                  header: "",
                  render: (member) => (
                    <span className="rowActions">
                      {member.account_role === "viewer" && member.role !== "viewer" && <span className="hint" title="This account has the viewer role, which is read-only everywhere.">read-only account</span>}
                      {!member.is_active && <StatusPill value="inactive" />}
                      {canManage && (
                        <button type="button" className="danger" disabled={busy} onClick={() => removeMember(member.user_id, member.name)}>
                          Remove
                        </button>
                      )}
                    </span>
                  )
                }
              ]}
            />
          )}
          {canManage && (
            <form
              className="memberAdd"
              onSubmit={(event) => {
                event.preventDefault();
                if (!newUserId) return;
                void run(async () => {
                  const next = await api.setProjectMember(project.id, newUserId, newRole);
                  setNewUserId("");
                  return next;
                });
              }}
            >
              <label>
                Add member
                <select value={newUserId} onChange={(event) => setNewUserId(event.target.value)}>
                  <option value="">Choose a user…</option>
                  {candidates.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.name} · {entry.email}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Role
                <select value={newRole} onChange={(event) => setNewRole(event.target.value as MemberRole)}>
                  {ROLES.map((role) => (
                    <option key={role} value={role}>
                      {ROLE_LABELS[role]}
                    </option>
                  ))}
                </select>
              </label>
              <button disabled={busy || !newUserId}>Add</button>
            </form>
          )}
        </>
      ) : (
        !error && <p className="hint">Loading…</p>
      )}
      <FormError message={error} />
    </Panel>
  );
}
