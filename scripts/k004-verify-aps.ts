// K004: an APS permit and an APS denial verify from the committed files alone.
// Pico's verifier, written from the vectors and the construction stated in the header
// comment of aeoess's independent-verify.mjs. Own RFC 8785 serializer (below), Ed25519 via
// node:crypto as Bun provides it. Usage: bun scripts/k004-verify-aps.ts <path-to>/interop/oauth-liu-composition/vectors
// Prints one line per check and exits 0 only if every check passes.
import { createHash, createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// --chain-as-object: digest the chain as JCS({delegation_chain: [...]}), the construction in the body of
// independent-verify.mjs (lines 82-83). Without it, the chain is digested as the bare array, as the header
// ("sha256(JCS(input artifact))") and MAPPING-TABLE.md ("delegation_chain (whole array)") state it.
const chainAsObject = process.argv.includes("--chain-as-object");
const dir = process.argv.slice(2).find((a) => !a.startsWith("--"));
if (!dir) { console.error("usage: bun scripts/k004-verify-aps.ts [--chain-as-object] <vectors dir>"); process.exit(2); }
const read = (...p: string[]) => JSON.parse(readFileSync(join(dir, ...p), "utf8"));

// RFC 8785 section 3.2.2.2: strings escape only ", \, and U+0000..U+001F (short forms for \b \t \n \f \r, else \u00xx lowercase).
function str(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x22) out += '\\"';
    else if (c === 0x5c) out += "\\\\";
    else if (c === 0x08) out += "\\b";
    else if (c === 0x09) out += "\\t";
    else if (c === 0x0a) out += "\\n";
    else if (c === 0x0c) out += "\\f";
    else if (c === 0x0d) out += "\\r";
    else if (c < 0x20) out += "\\u" + c.toString(16).padStart(4, "0");
    else if (c >= 0xd800 && c <= 0xdfff) {
      const next = s.charCodeAt(i + 1);
      if (c <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) { out += s[i] + s[i + 1]; i++; }
      else throw new Error("lone surrogate: not valid I-JSON");
    } else out += s[i];
  }
  return out + '"';
}
// RFC 8785 section 3.2.2.3: numbers as ECMAScript Number.prototype.toString; -0 serializes as 0.
function num(n: number): string {
  if (!Number.isFinite(n)) throw new Error("non-finite number");
  return Object.is(n, -0) ? "0" : String(n);
}
// RFC 8785 section 3.2.3: object members sorted by the UTF-16 code units of their names.
function cmpUtf16(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { const d = a.charCodeAt(i) - b.charCodeAt(i); if (d) return d; }
  return a.length - b.length;
}
function jcs(v: unknown): string {
  if (v === null) return "null";
  if (v === true) return "true";
  if (v === false) return "false";
  if (typeof v === "number") return num(v);
  if (typeof v === "string") return str(v);
  if (Array.isArray(v)) return "[" + v.map(jcs).join(",") + "]";
  if (typeof v === "object") return "{" + Object.keys(v as object).sort(cmpUtf16).map((k) => str(k) + ":" + jcs((v as any)[k])).join(",") + "}";
  throw new Error(`cannot canonicalize ${typeof v}`);
}

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const tagged = (tag: string, body: string) => Buffer.concat([Buffer.from(tag, "ascii"), Buffer.from([0]), Buffer.from(body, "utf8")]);
const without = (o: any, ...keys: string[]) => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));
function edVerify(msg: Buffer, sigHex: string, pubHex: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(pubHex) || !/^[0-9a-f]{128}$/.test(sigHex)) return false;
  const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(pubHex, "hex").toString("base64url") }, format: "jwk" });
  return verify(null, msg, key, Buffer.from(sigHex, "hex"));
}

let pass = 0, fail = 0;
const check = (name: string, ok: boolean) => { console.log(`${ok ? "PASS" : "FAIL"} ${name}`); ok ? pass++ : fail++; };

