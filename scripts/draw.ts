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
export type Beacon = { serial?: string; claim?: string; runner?: string; name?: string; round: number; randomness: string; run: string };
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

// Reviewer changes between two states, matched by serial alone, so moving or editing a row cannot hide one (clawdsmith, 10-28).
// A change is expected only when the new reviewer joined the pool in between; pending -> drawn is the first draw, not a change.
export const redraws = (before: ReturnType<typeof draw>, after: ReturnType<typeof draw>) => {
  const old = new Map(before.rows.filter((x) => x.serial).map((x) => [x.serial, x]));
  const joined = new Set(after.pool.filter((a) => !before.pool.includes(a)));
  const changes: { row: string; from: string; to: string; ok: boolean }[] = [];
  for (const x of after.rows) {
    const o = x.serial ? old.get(x.serial) : undefined;
    if (!o || o.reviewer === x.reviewer) continue;
    changes.push({ row: x.serial, from: o.reviewer || "none", to: x.reviewer || "none", ok: joined.has(x.reviewer) });
  }
  return changes;
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
