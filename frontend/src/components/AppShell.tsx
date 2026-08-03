import type { ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { Select } from "./ui";

export type NavItem = {
  path: string;
  label: string;
  description: string;
};

export function AppShell({
  children,
  navItems,
  projectValue,
  projectOptions,
  onProjectChange,
  systemValue,
  systemOptions,
  onSystemChange,
  busy,
  message,
  error,
  userLabel,
  onSignOut
}: {
  children: ReactNode;
  navItems: NavItem[];
  projectValue: string;
  projectOptions: Array<{ value: string; label: string }>;
  onProjectChange: (value: string) => void;
  systemValue: string;
  systemOptions: Array<{ value: string; label: string }>;
  onSystemChange: (value: string) => void;
  busy: boolean;
  message: string;
  error: string;
  userLabel: string;
  onSignOut: () => void;
}) {
  return (
    <div className="appShell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brandMark">F</span>
          <div>
            <strong>FSDP</strong>
            <small>Fluid Systems</small>
          </div>
        </div>
        <nav className="sideNav" aria-label="Primary navigation">
          {navItems.map((item) => (
            <NavLink className={({ isActive }) => (isActive ? "navItem active" : "navItem")} key={item.path} to={item.path}>
              <span>{item.label}</span>
              <small>{item.description}</small>
            </NavLink>
          ))}
        </nav>
      </aside>

      <div className="appMain">
        <header className="topBar">
          <div className="contextSelectors">
            <Select label="Project" value={projectValue} options={projectOptions} onChange={onProjectChange} />
            <Select label="System" value={systemValue} options={systemOptions} onChange={onSystemChange} />
            <div className="searchBox">Search parts, requirements, diagrams...</div>
          </div>
          <div className="statusStack">
            <span className="status">{busy ? "Working..." : message}</span>
            {error && <span className="error">{error}</span>}
          </div>
          <div className="userBox">
            <span className="userLabel">{userLabel}</span>
            <button className="signOut" onClick={onSignOut} type="button">Sign out</button>
          </div>
        </header>
        {children}
      </div>
    </div>
  );
}
