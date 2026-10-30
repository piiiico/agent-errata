// External witness for beacon commits (swipepredictbot, 10-29). Someone with write access could rewrite main and replace a beacon
// commit with one naming a drand round that was already public; the Actions run validate.ts reads can be deleted by the owner too.
// So right after table.yml pushes a beacon commit it signs the commit's sha with keyless cosign: Fulcio issues a short-lived cert
// naming this repo, table.yml, the push trigger and the commit the run was for, and Rekor (a public append-only log nobody here can
// edit) records it with the time it was logged. A beacon commit counts only if Rekor holds such an entry for its exact sha, logged
// within WINDOW seconds after the drand round the commit carries. A rewritten commit has a new sha and no entry, or one logged
// too late for its round.
// Usage: bun scripts/witness.ts <commit-sha> <round-unix-time> <parent-sha> [identity] — prints ok or the reasons, exits 1 on fail.
import { X509Certificate, createHash, createPublicKey, verify } from "node:crypto";
import { DRAND, assignSerials, parseBeacons, type Beacon } from "./draw.ts";

export const WINDOW = 900;
export const IDENTITY = "https://github.com/piiiico/agent-errata/.github/workflows/table.yml@refs/heads/main";
const REKOR = "https://rekor.sigstore.dev";
// rekor.sigstore.dev's log key (GET /api/v1/log/publicKey, 2026-10-29), pinned so a swapped key fails instead of vouching for itself.
const REKOR_KEY = createPublicKey("-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE2G2Y+2tabdTV5BcGiBIx0a9fAFwr\nkBbmLSGtks4L3qX6yYY0zufBnhC8Ur/iy55GhWP/9A/bY2LhC30M9+RYtw==\n-----END PUBLIC KEY-----\n");
const UA = { "user-agent": "agent-errata-ci (AI operator pico_amdal)", "content-type": "application/json" };

// The blob table.yml signs: the commit sha and a newline (`git rev-parse HEAD > blob`).
export const blobOf = (sha: string) => Buffer.from(`${sha}\n`);

// Fulcio's GitHub extensions, OID 1.3.6.1.4.1.57264.1.<n>: 1 issuer, 2 trigger, 3 commit sha the workflow ran at.
const ext = (der: Buffer, n: number) => {
  const oid = Buffer.from([0x06, 0x0a, 0x2b, 0x06, 0x01, 0x04, 0x01, 0x83, 0xbf, 0x30, 0x01, n]);
  let i = der.indexOf(oid);
  if (i < 0) return undefined;
  i += oid.length;
  if (der[i] === 0x01) i += 3; // critical flag
  if (der[i] !== 0x04) return undefined;
  const len = der[i + 1];
  if (len & 0x80) return undefined;
  let v = der.subarray(i + 2, i + 2 + len);
  if (v[0] === 0x0c && v[1] === v.length - 2) v = v.subarray(2); // DER UTF8String in newer Fulcio extensions
  return v.toString("utf8");
};

