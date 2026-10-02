// S003 capture endpoint: logs every request body, returns a canned "NONE" in the dialect asked for.
// Usage: PORT=18100 OUT=/path/dir bun cap.ts
import { mkdirSync, appendFileSync } from "fs";
const PORT = Number(process.env.PORT ?? 18100);
const OUT = process.env.OUT ?? "./cap-default";
mkdirSync(OUT, { recursive: true });
let i = 0;
const sse = (e: string | null, d: any) => (e ? `event: ${e}\n` : "") + `data: ${typeof d === "string" ? d : JSON.stringify(d)}\n\n`;
const TXT = "NONE";
Bun.serve({
  port: PORT, hostname: "127.0.0.1", idleTimeout: 60,
  async fetch(req) {
    const url = new URL(req.url);
    const body = req.method === "GET" ? "" : await req.text();
    const n = i++;
    const p = url.pathname;
    appendFileSync(`${OUT}/index.log`, `${n}\t${req.method}\t${p}${url.search}\t${body.length}\n`);
    if (body) await Bun.write(`${OUT}/req-${String(n).padStart(3, "0")}${p.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 80)}.json`, body);
    let j: any = {}; try { j = JSON.parse(body); } catch {}
    const model = j.model ?? "m";
    // model listings
    if (req.method === "GET" && /models\/?$/.test(p)) {
      if (p.includes("v1beta")) return Response.json({ models: [{ name: "models/gemini-2.5-pro", supportedGenerationMethods: ["generateContent"] }] });
      return Response.json({ object: "list", data: ["gpt-5", "claude-sonnet-4-5", "test-model"].map((id) => ({ id, object: "model", created: 0, owned_by: "x" })) });
    }
    if (p.endsWith("/messages") && req.method === "POST") {
      const msg = { id: "msg_1", type: "message", role: "assistant", model, content: [{ type: "text", text: TXT }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
      if (!j.stream) return Response.json(msg);
      const s = sse("message_start", { type: "message_start", message: { ...msg, content: [], stop_reason: null } }) + sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) + sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: TXT } }) + sse("content_block_stop", { type: "content_block_stop", index: 0 }) + sse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }) + sse("message_stop", { type: "message_stop" });
      return new Response(s, { headers: { "content-type": "text/event-stream" } });
    }
    if (p.endsWith("/chat/completions")) {
      const base = { id: "c1", created: 1, model };
      if (!j.stream) return Response.json({ ...base, object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: TXT }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
      const s = sse(null, { ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] }) + sse(null, { ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: TXT }, finish_reason: null }] }) + sse(null, { ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }) + sse(null, "[DONE]");
      return new Response(s, { headers: { "content-type": "text/event-stream" } });
    }
    if (p.endsWith("/responses")) {
      const item = { id: "msg_1", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: TXT, annotations: [] }] };
      const resp = { id: "resp_1", object: "response", created_at: 1, status: "completed", model, output: [item], usage: { input_tokens: 1, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 2 } };
      if (!j.stream) return Response.json(resp);
      const s = sse("response.created", { type: "response.created", response: { ...resp, status: "in_progress", output: [] } }) + sse("response.output_item.added", { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } }) + sse("response.content_part.added", { type: "response.content_part.added", item_id: "msg_1", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } }) + sse("response.output_text.delta", { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: TXT }) + sse("response.output_text.done", { type: "response.output_text.done", item_id: "msg_1", output_index: 0, content_index: 0, text: TXT }) + sse("response.output_item.done", { type: "response.output_item.done", output_index: 0, item }) + sse("response.completed", { type: "response.completed", response: resp });
      return new Response(s, { headers: { "content-type": "text/event-stream" } });
    }
    if (/:(stream)?[gG]enerateContent/.test(p)) {
      const r = { candidates: [{ content: { role: "model", parts: [{ text: TXT }] }, finishReason: "STOP", index: 0 }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 }, modelVersion: "gemini-2.5-pro" };
      if (p.includes("stream")) return new Response(sse(null, r), { headers: { "content-type": "text/event-stream" } });
      return Response.json(r);
    }
    if (/:countTokens/.test(p)) return Response.json({ totalTokens: 1 });
    return Response.json({});
  },
});
console.log(`cap on ${PORT} -> ${OUT}`);
