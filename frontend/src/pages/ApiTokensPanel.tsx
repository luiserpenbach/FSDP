import { useEffect, useState, type FormEvent } from "react";
import { api } from "../api";
import { DataTable, FormError, Panel, Select, TextInput } from "../components/ui";
import type { ApiToken, ApiTokenCreated } from "../types";

const EXPIRY_OPTIONS = [
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "365", label: "1 year" },
  { value: "", label: "No expiry" }
];

function formatDate(value: string | null, fallback: string): string {
  if (!value) return fallback;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date.toLocaleDateString();
}

/**
 * Personal access tokens for scripts and integrations (ERP/PLM sync, reports).
 * A token acts with its owner's role; the secret is shown once, at creation.
 */
export function ApiTokensPanel() {
  const [tokens, setTokens] = useState<ApiToken[]>([]);
  const [name, setName] = useState("");
  const [expiry, setExpiry] = useState("90");
  const [created, setCreated] = useState<ApiTokenCreated | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .listApiTokens()
      .then((next) => {
        if (!cancelled) setTokens(next);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : "Could not load tokens.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Request failed.");
    } finally {
      setBusy(false);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    void run(async () => {
      const token = await api.createApiToken({ name: name.trim(), expires_in_days: expiry ? Number(expiry) : undefined });
      setCreated(token);
      setCopied(false);
      setName("");
      setTokens(await api.listApiTokens());
    });
  }

  function revoke(token: ApiToken) {
    if (!window.confirm(`Revoke the token "${token.name}"? Anything using it stops working immediately.`)) return;
    void run(async () => {
      await api.revokeApiToken(token.id);
      if (created?.id === token.id) setCreated(null);
      setTokens(await api.listApiTokens());
    });
  }

  async function copySecret() {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.token);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <Panel title="API Tokens">
      <p className="hint">
        Tokens let scripts and other systems use the API as you, with your role. Send one as{" "}
        <span className="mono">Authorization: Bearer &lt;token&gt;</span>.
      </p>
      <form onSubmit={submit}>
        <TextInput label="Token name" value={name} onChange={setName} />
        <Select label="Expires" value={expiry} options={EXPIRY_OPTIONS} onChange={setExpiry} />
        <FormError message={error} />
        <button disabled={busy || !name.trim()}>Create token</button>
      </form>
      {created && (
        <div className="tokenSecret" role="status">
          <strong>Copy this token now. It is not shown again.</strong>
          <code className="mono" aria-label="New API token">{created.token}</code>
          <span className="rowActions">
            <button type="button" onClick={() => void copySecret()}>{copied ? "Copied" : "Copy"}</button>
            <button type="button" onClick={() => setCreated(null)}>Done</button>
          </span>
        </div>
      )}
      {tokens.length > 0 && (
        <DataTable
          rows={tokens}
          getKey={(token) => token.id}
          columns={[
            { header: "Name", render: (token) => token.name },
            { header: "Token", render: (token) => <span className="mono">{token.prefix}…</span> },
            { header: "Last used", render: (token) => formatDate(token.last_used_at, "Never") },
            { header: "Expires", render: (token) => formatDate(token.expires_at, "Never") },
            {
              header: "",
              render: (token) => (
                <button type="button" className="danger" disabled={busy} onClick={() => revoke(token)}>
                  Revoke
                </button>
              )
            }
          ]}
        />
      )}
    </Panel>
  );
}
