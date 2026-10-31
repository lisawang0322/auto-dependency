#!/usr/bin/env python3
"""Score release-starter outputs against the early-stage answer key (PRD success metric: suggested teams in
the key ≥ 80%; building coverage and approvals as expected).

    python3 eval/score_starter.py --key eval/answer-key.starter.ingest-142.json runs/<slug>/<date>.starting.json [runs/<EPIC>/<date>.building.json ...]

Per file: for a starting run, signal recall, team recall (target ≥ 80%) and precision, role agreement,
approvals found, contacts; for a building run, each team's coverage state and each approval's state and
ticket against the key, and whether a noise ticket was cited. Several files of the same stage are compared
run to run. Exit code 1 when a target is missed.
"""
import argparse
import json
import re
import sys


def norm(s):
    return re.sub(r"\s+", " ", (s or "")).strip().lower()


def score_starting(key, st):
    signals = st["signals"]
    sig_found = {e["id"]: next((s["id"] for s in signals if norm(e["quote_contains"]) in norm(s["quote"])), None) for e in key["signals"]}
    noise_hit = [n["quote_contains"] for n in key.get("noise_sentences", []) if any(norm(n["quote_contains"]) in norm(s["quote"]) for s in signals)]
    key_teams = {t["team"]: t["role"] for t in key["teams_to_involve"]}
    got = {t["team"]: t["role"] for t in st["teams"]}
    found = [t for t in key_teams if t in got]
    extra = [t for t in got if t not in key_teams]
    roles_ok = [t for t in found if got[t] == key_teams[t]]
    approvals = [a["name"] for a in st["approvals"]]
    appr_found = [a for a in key["approvals"] if a in approvals]
    contacts = {t["team"]: t["contact"] for t in st["teams"]}
    contacts_ok = {t: (contacts.get(t) or "").startswith(name) for t, name in key.get("contacts", {}).items()}
    return {
        "signal_recall": sum(1 for v in sig_found.values() if v) / len(sig_found), "sig_found": sig_found, "noise_hit": noise_hit,
        "team_recall": len(found) / len(key_teams), "team_precision": len(found) / len(got) if got else 1.0, "extra": extra,
        "roles_ok": len(roles_ok), "approval_recall": len(appr_found) / len(key["approvals"]), "contacts_ok": contacts_ok,
        "actions": len(st["next_actions"]), "actions_complete": all(a.get("text") and a.get("who") and a.get("when") and a.get("why") for a in st["next_actions"]),
        "signature": sorted((t["team"], t["role"]) for t in st["teams"]) + sorted(approvals),
    }


def score_building(key, st):
    kb = key["building"]
    cov = {c["team"]: c["state"] for c in st["coverage"]}
    cov_ok = {t: cov.get(t) == s for t, s in kb["coverage"].items()}
    appr = {a["name"]: a for a in st["approval_status"]}
    appr_ok = {n: (appr.get(n, {}).get("state") == e["state"] and appr.get(n, {}).get("ticket") == e["ticket"]) for n, e in kb["approvals"].items()}
    noise = {n["key"] for n in kb.get("noise", [])}
    cited = sorted({k for c in st["coverage"] for k in c["tickets"] if k in noise} | {a["ticket"] for a in st["approval_status"] if a["ticket"] in noise})
    return {
        "epic_ok": st.get("epic") == kb["epic"], "cov_ok": cov_ok, "cov": cov, "appr_ok": appr_ok, "appr": {n: (a["state"], a["ticket"]) for n, a in appr.items()},
        "cites_noise": cited, "actions": len(st["next_actions"]),
        "signature": sorted(cov.items()) + sorted((n, a["state"], a["ticket"]) for n, a in appr.items()),
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--key", required=True)
    ap.add_argument("files", nargs="+")
    ap.add_argument("--team-target", type=float, default=0.80)
    args = ap.parse_args()
    key = json.load(open(args.key))
    ok = True
    sigs = {"starting": [], "building": []}
    print(f"Answer key: {key['project']} · {len(key['teams_to_involve'])} teams · {len(key['approvals'])} approvals · building on {key['building']['epic']} @ {key['building']['snapshot']}\n")
    for path in args.files:
        st = json.load(open(path))
        print(f"== {path} ({st['stage']})")
        if st["stage"] == "starting":
            r = score_starting(key, st)
            sigs["starting"].append(r["signature"])
            print(f"   signals   {r['signal_recall']:.0%} of key signals found" + (f"; noise sentence(s) picked up: {r['noise_hit']}" if r["noise_hit"] else ""))
            print(f"   teams     recall {r['team_recall']:.0%}  target ≥ {args.team_target:.0%}  {'OK' if r['team_recall'] >= args.team_target else 'MISS'} · precision {r['team_precision']:.0%}" + (f" · extra: {', '.join(r['extra'])}" if r["extra"] else ""))
            print(f"   roles     {r['roles_ok']}/{len(key['teams_to_involve'])} as in the key · approvals {r['approval_recall']:.0%} · contacts {sum(r['contacts_ok'].values())}/{len(r['contacts_ok'])} · {r['actions']} actions{'' if r['actions_complete'] else ' (SOME INCOMPLETE)'}")
            ok = ok and r["team_recall"] >= args.team_target and r["actions_complete"] and not r["noise_hit"]
        else:
            r = score_building(key, st)
            sigs["building"].append(r["signature"])
            bad_cov = [t for t, v in r["cov_ok"].items() if not v]
            bad_appr = [n for n, v in r["appr_ok"].items() if not v]
            print(f"   epic      {'OK' if r['epic_ok'] else 'WRONG'}")
            print(f"   coverage  {sum(r['cov_ok'].values())}/{len(r['cov_ok'])} teams as in the key" + (f" · differs: {', '.join(f'{t}={r['cov'].get(t)}' for t in bad_cov)}" if bad_cov else ""))
            print(f"   approvals {sum(r['appr_ok'].values())}/{len(r['appr_ok'])} as in the key" + (f" · differs: {', '.join(f'{n}={r['appr'].get(n)}' for n in bad_appr)}" if bad_appr else ""))
            if r["cites_noise"]:
                print(f"   cites noise tickets: {', '.join(r['cites_noise'])}")
            print(f"   {r['actions']} actions")
            ok = ok and r["epic_ok"] and not bad_cov and not bad_appr and not r["cites_noise"]
        print()
    for stage, s in sigs.items():
        if len(s) > 1:
            same = all(x == s[0] for x in s)
            print(f"Run-to-run ({stage}): {'identical' if same else 'DIFFERENT'} across {len(s)} runs")
            ok = ok and same
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
