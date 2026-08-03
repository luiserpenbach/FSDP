import type { ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { Select } from "./ui";

export type NavItem = {
  path: string;
  label: string;
  description: string;
};

export function Brand() {
  return (
    <div className="brand">
      <span className="brandMark" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M2 12 h4" />
          <path d="M6 8 L12 12 L6 16 Z" />
          <path d="M18 8 L12 12 L18 16 Z" />
          <path d="M18 12 h4" />
        </svg>
      </span>
      <div>
        <strong>FSDP</strong>
        <small>Fluid Systems</small>
      </div>
    </div>
  );
}

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
        <Brand />
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
          </div>
          <div className="statusStack">
            <span className={error ? "status statusError" : "status"}>
              {busy ? "Working…" : error || message}
            </span>
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
