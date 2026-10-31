// Bypass check (clawdsmith, 10-30). The main ruleset (26185150, created 2026-10-30T04:33:32Z) requires the PR checks, but it lets a
// deploy key push straight to main, and until 2026-10-31 it let repository admins do the same. This lists every push to main since the
// ruleset and says which went through a merged PR and which did not, from sources anyone can read without a login: GitHub's public
// activity log for the repo (who moved main, from which commit to which, and whether it was a PR merge) and Rekor.
// Usage, from a full clone (git clone https://github.com/piiiico/agent-errata): bun scripts/bypass-check.ts
// Prints one line per commit: PR (a PR merge; GET /commits/<sha>/pulls must agree), WITNESSED (pushed directly, but Rekor holds an entry
// for its sha signed by table.yml's push run at its parent, see scripts/witness.ts) or DIRECT (pushed directly, nothing outside GitHub
// vouches for it). Exits 1 if any commit is DIRECT. Deploy-key pushes from table.yml and harness-watch.yml that add no beacon are DIRECT:
// they bypass the checks too, and their author name is whatever the workflow set. The activity log attributes deploy-key pushes to the
// repo owner, so it cannot tell them from an admin push; after ADMIN_BYPASS_REMOVED only the deploy key can push past the ruleset.
// Rebase merges are switched off (allow_rebase_merge=false), so every PR lands as one merge or squash commit, the `after` of a pr_merge.
import { join } from "node:path";
import { entries, blobOf } from "./witness.ts";

export const RULESET = 26185150;
export const SINCE = "2026-10-30T04:33:32Z";
export const ADMIN_BYPASS_REMOVED = "2026-10-31T04:18:57Z"; // ruleset updated_at when the admin bypass was removed
const REPO = "piiiico/agent-errata";
const UA = { "user-agent": "agent-errata bypass-check (AI operator pico_amdal)", accept: "application/vnd.github+json" };
const root = process.env.VALIDATE_ROOT || join(import.meta.dir, "..");

const git = (...a: string[]) => { const p = Bun.spawnSync(["git", "-C", root, ...a], { stdout: "pipe", stderr: "pipe" }); return { ok: p.exitCode === 0, out: p.stdout.toString().trim() }; };
const gh = async (path: string) => {
  const r = await fetch(`https://api.github.com/${path}`, { headers: process.env.GITHUB_TOKEN ? { ...UA, authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : UA, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`GET ${path}: ${r.status} ${(await r.text()).slice(0, 200)}`);
  return { body: await r.json(), next: r.headers.get("link")?.match(/<([^>]+)>; rel="next"/)?.[1] };
};

export type Event = { activity_type: string; ref: string; before: string; after: string; timestamp: string; actor?: { login: string } };
export type Row = { sha: string; kind: "PR" | "WITNESSED" | "DIRECT"; why: string; event: Event };

export async function activity(): Promise<Event[]> {
  const out: Event[] = [];
  let path: string | undefined = `repos/${REPO}/activity?ref=refs/heads/main&per_page=100`;
  while (path) {
    const { body, next } = await gh(path);
    if (!Array.isArray(body)) throw new Error("activity log is not a list");
    out.push(...body);
    if (body.some((e: Event) => e.timestamp < SINCE)) break;
    path = next?.replace("https://api.github.com/", "");
  }
  return out.filter((e) => e.ref === "refs/heads/main" && e.timestamp >= SINCE).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

// PR arm: the merged PR whose merge commit is this sha (squash and merge commits both map; checked on oven-sh/bun 9fe1cd6 -> 47382).
export async function prOf(sha: string): Promise<number | undefined> {
  const { body } = await gh(`repos/${REPO}/commits/${sha}/pulls`);
  return (body as any[]).find((p) => p.merged_at && p.merge_commit_sha === sha && p.base?.ref === "main")?.number;
}

export async function classify(events: Event[], prLookup = prOf, rekor = entries): Promise<Row[]> {
  const rows: Row[] = [];
  for (const e of events) {
    const range = /^0+$/.test(e.before) ? [e.after] : git("rev-list", "--reverse", `${e.before}..${e.after}`);
    const shas = Array.isArray(range) ? range : range.ok ? range.out.split("\n").filter(Boolean) : undefined;
    if (!shas) { rows.push({ sha: e.after, kind: "DIRECT", why: `${e.before.slice(0, 7)}..${e.after.slice(0, 7)} is not in this clone (fetch, or it was force-pushed away)`, event: e }); continue; }
    if (e.activity_type === "pr_merge") {
      const n = await prLookup(e.after);
      for (const s of shas) rows.push(n !== undefined
        ? { sha: s, kind: "PR", why: s === e.after ? `merge of #${n}` : `in #${n}`, event: e }
        : { sha: s, kind: "DIRECT", why: `activity log says pr_merge, but /commits/${e.after.slice(0, 7)}/pulls names no merged PR with that merge commit`, event: e });
      continue;
    }
    for (const s of shas) {
      const parent = git("rev-parse", `${s}^`).out;
      const w = (await rekor(blobOf(s))).ok.find((x) => x.at === parent);
      rows.push(w
        ? { sha: s, kind: "WITNESSED", why: `Rekor entry ${w.logIndex}, signed by table.yml at its parent`, event: e }
        : { sha: s, kind: "DIRECT", why: `${e.activity_type} by ${e.actor?.login ?? "?"}${e.timestamp >= ADMIN_BYPASS_REMOVED ? " (deploy key: admins can no longer bypass)" : ""}`, event: e });
    }
  }
  return rows;
}

if (import.meta.main) {
  if (git("rev-parse", "--is-shallow-repository").out !== "false") { console.error("needs a full clone (git fetch --unshallow)"); process.exit(2); }
  const events = await activity();
  // Floor: the ruleset's own creation was followed by pushes; an empty log means the fetch read nothing, not that main is clean.
  if (!events.length) { console.error(`activity log returned no main events since ${SINCE}; refusing to report clean`); process.exit(2); }
  const rows = await classify(events);
  for (const r of rows) {
    const subj = git("log", "-1", "--format=%an | %s", r.sha).out.slice(0, 90);
    console.log(`${r.kind.padEnd(9)} ${r.sha.slice(0, 7)} ${r.event.timestamp} ${r.why} | ${subj}`);
  }
  // Reconciliation: every first-parent commit of main since the ruleset must sit in some event's range.
  const seen = new Set(rows.map((r) => r.sha));
  const fp = git("rev-list", "--first-parent", `--since=${SINCE}`, "origin/main").out.split("\n").filter(Boolean);
  const missing = fp.filter((s) => !seen.has(s));
  for (const s of missing) console.log(`DIRECT    ${s.slice(0, 7)} on main but in no activity event since ${SINCE}`);
  const direct = rows.filter((r) => r.kind === "DIRECT").length + missing.length;
  console.log(`\n${events.length} pushes to main since ruleset ${RULESET} (${SINCE}): ${rows.filter((r) => r.kind === "PR").length} commits via PR, ${rows.filter((r) => r.kind === "WITNESSED").length} witnessed, ${direct} direct`);
  process.exit(direct ? 1 : 0);
}
