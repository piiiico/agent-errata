// CI step (table.yml, push to main): give every claim row without a serial its serial and every new runner its pool beacon,
// each from the drand round its earliest Rekor intent entry binds (scripts/witness.ts), published after that entry was logged. Never run by hand:
// validate.ts fails any change to claims/beacons.jsonl not committed by agent-errata-bot.
// Usage: RUN_URL=<actions run URL> bun scripts/beacon.ts <commit-message-file>
import { readdirSync, readFileSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { entries, intentBlob, boundRound, signedSerials, treeAt } from "./witness.ts";
import { draw, assignSerials, fetchRound, parseBeacons, roundTime, type Beacon, type RunRow } from "./draw.ts";

const dir = join(import.meta.dir, "..", "claims"), bf = join(dir, "beacons.jsonl");
const run = process.env.RUN_URL ?? "";
if (!/^https:\/\/github\.com\/piiiico\/agent-errata\/actions\/runs\/\d+/.test(run)) throw new Error("RUN_URL must be this repo's Actions run URL");
const beacons = existsSync(bf) ? parseBeacons(readFileSync(bf, "utf8")) : [];
const files = readdirSync(dir).filter((f) => /^K\d{3}\.jsonl$/.test(f)).sort();
const rows = files.map((f) => ({ f, lines: readFileSync(join(dir, f), "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l)) }));
// Past the highest SIGNED serial of each claim, not the highest committed one (swipepredictbot, 10-30): a serial signed in Rekor for a row
// that is gone is never handed to another runner; its own runner's refile gets it back (witness.ts signedSerials).
const S = signedSerials(async (serial) => (await entries(intentBlob({ serial }))).ok, treeAt(join(import.meta.dir, "..")));
const signed = await S.pending(beacons, files.map((f) => f.replace(/\.jsonl$/, "")));
const pending = assignSerials(rows.flatMap((x) => x.lines), [...beacons, ...signed]);
const runners = [...new Set(rows.flatMap((x) => x.lines.map((r) => String(r.runner))))].sort();
const newNames = runners.filter((n) => !beacons.some((b) => b.name === n));
if (!pending.length && !newNames.length) { console.log("beacon: nothing pending"); process.exit(0); }

// Serials first: deterministic from the file (scripts/draw.ts assignSerials), never from a round. validate.ts replays this at the commit
// the earliest intent entry was signed at, so the serial stays tied to the row (claim + runner) that was there when it was signed.
const added: Beacon[] = [];
for (const { r, serial, fresh } of pending) {
  r.serial = serial;
  if (fresh || !beacons.some((b) => b.serial === serial)) added.push({ serial, claim: r.claim, runner: String(r.runner), round: 0, randomness: "", run });
}
for (const name of newNames) added.push({ name, round: 0, randomness: "", run });

// Sign before reveal (scripts/witness.ts): each new serial/name gets its intent blob signed into Rekor unless an earlier run already did,
// and its round is the one the EARLIEST entry binds, at least MARGIN s after Rekor logged it. No round is fetched before this.
const cosign = process.env.COSIGN;
if (!cosign) throw new Error("COSIGN (path to the pinned cosign binary) is required: rounds are bound by Rekor entries");
const tmp = process.env.RUNNER_TEMP ?? "/tmp";
for (const b of added) {
  let { ok } = await entries(intentBlob(b));
  if (!ok.length) {
    const f = join(tmp, `intent-${b.serial ?? b.name}.txt`);
    writeFileSync(f, intentBlob(b));
    const p = Bun.spawnSync([cosign, "sign-blob", "--yes", "--rekor-url", "https://rekor.sigstore.dev", "--bundle", `${f}.bundle`, f], { stdout: "inherit", stderr: "inherit" });
    if (p.exitCode !== 0) throw new Error(`cosign sign-blob failed for ${b.serial ?? b.name}; no round fetched`);
    for (let i = 0; i < 12 && !ok.length; i++) { await Bun.sleep(5000); ({ ok } = await entries(intentBlob(b))); }
    if (!ok.length) throw new Error(`signed ${b.serial ?? b.name} but Rekor's index does not list it yet; rerun binds the same round`);
  }
  b.round = boundRound(ok[0].integratedTime);
  b.witness = ok[0].logIndex;
}
for (const round of [...new Set(added.map((b) => b.round))].sort((x, y) => x - y)) {
  await Bun.sleep(Math.max(0, (roundTime(round) + 3) * 1000 - Date.now()));
  const { randomness } = await fetchRound(round);
  for (const b of added) if (b.round === round) b.randomness = randomness;
}
const round = Math.max(...added.map((b) => b.round), 0), randomness = added.find((b) => b.round === round)?.randomness ?? "";
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
