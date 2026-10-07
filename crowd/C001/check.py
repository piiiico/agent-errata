#!/usr/bin/env python3
"""C001 reference check. Python 3.8+, standard library only, no API keys.

  AGENT="<your name>" STACK="<harness / model / OS>" python3 check.py <slice>     # e.g. 07
  python3 check.py --paper 2609.12345                                            # one paper
  python3 check.py --selftest     # a made-up reference must come back unresolved, real ones found

For each paper in the slice it downloads the LaTeX source from arXiv, takes the
bibliography entries the paper actually cites, and tries to find each one in
arXiv, Semantic Scholar, Crossref and OpenAlex by identifier and by title. Every reference gets one
row: found, id_mismatch (the title exists but the arXiv id or DOI given points at
a different paper), unresolved (no record with a matching title anywhere we
looked), or skipped (no title, or a web page / software / dataset rather than a paper).

"unresolved" is NOT "fake": it means four open indexes had nothing with that
title. Each unresolved row is re-checked by hand by two other agents and by Pico
before anything is counted as a reference to a paper that does not exist.

Rows go to rows/<slice>.<agent>.jsonl and stdout. The last line is the summary.
"""
import difflib, gzip, threading, io, json, os, re, sys, tarfile, time, unicodedata, urllib.error, urllib.parse, urllib.request

VERSION = "c001-check/1"
UA = f"{VERSION} (crowd study; https://github.com/piiiico/agent-errata/tree/main/crowd/C001)"
MAILTO = os.environ.get("MAILTO", "pico@amdal.dev")
from concurrent.futures import ThreadPoolExecutor
HERE = os.path.dirname(os.path.abspath(__file__))
FOUND_SIM = 0.88
_last = {}

_lock = threading.Lock()

def polite(host, gap):
    # reserve the next free slot for this host; threads queue up behind each other
    with _lock:
        now = time.time()
        slot = max(now, _last.get(host, 0) + gap)
        _last[host] = slot
    if slot > now: time.sleep(slot - now)

def get(url, host, gap, binary=False, tries=4):
    for i in range(tries):
        polite(host, gap)
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA}), timeout=60) as r:
                data = r.read()
                return (200, data if binary else data.decode("utf-8", "replace"))
        except urllib.error.HTTPError as e:
            if e.code in (404, 400, 410): return (e.code, None)
            if e.code in (403,):  # a block is a block: report it, never route around it
                raise SystemExit(f"ABORT: {host} answered 403 for {url}. Stop and report this line; do not retry from elsewhere.")
            time.sleep((4 if e.code == 429 else 5) * (i + 1))
        except Exception:
            time.sleep(5 * (i + 1))
    return (0, None)

# ---------- LaTeX source ----------
def source_files(arxiv_id):
    code, blob = get(f"https://export.arxiv.org/e-print/{arxiv_id}", "arxiv", 3.1, binary=True)
    if code != 200 or not blob: return None, f"e-print http {code}"
    files = {}
    try:
        with tarfile.open(fileobj=io.BytesIO(blob), mode="r:*") as t:
            for m in t.getmembers():
                if m.isfile() and m.name.lower().endswith((".tex", ".bib", ".bbl")) and m.size < 20_000_000:
                    files[m.name] = t.extractfile(m).read().decode("utf-8", "replace")
        return files, "tar"
    except tarfile.TarError:
        pass
    try:
        raw = gzip.decompress(blob)
    except OSError:
        raw = blob
    if raw[:4] == b"%PDF": return None, "pdf only (no LaTeX source)"
    return {"main.tex": raw.decode("utf-8", "replace")}, "single"

def strip_comments(tex):
    return "\n".join(re.sub(r"(?<!\\)%.*", "", l) for l in tex.split("\n"))

def cite_keys(texs):
    keys = set()
    for t in texs:
        for m in re.finditer(r"\\[a-zA-Z]*cite[a-zA-Z]*\*?\s*(?:\[[^\]]*\]\s*){0,2}\{([^}]*)\}", strip_comments(t)):
            keys.update(k.strip() for k in m.group(1).split(",") if k.strip())
    return keys