for (const v of ["v1-permit", "v2-denial"]) {
  const rec = read(v, "record.json"), keys = read(v, "keys.json"), input = read(v, "input.json");
  check(`${v}: receipt_id = sha256(APS-RECEIPT-ID-V1 \\0 JCS(record minus receipt_id, signatures))`,
    sha256(tagged("APS-RECEIPT-ID-V1", jcs(without(rec, "receipt_id", "signatures")))) === rec.receipt_id);
  check(`${v}: issuer is the key holder in keys.json`, rec.issuer === keys.signer);
  check(`${v}: exactly one signature`, Array.isArray(rec.signatures) && rec.signatures.length === 1);
  for (const s of rec.signatures ?? []) {
    const msg = tagged("APS-RECEIPT-SIG-V1", jcs({ receipt: without(rec, "signatures"), signer: without(s, "value") }));
    check(`${v}: Ed25519 signature by ${s.key_id} (${s.alg})`,
      s.alg === "Ed25519" && s.signer === keys.signer && s.key_id === keys.key_id && edVerify(msg, s.value, keys.public_key_hex));
  }
  for (const e of rec.evidence_refs ?? []) {
    const field = String(e.artifact_type).split("/").pop()!;
    const art = chainAsObject && field === "delegation_chain" ? { delegation_chain: input[field] } : input[field];
    check(`${v}: evidence ${field} = sha256(JCS(${art === input[field] ? `input.${field}` : `{${field}}`}))`, field in input && sha256(Buffer.from(jcs(art), "utf8")) === e.sha256);
  }
  check(`${v}: evidence_refs cover authorization_details and delegation_chain`,
    ["authorization_details", "delegation_chain"].every((f) => (rec.evidence_refs ?? []).some((e: any) => String(e.artifact_type).endsWith("/" + f))));
  check(`${v}: delegation_ref names the delegation_chain digest`,
    rec.delegation_ref === "liu-chain:sha256:" + sha256(Buffer.from(jcs(chainAsObject ? { delegation_chain: input.delegation_chain } : input.delegation_chain), "utf8")));
  check(`${v}: subject_agent is the last delegatee`, rec.subject_agent === input.delegation_chain.at(-1).delegatee_id);

  // action_ref and decision_ref, written from the README text of agent-passport-system#245 (head 324a7e7),
  // "Construction of action_ref and decision_ref", without reading that PR's verifier diff.
  const td = (tag: string, val: unknown) => sha256(tagged(tag, jcs(val)));
  const plain = (val: unknown) => sha256(Buffer.from(jcs(val), "utf8"));
  const C = input.delegation_chain, F = C.at(-1), X = input.rego_decision_context, E = X.evaluated_input;
  const actionRef = td("APS-ACTION-REF-V2", {
    profile: "aps-action-ref-v2", agent_id: F.delegatee_id, action_type: E.action, target: "item:" + E.item_id,
    payload_ref: plain(E), scope_required: [E.action], issued_at: rec.issued_at,
    nonce: sha256(Buffer.from("liu-composition-" + v, "utf8")).slice(0, 32),
  });
  check(`${v}: action_ref = APS-ACTION-REF-V2 digest of the eight-member action input`, actionRef === rec.action_ref);
  const authority = td("APS-DECISION-AUTHORITY-V1", { delegation_chain: C });
  const filledPolicy = { ...X.policy_ref, hash: "sha256-" + createHash("sha256").update(F.delegated_policy.content, "utf8").digest("base64") };
  const narrowed = [...new Set([...String(F.delegated_policy.content).matchAll(/input\.action == "([^"]*)"/g)].map((m) => m[1]))]
    .sort((a, b) => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8")));
  const output = X.result === "allow"
    ? { profile: "aps-core-decision-output-v1", verdict: "permit", effective_authority_ref: authority, constraints: narrowed }
    : { profile: "aps-core-decision-output-v1", verdict: "deny", effective_authority_ref: null, constraints: ["requested_action_outside_narrowed_subset:" + E.action] };
  const decisionRef = td("APS-DECISION-REF-V1", {
    profile: "aps-decision-ref-v1", action_ref: actionRef, authority_state_ref: authority,
    policy_ref: td("APS-DECISION-POLICY-V1", filledPolicy),
    context_ref: td("APS-DECISION-CONTEXT-V1", { policy_ref: filledPolicy, input_hash: "sha256:" + plain(E), result: X.result, evaluation_timestamp: X.evaluation_timestamp }),
    decision_output_ref: td("APS-DECISION-OUTPUT-V1", output),
  });
  check(`${v}: decision_ref = APS-DECISION-REF-V1 digest of the six-member decision object`, decisionRef === rec.decision_ref);
  check(`${v}: narrowed subset in the receipt result matches the final hop's policy`,
    X.result !== "allow" || jcs(rec.result?.narrowed_subset) === jcs(narrowed));
}

const obs = read("v3-observation", "record.json"), oin = read("v3-observation", "input.json");
check("v3-observation: Ed25519 signature by observer_key over JCS(record minus signature)",
  edVerify(Buffer.from(jcs(without(obs, "signature")), "utf8"), obs.signature, obs.observer_key));
const hop = oin.revocation_signal.revoked_hop;
check("v3-observation: authority_ref names the revoked hop, and the hop is in the chain",
  obs.authority_ref === `liu-chain-hop:${hop.delegator_id}->${hop.delegatee_id}` &&
  oin.delegation_chain.some((h: any) => h.delegator_id === hop.delegator_id && h.delegatee_id === hop.delegatee_id));
check("v3-observation: status_source jti and revoked_at match the revocation signal",
  obs.status_source.jti === oin.revocation_signal.set_jti && obs.revoked_at === oin.revocation_signal.revoked_at);

console.log(`${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
