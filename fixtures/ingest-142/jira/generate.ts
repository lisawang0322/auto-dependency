/**
 * PLACEHOLDER SAMPLE DATA generator (PRD R12: the real sample Jira projects are written by someone else).
 * Writes two dated snapshots of a fictional Jira site in Jira REST v3 shapes:
 *   fixtures/ingest-142/jira/<snapshot>/projects.json   (getVisibleJiraProjects)
 *   fixtures/ingest-142/jira/<snapshot>/issues/<KEY>.json (getJiraIssue)
 * JQL searches are evaluated over issues/ by the fixture JiraSource, so they are not stored.
 *
 *   npx tsx fixtures/ingest-142/jira/generate.ts
 */
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SNAPSHOTS = ["2026-11-10", "2026-11-13"] as const;
type Snap = (typeof SNAPSHOTS)[number];

const PEOPLE = {
  priya: "Priya Natarajan", marcus: "Marcus Lee", dana: "Dana Okafor",
  wei: "Wei Zhang", tomas: "Tomás Herrera", anika: "Anika Rao",
  jordan: "Jordan Blake", fatima: "Fatima Noor",
  sam: "Sam Whitfield", lena: "Lena Fischer", omar: "Omar Haddad",
  noah: "Noah Park", ava: "Ava Chen",
};

const projects = [
  { key: "INGEST", name: "Ingestion service", category: "Product", description: "The streaming ingestion service and its batch importer predecessor.", lead: PEOPLE.marcus },
  { key: "DATA", name: "Data Platform", category: "Platform", description: "Shared data platform: clusters, storage and permissions.", lead: PEOPLE.wei },
  { key: "SEC", name: "Security Engineering", category: "Security", description: "Application security reviews and launch approvals.", lead: PEOPLE.jordan },
  { key: "SRE", name: "Site Reliability Engineering", category: "Platform", description: "Capacity, on-call and production readiness.", lead: PEOPLE.sam },
  // decoys: plausible names that must never be matched silently
  { key: "SRETOOLS", name: "SRE Tooling", category: "Platform", description: "Internal tools built for the SRE org.", lead: PEOPLE.noah },
  { key: "SECOPS", name: "Security Operations", category: "Security", description: "Incident response and security monitoring.", lead: PEOPLE.ava },
];

interface CommentDef { created: string; author: string; body: string }
interface LinkDef { type: "Blocks" | "Relates"; dir: "inward" | "outward"; key: string }
interface IssueDef {
  key: string; type: "Epic" | "Story" | "Task"; summary: string; description?: string;
  assignee: string | null; created: string; due?: string | null; components?: string[];
  parent?: string; fixVersion?: boolean; links?: LinkDef[]; comments?: CommentDef[];
  /** status/due/updated/resolution per snapshot */
  at: Record<Snap, { status: string; due?: string | null; updated: string; resolution?: string | null }>;
}

const same = (status: string, updated: string, due?: string | null) =>
  ({ "2026-11-10": { status, updated, due }, "2026-11-13": { status, updated, due } }) as IssueDef["at"];

const ingestComponents = ["ingestion-api", "ingestion-workers"];
const issues: IssueDef[] = [];

issues.push({
  key: "INGEST-142", type: "Epic", summary: "Ingestion service launch",
  description: "Replace the batch importer with a streaming ingestion path onto the shared data platform. Plan of record v3.",
  assignee: PEOPLE.priya, created: "2026-09-15T10:00:00.000+0000", due: "2026-11-18", components: ingestComponents, fixVersion: true,
  links: [
    { type: "Blocks", dir: "inward", key: "SEC-881" },
    { type: "Relates", dir: "outward", key: "DATA-240" },
    { type: "Blocks", dir: "inward", key: "SRE-398" },
  ],
  comments: [
    { created: "2026-10-20T09:00:00.000+0000", author: PEOPLE.priya, body: "Kickoff done. The plan of record v3 is the source of truth for dates and owners." },
    { created: "2026-11-05T14:30:00.000+0000", author: PEOPLE.priya, body: "Security review kicked off, see SEC-881. Target is approval by Nov 14." },
    { created: "2026-11-12T17:05:00.000+0000", author: PEOPLE.priya, body: "QA signed off today. Reviewing readiness before Friday's go/no-go." },
  ],
  at: { "2026-11-10": { status: "In Progress", updated: "2026-11-09T16:20:00.000+0000" }, "2026-11-13": { status: "In Progress", updated: "2026-11-12T17:05:00.000+0000" } },
});

