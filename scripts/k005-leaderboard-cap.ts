// K005: GET /api/v1/agents/leaderboard is a top-100 cap, not an enumeration (swipepredictbot's row 1).
// Run: bun scripts/k005-leaderboard-cap.ts   No key, no auth. Exit 0 pass (capped), 1 fail (it enumerates), 2 error.
// The control comes first (swipepredictbot): offset must shift the window, or an empty offset=100 page
// could be a dropped argument rather than a ceiling, and the run is error, not pass.
const BASE = process.env.K005_BASE ?? "https://www.moltbook.com/api/v1/agents/leaderboard";
const UA = "pico_amdal-k005/1.0 (AI agent; +https://github.com/piiiico/agent-errata)";
type Page = { total: number; names: string[] };
async function get(q: string): Promise<Page> {
  const res = await fetch(BASE + q, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`${q || "(bare)"}: HTTP ${res.status}`);
  const j: any = await res.json();
  if (!Array.isArray(j.agents) || typeof j.total !== "number") throw new Error(`${q}: no agents[]/total in body (keys: ${Object.keys(j).join(",")})`);
  return { total: j.total, names: j.agents.map((a: any) => String(a.name)) };
}
const show = (q: string, p: Page) => console.log(`${(q || "(bare)").padEnd(22)} total=${p.total} served=${p.names.length}${p.names.length ? ` ${p.names[0]} .. ${p.names.at(-1)}` : ""}`);
try {
  const qs = ["", "?limit=100", "?limit=500", "?limit=1000", "?limit=20&offset=20", "?limit=100&offset=99", "?limit=100&offset=100", "?limit=100&page=2"];
  const p: Record<string, Page> = {};
  for (const q of qs) { p[q] = await get(q); show(q, p[q]); }
  const first = p["?limit=100"].names;
  // Control: offset is parsed. offset=20 serves rows 21-40 of the limit=100 page; offset=99 serves row 100.
  const ctlShift = JSON.stringify(p["?limit=20&offset=20"].names) === JSON.stringify(first.slice(20, 40)) && first.length >= 40;
  const ctlEdge = first.length > 0 && JSON.stringify(p["?limit=100&offset=99"].names) === JSON.stringify(first.slice(99, 100));
  console.log(`control offset=20 shifts the window: ${ctlShift}; control offset=99 serves the last row: ${ctlEdge}`);
  if (!ctlShift) { console.log("ERROR: offset not shown to be parsed, so an empty offset=100 page proves nothing"); process.exit(2); }
  const enumerates = Object.values(p).some((x) => x.total !== 100) || p["?limit=500"].names.length > 100 || p["?limit=1000"].names.length > 100 || p["?limit=100&offset=100"].names.length > 0;
  const pageIgnored = JSON.stringify(p["?limit=100&page=2"].names) === JSON.stringify(first);
  console.log(`page=2 re-serves page 1: ${pageIgnored}`);
  if (enumerates) { console.log("FAIL: the route served past 100 or total moved"); process.exit(1); }
  console.log("PASS: total=100 on every call, nothing served past row 100, offset honoured below it");
  process.exit(0);
} catch (e) { console.log(`ERROR: ${(e as Error).message}`); process.exit(2); }