def parse_bib(text):
    out, i, n = {}, 0, len(text)
    while True:
        m = re.compile(r"@\s*([a-zA-Z]+)\s*[{(]").search(text, i)
        if not m: break
        typ, j, depth = m.group(1).lower(), m.end(), 1
        k = j
        while k < n and depth:
            if text[k] == "{": depth += 1
            elif text[k] == "}": depth -= 1
            k += 1
        body, i = text[j:k - 1], k
        if typ in ("comment", "string", "preamble") or "," not in body: continue
        key, rest = body.split(",", 1)
        fields, p = {}, 0
        while True:
            fm = re.compile(r"\s*([a-zA-Z_\-]+)\s*=\s*").match(rest, p)
            if not fm: break
            name, p = fm.group(1).lower(), fm.end()
            if p < len(rest) and rest[p] == "{":
                d, q = 1, p + 1
                while q < len(rest) and d:
                    if rest[q] == "{": d += 1
                    elif rest[q] == "}": d -= 1
                    q += 1
                val, p = rest[p + 1:q - 1], q
            elif p < len(rest) and rest[p] == '"':
                q = p + 1
                while q < len(rest) and not (rest[q] == '"' and rest[q - 1] != "\\"): q += 1
                val, p = rest[p + 1:q], q + 1
            else:
                vm = re.compile(r"[^,]*").match(rest, p)
                val, p = vm.group(0), vm.end()
            fields[name] = val.strip()
            cm = re.compile(r"\s*,").match(rest, p)
            if not cm: break
            p = cm.end()
        out[key.strip()] = {"type": typ, **fields}
    return out

def parse_bbl(text):
    out = {}
    for chunk in re.split(r"\\bibitem", text)[1:]:
        m = re.match(r"\s*(?:\[(?:[^\[\]]|\[[^\]]*\])*\])?\s*\{([^}]*)\}(.*)", chunk, re.S)
        if not m: continue
        key, body = m.group(1).strip(), m.group(2)
        body = re.split(r"\\end\{thebibliography\}", body)[0]
        blocks = [b.strip() for b in re.split(r"\\newblock", body)]
        title = blocks[1] if len(blocks) > 1 else ""
        title = re.sub(r"^\\href\{[^}]*\}\{(.*)\}\s*\.?$", r"\1", title, flags=re.S)
        e = {"type": "bbl", "title": title.rstrip(". "), "author": blocks[0], "raw": " ".join(body.split())[:400]}
        am = re.search(r"(?:arXiv[:\s]*|arxiv\.org/abs/)(\d{4}\.\d{4,5})", body, re.I)
        if am: e["eprint"] = am.group(1)
        dm = re.search(r"(10\.\d{4,9}/[^\s},]+)", body)
        if dm: e["doi"] = dm.group(1)
        out[key] = e
    return out

# ---------- normalising ----------
def clean_latex(s):
    s = s or ""
    s = re.sub(r"\\(?:emph|textit|textbf|textsc|mathrm|mathbf|text|texttt|url|href\{[^}]*\})\s*", "", s)
    s = re.sub(r"\\[`'^\"~=.uvHtcdbk]\s*\{?([a-zA-Z])\}?", r"\1", s)
    s = re.sub(r"\\[a-zA-Z]+\*?", " ", s)
    s = s.replace("{", "").replace("}", "").replace("~", " ").replace("--", "-")
    return " ".join(s.split())

def norm(s):
    s = unicodedata.normalize("NFKD", clean_latex(s)).encode("ascii", "ignore").decode().lower()
    return " ".join(re.sub(r"[^a-z0-9]+", " ", s).split())

def sim(a, b):
    a, b = norm(a), norm(b)
    if not a or not b: return 0.0
    if a == b: return 1.0
    short, long_ = sorted((a, b), key=len)
    if len(short.split()) >= 4 and (long_.startswith(short + " ") or long_.endswith(" " + short)):
        return 0.95  # subtitle dropped on one side
    return round(difflib.SequenceMatcher(None, a, b).ratio(), 3)

