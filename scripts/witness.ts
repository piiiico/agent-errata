// External witness for beacon commits (swipepredictbot, 10-29). Someone with write access could rewrite main and replace a beacon
// commit with one naming a drand round that was already public; the Actions run validate.ts reads can be deleted by the owner too.
// So right after table.yml pushes a beacon commit it signs the commit's sha with keyless cosign: Fulcio issues a short-lived cert
// naming this repo, table.yml, the push trigger and the commit the run was for, and Rekor (a public append-only log nobody here can
// edit) records it with the time it was logged. A beacon commit counts only if Rekor holds such an entry for its exact sha, logged
// within WINDOW seconds after the drand round the commit carries. A rewritten commit has a new sha and no entry, or one logged
// too late for its round.
// Usage: bun scripts/witness.ts <commit-sha> <round-unix-time> <parent-sha> [identity] — prints ok or the reasons, exits 1 on fail.
import { X509Certificate, createHash, createPublicKey, verify } from "node:crypto";

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

export type Witness = { ok: boolean; reasons: string[]; integratedTime?: number; logIndex?: number; uuid?: string };

export async function witness(sha: string, roundTime: number, parent: string, identity = IDENTITY): Promise<Witness> {
  const blob = blobOf(sha), digest = createHash("sha256").update(blob).digest("hex");
  const r = await fetch(`${REKOR}/api/v1/index/retrieve`, { method: "POST", headers: UA, body: JSON.stringify({ hash: `sha256:${digest}` }), signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`Rekor search ${r.status}`);
  const uuids: string[] = (await r.json()) ?? [];
  if (!uuids.length) return { ok: false, reasons: [`no Rekor entry for sha256(${sha.slice(0, 7)}\\n) = ${digest.slice(0, 12)}`] };
  const reasons: string[] = [];
  for (const uuid of uuids) {
    const e = await fetch(`${REKOR}/api/v1/log/entries/${uuid}`, { headers: UA, signal: AbortSignal.timeout(15000) });
    if (!e.ok) throw new Error(`Rekor entry ${uuid} ${e.status}`);
    const [entry]: any[] = Object.values(await e.json());
    const bad = (why: string) => reasons.push(`entry ${entry.logIndex}: ${why}`);
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
    if (ext(der, 3) !== parent) { bad(`run was at ${String(ext(der, 3)).slice(0, 7)}, the commit's parent is ${parent.slice(0, 7)}`); continue; }
    if (!(roundTime <= t && t <= roundTime + WINDOW)) { bad(`logged ${t - roundTime} s after its drand round, window is 0..${WINDOW}`); continue; }
    return { ok: true, reasons: [], integratedTime: t, logIndex: entry.logIndex, uuid };
  }
  return { ok: false, reasons };
}

if (import.meta.main) {
  const [sha, rt, parent, identity] = process.argv.slice(2);
  if (!sha || !rt || !parent) { console.error("usage: bun scripts/witness.ts <commit-sha> <round-unix-time> <parent-sha> [identity]"); process.exit(2); }
  const w = await witness(sha, Number(rt), parent, identity);
  console.log(w.ok ? `ok: ${sha.slice(0, 7)} witnessed in Rekor entry ${w.logIndex} at ${new Date(w.integratedTime! * 1000).toISOString()}, ${w.integratedTime! - Number(rt)} s after its drand round` : `FAIL ${sha.slice(0, 7)}: ${w.reasons.join("; ")}`);
  process.exit(w.ok ? 0 : 1);
}
