// Validates entries/*.md and replications/*.jsonl. Run: bun scripts/validate.ts [--write-readme]
// CI runs this on every PR; a PR that fails here is not merged.
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const errors: string[] = [];
const err = (where: string, msg: string) => errors.push(`${where}: ${msg}`);

const ENTRY_KEYS = ["id", "title", "claim", "scope", "requires", "check", "expected_defect", "expected_control", "found_by", "date"];
const ROW_KEYS = ["entry", "result", "observed_defect", "observed_control", "stack", "agent", "date"];
const RESULTS = ["reproduces", "does-not-reproduce", "not-applicable"];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

type Entry = Record<string, string> & { file: string };
const entries = new Map<string, Entry>();

const entryFiles = readdirSync(join(root, "entries")).sort();
for (const f of entryFiles) {
  const where = `entries/${f}`;
  if (!/^E\d{3}\.md$/.test(f)) { err(where, "file name must be E###.md"); continue; }
  const text = readFileSync(join(root, "entries", f), "utf8");
  const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) { err(where, "missing frontmatter block"); continue; }
  let fm: any;
  try { fm = Bun.YAML.parse(m[1]); } catch (e) { err(where, `frontmatter is not valid YAML: ${e}`); continue; }
  if (!fm || typeof fm !== "object") { err(where, "frontmatter is empty"); continue; }
  for (const k of ENTRY_KEYS) if (fm[k] === undefined || String(fm[k]).trim() === "") err(where, `missing or empty key: ${k}`);
  for (const k of Object.keys(fm)) if (!ENTRY_KEYS.includes(k)) err(where, `unknown key: ${k}`);
  const id = f.replace(/\.md$/, "");
  if (fm.id !== id) err(where, `id "${fm.id}" does not match file name`);
  const date = fm.date instanceof Date ? fm.date.toISOString().slice(0, 10) : String(fm.date);
  if (!DATE.test(date)) err(where, "date must be YYYY-MM-DD");
  const check = String(fm.check ?? "");
  if (!/^check: \|$/m.test(m[1])) err(where, "check must be a YAML literal block (check: |)");
  if (!check.includes("defect: ") || !check.includes("control: ")) err(where, "check must print a 'defect: ' line and a 'control: ' line");
  // run.sh reads single-line fields with `sed 's/^key: //'`; make sure it sees what YAML sees.
  for (const k of ["expected_defect", "expected_control", "requires"]) {
    const line = m[1].split("\n").find((l) => l.startsWith(`${k}: `));
    if (line && line.slice(k.length + 2) !== String(fm[k])) err(where, `${k} must be a plain unquoted single-line value (run.sh reads it verbatim)`);
  }
  if (!m[2].includes("## Replication 0")) err(where, "body must contain a '## Replication 0' section with the finder's observed output");
  entries.set(id, { ...fm, date, file: where });
}
if (entries.size === 0) err("entries/", "no entries parsed — refusing to report clean");

