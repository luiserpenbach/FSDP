export type User = {
  id: string;
  email: string;
  name: string;
  role: string;
  is_active: boolean;
};

export type ChangeEvent = {
  id: string;
  object_type: string;
  object_id: string;
  action: string;
  summary: string;
  actor?: string | null;
  created_at: string;
};

export type Project = {
  id: string;
  name: string;
  description?: string | null;
  owner?: string | null;
  part_name_prefix?: string | null;
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
  temperature_min_c?: number | null;
  temperature_max_c?: number | null;
  cv?: number | null;
  mass_kg?: number | null;
  qualification_status: string;
  certification_status: string;
  lifecycle_status: string;
  preferred: boolean;
  notes?: string | null;
  completeness?: number;
};

export type CatalogSettings = {
  prefix: string;
  sequence_padding: number;
  next_sequence: number;
  part_types: string[];
};

export type CatalogDocument = {
  id: string;
  part_id: string;
  title: string;
  kind: string;
  original_filename: string;
  content_type: string;
  size_bytes: number;
  source_url?: string | null;
  uploaded_by?: string | null;
  created_at: string;
};

export type PartUsage = {
  components: Array<{
    id: string;
    tag: string;
    quantity: number;
    diagram_id: string;
    diagram_name: string;
    system_id: string;
    system_name: string;
    project_id: string;
    project_name: string;
  }>;
  bom_snapshots: Array<{
    id: string;
    diagram_id: string;
    revision: number;
    status: string;
  }>;
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
};

export type BomSnapshot = {
  id: string;
  diagram_id: string;
  revision: number;
  status: string;
  rows: Array<Record<string, unknown>>;
  created_at?: string;
};

export type ProjectBom = BomSnapshot & { diagram_name: string };

export type BomReadinessIssue = {
  part_number?: string | null;
  component_tags: string[];
  warnings: string[];
};

export type BomReadiness = {
  snapshot_id: string;
  row_count: number;
  issue_count: number;
  ready: boolean;
  issues: BomReadinessIssue[];
};

export type BomDiff = {
  snapshot_id: string;
  against_id: string;
  added: Array<Record<string, unknown>>;
  removed: Array<Record<string, unknown>>;
  changed: Array<{
    part_number?: string | null;
    description?: string | null;
    from_quantity: number;
    to_quantity: number;
  }>;
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

export type SymbolPortSide = "left" | "right" | "top" | "bottom";

export type SymbolPort = {
  id: string;
  x: number;
  y: number;
  side: SymbolPortSide;
};

export type PidSymbolDef = {
  id: string;
  name: string;
  view_box: string;
  svg: string;
  ports: SymbolPort[];
  created_at?: string;
  updated_at?: string;
};
