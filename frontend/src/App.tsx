import { Suspense, lazy, useEffect, useState } from "react";
import { Navigate, Route, RouterProvider, Routes, createBrowserRouter, useBlocker } from "react-router-dom";
import { api, setUnauthorizedHandler } from "./api";
import { AppShell, type NavItem } from "./components/AppShell";
import { DashboardPage } from "./pages/DashboardPage";
import { LoginPage } from "./pages/LoginPage";
import type { User } from "./types";
import { UnsavedChangesContext, createUnsavedChangesRegistry, unsavedPrompt, useUnsavedChangesRegistry } from "./unsavedChanges";
import { WorkspaceProvider, useWorkspace } from "./workspace/WorkspaceContext";
import { WorkspaceSwitcher } from "./workspace/WorkspaceSwitcher";

// Route pages load on first visit; the dashboard (the landing page) ships in the main chunk.
const SystemsPage = lazy(() => import("./pages/SystemsPage").then((module) => ({ default: module.SystemsPage })));
const DiagramsPage = lazy(() => import("./pages/DiagramsPage").then((module) => ({ default: module.DiagramsPage })));
const DraftingPage = lazy(() => import("./pages/DraftingPage").then((module) => ({ default: module.DraftingRoutePage })));
const PartsPage = lazy(() => import("./pages/PartsCatalog").then((module) => ({ default: module.PartsPage })));
const RequirementsPage = lazy(() => import("./pages/RequirementsPage").then((module) => ({ default: module.RequirementsPage })));
const BomPage = lazy(() => import("./pages/BomPage").then((module) => ({ default: module.BomPage })));
const ReviewsPage = lazy(() => import("./pages/ReviewsPage").then((module) => ({ default: module.ReviewsPage })));
const SettingsPage = lazy(() => import("./pages/SettingsPage").then((module) => ({ default: module.SettingsPage })));

const navItems: NavItem[] = [
  { path: "/dashboard", label: "Dashboard", description: "Project overview" },
  { path: "/systems", label: "Systems", description: "Projects and fluid systems" },
  { path: "/diagrams", label: "Diagrams", description: "P&ID workspace" },
  { path: "/drafting", label: "Drafting", description: "Paper-space P&ID drawings" },
  { path: "/parts", label: "Parts Catalog", description: "Internal and vendor parts" },
  { path: "/requirements", label: "Requirements", description: "Traceable requirements" },
  { path: "/bom", label: "BoM & Procurement", description: "Snapshots and exports" },
  { path: "/reviews", label: "Reviews", description: "Impact and approvals" },
  { path: "/settings", label: "Settings", description: "Project configuration" }
];

export type AppRouter = ReturnType<typeof createBrowserRouter>;

/**
 * A data router, so the workspace can block in-app navigation (useBlocker)
 * while an editor holds unsaved work; the workspace's own <Routes> render
 * under the catch-all route.
 */
export function createAppRouter(): AppRouter {
  return createBrowserRouter([{ path: "*", element: <AuthGate /> }]);
}

export function App({ router }: { router?: AppRouter }) {
  const [appRouter] = useState(() => router ?? createAppRouter());
  return <RouterProvider router={appRouter} />;
}

function AuthGate() {
  const [user, setUser] = useState<User | null>(null);
  const [checkingSession, setCheckingSession] = useState(true);
  // A 401 mid-session shows the login form over the still-mounted workspace,
  // so signing in again keeps unsaved drafting and diagram edits.
  const [sessionExpired, setSessionExpired] = useState(false);
  const [unsaved] = useState(createUnsavedChangesRegistry);

  useEffect(() => {
    setUnauthorizedHandler(() => setSessionExpired(true));
    api
      .me()
      .then(setUser)
      .catch(() => setUser(null))
      .finally(() => setCheckingSession(false));
    return () => setUnauthorizedHandler(null);
  }, []);

  function signIn(next: User) {
    setSessionExpired(false);
    setUser(next);
  }

  async function signOut() {
    const pending = unsaved.pending();
    if (pending.length && !window.confirm(unsavedPrompt(pending, "Sign out"))) return;
    try {
      await api.logout();
    } finally {
      setSessionExpired(false);
      setUser(null);
    }
  }

  if (checkingSession) {
    return (
      <div className="authScreen">
        <p className="hint">Checking session...</p>
      </div>
    );
  }
  if (!user) {
    return <LoginPage onLogin={signIn} />;
  }
  return (
    <UnsavedChangesContext.Provider value={unsaved}>
      {/* Keyed by account: signing back in as someone else starts a fresh workspace. */}
      <div inert={sessionExpired}>
        <WorkspaceProvider key={user.id} user={user}>
          <Workspace onSignOut={() => void signOut()} />
        </WorkspaceProvider>
      </div>
      {sessionExpired && (
        <div className="sessionExpiredOverlay" role="dialog" aria-modal="true" aria-label="Session expired">
          <LoginPage
            onLogin={signIn}
            notice="Your session has expired. Sign in again to continue; unsaved work is kept."
          />
        </div>
      )}
    </UnsavedChangesContext.Provider>
  );
}

/** Ask before in-app navigation discards work in an editor that unmounts with its page. */
function UnsavedNavigationGuard() {
  const unsaved = useUnsavedChangesRegistry();
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      currentLocation.pathname !== nextLocation.pathname && unsaved.pending({ routeScoped: true }).length > 0
  );
  useEffect(() => {
    if (blocker.state !== "blocked") return;
    const pending = unsaved.pending({ routeScoped: true });
    if (!pending.length || window.confirm(unsavedPrompt(pending, "Leave this page"))) blocker.proceed();
    else blocker.reset();
  }, [blocker, unsaved]);
  return null;
}

function Workspace({ onSignOut }: { onSignOut: () => void }) {
  const { user, busy, message, error } = useWorkspace();
  return (
    <AppShell
      navItems={navItems}
      busy={busy}
      message={message}
      error={error}
      user={user}
      onSignOut={onSignOut}
      switcher={(collapsed, expand) => <WorkspaceSwitcher collapsed={collapsed} onExpand={expand} />}
    >
      <UnsavedNavigationGuard />
      <Suspense fallback={<main className="page"><p className="hint">Loading…</p></main>}>
        <Routes>
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/systems" element={<SystemsPage />} />
          <Route path="/diagrams" element={<DiagramsPage />} />
          <Route path="/drafting" element={<DraftingPage />} />
          <Route path="/parts" element={<PartsPage />} />
          <Route path="/requirements" element={<RequirementsPage />} />
          <Route path="/bom" element={<BomPage />} />
          <Route path="/reviews" element={<ReviewsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
      </Suspense>
    </AppShell>
  );
}