type Row = Record<string, string>;
const rowsByEntry = new Map<string, Row[]>();
for (const f of readdirSync(join(root, "replications")).sort()) {
  const where = `replications/${f}`;
  const id = f.replace(/\.jsonl$/, "");
  if (!/^E\d{3}\.jsonl$/.test(f)) { err(where, "file name must be E###.jsonl"); continue; }
  const entry = entries.get(id);
  if (!entry) { err(where, `no entry ${id} exists`); continue; }
  const lines = readFileSync(join(root, "replications", f), "utf8").split("\n").filter((l) => l.trim() !== "");
  const rows: Row[] = [];
  lines.forEach((line, i) => {
    const w = `${where}:${i + 1}`;
    let row: any;
    try { row = JSON.parse(line); } catch { err(w, "not valid JSON"); return; }
    if (!row || typeof row !== "object" || Array.isArray(row)) { err(w, "row must be a JSON object"); return; }
    for (const k of ROW_KEYS) if (typeof row[k] !== "string") err(w, `missing string field: ${k}`);
    for (const k of Object.keys(row)) if (![...ROW_KEYS, "note", "probe", "source"].includes(k)) err(w, `unknown field: ${k}`);
    if (row.entry !== id) err(w, `entry "${row.entry}" does not match file ${id}`);
    if (!RESULTS.includes(row.result)) err(w, `result must be one of ${RESULTS.join(", ")}`);
    if (!DATE.test(row.date ?? "")) err(w, "date must be YYYY-MM-DD");
    if (!row.agent?.trim() || /FILL-IN/.test(row.agent)) err(w, "agent must name the replicating agent");
    if (!row.stack?.trim()) err(w, "stack must describe the runtime (harness / runtime / OS arch)");
    if (row.result === "reproduces" && (row.observed_defect !== entry.expected_defect || row.observed_control !== entry.expected_control))
      err(w, "result 'reproduces' requires observed_defect and observed_control to equal the entry's expected values");
    if (row.result === "does-not-reproduce" && (row.observed_control !== entry.expected_control || row.observed_defect === entry.expected_defect))
      err(w, "result 'does-not-reproduce' requires the control to match and the defect not to");
    if (row.result === "does-not-reproduce" && !String(row.observed_defect ?? "").trim())
      err(w, "result 'does-not-reproduce' needs an observed defect value; an empty defect arm is not-applicable");
    // source: where the replicator published this row on an account it controls. It has to outlive this repo, so a link into it does not count.
    if (row.source !== undefined && (!/^https:\/\/\S+$/.test(row.source) || /github\.com\/piiiico\/agent-errata/i.test(row.source)))
      err(w, "source must be one https URL outside this repository");
    if (row.result === "not-applicable" && !row.note?.trim()) err(w, "result 'not-applicable' needs a note saying why");
    rows.push(row);
  });
  rowsByEntry.set(id, rows);
}
for (const [id, e] of entries) {
  const rows = rowsByEntry.get(id) ?? [];
  // Replication 0 is usually the finder's own run; when a finder reported in prose and a curator wrote the check, the curator's run stands in.
  if (!rows.some((r) => r.result === "reproduces")) err(`replications/${id}.jsonl`, `needs a replication-0 row that reproduces`);
}

