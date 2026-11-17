import { useEffect, useState, type FormEvent } from "react";
import { SSO_LOGIN_URL, api } from "../api";
import { Brand } from "../components/AppShell";
import { FormError, TextInput } from "../components/ui";
import type { AuthConfig, User } from "../types";

/** `notice` replaces the default hint, e.g. to explain an expired session. */
export function LoginPage({ onLogin, notice }: { onLogin: (user: User) => void; notice?: string }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  // A failed single sign-on comes back as /?sso_error=...; show it once and clean the URL.
  const [error, setError] = useState(() => new URLSearchParams(window.location.search).get("sso_error") ?? "");
  const [busy, setBusy] = useState(false);
  const [config, setConfig] = useState<AuthConfig | null>(null);

  useEffect(() => {
    if (new URLSearchParams(window.location.search).has("sso_error")) {
      window.history.replaceState(null, "", window.location.pathname);
    }
    let cancelled = false;
    api
      .authConfig()
      .then((next) => {
        if (!cancelled) setConfig(next);
      })
      .catch(() => {
        // Older servers have no config endpoint: password sign-in only.
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const sso = Boolean(config?.sso_enabled);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      onLogin(await api.login(email, password));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Login failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="authScreen">
      <div className="loginPanel">
        <form className="loginCard" onSubmit={submit}>
          <Brand />
          <h1>Sign in</h1>
          <p className="hint">{notice ?? "Use your FSDP account. Ask an administrator if you need one."}</p>
          {sso && (
            <>
              <a className="ssoButton" href={SSO_LOGIN_URL}>
                {config?.sso_label || "Sign in with SSO"}
              </a>
              <p className="loginDivider">
                <span>{config?.password_login_enabled ? "or use a password" : "administrators can use a password"}</span>
              </p>
            </>
          )}
          <TextInput label="Email" value={email} onChange={setEmail} />
          <TextInput label="Password" type="password" value={password} onChange={setPassword} />
          <FormError message={error} />
          <button disabled={busy || !email.trim() || !password}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>
        <p className="loginFootnote">Fluid Systems Development Platform · connected engineering data</p>
      </div>
    </div>
  );
}
