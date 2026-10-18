/**
 * Shared contracts for the Release Readiness Review.
 *
 * The release-reader skill writes PlanDraft, ReleaseTarget and Release.
 * The (not yet built) analyzer writes Finding[] and LinkageGap[]; the status
 * skill writes Team[]. The GUI validates every file it loads against these.
 */
import { z } from "zod";

// ---------- common ----------
export const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");
export const IsoDateTime = z.string().min(10);
export const IssueKey = z.string().regex(/^[A-Z][A-Z0-9]+-\d+$/);
export const ProjectKey = z.string().regex(/^[A-Z][A-Z0-9]+$/);

// ---------- Stage A: plan-draft.json ----------
export const PlanItemKind = z.enum(["deliverable", "dependency", "approval", "checklist"]);
export type PlanItemKind = z.infer<typeof PlanItemKind>;

export const PlanSource = z.object({
  file: z.string(),
  locator: z.string(),
  quote: z.string().min(1),
});

export const PlanItem = z.object({
  id: z.string(),
  text: z.string().min(1),
  kind: PlanItemKind,
  owner_team: z.string().nullable(),
  due: IsoDate.nullable(),
  due_text: z.string().nullable(),
  due_is_inferred: z.boolean(),
  source: PlanSource,
});
export type PlanItem = z.infer<typeof PlanItem>;

export const PlanTeam = z.object({
  name: z.string(),
  mentioned_in: z.array(z.string()),
  jira_project_hint: ProjectKey.nullable(),
  owners: z.array(z.string()),
  components: z.array(z.string()),
  role: z.string().nullable().optional(),
  /** Project keys that appear next to this team in plan text (used by Stage B "explicit"). */
  project_keys_mentioned: z.array(ProjectKey).default([]),
});
export type PlanTeam = z.infer<typeof PlanTeam>;

export const ReadAs = z.enum(["plan_items", "launch_checks", "teams_and_owners"]);
export type ReadAs = z.infer<typeof ReadAs>;

export const PlanFile = z.object({
  name: z.string(),
  read_as: z.array(ReadAs),
  notes: z.string(),
});

export const PlanDraft = z.object({
  launch_date: IsoDate.nullable(),
  epic_keys_mentioned: z.array(IssueKey),
  items: z.array(PlanItem),
  teams: z.array(PlanTeam),
  files: z.array(PlanFile),
  warnings: z.array(z.string()),
});
export type PlanDraft = z.infer<typeof PlanDraft>;

// ---------- Stage B: release-target.json ----------
export const MatchSource = z.enum(["team_list", "explicit", "linked", "name", "unresolved"]);
export type MatchSource = z.infer<typeof MatchSource>;

export const ProjectCandidate = z.object({
  key: ProjectKey,
  name: z.string(),
  evidence: z.string(),
});

export const TeamProject = z.object({
  team: z.string(),
  jira_project: ProjectKey.nullable(),
  match: MatchSource,
  evidence: z.string(),
  candidates: z.array(ProjectCandidate),
  /** Set by the person in the GUI or on the CLI: skip the scoped search for this team. */
  search: z.boolean().default(true),
});
export type TeamProject = z.infer<typeof TeamProject>;

export const VisibleProject = z.object({
  key: ProjectKey,
  name: z.string(),
  category: z.string().nullable(),
  description: z.string().nullable(),
  lead: z.string().nullable(),
});
export type VisibleProject = z.infer<typeof VisibleProject>;

export const ReleaseTarget = z.object({
  epic: z.object({
    key: IssueKey,
    summary: z.string(),
    fix_version: z.string().nullable(),
    release_date: IsoDate.nullable(),
    created: IsoDate.nullable().optional(),
  }),
  release_window: z.object({ start: IsoDate, end: IsoDate }),
  projects: z.array(TeamProject),
  visible_projects: z.array(VisibleProject).default([]),
  warnings: z.array(z.string()),
});
export type ReleaseTarget = z.infer<typeof ReleaseTarget>;

// ---------- Stage C: release.json ----------
export const Comment = z.object({
  author: z.string(),
  created: IsoDateTime,
  body: z.string(),
  mentioned_keys: z.array(IssueKey),
});

export const Story = z.object({
  key: IssueKey,
  summary: z.string(),
  status: z.string(),
  assignee: z.string().nullable(),
  due: IsoDate.nullable(),
  components: z.array(z.string()),
  comments: z.array(Comment),
});
export type Story = z.infer<typeof Story>;

