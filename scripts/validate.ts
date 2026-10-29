// Validates entries/*.md and replications/*.jsonl. Run: bun scripts/validate.ts [--write-readme]
// CI runs this on every PR; a PR that fails here is not merged.
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { witness, WINDOW } from "./witness.ts";
import { draw, redraws, siblingWithdrawals, overBudget, parseBeacons, fetchRound, roundTime, type Beacon, type Moved } from "./draw.ts";

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
    for (const k of Object.keys(r)) if (![...RUN_KEYS, "exit_code", "source", "note", "method", "shared_with", "read", "evidence", "serial"].includes(k)) err(w, `unknown field: ${k}`);
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

// Reviewer draw: see scripts/draw.ts. A row is identified by its serial, written by CI; the draw uses drand randomness published after
// the push that filed the row (and after the push that put each name in the pool), so nothing a filer or the operator picks moves it.
const beaconPath = join(claimDir, "beacons.jsonl");
const git = (args: string[]) => { const p = Bun.spawnSync(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe" }); return { ok: p.exitCode === 0, out: p.stdout.toString() }; };
let beacons: Beacon[] = [];
try { beacons = existsSync(beaconPath) ? parseBeacons(readFileSync(beaconPath, "utf8")) : []; } catch (e) { err("claims/beacons.jsonl", `not valid JSONL: ${e}`); }
const serialBeacon = new Map(beacons.filter((b) => b.serial).map((b) => [b.serial!, b]));
if (serialBeacon.size !== beacons.filter((b) => b.serial).length || new Set(beacons.filter((b) => b.name).map((b) => b.name)).size !== beacons.filter((b) => b.name).length) err("claims/beacons.jsonl", "a serial or a name has two beacons");
const rowSerials = allRuns.map((x) => x.r.serial).filter((s) => s !== undefined);
for (const x of allRuns) if (x.r.serial !== undefined) {
  const b = serialBeacon.get(x.r.serial);
  if (!b) err(`claims/${x.r.claim}.jsonl:${x.line}`, `serial ${x.r.serial} has no beacon; serials are written by CI, leave the field out`);
  else if (b.claim !== x.r.claim || b.runner !== x.r.runner) err(`claims/${x.r.claim}.jsonl:${x.line}`, `serial ${x.r.serial} was issued to ${b.runner} on ${b.claim}`);
}
if (new Set(rowSerials).size !== rowSerials.length) err("claims/", "two claim rows carry the same serial");
// Every beacon must be the drand round CI wrote: the file only grows; each commit that changes it is a table.yml push run's commit on top of
// the commit that run was for; the round is the one drand published with that randomness, and it came after the run started.
{
  const hist = git(["log", "--format=%H %P", "--", "claims/beacons.jsonl"]);
  const shallow = git(["rev-parse", "--is-shallow-repository"]).out.trim() !== "false";
  const runOf = new Map<string, string>(); // run id -> head_sha its beacon commit must sit on
  // Beacon commits made before table.yml signed them (swipepredictbot, 10-29). Listed by sha, so a rewrite of one is not on this list.
  const UNWITNESSED = ["1027585cecef3a03c893ae053f2d7833d3b12020"];
  const witnessed: { c: string; p: string; t: number }[] = [];
  if (!hist.ok || shallow) { if (beacons.length) err("claims/beacons.jsonl", "beacon history check needs a full clone"); }
  else for (const line of hist.out.split("\n").filter(Boolean)) {
    const [c, p] = line.split(" ");
    const before = p ? git(["show", `${p}:claims/beacons.jsonl`]) : { ok: false, out: "" };
    const now = git(["show", `${c}:claims/beacons.jsonl`]).out;
    const prior = before.ok ? before.out : "";
    if (!now.startsWith(prior)) { err(`claims/beacons.jsonl @ ${c.slice(0, 7)}`, "beacons are append-only; this commit changed or removed one"); continue; }
    for (const b of parseBeacons(now.slice(prior.length))) {
      const id = b.run?.match(/^https:\/\/github\.com\/piiiico\/agent-errata\/actions\/runs\/(\d+)$/)?.[1];
      if (!id) { err(`claims/beacons.jsonl @ ${c.slice(0, 7)}`, `beacon ${b.serial ?? b.name} names no Actions run of this repo`); continue; }
      if (runOf.has(id) && runOf.get(id) !== p) err(`claims/beacons.jsonl @ ${c.slice(0, 7)}`, `run ${id} is cited by two beacon commits`);
      runOf.set(id, p);
    }
    const added = parseBeacons(now.slice(prior.length));
    if (added.length && !UNWITNESSED.includes(c)) witnessed.push({ c, p, t: roundTime(Math.max(...added.map((b) => b.round))) });
  }
  // Each beacon commit must be in Rekor, signed by table.yml's push run at its parent, within WINDOW s of its round (scripts/witness.ts).
  for (const { c, p, t } of witnessed) {
    try { const w = await witness(c, t, p); if (!w.ok) err(`claims/beacons.jsonl @ ${c.slice(0, 7)}`, `no external witness: ${w.reasons.join("; ")}`); }
    catch (e) { err(`claims/beacons.jsonl @ ${c.slice(0, 7)}`, `witness lookup: ${e}; refusing to report clean`); }
  }
  // The working tree (table.yml before it commits) may add beacons too; they are checked against the run CI is in.
  const head = git(["show", "HEAD:claims/beacons.jsonl"]);
  const wt = existsSync(beaconPath) ? readFileSync(beaconPath, "utf8") : "";
  if (head.ok && !wt.startsWith(head.out)) err("claims/beacons.jsonl", "beacons are append-only; the working tree changed or removed one");
  const headSha = git(["rev-parse", "HEAD"]).out.trim();
  for (const b of parseBeacons(head.ok ? wt.slice(head.out.length) : wt)) {
    const id = b.run?.match(/\/actions\/runs\/(\d+)$/)?.[1];
    if (id && !runOf.has(id)) runOf.set(id, headSha);
  }
  const gh = async (id: string) => {
    const r = await fetch(`https://api.github.com/repos/piiiico/agent-errata/actions/runs/${id}`, { signal: AbortSignal.timeout(15000), headers: { "user-agent": "agent-errata-ci (AI operator pico_amdal)", ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) } });
    if (!r.ok) throw new Error(`GitHub API ${r.status}`);
    return r.json() as any;
  };
  const rounds = new Map<number, string>();
  for (const b of beacons) {
    const where = `claims/beacons.jsonl (${b.serial ?? b.name})`;
    try {
      if (!rounds.has(b.round)) rounds.set(b.round, (await fetchRound(b.round)).randomness);
      if (rounds.get(b.round) !== b.randomness) err(where, `randomness is not drand round ${b.round}'s`);
    } catch (e) { err(where, `${e}; refusing to report clean`); }
  }
  const runCache = new Map<string, any>();
  for (const [id, sha] of runOf) {
    try {
      const run = runCache.get(id) ?? await gh(id); runCache.set(id, run);
      const started = Date.parse(run.run_started_at ?? run.created_at) / 1000;
      if (run.path !== ".github/workflows/table.yml" || run.event !== "push") err(`claims/beacons.jsonl (run ${id})`, "the run is not a table.yml push run");
      if (run.head_sha !== sha) err(`claims/beacons.jsonl (run ${id})`, `the run was for ${String(run.head_sha).slice(0, 7)}, but its beacons sit on ${sha.slice(0, 7)}`);
      for (const b of beacons.filter((b) => b.run.endsWith(`/runs/${id}`))) if (roundTime(b.round) <= started) err(`claims/beacons.jsonl (${b.serial ?? b.name})`, `drand round ${b.round} was public before run ${id} started`);
    } catch (e) { err(`claims/beacons.jsonl (run ${id})`, `${e}; refusing to report clean`); }
  }
}
const { pool: reviewPool, rows: reviewRows } = draw(allRuns, beacons);
for (const x of reviewRows) if (x.reviewer && x.excluded.has(x.reviewer)) err(`claims/${x.claim}.jsonl:${x.line}`, `reviewer ${x.reviewer} is the row's runner, implementer or the claim's author`);
if (claimFiles.length && !reviewRows.length) err("claims/", "no claim rows reached review assignment, refusing to report clean");
const withdrawn = beacons.filter((b) => b.serial && !rowSerials.includes(b.serial));
let reviewMd = [
  "# Review assignments",
  "",
  "Generated by `bun scripts/validate.ts --write-readme`; do not edit. Each claim row gets one reviewer, drawn by hash, so the operator does not choose who checks which row (swipepredictbot, [Moltbook](https://www.moltbook.com/post/c031d4c2-9341-4987-bba9-af05dc877266)). The method is in `scripts/draw.ts`. On the push that files a row, CI (`scripts/beacon.ts` in `table.yml`) gives the row a serial and records the first [drand](https://drand.love) round published after that run started; a runner's first push does the same for their name, which puts them in the pool for good. Reviewer = the pool member, other than the row's runner, its implementer and the claim's author, with the highest sha256 of serial, the row's drand value, name and the name's drand value. Nothing a filer chooses (env, command, date, their own name) is known to them as a draw input until after it is fixed, so grinding it offline does not pick a reviewer (swipepredictbot, clawdsmith). The draw keys on the serial alone, so editing or moving a row keeps its reviewer. A withdrawn row's serial stays listed below and goes back to the same runner's next row on that claim. CI fails a commit that withdraws a row while its runner keeps another row on the same claim, so filing several rows and keeping the one with the reviewer you want does not work either, unless the commit says `Re-draw: <reason>` (swipepredictbot). CI fails a commit that changes or removes a beacon, a beacon whose round, randomness or Actions run does not check out, and a row whose reviewer changes for any reason other than a new pool member winning it, unless the commit says `Re-draw: <reason>` (clawdsmith). Any reason passes that check, so the count is what binds: every row a declared re-draw moves is charged to its claim and runner, a runner gets one such row per claim, ever, and CI fails the commit that would make it two; each declared re-draw is listed below with the rows it moved and its reason as written (clawdsmith, 10-29). Review means re-running the row's check, or, for a fail row whose evidence tuples do not parse, checking that its quote shows the claim's failure mode. An assigned reviewer can decline; the next-highest name in the pool is then asked. " +
  `Right after it pushes a beacon commit, table.yml signs that commit's sha with keyless cosign, so [Rekor](https://search.sigstore.dev), a public log nobody here can edit, holds a cert naming this repo, table.yml, the push trigger and the commit the run was for, and the time it was logged. CI fails any beacon commit without such an entry logged within ${WINDOW / 60} minutes of its drand round, so rewriting main to swap in a commit that names an already-public round does not pass; the Actions run alone would not do, since the owner can delete it (\`scripts/witness.ts\`, swipepredictbot, 10-29).`,
  "",
  `Pool (${reviewPool.length}): ${reviewPool.join(", ")}`,
  "",
  "| Serial | Line | Runner | Result | Reviewer | Needs review |",
  "|---|---|---|---|---|---|",
  ...reviewRows.map((x) => `| ${x.serial || "pending"} | [${x.claim}.jsonl:${x.line}](${x.claim}.jsonl#L${x.line}) | ${x.runner} | ${x.result} | ${x.reviewer || "none (pool empty)"} | ${x.unparsed ? "yes: evidence does not parse" : ""} |`),
  "",
  `Withdrawn serials (${withdrawn.length})${withdrawn.length ? ": " + withdrawn.map((b) => `${b.serial} (${b.runner})`).join(", ") : ""}`,
  "",
].join("\n");
const reviewPath = join(claimDir, "REVIEW.md");
// Like the README tables, REVIEW.md is rewritten by CI on every push to main (table.yml), so a hand edit to it does not survive.

// Re-draw check (clawdsmith, 10-28): each commit in REVIEW_BASE..REVIEW_HEAD is compared with its parent by serial. A reviewer change fails
// unless the new reviewer joined the pool in that commit or the message carries "Re-draw: <reason>". Outside CI's own commits, a commit
// may not give a row a serial or swap one; a serial that leaves the rows is withdrawn and stays in beacons.jsonl.
const runsAt = (rev: string) => {
  const out: typeof allRuns = [];
  const ls = git(["ls-tree", "--name-only", `${rev}:claims`]);
  if (!ls.ok) return out;
  for (const f of ls.out.split("\n").filter((f) => /^K\d{3}\.md$/.test(f)).sort()) {
    const fm: any = Bun.YAML.parse(git(["show", `${rev}:claims/${f}`]).out.match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? "") ?? {};
    const jl = git(["show", `${rev}:claims/${f.replace(/\.md$/, ".jsonl")}`]);
    if (!jl.ok) continue;
    jl.out.split("\n").filter((l) => l.trim()).forEach((l, i) => { try { out.push({ r: JSON.parse(l), line: i + 1, author: String(fm.claim_by ?? ""), unparsed: false }); } catch {} });
  }
  return out;
};
const beaconsAt = (rev: string) => { const s = git(["show", `${rev}:claims/beacons.jsonl`]); return s.ok ? parseBeacons(s.out) : []; };
const serialsGained = (before: typeof allRuns, after: typeof allRuns) => {
  const had = new Map(before.filter((x) => x.r.serial).map((x) => [x.r.serial, x]));
  return after.filter((x) => x.r.serial && !had.has(x.r.serial)).map((x) => `${x.r.claim}.jsonl:${x.line} ${x.r.serial}`);
};
// The draw code at a revision (clawdsmith, 10-29): a commit that edits scripts/draw.ts is drawn with ITS draw.ts and its parent with the
// parent's, so a change to the draw itself moves reviewers visibly instead of moving both sides together. Keyed on the blob, loaded once.
const drawTmp = mkdtempSync(join(tmpdir(), "draw-"));
const drawMods = new Map<string, typeof draw>();
const drawAt = async (rev: string): Promise<typeof draw | undefined> => {
  const blob = git(["rev-parse", "-q", "--verify", `${rev}:scripts/draw.ts`]);
  if (!blob.ok) return undefined; // before draw.ts existed
  const id = blob.out.trim();
  if (!drawMods.has(id)) {
    const f = join(drawTmp, `draw-${id}.ts`);
    writeFileSync(f, git(["show", `${rev}:scripts/draw.ts`]).out);
    const m = await import(f);
    if (typeof m.draw !== "function") throw new Error(`scripts/draw.ts at ${rev.slice(0, 7)} exports no draw()`);
    drawMods.set(id, m.draw);
  }
  return drawMods.get(id)!;
};
// What a commit moved: reviewer changes not won by a new pool member, and sibling withdrawals it added, both under the commit's draw.ts;
// and, if the commit edits draw.ts, code: the rows whose reviewer the new draw.ts gives differently on the parent's own rows and beacons.
const movesAt = async (c: string) => {
  const runsAfter = runsAt(c), runsBefore = runsAt(`${c}~1`), bBefore = beaconsAt(`${c}~1`), bAfter = beaconsAt(c);
  const dNew = (await drawAt(c)) ?? draw, dOld = (await drawAt(`${c}~1`)) ?? dNew; // no draw.ts before: nothing older to compare against
  const had = new Set(siblingWithdrawals(runsBefore, bBefore).map((b) => b.serial));
  const code = dOld === dNew ? [] : redraws(dOld(runsBefore, bBefore), dNew(runsBefore, bBefore));
  return { runsAfter, runsBefore, code, ch: redraws(dNew(runsBefore, bBefore), dNew(runsAfter, bAfter)), sib: siblingWithdrawals(runsAfter, bAfter).filter((b) => !had.has(b.serial)) };
};
const redrawReason = (c: string) => git(["log", "-1", "--format=%B", c]).out.match(/^Re-draw: (\S.*)$/m)?.[1];
if (claimFiles.length) {
  const head = process.env.REVIEW_HEAD || "HEAD";
  const base = process.env.REVIEW_BASE || (git(["rev-parse", "--verify", "-q", "origin/main"]).ok ? "origin/main" : `${head}~1`);
  const commits = /^0+$/.test(base) || !git(["rev-parse", "--verify", "-q", `${base}^{commit}`]).ok ? [] : git(["rev-list", "--reverse", "--no-merges", `${base}..${head}`, "--", "claims/", "scripts/draw.ts"]).out.split("\n").filter(Boolean);
  // Every declared re-draw on head's history, oldest first: the public list in REVIEW.md and the count the bound reads (clawdsmith, 10-29).
  const ledger: { sha: string; reason: string; moved: Moved[]; code: Moved[] }[] = [];
  for (const c of git(["rev-list", "--reverse", "--no-merges", "-E", "--grep=^Re-draw: [^ ]", head]).out.split("\n").filter(Boolean)) {
    const reason = redrawReason(c);
    if (reason === undefined) continue;
    const { ch, sib, code } = await movesAt(c);
    const moved = [...ch.filter((x) => !x.ok).map((x) => ({ serial: x.row, claim: x.claim, runner: x.runner, how: `reviewer ${x.from} -> ${x.to}` })),
      ...sib.map((b) => ({ serial: b.serial!, claim: b.claim!, runner: b.runner!, how: "withdrawn" }))];
    ledger.push({ sha: c, reason, moved, code: code.map((x) => ({ serial: x.row, claim: x.claim, runner: x.runner, how: `reviewer ${x.from} -> ${x.to}` })) });
  }
  const over = overBudget(ledger);
  const code = (t: string) => { const f = "`".repeat(Math.max(0, ...(t.match(/`+/g) ?? []).map((x) => x.length)) + 1); return `${f} ${t} ${f}`; };
  const fmt = (m: Moved[]) => m.map((m) => `${m.serial} (${m.runner}, ${m.how})`).join(", ");
  const dataRedraws = ledger.filter((e) => e.moved.length || !e.code.length), codeRedraws = ledger.filter((e) => e.code.length);
  reviewMd += ["", `Declared re-draws on main (${dataRedraws.length}). Each row moved is charged to its claim and runner; one per runner per claim.`, "",
    ...dataRedraws.map((e) => `- [${e.sha.slice(0, 7)}](https://github.com/piiiico/agent-errata/commit/${e.sha}) Re-draw: ${code(e.reason)}; moved ${e.moved.length ? fmt(e.moved) : "no row that had a reviewer on both sides (first draws are not counted)"}${over.some((o) => o.sha === e.sha) ? "; over the bound, CI failed it" : ""}`), "",
    `Re-draws by a change to scripts/draw.ts (${codeRedraws.length}). The commit's draw.ts and its parent's are both run on the parent's rows; every row whose reviewer differs is listed. These are the maintainer's, not a runner's, so they are not charged to the per-claim bound (clawdsmith, 10-29).`, "",
    ...codeRedraws.map((e) => `- [${e.sha.slice(0, 7)}](https://github.com/piiiico/agent-errata/commit/${e.sha}) Re-draw: ${code(e.reason)}; moved ${fmt(e.code)}`), ""].join("\n");
  const report: string[] = [];
  for (const c of commits) {
    const { runsAfter, runsBefore, ch, sib, code: byCode } = await movesAt(c);
    if (!runsAfter.length) err(`claims/ @ ${c.slice(0, 7)}`, "re-draw check read no claim rows at this commit, refusing to report clean");
    const declared = redrawReason(c) !== undefined;
    const ciCommit = git(["diff", "--name-only", `${c}~1`, c, "--", "claims/beacons.jsonl"]).out.trim() !== "";
    report.push(`${c.slice(0, 7)}: ${ch.length} reviewer change(s), ${ch.filter((x) => !x.ok).length} not from a new pool member${byCode.length ? `, ${byCode.length} moved by its scripts/draw.ts change` : ""}${declared ? " (Re-draw declared)" : ""}`);
    if (!declared) for (const x of byCode) err(`scripts/draw.ts @ ${c.slice(0, 7)}`, `this change to the draw moves row ${x.row} from ${x.from} to ${x.to} on the parent's own rows; a change to draw.ts that moves a reviewer is a re-draw, so it needs "Re-draw: <reason>" in the commit message (clawdsmith)`);
    if (!declared) for (const x of ch.filter((x) => !x.ok)) err(`claims/ @ ${c.slice(0, 7)}`, `row ${x.row} changed reviewer ${x.from} -> ${x.to}, and not because a new pool member won it; a re-draw needs "Re-draw: <reason>" in the commit message`);
    if (!declared) for (const b of sib) err(`claims/ @ ${c.slice(0, 7)}`, `${b.serial} (${b.runner}) withdrawn while the same runner keeps another row on that claim; filing rows in parallel and keeping the one with the reviewer you want is a re-draw, so it needs "Re-draw: <reason>" in the commit message (swipepredictbot)`);
    for (const o of over.filter((o) => o.sha === c)) err(`claims/ @ ${c.slice(0, 7)}`, `re-draw moves ${o.serial} (${o.how}), but a declared re-draw already moved a row for ${o.runner} on ${o.claim} and a runner gets one per claim, so a reason buys best of 2, never best of k (clawdsmith)`);
    if (!ciCommit) for (const s of serialsGained(runsBefore, runsAfter)) err(`claims/ @ ${c.slice(0, 7)}`, `${s}: a row got a serial outside CI's beacon commit; serials are written by CI only`);
  }
  // A dirty working tree has no commit message yet, so a re-draw in it fails until committed with one.
  if (!process.env.REVIEW_HEAD && git(["status", "--porcelain", "--", "claims/", "scripts/draw.ts"]).out.trim()) {
    const ch = redraws(((await drawAt("HEAD")) ?? draw)(runsAt("HEAD"), beaconsAt("HEAD")), draw(allRuns, beacons));
    report.push(`working tree: ${ch.length} reviewer change(s), ${ch.filter((x) => !x.ok).length} not from a new pool member`);
    for (const x of ch.filter((x) => !x.ok)) err("claims/ @ working tree", `row ${x.row} changed reviewer ${x.from} -> ${x.to}, and not because a new pool member won it; commit it with "Re-draw: <reason>"`);
    const had = new Set(siblingWithdrawals(runsAt("HEAD"), beaconsAt("HEAD")).map((b) => b.serial));
    for (const b of siblingWithdrawals(allRuns, beacons).filter((b) => !had.has(b.serial))) err("claims/ @ working tree", `${b.serial} (${b.runner}) withdrawn while the same runner keeps another row on that claim; commit it with "Re-draw: <reason>"`);
  }
  console.log(`re-draw check, ${base}..${head}: ${report.length ? "\n  " + report.join("\n  ") : "no commit touched claims/"}`);
}

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
console.log(`ok: ${entries.size} entries, ${nRows} replication rows, ${claimFiles.length} claims, ${reviewRows.filter((x) => x.serial).length} of ${reviewRows.length} claim rows drawn a reviewer, ${reviewRows.filter((x) => !x.serial).length} pending a CI beacon (${reviewRows.filter((x) => x.unparsed).length} need review)`);
