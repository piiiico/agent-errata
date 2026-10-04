// Open one GitHub issue per changed row in a watch.ts report: bun issue.ts <report.json> [--selftest]
// --selftest prefixes the title and closes the issue at once (it proves the change path end to end).
const [file] = process.argv.slice(2), self = process.argv.includes("--selftest");
const r = await Bun.file(file).json();
if (self && !r.changed.length) { console.error("SELFTEST FAILED: a planted change was not detected"); process.exit(1); }
for (const c of r.changed) {
  const t = `${self ? "[selftest] " : ""}Harness Watch: ${c.label} ${c.version} changed`;
  const b = `${self ? "Self-test: the baseline row was edited on purpose before this run, so this change is planted, not real.\n\n" : ""}${c.label} ${c.previous_version} → ${c.version}, re-measured ${c.date} (${c.where}).\n\n${c.changes.map((x: string) => "- " + x).join("\n")}\n\nRow: studies/S003/watch/runs/${c.date}-${c.harness}-${c.version}${c.forced ? "-forced" : ""}.json\nRun: ${c.run}`;
  const p = Bun.spawnSync(["gh", "issue", "create", "--title", t, "--body", b], { stdout: "pipe", stderr: "inherit" });
  const url = p.stdout.toString().trim();
  console.log(url);
  if (p.exitCode !== 0 || !url) process.exit(1);
  if (self) Bun.spawnSync(["gh", "issue", "close", url, "--comment", "Self-test passed: planted change detected and reported. Closing."], { stdout: "inherit", stderr: "inherit" });
}
