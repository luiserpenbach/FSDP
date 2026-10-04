import { useState, type FormEvent } from "react";
import { api } from "../api";
import { Brand } from "../components/AppShell";
import { FormError, TextInput } from "../components/ui";
import type { User } from "../types";

/** `notice` replaces the default hint, e.g. to explain an expired session. */
export function LoginPage({ onLogin, notice }: { onLogin: (user: User) => void; notice?: string }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

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
