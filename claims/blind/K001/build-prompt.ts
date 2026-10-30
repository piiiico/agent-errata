// Assembles the pinned prompt. Usage: bun build-prompt.ts <settle-core-v0 dir at horizon-shield@67430d93> > prompt.txt
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
const d = process.argv[2];
const here = import.meta.dir;
const spec = readFileSync(join(d, "SETTLE_CORE_v0.md"), "utf8");
const v = join(d, "vectors", "real_p31_baseline");
const view = JSON.parse(readFileSync(join(v, "view.json"), "utf8"));
const n = view.headers.length;
const viewExcerpt = JSON.stringify({ ...view, headers: view.headers.slice(0, 2) }, null, 1);
const ev = readdirSync(join(v, "events")).sort();
let out = readFileSync(join(here, "INSTRUCTIONS.md"), "utf8");
out += "\n\n===== SETTLE_CORE_v0.md =====\n\n" + spec;
out += "\n\n===== Example vector inputs: real_p31_baseline (expected output not included) =====\n";
out += "\n--- contract.json ---\n" + readFileSync(join(v, "contract.json"), "utf8");
for (const f of ev) out += `\n--- events/${f} ---\n` + readFileSync(join(v, "events", f), "utf8");
out += `\n--- view.json (excerpt: the first 2 of its ${n} headers; the real file holds all ${n}) ---\n` + viewExcerpt + "\n";
process.stdout.write(out);
