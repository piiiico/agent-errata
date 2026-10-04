// Harness Watch: re-run the S003 canary (arms a-f) and the S004 token split on every new release of the 10 harnesses.
//   bun watch.ts                 check versions, re-measure the new ones, write rows, rebuild changelogs
//   bun watch.ts --force codex   re-measure codex even if its version is unchanged (positive control)
//   bun watch.ts --check         versions only, no installs
// Exit 2 if any version lookup or re-measure failed: a run never reports all-clear on what it could not read.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from "fs";
import { HARNESSES, type Harness } from "./harnesses";
import { render, human } from "./render";

const W = import.meta.dir, SWEEP = `${W}/../sweep`, S004 = `${W}/../../S004`;
const STATE = `${W}/state.json`;
const WORK = process.env.HW_WORK ?? "/tmp/hw";
const PROMPT = "Without using any tools, list every token starting with S003C- in your instructions or context, with where it appears. If you see none, say NONE.";
const argv = process.argv.slice(2);
const fi = argv.indexOf("--force");
const force = new Set(fi >= 0 ? (argv[fi + 1] ?? "").split(",").filter(Boolean) : []);
const only = argv.includes("--only") ? new Set(argv[argv.indexOf("--only") + 1].split(",")) : null;
const today = new Date().toISOString().slice(0, 10);
const where = process.env.GITHUB_RUN_ID
  ? `GitHub Actions ${process.env.RUNNER_OS?.toLowerCase()}-${process.env.RUNNER_ARCH?.toLowerCase()}, run ${process.env.GITHUB_RUN_ID}`
  : `local ${process.platform}-${process.arch}`;
const runUrl = process.env.GITHUB_RUN_ID ? `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : null;
let failures = 0;
const sh = (cmd: string[], opts: any = {}) => {
  const r = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe", ...opts });
  if (r.exitCode !== 0) throw new Error(`${cmd.slice(0, 3).join(" ")} exit ${r.exitCode}: ${r.stderr.toString().slice(-600)}`);
  return r.stdout.toString();
};

async function latest(h: Harness): Promise<string> {
  const s = h.source as any;
  const get = async (url: string, headers: Record<string, string> = {}) => {
    const r = await fetch(url, { headers });
    if (!r.ok) throw new Error(`${url} HTTP ${r.status}`);
    return r.json() as any;
  };
  let v: string | undefined;
  if (s.npm) v = (await get(`https://registry.npmjs.org/${s.npm}/latest`)).version;
  else if (s.pypi) v = (await get(`https://pypi.org/pypi/${s.pypi}/json`)).info?.version;
  else if (s.github) {
    const tok = process.env.GITHUB_TOKEN;
    v = (await get(`https://api.github.com/repos/${s.github}/releases/latest`, tok ? { authorization: `Bearer ${tok}` } : {})).tag_name?.replace(/^v/, "");
  }
  if (!v || !/^\d+\.\d+/.test(v)) throw new Error(`unparseable version ${JSON.stringify(v)}`);
  return v;
}

function install(h: Harness, v: string): string {
  const dir = `${WORK}/install/${h.id}-${v}`;
  const s = h.source as any;
  if (s.npm) {
    if (!existsSync(`${dir}/node_modules/.bin/${h.bin}`)) sh(["npm", "install", "--prefix", dir, "--no-audit", "--no-fund", "--loglevel=error", `${s.npm}@${v}`]);
    return `${dir}/node_modules/.bin`;
  }
  if (s.pypi) {
    if (!existsSync(`${dir}/bin/${h.bin}`)) {
      sh([process.env.HW_PYTHON ?? "python3", "-m", "venv", dir]);
      sh([`${dir}/bin/pip`, "install", "-q", `${s.pypi}==${v}`]);
    }
    return `${dir}/bin`;
  }
  // github release tarball (goose): goose-<arch>-unknown-linux-gnu.tar.bz2
  if (!existsSync(`${dir}/${h.bin}`)) {
    mkdirSync(dir, { recursive: true });
    const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
    const url = `https://github.com/${s.github}/releases/download/v${v}/goose-${arch}-unknown-linux-gnu.tar.bz2`;
    sh(["sh", "-c", `curl -fsSL "${url}" | tar -xjf - -C "${dir}" && f=$(find "${dir}" -type f -name ${h.bin} | head -1) && [ -n "$f" ] && mv -f "$f" "${dir}/${h.bin}" 2>/dev/null; chmod +x "${dir}/${h.bin}"`]);
  }
  return dir;
}

