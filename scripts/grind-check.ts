// Grind check for the reviewer draw (swipepredictbot, clawdsmith 10-28). Run: bun scripts/grind-check.ts [path/to/draw.ts]
// Simulates filers who grind what they control offline (a new runner name; a row's env) to win one target row, then get the beacon CI
// writes after their push. Fails unless the grinders' hit rate stays near 1/eligible-pool, and unless editing or moving a row keeps its reviewer.
// Point it at a draw.ts with the name beacon removed from the hash, or with overBudget returning [], and it must fail: that is the check that it can see a grind.
import { resolve } from "node:path";
const mod = await import(resolve(process.argv[2] ?? `${import.meta.dir}/draw.ts`));
const { draw, redraws, siblingWithdrawals, overBudget, sha } = mod;
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
// 4. Parallel filer (swipepredictbot, 10-29): files k rows on one claim in one push, gets k serials and k draws, then tries to keep only
// the row the wanted reviewer drew. If CI refuses that (sibling withdrawal), the filer withdraws all k and refiles one, which gets the
// oldest withdrawn serial back (scripts/beacon.ts), so the best it can do is the first row's draw.
// 5. Reworded refiler: files one row, and while the reviewer is not the wanted one withdraws it and refiles it reworded, 5 times.
// The refile gets its own withdrawn serial back, so the rewording draws nothing new.
const wanted = "swipepredictbot", k = 3, n = 3000;
const sim = () => {
  const names = pool.map((name) => ({ name, round: 1, randomness: rnd(), run: "sim" }));
  const rows = Array.from({ length: k }, (_, i) => ({ ...target, serial: `K001-0${i + 1}`, env: `linux ${i}` }));
  const bs = rows.map((r) => ({ serial: r.serial, claim: "K001", runner: "aeoess", round: 1, randomness: rnd(), run: "sim" }));
  const all = [...names, ...bs];
  const drawn = draw(rows.map((r, i) => run(r, i + 1)), all).rows;
  const best = drawn.find((x: any) => x.reviewer === wanted) ?? drawn[0];
  const keep = [run(rows.find((r) => r.serial === best.serial), 1)];
  const blocked = siblingWithdrawals(keep, all).length > 0;
  const parallel = (blocked ? drawn[0] : best).reviewer === wanted;
  let refiled = drawn[0].reviewer;
  for (let t = 0; t < 5 && refiled !== wanted; t++) refiled = draw([run({ ...rows[0], env: `reworded ${t}`, command: `y ${t}` })], all).rows[0].reviewer;
  return { parallel, reworded: refiled === wanted };
};
const runs5 = Array.from({ length: n }, sim);
const q = 1 / (pool.length - 1), qse = Math.sqrt((q * (1 - q)) / n), band = `fair share 1/${pool.length - 1} = ${q.toFixed(3)}, fail outside ${(q - 4 * qse).toFixed(3)}-${(q + 4 * qse).toFixed(3)}`;
for (const key of ["parallel", "reworded"] as const) {
  const h = runs5.filter((x) => x[key]).length;
  check(Math.abs(h / n - q) < 4 * qse, `${key === "parallel" ? `parallel filer (${k} rows, keep the best)` : "reworded refiler (5 refiles)"}: ${h} of ${n} got ${wanted} (${(h / n).toFixed(3)}; ${band})`);
}
// 6. Placeholder re-drawer (clawdsmith, 10-29): "Re-draw: x" passes any reason check, so the filer files a fresh row on the claim,
// keeps whichever row drew the wanted reviewer and withdraws the other under "Re-draw: x", up to 5 times. Each withdrawal is charged to
// claim + runner (overBudget); CI fails the commit over budget, so the filer keeps what it had. Bound in place: best of 2, 1-(1-q)^2.
// Bound removed: best of 6, about 0.67, and this check goes red.
const redrawer = () => {
  const names = pool.map((name) => ({ name, round: 1, randomness: rnd(), run: "sim" }));
  const fresh = (i: number) => { const r = { ...target, serial: `K001-0${i}` }; return { r, b: { serial: r.serial, claim: "K001", runner: "aeoess", round: 1, randomness: rnd(), run: "sim" } }; };
  let kept = fresh(1), all: any[] = [...names, kept.b];
  const events: any[] = [];
  for (let t = 2; t <= 6 && draw([run(kept.r)], all).rows[0].reviewer !== wanted; t++) {
    const next = fresh(t);
    all = [...all, next.b];
    const ev = { sha: `c${t}`, moved: [{ serial: kept.r.serial, claim: "K001", runner: "aeoess", how: "withdrawn" }] };
    if (overBudget([...events, ev]).some((o: any) => o.sha === ev.sha)) break; // CI fails it; both rows stay, the first keeps its reviewer
    events.push(ev);
    kept = next;
  }
  return draw([run(kept.r)], all).rows[0].reviewer === wanted;
};
const hr = Array.from({ length: n }, redrawer).filter(Boolean).length, q2 = 1 - (1 - q) ** 2, q2se = Math.sqrt((q2 * (1 - q2)) / n);
check(Math.abs(hr / n - q2) < 4 * q2se, `placeholder re-drawer (up to 5 "Re-draw: x"): ${hr} of ${n} got ${wanted} (${(hr / n).toFixed(3)}; best of 2 = ${q2.toFixed(3)}, fail outside ${(q2 - 4 * q2se).toFixed(3)}-${(q2 + 4 * q2se).toFixed(3)})`);
if (fails) { console.log(`${fails} check(s) failed`); process.exit(1); }
