import type { ReactNode } from "react";

/** Slim one-line page bar: small title + muted context, no hero header. */
export function PageLayout({
  title,
  description,
  className = "",
  children
}: {
  title: string;
  description: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <main className={`page ${className}`.trim()}>
      <header className="pageHeader">
        <h1>{title}</h1>
        <p>{description}</p>
      </header>
      {children}
    </main>
  );
}

/** Placeholder body for planned features; embeddable inside another page's grid. */
export function PlaceholderCard({ title, body }: { title: string; body: string }) {
  return (
    <section className="workspace placeholder">
      <h2>{title}</h2>
      <p>{body}</p>
    </section>
  );
}

export function PlaceholderPage({ title, body }: { title: string; body: string }) {
  return (
    <PageLayout title={title} description="Planned workspace">
      <PlaceholderCard title={title} body={body} />
    </PageLayout>
  );
}
