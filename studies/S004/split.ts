// split.ts <capdir>...  For each capture dir: find the main request (largest POST body that has a tool list or system),
// print total body bytes and the share in tools, system/instructions, and messages. Bytes are JSON.stringify of each part.
import { readdirSync, readFileSync, statSync } from "fs";
const PROMPT = "Without using any tools, list every token starting with S003C-";
let parsed = 0;
for (const dir of process.argv.slice(2)) {
  const files = readdirSync(dir).filter(f => f.startsWith("req-") && f.endsWith(".json"));
  let best: any = null;
  for (const f of files) {
    const raw = readFileSync(`${dir}/${f}`, "utf8");
    let j: any; try { j = JSON.parse(raw); } catch { continue; }
    const body = j.body ?? j;
    const b = typeof body === "string" ? (() => { try { return JSON.parse(body) } catch { return null } })() : body;
    if (!b || !JSON.stringify(b).includes(PROMPT)) continue;
    const size = Buffer.byteLength(JSON.stringify(b));
    if (!best || size > best.size) best = { f, b, size };
  }
  if (!best) { console.log(`${dir}\tNO_MAIN_REQUEST`); continue; }
  parsed++;
  const b = best.b, L = (x: any) => x == null ? 0 : Buffer.byteLength(JSON.stringify(x));
  // tools: anthropic/openai .tools; gemini .tools (functionDeclarations)
  const tools = L(b.tools);
  const ntools = Array.isArray(b.tools) ? b.tools.reduce((n: number, t: any) => n + (t.functionDeclarations?.length ?? 1), 0) : 0;
  // system: anthropic .system, responses .instructions, gemini .systemInstruction, openai chat = role:system/developer msgs
  let sys = L(b.system) + L(b.instructions) + L(b.systemInstruction);
  const msgs = b.messages ?? b.input ?? b.contents ?? [];
  let msgSys = 0;
  if (Array.isArray(msgs)) for (const m of msgs) if (m.role === "system" || m.role === "developer") msgSys += L(m);
  sys += msgSys;
  const msgBytes = L(msgs) - msgSys;
  console.log([dir, best.f, best.size, ntools, tools, sys, msgBytes, best.size - tools - sys - msgBytes].join("\t"));
}
if (parsed === 0) { console.error("FLOOR: 0 captures parsed"); process.exit(3); }