def arxiv_id_of(e):
    if e.get("eprint") and re.match(r"^\d{4}\.\d{4,5}", e["eprint"]): return e["eprint"][:10].rstrip("v")
    blob = " ".join(e.get(f, "") for f in ("journal", "url", "note", "howpublished", "volume", "booktitle", "doi"))
    m = re.search(r"(?:arxiv[^0-9]{0,20}|abs/|10\.48550/arxiv\.)(\d{4}\.\d{4,5})", blob, re.I)
    return m.group(1) if m else None

def doi_of(e):
    d = e.get("doi", "") or ""
    m = re.search(r"10\.\d{4,9}/\S+", d + " " + e.get("url", ""))
    return m.group(0).rstrip(".},") if m else None

def is_not_paper(e):
    t = e.get("type", "")
    if t in ("software", "online", "electronic", "www", "dataset", "manual"): return True
    # @misc with no arXiv id, no DOI and no venue is almost always a blog post, model card or web page
    return t == "misc" and not arxiv_id_of(e) and not doi_of(e) and not any(
        e.get(f) for f in ("journal", "booktitle", "publisher", "institution", "school"))

# ---------- resolvers ----------
def arxiv_titles(ids):
    found = {}
    ids = sorted(set(ids))
    for k in range(0, len(ids), 50):
        q = urllib.parse.urlencode({"id_list": ",".join(ids[k:k + 50]), "max_results": 50})
        code, xml = get(f"https://export.arxiv.org/api/query?{q}", "arxiv", 3.1)
        if code != 200 or not xml: continue
        for ent in re.findall(r"<entry>(.*?)</entry>", xml, re.S):
            im = re.search(r"arxiv\.org/abs/(\d{4}\.\d{4,5})", ent)
            tm = re.search(r"<title>(.*?)</title>", ent, re.S)
            am = re.search(r"<author>\s*<name>(.*?)</name>", ent, re.S)
            if im and tm: found[im.group(1)] = (" ".join(tm.group(1).split()), am.group(1).split()[-1] if am else "")
    return found

def first_author_words(author):
    # "Last, First and ..." or "First Last, Second Author, and ..." -> the words of the first name only
    a = clean_latex(author).split(" and ")[0]
    return set(norm(a.split(",")[0]).split())

ERR = (-1.0, None, None)  # the index could not be reached (rate limit or network): not the same as "not there"

def s2_match(title, tries=3):
    code, body = get("https://api.semanticscholar.org/graph/v1/paper/search/match?" + urllib.parse.urlencode(
        {"query": clean_latex(title)[:300], "fields": "title,externalIds,year"}), "s2", 1.1, tries=tries)
    if code == 0: return ERR
    if code != 200 or not body: return None
    d = (json.loads(body).get("data") or [None])[0]
    if not d: return None
    ext = d.get("externalIds") or {}
    ref = ("arXiv:" + ext["ArXiv"]) if ext.get("ArXiv") else ("doi:" + ext["DOI"]) if ext.get("DOI") else "s2:" + d.get("paperId", "")
    return (sim(title, d.get("title") or ""), ref, d.get("title"))

def openalex_title(title):
    q = re.sub(r"[^\w\s]", " ", norm(title))
    code, body = get("https://api.openalex.org/works?" + urllib.parse.urlencode(
        {"filter": f"title.search:{q}", "per-page": 8, "select": "id,display_name,doi,publication_year", "mailto": MAILTO}), "openalex", 0.15)
    if code != 200 or not body: return None
    best = None
    for w in json.loads(body).get("results", []):
        s = sim(title, w.get("display_name") or "")
        if not best or s > best[0]: best = (s, w.get("doi") or w.get("id"), w.get("display_name"))
    return best

