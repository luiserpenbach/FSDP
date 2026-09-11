import { useEffect, useState, type ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { PanelResizer, useStoredWidth } from "./resizable";

export type NavItem = {
  path: string;
  label: string;
  description: string;
};

/** Sidebar sections, in order; items not listed fall into the last section. */
const NAV_GROUPS: Array<{ title: string; paths: string[] }> = [
  { title: "Workspace", paths: ["/dashboard", "/systems", "/diagrams", "/drafting"] },
  { title: "Data", paths: ["/parts", "/requirements", "/bom"] },
  { title: "Assurance", paths: ["/safety", "/reviews", "/certification"] }
];

const ICON_PROPS = { viewBox: "0 0 20 20", fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };

/** Small monochrome outline icons, keyed by route. */
const NAV_ICONS: Record<string, ReactNode> = {
  "/dashboard": (
    <svg {...ICON_PROPS}>
      <rect x="3" y="3" width="6" height="6" rx="1.2" />
      <rect x="11" y="3" width="6" height="6" rx="1.2" />
      <rect x="3" y="11" width="6" height="6" rx="1.2" />
      <rect x="11" y="11" width="6" height="6" rx="1.2" />
    </svg>
  ),
  "/systems": (
    <svg {...ICON_PROPS}>
      <path d="M10 3 L17 6.5 L10 10 L3 6.5 Z" />
      <path d="M3 10.5 L10 14 L17 10.5" />
      <path d="M3 14 L10 17.5 L17 14" />
    </svg>
  ),
  "/diagrams": (
    <svg {...ICON_PROPS}>
      <rect x="2.5" y="3" width="5" height="4" rx="1" />
      <rect x="12.5" y="3" width="5" height="4" rx="1" />
      <rect x="7.5" y="13" width="5" height="4" rx="1" />
      <path d="M5 7 V10 H15 V7" />
      <path d="M10 10 V13" />
    </svg>
  ),
  "/drafting": (
    <svg {...ICON_PROPS}>
      <path d="M3 17 L13.5 6.5 L16.5 9.5 L6 17 Z" />
      <path d="M13.5 6.5 L15.5 4.5 L18.5 7.5 L16.5 9.5" />
      <path d="M3 17 L4.2 13.8" />
    </svg>
  ),
  "/parts": (
    <svg {...ICON_PROPS}>
      <path d="M3 6.5 L10 3 L17 6.5 V13.5 L10 17 L3 13.5 Z" />
      <path d="M3 6.5 L10 10 L17 6.5" />
      <path d="M10 10 V17" />
    </svg>
  ),
  "/requirements": (
    <svg {...ICON_PROPS}>
      <rect x="4" y="3.5" width="12" height="14" rx="1.5" />
      <path d="M7.5 3.5 V2.5 H12.5 V3.5" />
      <path d="M7 10.5 L9 12.5 L13 8.5" />
    </svg>
  ),
  "/bom": (
    <svg {...ICON_PROPS}>
      <path d="M5 3 H15 V17 L13 15.5 L11 17 L9 15.5 L7 17 L5 15.5 Z" />
      <path d="M8 7 H12" />
      <path d="M8 10 H12" />
    </svg>
  ),
  "/safety": (
    <svg {...ICON_PROPS}>
      <path d="M10 2.5 L16 5 V10 C16 13.5 13.5 16 10 17.5 C6.5 16 4 13.5 4 10 V5 Z" />
      <path d="M7.5 10 L9.3 11.8 L12.8 8.3" />
    </svg>
  ),
  "/reviews": (
    <svg {...ICON_PROPS}>
      <path d="M3.5 5 A1.5 1.5 0 0 1 5 3.5 H15 A1.5 1.5 0 0 1 16.5 5 V12 A1.5 1.5 0 0 1 15 13.5 H9 L5.5 16.5 V13.5 H5 A1.5 1.5 0 0 1 3.5 12 Z" />
      <path d="M7.5 8.5 H12.5" />
    </svg>
  ),
  "/certification": (
    <svg {...ICON_PROPS}>
      <circle cx="10" cy="8" r="4.5" />
      <path d="M7.5 11.8 L6.5 17.5 L10 15.5 L13.5 17.5 L12.5 11.8" />
    </svg>
  ),
  "/settings": (
    <svg {...ICON_PROPS}>
      <circle cx="10" cy="10" r="2.6" />
      <path d="M10 2.8 V4.6 M10 15.4 V17.2 M2.8 10 H4.6 M15.4 10 H17.2 M4.9 4.9 L6.2 6.2 M13.8 13.8 L15.1 15.1 M15.1 4.9 L13.8 6.2 M6.2 13.8 L4.9 15.1" />
    </svg>
  )
};

const FALLBACK_ICON = (
  <svg {...ICON_PROPS}>
    <circle cx="10" cy="10" r="2.2" />
  </svg>
);

/** Amphora mark: a two-handled vessel in a soft rounded tile. */
export function AmphoraMark({ size = 30 }: { size?: number }) {
  return (
    <span className="brandMark" style={{ width: size, height: size }} aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
        <path d="M9 4.5 H15" />
        <path d="M10 4.5 C10 7 8 8 8 11 C8 15.5 9.5 18.5 12 20 C14.5 18.5 16 15.5 16 11 C16 8 14 7 14 4.5" />
        <path d="M8.3 8.5 C5.5 8.5 5 12 8.4 12.6" />
        <path d="M15.7 8.5 C18.5 8.5 19 12 15.6 12.6" />
        <path d="M10 20 H14" />
      </svg>
    </span>
  );
}

export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className={compact ? "brand brandCompact" : "brand"}>
      <AmphoraMark />
      {!compact && (
        <div className="brandText">
          <strong>Amphora</strong>
          <small>Fluid Systems</small>
        </div>
      )}
    </div>
  );
}

