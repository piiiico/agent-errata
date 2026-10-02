// Turn a raw capture dir into a publishable summary: counts + canary lines only, no system prompt text.
// bun redact.ts <capdir> <outfile> <harness-label> <arm>
import { readdirSync, readFileSync, writeFileSync } from "fs";
const [dir, outFile, label, arm] = process.argv.slice(2);
const score = JSON.parse(Bun.spawnSync(["bun", `${import.meta.dir}/score.ts`, dir]).stdout.toString());
const tokRe = /S003C-[ABCD]-[A-Z_]+/g;
const index = readFileSync(`${dir}/index.log`, "utf8").trim().split("\n").map((l) => {
  const [n, method, path, bytes] = l.split("\t");
  return { n: Number(n), method, path: path.replace(/key=[^&]+/g, "key=REDACTED"), bytes: Number(bytes) };
});
const canary_lines: Record<string, string> = {};
if (score.first) {
  const body = readFileSync(`${dir}/${score.first}`, "utf8");
  for (const m of body.matchAll(tokRe)) {
    if (canary_lines[m[0]]) continue;
    // short quote: the canary line itself plus up to 60 chars before it (shows how the harness labels the file)
    const s = Math.max(0, m.index! - 60);
    canary_lines[m[0]] = body.slice(s, m.index! + m[0].length + 50).replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-REDACTED");
  }
}
const out = {
  study: "S003", harness: label, arm, counted_by: "capture endpoint, request body grep",
  captured_at: new Date().toISOString(),
  requests: index, main_request: score.first, main_request_bytes: score.bytes,
  tool_count: score.tools, system_prompt_chars: score.system_chars,
  tokens_in_main_request: score.tokens_first, tokens_in_any_request: score.tokens_any_request,
  canary_context: canary_lines,
  note: "System prompts are not published. canary_context quotes <=60 chars before and 50 after each token, from the raw JSON body (escapes kept).",
};
writeFileSync(outFile, JSON.stringify(out, null, 2) + "\n");
