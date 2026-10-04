import { useEffect, useState, type FormEvent } from "react";
import { api } from "../api";
import { DataTable, FormError, Panel, Select, StatusPill, TextInput } from "../components/ui";
import type { User } from "../types";
import { useWorkspace } from "../workspace/WorkspaceContext";
import { CatalogSettingsPanel } from "./CatalogSettingsPanel";
import { LineClassPanel } from "./LineClassPanel";
import { PageLayout } from "./PageLayout";
import { TagSchemePanel } from "./TagSchemePanel";

const roleOptions = ["engineer", "viewer", "admin"].map((value) => ({ value, label: value }));

/** Accounts (admins), catalog settings, and the selected project's tag scheme and line classes. */
export function SettingsPage() {
  const { user, isAdmin, canWrite, busy, formErrors, runAction, selectedProject, replaceProject } = useWorkspace();
  const [users, setUsers] = useState<User[]>([]);
  const [userForm, setUserForm] = useState({ email: "", name: "", password: "", role: "engineer" });

  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    api
      .listUsers()
      .then((next) => {
        if (!cancelled) setUsers(next);
      })
      .catch(() => {
        if (!cancelled) setUsers([]);
      });
    return () => {
      cancelled = true;
    };
  }, [isAdmin]);

  function submitUser(event: FormEvent) {
    event.preventDefault();
    void runAction("Created user.", async () => {
      await api.createUser(userForm);
      setUsers(await api.listUsers());
      setUserForm({ email: "", name: "", password: "", role: "engineer" });
    }, "user");
  }

  function updateUserAccount(userId: string, changes: { role?: string; is_active?: boolean }) {
    void runAction("Updated user.", async () => {
      await api.updateUser(userId, changes);
      setUsers(await api.listUsers());
    }, "user");
  }

  return (
    <PageLayout title="Settings" description="Accounts and configuration">
      <section className="grid">
        {isAdmin ? (
          <>
            <Panel title="Create User">
              <form onSubmit={submitUser}>
                <TextInput label="Email" value={userForm.email} onChange={(email) => setUserForm({ ...userForm, email })} />
                <TextInput label="Name" value={userForm.name} onChange={(name) => setUserForm({ ...userForm, name })} />
                <TextInput label="Password" type="password" value={userForm.password} onChange={(password) => setUserForm({ ...userForm, password })} />
                <Select label="Role" value={userForm.role} options={roleOptions} onChange={(role) => setUserForm({ ...userForm, role })} />
                <FormError message={formErrors.user} />
                <button disabled={busy || !userForm.email || !userForm.name || userForm.password.length < 8}>Create user</button>
              </form>
              <p className="hint">Passwords need at least 8 characters. Viewers are read-only.</p>
            </Panel>
            <Panel title="Users">
              <DataTable
                rows={users}
                getKey={(account) => account.id}
                columns={[
                  { header: "Email", render: (account) => <span className="mono">{account.email}</span> },
                  { header: "Name", render: (account) => account.name },
                  { header: "Role", render: (account) => <StatusPill value={account.role} /> },
                  { header: "Status", render: (account) => <StatusPill value={account.is_active ? "active" : "inactive"} /> },
                  {
                    header: "",
                    render: (account) => (
                      <span className="rowActions">
                        <select value={account.role} onChange={(event) => updateUserAccount(account.id, { role: event.target.value })} disabled={busy || account.id === user.id}>
                          {roleOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                        </select>
                        {account.is_active
                          ? <button className="danger" disabled={busy || account.id === user.id} onClick={() => updateUserAccount(account.id, { is_active: false })}>Deactivate</button>
                          : <button disabled={busy} onClick={() => updateUserAccount(account.id, { is_active: true })}>Activate</button>}
                      </span>
                    )
                  }
                ]}
              />
            </Panel>
          </>
        ) : (
          <Panel title="Accounts">
            <p className="hint">You are signed in as {user.email} ({user.role}). Ask an administrator to manage accounts.</p>
          </Panel>
        )}
        <CatalogSettingsPanel project={selectedProject} isAdmin={isAdmin} onProjectUpdated={replaceProject} />
        <TagSchemePanel project={selectedProject} canWrite={canWrite} />
        <LineClassPanel project={selectedProject} canWrite={canWrite} />
      </section>
    </PageLayout>
  );
}