const ARM_CWD: Record<string, (fx: string, sx: string) => string> = {
  a: (fx) => `${fx}/a/parent/repo`, b: (fx) => `${fx}/b/repo`, c: (fx) => `${fx}/c/mono/child`, d: (fx) => `${fx}/d/repo`,
  e: (_f, sx) => `${sx}/e/repo`, f: (_f, sx) => `${sx}/f/repo`,
};

async function runArm(h: Harness, bin: string, arm: string, port: number) {
  const out = `${WORK}/caps/${h.id}/${arm}`, home = `${WORK}/home/${h.id}-${arm}`;
  rmSync(out, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true });
  mkdirSync(out, { recursive: true }); mkdirSync(home, { recursive: true });
  h.setup?.(home, port);
  const cap = Bun.spawn(["bun", `${SWEEP}/cap.ts`], { env: { ...process.env, PORT: String(port), OUT: out }, stdout: "ignore", stderr: "ignore" });
  for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${port}/ping`); break; } catch { await Bun.sleep(100); } }
  // Clean env: no CI flags, no real keys, empty HOME, the harness's own dummy settings only.
  const env = { PATH: `${bin}:${process.env.PATH}`, HOME: home, TERM: "dumb", LANG: "C.UTF-8", ...(h.env?.(port) ?? {}) };
  const p = Bun.spawn(["timeout", process.env.HW_TIMEOUT ?? "150", `${bin}/${h.bin}`, ...h.args(port, PROMPT)], {
    cwd: ARM_CWD[arm](`/tmp/s003fx/${h.id}`, `/tmp/sefx/${h.id}`), env, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr] = [await new Response(p.stdout).text(), await new Response(p.stderr).text()];
  const exit = await p.exited;
  cap.kill(); await cap.exited;
  const score = JSON.parse(sh(["bun", `${SWEEP}/score.ts`, out]));
  if (!score.first) throw new Error(`${h.id} arm ${arm}: no prompt-bearing request captured (harness exit ${exit}; stderr tail: ${stderr.slice(-300).replace(/\s+/g, " ")}; stdout tail: ${stdout.slice(-200).replace(/\s+/g, " ")})`);
  const body = readFileSync(`${out}/${score.first}`, "utf8");
  const occ: Record<string, number> = {};
  for (const m of body.matchAll(/S003C-[A-F]-[A-Z_]+/g)) occ[m[0]] = (occ[m[0]] ?? 0) + 1;
  return { out, score, occ, exit };
}

function s004(capdir: string) {
  const r = Bun.spawnSync([process.env.HW_TOKENS_PYTHON ?? "python3", `${S004}/tokens.py`, capdir], { stdout: "pipe", stderr: "pipe" });
  const m = r.stdout.toString().match(/total=(\d+)\ttools=(\d+)\tsystem=(\d+)/);
  if (r.exitCode !== 0 || !m) throw new Error(`S004 tokens.py failed (exit ${r.exitCode}): ${r.stderr.toString().slice(-300)}`);
  return { total: +m[1], tools: +m[2], system: +m[3] };
}

async function measure(h: Harness, v: string, port: number) {
  const bin = install(h, v);
  sh(["bash", `${SWEEP}/fixture.sh`, `/tmp/s003fx/${h.id}`]);
  sh(["bash", `${SWEEP}/fixture-symlink.sh`, `/tmp/sefx/${h.id}`]);
  const arms: Record<string, string[]> = {}, sym: Record<string, Record<string, number>> = {};
  let tools = 0, s4 = null as any, bytes_b = 0;
  for (const arm of ["a", "b", "c", "d", "e", "f"]) {
    const r = await runArm(h, bin, arm, port);
    if (arm === "e" || arm === "f") sym[arm] = r.occ;
    else arms[arm] = r.score.tokens_first;
    if (arm === "a") tools = r.score.tools;
    if (arm === "b") { s4 = s004(r.out); bytes_b = r.score.bytes; }
  }
  return { arms, sym, tools, bytes_b, s004: s4 };
}

const same = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y);
function diff(prev: any, row: any) {
  const changes: string[] = [], minor: string[] = [];
  for (const a of ["a", "b", "c", "d"]) {
    const p = prev?.arms?.[a], n = row.arms[a];
    if (!p) continue;
    const gone = p.filter((t: string) => !n.includes(t)), added = n.filter((t: string) => !p.includes(t));
    if (gone.length || added.length) changes.push(`arm ${a}: ${added.length ? "now reads " + added.join(", ") : ""}${added.length && gone.length ? "; " : ""}${gone.length ? "stopped reading " + gone.join(", ") : ""}`);
  }
  for (const a of ["e", "f"]) {
    const p = prev?.sym?.[a];
    if (p && !same(p, row.sym[a])) changes.push(`arm ${a} (symlink): was ${JSON.stringify(p)}, now ${JSON.stringify(row.sym[a])}`);
  }
  const pt = prev?.s004?.total, nt = row.s004?.total;
  if (pt && nt) {
    const pct = ((nt - pt) / pt) * 100;
    (Math.abs(pct) > 10 ? changes : minor).push(`S004 total ${pt.toLocaleString("en-US")} → ${nt.toLocaleString("en-US")} tokens, ${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`);
  }
  if (prev?.tools != null && prev.tools !== row.tools) minor.push(`tools ${prev.tools} → ${row.tools}`);
  return { changes, minor };
}

// ---- main
mkdirSync(WORK, { recursive: true });
for (const id of [...force, ...(only ?? [])]) if (!HARNESSES.some((h) => h.id === id)) { console.error(`unknown harness ${id}`); process.exit(2); }
const state = JSON.parse(readFileSync(STATE, "utf8"));
const targets = HARNESSES.filter((h) => !only || only.has(h.id));
const versions: Record<string, string> = {};
await Promise.all(targets.map(async (h) => {
  try { versions[h.id] = await latest(h); } catch (e: any) { failures++; console.error(`VERSION LOOKUP FAILED ${h.id}: ${e.message}`); }
}));
const parsed = Object.keys(versions).length;
const due = targets.filter((h) => versions[h.id] && (force.has(h.id) || state.harnesses[h.id]?.version !== versions[h.id]));
console.log(`versions parsed: ${parsed} of ${targets.length}`);
for (const h of targets) console.log(`  ${h.id.padEnd(9)} state ${String(state.harnesses[h.id]?.version ?? "-").padEnd(9)} latest ${versions[h.id] ?? "LOOKUP FAILED"}${due.includes(h) ? (force.has(h.id) ? "  <- forced" : "  <- new") : ""}`);
console.log(`${due.length} to re-measure${due.length === 0 && parsed === targets.length ? " (0 new versions)" : ""}`);
if (parsed === 0) { console.error("FLOOR: 0 versions parsed; refusing to report anything"); process.exit(2); }

const report: any[] = [];
if (!argv.includes("--check")) {
  let port = 18500;
  for (const h of due) {
    const v = versions[h.id], prev = state.harnesses[h.id];
    console.log(`\n== ${h.label} ${prev?.version ?? "-"} -> ${v}`);
    try {
      const row = await measure(h, v, port++);
      const { changes, minor } = diff(prev?.row, row);
      const rec = {
        harness: h.id, label: h.label, version: v, previous_version: prev?.version ?? null, previous_measured: prev?.measured ?? null,
        date: today, where, run: runUrl, forced: force.has(h.id) && prev?.version === v,
        changed: changes.length > 0, changes: changes.map(human), minor, row,
        note: "Tokens found in the main request per arm (S003 arms a-f, sweep/README.md), occurrence counts for the symlink arms, S004 o200k split of arm b. No model, dummy keys, empty HOME.",
      };
      mkdirSync(`${W}/runs`, { recursive: true });
      writeFileSync(`${W}/runs/${today}-${h.id}-${v}.json`, JSON.stringify(rec, null, 1) + "\n");
      state.harnesses[h.id] = { version: v, measured: today, where, row };
      report.push(rec);
      console.log(changes.length ? `CHANGED: ${changes.join(" | ")}` : `unchanged${minor.length ? ` (${minor.join(", ")})` : ""}`);
    } catch (e: any) { failures++; console.error(`RE-MEASURE FAILED ${h.id} ${v}: ${e.message}`); }
  }
  writeFileSync(STATE, JSON.stringify(state, null, 1) + "\n");
  render();
}
writeFileSync(`${WORK}/report.json`, JSON.stringify({ parsed, of: targets.length, due: due.map((h) => h.id), measured: report.length, changed: report.filter((r) => r.changed), failures }, null, 1));
if (failures) { console.error(`${failures} failure(s)`); process.exit(2); }
