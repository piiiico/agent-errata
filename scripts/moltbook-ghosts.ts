// Classify every Moltbook notification that points at a comment:
//   served     - the comment is in the post's comment tree
//   pending    - verificationStatus != verified: the author never solved the challenge, never published
//   deleted    - isDeleted, or the notification no longer carries the comment
//   below-cap  - verified, not deleted, parent sits at depth >= 4, so the comment is past the depth-5 tree cap
//   unexplained- none of the above: this is the one to report
// Usage: MOLTBOOK_API_KEY=... bun scripts/moltbook-ghosts.ts   (read-only, www.moltbook.com only)
const key = process.env.MOLTBOOK_API_KEY;
if (!key) { console.error("set MOLTBOOK_API_KEY"); process.exit(2); }
const api = async (p: string) => {
  const r = await fetch(`https://www.moltbook.com/api/v1${p}`, { headers: { Authorization: `Bearer ${key}` } });
  if (!r.ok) { console.error(`${r.status} on ${p}`); process.exit(2); }
  return r.json() as any;
};
const notes = (await api("/notifications?limit=50")).notifications ?? [];
const withComment = notes.filter((n: any) => n.relatedCommentId);
if (!withComment.length) { console.error(`0 of ${notes.length} notifications point at a comment; nothing classified`); process.exit(2); }
const trees = new Map<string, Map<string, number>>();
const tree = async (post: string) => {
  if (!trees.has(post)) {
    const m = new Map<string, number>();
    const walk = (cs: any[]) => { for (const c of cs ?? []) { m.set(c.id, c.depth); walk(c.replies); } };
    for (const sort of ["new", "top", "old"]) walk((await api(`/posts/${post}/comments?sort=${sort}&limit=200`)).comments);
    trees.set(post, m);
  }
  return trees.get(post)!;
};
const counts: Record<string, number> = {};
for (const n of withComment) {
  const c = n.comment, t = await tree(n.relatedPostId);
  let cls: string, why = "";
  if (t.has(n.relatedCommentId)) { cls = "served"; why = `depth ${t.get(n.relatedCommentId)}`; }
  else if (!c || c.isDeleted) cls = "deleted";
  else if (c.verificationStatus !== "verified") { cls = "pending"; why = `verificationStatus=${c.verificationStatus}`; }
  else if (c.parentId && (t.get(c.parentId) ?? -1) >= 4) { cls = "below-cap"; why = `parent depth ${t.get(c.parentId)}`; }
  else { cls = "unexplained"; why = c.parentId ? `parent ${t.has(c.parentId) ? "depth " + t.get(c.parentId) : "not in tree either"}` : "top-level"; }
  counts[cls] = (counts[cls] ?? 0) + 1;
  console.log(`${cls.padEnd(11)} ${n.relatedCommentId} ${n.type} ${n.createdAt}${why ? "  (" + why + ")" : ""}`);
}
console.log(`\n${withComment.length} notifications with a comment: ` + Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(" "));
