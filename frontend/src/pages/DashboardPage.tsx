import { SummaryCard } from "../components/ui";
import { useWorkspace } from "../workspace/WorkspaceContext";
import { PageLayout } from "./PageLayout";

/** Project overview. */
export function DashboardPage() {
  const { projects, selectedProject, systems, selectedSystem, diagrams, selectedDiagramId, parts, requirements } = useWorkspace();
  const selectedDiagram = diagrams.find((diagram) => diagram.id === selectedDiagramId) ?? null;
  return (
    <PageLayout title="Dashboard" description="Project overview">
      <section className="grid">
        <SummaryCard title="Projects" value={projects.length} detail={selectedProject ? `Working in ${selectedProject.name}` : "None selected"} />
        <SummaryCard title="Systems" value={systems.length} detail={selectedSystem?.name ?? "None selected"} />
        <SummaryCard title="Diagrams" value={diagrams.length} detail={selectedDiagram?.name ?? "None open"} />
        <SummaryCard title="Catalog Parts" value={parts.length} detail={`${parts.length} in the catalog`} />
        <SummaryCard title="Requirements" value={requirements.length} detail={`${requirements.length} in this project`} />
      </section>
    </PageLayout>
  );
}