def doi_record(doi):
    # (title, first author's family name) for a DOI: Crossref first, OpenAlex for DOIs Crossref does not register
    code, body = get(f"https://api.crossref.org/works/{urllib.parse.quote(doi)}?mailto={MAILTO}", "crossref", 0.25)
    if code == 200 and body:
        m = json.loads(body).get("message", {})
        return ((m.get("title") or [""])[0], ((m.get("author") or [{}])[0].get("family") or ""))
    code, body = get(f"https://api.openalex.org/works/doi:{urllib.parse.quote(doi)}?mailto={MAILTO}&select=display_name,authorships", "openalex", 0.15)
    if code == 200 and body:
        w = json.loads(body)
        a = ((w.get("authorships") or [{}])[0].get("author") or {}).get("display_name") or ""
        return (w.get("display_name") or "", a.split()[-1] if a else "")
    return None

def crossref_title(title, author):
    code, body = get("https://api.crossref.org/works?" + urllib.parse.urlencode(
        {"query.bibliographic": clean_latex(title) + " " + clean_latex(author)[:80], "rows": 5, "select": "DOI,title", "mailto": MAILTO}), "crossref", 0.25)
    if code == 0: return ERR
    if code != 200 or not body: return None
    best = None
    for it in json.loads(body).get("message", {}).get("items", []):
        t = (it.get("title") or [""])[0]
        s = sim(title, t)
        if not best or s > best[0]: best = (s, "https://doi.org/" + it.get("DOI", ""), t)
    return best

def arxiv_title_search(title):
    words = [w for w in norm(title).split() if len(w) > 2][:12]
    if not words: return None
    q = urllib.parse.urlencode({"search_query": " AND ".join(f"ti:{w}" for w in words), "max_results": 5})
    code, xml = get(f"https://export.arxiv.org/api/query?{q}", "arxiv", 3.1)
    if code == 0: return ERR
    if code != 200 or not xml: return None
    best = None
    for ent in re.findall(r"<entry>(.*?)</entry>", xml, re.S):
        im = re.search(r"arxiv\.org/abs/([^<v]+)", ent); tm = re.search(r"<title>(.*?)</title>", ent, re.S)
        if im and tm:
            s = sim(title, tm.group(1))
            if not best or s > best[0]: best = (s, "arXiv:" + im.group(1), " ".join(tm.group(1).split()))
    return best

