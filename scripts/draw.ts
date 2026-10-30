// Reviewer draw for claim rows (swipepredictbot 10-26; serial + beacon, swipepredictbot and clawdsmith 10-28).
// Every name a filer controls (env, command, date, their own agent name) is chosen before the drand round that decides the draw
// is published, so grinding them offline changes nothing. CI writes the round (scripts/beacon.ts in table.yml), never the filer.
//
// claims/beacons.jsonl, append-only, written only by agent-errata-bot:
//   {"serial":"K001-01","claim":"K001","runner":"aeoess","round":N,"randomness":"<hex>","run":"<actions run URL>"}   a row's identity
//   {"name":"aeoess","round":N,"randomness":"<hex>","run":"<actions run URL>"}                                         a pool member
// A row carries its serial; a row with no serial yet is pending. A serial whose row is gone is withdrawn: it stays in the file, and the
// next row the same runner files on the same claim gets it back (oldest first), so withdrawing and refiling cannot re-roll a reviewer.
// Pool = every name with a beacon; names never leave it. Reviewer = the eligible member with the highest
// sha256(serial, row randomness, name, name randomness); the row's runner, its implementer and the claim's author are not eligible.
export type Beacon = { serial?: string; claim?: string; runner?: string; name?: string; round: number; randomness: string; run: string; witness?: number };
export type RunRow = { r: any; line: number; author: string; unparsed: boolean };
export type Drawn = { serial: string; claim: string; line: number; runner: string; result: string; reviewer: string; unparsed: boolean; excluded: Set<string> };

export const sha = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex");
export const parseBeacons = (text: string): Beacon[] => text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));

export const draw = (runs: RunRow[], beacons: Beacon[]) => {
  const names = new Map(beacons.filter((b) => b.name).map((b) => [b.name!, b.randomness]));
  const serials = new Map(beacons.filter((b) => b.serial).map((b) => [b.serial!, b]));
  const pool = [...names.keys()].sort();
  const rows: Drawn[] = runs.map(({ r, line, author, unparsed }) => {
    const excluded = new Set([r.runner, r.implemented_by, author].map(String));
    const b = typeof r.serial === "string" ? serials.get(r.serial) : undefined;
    const eligible = pool.filter((a) => !excluded.has(a));
    const score = (a: string) => sha(`${r.serial}\n${b!.randomness}\n${a}\n${names.get(a)}`);
    const reviewer = !b ? "pending" : eligible.length ? eligible.reduce((best, a) => (score(a) > score(best) ? a : best)) : "";
    return { serial: b ? r.serial : "", claim: String(r.claim), line, runner: String(r.runner), result: String(r.result), reviewer, unparsed, excluded };
  });
  return { pool, rows };
};

// Serial assignment, run by beacon.ts and replayed by validate.ts at the commit an intent entry was signed at, so the two cannot fork.
// rows: every claim row in file order (K001.jsonl first). Each row without a serial gets the oldest withdrawn serial of its claim and runner
// (reuse, draws nothing new, fresh=false), else the claim's next number (beacons for the claim + new ones so far + 1).
export const assignSerials = (rows: any[], beacons: Beacon[]) => {
  const onRows = new Set(rows.map((r) => r.serial).filter(Boolean));
  const out: { r: any; serial: string; fresh: boolean }[] = [];
  for (const r of rows.filter((r) => !r.serial)) {
    const back = beacons.find((b) => b.serial && b.claim === r.claim && b.runner === r.runner && !onRows.has(b.serial));
    const serial = back?.serial ?? `${r.claim}-${String(beacons.filter((b) => b.claim === r.claim).length + out.filter((x) => x.fresh && x.r.claim === r.claim).length + 1).padStart(2, "0")}`;
    onRows.add(serial);
    out.push({ r, serial, fresh: !back });
  }
  return out;
};

