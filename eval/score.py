#!/usr/bin/env python3
"""Score one or more findings.json files against an answer key (PRD success metrics).

    python3 eval/score.py --key eval/answer-key.ingest-142.json run1/findings.json [run2/findings.json ...]
                          [--key-map out/key-map.json]

Prints, per run and overall:
  recall           key gaps found by any finding in the run (shown or hidden)      target ≥ 80%
  precision        shown findings that are in the key                             target ≥ 70%
  blocker          the key's unlinked blocker(s) appear as a linkage gap           must hold in every run
  differences      what differs between runs (finding set, strengths, visibility)
A finding matches a key entry when the gap types are equal and either the plan item ids are equal or the
key's plan_quote_contains phrase occurs in the finding's plan_quote. --key-map (from scripts/seed_jira.py)
maps sandbox keys back to fixture keys first. Exit code 1 when any target is missed.
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


def norm(s):
    return re.sub(r"\s+", " ", (s or "")).strip().lower()


def matches(entry, finding):
    if entry["gap_type"] != finding["gap_type"]:
        return False
    if entry.get("plan_item_id") and entry["plan_item_id"] == finding.get("plan_item_id"):
        return True
    phrase = norm(entry.get("plan_quote_contains"))
    return bool(phrase) and phrase in norm(finding.get("plan_quote") or finding.get("title"))


def score_run(key, run):
    findings = run["findings"]
    shown = [f for f in findings if f.get("shown", f.get("strength") != "weak")]
    noise_keys = {n["key"] for n in key.get("noise", [])}
    found, strength_ok = {}, {}
    for e in key["gaps"]:
        hit = next((f for f in findings if matches(e, f)), None)
        found[e["id"]] = hit["id"] if hit else None
        strength_ok[e["id"]] = (hit["strength"] == e["expected_strength"]) if hit else None
    in_key = [f for f in shown if any(matches(e, f) for e in key["gaps"])]
    false_pos = [f for f in shown if f not in in_key]
    cites_noise = [f["id"] for f in findings if any(ev["key"] in noise_keys for ev in f.get("evidence", []) if not ev.get("meta", "").endswith("not counted"))]
    gaps = {(g["from"], g["to"]) for g in run.get("linkage_gaps", [])}
    for f in findings:
        if f.get("linkage"):
            gaps.add((f["linkage"]["from"], f["linkage"]["to"]))
    blockers = [g for g in key["linkage_gaps"] if g.get("blocker")]
    blocker_ok = all((g["from"], g["to"]) in gaps for g in blockers)
    other_links = [g for g in key["linkage_gaps"] if not g.get("blocker")]
    other_ok = sum(1 for g in other_links if (g["from"], g["to"]) in gaps)
    recall = sum(1 for v in found.values() if v) / len(key["gaps"]) if key["gaps"] else 1.0
    precision = len(in_key) / len(shown) if shown else 1.0
    return {
        "recall": recall, "precision": precision, "found": found, "strength_ok": strength_ok,
        "shown": len(shown), "in_key": len(in_key), "false_pos": [(f["id"], f["plan_item_id"], f["gap_type"], f["title"]) for f in false_pos],
        "cites_noise": cites_noise, "blocker_ok": blocker_ok, "blockers": blockers, "other_links": (other_ok, len(other_links)),
        "signature": sorted((f["plan_item_id"], f["gap_type"], f["strength"], bool(f.get("shown", f["strength"] != "weak"))) for f in findings),
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--key", required=True)
    ap.add_argument("runs", nargs="+")
    ap.add_argument("--key-map", help="scripts/seed_jira.py output; sandbox keys are mapped back to fixture keys")
    ap.add_argument("--recall-target", type=float, default=0.80)
    ap.add_argument("--precision-target", type=float, default=0.70)
    args = ap.parse_args()

    key = json.load(open(args.key))
    back = {}
    if args.key_map:
        km = json.load(open(args.key_map))
        back = {v: k for k, v in km.get("keys", km).items()}
    results = []
    for path in args.runs:
        run = remap(json.load(open(path)), back)
        if run.get("epic") and run["epic"] != key["release"]:
            print(f"warning: {path} is for epic {run['epic']}, the key is for {key['release']}")
        results.append((path, score_run(key, run)))

    ok = True
    print(f"Answer key: {key['release']} @ {key['snapshot']} · {len(key['gaps'])} seeded gaps · {len([g for g in key['linkage_gaps'] if g.get('blocker')])} unlinked blocker(s) · {len(results)} run(s)\n")
    for path, r in results:
        print(f"== {path}")
        print(f"   recall    {r['recall']:.0%}  ({sum(1 for v in r['found'].values() if v)}/{len(r['found'])} key gaps found)   target ≥ {args.recall_target:.0%}  {'OK' if r['recall'] >= args.recall_target else 'MISS'}")
        print(f"   precision {r['precision']:.0%}  ({r['in_key']}/{r['shown']} shown findings are in the key)   target ≥ {args.precision_target:.0%}  {'OK' if r['precision'] >= args.precision_target else 'MISS'}")
        print(f"   blocker   {'OK' if r['blocker_ok'] else 'MISSING'}  " + ", ".join(f"{g['from']} → {g['to']}" for g in r["blockers"]))
        print(f"   other linkage gaps: {r['other_links'][0]}/{r['other_links'][1]}")
        for e in key["gaps"]:
            fid = r["found"][e["id"]]
            s_ok = r["strength_ok"][e["id"]]
            print(f"     {e['id']} {e['gap_type']:15} {e['plan_item_id']:3} {'found as ' + fid if fid else 'NOT FOUND':14} " + ("" if fid is None else ("strength as expected" if s_ok else f"strength differs (expected {e['expected_strength']})")))
        for fp in r["false_pos"]:
            print(f"     false positive: {fp[0]} {fp[1]} {fp[2]}: {fp[3]}")
        if r["cites_noise"]:
            print(f"     cites noise tickets: {', '.join(r['cites_noise'])}")
        ok = ok and r["recall"] >= args.recall_target and r["precision"] >= args.precision_target and r["blocker_ok"]
        print()

    if len(results) > 1:
        sigs = [r["signature"] for _, r in results]
        if all(s == sigs[0] for s in sigs):
            print("Run-to-run: identical finding sets (plan item, gap type, strength, shown) in all runs.")
        else:
            print("Run-to-run differences:")
            union = sorted({tuple(x) for s in sigs for x in s})
            for x in union:
                runs_with = [str(i + 1) for i, s in enumerate(sigs) if list(x) in [list(y) for y in s]]
                if len(runs_with) != len(sigs):
                    print(f"   {x[0]} {x[1]} {x[2]} {'shown' if x[3] else 'hidden'}: only in run(s) {', '.join(runs_with)}")
            ok = False
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
