"""Replicate agentforscience/few-shot-ordering-effects H4 (best-worst order gap, MNLI vs SST-2, K=4)
on Qwen3.6-35B-A3B (Hetzner inference, chat API, thinking off). Uses the repo's own design.json
(same demo sets, same permutations, same test items) and its tasks.py prompt templates.
Resumable: appends one JSON line per scored prompt to out.jsonl; skips keys already present.
Deviation from the original: chat template + label scored from top-5 logprobs of the FIRST
assistant token (case-folded, leading space stripped), not raw-completion label-restricted logprobs.
"""
import json, os, sys, time, math, urllib.request
sys.path.insert(0, "/workspace/tmp/pylib"); sys.path.insert(0, "/workspace/tmp/fso/src")
os.chdir("/workspace/tmp/fso")
import tasks  # repo's own loaders/templates
MODEL = "Qwen/Qwen3.6-35B-A3B-FP8"
SETS = [int(x) for x in os.environ.get("SETS", "0,1").split(",")]
N_ITEMS = int(os.environ.get("N_ITEMS", "50"))
DEADLINE = time.time() + float(os.environ.get("RUN_SECS", "3000"))
OUT = "/workspace/tmp/a4s-repl/out.jsonl"
env = dict(l.strip().split("=", 1) for l in open("/workspace/.secrets/hetzner-inference.env") if l.startswith("HETZNER_"))
URL = env["HETZNER_INFERENCE_BASE_URL"].rstrip("/") + "/chat/completions"
done = set()
if os.path.exists(OUT):
    for l in open(OUT):
        try: r = json.loads(l); done.add(r["key"])
        except Exception: pass
design = json.load(open("results/design.json"))["cls"]
def call(prompt):
    body = json.dumps({"model": MODEL, "messages": [{"role": "user", "content": prompt}], "max_tokens": 1,
        "temperature": 0, "logprobs": True, "top_logprobs": 10, "chat_template_kwargs": {"enable_thinking": False}}).encode()
    for attempt in range(6):
        try:
            req = urllib.request.Request(URL, body, {"Authorization": "Bearer " + env["HETZNER_INFERENCE_TOKEN"], "Content-Type": "application/json", "User-Agent": "Pico/1.0 (AI agent; pico@amdal.dev)"})
            return json.load(urllib.request.urlopen(req, timeout=60))
        except urllib.error.HTTPError as e:
            time.sleep(15 if e.code == 429 else 5)
        except Exception:
            time.sleep(5)
    return None
jobs = []
for task in ["mnli", "sst2"]:  # interleave so a partial run still covers both tasks
    tr, te = tasks.load_cls(task)
    d = design[task]
    for c in d["conds"]:
        if c["K"] != 4 or c["set"] not in SETS: continue
        for pi, perm in enumerate(c["perms"]):
            demos = [tr.iloc[c["demos"][j]] for j in perm]
            for ti in d["test_idx"][:N_ITEMS]:
                jobs.append((task, c["set"], pi, ti, demos, te.iloc[ti]))
# order: item-major so every (task,set,perm) cell grows evenly
jobs.sort(key=lambda j: (j[3] if True else 0, j[0], j[1], j[2]))
labels = {t: [w.strip().lower() for w in tasks.CLS_TASKS[t]["labels"]] for t in ["mnli", "sst2"]}
n = 0
for task, s, pi, ti, demos, row in jobs:
    key = f"{task}|{s}|{pi}|{ti}"
    if key in done: continue
    if time.time() > DEADLINE: break
    t0 = time.time()
    r = call(tasks.cls_prompt(task, demos, row))
    if r is None: continue
    top = r["choices"][0]["logprobs"]["content"][0]["top_logprobs"]
    p = {w: 0.0 for w in labels[task]}
    for t in top:
        w = t["token"].strip().lower()
        if w in p: p[w] += math.exp(t["logprob"])
    pred = max(p, key=p.get) if max(p.values()) > 0 else None
    rec = {"key": key, "task": task, "set": s, "perm": pi, "item": ti, "gold": labels[task][int(row["label"])],
           "pred": pred, "p": p, "top1": top[0]["token"], "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    open(OUT, "a").write(json.dumps(rec) + "\n"); n += 1
    time.sleep(max(0, 6.2 - (time.time() - t0)))  # 10 req/60s key limit
print("scored", n, "this run; total", len(done) + n, "of", len(jobs))
