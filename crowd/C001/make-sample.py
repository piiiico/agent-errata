#!/usr/bin/env python3
"""Builds sample.tsv for C001: every cs.CL / cs.AI paper first submitted to arXiv in
September 2026 (arXiv API, https), then the 100 with the smallest sha256(SEED + id).
Re-running it gives the same 100 as long as arXiv's listing for September is unchanged."""
import hashlib, re, sys, time, urllib.request, urllib.parse

SEED = "C001-2026-10-07"
N, PER_SLICE = 100, 4
Q = "(cat:cs.CL OR cat:cs.AI) AND submittedDate:[202609010000 TO 202609302359]"

def page(start):
    url = "https://export.arxiv.org/api/query?" + urllib.parse.urlencode(
        {"search_query": Q, "start": start, "max_results": 1000, "sortBy": "submittedDate", "sortOrder": "ascending"})
    for attempt in range(5):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "C001-sample/1 (pico@amdal.dev)"}), timeout=120) as r:
                return r.read().decode()
        except Exception as e:
            print("retry", start, e, file=sys.stderr); time.sleep(10)
    raise SystemExit("arXiv API failed")

papers, total, start = {}, None, 0
while True:
    xml = page(start)
    if total is None:
        total = int(re.search(r"<opensearch:totalResults[^>]*>(\d+)<", xml).group(1))
    entries = re.findall(r"<entry>(.*?)</entry>", xml, re.S)
    for e in entries:
        m = re.search(r"<id>https?://arxiv\.org/abs/([0-9]{4}\.[0-9]{4,5})v\d+</id>", e)
        if not m: continue
        pid = m.group(1)
        if not pid.startswith("2609."): continue  # new submissions in Sept 2026 only, no old-id replacements
        title = re.sub(r"\s+", " ", re.search(r"<title>(.*?)</title>", e, re.S).group(1)).strip()
        cat = re.search(r'<arxiv:primary_category[^>]*term="([^"]+)"', e)
        papers[pid] = (title, cat.group(1) if cat else "")
    print(f"start={start} got={len(entries)} kept={len(papers)} total={total}", file=sys.stderr)
    start += 1000
    if start >= total or not entries: break
    time.sleep(4)

if len(papers) < 1000:
    raise SystemExit(f"population floor: only {len(papers)} papers parsed, expected thousands")
ranked = sorted(papers, key=lambda p: hashlib.sha256((SEED + p).encode()).hexdigest())[:N]
ranked.sort()
with open("sample.tsv", "w") as f:
    f.write(f"# C001 sample: {N} of {len(papers)} cs.CL/cs.AI papers with a 2609.* id (arXiv API, {time.strftime('%Y-%m-%d %H:%M', time.gmtime())} UTC), seed {SEED}\n")
    f.write("slice\tarxiv\tprimary\ttitle\n")
    for i, p in enumerate(ranked):
        f.write(f"{i // PER_SLICE + 1:02d}\t{p}\t{papers[p][1]}\t{papers[p][0]}\n")
print(f"population={len(papers)} sample={N}")
