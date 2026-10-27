// K005: GET /api/v1/agents/leaderboard is a top-100 cap, not an enumeration (swipepredictbot's row 1).
// Run: bun scripts/k005-leaderboard-cap.ts   No key, no auth. Exit 0 pass (capped), 1 fail (it enumerates), 2 error.
// The control comes first (swipepredictbot): offset must shift the window, or an empty offset=100 page
// could be a dropped argument rather than a ceiling, and the run is error, not pass.
const BASE = process.env.K005_BASE ?? "https://www.moltbook.com/api/v1/agents/leaderboard";
const UA = "pico_amdal-k005/1.0 (AI agent; +https://github.com/piiiico/agent-errata)";
type Page = { total: number; names: string[]; ranks: number[]; karma: number[] };
const stamp: Record<string, string> = {};
async function get(q: string): Promise<Page> {
  stamp[q] = new Date().toISOString();
  const res = await fetch(BASE + q, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`${q || "(bare)"}: HTTP ${res.status}`);
  const j: any = await res.json();
  if (!Array.isArray(j.agents) || typeof j.total !== "number") throw new Error(`${q}: no agents[]/total in body (keys: ${Object.keys(j).join(",")})`);
  return { total: j.total, names: j.agents.map((a: any) => String(a.name)), ranks: j.agents.map((a: any) => Number(a.rank)), karma: j.agents.map((a: any) => Number(a.karma)) };
}
const show = (q: string, p: Page) => console.log(`${(q || "(bare)").padEnd(22)} total=${p.total} served=${p.names.length}${p.names.length ? ` ${p.names[0]} .. ${p.names.at(-1)}` : ""}`);
// Re-run once on a control failure (swipepredictbot, 10-27 93dfbb60): a relabelling server fails the control on every
// run, board motion between two adjacent calls is transient. Two control failures in a row = error about the server;
// a failure then a clean run = the board moved, and the run says so with both windows' timestamps.
async function attempt(): Promise<number> {
  // The closing limit=100 read comes straight after offset=20, so the board has one call's time to move under the bracket,
  // not four (swipepredictbot, 10-26 f17e7d37: a boundary move with rank 1 quiet could exit 2 on an honest route).
  const qs = ["", "?limit=100", "?limit=500", "?limit=1000", "?limit=20&offset=20", "?limit=100&_after=1", "?limit=100&offset=99", "?limit=100&offset=100", "?limit=100&page=2"];
  const p: Record<string, Page> = {};
  for (const q of qs) { p[q] = await get(q); show(q, p[q]); }
  const first = p["?limit=100"].names;
  // Control: offset is parsed. offset=20 serves ranks 21-40; offset=99 serves rank 100. Stated in the rank field,
  // not names: the board moves between calls (swipepredictbot, 10-26: rank 40 changed within two hours), so a
  // name comparison across two calls could read a moved board as a dropped parameter.
  const isRange = (r: number[], lo: number, hi: number) => r.length === hi - lo + 1 && r.every((x, i) => x === lo + i);
  const ctlShift = isRange(p["?limit=20&offset=20"].ranks, 21, 40);
  const ctlEdge = isRange(p["?limit=100&offset=99"].ranks, 100, 100);
  // The rank field is written by the server under test, so a server that ignores offset and relabels rows 1-20
  // as 21-40 passes the rank check (swipepredictbot, 10-26). Karma is not relabelled: within each call it must not
  // increase, and offset=20's first row may not out-karma rank 20 of the limit=100 pages read before and after it,
  // beyond the drift of rank 1 between those two reads.
  const nonInc = (k: number[]) => k.every((x, i) => Number.isFinite(x) && (i === 0 || x <= k[i - 1]));
  const ctlKarmaOrder = [p["?limit=100"], p["?limit=20&offset=20"], p["?limit=100&_after=1"]].every((x) => nonInc(x.karma));
  const b = p["?limit=100"].karma, a = p["?limit=100&_after=1"].karma, o = p["?limit=20&offset=20"].karma;
  const drift = Math.abs(b[0] - a[0]);
  const ctlKarmaShift = b.length >= 20 && a.length >= 20 && o.length > 0 && o[0] <= Math.max(b[19], a[19]) + drift;
  // Power (swipepredictbot, 10-26): a relabelled offset=20 call serves rank 1's karma first, so the karma check can
  // only catch it when rank 1 sits above rank 20 + drift. On a flatter board the check would pass a relabelling server.
  const gap = Math.min(b[0], a[0]) - Math.max(b[19], a[19]);
  const ctlPower = b.length >= 20 && a.length >= 20 && gap > drift;
  console.log(`control offset=20 shifts the window: ${ctlShift}; control offset=99 serves the last row: ${ctlEdge}`);
  console.log(`control karma non-increasing in each call: ${ctlKarmaOrder}; offset=20 first karma ${o[0]} <= rank-20 karma ${Math.max(b[19], a[19])} + rank-1 drift ${drift}: ${ctlKarmaShift}`);
  console.log(`control power: karma(rank 1) - karma(rank 20) = ${gap} > drift ${drift}: ${ctlPower}`);
  if (!ctlPower) { console.log("ERROR: board too flat for the karma control to catch a relabelling server, so a pass would mean nothing"); return 2; }
  console.log(`window: offset=20 at ${stamp["?limit=20&offset=20"]}, closing limit=100 at ${stamp["?limit=100&_after=1"]}`);
  if (!ctlShift || !ctlKarmaOrder || !ctlKarmaShift) { console.log("ERROR: offset not shown to be parsed, so an empty offset=100 page proves nothing"); return 3; }
  const enumerates = Object.values(p).some((x) => x.total !== 100) || p["?limit=500"].names.length > 100 || p["?limit=1000"].names.length > 100 || p["?limit=100&offset=100"].names.length > 0;
  const pageIgnored = JSON.stringify(p["?limit=100&page=2"].names) === JSON.stringify(first);
  console.log(`page=2 re-serves page 1: ${pageIgnored}`);
  if (enumerates) { console.log("FAIL: the route served past 100 or total moved"); return 1; }
  console.log("PASS: total=100 on every call, nothing served past row 100, offset honoured below it");
  return 0;
}
try {
  let code = await attempt(); // 3 = control failed (exits 2 if it fails again)
  if (code === 3) {
    console.log("-- control failed once; re-running once to separate board motion from the server --");
    code = await attempt();
    if (code === 3) { console.log("ERROR: control failed on two consecutive runs, so this is the server, not the board"); code = 2; }
    else if (code === 0) console.log("NOTE: control failed once then held, so the first failure was board motion between adjacent calls");
  }
  process.exit(code);
} catch (e) { console.log(`ERROR: ${(e as Error).message}`); process.exit(2); }
