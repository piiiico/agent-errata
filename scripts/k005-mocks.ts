// Mock leaderboards for K005: enumerate150, ignoreOffset (true ranks), movingNames (ranks right, names churn), relabel (ignores offset, ranks = offset+i), flatRelabel (relabel on a board whose top 20 share one karma), and four honest boards that move at rank 20 with rank 1 still (below)
// Run: bun scripts/k005-mocks.ts, then K005_BASE=http://localhost:8799/<mode> bun scripts/k005-leaderboard-cap.ts. Expected exits: honest 0, enumerate150 1, ignoreOffset 2, movingNames 0, relabel 2, flatRelabel 2, overtake 0, doubleRise 0, riseThenRevertLate 0, riseThenRevert 2.
const N = 100;
let call = 0, lastMode = ""; // call counts per mode, so each run of the check starts at call 1
const mk = (n: number, tag = "") => Array.from({ length: n }, (_, i) => ({ name: `a${i + 1}${tag}`, rank: i + 1, karma: 1_000_000 - i * 1000 }));
Bun.serve({ port: 8799, fetch(req) {
  const u = new URL(req.url); const mode = u.pathname.slice(1);
  const limit = Math.min(Number(u.searchParams.get("limit") ?? 50), mode === "enumerate150" ? 1000 : 100);
  const off = Number(u.searchParams.get("offset") ?? 0); if (mode !== lastMode) { lastMode = mode; call = 0; } call++;
  let rows: any[]; let total = N;
  if (mode === "enumerate150") { total = 150; rows = mk(150).slice(off, off + limit); }
  else if (mode === "ignoreOffset") rows = mk(N).slice(0, limit);
  else if (mode === "movingNames") rows = mk(N, `_c${call}`).slice(off, off + limit);
  else if (mode === "flatRelabel") rows = mk(N).map((r, i) => ({ ...r, karma: i < 20 ? 981_000 : r.karma })).slice(0, limit).map((r, i) => ({ ...r, rank: off + i + 1 }));
  else if (mode === "overtake" || mode === "doubleRise" || mode.startsWith("riseThenRevert")) {
    // Honest offset; the board moves at the rank-20 boundary while rank 1 stays put (swipepredictbot, 10-26 f17e7d37).
    // overtake: from call 3 on, a21 passes a20. doubleRise: from call 3 on, a20 and a21 both pass a19 (monotone).
    // riseThenRevert: as doubleRise for calls 3-5 only (offset=20 is call 5), then both fall back. Exits 2 on an honest
    // route on every version: the one false-error path left, and only when boundary karma falls between two adjacent calls.
    // riseThenRevertLate: falls back after call 8. Exits 2 on 4c4398d (closing read was call 9), 0 since the read moved to call 6.
    const b = mk(N); const moved = call >= 3 && (mode === "riseThenRevert" ? call <= 5 : mode === "riseThenRevertLate" ? call <= 8 : true);
    if (moved && mode === "overtake") b[20].karma = b[19].karma + 500;
    if (moved && mode !== "overtake") { b[19].karma = b[18].karma + 600; b[20].karma = b[18].karma + 500; }
    b.sort((x, y) => y.karma - x.karma).forEach((r, i) => (r.rank = i + 1)); rows = b.slice(off, off + limit);
  }
  else if (mode === "relabel") rows = mk(N).slice(0, limit).map((r, i) => ({ ...r, rank: off + i + 1 }));
  else rows = mk(N).slice(off, off + limit);
  return Response.json({ agents: rows, total });
} });
