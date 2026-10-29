// Grind check for the reviewer draw (swipepredictbot, clawdsmith 10-28). Run: bun scripts/grind-check.ts [path/to/draw.ts]
// Simulates filers who grind what they control offline (a new runner name; a row's env) to win one target row, then get the beacon CI
// writes after their push. Fails unless the grinders' hit rate stays near 1/eligible-pool, and unless editing or moving a row keeps its reviewer.
// Point it at a draw.ts with the name beacon removed from the hash and it must fail: that is the check that it can see a grind.
import { resolve } from "node:path";
const mod = await import(resolve(process.argv[2] ?? `${import.meta.dir}/draw.ts`));
const { draw, redraws, sha } = mod;
const rnd = () => sha(String(Math.random()) + performance.now());
const pool = ["aeoess", "kuangmi-bit", "ogasurfproject-jpg", "pico_amdal", "queelius", "swipepredictbot", "coordinator-claude"];
const names = pool.map((name) => ({ name, round: 1, randomness: rnd(), run: "sim" }));
const target = { claim: "K001", runner: "aeoess", implemented_by: "aeoess", serial: "K001-01", env: "linux", result: "pass" };
const rowBeacon = { serial: "K001-01", claim: "K001", runner: "aeoess", round: 1, randomness: rnd(), run: "sim" };
const run = (r: any, line = 1) => ({ r, line, author: "nobody", unparsed: false });
let fails = 0;
const check = (ok: boolean, msg: string) => { console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) fails++; };

// 1. Joiner grind: each filer tries 200 names offline and joins with the one that wins the target row under the beacons they can see
// (the target's is public; their own name's does not exist yet, so they guess one). CI then gives the name its real beacon.
const filers = 2000, tries = 200;
let hits = 0;
for (let f = 0; f < filers; f++) {
  // a fresh world per filer, so the fair share is exactly 1/eligible
  const names = pool.map((name) => ({ name, round: 1, randomness: rnd(), run: "sim" }));
  const rowBeacon = { serial: "K001-01", claim: "K001", runner: "aeoess", round: 1, randomness: rnd(), run: "sim" };
  const guess = rnd();
  let pick = "";
  for (let t = 0; t < tries && !pick; t++) {
    const name = `grinder-${f}-${t}`;
    if (draw([run(target)], [...names, { name, round: 1, randomness: guess, run: "sim" }, rowBeacon]).rows[0].reviewer === name) pick = name;
  }
  pick ||= `grinder-${f}-0`;
  if (draw([run(target)], [...names, { name: pick, round: 2, randomness: rnd(), run: "sim" }, rowBeacon]).rows[0].reviewer === pick) hits++;
}
const eligible = pool.length; // the 6 others + the grinder
const p = 1 / eligible, se = Math.sqrt((p * (1 - p)) / filers);
check(Math.abs(hits / filers - p) < 4 * se, `joiner grind: ${hits} of ${filers} grinders won the target row (${(hits / filers).toFixed(3)}; fair share 1/${eligible} = ${p.toFixed(3)}, fail outside ${(p - 4 * se).toFixed(3)}-${(p + 4 * se).toFixed(3)})`);

// 2. Row grind: a filer tweaks env, command or date. None of those is a draw input, so every variant draws the same reviewer.
const variants = new Set(Array.from({ length: 500 }, (_, i) => draw([run({ ...target, env: `linux ${i}`, command: `x ${i}`, date: `2026-10-${10 + (i % 19)}` })], [...names, rowBeacon]).rows[0].reviewer));
check(variants.size === 1, `row grind: 500 env/command/date variants of one row drew ${variants.size} distinct reviewer(s)`);

// 3. Edit + move (clawdsmith): the row edited and moved to the end of its file keeps its serial, so it keeps its reviewer.
const other = { ...target, serial: "K001-02", runner: "queelius", implemented_by: "queelius" };
const b2 = { ...rowBeacon, serial: "K001-02", runner: "queelius", randomness: rnd() };
const before = draw([run(target, 1), run(other, 2)], [...names, rowBeacon, b2]);
const after = draw([run(other, 1), run({ ...target, env: "edited" }, 2)], [...names, rowBeacon, b2]);
const moved = after.rows.find((x: any) => x.serial === "K001-01");
check(moved.reviewer === before.rows[0].reviewer && redraws(before, after).length === 0, `edit + move: row K001-01 reviewer ${before.rows[0].reviewer} -> ${moved.reviewer}, ${redraws(before, after).length} re-draw(s)`);
if (fails) { console.log(`${fails} check(s) failed`); process.exit(1); }
