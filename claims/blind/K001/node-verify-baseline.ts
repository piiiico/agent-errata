import { readFileSync } from "node:fs";
import { createHash, createPublicKey, verify } from "node:crypto";
const c = JSON.parse(readFileSync(process.argv[2], "utf8"));
const canon = (v: any): string => Array.isArray(v) ? "[" + v.map(canon).join(",") + "]" : v && typeof v === "object" ? "{" + Object.keys(v).sort().map(k => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}" : JSON.stringify(v);
const { signatures, ...body } = c;
const bytes = Buffer.from("a2a-contract-v0\n" + canon(body), "utf8");
console.log("sha", createHash("sha256").update(bytes).digest("hex"));
console.log(JSON.stringify(signatures).slice(0, 300));
for (const s of signatures) {
  const party = c.parties.find((p: any) => p.domain === s.domain);
  const key = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(party.public_key_ed25519_b64, "base64")]), format: "der", type: "spki" });
  console.log(s.domain, verify(null, bytes, key, Buffer.from(s.signature, "base64")));
}
