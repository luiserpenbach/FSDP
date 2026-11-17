import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SSO_LOGIN_URL, api } from "../api";
import { LoginPage } from "./LoginPage";

describe("LoginPage single sign-on", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    window.history.replaceState(null, "", "/");
  });

  it("offers only a password when single sign-on is off or the server does not say", async () => {
    const config = vi.spyOn(api, "authConfig").mockRejectedValue(new Error("Not Found"));
    render(<LoginPage onLogin={() => {}} />);
    await waitFor(() => expect(config).toHaveBeenCalled());
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
  });

  it("links to the provider with the configured label", async () => {
    vi.spyOn(api, "authConfig").mockResolvedValue({ sso_enabled: true, sso_label: "Sign in with Okta", password_login_enabled: false });
    render(<LoginPage onLogin={() => {}} />);
    const link = await screen.findByRole("link", { name: "Sign in with Okta" });
    expect(link.getAttribute("href")).toBe(SSO_LOGIN_URL);
    expect(screen.getByText("administrators can use a password")).toBeInTheDocument();
  });

  it("shows why a single sign-on failed and cleans the address", async () => {
    vi.spyOn(api, "authConfig").mockResolvedValue({ sso_enabled: true, sso_label: "Sign in with SSO", password_login_enabled: true });
    window.history.replaceState(null, "", "/?sso_error=Your+email+domain+is+not+allowed+to+sign+in+here.");
    render(<LoginPage onLogin={() => {}} />);
    expect(await screen.findByText("Your email domain is not allowed to sign in here.")).toBeInTheDocument();
    expect(window.location.search).toBe("");
  });
});
