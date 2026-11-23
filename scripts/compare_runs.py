#!/usr/bin/env python3
"""Compare a Devin-produced release.json (MCP mode, sandbox Jira) with the fixture-mode one.

    python3 scripts/compare_runs.py --devin out/release.json \
        --fixture fixtures/ingest-142/release.2026-11-13.json --key-map out/key-map.json

The key map is what scripts/seed_jira.py printed (fixture key -> sandbox key). Sandbox keys in the Devin
file are mapped back to fixture keys first (everywhere: keys, comment bodies, excerpts, JQL). Statuses the
sandbox workflow could not reproduce (key-map "status_fallbacks") are applied to the fixture side.

Compared: the epic; the story set and each story's summary, status, due, components and comment bodies;
the link set; related issues (how each was reached); search candidates (which key for which plan item);
projects searched. Ignored: read_at, snapshot_label, updated/created timestamps, assignees, JQL text and
warnings (counts are shown). Exit code 0 when nothing differs, 1 otherwise.
"""
import argparse
import json
import re
import sys

KEY_RE = re.compile(r"\b[A-Z][A-Z0-9]+-\d+\b")


def remap(obj, mapping):
    if isinstance(obj, str):
        return KEY_RE.sub(lambda m: mapping.get(m.group(0), m.group(0)), obj)
    if isinstance(obj, list):
        return [remap(x, mapping) for x in obj]
    if isinstance(obj, dict):
        return {k: remap(v, mapping) for k, v in obj.items()}
    return obj


def norm_text(s):
    return re.sub(r"\s+", " ", s or "").strip()


