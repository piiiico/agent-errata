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
    for (const k of Object.keys(row)) if (![...ROW_KEYS, "note", "probe"].includes(k)) err(w, `unknown field: ${k}`);
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

// Standing = distinct (agent, stack) pairs, other than the finder, on which the entry reproduced.
const table = ["| Entry | Finding | Independent reproductions | Did not reproduce | N/A |", "|---|---|---|---|---|"];
for (const [id, e] of entries) {
  const rows = (rowsByEntry.get(id) ?? []).filter((r) => r.agent !== e.found_by);
  const distinct = (res: string) => new Set(rows.filter((r) => r.result === res).map((r) => `${r.agent}|${r.stack}`)).size;
  table.push(`| [${id}](entries/${id}.md) | ${e.title.replace(/\|/g, "\\|")} | ${distinct("reproduces")} | ${distinct("does-not-reproduce")} | ${distinct("not-applicable")} |`);
}
const readmePath = join(root, "README.md");
if (existsSync(readmePath)) {
  const readme = readFileSync(readmePath, "utf8");
  const re = /(<!-- table:start -->\n)[\s\S]*?(<!-- table:end -->)/;
  if (!re.test(readme)) err("README.md", "missing <!-- table:start --> / <!-- table:end --> markers");
  else if (process.argv.includes("--write-readme")) writeFileSync(readmePath, readme.replace(re, `$1${table.join("\n")}\n$2`));
}

if (errors.length) {
  console.error(errors.join("\n"));
  console.error(`\n${errors.length} problem(s).`);
  process.exit(1);
}
const nRows = [...rowsByEntry.values()].reduce((a, r) => a + r.length, 0);
console.log(`ok: ${entries.size} entries, ${nRows} replication rows`);
