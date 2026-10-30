// Fixture arms for serial ordering and draws bound at signature (swipepredictbot, 10-30, Moltbook c031d4c2 b6465e06). No network:
// Rekor and git are stand-ins. Usage: bun scripts/serial-arms.ts [old-witness.ts] — with a path to an older witness.ts (e.g. 036a1a6's),
// also prints what that version does on the same fixtures. Exits 1 if an arm fails on this version.
import { signedSerials, orderFail, owedDraw, rowFail, type Entry, type Tree } from "./witness.ts";
import type { Beacon } from "./draw.ts";

const fails: string[] = [];
const arm = (name: string, ok: boolean, got: unknown) => { console.log(`${ok ? "ok  " : "FAIL"} ${name}: ${JSON.stringify(got)}`); if (!ok) fails.push(name); };

// K001 has serials 01..12 with beacons; pool X, Y, A, B; the claim's author is Z.
const C1 = "1".repeat(40), C2 = "2".repeat(40);
const kept = Array.from({ length: 12 }, (_, i) => ({ claim: "K001", runner: "X", serial: `K001-${String(i + 1).padStart(2, "0")}`, result: "pass" }));
const beacons: Beacon[] = [
  ...kept.map((r) => ({ serial: r.serial, claim: "K001", runner: "X", round: 1, randomness: "00", run: "" })),
  ...["X", "Y", "A", "B"].map((name, i) => ({ name, round: 1, randomness: `0${i + 1}`, run: "" })),
];
const jsonl = (rows: object[]) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
const bj = jsonl(beacons);
// C1: A's row filed, K001-13 signed there. C2: A's row deleted, B's row filed, K001-14 signed there.
const tree: Tree = (at) => at === C1 ? { claims: [jsonl([...kept, { claim: "K001", runner: "A", result: "fail" }])], beacons: bj }
  : at === C2 ? { claims: [jsonl([...kept, { claim: "K001", runner: "B", result: "pass" }])], beacons: bj } : undefined;
// 13 and 14 logged in the same second, 13 first.
const rekor: Record<string, Entry[]> = { "K001-13": [{ integratedTime: 1_800_000_000, logIndex: 100, uuid: "u13", at: C1 }], "K001-14": [{ integratedTime: 1_800_000_000, logIndex: 101, uuid: "u14", at: C2 }] };
const lookup = async (s: string) => rekor[s] ?? [];

// (1) Cutoff by logIndex. Replaying 14 counts serials signed before 14's entry; 13 is one, though it shares 14's second.
const S = signedSerials(lookup, tree);
const before14 = await S.pending(beacons, ["K001"], rekor["K001-14"][0].logIndex);
arm("logIndex cutoff counts 13 (same second as 14)", before14.map((p) => p.serial).join() === "K001-13", before14.map((p) => p.serial));
const why14 = rowFail({ serial: "K001-14", claim: "K001", runner: "B" }, C2, tree, before14);
arm("B's refile as K001-14 is green", why14 === "", why14);

// Skipped / pre-signed serial: 14's earliest entry logged before 13's.
arm("in-order serials are green", orderFail([{ serial: "K001-13", entry: 100 }, { serial: "K001-14", entry: 101 }]).length === 0, orderFail([{ serial: "K001-13", entry: 100 }, { serial: "K001-14", entry: 101 }]));
const pre = orderFail([{ serial: "K001-13", entry: 200 }, { serial: "K001-14", entry: 150 }]);
arm("K001-14 logged before K001-13 is red", pre.length === 1 && pre[0].startsWith("K001-14"), pre);

// (2) Draw binds at signature. Today: A's row gone, no beacon for 13 or 14. 13 is still owed, by the reviewer drawn for A's row as of C1.
const now = await signedSerials(lookup, tree).pending(beacons, ["K001"]);
const p13 = now.find((p) => p.serial === "K001-13")!;
const R = "ab".repeat(32);
const reviewer = owedDraw({ serial: "K001-13", row: p13.row }, "Z", R, beacons);
arm("13 owed: runner A, row as of C1, reviewer drawn", p13.runner === "A" && p13.at === C1 && ["X", "Y", "B"].includes(reviewer), { runner: p13.runner, at: String(p13.at).slice(0, 7), reviewer });

if (process.argv[2]) {
  const old = await import(process.argv[2]);
  const O = old.signedSerials(lookup, tree);
  // 036a1a6: validate.ts passed ok[0].integratedTime as the cutoff.
  const o14 = await O.pending(beacons, ["K001"], rekor["K001-14"][0].integratedTime);
  console.log(`old  integratedTime cutoff, replaying 14: pending ${JSON.stringify(o14.map((p: any) => p.serial))}; rowFail: ${JSON.stringify(old.rowFail({ serial: "K001-14", claim: "K001", runner: "B" }, C2, tree, o14))}`);
  const oNow = await old.signedSerials(lookup, tree).pending(beacons, ["K001"]);
  console.log(`old  13 today: ${JSON.stringify(oNow.find((p: any) => p.serial === "K001-13"))} (no row, no reviewer)`);
}
if (fails.length) { console.error(`${fails.length} arm(s) failed`); process.exit(1); }