// 25 stories INGEST-143..167. Done on Nov 10: 143-149, 151-156, 158-162 (18). Also done by Nov 13: 150, 164, 165 (21).
const storyDefs: [number, string, string, string | null][] = [
  [143, "Define ingestion event schema", "Done", PEOPLE.marcus],
  [144, "Kafka consumer for raw events", "Done", PEOPLE.marcus],
  [145, "Writer service skeleton", "Done", PEOPLE.dana],
  [146, "Backpressure and retry policy", "Done", PEOPLE.marcus],
  [147, "Schema validation on ingest", "Done", PEOPLE.dana],
  [148, "Dead-letter topic handling", "Done", PEOPLE.marcus],
  [149, "Metrics for ingestion throughput", "Done", PEOPLE.dana],
  [150, "Provision ingestion cluster namespace", "In Progress", PEOPLE.marcus],
  [151, "Staging deployment pipeline", "Done", PEOPLE.dana],
  [152, "Batch importer compatibility shim", "Done", PEOPLE.marcus],
  [153, "Idempotent writes to the platform store", "Done", PEOPLE.dana],
  [154, "Config and secrets wiring", "Done", PEOPLE.marcus],
  [155, "Integration tests against staging", "Done", PEOPLE.dana],
  [156, "Partitioning strategy for hot tenants", "Done", PEOPLE.marcus],
  [157, "Production database access for ingestion writer", "In Progress", PEOPLE.marcus],
  [158, "Alert rules for consumer lag", "Done", PEOPLE.dana],
  [159, "Canary rollout config", "Done", PEOPLE.marcus],
  [160, "Staging soak, week 1", "Done", PEOPLE.dana],
  [161, "Tenant onboarding doc", "Done", PEOPLE.dana],
  [162, "Feature flag for streaming path", "Done", PEOPLE.marcus],
  [163, "Load test at 2× peak", "In Progress", PEOPLE.dana],
  [164, "Fix duplicate events under rebalance", "In Progress", PEOPLE.marcus],
  [165, "Dashboard for ingestion lag", "In Review", PEOPLE.dana],
  [166, "Production runbook", "To Do", PEOPLE.marcus],
  [167, "Cut-over plan from batch importer", "To Do", PEOPLE.priya],
];
const doneByNov13 = new Set([150, 164, 165]);
const secondComment = new Set([145, 148, 152, 155, 159, 161, 164]);

for (const [n, summary, status10, assignee] of storyDefs) {
  const key = `INGEST-${n}`;
  const dayCreated = 20 + ((n - 143) % 9); // Sep 20 .. Sep 28
  const created = `2026-09-${dayCreated}T09:00:00.000+0000`;
  const status13 = doneByNov13.has(n) ? "Done" : status10 === "To Do" && n === 166 ? "In Progress" : status10;
  const comments: CommentDef[] = [
    { created: `2026-10-${String(1 + ((n - 143) % 28)).padStart(2, "0")}T10:00:00.000+0000`, author: assignee ?? PEOPLE.marcus, body: "Picked this up." },
  ];
  if (secondComment.has(n)) comments.push({ created: `2026-11-0${1 + (n % 7)}T11:00:00.000+0000`, author: PEOPLE.priya, body: "Thanks, looks good for the Nov 20 launch." });
  const def: IssueDef = {
    key, type: "Story", summary, assignee, created, components: [ingestComponents[n % 2]], parent: "INGEST-142", fixVersion: true,
    comments,
    at: {
      "2026-11-10": { status: status10, updated: status10 === "Done" ? "2026-11-03T12:00:00.000+0000" : "2026-11-09T12:00:00.000+0000" },
      "2026-11-13": { status: status13, updated: status13 !== status10 ? "2026-11-12T12:00:00.000+0000" : status10 === "Done" ? "2026-11-03T12:00:00.000+0000" : "2026-11-11T12:00:00.000+0000" },
    },
  };
  if (n === 150) {
    def.links = [{ type: "Blocks", dir: "inward", key: "DATA-221" }];
    def.comments.push(
      { created: "2026-11-03T15:10:00.000+0000", author: PEOPLE.marcus, body: "Namespace is created but we can't scale workers until the quota is raised. Quota bump is tracked in DATA-233, waiting on Data Platform." },
      { created: "2026-11-12T10:40:00.000+0000", author: PEOPLE.anika, body: "DATA-233 is done, quota raised to 40 vCPU. Closing this." },
    );
  }
  if (n === 157) {
    def.due = "2026-11-13";
    def.links = [{ type: "Relates", dir: "outward", key: "DATA-240" }, { type: "Blocks", dir: "inward", key: "SEC-890" }];
    def.comments.push(
      { created: "2026-11-04T09:30:00.000+0000", author: PEOPLE.marcus, body: "Writer needs INSERT on the platform store in prod. Opened DATA-240 for the permissions review." },
      { created: "2026-11-12T16:15:00.000+0000", author: PEOPLE.tomas, body: "Closing DATA-240 as a duplicate of the general access process. DBA will review prod permissions before launch." },
    );
  }
  if (n === 163) {
    def.due = "2026-11-15";
    def.comments.push({ created: "2026-11-11T18:00:00.000+0000", author: PEOPLE.dana, body: "Ran the 2× peak run on staging yesterday, load test looks fine. Will attach the report." });
  }
  if (n === 167) {
    def.comments.push({ created: "2026-11-09T13:00:00.000+0000", author: PEOPLE.marcus, body: "Need SRE's capacity confirmation before we can write the cut-over timing." });
  }
  issues.push(def);
}