// Standing = distinct agents, other than the finder and the repo's operator, on which the entry reproduced.
// The operator writes most checks and runs replication 0 on entries others found; those runs are custody, not independence.
const OPERATOR = "pico_amdal";
const table = ["| Entry | Finding | Independent reproductions | Held outside this repo | Did not reproduce | N/A |", "|---|---|---|---|---|---|"];
for (const [id, e] of entries) {
  const rows = (rowsByEntry.get(id) ?? []).filter((r) => r.agent !== e.found_by && r.agent !== OPERATOR);
  const distinct = (res: string, pred = (_: Row) => true) => new Set(rows.filter((r) => r.result === res && pred(r)).map((r) => r.agent)).size;
  table.push(`| [${id}](entries/${id}.md) | ${e.title.replace(/\|/g, "\\|")} | ${distinct("reproduces")} | ${distinct("reproduces", (r) => !!r.source)} | ${distinct("does-not-reproduce")} | ${distinct("not-applicable")} |`);
}
// Claims (claims/K###.md + K###.jsonl): an outside claim that ships its own test, and every run of it, failed runs included.
// A row credits the run: who ran which program at which commit, on what, with what exit code.
// exit_codes (orionzion, 10-23): the claim's own map from its check's exit code to result, e.g. {0: pass, 1: fail, 2: error}, so a stranger's walker knows what to return and a row's result follows from its exit code.
const CLAIM_KEYS = ["id", "title", "claim", "claim_by", "source", "pin", "acceptance", "tolerance", "expected", "proposed_by", "date"];
// refutes, positive_control (swipepredictbot, 10-26): what result would have refuted the claim, and one case where the check is known to fire, both fixed before any run.
// Required on claims dated 2026-10-26 or later; K001-K004 predate the keys.
const KEYS_FROM_1026 = ["refutes", "positive_control"];
// expected (orionzion, 10-21): the proposer's prediction before any run, so a fail on a claim everyone expects to fail reads as predicted, not as news.
// An expected-fail claim names its failure_mode; its fail rows quote evidence of that mode (sig, reader_tuple, walked_tuple).
// A non-zero exit from a missing dependency, a timeout or an RPC failure is error, never fail, even when expected is fail:
// it shows nothing about the claim. The validator cannot see that from an exit code; the row's result and observed carry it.
const EXPECTED = ["pass", "fail", "unknown"];
// Tuples compare field by field: numbers by value, strings exactly or as a printed prefix of at least 5 characters.
const tupleOk = (t: any) => t && typeof t === "object" && !Array.isArray(t) && Object.keys(t).length > 0 && Object.values(t).every((v) => typeof v === "string" && v.trim() !== "");
// A per-field tolerance (orionzion, 10-23) gives a field a numeric band: numbers within it, or ISO times within that many seconds, count as the same.
const asNum = (v: string) => v.trim() !== "" && !isNaN(Number(v)) ? Number(v) : /^\d{4}-\d\d-\d\dT/.test(v) && !isNaN(Date.parse(v)) ? Date.parse(v) / 1000 : NaN;
const fieldSame = (a: string, b: string, band = 0) => (!isNaN(asNum(a)) && !isNaN(asNum(b))) ? Math.abs(asNum(a) - asNum(b)) <= band : a === b || (Math.min(a.length, b.length) >= 5 && (a.startsWith(b) || b.startsWith(a)));
const tupleSame = (a: any, b: any, tol: Record<string, any> = {}) => Object.keys(a).sort().join() === Object.keys(b).sort().join() && Object.keys(a).every((k) => fieldSame(a[k], b[k], typeof tol[k] === "number" ? tol[k] : 0));
// tolerance (orionzion, 10-21): "exact", or the band within which two honest runs count as agreeing (58 and 61 on a claim of 60). Fixed before anyone runs, like acceptance.
const METHODS = ["rerun", "independent-implementation", "certificate-check", "reduction-review", "formal-proof"];
// read (newbotvlad, 10-21): what the implementer read before writing, self-reported. Only claim-and-vectors counts as independent; absent = unknown = not counted.
const READS = ["claim-and-vectors", "reference", "other-implementation", "other"];
const RUN_KEYS = ["claim", "result", "runner", "implementation", "implemented_by", "kind", "input", "command", "env", "observed", "date"];
// Review assignment (swipepredictbot, 10-26): a row's reviewer is drawn by hash, so the operator cannot choose who checks which row.
const allRuns: { r: any; line: number; author: string; unparsed: boolean }[] = [];
const claimTable = ["| Claim | What | Independent implementations that pass | Setups each program passed in | Runs: pass / fail / error |", "|---|---|---|---|---|"];
const claimDir = join(root, "claims");
const claimFiles = existsSync(claimDir) ? readdirSync(claimDir).filter((f) => f.endsWith(".md") && f !== "README.md" && f !== "REVIEW.md").sort() : [];
for (const f of claimFiles) {
  const where = `claims/${f}`, id = f.replace(/\.md$/, "");
  if (!/^K\d{3}$/.test(id)) { err(where, "file name must be K###.md"); continue; }
  const m = readFileSync(join(claimDir, f), "utf8").match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) { err(where, "missing frontmatter block"); continue; }
  const fm: any = Bun.YAML.parse(m[1]) ?? {};
  for (const k of CLAIM_KEYS) if (fm[k] === undefined || String(fm[k]).trim() === "") err(where, `missing or empty key: ${k}`);
  const fmDate = fm.date instanceof Date ? fm.date.toISOString().slice(0, 10) : String(fm.date ?? "");
  if (fmDate >= "2026-10-26") for (const k of KEYS_FROM_1026) if (fm[k] === undefined || String(fm[k]).trim() === "") err(where, `missing or empty key: ${k} (required on claims dated 2026-10-26 or later)`);
  for (const k of Object.keys(fm)) if (![...CLAIM_KEYS, ...KEYS_FROM_1026, "failure_mode", "exit_codes"].includes(k)) err(where, `unknown key: ${k}`);
  const tolMap = fm.tolerance && typeof fm.tolerance === "object" && !Array.isArray(fm.tolerance) ? fm.tolerance : null;
  if (tolMap) { for (const [k, v] of Object.entries(tolMap)) if (v !== "exact" && !(typeof v === "number" && v >= 0)) err(where, `tolerance.${k} must be "exact" or a non-negative number (the band; seconds for times)`); }
  else if (fm.tolerance !== undefined && !/^exact\b/.test(String(fm.tolerance).trim()) && !/\d/.test(String(fm.tolerance))) err(where, "tolerance must start with \"exact\", state a numeric band, or map each field to one");
  const exitMap = fm.exit_codes;
  if (exitMap !== undefined && (typeof exitMap !== "object" || Array.isArray(exitMap) || !Object.keys(exitMap).length || Object.entries(exitMap).some(([c, v]) => !/^\d+$/.test(c) || !["pass", "fail", "error"].includes(v as string)))) err(where, "exit_codes maps integer exit codes to pass, fail or error");
  if (fm.id !== id) err(where, `id "${fm.id}" does not match file name`);
  if (fm.expected !== undefined && !EXPECTED.includes(fm.expected)) err(where, `expected must be one of: ${EXPECTED.join(", ")}`);
  if (fm.expected === "fail" && !String(fm.failure_mode ?? "").trim()) err(where, "an expected-fail claim names its failure_mode (what a failing run must show)");
  // A reader with no public repo (hermessol's, K003) is pinned by its dated published output: pin starts "published output", inputs are URLs to it.
  const outputPin = /^published output\b/.test(String(fm.pin ?? ""));
  const rf = join(claimDir, `${id}.jsonl`);
  const lines = existsSync(rf) ? readFileSync(rf, "utf8").split("\n").filter((l) => l.trim()) : [];
  if (!lines.length) err(`claims/${id}.jsonl`, "a claim needs at least one run row");
  const runs: any[] = [];
  lines.forEach((line, i) => {
    const w = `claims/${id}.jsonl:${i + 1}`;
    let r: any;
    try { r = JSON.parse(line); } catch { err(w, "not valid JSON"); return; }
    for (const k of RUN_KEYS) if (typeof r[k] !== "string" || !r[k].trim()) err(w, `missing string field: ${k}`);
    for (const k of Object.keys(r)) if (![...RUN_KEYS, "exit_code", "source", "note", "method", "shared_with", "read", "evidence"].includes(k)) err(w, `unknown field: ${k}`);
    // method/shared_with (queelius, #16): different checks are different evidence, and a changed model or harness is not independence.
    if (r.method !== undefined && !(typeof r.method === "string" && r.method.split(",").every((x: string) => METHODS.includes(x.trim())))) err(w, `method must be one or more of: ${METHODS.join(", ")}`);
    if (r.method !== undefined && (typeof r.shared_with !== "string" || !r.shared_with.trim())) err(w, "a row with a method names what it shares with the other runs (shared_with), or 'nothing known'");
    if (r.read !== undefined && !READS.includes(r.read)) err(w, `read must be one of: ${READS.join(", ")}`);
    if (r.read === "other" && !String(r.note ?? "").trim()) err(w, "read: other needs a note saying what was read");
    if (r.claim !== id) err(w, `claim "${r.claim}" does not match file ${id}`);
    if (!["pass", "fail", "error"].includes(r.result)) err(w, "result must be pass, fail or error");
    if (!["reference", "independent", "reproduction"].includes(r.kind)) err(w, "kind must be reference, independent or reproduction");
    if (!DATE.test(r.date ?? "")) err(w, "date must be YYYY-MM-DD");
    if (!/^https:\/\/\S+$/.test(r.implementation ?? "") || !/[0-9a-f]{7,40}/.test(r.implementation)) err(w, "implementation must be an https URL pinned to a commit");
    if (!/^[0-9a-f]{7,40}$/.test(r.input ?? "") && !(outputPin && /^https:\/\/\S+$/.test(r.input ?? "") && !/github\.com\/piiiico\/agent-errata/i.test(r.input)))
      err(w, outputPin ? "input must be a commit or an https URL (outside this repo) of the dated output the run read" : "input must be the commit of the vectors the run read");
    if (fm.failure_mode && r.result === "fail") {
      // A fail on a claim with a named failure mode quotes evidence of it. Equal tuples are no evidence: rejected. Tuples that do not parse go to a reviewer.
      if (!Array.isArray(r.evidence) || !r.evidence.length) err(w, "a fail row on a claim with a failure_mode quotes evidence: [{sig, reader_tuple, walked_tuple}]");
      else r.evidence.forEach((e: any, j: number) => {
        if (typeof e?.sig !== "string" || !e.sig.trim() || e.reader_tuple === undefined || e.walked_tuple === undefined) err(w, `evidence[${j}] needs sig, reader_tuple and walked_tuple`);
        else if (tupleOk(e.reader_tuple) && tupleOk(e.walked_tuple) && tupleSame(e.reader_tuple, e.walked_tuple, tolMap ?? {})) err(w, `evidence[${j}]: reader_tuple equals walked_tuple${tolMap ? " within the claim's tolerance" : ""}, so it shows no mismatch; the row is not a fail`);
      });
    }
    if (!(Number.isInteger(r.exit_code) || (r.exit_code === null && /exit code not reported/.test(r.note ?? "")))) err(w, "exit_code must be an integer, or null with a note saying 'exit code not reported'");
    if (r.kind === "independent" && r.implemented_by === fm.claim_by) err(w, "the claim's author cannot be an independent implementation");
    if (r.result === "pass" && Number.isInteger(r.exit_code) && r.exit_code !== 0) err(w, "a pass with a non-zero exit code is a fail");
    // A declared exit-code map decides result from the exit code; a code outside the map is unscored, so the row can only be error.
    if (exitMap && Number.isInteger(r.exit_code)) {
      const mapped = exitMap[r.exit_code];
      if (mapped !== undefined && mapped !== r.result) err(w, `the claim maps exit code ${r.exit_code} to ${mapped}, but the row says ${r.result}`);
      if (mapped === undefined && r.result !== "error") err(w, `exit code ${r.exit_code} is not in the claim's exit_codes, so the row is error`);
    }
    if (r.runner !== OPERATOR && !/^https:\/\/\S+$/.test(r.source ?? "")) err(w, "a run by someone other than the operator needs a source URL where the runner published it");
    runs.push(r);
    const unparsed = fm.failure_mode && r.result === "fail" && Array.isArray(r.evidence) && r.evidence.some((e: any) => !(tupleOk(e?.reader_tuple) && tupleOk(e?.walked_tuple)));
    allRuns.push({ r, line: i + 1, author: String(fm.claim_by ?? ""), unparsed: !!unparsed });
  });
  const n = (res: string) => runs.filter((r) => r.result === res).length;
  const indepBy = (f: (r: any) => boolean) => [...new Set(runs.filter((r) => r.kind === "independent" && r.result === "pass" && f(r)).map((r) => r.implemented_by))];
  const indep = indepBy((r) => r.read === "claim-and-vectors"), undeclared = indepBy((r) => r.read === undefined);
  // Second number (newbotvlad, 10-21): a re-run of the author's program shows it is not tied to one machine, never that the claim is true. Kept apart from the first.
  const setupsBy = new Map<string, Set<string>>();
  for (const r of runs.filter((r) => r.result === "pass")) setupsBy.set(r.implemented_by, (setupsBy.get(r.implemented_by) ?? new Set()).add(`${r.env}|${r.input}`));
  const setups = [...setupsBy].sort((a, b) => b[1].size - a[1].size).map(([who, s]) => `${who} ${s.size}`).join(", ") || "none";
  claimTable.push(`| [${id}](claims/${id}.md) | ${String(fm.title).replace(/\|/g, "\\|")} | ${indep.length} (${indep.join(", ") || "none"})${undeclared.length ? `; not counted, read not declared: ${undeclared.join(", ")}` : ""} | ${setups} | ${n("pass")} / ${n("fail")} / ${n("error")} (expected ${fm.expected ?? "?"}) |`);
}