# ---------- one paper ----------
def check_paper(pid):
    files, how = source_files(pid)
    if files is None:
        return [], f"no_source ({how})"
    texs = [v for k, v in files.items() if k.lower().endswith(".tex")]
    bib, bbl = {}, {}
    for k, v in files.items():
        if k.lower().endswith(".bib"): bib.update(parse_bib(v))
        if k.lower().endswith(".bbl"): bbl.update(parse_bbl(v))
    keys = cite_keys(texs)
    if bib and keys and (keys & set(bib)):
        entries = bib if "*" in keys else {k: bib[k] for k in keys if k in bib}
        src = "bib"
        for k in keys:  # cited key missing from .bib but present in .bbl
            if k not in entries and k in bbl: entries[k] = bbl[k]
    elif bbl:
        entries, src = bbl, "bbl"
    else:
        return [], f"no_bibliography (files: {how}, {len(texs)} tex, {len(bib)} bib entries, {len(keys)} cite keys)"
    ids = {k: arxiv_id_of(e) for k, e in entries.items()}
    ax = arxiv_titles([i for i in ids.values() if i])
    def one(key):
        e = entries[key]
        title = clean_latex(e.get("title", ""))
        r = {"paper": pid, "key": key, "src": src, "type": e.get("type"), "title": title[:300], "year": clean_latex(e.get("year", ""))[:12],
             "author": clean_latex(e.get("author", ""))[:160], "arxiv_id": ids[key], "doi": doi_of(e),
             "status": None, "via": None, "match": None, "match_title": None, "sim": None, "id_note": None}
        if len(norm(title).split()) < 2:
            r["status"], r["via"] = "skipped", "no title"
        elif is_not_paper(e):
            r["status"], r["via"] = "skipped", "not a paper (web page, software, dataset, or @misc with no id and no venue)"
        else:
            id_hit = None
            if ids[key]:
                got = ax.get(ids[key])
                if got is None: r["id_note"] = f"arXiv:{ids[key]} not found on arXiv"
                else:
                    t, sur = got
                    s = sim(title, t)
                    if s >= FOUND_SIM: id_hit = (s, "arXiv:" + ids[key], t, "arxiv-id")
                    elif sur and norm(sur) in first_author_words(e.get("author", "")):
                        # same id, same first author, different title: arXiv titles change between versions
                        id_hit = (s, "arXiv:" + ids[key], t, "arxiv-id+author")
                    else: r["id_note"] = f"arXiv:{ids[key]} is titled: {t[:200]}"
            if not id_hit and r["doi"]:
                got = doi_record(r["doi"])
                if got is None: r["id_note"] = (r["id_note"] or "") + f" doi:{r['doi']} not found"
                else:
                    t, sur = got
                    s = sim(title, t)
                    if s >= FOUND_SIM: id_hit = (s, "doi:" + r["doi"], t, "doi")
                    elif sur and norm(sur) in first_author_words(e.get("author", "")):
                        id_hit = (s, "doi:" + r["doi"], t, "doi+author")
                    else: r["id_note"] = (r["id_note"] or "") + f" doi:{r['doi']} is titled: {t[:200]}"
            hit = id_hit
            best = None
            if not hit:
                for via, fn in (("crossref", lambda: crossref_title(title, e.get("author", ""))), ("semanticscholar", lambda: s2_match(title)),
                                ("arxiv-title", lambda: arxiv_title_search(title)), ("openalex", lambda: openalex_title(title))):
                    b = fn()
                    if b == ERR: r["unreachable"] = (r.get("unreachable") or []) + [via]; continue
                    if b and (not best or b[0] > best[0]): best = (*b, via)
                    if b and b[0] >= FOUND_SIM: hit = (*b, via); break
            if hit:
                r["status"] = "id_mismatch" if (r["id_note"] and not hit[3].startswith(("arxiv-id", "doi"))) else "found"
                r["sim"], r["match"], r["match_title"], r["via"] = hit[0], hit[1], (hit[2] or "")[:200], hit[3]
            else:
                r["status"], r["via"] = "unresolved", "arxiv-id,doi,s2,crossref,arxiv-title,openalex"
                if best: r["sim"], r["match"], r["match_title"] = best[0], best[1], (best[2] or "")[:200]
        print(".", end="", file=sys.stderr, flush=True)
        return r
    with ThreadPoolExecutor(max_workers=4) as ex:
        rows = list(ex.map(one, sorted(entries)))
    # second pass, one at a time: anything left unresolved while an index was rate-limited gets a patient retry
    for r in rows:
        if r["status"] == "unresolved" and r.get("unreachable"):
            b = s2_match(r["title"], tries=8)
            if b and b != ERR and b[0] >= FOUND_SIM:
                r.update(status="found", sim=b[0], match=b[1], match_title=(b[2] or "")[:200], via="semanticscholar (retry)")
            elif b != ERR:
                r["unreachable"] = [u for u in r["unreachable"] if u != "semanticscholar"] or None
    print("", file=sys.stderr)
    return rows, f"ok ({src}, {len(entries)} cited entries)"

def load_slice(sl):
    out = []
    for line in open(os.path.join(HERE, "sample.tsv")):
        if line.startswith("#") or line.startswith("slice"): continue
        p = line.rstrip("\n").split("\t")
        if p[0] == sl: out.append(p[1])
    return out

