// S005 loop endpoint, four dialects (Anthropic messages, OpenAI chat completions, OpenAI responses, Gemini).
// Every request that offers tools gets ONE harmless tool call back (glob / list / `echo <n>`), with arguments that
// change on every call so loop detectors see no repeat, and a usage block of IN_TOK input + OUT_TOK output tokens.
// Requests without tools (titles, routing, summaries) get a short text answer. No model is involved.
// Usage: PORT=18200 OUT=dir IN_TOK=20000 OUT_TOK=500 CWD=/abs/repo [SAME=1] [MARK=text] bun loop.ts
// SAME=1: identical arguments on every call (a stuck model). MARK: log whether each request body contains this text.
// TOOL=<name> CMD=<shell>: always call that tool with that command (e.g. TOOL=Bash CMD="seq 1 150000" for a large pending tool result); bytes= logs request size.
import { mkdirSync, appendFileSync } from "fs";
const PORT = Number(process.env.PORT ?? 18200), OUT = process.env.OUT ?? "./loop-out";
const IN_TOK = Number(process.env.IN_TOK ?? 20000), OUT_TOK = Number(process.env.OUT_TOK ?? 500);
const CWD = process.env.CWD ?? process.cwd();
mkdirSync(OUT, { recursive: true });
let i = 0, toolTurns = 0;
const sse = (e: string | null, d: any) => (e ? `event: ${e}\n` : "") + `data: ${typeof d === "string" ? d : JSON.stringify(d)}\n\n`;
const PREF = ["glob", "Glob", "list_directory", "ls", "LS", "list", "bash", "Bash", "shell", "shell_command", "exec_command", "developer__shell", "run_shell_command"];

type T = { name: string; schema: any };
function toolsOf(j: any): T[] {
  const out: T[] = [];
  for (const t of j.tools ?? []) {
    if (t.functionDeclarations) for (const f of t.functionDeclarations) out.push({ name: f.name, schema: f.parameters ?? f.parametersJsonSchema ?? {} });
    else if (t.function) out.push({ name: t.function.name, schema: t.function.parameters ?? {} });
    else if (t.name) out.push({ name: t.name, schema: t.input_schema ?? t.parameters ?? {} });
  }
  return out;
}
function argsFor(t: T, n: number): Record<string, any> {
  const props = t.schema?.properties ?? {}, req: string[] = t.schema?.required ?? [];
  const a: Record<string, any> = {};
  for (const k of new Set([...req, ...Object.keys(props).filter((k) => /pattern|command|cmd/i.test(k))])) {
    const p = props[k] ?? {}, ty = Array.isArray(p.type) ? p.type[0] : p.type;
    let v: any;
    if (/pattern/i.test(k)) v = `*s005-${n}*`;
    else if (/command|cmd/i.test(k)) v = process.env.CMD ?? `echo s005-${n}`;
    else if (/path|dir|file/i.test(k)) v = CWD;
    else if (ty === "number" || ty === "integer") v = 1;
    else if (ty === "boolean") v = false;
    else v = `s005-${n}`;
    if (ty === "array") v = /command|cmd/i.test(k) ? ["bash", "-lc", `echo s005-${n}`] : [v];
    a[k] = v;
  }
  return a;
}