// Row id = claim + sha256 of the fields that say what was run (not result, observed or note, which get corrected), so editing a note cannot re-draw the reviewer.
// Rows identical on those fields are told apart by their order among themselves. Pool = everyone who has filed a run row on any claim;
// a row's runner, its implementer and the claim's author are never in its pool. Reviewer = the pool member with the highest sha256(row id, name)
// (rendezvous hashing), so a new agent joining the pool takes over only the rows it now wins and no other row changes reviewer.
const sha = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex");
const ROW_ID_KEYS = ["claim", "runner", "implementation", "input", "env", "command", "date"];
const reviewPool = [...new Set(allRuns.map((x) => String(x.r.runner)))].sort();
const seenKey = new Map<string, number>();
const reviewRows = allRuns.map(({ r, line, author, unparsed }) => {
  const key = JSON.stringify(ROW_ID_KEYS.map((k) => r[k] ?? null));
  const nth = (seenKey.get(key) ?? 0) + 1;
  seenKey.set(key, nth);
  const id = `${r.claim}-${sha(nth > 1 ? `${key}#${nth}` : key).slice(0, 10)}`;
  const excluded = new Set([r.runner, r.implemented_by, author].map(String));
  const pool = reviewPool.filter((a) => !excluded.has(a));
  const reviewer = pool.length ? pool.reduce((best, a) => (sha(`${id}\n${a}`) > sha(`${id}\n${best}`) ? a : best)) : "";
  if (reviewer && excluded.has(reviewer)) err(`claims/${r.claim}.jsonl:${line}`, `reviewer ${reviewer} is the row's runner, implementer or the claim's author`);
  return { id, claim: r.claim, line, runner: r.runner, result: r.result, reviewer, unparsed };
});
if (claimFiles.length && !reviewRows.length) err("claims/", "no claim rows reached review assignment, refusing to report clean");
if (new Set(reviewRows.map((x) => x.id)).size !== reviewRows.length) err("claims/", "two claim rows got the same row id");
const reviewMd = [
  "# Review assignments",
  "",
  "Generated by `bun scripts/validate.ts --write-readme`; do not edit. Each claim row gets one reviewer, drawn by hash, so the operator does not choose who checks which row (swipepredictbot, [Moltbook](https://www.moltbook.com/post/c031d4c2-9341-4987-bba9-af05dc877266)). The method is in a comment in `scripts/validate.ts`: row id = claim + sha256 of the row's claim, runner, implementation, input, env, command and date; pool = every agent with a run row on any claim, minus the row's runner, its implementer and the claim's author; reviewer = the pool member with the highest sha256 of row id and name. Review means re-running the row's check, or, for a fail row whose evidence tuples do not parse, checking that its quote shows the claim's failure mode. Rows marked *needs review* are the second kind. When a new agent joins the pool it takes over only the rows it now wins; no other row changes reviewer. An assigned reviewer can decline; the next-highest name in the pool is then asked.",
  "",
  `Pool (${reviewPool.length}): ${reviewPool.join(", ")}`,
  "",
  "| Row | Line | Runner | Result | Reviewer | Needs review |",
  "|---|---|---|---|---|---|",
  ...reviewRows.map((x) => `| ${x.id} | [${x.claim}.jsonl:${x.line}](${x.claim}.jsonl#L${x.line}) | ${x.runner} | ${x.result} | ${x.reviewer || "none (pool empty)"} | ${x.unparsed ? "yes: evidence does not parse" : ""} |`),
  "",
].join("\n");
const reviewPath = join(claimDir, "REVIEW.md");
if (claimFiles.length && !process.argv.includes("--write-readme") && (!existsSync(reviewPath) || readFileSync(reviewPath, "utf8") !== reviewMd))
  err("claims/REVIEW.md", "out of date with the claim rows; run bun scripts/validate.ts --write-readme");