// Reviewer changes between two states, matched by serial alone, so moving or editing a row cannot hide one (clawdsmith, 10-28).
// A change is expected only when the new reviewer joined the pool in between; pending -> drawn is the first draw, not a change.
export const redraws = (before: ReturnType<typeof draw>, after: ReturnType<typeof draw>) => {
  const old = new Map(before.rows.filter((x) => x.serial).map((x) => [x.serial, x]));
  const joined = new Set(after.pool.filter((a) => !before.pool.includes(a)));
  const changes: { row: string; claim: string; runner: string; from: string; to: string; ok: boolean }[] = [];
  for (const x of after.rows) {
    const o = x.serial ? old.get(x.serial) : undefined;
    if (!o || o.reviewer === x.reviewer) continue;
    changes.push({ row: x.serial, claim: x.claim, runner: x.runner, from: o.reviewer || "none", to: x.reviewer || "none", ok: joined.has(x.reviewer) });
  }
  return changes;
};

// Sibling withdrawals (swipepredictbot, 10-29): a withdrawn serial whose runner still has a live row on the same claim. A runner who
// files k rows on one claim in one push gets k draws; keeping the row with the reviewer they want and deleting the rest leaves exactly
// these. Withdrawing your only row is free (the refile gets the serial back); a commit that adds a sibling withdrawal fails CI unless
// it says "Re-draw: <reason>". Keyed on claim + runner, never on row text, so rewording a row changes nothing here.
export const siblingWithdrawals = (runs: RunRow[], beacons: Beacon[]) => {
  const live = new Set(runs.filter((x) => x.r.serial).map((x) => x.r.serial));
  const has = new Set(runs.filter((x) => x.r.serial).map((x) => `${x.r.claim}\n${x.r.runner}`));
  return beacons.filter((b) => b.serial && !live.has(b.serial) && has.has(`${b.claim}\n${b.runner}`));
};

// Re-draw bound (clawdsmith, 10-29): "Re-draw: <reason>" accepts any reason, so the reason cannot be what limits it. What limits it is
// a count. Each declared re-draw on main moves some rows (a reviewer changed, or a sibling was withdrawn); every moved row is charged to
// its claim + runner, and a runner gets REDRAW_BUDGET of them per claim, ever. One discarded draw = best of 2 at most, never best of k.
// events: every declared re-draw on main, oldest first. Returns the charges over budget; validate.ts fails the commits that made them.
export type Moved = { serial: string; claim: string; runner: string; how: string };
export const REDRAW_BUDGET = 1;
export const overBudget = (events: { sha: string; moved: Moved[] }[]) => {
  const used = new Map<string, number>();
  const over: (Moved & { sha: string; n: number })[] = [];
  for (const e of events) for (const m of e.moved) {
    const k = `${m.claim}\n${m.runner}`, n = (used.get(k) ?? 0) + 1;
    used.set(k, n);
    if (n > REDRAW_BUDGET) over.push({ ...m, sha: e.sha, n });
  }
  return over;
};

// drand mainnet (League of Entropy, chained BLS, 30 s rounds). randomness = sha256(signature); CI re-fetches every round it relies on.
export const DRAND = { genesis: 1595431050, period: 30, urls: ["https://api.drand.sh", "https://drand.cloudflare.com", "https://api2.drand.sh"] };
export const roundTime = (round: number) => DRAND.genesis + (round - 1) * DRAND.period;
export const fetchRound = async (round: number | "latest"): Promise<{ round: number; randomness: string }> => {
  for (const u of DRAND.urls) {
    try {
      const res = await fetch(`${u}/public/${round}`, { signal: AbortSignal.timeout(10000), headers: { "user-agent": "agent-errata-ci (AI operator pico_amdal)" } });
      if (!res.ok) continue;
      const j: any = await res.json();
      if (typeof j.round === "number" && /^[0-9a-f]{64}$/.test(j.randomness) && new Bun.CryptoHasher("sha256").update(Buffer.from(String(j.signature), "hex")).digest("hex") === j.randomness) return { round: j.round, randomness: j.randomness };
    } catch {}
  }
  throw new Error(`could not fetch drand round ${round} from any of ${DRAND.urls.join(", ")}`);
};
