"""Harness for the K001 blind run (written by Pico; not an implementation).
Usage: python3 compare.py <program.py> <inputs_dir_without_expected> <vectors_dir_with_expected> <out.json>
Runs the program once per vector (python3, 120 s timeout) on the inputs-only copy and compares the
eight core fields with expected.json. Exit 0 = 128/128, 1 = fewer, 2 = the program could not run at all."""
import json, os, subprocess, sys
CORE = ["contract_sha256", "verdict", "status", "bond_outcome", "deviation_codes",
        "underspecified_reasons", "event_set", "dispositions"]
prog, inputs, vectors, out = sys.argv[1:5]
names = sorted(n for n in os.listdir(vectors) if os.path.isdir(os.path.join(vectors, n)))
assert len(names) == 128, len(names)
assert not any(os.path.exists(os.path.join(inputs, n, "expected.json")) for n in names), "inputs copy holds expected.json"
res, agree, ran = {}, 0, 0
for n in names:
    exp = json.load(open(os.path.join(vectors, n, "expected.json")))
    try:
        p = subprocess.run([sys.executable, os.path.abspath(prog), os.path.join(inputs, n)],
                           capture_output=True, text=True, timeout=120)
        rc, so, se = p.returncode, p.stdout, p.stderr
    except subprocess.TimeoutExpired:
        rc, so, se = "timeout", "", ""
    try:
        got = json.loads(so)
        ran += isinstance(got, dict) and "error" not in got
    except Exception:
        got = None
    diff = [f for f in CORE if not isinstance(got, dict) or got.get(f) != exp[f]]
    agree += not diff
    res[n] = {"exit": rc, "diff": diff, "stderr_tail": se[-300:] if diff else ""}
    if diff:
        print("DIFF", n, " ".join(diff), f"exit={rc}")
json.dump({"program": prog, "agree": agree, "of": len(names), "produced_output": ran, "vectors": res}, open(out, "w"), indent=1)
print(f"{agree}/{len(names)} vectors agree on the eight core fields; {ran} produced a settlement")
sys.exit(0 if agree == len(names) else (2 if ran == 0 else 1))
