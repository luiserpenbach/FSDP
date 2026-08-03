import { useState, type FormEvent } from "react";
import { api } from "../api";
import { FormError, TextInput } from "../components/ui";
import type { User } from "../types";

export function LoginPage({ onLogin }: { onLogin: (user: User) => void }) {
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
      <form className="loginCard" onSubmit={submit}>
        <div className="brand">
          <span className="brandMark">F</span>
          <div>
            <strong>FSDP</strong>
            <small>Fluid Systems</small>
          </div>
        </div>
        <h1>Sign in</h1>
        <p className="hint">Use your FSDP account. Ask an administrator if you need one.</p>
        <TextInput label="Email" value={email} onChange={setEmail} />
        <TextInput label="Password" type="password" value={password} onChange={setPassword} />
        <FormError message={error} />
        <button disabled={busy || !email.trim() || !password}>
          {busy ? "Signing in..." : "Sign in"}
        </button>
      </form>
    </div>
  );
}
