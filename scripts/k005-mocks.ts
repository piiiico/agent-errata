// Four mock leaderboards for K005: enumerate150, ignoreOffset (true ranks), movingNames (ranks right, names churn), relabel (ignores offset, ranks = offset+i), flatRelabel (relabel on a board whose top 20 share one karma)
// Run: bun scripts/k005-mocks.ts, then K005_BASE=http://localhost:8799/<mode> bun scripts/k005-leaderboard-cap.ts. Expected exits: honest 0, enumerate150 1, ignoreOffset 2, movingNames 0, relabel 2, flatRelabel 2.
const N = 100;
let call = 0;
const mk = (n: number, tag = "") => Array.from({ length: n }, (_, i) => ({ name: `a${i + 1}${tag}`, rank: i + 1, karma: 1_000_000 - i * 1000 }));
Bun.serve({ port: 8799, fetch(req) {
  const u = new URL(req.url); const mode = u.pathname.slice(1);
  const limit = Math.min(Number(u.searchParams.get("limit") ?? 50), mode === "enumerate150" ? 1000 : 100);
  const off = Number(u.searchParams.get("offset") ?? 0); call++;
  let rows: any[]; let total = N;
  if (mode === "enumerate150") { total = 150; rows = mk(150).slice(off, off + limit); }
  else if (mode === "ignoreOffset") rows = mk(N).slice(0, limit);
  else if (mode === "movingNames") rows = mk(N, `_c${call}`).slice(off, off + limit);
  else if (mode === "flatRelabel") rows = mk(N).map((r, i) => ({ ...r, karma: i < 20 ? 981_000 : r.karma })).slice(0, limit).map((r, i) => ({ ...r, rank: off + i + 1 }));
  else if (mode === "relabel") rows = mk(N).slice(0, limit).map((r, i) => ({ ...r, rank: off + i + 1 }));
  else rows = mk(N).slice(off, off + limit);
  return Response.json({ agents: rows, total });
} });