class Diff:
    def __init__(self):
        self.lines = []

    def add(self, section, msg):
        self.lines.append(f"[{section}] {msg}")

    def compare_fields(self, section, label, a, b, fields):
        for f in fields:
            va, vb = a.get(f), b.get(f)
            if isinstance(va, str) and isinstance(vb, str):
                va, vb = norm_text(va), norm_text(vb)
            if va != vb:
                self.add(section, f"{label}.{f}: fixture={va!r} devin={vb!r}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--devin", required=True)
    ap.add_argument("--fixture", required=True)
    ap.add_argument("--key-map", required=True)
    args = ap.parse_args()

    fx = json.load(open(args.fixture))
    km = json.load(open(args.key_map))
    fwd = km.get("keys", km)
    back = {v: k for k, v in fwd.items()}
    dv = remap(json.load(open(args.devin)), back)
    fallbacks = km.get("status_fallbacks", {})

    def st(s):
        return fallbacks.get(s, s)

    d = Diff()

    # epic
    e_fx, e_dv = dict(fx["epic"]), dict(dv["epic"])
    e_fx["status"] = st(e_fx["status"])
    d.compare_fields("epic", fx["epic"]["key"], e_fx, e_dv, ["key", "summary", "status", "fix_version", "release_date", "due"])
    if sorted(e_fx["components"]) != sorted(e_dv["components"]):
        d.add("epic", f"components: fixture={sorted(e_fx['components'])} devin={sorted(e_dv['components'])}")

    # stories
    s_fx = {s["key"]: s for s in fx["stories"]}
    s_dv = {s["key"]: s for s in dv["stories"]}
    for k in sorted(set(s_fx) - set(s_dv)):
        d.add("stories", f"{k} missing in devin")
    for k in sorted(set(s_dv) - set(s_fx)):
        d.add("stories", f"{k} extra in devin")
    for k in sorted(set(s_fx) & set(s_dv)):
        a, b = dict(s_fx[k]), s_dv[k]
        a["status"] = st(a["status"])
        d.compare_fields("stories", k, a, b, ["summary", "status", "due"])
        if sorted(a["components"]) != sorted(b["components"]):
            d.add("stories", f"{k}.components: fixture={sorted(a['components'])} devin={sorted(b['components'])}")
        ca = [norm_text(c["body"]) for c in a["comments"]]
        cb = [norm_text(c["body"]) for c in b["comments"]]
        if sorted(ca) != sorted(cb):
            d.add("stories", f"{k}.comments differ: fixture has {len(ca)}, devin has {len(cb)}; missing={sorted(set(ca) - set(cb))[:3]} extra={sorted(set(cb) - set(ca))[:3]}")
        ma = sorted(set(sum((c["mentioned_keys"] for c in a["comments"]), [])))
        mb = sorted(set(sum((c["mentioned_keys"] for c in b["comments"]), [])))
        if ma != mb:
            d.add("stories", f"{k}.comment mentions: fixture={ma} devin={mb}")

    # links
    l_fx = {(l["from"], l["to"], l["type"], l["direction"]) for l in fx["links"]}
    l_dv = {(l["from"], l["to"], l["type"], l["direction"]) for l in dv["links"]}
    for l in sorted(l_fx - l_dv):
        d.add("links", f"missing in devin: {l}")
    for l in sorted(l_dv - l_fx):
        d.add("links", f"extra in devin: {l}")

    # related (one hop)
    r_fx = {r["key"]: r for r in fx["related"]}
    r_dv = {r["key"]: r for r in dv["related"]}
    for k in sorted(set(r_fx) - set(r_dv)):
        d.add("related", f"{k} missing in devin (fixture reached it by {r_fx[k]['reached_by']} via {r_fx[k]['via']['issue']})")
    for k in sorted(set(r_dv) - set(r_fx)):
        d.add("related", f"{k} extra in devin (reached by {r_dv[k]['reached_by']} via {r_dv[k]['via']['issue']})")
    for k in sorted(set(r_fx) & set(r_dv)):
        a, b = dict(r_fx[k]), r_dv[k]
        a["status"] = st(a["status"])
        d.compare_fields("related", k, a, b, ["project", "summary", "status", "due", "reached_by"])
        d.compare_fields("related", k + ".via", a["via"], b["via"], ["issue", "link_type"])

    # search candidates
    c_fx = {(c["key"], c["matched_plan_item_id"]): c for c in fx["search_candidates"]}
    c_dv = {(c["key"], c["matched_plan_item_id"]): c for c in dv["search_candidates"]}
    for k in sorted(set(c_fx) - set(c_dv)):
        d.add("search", f"{k[0]} for plan item {k[1]} missing in devin")
    for k in sorted(set(c_dv) - set(c_fx)):
        d.add("search", f"{k[0]} for plan item {k[1]} extra in devin ({c_dv[k]['summary']!r})")
    for k in sorted(set(c_fx) & set(c_dv)):
        a, b = dict(c_fx[k]), c_dv[k]
        a["status"] = st(a["status"])
        d.compare_fields("search", k[0], a, b, ["project", "summary", "status", "due"])

    # projects searched
    p_fx = sorted((p["team"], p["jira_project"]) for p in fx["projects_searched"])
    p_dv = sorted((p["team"], p["jira_project"]) for p in dv["projects_searched"])
    if p_fx != p_dv:
        d.add("projects_searched", f"fixture={p_fx} devin={p_dv}")

    # the required check from the PRD: the unlinked SRE blocker comes back from search
    sre = [c for c in fx["search_candidates"] if c["key"] == "SRE-412"]
    sre_key = fwd.get("SRE-412", "SRE-412")
    found = [c for c in dv["search_candidates"] if c["key"] == "SRE-412"]
    print(f"SRE-412 (sandbox {sre_key}) in search_candidates: {'YES' if found else 'NO'}" + (f" (plan item {found[0]['matched_plan_item_id']})" if found else ""))
    if sre and not found:
        d.add("search", f"SRE-412 ({sre_key}) is not in devin's search_candidates")

    print(f"warnings: fixture {len(fx['warnings'])}, devin {len(dv['warnings'])}")
    for w in dv["warnings"]:
        print(f"  devin warning: {w}")
    if fallbacks:
        print(f"status fallbacks applied to the fixture side: {fallbacks}")
    if d.lines:
        print(f"\n{len(d.lines)} difference(s):")
        for l in d.lines:
            print("  " + l)
        sys.exit(1)
    print("\nPASS: no differences apart from timestamps, assignees and JQL text.")


if __name__ == "__main__":
    main()
