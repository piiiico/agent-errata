// S005 runner: one harness, one scratch HOME + repo, pointed at loop2.ts; stops at the harness's own exit or at TIMEOUT.
// Usage: bun run.ts <label> <harness-id> [timeoutSec] [-- extra args...]   env: EXTRA_ENV='{"K":"V"}' SETUP_JSON='{"rel/path":{...}}'
//   MIN_FREE_GB (start floor, 8) ABORT_FREE_GB (mid-run kill, max(2, MIN_FREE_GB/4)) KEEP_HOME=1
import { HARNESSES } from "../S003/watch/harnesses.ts";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, statfsSync } from "fs";
const [label, id, tsec = "90", ...rest] = process.argv.slice(2);
const extra = rest[0] === "--" ? rest.slice(1) : rest;
const h = HARNESSES.find((x) => x.id === id)!;
// Where each binary lives on OUR box; override with BIN_<ID>=/path or BIN_DIR=dir.
const BIN: Record<string, string> = {
  claude: "/workspace/tmp/s005/npm/node_modules/.bin/claude", qwen: "/workspace/tmp/s003-bin/node_modules/.bin/qwen",
  crush: "/workspace/tmp/s003-bin/node_modules/.bin/crush", goose: "/workspace/tmp/s005/gbin/goose",
};
const bin = process.env[`BIN_${id.toUpperCase()}`] ?? BIN[id] ?? `${process.env.BIN_DIR ?? "./node_modules/.bin"}/${h.bin}`;
const D = require("path").resolve(`${process.env.RUNS ?? "./runs"}/${label}`); // absolute: Bun.spawn ENOENTs on a relative cwd rmSync(D, { recursive: true, force: true });
// Disk guard: a harness fed a large pending tool result writes ~11 MB/s of transcript into its scratch HOME
// (Claude Code, 20 s run = 228 MB, measured 2026-10-06). Uncapped runs filled a shared disk twice. Refuse to start
// below MIN_FREE_GB, and delete the HOME afterwards unless KEEP_HOME=1 (its size is kept in result.json).
const runsRoot = D.replace(/\/[^/]+$/, ""); mkdirSync(runsRoot, { recursive: true });
const fs0 = statfsSync(runsRoot), freeGB = (fs0.bavail * fs0.bsize) / 1e9, minFree = Number(process.env.MIN_FREE_GB ?? "8");
if (!(freeGB >= minFree)) { console.error(`refusing to run: ${freeGB.toFixed(1)} GB free under ${runsRoot}, floor ${minFree} GB (MIN_FREE_GB)`); process.exit(3); }
const home = `${D}/home`, repo = `${D}/repo`; mkdirSync(home, { recursive: true }); mkdirSync(repo, { recursive: true });
Bun.spawnSync(["git", "init", "-q", "."], { cwd: repo }); writeFileSync(`${repo}/a.txt`, "hi\n");
const port = 20000 + Math.floor(Math.random() * 20000);
h.setup?.(home, port);
for (const [rel, data] of Object.entries(JSON.parse(process.env.SETUP_JSON ?? "{}"))) {
  const f = `${home}/${rel}`; mkdirSync(f.replace(/\/[^/]+$/, ""), { recursive: true });
  writeFileSync(f, typeof data === "string" ? (data as string).replaceAll("$PORT", String(port)) : JSON.stringify(data).replaceAll("$PORT", String(port)));
}
const srv = Bun.spawn(["bun", new URL("./loop.ts", import.meta.url).pathname], { env: { ...process.env, PORT: String(port), OUT: `${D}/cap`, CWD: repo, IN_TOK: process.env.IN_TOK ?? "20000", OUT_TOK: process.env.OUT_TOK ?? "500" }, stdout: "ignore", stderr: "ignore" });
await Bun.sleep(800);
const prompt = "List the files in this directory.";
const args = [...h.args(port, prompt), ...extra];
const env = { PATH: process.env.PATH!, HOME: home, TERM: "dumb", NO_COLOR: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", ...(h.env?.(port) ?? {}), ...JSON.parse(process.env.EXTRA_ENV ?? "{}") };
for (const [k, v] of Object.entries(env)) env[k] = String(v).replaceAll("$PORT", String(port));
const t0 = Date.now();
const p = Bun.spawn([bin, ...args], { cwd: repo, env, stdin: "ignore", stdout: Bun.file(`${D}/stdout.txt`), stderr: Bun.file(`${D}/stderr.txt`) });
const stop = () => { p.kill("SIGTERM"); setTimeout(() => p.kill("SIGKILL"), 3000); };
const timer = setTimeout(stop, Number(tsec) * 1000);
// The start floor alone can't stop one run: 900 s at ~11 MB/s is ~10 GB, more than the 8 GB floor. So also check free
// space every 2 s and kill the harness below ABORT_FREE_GB (default max(2, MIN_FREE_GB/4)); the HOME is then always deleted.
const abortGB = Number(process.env.ABORT_FREE_GB ?? Math.max(2, minFree / 4)); let diskAbort = false, minSeenGB = freeGB;
const watch = setInterval(() => {
  const s = statfsSync(runsRoot), gb = (s.bavail * s.bsize) / 1e9; minSeenGB = Math.min(minSeenGB, gb);
  if (gb < abortGB && !diskAbort) { diskAbort = true; console.error(`disk abort: ${gb.toFixed(2)} GB free under ${runsRoot}, abort floor ${abortGB} GB`); stop(); }
}, 2000);
const code = await p.exited; clearTimeout(timer); clearInterval(watch);
const secs = (Date.now() - t0) / 1000; srv.kill();
const log = existsSync(`${D}/cap/index.log`) ? readFileSync(`${D}/cap/index.log`, "utf8").trim().split("\n").filter(Boolean) : [];
const calls = log.filter((l) => !l.includes("\tcall=-")).length;
const homeBytes = Number(Bun.spawnSync(["du", "-sb", home]).stdout.toString().split("\t")[0]) || 0;
const keep = process.env.KEEP_HOME === "1" && !diskAbort; if (!keep) rmSync(home, { recursive: true, force: true });
const res = { label, harness: id, args: extra, exit: code, timedOut: secs >= Number(tsec) - 0.5, secs: Math.round(secs), requests: log.length, toolCalls: calls, homeBytes, homeKept: keep, diskAbort, minFreeGB: Number(minSeenGB.toFixed(2)) };
writeFileSync(`${D}/result.json`, JSON.stringify(res, null, 1));
console.log(JSON.stringify(res));
