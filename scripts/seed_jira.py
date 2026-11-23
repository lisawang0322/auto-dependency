#!/usr/bin/env python3
"""Seed a SANDBOX Jira Cloud site with the fixture's Jira snapshot, through the Jira REST API v3.

This is the one place in the repository that writes to Jira. It refuses to run unless
JIRA_SANDBOX=yes is set, and it is meant for a free, throwaway Jira Cloud site.

    JIRA_SANDBOX=yes JIRA_SITE=https://<you>.atlassian.net JIRA_EMAIL=<email> JIRA_API_TOKEN=<token> \
      .venv/bin/python scripts/seed_jira.py --snapshot fixtures/ingest-142/jira/2026-11-13 --out out/key-map.json

Options:
    --snapshot DIR   fixture snapshot folder (projects.json + issues/*.json). Default: the Nov 13 snapshot.
    --out FILE       where to write the key mapping JSON (fixture key -> created key). Default: out/key-map.json.
    --key-prefix P   prefix every project key (Jira project keys are unique per site; use this to seed twice).
    --dry-run        print what would be created, call nothing.

What it creates: the projects (INGEST, DATA, SEC, SRE, plus the decoys SRETOOLS and SECOPS) with their
descriptions, project categories (best effort), components and fix versions; every issue with summary,
description, type, due date, components, fix version, and parent (stories under the epic); the status via
workflow transitions; the issue links; the comments, with issue keys inside comment bodies rewritten to the
created keys. It prints the mapping from fixture keys to created keys, because Jira assigns its own numbers.

What it cannot do: Jira sets created/updated timestamps and comment dates itself (they will be "now"); the
fictional assignees are not users on your site, so issues are left unassigned; the default workflow may lack
statuses such as "In Review" or "Closed", in which case the nearest status is used and reported in the
mapping file under status_fallbacks. scripts/compare_runs.py knows how to read that file.
"""
import argparse
import base64
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

KEY_RE = re.compile(r"\b([A-Z][A-Z0-9]+)-(\d+)\b")

# Nearest status when the workflow lacks the fixture's status (tried in order).
STATUS_FALLBACKS = {
    "Open": ["To Do", "Backlog", "Open"],
    "To Do": ["To Do", "Backlog", "Open"],
    "In Progress": ["In Progress"],
    "In Review": ["In Review", "Review", "In Progress"],
    "Done": ["Done", "Closed"],
    "Closed": ["Closed", "Done"],
}

PROJECT_TEMPLATE = "com.pyxis.greenhopper.jira:gh-simplified-kanban-classic"  # company-managed kanban: To Do / In Progress / Done


class Jira:
    def __init__(self, site, email, token, dry_run=False):
        self.site = site.rstrip("/")
        self.auth = base64.b64encode(f"{email}:{token}".encode()).decode()
        self.dry_run = dry_run
        self.calls = 0

    def call(self, method, path, body=None, ok=(200, 201, 204)):
        url = f"{self.site}/rest/api/3{path}"
        if self.dry_run and method != "GET":
            print(f"  [dry-run] {method} {path} {json.dumps(body)[:160] if body else ''}")
            return {}
        data = json.dumps(body).encode() if body is not None else None
        for attempt in range(5):
            req = urllib.request.Request(url, data=data, method=method)
            req.add_header("Authorization", f"Basic {self.auth}")
            req.add_header("Accept", "application/json")
            if data is not None:
                req.add_header("Content-Type", "application/json")
            try:
                with urllib.request.urlopen(req, timeout=60) as resp:
                    self.calls += 1
                    raw = resp.read()
                    return json.loads(raw) if raw else {}
            except urllib.error.HTTPError as e:
                text = e.read().decode(errors="replace")
                if e.code == 429 or e.code >= 500:
                    wait = 2 ** attempt
                    print(f"  HTTP {e.code}, retrying in {wait}s", file=sys.stderr)
                    time.sleep(wait)
                    continue
                raise RuntimeError(f"{method} {path} -> HTTP {e.code}: {text[:400]}") from None
        raise RuntimeError(f"{method} {path}: gave up after retries")


def adf(text):
    """A plain-text body as Atlassian Document Format, one paragraph per line."""
    paras = []
    for line in (text or "").split("\n"):
        paras.append({"type": "paragraph", "content": ([{"type": "text", "text": line}] if line else [])})
    return {"type": "doc", "version": 1, "content": paras or [{"type": "paragraph", "content": []}]}


