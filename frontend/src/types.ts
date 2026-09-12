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
  drawing_items: Array<{
    sheet_id: string;
    item_id: string;
    tag: string | null;
    zone: string | null;
    dnp: boolean;
    drawing_id: string;
    drawing_number: string;
    drawing_title: string;
    sheet_no: number;
    project_id: string;
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

export type DrawingRevision = {
  id: string;
  drawing_id: string;
  sequence: number;
  label: string;
  description: string;
  status: string;
  drawn_by: string | null;
  drawn_date: string | null;
  checked_by: string | null;
  checked_date: string | null;
  approved_by: string | null;
  approved_date: string | null;
  created_at: string;
};

export type DrawingSheetSummary = {
  id: string;
  sheet_no: number;
  title: string | null;
  source_diagram_id: string | null;
};

export type DrawingSheet = DrawingSheetSummary & {
  drawing_id: string;
  document: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export type Drawing = {
  id: string;
  project_id: string;
  system_id: string | null;
  number: string;
  title: string;
  size: string;
  units: string;
  discipline: string;
  status: string;
  frame_template: string;
  fields: Record<string, unknown>;
  notes: string[];
  sheets: DrawingSheetSummary[];
  revisions: DrawingRevision[];
  created_at: string;
  updated_at: string;
};

export type LineClass = {
  id: string;
  project_id: string;
  name: string;
  description: string | null;
  material: string | null;
  rating: string | null;
  wall: string | null;
  sizes: string[];
  insulation: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

export type TagSchemeRead = {
  project_id: string;
  scheme: Record<string, unknown> | null;
};

export type SchematicRead = {
  diagram_id: string;
  revision: number;
  document: Record<string, unknown> | null;
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

export type RequirementConstraintRead = {
  kind: "material_in" | "material_not_in" | "pressure_rating_min" | "part_qualified" | "line_class_in" | "relief_required";
  values: string[];
  scope?: { categories?: string[]; services?: string[] };
};

export type RequirementCategory = "functional" | "performance" | "safety" | "interface" | "environmental" | "manufacturing" | "verification";
export type VerificationStatus = "planned" | "in_progress" | "verified" | "failed" | "waived";

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
  /** Machine-checkable constraint evaluated by the drawing DRC. */
  constraint?: RequirementConstraintRead | null;
  parent_id?: string | null;
  rationale?: string | null;
  category?: RequirementCategory | string;
  safety_critical?: boolean;
  applicability?: { systems?: string[]; operating_modes?: string[]; services?: string[] } | null;
  /** Rolled up from evidence on the server. */
  verification_status?: VerificationStatus | string;
  revision?: number;
  source_ref?: string | null;
};

export type RequirementHistoryEntry = {
  id: string;
  requirement_id: string;
  revision: number;
  field: string;
  old_value: string | null;
  new_value: string | null;
  actor: string | null;
  created_at: string;
};

export type RequirementImportResult = {
  dry_run: boolean;
  mapping: Record<string, string>;
  created: number;
  updated: number;
  skipped: number;
  errors: string[];
  preview: Array<{ row: number; key: string; title: string; category: string; parent_key: string | null; action: "create" | "update" | "skip" }>;
};

export type RequirementCoverage = {
  project_id: string;
  totals: { requirements: number; hazards: number; traced: number; with_evidence: number };
  untraced_requirements: Array<{ id: string; key: string; title: string }>;
  critical_without_evidence: Array<{ id: string; key: string; title: string }>;
  hazards_without_controls: Array<{ id: string; key: string; title: string }>;
  uncovered_hardware_controls: Array<{ hazard_id: string; hazard_key: string; link_id: string; item_id: string; tag: string; sheet_id: string | null }>;
};

export type EvidenceKind = "drc" | "analysis" | "document" | "test" | "inspection" | "waiver";
export type EvidenceStatus = "pass" | "fail" | "pending";

export type Evidence = {
  id: string;
  requirement_id: string;
  kind: EvidenceKind | string;
  ref_type: string | null;
  ref_id: string | null;
  status: EvidenceStatus | string;
  note: string | null;
  recorded_by: string | null;
  created_at: string;
  updated_at: string;
};

export type HazardControl = {
  link_id: string;
  type: "requirement" | "sheet_item";
  id: string;
  label: string;
  title?: string | null;
  verification_status: string;
  covered: boolean;
  covering_requirements: string[];
};

export type Hazard = {
  id: string;
  project_id: string;
  key: string;
  title: string;
  description: string;
  category: string;
  system_id: string | null;
  operating_modes: string[] | null;
  severity_initial: string | null;
  likelihood_initial: string | null;
  severity_residual: string | null;
  likelihood_residual: string | null;
  status: "open" | "accepted" | "closed" | string;
  owner: string | null;
  accepted_by: string | null;
  accepted_at: string | null;
  acceptance_justification: string | null;
  fault_tolerance_required: number;
  created_at: string;
  updated_at: string;
  computed_status: "open" | "controlled" | "accepted" | "closed" | string;
  risk_initial: string | null;
  risk_residual: string | null;
  controls_total: number;
  controls_verified: number;
  independent_controls: number;
  controls: HazardControl[];
  causes: number;
};

export type HazardInput = Partial<Pick<Hazard, "title" | "description" | "category" | "system_id" | "operating_modes" | "severity_initial" | "likelihood_initial" | "severity_residual" | "likelihood_residual" | "status" | "owner" | "fault_tolerance_required">>;

export type ScaleEntry = { code: string; name: string; description?: string };

export type SafetySettings = {
  severity_scale: ScaleEntry[];
  likelihood_scale: ScaleEntry[];
  risk_classes: Array<{ code: string; name: string }>;
  risk_matrix: Record<string, Record<string, string>>;
  fault_tolerance: Record<string, number>;
  rpn_threshold: number;
  fmea_scale_max?: number;
  fmea_hazard_severity_min?: number;
  fmea_rating_descriptions?: Record<string, string[]>;
  operating_modes: string[];
  hazard_categories: string[];
  auto_hazard: boolean;
  default_hazard_severity: string;
  default_hazard_likelihood: string;
  approvers: string[];
};

export type HazardMatrix = {
  project_id: string;
  severity_scale: ScaleEntry[];
  likelihood_scale: ScaleEntry[];
  risk_matrix: Record<string, Record<string, string>>;
  initial: Record<string, Record<string, number>>;
  residual: Record<string, Record<string, number>>;
  unrated: number;
};

export type SheetItemRef = {
  id: string;
  sheet_id: string;
  item_id: string;
  tag: string | null;
  label: string | null;
  category: string | null;
  symbol_name: string | null;
  zone: string | null;
  part_id: string | null;
  drawing_id: string;
  drawing_number: string;
  sheet_no: number;
};

export type DrcResultRead = {
  id: string;
  sheet_id: string;
  key: string;
  rule: string;
  severity: "error" | "warning" | "info";
  message: string;
  item_id: string | null;
  subject: string | null;
  zone: string | null;
  requirement_id: string | null;
};

export type DrcWaiverRead = {
  id: string;
  sheet_id: string;
  key: string;
  reason: string;
  waived_by: string | null;
  created_at: string;
};

export type SheetDrcRead = {
  sheet_id: string;
  sheet_no: number;
  counts: { error: number; warning: number; info: number; waived: number };
  findings: DrcResultRead[];
  waivers: DrcWaiverRead[];
  checks: Array<{ id: string; sheet_id: string; requirement_id: string; item_id: string; subject: string | null; zone: string | null; status: "pass" | "fail"; message: string }>;
};

export type DrawingDrcRead = { drawing_id: string; counts: SheetDrcRead["counts"]; sheets: SheetDrcRead[] };

export type VerificationRow = {
  requirement_id: string;
  key: string;
  title: string;
  status: string;
  constraint: RequirementConstraintRead | null;
  checked: number;
  passed: number;
  failed: number;
  verdict: "pass" | "fail" | "no_data" | "manual";
  drawings: Array<{ drawing_id: string; drawing_number: string; checked: number; failed: number; sheets: number[] }>;
  linked_components: number;
  linked_drawings: number;
  failures: SheetDrcRead["checks"];
  category?: string;
  verification_method?: string | null;
  owner?: string | null;
  verification_status?: string;
  safety_critical?: boolean;
  evidence?: Record<string, number>;
  hazards?: string[];
};

export type VerificationMatrix = { project_id: string; rows: VerificationRow[] };

export type BomSnapshot = {
  id: string;
  diagram_id: string | null;
  drawing_id?: string | null;
  source_kind?: "diagram" | "drawing";
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
  code?: string;
  severity?: "blocking" | "warning";
};

export type BomReadiness = {
  snapshot_id: string;
  row_count: number;
  issue_count: number;
  blocking_count?: number;
  warning_count?: number;
  ready: boolean;
  issues: BomReadinessIssue[];
};

export type ListColumn = { key: string; label: string };

/** Engineering list served from the saved sheet index. */
export type ListRead = {
  kind: string;
  title: string;
  scope: "drawing" | "project";
  header: Record<string, string | number>;
  columns: ListColumn[];
  rows: Array<Record<string, string | number | boolean | null>>;
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
  /** Library metadata (Phase 2): palette category, legend text, default tag letters. */
  category?: string | null;
  legend?: string | null;
  tag_prefix?: string | null;
  created_at?: string;
  updated_at?: string;
};

// ---- FMEA ----

export type FailureMode = {
  id: string;
  category: string;
  symbol_key: string | null;
  name: string;
  title: string;
  default_local_effect: string;
  default_detection_hint: string[] | null;
  default_severity: number | null;
  applicable_modes: string[] | null;
  replaces_category: boolean;
  active: boolean;
};

export type FmeaWorksheet = {
  id: string;
  project_id: string;
  system_id: string | null;
  drawing_id: string | null;
  drawing_number: string | null;
  drawing_revision_label: string | null;
  drawing_current_revision_label: string | null;
  revision_drift: boolean;
  title: string;
  method: "fmea" | "fmeca" | string;
  operating_modes: string[] | null;
  status: "draft" | "in_review" | "released" | "superseded" | string;
  revision: number;
  row_count: number;
  stale_count: number;
  open_actions: number;
  above_threshold: number;
  created_at: string;
  updated_at: string;
};

export type FmeaControl = { link_id: string; type: "requirement" | "sheet_item" | string; id: string; label: string };

export type FmeaRow = {
  id: string;
  worksheet_id: string;
  sheet_id: string | null;
  item_id: string | null;
  subject_text: string | null;
  item_tag: string | null;
  item_category: string | null;
  item_symbol: string | null;
  item_zone: string | null;
  item_exists: boolean;
  part_id: string | null;
  part_number: string | null;
  sheet_no: number | null;
  drawing_id: string | null;
  drawing_number: string | null;
  failure_mode_id: string | null;
  failure_mode_text: string | null;
  failure_mode_name: string | null;
  failure_mode_title: string | null;
  operating_modes: string[] | null;
  cause: string;
  local_effect: string;
  next_effect: string;
  end_effect: string;
  detected_by_item_id: string | null;
  detected_by_tag: string | null;
  detection_kind: "instrument" | "procedure" | "inspection" | "none" | string;
  detection_reason: string | null;
  severity: number | null;
  occurrence: number | null;
  detection: number | null;
  rpn: number | null;
  hazard_id: string | null;
  hazard_key: string | null;
  recommended_action: string | null;
  action_owner: string | null;
  action_due: string | null;
  action_status: "not_required" | "open" | "in_progress" | "done" | string;
  severity_residual: number | null;
  occurrence_residual: number | null;
  detection_residual: number | null;
  rpn_residual: number | null;
  notes: string | null;
  not_applicable: boolean;
  stale_reason: string | null;
  stale_detail: string | null;
  position: number;
  controls: FmeaControl[];
  comment_count: number;
  open_comment_count: number;
  created_at: string;
  updated_at: string;
};

export type FmeaRowPatch = Partial<
  Pick<
    FmeaRow,
    | "sheet_id"
    | "item_id"
    | "subject_text"
    | "failure_mode_id"
    | "failure_mode_text"
    | "operating_modes"
    | "cause"
    | "local_effect"
    | "next_effect"
    | "end_effect"
    | "detected_by_item_id"
    | "detection_kind"
    | "detection_reason"
    | "severity"
    | "occurrence"
    | "detection"
    | "hazard_id"
    | "recommended_action"
    | "action_owner"
    | "action_due"
    | "action_status"
    | "severity_residual"
    | "occurrence_residual"
    | "detection_residual"
    | "notes"
    | "not_applicable"
    | "position"
  >
>;

export type FmeaGenerateResult = { added: number; kept: number; stale: number; items_without_modes: string[] };
export type FmeaGate = { ready: boolean; blockers: Array<{ row_id: string; item: string; reason: string }> };
export type FmeaRelease = { id: string; worksheet_id: string; revision: number; drawing_revision_label: string | null; released_by: string | null; note: string | null; row_count: number; created_at: string };
export type FmeaDiff = {
  worksheet_id: string;
  against_revision: number;
  added: Array<Record<string, unknown>>;
  removed: Array<Record<string, unknown>>;
  changed: Array<{ item_tag: string | null; failure_mode_title: string | null; fields: Record<string, { from: unknown; to: unknown }> }>;
};
export type FmeaComment = { id: string; row_id: string; author: string | null; body: string; resolved: boolean; created_at: string };