let fulcio: X509Certificate[] | undefined;
const fulcioCerts = async () => {
  if (fulcio) return fulcio;
  const r = await fetch("https://fulcio.sigstore.dev/api/v2/trustBundle", { headers: UA, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`Fulcio trust bundle ${r.status}`);
  const j: any = await r.json();
  fulcio = j.chains.flatMap((c: any) => c.certificates).map((p: string) => new X509Certificate(p));
  if (!fulcio!.length) throw new Error("Fulcio trust bundle is empty");
  return fulcio!;
};

export type Entry = { integratedTime: number; logIndex: number; uuid: string; at?: string };
export type Witness = { ok: boolean; reasons: string[]; integratedTime?: number; logIndex?: number; uuid?: string };

// Every Rekor entry for this exact blob that verifies (log signature, hashedrekord, signature, Fulcio cert naming `identity`, push
// trigger), earliest integratedTime first; `at` is the commit the signing run was at. Entries that fail are listed in `reasons`.
export async function entries(blob: Buffer, identity = IDENTITY): Promise<{ ok: Entry[]; reasons: string[] }> {
  const digest = createHash("sha256").update(blob).digest("hex");
  const r = await fetch(`${REKOR}/api/v1/index/retrieve`, { method: "POST", headers: UA, body: JSON.stringify({ hash: `sha256:${digest}` }), signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`Rekor search ${r.status}`);
  const uuids: string[] = (await r.json()) ?? [];
  const ok: Entry[] = [], reasons: string[] = [];
  for (const uuid of uuids) {
    const e = await fetch(`${REKOR}/api/v1/log/entries/${uuid}`, { headers: UA, signal: AbortSignal.timeout(15000) });
    if (!e.ok) throw new Error(`Rekor entry ${uuid} ${e.status}`);
    const [entry]: any[] = Object.values(await e.json());
    const bad = (why: string) => reasons.push(`entry ${entry.logIndex}: ${why}`);
    // Rekor v1 only. A v2 log has no integratedTime; its time would come from an RFC 3161 timestamp with a pinned TSA cert (not built).
    if (typeof entry.integratedTime !== "number") { bad("no Rekor v1 integratedTime"); continue; }
    // The log's own signature over the entry and its time, so the time is Rekor's, not the API response's.
    const set = JSON.stringify({ body: entry.body, integratedTime: entry.integratedTime, logID: entry.logID, logIndex: entry.logIndex });
    if (!verify("sha256", Buffer.from(set), REKOR_KEY, Buffer.from(entry.verification?.signedEntryTimestamp ?? "", "base64"))) { bad("Rekor's signed entry timestamp does not verify"); continue; }
    const body = JSON.parse(Buffer.from(entry.body, "base64").toString());
    if (body.kind !== "hashedrekord" || body.spec?.data?.hash?.value !== digest) { bad(`not a hashedrekord of ${digest.slice(0, 12)}`); continue; }
    const cert = new X509Certificate(Buffer.from(body.spec.signature.publicKey.content, "base64"));
    if (!verify("sha256", blob, cert.publicKey, Buffer.from(body.spec.signature.content, "base64"))) { bad("signature does not verify against its cert"); continue; }
    const t = entry.integratedTime;
    if (!(Date.parse(cert.validFrom) / 1000 <= t && t <= Date.parse(cert.validTo) / 1000)) { bad("logged outside its cert's lifetime"); continue; }
    const ca = (await fulcioCerts()).find((c) => cert.checkIssued(c) && cert.verify(c.publicKey));
    if (!ca) { bad("cert not issued by Fulcio"); continue; }
    const der = Buffer.from(cert.raw);
    const san = cert.subjectAltName ?? "";
    if (san !== `URI:${identity}`) { bad(`cert names ${san}, not ${identity}`); continue; }
    if (ext(der, 1) !== "https://token.actions.githubusercontent.com") { bad(`OIDC issuer ${ext(der, 1)}`); continue; }
    if (ext(der, 2) !== "push") { bad(`trigger ${ext(der, 2)}, not push`); continue; }
    ok.push({ integratedTime: t, logIndex: entry.logIndex, uuid, at: ext(der, 3) });
  }
  ok.sort((a, b) => a.integratedTime - b.integratedTime || a.logIndex - b.logIndex);
  return { ok, reasons };
}

// The beacon commit itself: an entry for its sha, signed by a run at its parent. window: seconds after the round it must be logged in
// (legacy beacons); beacons bound by an intent entry pass Infinity, since their round was fixed before it was published.
export async function witness(sha: string, roundTime: number, parent: string, identity = IDENTITY, window = WINDOW): Promise<Witness> {
  const { ok, reasons } = await entries(blobOf(sha), identity);
  if (!ok.length && !reasons.length) return { ok: false, reasons: [`no Rekor entry for sha256(${sha.slice(0, 7)}\\n)`] };
  for (const e of ok) {
    if (e.at !== parent) { reasons.push(`entry ${e.logIndex}: run was at ${String(e.at).slice(0, 7)}, the commit's parent is ${parent.slice(0, 7)}`); continue; }
    const d = e.integratedTime - roundTime;
    if (!(0 <= d && d <= window)) { reasons.push(`entry ${e.logIndex}: logged ${d} s after its drand round, window is 0..${window}`); continue; }
    return { ok: true, reasons: [], integratedTime: e.integratedTime, logIndex: e.logIndex, uuid: e.uuid };
  }
  return { ok: false, reasons };
}

// Sign before reveal (swipepredictbot, 10-29/30). Before any round is fetched, table.yml signs one intent blob per new serial and per new
// pool name. The blob holds nothing a verifier cannot recompute (no round, no parent), so validate.ts finds EVERY entry for it, including
// those of runs that were cancelled. The earliest entry binds: the draw's round is the first one published at least MARGIN s after
// Rekor logged it, so nobody, owner included, knows the randomness when the round is fixed. Re-running or cancelling cannot move it, and
// signing again changes nothing (no veto). A run that dies after signing leaves the round bound; the next run uses the same round.
export const MARGIN = 90;
export const intentBlob = (b: { serial?: string; name?: string }) => Buffer.from(b.serial ? `agent-errata serial ${b.serial}\n` : `agent-errata name ${b.name}\n`);
export const boundRound = (integratedTime: number) => Math.ceil((integratedTime + MARGIN - DRAND.genesis) / DRAND.period) + 1;
// Why a beacon fails its intent check, or "" if its round and entry are the ones its earliest verified entry binds.
export const bindFail = (b: { round: number; witness?: number }, ok: Entry[]) =>
  !ok.length ? "no Rekor intent entry signed before its round"
  : b.round !== boundRound(ok[0].integratedTime) || b.witness !== ok[0].logIndex ? `round ${b.round} (entry ${b.witness}) is not the one its earliest intent entry ${ok[0].logIndex} binds: ${boundRound(ok[0].integratedTime)}`
  : "";
// Runner bound at signing (swipepredictbot, 10-30). The intent blob names only the serial, and a cancelled run commits no beacon, so the
// owner could sign K001-13 with runner A's row, wait for the bound round, then refile the row as runner B and get K001-13 again with
// a different draw. So the earliest entry's cert also counts: Fulcio ext 3 is the commit the signing run was at, and beacon.ts replayed
// there (claims/*.jsonl and beacons.jsonl as of that commit) must give this serial to this claim and runner. Only the earliest entry is
// replayed; a failing one is red, never skipped for a later one. tree(at): the claim files' texts in file order and beacons.jsonl, or
// undefined if the commit is not in the clone.
// signed: the serials signed-no-beacon at that commit as of the entry's time (signedSerials below), so a later signature cannot change
// what the old commit should have assigned.
export type Tree = (at: string) => { claims: string[]; beacons: string } | undefined;
export const rowFail = (b: { serial?: string; claim?: string; runner?: string }, at: string | undefined, tree: Tree, signed: Beacon[] = []) => {
  if (!b.serial) return "";
  if (!at || !/^[0-9a-f]{40}$/.test(at)) return `earliest intent entry names no commit (${at})`;
  const t = tree(at);
  if (!t) return `earliest intent entry was signed at ${at.slice(0, 7)}, which is not in this repository`;
  const rows = t.claims.flatMap((s) => s.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l)));
  const r = assignSerials(rows, [...parseBeacons(t.beacons), ...signed]).find((x) => x.fresh && x.serial === b.serial)?.r;
  if (!r) return `at ${at.slice(0, 7)}, where its earliest intent entry was signed, no row gets serial ${b.serial}`;
  if (r.claim !== b.claim || String(r.runner) !== b.runner) return `serial ${b.serial} was signed at ${at.slice(0, 7)} for ${r.runner} on ${r.claim}, but the beacon names ${b.runner} on ${b.claim}`;
  return "";
};
// Signed, no beacon (swipepredictbot, 10-30). Counting committed beacons let a signed serial be handed out twice: sign K001-13 for A,
// delete A's row, and B's next row derived K001-13 again, red forever at the replay. Deleting after seeing the bound round and never
// refiling left no trace at all. So a serial counts once its intent entry is in Rekor: beacon.ts assigns past the highest SIGNED serial
// of the claim, and each signed serial with no beacon stands in assignSerials as a pseudo-beacon of the row it was signed for (claim and
// runner from the replay at its earliest entry's commit), so that runner's refile gets it back and anyone else gets the next number.
// pending(beacons, claims, before): those pseudo-beacons beyond the committed ones, counting only entries logged before `before`.
export const signedSerials = (lookup: (serial: string) => Promise<Entry[]>, tree: Tree) => {
  const got = new Map<string, Promise<Entry[]>>(), owners = new Map<string, Promise<string | undefined>>();
  const ok = (s: string) => got.get(s) ?? (got.set(s, lookup(s)), got.get(s)!);
  const owner = (serial: string, claim: string, e: Entry) => owners.get(serial) ?? (owners.set(serial, (async () => {
    const t = e.at && /^[0-9a-f]{40}$/.test(e.at) ? tree(e.at) : undefined;
    if (!t) return undefined;
    const rows = t.claims.flatMap((s) => s.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l)));
    const bs = parseBeacons(t.beacons);
    const x = assignSerials(rows, [...bs, ...(await pending(bs, [claim], e.integratedTime))]).find((x) => x.fresh && x.serial === serial);
    return x && x.r.claim === claim ? String(x.r.runner) : undefined;
  })()), owners.get(serial)!);
  const pending = async (beacons: Beacon[], claims: string[], before = Infinity) => {
    const out: (Beacon & { entry: number })[] = [];
    for (const claim of claims) for (let n = beacons.filter((b) => b.claim === claim).length + 1; ; n++) {
      const serial = `${claim}-${String(n).padStart(2, "0")}`, [e] = await ok(serial);
      if (!e || e.integratedTime >= before) break;
      out.push({ serial, claim, runner: await owner(serial, claim, e), round: 0, randomness: "", run: "", entry: e.logIndex });
    }
    return out;
  };
  return { pending, entries: ok };
};
// tree for rowFail from a git clone at root.
export const treeAt = (root: string): Tree => (at: string) => {
  const git = (...a: string[]) => { const p = Bun.spawnSync(["git", "-C", root, ...a], { stdout: "pipe", stderr: "pipe" }); return { ok: p.exitCode === 0, out: p.stdout.toString() }; };
  const ls = git("ls-tree", "--name-only", at, "claims/");
  if (!ls.ok) return undefined;
  const bj = git("show", `${at}:claims/beacons.jsonl`);
  return { claims: ls.out.split("\n").filter((f) => /^claims\/K\d{3}\.jsonl$/.test(f)).sort().map((f) => git("show", `${at}:${f}`).out), beacons: bj.ok ? bj.out : "" };
};

if (import.meta.main) {
  const [sha, rt, parent, identity] = process.argv.slice(2);
  if (!sha || !rt || !parent) { console.error("usage: bun scripts/witness.ts <commit-sha> <round-unix-time> <parent-sha> [identity]"); process.exit(2); }
  const w = await witness(sha, Number(rt), parent, identity);
  console.log(w.ok ? `ok: ${sha.slice(0, 7)} witnessed in Rekor entry ${w.logIndex} at ${new Date(w.integratedTime! * 1000).toISOString()}, ${w.integratedTime! - Number(rt)} s after its drand round` : `FAIL ${sha.slice(0, 7)}: ${w.reasons.join("; ")}`);
  process.exit(w.ok ? 0 : 1);
}
