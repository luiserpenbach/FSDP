import type { ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { NavGlyph, userInitials } from "./NavIcons";
import { PanelResizer, useStoredWidth } from "./resizable";

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
  busy,
  message,
  error,
  userName,
  userRole,
  onSignOut
}: {
  children: ReactNode;
  navItems: NavItem[];
  busy: boolean;
  message: string;
  error: string;
  userName: string;
  userRole: string;
  onSignOut: () => void;
}) {
  const [sidebarWidth, setSidebarWidth] = useStoredWidth("fsdp.sidebarWidth", 248, 196, 360);
  const statusText = busy ? "Working…" : error || (message !== "Ready" ? message : "");

  return (
    <div className="appShell" style={{ gridTemplateColumns: `${sidebarWidth}px minmax(0, 1fr)` }}>
      <aside className="sidebar">
        <Brand />
        <nav className="sideNav" aria-label="Primary navigation">
          {navItems.map((item) => (
            <NavLink
              className={({ isActive }) => (isActive ? "navItem active" : "navItem")}
              key={item.path}
              to={item.path}
              title={item.description}
            >
              <NavGlyph path={item.path} />
              <span>{item.label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="sidebarFooter">
          {statusText ? (
            <span className={error ? "sidebarStatus isError" : "sidebarStatus"}>{statusText}</span>
          ) : null}
          <div className="sidebarUser">
            <span className="userAvatar" aria-hidden="true">
              {userInitials(userName)}
            </span>
            <div className="userMeta">
              <span className="userName">{userName}</span>
              <span className="userRole">{userRole}</span>
            </div>
            <button className="signOut" onClick={onSignOut} type="button">
              Sign out
            </button>
          </div>
        </div>
        <PanelResizer width={sidebarWidth} onResize={setSidebarWidth} direction={1} label="Resize navigation panel" />
      </aside>

      <div className="appMain">{children}</div>
    </div>
  );
}