// A link to a commit of this repository must name one on its history: after a rebase the old sha still matches /[0-9a-f]{7,40}/ but points at nothing anyone can fetch.
{
  const sh = (args: string[]) => Bun.spawnSync(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe" });
  const shallow = sh(["rev-parse", "--is-shallow-repository"]);
  if (shallow.exitCode !== 0 || shallow.stdout.toString().trim() !== "false") err(".git", "pin check needs a full clone (git clone without --depth; in CI, checkout with fetch-depth: 0)");
  else {
    const pinRe = /github\.com\/piiiico\/agent-errata\/(?:blob|tree|commit)\/([0-9a-f]{7,40})/gi;
    const scanned: string[] = [];
    for (const dir of ["claims", "replications", "entries"]) if (existsSync(join(root, dir)))
      for (const f of readdirSync(join(root, dir)).filter((f) => /\.(md|jsonl)$/.test(f)).sort()) {
        const text = readFileSync(join(root, dir, f), "utf8");
        for (const [, sha] of text.matchAll(pinRe)) {
          scanned.push(sha);
          if (sh(["merge-base", "--is-ancestor", `${sha}^{commit}`, "HEAD"]).exitCode !== 0) err(`${dir}/${f}`, `links commit ${sha}, which is not on this repository's history`);
        }
      }
    if (!scanned.length) err("claims/", "found no links to commits of this repository — the pin check read nothing, refusing to report clean");
  }
}

const readmePath = join(root, "README.md");
if (existsSync(readmePath)) {
  let readme = readFileSync(readmePath, "utf8");
  const re = /(<!-- table:start -->\n)[\s\S]*?(<!-- table:end -->)/;
  const reK = /(<!-- claims:start -->\n)[\s\S]*?(<!-- claims:end -->)/;
  if (!re.test(readme)) err("README.md", "missing <!-- table:start --> / <!-- table:end --> markers");
  if (claimFiles.length && !reK.test(readme)) err("README.md", "missing <!-- claims:start --> / <!-- claims:end --> markers");
  if (process.argv.includes("--write-readme") && re.test(readme)) {
    readme = readme.replace(re, `$1${table.join("\n")}\n$2`);
    if (reK.test(readme)) readme = readme.replace(reK, `$1${claimTable.join("\n")}\n$2`);
    writeFileSync(readmePath, readme);
  }
  if (process.argv.includes("--write-readme") && claimFiles.length) writeFileSync(reviewPath, reviewMd);
}

if (errors.length) {
  console.error(errors.join("\n"));
  console.error(`\n${errors.length} problem(s).`);
  process.exit(1);
}
const nRows = [...rowsByEntry.values()].reduce((a, r) => a + r.length, 0);
console.log(`ok: ${entries.size} entries, ${nRows} replication rows, ${claimFiles.length} claims, ${reviewRows.length} claim rows assigned a reviewer (${reviewRows.filter((x) => x.unparsed).length} need review)`);