// One hop out: other teams' issues
issues.push(
  {
    key: "SEC-881", type: "Task", summary: "Security review: ingestion service", assignee: PEOPLE.fatima, created: "2026-10-28T09:00:00.000+0000", due: "2026-11-14", components: ["app-security"],
    links: [{ type: "Blocks", dir: "outward", key: "INGEST-142" }],
    comments: [{ created: "2026-11-11T09:15:00.000+0000", author: PEOPLE.fatima, body: "Threat model received, review in progress." }],
    at: { "2026-11-10": { status: "Open", updated: "2026-11-05T14:35:00.000+0000" }, "2026-11-13": { status: "In Review", updated: "2026-11-11T09:15:00.000+0000" } },
  },
  {
    key: "SEC-890", type: "Task", summary: "Secrets rotation policy sign-off for ingestion", assignee: PEOPLE.jordan, created: "2026-10-10T09:00:00.000+0000", due: "2026-10-30", components: ["app-security"],
    links: [{ type: "Blocks", dir: "outward", key: "INGEST-157" }],
    at: same("Done", "2026-10-29T11:00:00.000+0000"),
  },
  {
    key: "DATA-240", type: "Task", summary: "Production DB permissions for ingestion writer", assignee: PEOPLE.tomas, created: "2026-11-04T09:35:00.000+0000", due: "2026-11-13", components: ["permissions"],
    links: [{ type: "Relates", dir: "inward", key: "INGEST-142" }, { type: "Relates", dir: "inward", key: "INGEST-157" }],
    at: { "2026-11-10": { status: "To Do", updated: "2026-11-04T09:35:00.000+0000" }, "2026-11-13": { status: "Closed", updated: "2026-11-12T16:10:00.000+0000", resolution: "Duplicate" } },
  },
  {
    key: "DATA-233", type: "Task", summary: "Raise ingestion cluster quota", description: "Raise the ingestion namespace quota to 40 vCPU for launch load.", assignee: PEOPLE.anika, created: "2026-10-22T09:00:00.000+0000", due: "2026-11-12", components: ["cluster"],
    at: { "2026-11-10": { status: "In Progress", updated: "2026-11-06T10:00:00.000+0000" }, "2026-11-13": { status: "Done", updated: "2026-11-12T10:30:00.000+0000" } },
  },
  {
    key: "DATA-221", type: "Task", summary: "Kafka topic ACLs for ingestion", assignee: PEOPLE.wei, created: "2026-10-05T09:00:00.000+0000", due: "2026-10-20", components: ["permissions"],
    links: [{ type: "Blocks", dir: "outward", key: "INGEST-150" }],
    at: same("Done", "2026-10-19T15:00:00.000+0000"),
  },
  {
    key: "DATA-251", type: "Task", summary: "Permissions review for analytics warehouse writers", assignee: PEOPLE.tomas, created: "2026-11-02T09:00:00.000+0000", due: null, components: ["permissions"],
    at: same("In Progress", "2026-11-08T12:00:00.000+0000"),
  },
  {
    key: "SRE-398", type: "Task", summary: "Alerting and runbook for ingestion service", assignee: PEOPLE.lena, created: "2026-10-12T09:00:00.000+0000", due: "2026-11-06", components: ["on-call"],
    links: [{ type: "Blocks", dir: "outward", key: "INGEST-142" }],
    at: same("Done", "2026-11-05T17:00:00.000+0000"),
  },
  {
    key: "SRE-412", type: "Task", summary: "Capacity for ingestion service", description: "Reserve node capacity and on-call rotation for the ingestion service launch.", assignee: PEOPLE.omar, created: "2026-10-27T09:00:00.000+0000", components: ["capacity"],
    comments: [{ created: "2026-11-12T11:20:00.000+0000", author: PEOPLE.omar, body: "Pushing this to Nov 22; the capacity team is tied up with the warehouse migration this week." }],
    at: { "2026-11-10": { status: "To Do", updated: "2026-10-28T09:00:00.000+0000", due: "2026-11-13" }, "2026-11-13": { status: "To Do", updated: "2026-11-12T11:20:00.000+0000", due: "2026-11-22" } },
  },
  // decoy-project issues: only reachable if someone picks the wrong project
  {
    key: "SRETOOLS-77", type: "Task", summary: "Capacity dashboard for the SRE org", assignee: PEOPLE.noah, created: "2026-10-01T09:00:00.000+0000", components: [],
    at: same("In Progress", "2026-11-02T09:00:00.000+0000"),
  },
  {
    key: "SECOPS-12", type: "Task", summary: "Security review of on-call paging tooling", assignee: PEOPLE.ava, created: "2026-10-03T09:00:00.000+0000", components: [],
    at: same("To Do", "2026-10-30T09:00:00.000+0000"),
  },
);

