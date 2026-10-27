"""Same-cell comparison: demo set 0, K=4, the same 8 orders and the same test items, for our
Qwen3.6-35B-A3B rows (out.jsonl, set==0 only) and each Qwen2.5-Instruct size from the repo's own
raw parquet. Per cell: acc per order, range (best-worst), pairwise gap E|a_i-a_j|, and a within-item
order-shuffle null for the range (2000 draws). Paired bootstrap CI on our range."""
import sys, json, random, itertools
sys.path.insert(0, "/workspace/tmp/pylib")
import pandas as pd
rows = [json.loads(l) for l in open("/workspace/tmp/a4s-repl/out-set0.jsonl")]
ours = {}
for r in rows:
    if r["set"] != 0: continue
    ours.setdefault(r["task"], {})[(r["perm"], r["item"])] = int(r["pred"] == r["gold"])
def stats(d, items, seed=0):
    rnd = random.Random(seed)
    acc = lambda dd, its: [sum(dd[(p, i)] for i in its) / len(its) for p in range(8)]
    a = acc(d, items); rng = max(a) - min(a)
    pair = sum(abs(x - y) for x, y in itertools.combinations(a, 2)) / 28
    nulls = []
    for _ in range(2000):
        sh = {}
        for i in items:
            v = [d[(p, i)] for p in range(8)]; rnd.shuffle(v)
            for p in range(8): sh[(p, i)] = v[p]
        an = acc(sh, items); nulls.append(max(an) - min(an))
    nulls.sort(); p = sum(x >= rng - 1e-12 for x in nulls) / len(nulls)
    boots = sorted((lambda b: max(b) - min(b))(acc(d, [rnd.choice(items) for _ in items])) for _ in range(2000))
    return dict(n=len(items), mean_acc=sum(a)/8, acc=[round(x, 3) for x in a], range=rng, pair=pair,
                null_med=nulls[1000], null95=nulls[1900], p=p, boot=(boots[50], boots[1949]))
for task in ["mnli", "sst2"]:
    d = ours.get(task, {})
    items = sorted({i for _, i in d if all((p, i) in d for p in range(8))})
    s = stats(d, items)
    print(f"{task} Qwen3.6-35B-A3B n={s['n']} meanacc={s['mean_acc']*100:.1f} acc={s['acc']} range={s['range']*100:.1f} pair={s['pair']*100:.1f} null_med={s['null_med']*100:.1f} null95={s['null95']*100:.1f} p={s['p']:.3f} boot95=[{s['boot'][0]*100:.1f},{s['boot'][1]*100:.1f}]")
    for m in ["0.5B", "1.5B", "3B", "7B", "14B"]:
        df = pd.read_parquet(f"/workspace/tmp/fso/results/raw/Qwen2.5-{m}-Instruct_cls.parquet", columns=["task","K","set","perm","test_id","correct"])
        x = df[(df.task == task) & (df.K == 4) & (df.set == 0)]
        dd = {(int(r.perm), int(r.test_id)): int(r.correct) for r in x.itertuples()}
        its = [i for i in items if all((p, i) in dd for p in range(8))]
        s = stats(dd, its)
        print(f"{task} Qwen2.5-{m} n={s['n']} meanacc={s['mean_acc']*100:.1f} range={s['range']*100:.1f} pair={s['pair']*100:.1f} null_med={s['null_med']*100:.1f} p={s['p']:.3f}")