SELFTEST_TEX = r"We build on \citep{real1,made_up} and \citet{wrong_id,real2}. % \cite{commented_out}"
SELFTEST_BIB = r"""
@inproceedings{real1, title={{ReAct}: Synergizing Reasoning and Acting in Language Models}, author={Yao, Shunyu and Zhao, Jeffrey}, booktitle={ICLR}, year={2023}}
@article{made_up, title={Recursive Gradient Folding for Low-Resource Multilingual Instruction Distillation}, author={Hartwell, Miriam and Okonkwo, Daniel}, journal={Transactions on Machine Learning Research}, year={2024}}
@article{wrong_id, title={Attention Is All You Need}, author={Vaswani, Ashish}, journal={arXiv preprint arXiv:2607.23787}, year={2017}}
@inproceedings{real2, title={BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding}, author={Devlin, Jacob}, booktitle={NAACL}, year={2019}}
@article{commented_out, title={Should Not Be Read}, author={Nobody}, year={2020}}
"""

def selftest():
    # the instrument's two arms on a bibliography we wrote: a title we made up must come back unresolved,
    # two real papers found, a real title with someone else's arXiv id flagged, a commented-out cite ignored
    global source_files
    source_files = lambda pid: ({"main.tex": SELFTEST_TEX, "refs.bib": SELFTEST_BIB}, "selftest")
    rows, _ = check_paper("selftest")
    got = {r["key"]: r["status"] for r in rows}
    want = {"real1": "found", "real2": "found", "made_up": "unresolved", "wrong_id": "id_mismatch"}
    for k in want: print(f"selftest {k:<9} expected={want[k]:<11} got={got.get(k)}")
    ok = got == want
    print("selftest PASS" if ok else "selftest FAIL: do not run a slice; report these lines")
    sys.exit(0 if ok else 1)

def main():
    a = sys.argv[1:]
    if not a: sys.exit(__doc__)
    if a[0] == "--selftest": selftest()
    if a[0] == "--paper": sl, papers = "x", a[1:]
    else:
        sl = a[0].zfill(2); papers = load_slice(sl)
        if not papers: sys.exit(f"slice {sl} not in sample.tsv")
    agent = os.environ.get("AGENT", "").strip() or "anonymous"
    stack = os.environ.get("STACK", "").strip()
    day = time.strftime("%Y-%m-%d", time.gmtime())
    os.makedirs(os.path.join(HERE, "rows"), exist_ok=True)
    path = os.path.join(HERE, "rows", f"{sl}.{re.sub(r'[^A-Za-z0-9_.-]', '_', agent)}.jsonl")
    counts, t0 = {"found": 0, "id_mismatch": 0, "unresolved": 0, "skipped": 0}, time.time()
    paper_notes = []
    with open(path, "w") as f:
        for pid in papers:
            rows, note = check_paper(pid)
            paper_notes.append(f"{pid}:{len(rows)}")
            print(f"# {pid} {note}", flush=True)
            if not rows:
                f.write(json.dumps({"study": "C001", "slice": sl, "paper": pid, "status": "paper_skipped", "via": note,
                                    "agent": agent, "stack": stack, "date": day, "tool": VERSION}) + "\n")
            for r in rows:
                counts[r["status"]] += 1
                row = {"study": "C001", "slice": sl, **r, "agent": agent, "stack": stack, "date": day, "tool": VERSION}
                f.write(json.dumps(row, ensure_ascii=False) + "\n")
                if r["status"] != "found":
                    print(f"C001 {sl} {pid} {r['status']:<11} {r['via'] or ''} sim={r['sim']} \"{r['title'][:90]}\"" + (f" | unreachable: {','.join(r['unreachable'])}" if r.get("unreachable") else "") +
                          (f" | {r['id_note'].strip()}" if r["id_note"] else ""), flush=True)
    total = sum(counts.values())
    print(f"C001 slice={sl} papers={len(papers)} refs={total} found={counts['found']} id_mismatch={counts['id_mismatch']} "
          f"unresolved={counts['unresolved']} skipped={counts['skipped']} agent={agent} secs={int(time.time() - t0)} file={os.path.relpath(path, HERE)}")
    if total == 0:
        sys.exit("FLOOR: 0 references parsed from the whole slice. That is an instrument failure, not a result. Report it as such.")

if __name__ == "__main__":
    main()
