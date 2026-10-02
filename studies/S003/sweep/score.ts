// Score a capture dir: which S003C tokens are in the FIRST prompt-bearing request, plus size stats.
// bun score.ts <capdir> [arm-letter]
import { readdirSync, readFileSync } from "fs";
const dir = process.argv[2];
const files = readdirSync(dir).filter((f) => f.startsWith("req-")).sort();
const PROMPT_NEEDLE = "list every token starting with";
const tokRe = /S003C-[A-F]-[A-Z_]+/g;
let first: string | null = null; let firstAny: string | null = null;
const union = new Set<string>();
for (const f of files) {
  const b = readFileSync(`${dir}/${f}`, "utf8");
  for (const t of b.match(tokRe) ?? []) union.add(t);
  if (b.includes(PROMPT_NEEDLE)) {
    let j: any = {}; try { j = JSON.parse(b); } catch {}
    const hasTools = Array.isArray(j.tools) && j.tools.length > 0;
    if (!firstAny) firstAny = f;
    if (!first && hasTools) first = f;
  }
}
if (!first) first = firstAny;
const out: any = { dir, requests: files.length, first };
if (first) {
  const raw = readFileSync(`${dir}/${first}`, "utf8");
  const j = JSON.parse(raw);
  out.bytes = Buffer.byteLength(raw);
  out.tokens_first = [...new Set(raw.match(tokRe) ?? [])].sort();
  let tools = 0;
  if (Array.isArray(j.tools)) tools = j.tools.reduce((n: number, t: any) => n + (t.functionDeclarations ? t.functionDeclarations.length : 1), 0);
  out.tools = tools;
  const txt = (x: any): string => (typeof x === "string" ? x : Array.isArray(x) ? x.map(txt).join("") : x && typeof x === "object" ? txt(x.text ?? x.content ?? x.parts ?? "") : "");
  let sys = "";
  if (j.system) sys += txt(j.system);
  if (j.instructions) sys += txt(j.instructions);
  if (j.systemInstruction) sys += txt(j.systemInstruction);
  if (j.request?.systemInstruction) sys += txt(j.request.systemInstruction);
  for (const m of j.messages ?? j.input ?? []) if (m && (m.role === "system" || m.role === "developer")) sys += txt(m.content);
  out.system_chars = sys.length;
  out.model = j.model ?? null;
}
out.tokens_any_request = [...union].sort();
console.log(JSON.stringify(out));