Bun.serve({ port: PORT, hostname: "127.0.0.1", idleTimeout: 120, async fetch(req) {
  const url = new URL(req.url), p = url.pathname;
  const body = req.method === "GET" ? "" : await req.text(); const n = i++;
  let j: any = {}; try { j = JSON.parse(body); } catch {}
  const model = j.model ?? "m";
  if (req.method === "GET" && /models\/?$/.test(p)) {
    if (p.includes("v1beta")) return Response.json({ models: [{ name: "models/gemini-2.5-pro", supportedGenerationMethods: ["generateContent"] }] });
    return Response.json({ object: "list", data: ["gpt-5", "gpt-4o", "claude-sonnet-4-5", "test-model"].map((id) => ({ id, object: "model", created: 0, owned_by: "x" })) });
  }
  const tools = toolsOf(j);
  const pick = process.env.TOOL ? tools.find((t) => t.name.toLowerCase() === process.env.TOOL!.toLowerCase()) : PREF.map((nm) => tools.find((t) => t.name === nm)).find(Boolean);
  const call = pick ? (toolTurns++, { name: pick.name, args: argsFor(pick, process.env.SAME ? 1 : toolTurns), id: `call_s005_${n}` }) : null;
  const inTok = call ? IN_TOK : 10, outTok = call ? OUT_TOK : 5;
  if (n < 2 && tools.length) appendFileSync(`${OUT}/tools.txt`, `${p}\t${tools.map((t) => t.name).join(",")}\n`);
  appendFileSync(`${OUT}/index.log`, `${n}\t${new Date().toISOString()}\t${req.method}\t${p}\ttools=${tools.length}\tbytes=${body.length}\tmark=${process.env.MARK && body.includes(process.env.MARK) ? 1 : 0}\tcall=${call ? call.name + JSON.stringify(call.args) : "-"}\n`);

  if (p.endsWith("/messages") && req.method === "POST") {
    const content: any[] = call ? [{ type: "tool_use", id: call.id, name: call.name, input: call.args }] : [{ type: "text", text: "OK" }];
    const stop = call ? "tool_use" : "end_turn", usage = { input_tokens: inTok, output_tokens: outTok };
    const msg = { id: `msg_${n}`, type: "message", role: "assistant", model, content, stop_reason: stop, stop_sequence: null, usage };
    if (!j.stream) return Response.json(msg);
    let s = sse("message_start", { type: "message_start", message: { ...msg, content: [], stop_reason: null, usage: { input_tokens: inTok, output_tokens: 1 } } });
    content.forEach((c, k) => {
      if (c.type === "tool_use") s += sse("content_block_start", { type: "content_block_start", index: k, content_block: { type: "tool_use", id: c.id, name: c.name, input: {} } }) + sse("content_block_delta", { type: "content_block_delta", index: k, delta: { type: "input_json_delta", partial_json: JSON.stringify(c.input) } });
      else s += sse("content_block_start", { type: "content_block_start", index: k, content_block: { type: "text", text: "" } }) + sse("content_block_delta", { type: "content_block_delta", index: k, delta: { type: "text_delta", text: c.text } });
      s += sse("content_block_stop", { type: "content_block_stop", index: k });
    });
    s += sse("message_delta", { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: outTok } }) + sse("message_stop", { type: "message_stop" });
    return new Response(s, { headers: { "content-type": "text/event-stream" } });
  }
  if (p.endsWith("/chat/completions")) {
    const base = { id: `c${n}`, created: 1, model }, usage = { prompt_tokens: inTok, completion_tokens: outTok, total_tokens: inTok + outTok };
    const tc = call ? [{ index: 0, id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } }] : undefined;
    const fin = call ? "tool_calls" : "stop";
    if (!j.stream) return Response.json({ ...base, object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: call ? null : "OK", ...(tc ? { tool_calls: tc.map(({ index, ...r }) => r) } : {}) }, finish_reason: fin }], usage });
    const s = sse(null, { ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta: call ? { role: "assistant", content: null, tool_calls: tc } : { role: "assistant", content: "OK" }, finish_reason: null }] })
      + sse(null, { ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: fin }] })
      + sse(null, { ...base, object: "chat.completion.chunk", choices: [], usage }) + sse(null, "[DONE]");
    return new Response(s, { headers: { "content-type": "text/event-stream" } });
  }
  if (p.endsWith("/responses")) {
    const item: any = call ? { id: `fc_${n}`, type: "function_call", status: "completed", call_id: call.id, name: call.name, arguments: JSON.stringify(call.args) }
      : { id: `msg_${n}`, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "OK", annotations: [] }] };
    const resp = { id: `resp_${n}`, object: "response", created_at: 1, status: "completed", model, output: [item], usage: { input_tokens: inTok, input_tokens_details: { cached_tokens: 0 }, output_tokens: outTok, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: inTok + outTok } };
    if (!j.stream) return Response.json(resp);
    let s = sse("response.created", { type: "response.created", response: { ...resp, status: "in_progress", output: [] } }) + sse("response.output_item.added", { type: "response.output_item.added", output_index: 0, item: call ? { ...item, status: "in_progress", arguments: "" } : { ...item, status: "in_progress", content: [] } });
    if (call) s += sse("response.function_call_arguments.delta", { type: "response.function_call_arguments.delta", item_id: item.id, output_index: 0, delta: item.arguments }) + sse("response.function_call_arguments.done", { type: "response.function_call_arguments.done", item_id: item.id, output_index: 0, arguments: item.arguments });
    else s += sse("response.output_text.delta", { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: "OK" });
    s += sse("response.output_item.done", { type: "response.output_item.done", output_index: 0, item }) + sse("response.completed", { type: "response.completed", response: resp });
    return new Response(s, { headers: { "content-type": "text/event-stream" } });
  }
  if (/:(stream)?[gG]enerateContent/.test(p)) {
    // Gemini CLI's loop detector asks a side model "is this unproductive?"; the stand-in answers like a model that thinks it is making progress.
    const txt = body.includes("unproductive_state_confidence") ? JSON.stringify({ unproductive_state_analysis: "Listing files, making progress.", unproductive_state_confidence: 0 }) : "OK";
    const parts = call ? [{ functionCall: { name: call.name, args: call.args } }] : [{ text: txt }];
    const r = { candidates: [{ content: { role: "model", parts }, finishReason: "STOP", index: 0 }], usageMetadata: { promptTokenCount: inTok, candidatesTokenCount: outTok, totalTokenCount: inTok + outTok }, modelVersion: "gemini-2.5-pro" };
    if (p.includes("stream")) return new Response(sse(null, r), { headers: { "content-type": "text/event-stream" } });
    return Response.json(r);
  }
  if (/:countTokens/.test(p)) return Response.json({ totalTokens: 10 });
  return Response.json({});
}});
console.log(`loop2 on ${PORT} -> ${OUT}`);
