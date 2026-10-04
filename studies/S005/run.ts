// S005 runner: one harness, one scratch HOME + repo, pointed at loop2.ts; stops at the harness's own exit or at TIMEOUT.
// Usage: bun run.ts <label> <harness-id> [timeoutSec] [-- extra args...]   env: EXTRA_ENV='{"K":"V"}' SETUP_JSON='{"rel/path":{...}}'
import { HARNESSES } from "../S003/watch/harnesses.ts";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "fs";
const [label, id, tsec = "90", ...rest] = process.argv.slice(2);
const extra = rest[0] === "--" ? rest.slice(1) : rest;
const h = HARNESSES.find((x) => x.id === id)!;
// Where each binary lives on OUR box; override with BIN_<ID>=/path or BIN_DIR=dir.
const BIN: Record<string, string> = {
  claude: "/workspace/tmp/s005/npm/node_modules/.bin/claude", qwen: "/workspace/tmp/s003-bin/node_modules/.bin/qwen",
  crush: "/workspace/tmp/s003-bin/node_modules/.bin/crush", goose: "/workspace/tmp/s005/gbin/goose",
};
const bin = process.env[`BIN_${id.toUpperCase()}`] ?? BIN[id] ?? `${process.env.BIN_DIR ?? "./node_modules/.bin"}/${h.bin}`;
const D = `${process.env.RUNS ?? "./runs"}/${label}`; rmSync(D, { recursive: true, force: true });
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
const timer = setTimeout(() => { p.kill("SIGTERM"); setTimeout(() => p.kill("SIGKILL"), 3000); }, Number(tsec) * 1000);
const code = await p.exited; clearTimeout(timer);
const secs = (Date.now() - t0) / 1000; srv.kill();
const log = existsSync(`${D}/cap/index.log`) ? readFileSync(`${D}/cap/index.log`, "utf8").trim().split("\n").filter(Boolean) : [];
const calls = log.filter((l) => !l.includes("\tcall=-")).length;
const res = { label, harness: id, args: extra, exit: code, timedOut: secs >= Number(tsec) - 0.5, secs: Math.round(secs), requests: log.length, toolCalls: calls };
writeFileSync(`${D}/result.json`, JSON.stringify(res, null, 1));
console.log(JSON.stringify(res));
