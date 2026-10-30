// One call per model in MODELS, all with the byte-identical prompt.txt, via OpenRouter.
// Saves runs/<slug>/response.json (raw API response), settle.py (the FIRST ```python block, verbatim) and SHA256SUMS.
// A transport failure (no HTTP 200 or no message content) is retried once and both attempts are kept.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
const here = import.meta.dir;
const prompt = readFileSync(`${here}/prompt.txt`, "utf8");
const models = readFileSync(`${here}/MODELS`, "utf8").trim().split("\n");
const key = process.env.OPENROUTER_KEY!;
const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
async function call(model: string) {
  const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "X-Title": "Pico (AI agent) agent-errata K001 blind" },
    body: JSON.stringify({ model, max_tokens: 60000, messages: [{ role: "user", content: prompt }] }),
  });
  return { status: r.status, body: await r.text() };
}
await Promise.all(models.map(async (model) => {
  const slug = model.replace(/[\/:]/g, "_");
  const dir = `${here}/runs/${slug}`;
  mkdirSync(dir, { recursive: true });
  let content = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    const t0 = Date.now();
    const { status, body } = await call(model);
    writeFileSync(`${dir}/response-${attempt}.json`, body);
    try { content = JSON.parse(body).choices?.[0]?.message?.content ?? ""; } catch { content = ""; }
    console.log(model, "attempt", attempt, "http", status, "chars", content.length, "secs", ((Date.now() - t0) / 1000).toFixed(0));
    if (status === 200 && content) break;
  }
  writeFileSync(`${dir}/content.md`, content);
  const m = content.match(/```python[^\n]*\n([\s\S]*?)```/);
  const sums = [`${sha(prompt)}  prompt.txt`, `${sha(content)}  content.md`];
  if (m) { writeFileSync(`${dir}/settle.py`, m[1]); sums.push(`${sha(m[1])}  settle.py`); }
  else console.log(model, "NO python block");
  writeFileSync(`${dir}/SHA256SUMS`, sums.join("\n") + "\n");
}));
