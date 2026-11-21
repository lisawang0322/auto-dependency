/**
 * The demo identity provider (AUTH=demo): a sign-in page served by this server with a few people to sign in as, and a
 * consent page for the employee directory that stands in for Microsoft Entra ID. Nothing here talks to a real tenant;
 * it exists so sign-in, per-person state and the directory's Entra layer can be shown without an app registration.
 */
export const DEMO_ORG = "sample-co";

export interface DemoPersona { id: string; name: string; email: string; title: string }
export const DEMO_PERSONAS: DemoPersona[] = [
  { id: "priya", name: "Priya Natarajan", email: "priya@sample-co.example", title: "TPM, Ingestion team" },
  { id: "dana", name: "Dana Okafor", email: "dana@sample-co.example", title: "Product, Ingestion team" },
  { id: "anika", name: "Anika Rao", email: "anika@sample-co.example", title: "Director, platform" },
];

/** What the directory's Entra layer reads in demo mode: the sample company, in Graph's shape. */
export interface DemoGraphUser { displayName: string; jobTitle: string; department: string; manager?: string }
export const DEMO_DIRECTORY: DemoGraphUser[] = [
  { displayName: "Priya Natarajan", jobTitle: "TPM", department: "Ingestion team", manager: "Dana Okafor" },
  { displayName: "Marcus Lee", jobTitle: "eng lead", department: "Ingestion team", manager: "Dana Okafor" },
  { displayName: "Dana Okafor", jobTitle: "product", department: "Product" },
  { displayName: "Wei Zhang", jobTitle: "eng lead", department: "Data Platform", manager: "Anika Rao" },
  { displayName: "Tomás Herrera", jobTitle: "DBA", department: "Data Platform", manager: "Anika Rao" },
  { displayName: "Anika Rao", jobTitle: "director, platform", department: "Platform leadership" },
  { displayName: "Jordan Blake", jobTitle: "security lead", department: "Security", manager: "Anika Rao" },
  { displayName: "Fatima Noor", jobTitle: "reviewer", department: "Security", manager: "Jordan Blake" },
  { displayName: "Sam Ortiz", jobTitle: "SRE lead", department: "SRE", manager: "Anika Rao" },
  { displayName: "Lena Fischer", jobTitle: "on-call lead", department: "SRE", manager: "Sam Ortiz" },
  { displayName: "Noor Haddad", jobTitle: "privacy counsel", department: "Privacy", manager: "Anika Rao" },
];

const STYLE = `body{font-family:system-ui,-apple-system,sans-serif;margin:0;background:#F6F6F2;color:#1E2026}main{max-width:560px;margin:48px auto;padding:0 20px}h1{font-size:22px;margin:0 0 6px}p{color:#4F5560;margin:0 0 18px;line-height:1.45}.card{background:#fff;border:1px solid #DADAD3;border-radius:10px;padding:18px 20px;margin-bottom:12px;display:flex;justify-content:space-between;align-items:center;gap:12px}.who{display:flex;flex-direction:column;gap:2px}.who b{font-weight:600}.who span{color:#4F5560;font-size:14px}button{font:inherit;height:40px;padding:0 16px;border-radius:8px;border:1px solid #C9C9C1;background:#fff;cursor:pointer}button.primary{background:#1E2026;color:#fff;border-color:#1E2026}.tag{display:inline-block;font-size:12px;color:#4F5560;border:1px solid #DADAD3;border-radius:999px;padding:2px 10px;margin-bottom:16px}ul{color:#4F5560;line-height:1.5}`;

export function escapeHtml(s: string): string { return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string)); }

/** The sign-in page: pick a person. Looks like a company sign-in, says it is the demo. */
export function demoLoginPage(next: string): string {
  const rows = DEMO_PERSONAS.map((p) => `<form method="post" action="/auth/login" class="card"><input type="hidden" name="persona" value="${p.id}"><input type="hidden" name="next" value="${escapeHtml(next)}"><div class="who"><b>${escapeHtml(p.name)}</b><span>${escapeHtml(p.title)} · ${escapeHtml(p.email)}</span></div><button type="submit" class="primary">Sign in</button></form>`).join("");
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in · Sample Co</title><style>${STYLE}</style><main><span class="tag">Demo identity provider · stands in for Microsoft Entra ID</span><h1>Sign in to Sample Co</h1><p>Pick who to sign in as. Each person keeps their own plans, decisions and connections, as they would with the company's real sign-in.</p>${rows}</main>`;
}

/** The directory consent page: what Entra's admin-consent prompt would show for the Graph scope. */
export function demoDirectoryConsentPage(scopes: string[], popup: boolean): string {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Permissions requested · Sample Co</title><style>${STYLE}</style><main><span class="tag">Demo identity provider · stands in for Microsoft Entra ID</span><h1>Permissions requested</h1><p><b>Throughline</b> wants to read your organisation's directory on your behalf (${escapeHtml(scopes.join(", "))}):</p><ul><li>Names, titles and departments of everyone at Sample Co</li><li>Who reports to whom</li></ul><p>It cannot change anything, and it keeps a snapshot, not a token.</p><form method="post" action="/auth/directory/entra/callback${popup ? "?popup=1" : ""}" style="display:flex;gap:10px"><button type="submit" name="decision" value="accept" class="primary">Accept</button><button type="submit" name="decision" value="cancel">Cancel</button></form></main>`;
}
