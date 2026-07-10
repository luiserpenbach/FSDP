export type Project = {
  id: string;
  name: string;
  description?: string | null;
  owner?: string | null;
};

export type FluidSystem = {
  id: string;
  project_id: string;
  name: string;
  fluid?: string | null;
  description?: string | null;
};

export type Part = {
  id: string;
  part_number: string;
  revision?: string | null;
  description: string;
  manufacturer?: string | null;
  part_type: string;
  source_type: string;
  material?: string | null;
  pressure_rating_bar?: number | null;
  qualification_status: string;
  certification_status: string;
  lifecycle_status: string;
  family_id?: string | null;
  replacement_part_id?: string | null;
};

export type PartFamily = {
  id: string;
  name: string;
  description?: string | null;
  part_type: string;
  template_properties: Record<string, unknown>;
};

export type PartRevision = {
  id: string;
  part_id: string;
  revision_label?: string | null;
  change_summary: string;
  snapshot: Record<string, unknown>;
  created_at: string;
};

export type PartAttachment = {
  id: string;
  part_id: string;
  filename: string;
  attachment_type: string;
  mime_type?: string | null;
  size_bytes?: number | null;
  content_base64?: string | null;
};

export type PartWhereUsed = {
  part_id: string;
  components: Array<{ component_id: string; tag: string; diagram_id: string; quantity: number }>;
  diagrams: Array<{
    diagram_id: string;
    diagram_name: string;
    system_name?: string | null;
    project_name?: string | null;
    component_tags: string[];
  }>;
  bom_snapshots: Array<{
    snapshot_id: string;
    diagram_id: string;
    diagram_name?: string | null;
    revision: number;
    quantity?: number;
  }>;
  requirements: Array<{
    requirement_id: string;
    key: string;
    title: string;
    link_type: string;
  }>;
};

export type PartCompare = {
  left: Part;
  right: Part;
  differences: Array<{ field: string; left: unknown; right: unknown }>;
};

export type PartImportResult = {
  created: number;
  updated: number;
  skipped: number;
  errors: string[];
};

export type Diagram = {
  id: string;
  system_id: string;
  name: string;
  diagram_type: string;
  revision: number;
  graph: {
    nodes?: import("reactflow").Node[];
    edges?: import("reactflow").Edge[];
  };
};

export type ComponentInstance = {
  id: string;
  diagram_id: string;
  node_id?: string | null;
  part_id?: string | null;
  tag: string;
  quantity: number;
  properties?: Record<string, unknown>;
};

export type Requirement = {
  id: string;
  project_id: string;
  key: string;
  title: string;
  text: string;
  requirement_type: string;
  verification_method?: string | null;
  status: string;
  owner?: string | null;
  lifecycle_status: string;
  verification_status: string;
  set_id?: string | null;
  superseded_by_requirement_id?: string | null;
  created_at?: string;
  updated_at?: string;
};

export type RequirementSet = {
  id: string;
  project_id: string;
  name: string;
  description?: string | null;
  requirement_type: string;
  default_verification_method?: string | null;
  template_text?: string | null;
  template_properties: Record<string, unknown>;
};

export type RequirementRevision = {
  id: string;
  requirement_id: string;
  revision_label?: string | null;
  change_summary: string;
  snapshot: Record<string, unknown>;
  created_at: string;
};

export type RequirementAttachment = {
  id: string;
  requirement_id: string;
  filename: string;
  attachment_type: string;
  mime_type?: string | null;
  size_bytes?: number | null;
  content_base64?: string | null;
};

export type RequirementCompare = {
  left: Requirement;
  right: Requirement;
  differences: Array<{ field: string; left: unknown; right: unknown }>;
};

export type RequirementImportResult = {
  created: number;
  updated: number;
  skipped: number;
  errors: string[];
};

export type RequirementVerificationMatrixRow = {
  requirement_id: string;
  key: string;
  title: string;
  requirement_type: string;
  verification_method?: string | null;
  status: string;
  verification_status: string;
  verification_display: string;
  link_count: number;
  evidence_count: number;
  linked_components: string[];
  lifecycle_status: string;
};

export type TraceableComponent = {
  component_id: string;
  tag: string;
  diagram_id: string;
  diagram_name: string;
  system_name: string;
  part_number?: string | null;
};

export type RequirementTraceability = {
  requirement_id: string;
  links: Array<{
    id: string;
    source_type: string;
    source_id: string;
    target_type: string;
    target_id: string;
    link_type: string;
    rationale?: string | null;
  }>;
  components: Array<{ component_id: string; tag: string; diagram_id: string; quantity: number }>;
  diagrams: Array<{
    diagram_id: string;
    diagram_name: string;
    system_name?: string | null;
    project_name?: string | null;
    component_tags: string[];
  }>;
  parts: Array<{ part_id: string; part_number: string; description: string }>;
};

export type BomSnapshot = {
  id: string;
  diagram_id: string;
  revision: number;
  status: string;
  rows: Array<Record<string, unknown>>;
};

export type TraceLink = {
  id: string;
  source_type: string;
  source_id: string;
  target_type: string;
  target_id: string;
  link_type: string;
  rationale?: string | null;
};

export type Impact = {
  object_type: string;
  object_id: string;
  direct_links: TraceLink[];
  affected_bom_snapshots: BomSnapshot[];
  affected_components: ComponentInstance[];
};
