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