export const Link = z.object({
  from: IssueKey,
  to: IssueKey,
  type: z.string(),
  direction: z.enum(["inward", "outward"]),
});
export type Link = z.infer<typeof Link>;

export const RelatedIssue = z.object({
  key: IssueKey,
  project: ProjectKey,
  summary: z.string(),
  status: z.string(),
  assignee: z.string().nullable(),
  due: IsoDate.nullable(),
  updated: IsoDateTime,
  reached_by: z.enum(["link", "comment_mention"]),
  via: z.object({
    issue: IssueKey,
    link_type: z.string().nullable(),
    comment_excerpt: z.string().nullable(),
  }),
});
export type RelatedIssue = z.infer<typeof RelatedIssue>;

export const SearchCandidate = z.object({
  key: IssueKey,
  project: ProjectKey,
  summary: z.string(),
  status: z.string(),
  assignee: z.string().nullable(),
  due: IsoDate.nullable(),
  updated: IsoDateTime.optional(),
  matched_plan_item_id: z.string(),
  match_terms: z.array(z.string()),
  jql: z.string(),
});
export type SearchCandidate = z.infer<typeof SearchCandidate>;

export const Release = z.object({
  schema_version: z.literal(1),
  snapshot_label: z.string(),
  read_at: IsoDateTime,
  epic: z.object({
    key: IssueKey,
    summary: z.string(),
    status: z.string(),
    fix_version: z.string().nullable(),
    release_date: IsoDate.nullable(),
    components: z.array(z.string()),
    due: IsoDate.nullable(),
  }),
  stories: z.array(Story),
  links: z.array(Link),
  related: z.array(RelatedIssue),
  search_candidates: z.array(SearchCandidate),
  projects_searched: z.array(z.object({ team: z.string(), jira_project: ProjectKey, match: MatchSource })),
  warnings: z.array(z.string()),
});
export type Release = z.infer<typeof Release>;

// ---------- Analyzer output (not built yet; types only) ----------
export const GapType = z.enum(["process", "cross_team_date", "commitment"]);
export const Strength = z.enum(["strong", "moderate", "weak"]);
export const OwnerSource = z.enum(["team_list", "jira_inferred"]);

export const Evidence = z.object({ key: z.string(), text: z.string(), meta: z.string() });

export const Linkage = z.object({ from: IssueKey, to: IssueKey, suggested_type: z.string() });

export const Finding = z.object({
  id: z.string(),
  title: z.string(),
  gap_type: GapType,
  strength: Strength,
  owner: z.string(),
  owner_source: OwnerSource,
  plan_item_id: z.string(),
  evidence: z.array(Evidence),
  why: z.string(),
  linkage: Linkage.optional(),
  /** What to ask the owner if the finding is kept (shown on the go/no-go card). */
  ask: z.string().optional(),
});
export type Finding = z.infer<typeof Finding>;

export const LinkageGap = z.object({
  id: z.string(),
  from: IssueKey,
  to: IssueKey,
  to_summary: z.string(),
  how: z.enum(["comment_mention", "search_match"]),
  suggested_type: z.string(),
  /** If a finding already shows this gap, its id; such gaps are not listed separately. */
  finding_id: z.string().nullable(),
});
export type LinkageGap = z.infer<typeof LinkageGap>;

// ---------- Status output (not built yet; types only) ----------
export const TeamStatus = z.enum(["on_track", "at_risk", "late"]);
export type TeamStatus = z.infer<typeof TeamStatus>;

export const ItemResult = z.enum(["ok", "gap", "late", "weak"]);

export const TeamItem = z.object({
  plan_item_id: z.string(),
  text: z.string(),
  ticket: IssueKey.nullable(),
  ticket_status: z.string(),
  plan_due: IsoDate.nullable(),
  jira_due: IsoDate.nullable(),
  result: ItemResult,
  note: z.string(),
  finding_id: z.string().nullable(),
});
export type TeamItem = z.infer<typeof TeamItem>;

export const Team = z.object({
  team: z.string(),
  project_key: ProjectKey,
  role: z.string(),
  status: TeamStatus,
  items: z.array(TeamItem),
  change_note: z.string(),
});
export type Team = z.infer<typeof Team>;

// ---------- Saved run: runs/<epic>/<snapshot>.json ----------
export const Run = z.object({
  plan: PlanDraft,
  target: ReleaseTarget,
  release: Release,
  findings: z.array(Finding),
  linkage_gaps: z.array(LinkageGap),
  teams: z.array(Team),
});
export type Run = z.infer<typeof Run>;