def load_snapshot(d):
    projects = json.load(open(os.path.join(d, "projects.json")))
    issues = []
    idir = os.path.join(d, "issues")
    for f in sorted(os.listdir(idir)):
        if f.endswith(".json"):
            issues.append(json.load(open(os.path.join(idir, f))))
    return projects, issues


def issue_sort_key(i):
    """Epics first, then by project and number, so parents exist before children."""
    proj, num = i["key"].rsplit("-", 1)
    return (0 if (i["fields"].get("issuetype") or {}).get("name") == "Epic" else 1, proj, int(num))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--snapshot", default="fixtures/ingest-142/jira/2026-11-13")
    ap.add_argument("--out", default="out/key-map.json")
    ap.add_argument("--key-prefix", default="")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    if os.environ.get("JIRA_SANDBOX") != "yes":
        print("Refusing to run: set JIRA_SANDBOX=yes to confirm this is a throwaway sandbox site. This script writes to Jira.", file=sys.stderr)
        sys.exit(2)
    site, email, token = os.environ.get("JIRA_SITE"), os.environ.get("JIRA_EMAIL"), os.environ.get("JIRA_API_TOKEN")
    if not args.dry_run and not (site and email and token):
        print("Set JIRA_SITE (https://<you>.atlassian.net), JIRA_EMAIL and JIRA_API_TOKEN.", file=sys.stderr)
        sys.exit(2)
    jira = Jira(site or "https://example.atlassian.net", email or "x", token or "x", dry_run=args.dry_run)

    projects, issues = load_snapshot(args.snapshot)
    issues.sort(key=issue_sort_key)
    pkey = lambda k: f"{args.key_prefix}{k}"  # noqa: E731
    print(f"Seeding {len(projects)} projects and {len(issues)} issues from {args.snapshot} into {jira.site}{' (dry run)' if args.dry_run else ''}")

    me = jira.call("GET", "/myself") if not args.dry_run else {"accountId": "<me>"}
    lead = me["accountId"]

    # 1. Project categories (best effort: needs admin; the matcher only uses them as a hint)
    cat_ids = {}
    if not args.dry_run:
        try:
            for c in jira.call("GET", "/projectCategory"):
                cat_ids[c["name"]] = c["id"]
        except RuntimeError as e:
            print(f"  project categories not readable ({e}); continuing without", file=sys.stderr)

    # 2. Projects, components, versions
    version_ids = {}   # (projectKey, name) -> id
    comp_ids = {}      # (projectKey, name) -> id
    for p in projects:
        key = pkey(p["key"])
        body = {"key": key, "name": p["name"], "projectTypeKey": "software", "projectTemplateKey": PROJECT_TEMPLATE,
                "leadAccountId": lead, "assigneeType": "UNASSIGNED", "description": p.get("description") or ""}
        cat = (p.get("projectCategory") or {}).get("name")
        if cat and not args.dry_run:
            if cat not in cat_ids:
                try:
                    cat_ids[cat] = jira.call("POST", "/projectCategory", {"name": cat, "description": "seeded"})["id"]
                except RuntimeError as e:
                    print(f"  could not create category {cat} ({e}); skipping", file=sys.stderr)
            if cat in cat_ids:
                body["categoryId"] = cat_ids[cat]
        print(f"  project {key} ({p['name']})")
        jira.call("POST", "/project", body)
    comps, vers = {}, {}
    for i in issues:
        pk = pkey(i["fields"]["project"]["key"])
        for c in i["fields"].get("components") or []:
            comps.setdefault((pk, c["name"]), None)
        for v in i["fields"].get("fixVersions") or []:
            vers.setdefault((pk, v["name"]), v.get("releaseDate"))
    for (pk, name) in sorted(comps):
        r = jira.call("POST", "/component", {"name": name, "project": pk})
        comp_ids[(pk, name)] = r.get("id")
    for (pk, name), rd in sorted(vers.items()):
        body = {"name": name, "project": pk}
        if rd:
            body["releaseDate"] = rd
        r = jira.call("POST", "/version", body)
        version_ids[(pk, name)] = r.get("id")
    print(f"  {len(comps)} components, {len(vers)} versions")

    # 3. Issues (epics first), with the key mapping
    key_map = {}
    status_fallbacks = {}
    for i in issues:
        f = i["fields"]
        pk = pkey(f["project"]["key"])
        itype = (f.get("issuetype") or {}).get("name") or "Task"
        fields = {"project": {"key": pk}, "issuetype": {"name": itype}, "summary": f["summary"]}
        if f.get("description"):
            fields["description"] = adf(f["description"] if isinstance(f["description"], str) else json.dumps(f["description"]))
        if f.get("duedate"):
            fields["duedate"] = f["duedate"]
        if f.get("components"):
            fields["components"] = [{"name": c["name"]} for c in f["components"]]
        if f.get("fixVersions"):
            fields["fixVersions"] = [{"name": v["name"]} for v in f["fixVersions"]]
        parent = (f.get("parent") or {}).get("key")
        if parent:
            if parent not in key_map:
                print(f"  {i['key']}: parent {parent} not created yet; created without parent", file=sys.stderr)
            else:
                fields["parent"] = {"key": key_map[parent]}
        r = jira.call("POST", "/issue", {"fields": fields})
        new_key = r.get("key") or f"{pk}-{i['key'].rsplit('-', 1)[1]}"
        key_map[i["key"]] = new_key
        # status via transitions
        want = (f.get("status") or {}).get("name") or "To Do"
        got = want
        if not args.dry_run and want not in ("To Do",):
            trans = jira.call("GET", f"/issue/{new_key}/transitions").get("transitions", [])
            by_name = {t["to"]["name"].lower(): t for t in trans}
            chosen = None
            for cand in STATUS_FALLBACKS.get(want, [want]):
                if cand.lower() in by_name:
                    chosen = by_name[cand.lower()]
                    break
            if chosen:
                body = {"transition": {"id": chosen["id"]}}
                res = (f.get("resolution") or {}).get("name")
                if res:
                    try:
                        jira.call("POST", f"/issue/{new_key}/transitions", {**body, "fields": {"resolution": {"name": res}}})
                    except RuntimeError:
                        jira.call("POST", f"/issue/{new_key}/transitions", body)
                else:
                    jira.call("POST", f"/issue/{new_key}/transitions", body)
                got = chosen["to"]["name"]
            else:
                got = "To Do"
                print(f"  {new_key}: no transition to '{want}' (available: {sorted(by_name)}); left as created", file=sys.stderr)
        if got != want:
            status_fallbacks[want] = got
        print(f"  {i['key']} -> {new_key}  {itype:5} {want}{'' if got == want else ' (as ' + got + ')'}")

    def remap_text(text):
        return KEY_RE.sub(lambda m: key_map.get(m.group(0), m.group(0)), text or "")

    # 4. Links (deduplicated; each side of a link lists it)
    seen = set()
    for i in issues:
        for l in i["fields"].get("issuelinks") or []:
            tname = l["type"]["name"]
            if l.get("inwardIssue"):
                inward, outward = i["key"], l["inwardIssue"]["key"]
            elif l.get("outwardIssue"):
                inward, outward = l["outwardIssue"]["key"], i["key"]
            else:
                continue
            sig = (tname, key_map.get(outward, outward), key_map.get(inward, inward))
            if sig in seen or outward not in key_map or inward not in key_map:
                continue
            seen.add(sig)
            jira.call("POST", "/issueLink", {"type": {"name": tname}, "inwardIssue": {"key": key_map[inward]}, "outwardIssue": {"key": key_map[outward]}})
    print(f"  {len(seen)} links")

    # 5. Comments, in date order, with keys rewritten
    n = 0
    for i in issues:
        for c in sorted((i["fields"].get("comment") or {}).get("comments") or [], key=lambda c: c.get("created", "")):
            body = c["body"] if isinstance(c["body"], str) else json.dumps(c["body"])
            jira.call("POST", f"/issue/{key_map[i['key']]}/comment", {"body": adf(remap_text(body))})
            n += 1
    print(f"  {n} comments")

    out = {
        "site": jira.site, "snapshot": args.snapshot, "seeded_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "key_prefix": args.key_prefix, "keys": key_map, "status_fallbacks": status_fallbacks,
        "not_seeded": ["created/updated timestamps and comment dates (Jira sets them)", "assignees (fictional people are not users on the site)"],
    }
    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    with open(args.out, "w") as fh:
        json.dump(out, fh, indent=2)
    print(f"\nKey mapping (fixture -> created), also in {args.out}:")
    for k, v in key_map.items():
        print(f"  {k:12} -> {v}")
    if status_fallbacks:
        print("Status fallbacks (fixture status -> status used):", status_fallbacks)
    print(f"{jira.calls} REST calls.")


if __name__ == "__main__":
    main()