/** Initials avatar; hue derived from the email so each person keeps a stable colour. */
export function Avatar({ name, seed, size = 28 }: { name: string; seed: string; size?: number }) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("") || "?";
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) % 360;
  return (
    <span className="avatar" style={{ width: size, height: size, background: `hsl(${hash} 48% 42%)`, fontSize: size * 0.4 }} aria-hidden="true">
      {initials}
    </span>
  );
}

function readCollapsed(): boolean {
  try {
    return localStorage.getItem("fsdp.sidebarCollapsed") === "1";
  } catch {
    return false;
  }
}

export function AppShell({
  children,
  navItems,
  busy,
  message,
  error,
  user,
  onSignOut
}: {
  children: ReactNode;
  navItems: NavItem[];
  busy: boolean;
  message: string;
  error: string;
  user: { name: string; email: string; role: string };
  onSignOut: () => void;
}) {
  const [sidebarWidth, setSidebarWidth] = useStoredWidth("fsdp.sidebarWidth", 236, 200, 360);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  useEffect(() => {
    try {
      localStorage.setItem("fsdp.sidebarCollapsed", collapsed ? "1" : "0");
    } catch {
      /* storage unavailable */
    }
  }, [collapsed]);

  const width = collapsed ? 60 : sidebarWidth;
  const byPath = new Map(navItems.map((item) => [item.path, item]));
  const grouped = NAV_GROUPS.map((group) => ({ ...group, items: group.paths.map((path) => byPath.get(path)).filter((item): item is NavItem => Boolean(item)) }));
  const placed = new Set(NAV_GROUPS.flatMap((group) => group.paths));
  const rest = navItems.filter((item) => !placed.has(item.path) && item.path !== "/settings");
  if (rest.length) grouped[grouped.length - 1].items.push(...rest);
  const settings = byPath.get("/settings");
  const statusText = busy ? "Working…" : error || message;

  return (
    <div className={collapsed ? "appShell sidebarCollapsed" : "appShell"} style={{ gridTemplateColumns: `${width}px minmax(0, 1fr)` }}>
      <aside className="sidebar" aria-label="Sidebar">
        <div className="sidebarTop">
          <Brand compact={collapsed} />
          <button
            type="button"
            className="sidebarToggle"
            onClick={() => setCollapsed((current) => !current)}
            aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}
            aria-expanded={!collapsed}
            title={collapsed ? "Expand navigation" : "Collapse navigation"}
          >
            <svg {...ICON_PROPS}>
              <rect x="3" y="4" width="14" height="12" rx="2" />
              <path d="M8 4 V16" />
            </svg>
          </button>
        </div>
        <nav className="sideNav" aria-label="Primary navigation">
          {grouped.map((group) => (
            <div className="navGroup" key={group.title}>
              {!collapsed && <div className="navGroupTitle">{group.title}</div>}
              {group.items.map((item) => (
                <NavLink
                  className={({ isActive }) => (isActive ? "navItem active" : "navItem")}
                  key={item.path}
                  to={item.path}
                  title={collapsed ? item.label : item.description}
                  aria-label={collapsed ? item.label : undefined}
                >
                  <span className="navIcon">{NAV_ICONS[item.path] ?? FALLBACK_ICON}</span>
                  {!collapsed && <span className="navLabel">{item.label}</span>}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebarFooter">
          {statusText && !collapsed && (
            <div className={error ? "sidebarStatus statusError" : "sidebarStatus"} role="status">
              <span className="statusDot" aria-hidden="true" />
              <span>{statusText}</span>
            </div>
          )}
          <div className="userCard">
            <Avatar name={user.name} seed={user.email} />
            {!collapsed && (
              <div className="userMeta">
                <span className="userName">{user.name}</span>
                <span className="userRole">{user.role}</span>
              </div>
            )}
            {!collapsed && (
              <div className="userActions">
                {settings && (
                  <NavLink className={({ isActive }) => (isActive ? "iconButton active" : "iconButton")} to={settings.path} title={settings.description} aria-label="Settings">
                    {NAV_ICONS["/settings"]}
                  </NavLink>
                )}
                <button className="iconButton" onClick={onSignOut} type="button" title="Sign out" aria-label="Sign out">
                  <svg {...ICON_PROPS}>
                    <path d="M8 3.5 H5 A1.5 1.5 0 0 0 3.5 5 V15 A1.5 1.5 0 0 0 5 16.5 H8" />
                    <path d="M12 6.5 L15.5 10 L12 13.5" />
                    <path d="M15.5 10 H7.5" />
                  </svg>
                </button>
              </div>
            )}
          </div>
          {collapsed && (
            <div className="userActions userActionsRail">
              {settings && (
                <NavLink className={({ isActive }) => (isActive ? "iconButton active" : "iconButton")} to={settings.path} title="Settings" aria-label="Settings">
                  {NAV_ICONS["/settings"]}
                </NavLink>
              )}
              <button className="iconButton" onClick={onSignOut} type="button" title="Sign out" aria-label="Sign out">
                <svg {...ICON_PROPS}>
                  <path d="M8 3.5 H5 A1.5 1.5 0 0 0 3.5 5 V15 A1.5 1.5 0 0 0 5 16.5 H8" />
                  <path d="M12 6.5 L15.5 10 L12 13.5" />
                  <path d="M15.5 10 H7.5" />
                </svg>
              </button>
            </div>
          )}
        </div>
        {!collapsed && <PanelResizer width={sidebarWidth} onResize={setSidebarWidth} direction={1} label="Resize navigation panel" />}
      </aside>

      <div className="appMain">{children}</div>
    </div>
  );
}
