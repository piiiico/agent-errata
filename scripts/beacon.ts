// CI step (table.yml, push to main): give every claim row without a serial its serial and every new runner its pool beacon,
// all from the latest drand round at run time, which is published after the push that triggered the run. Never run by hand:
// validate.ts fails any change to claims/beacons.jsonl not committed by agent-errata-bot.
// Usage: RUN_URL=<actions run URL> bun scripts/beacon.ts <commit-message-file>
import { readdirSync, readFileSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { draw, fetchRound, parseBeacons, roundTime, DRAND, type Beacon, type RunRow } from "./draw.ts";

const dir = join(import.meta.dir, "..", "claims"), bf = join(dir, "beacons.jsonl");
const run = process.env.RUN_URL ?? "";
if (!/^https:\/\/github\.com\/piiiico\/agent-errata\/actions\/runs\/\d+/.test(run)) throw new Error("RUN_URL must be this repo's Actions run URL");
const beacons = existsSync(bf) ? parseBeacons(readFileSync(bf, "utf8")) : [];
const files = readdirSync(dir).filter((f) => /^K\d{3}\.jsonl$/.test(f)).sort();
const rows = files.map((f) => ({ f, lines: readFileSync(join(dir, f), "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l)) }));
const onRows = new Set(rows.flatMap((x) => x.lines.map((r) => r.serial)).filter(Boolean));
const pendingRows = rows.flatMap((x) => x.lines.filter((r) => !r.serial));
const runners = [...new Set(rows.flatMap((x) => x.lines.map((r) => String(r.runner))))].sort();
const newNames = runners.filter((n) => !beacons.some((b) => b.name === n));
if (!pendingRows.length && !newNames.length) { console.log("beacon: nothing pending"); process.exit(0); }

// The first round published after this script started, so after the run started and after the push it is for.
const target = Math.floor((Date.now() / 1000 - DRAND.genesis) / DRAND.period) + 2;
await Bun.sleep(Math.max(0, (roundTime(target) + 3) * 1000 - Date.now()));
const { round, randomness } = await fetchRound(target);
const added: Beacon[] = [];
for (const r of pendingRows) {
  // Refile reuse: the oldest withdrawn serial of the same claim and runner, else the claim's next number.
  const back = beacons.find((b) => b.serial && b.claim === r.claim && b.runner === r.runner && !onRows.has(b.serial));
  if (back) { r.serial = back.serial; onRows.add(back.serial!); continue; }
  const n = [...beacons, ...added].filter((b) => b.claim === r.claim).length + 1;
  r.serial = `${r.claim}-${String(n).padStart(2, "0")}`;
  onRows.add(r.serial);
  added.push({ serial: r.serial, claim: r.claim, runner: String(r.runner), round, randomness, run });
}
for (const name of newNames) added.push({ name, round, randomness, run });
for (const { f, lines } of rows) writeFileSync(join(dir, f), lines.map(({ serial, ...rest }) => JSON.stringify({ serial, ...rest })).join("\n") + "\n");
if (added.length) appendFileSync(bf, added.map((b) => JSON.stringify(b)).join("\n") + "\n");

// Commit message: what was drawn, and any row whose REVIEW.md reviewer (by file and line) differs after the draw.
const all = [...beacons, ...added];
const runs: RunRow[] = rows.flatMap(({ f, lines }) => {
  const fm: any = Bun.YAML.parse(readFileSync(join(dir, f.replace(/\.jsonl$/, ".md")), "utf8").match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? "") ?? {};
  return lines.map((r, i) => ({ r, line: i + 1, author: String(fm.claim_by ?? ""), unparsed: false }));
});
const prev = new Map([...readFileSync(join(dir, "REVIEW.md"), "utf8").matchAll(/\[(K\d{3})\.jsonl:(\d+)\]\S*\s*\|\s*[^|]*\|\s*[^|]*\|\s*([^|]+?)\s*\|/g)].map((m) => [`${m[1]}:${m[2]}`, m[3]]));
const moved = draw(runs, all).rows.filter((x) => prev.has(`${x.claim}:${x.line}`) && !/^pending/.test(prev.get(`${x.claim}:${x.line}`)!) && prev.get(`${x.claim}:${x.line}`) !== x.reviewer);
const msg = [
  `Beacons: drand round ${round} for ${added.filter((b) => b.serial).length} new serial(s), ${newNames.length} new pool member(s)`,
  "",
  `Round ${round}, randomness ${randomness}, fetched by ${run}`,
  ...(moved.length ? ["", `Re-draw: reviewer moved on ${moved.length} row(s) since the last REVIEW.md:`, ...moved.map((x) => `  ${x.claim}.jsonl:${x.line} ${x.serial}: ${prev.get(`${x.claim}:${x.line}`)} -> ${x.reviewer}`)] : []),
].join("\n");
if (process.argv[2]) writeFileSync(process.argv[2], msg + "\n");
console.log(msg);