const LINK_TYPES = { Blocks: { name: "Blocks", inward: "is blocked by", outward: "blocks" }, Relates: { name: "Relates", inward: "relates to", outward: "relates to" } };

function render(def: IssueDef, snap: Snap) {
  const st = def.at[snap];
  const due = st.due !== undefined ? st.due : def.due ?? null;
  const comments = (def.comments ?? []).filter((c) => c.created.slice(0, 10) <= snap).map((c) => ({
    author: { displayName: c.author }, created: c.created, body: c.body,
  }));
  return {
    key: def.key,
    fields: {
      summary: def.summary,
      description: def.description ?? null,
      issuetype: { name: def.type },
      status: { name: st.status },
      resolution: st.resolution ? { name: st.resolution } : null,
      project: { key: def.key.slice(0, def.key.lastIndexOf("-")) },
      assignee: def.assignee ? { displayName: def.assignee } : null,
      duedate: due,
      created: def.created,
      updated: st.updated,
      components: (def.components ?? []).map((name) => ({ name })),
      fixVersions: def.fixVersion ? [{ name: "1.0", releaseDate: "2026-11-20" }] : [],
      parent: def.parent ? { key: def.parent } : undefined,
      issuelinks: (def.links ?? []).map((l) => ({
        type: LINK_TYPES[l.type],
        ...(l.dir === "inward" ? { inwardIssue: { key: l.key } } : { outwardIssue: { key: l.key } }),
      })),
      comment: { comments, total: comments.length },
    },
  };
}

for (const snap of SNAPSHOTS) {
  const dir = join(HERE, snap);
  rmSync(join(dir, "issues"), { recursive: true, force: true });
  mkdirSync(join(dir, "issues"), { recursive: true });
  writeFileSync(join(dir, "projects.json"), JSON.stringify(projects.map((p) => ({
    key: p.key, name: p.name, projectCategory: { name: p.category }, description: p.description, lead: { displayName: p.lead },
  })), null, 2) + "\n");
  let total = 0;
  for (const def of issues) {
    const r = render(def, snap);
    total += r.fields.comment.total;
    writeFileSync(join(dir, "issues", `${def.key}.json`), JSON.stringify(r, null, 2) + "\n");
  }
  writeFileSync(join(dir, "README.md"), `# Sample Jira snapshot ${snap}\n\nPLACEHOLDER SAMPLE DATA generated by \`generate.ts\`. ${issues.length} issues, ${total} comments. Do not edit by hand; edit the generator.\n`);
  console.log(`${snap}: ${issues.length} issues, ${total} comments`);
}
