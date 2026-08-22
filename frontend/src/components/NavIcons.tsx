import type { ReactNode } from "react";

const ICONS: Record<string, ReactNode> = {
  dashboard: (
    <>
      <rect x="4" y="4" width="7" height="7" rx="1.4" />
      <rect x="13" y="4" width="7" height="7" rx="1.4" />
      <rect x="4" y="13" width="7" height="7" rx="1.4" />
      <rect x="13" y="13" width="7" height="7" rx="1.4" />
    </>
  ),
  systems: (
    <>
      <path d="M5 8.5 L12 5 L19 8.5 L12 12 Z" />
      <path d="M5 12.5 L12 16 L19 12.5" />
      <path d="M5 16 L12 19.5 L19 16" />
    </>
  ),
  diagrams: (
    <>
      <circle cx="6.5" cy="7" r="2.2" />
      <circle cx="17.5" cy="7" r="2.2" />
      <circle cx="12" cy="17.5" r="2.2" />
      <path d="M8.4 8.4 L10.4 15.4" />
      <path d="M15.6 8.4 L13.6 15.4" />
    </>
  ),
  parts: (
    <>
      <path d="M12 4 L19 8 V16 L12 20 L5 16 V8 Z" />
      <path d="M12 20 V12" />
      <path d="M5 8 L12 12 L19 8" />
    </>
  ),
  requirements: (
    <>
      <path d="M8 5 H16 A2 2 0 0 1 18 7 V18 A2 2 0 0 1 16 20 H8 A2 2 0 0 1 6 18 V7 A2 2 0 0 1 8 5 Z" />
      <path d="M9 10 H15" />
      <path d="M9 13.5 H15" />
      <path d="M9 17 H13" />
    </>
  ),
  bom: (
    <>
      <path d="M5 6 H19 V18 H5 Z" />
      <path d="M5 10 H19" />
      <path d="M10 6 V18" />
    </>
  ),
  safety: <path d="M12 4 L19 7 V12 C19 16.5 15.8 19.4 12 20.5 C8.2 19.4 5 16.5 5 12 V7 Z" />,
  reviews: (
    <>
      <path d="M6 16.5 V8 A3 3 0 0 1 9 5 H15 A3 3 0 0 1 18 8 V13 A3 3 0 0 1 15 16 H10 L6 19.5 Z" />
    </>
  ),
  certification: (
    <>
      <circle cx="12" cy="10" r="5" />
      <path d="M9.2 14.4 L8 20 L12 17.8 L16 20 L14.8 14.4" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 5 V7.2 M12 16.8 V19 M5 12 H7.2 M16.8 12 H19 M7.1 7.1 L8.6 8.6 M15.4 15.4 L16.9 16.9 M16.9 7.1 L15.4 8.6 M8.6 15.4 L7.1 16.9" />
    </>
  )
};

const PATH_ICONS: Record<string, string> = {
  "/dashboard": "dashboard",
  "/systems": "systems",
  "/diagrams": "diagrams",
  "/parts": "parts",
  "/requirements": "requirements",
  "/bom": "bom",
  "/safety": "safety",
  "/reviews": "reviews",
  "/certification": "certification",
  "/settings": "settings"
};

export function NavGlyph({ path }: { path: string }) {
  const icon = ICONS[PATH_ICONS[path] ?? ""] ?? ICONS.dashboard;
  return (
    <svg
      className="navGlyph"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {icon}
    </svg>
  );
}

export function userInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0]![0] ?? ""}${parts[parts.length - 1]![0] ?? ""}`.toUpperCase();
  }
  return name.slice(0, 2).toUpperCase() || "?";
}
