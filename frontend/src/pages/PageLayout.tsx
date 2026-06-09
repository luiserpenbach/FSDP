import type { ReactNode } from "react";

export function PageLayout({
  eyebrow = "Fluid Systems Development Platform",
  title,
  description,
  className = "",
  children
}: {
  eyebrow?: string;
  title: string;
  description: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <main className={`page ${className}`.trim()}>
      <header className="pageHeader">
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        <p>{description}</p>
      </header>
      {children}
    </main>
  );
}

export function PlaceholderPage({ title, body }: { title: string; body: string }) {
  return (
    <PageLayout title={title} description="Planned workspace">
      <section className="workspace placeholder">
        <p className="eyebrow">Planned Workspace</p>
        <h2>{title}</h2>
        <p>{body}</p>
      </section>
    </PageLayout>
  );
}
