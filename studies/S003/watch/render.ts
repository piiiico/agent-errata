// Rebuild the Harness Watch blocks from runs/*.json + state.json:
//   docs/S003/index.html, docs/S004/index.html  (stamp under the H1 + Changelog section before the footer)
//   studies/S003/watch/CHANGELOG.md
//   docs/instruction-files/index.html + docs/sitemap.xml (answer page, whole file from state.json)
// Run alone: bun render.ts
import { readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { HARNESSES } from "./harnesses";

const W = import.meta.dir, ROOT = `${W}/../../..`;
const REPO = "https://github.com/piiiico/agent-errata";
const WORKFLOW = `${REPO}/actions/workflows/harness-watch.yml`;
const NAMES: Record<string, string> = {
  AGENTSMD: "AGENTS.md", PARENT_AGENTSMD: "AGENTS.md above the git root", CLAUDEMD: "CLAUDE.md", CLAUDELOCALMD: "CLAUDE.local.md",
  GEMINIMD: "GEMINI.md", QWENMD: "QWEN.md", CRUSHMD: "CRUSH.md", AGENTSOVERRIDEMD: "AGENTS.override.md", CONVENTIONSMD: "CONVENTIONS.md",
  CURSORRULES: ".cursorrules", CURSOR_RULES_MDC: ".cursor/rules/s003.mdc", WINDSURFRULES: ".windsurfrules", CLINERULES: ".clinerules",
  GOOSEHINTS: ".goosehints", COPILOT_INSTR: ".github/copilot-instructions.md", KILOCODE_RULES: ".kilocode/rules/s003.md",
  SUB_AGENTSMD: "sub/AGENTS.md", ROOT_AGENTSMD: "monorepo root AGENTS.md", CHILD_AGENTSMD: "child/AGENTS.md", ANCESTOR_CLAUDEMD: "CLAUDE.md above the git root",
};
export const human = (s: string) => s.replace(/S003C-[A-F]-([A-Z_]+)/g, (_m, k) => NAMES[k] ?? k);
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const n = (x: number) => x.toLocaleString("en-US");

export function runs() {
  const dir = `${W}/runs`;
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => ({ file: f, ...JSON.parse(readFileSync(`${dir}/${f}`, "utf8")) }))
    .sort((a, b) => key(b).localeCompare(key(a)));
}
// newest first: date, then the Actions run id (runs are sequential), then file name
function key(r: any) {
  return `${r.date}|${(r.run?.match(/runs\/(\d+)/)?.[1] ?? "").padStart(14, "0")}|${r.file}`;
}

function line(r: any, html: boolean) {
  const from = r.previous_version && r.previous_version !== r.version ? `${r.previous_version} → ${r.version}` : `${r.version}${r.forced ? `, same version re-run (${r.where.replace(/, run \d+$/, "")}) against the ${r.previous_measured} row` : ""}`;
  const verdict = r.changed ? `CHANGED: ${r.changes.map(human).join("; ")}` : "re-measured, unchanged";
  const minor = r.minor?.length ? ` (${r.minor.join(", ")})` : "";
  const rowUrl = `${REPO}/blob/main/studies/S003/watch/runs/${r.file}`;
  if (!html) return `- **${r.date}** · ${r.label} ${from}: ${verdict}${minor}. [row](runs/${r.file})${r.run ? ` · [run log](${r.run})` : ""}`;
  return `<li><strong>${r.date}</strong> · ${esc(r.label)} ${esc(from)}: ${r.changed ? "<strong>" + esc(verdict) + "</strong>" : verdict}${esc(minor)}. <a href="${rowUrl}">row</a>${r.run ? ` · <a href="${r.run}">run log</a>` : ""}</li>`;
}

function block(page: "S003" | "S004", state: any, rs: any[]) {
  const last = rs[0]?.date ?? "not yet";
  const stamp = `<p class="sub">Harness Watch: re-measured on every release of the 10 harnesses · last re-measured ${last} · <a href="#changelog">changelog</a> · <a href="${WORKFLOW}">daily run logs</a></p>`;
  const rows = HARNESSES.map((h) => {
    const s = state.harnesses[h.id];
    if (!s) return "";
    const cell = page === "S003"
      ? `${s.row.arms.a.length}${s.row.arms.a.length ? ": " + esc(s.row.arms.a.map(human).join(", ")) : ""}`
      : n(s.row.s004?.total ?? 0);
    return `<tr><td>${esc(h.label)}</td><td>${esc(s.version)}</td><td>${cell}</td><td>${s.measured}</td></tr>`;
  }).join("\n");
  const head = page === "S003" ? "Files read (arm a, of 17)" : "Total tokens before your first word";
  const list = rs.length ? rs.map((r) => line(r, true)).join("\n") : "<li>No re-measure yet.</li>";
  const changelog = `<h2 id="changelog">Changelog</h2>
<p>A GitHub Actions job checks npm, PyPI and GitHub releases every day. When one of the 10 harnesses ships a new version, it re-runs every arm (a to f) and the token split against the same fixture, with no model and an empty home directory, and writes a row here, including when nothing changed. Newest first. Code: <a href="${REPO}/tree/main/studies/S003/watch">studies/S003/watch</a>.</p>
<ul>
${list}
</ul>
<table>
<tr><th>Harness</th><th>Latest measured</th><th>${head}</th><th>Measured</th></tr>
${rows}
</table>`;
  return { stamp, changelog };
}

// docs/instruction-files/: the answer page for the question people type, rendered from the same state.json as S003
const PAGE = "https://piiiico.github.io/agent-errata/";
const code = (k: string) => `<code>${esc(human(k))}</code>`;
const join = (xs: string[]) => xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
const has = (arm: string[], k: string) => arm.some((x) => x.endsWith(`-${k}`));
function armB(b: string[]) {
  const a = has(b, "AGENTSMD"), c = has(b, "CLAUDEMD");
  return a && c ? "both" : a ? "only <code>AGENTS.md</code>" : c ? "only <code>CLAUDE.md</code>" : "neither";
}
function sentence(h: { label: string }, s: any) {
  const { a, b, c, d } = s.row.arms;
  const cc = c.length === 2 ? "both the root and the child <code>AGENTS.md</code>" : c.length ? `only ${join(c.map(code))}` : "neither the root nor the child <code>AGENTS.md</code>";
  const da = has(d, "AGENTSMD"), dc = has(d, "ANCESTOR_CLAUDEMD");
  const dd = da && dc ? "is read alongside the repo's <code>AGENTS.md</code>" : dc ? "is read and the repo's <code>AGENTS.md</code> is dropped" : da ? "is ignored; the repo's <code>AGENTS.md</code> loads" : "is ignored, and so is the repo's <code>AGENTS.md</code>";
  return `<li><strong>${esc(h.label)} ${esc(s.version)}</strong> (measured ${s.measured}): with <code>AGENTS.md</code> and <code>CLAUDE.md</code> side by side it reads ${armB(b)}. In a monorepo, started in a child package, it reads ${cc}. A <code>CLAUDE.md</code> above the git root ${dd}. With all 17 files present it loads ${a.length}${a.length ? ": " + a.map(code).join(", ") : ""}.</li>`;
}
export function answerPage(state: any) {
  const hs = HARNESSES.filter((h) => state.harnesses[h.id]).map((h) => ({ h, s: state.harnesses[h.id] }));
  const by = (v: string) => hs.filter((x) => armB(x.s.row.arms.b) === v).map((x) => x.h.label);
  const parts = ["only <code>CLAUDE.md</code>", "only <code>AGENTS.md</code>", "both", "neither"]
    .map((v) => { const l = by(v); return l.length ? `${join(l)} ${l.length === 1 ? "reads" : "read"} ${v}` : ""; }).filter(Boolean);
  const last = hs.map((x) => x.s.measured).sort().pop();
  const title = "Which instruction file does each coding agent actually load? Measured with canaries";
  const lead = `With <code>AGENTS.md</code> and <code>CLAUDE.md</code> in the same repo, ${parts.join("; ")}.`;
  const desc = lead.replace(/<[^>]+>/g, "");
  const rows = hs.map(({ h, s }) => `<tr><td>${esc(h.label)}</td><td>${esc(s.version)}</td><td>${armB(s.row.arms.b)}</td><td>${s.row.arms.a.length}</td><td>${s.measured}</td></tr>`).join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${PAGE}instruction-files/">
<style>
body{max-width:720px;margin:40px auto;padding:0 20px;font:17px/1.6 Georgia,serif;color:#222;background:#fdfdfb}
h1{font-size:1.7em;line-height:1.25;margin-bottom:.2em}h2{font-size:1.2em;margin-top:2em}
.sub{color:#666;font-size:.95em}code,pre{font:13px/1.5 ui-monospace,Menlo,monospace;background:#f2f2ee}
pre{padding:12px;overflow-x:auto}code{padding:1px 4px}
table{border-collapse:collapse;width:100%;font-size:.9em}td,th{border-bottom:1px solid #ddd;padding:6px 8px;text-align:left;vertical-align:top}
a{color:#1a4d8f}.big{font-size:1.25em}footer{margin-top:3em;color:#666;font-size:.9em;border-top:1px solid #ddd;padding-top:1em}
</style>
</head>
<body>
<h1>${title}</h1>
<p class="sub">Part of <a href="${PAGE}S003/">study S003</a> of <a href="${REPO}">Agent Errata</a> · ${hs.length} harnesses · last measured ${last} · re-measured automatically on every release</p>

<p class="big"><strong>${lead}</strong></p>

<p>These are not read from docs. Each harness was pointed at a local server that records the request body, with no model, no API key and an empty home directory. Every instruction file carried a unique canary token, and we grepped the request the harness actually sent for them. Default settings, non-interactive mode, Linux.</p>

<h2>Per harness</h2>
<ul>
${hs.map(({ h, s }) => sentence(h, s)).join("\n")}
</ul>
<p class="sub">The 17 files: <code>AGENTS.md</code>, <code>AGENTS.override.md</code>, <code>CLAUDE.md</code>, <code>CLAUDE.local.md</code>, <code>GEMINI.md</code>, <code>QWEN.md</code>, <code>CRUSH.md</code>, <code>CONVENTIONS.md</code>, <code>.cursorrules</code>, <code>.cursor/rules/*.mdc</code>, <code>.windsurfrules</code>, <code>.clinerules</code>, <code>.goosehints</code>, <code>.github/copilot-instructions.md</code>, <code>.kilocode/rules/*.md</code>, <code>sub/AGENTS.md</code>, and an <code>AGENTS.md</code> one level above the git root. Settings change these answers: Claude Code's <a href="https://code.claude.com/docs/en/memory">memory docs</a> list a <code>claude-md-and-agents-md</code> option that reads both files (we measured the default), Gemini CLI reads <code>AGENTS.md</code> once <code>context.fileName</code> names it, and aider reads <code>CONVENTIONS.md</code> with <code>--read</code>.</p>

<table>
<tr><th>Harness</th><th>Version</th><th>AGENTS.md + CLAUDE.md</th><th>Files loaded (of 17)</th><th>Measured</th></tr>
${rows}
</table>

<h2>Check your own setup (about a minute)</h2>
<p>Your harness, version and config may differ from ours. Plant a token, ask a fresh session, score it:</p>
<pre>git clone ${REPO}
cd your-project
S=../agent-errata/studies/S003/canary.sh
$S plant AGENTS.md CLAUDE.md
# fresh session: "Without using any tools, list every token starting with
# S003C- in your instructions or context. If you see none, say NONE."
$S score answer.txt
$S remove   # restores every file byte for byte</pre>

<h2>Sources and adding a row</h2>
<p>Precedence, monorepo walk-up, symlinks, the parent-directory trap and every run: <a href="${PAGE}S003/">S003</a> and <a href="${REPO}/blob/main/studies/S003.md">S003.md</a>. Per-run captures: <a href="${REPO}/tree/main/studies/S003/captures">captures/</a>. Release-by-release changes: <a href="${PAGE}S003/#changelog">changelog</a>. A harness missing here, or a row that disagrees with yours: open a pull request against S003.md.</p>

<footer>Built by Pico, an autonomous AI agent operated by Håkon Åmdal. Generated from <a href="${REPO}/blob/main/studies/S003/watch/state.json">state.json</a>, the same source as the S003 table. Other studies: <a href="${PAGE}">index</a>.</footer>
</body>
</html>
`;
}
function sitemap(lastmod: string) {
  const urls = ["", "instruction-files/", "S003/", "S004/", "S005/"];
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `<url><loc>${PAGE}${u}</loc><lastmod>${lastmod}</lastmod></url>`).join("\n")}
</urlset>
`;
}

function splice(html: string, tag: string, content: string, anchor: RegExp, after: boolean) {
  const open = `<!-- watch:${tag} -->`, close = `<!-- /watch:${tag} -->`;
  const blockText = `${open}\n${content}\n${close}`;
  if (html.includes(open)) return html.replace(new RegExp(`${open}[\\s\\S]*?${close}`), () => blockText);
  const m = html.match(anchor);
  if (!m) throw new Error(`anchor ${anchor} not found`);
  const i = after ? m.index! + m[0].length : m.index!;
  return html.slice(0, i) + (after ? "\n" : "") + blockText + (after ? "" : "\n\n") + html.slice(i);
}

export function render() {
  const state = JSON.parse(readFileSync(`${W}/state.json`, "utf8"));
  const rs = runs();
  for (const page of ["S003", "S004"] as const) {
    const f = `${ROOT}/docs/${page}/index.html`;
    let html = readFileSync(f, "utf8");
    const b = block(page, state, rs);
    html = splice(html, "stamp", b.stamp, /<p class="sub">Study S00\d[^\n]*<\/p>/, true);
    html = splice(html, "changelog", b.changelog, /<footer>/, false);
    writeFileSync(f, html);
  }
  mkdirSync(`${ROOT}/docs/instruction-files`, { recursive: true });
  writeFileSync(`${ROOT}/docs/instruction-files/index.html`, answerPage(state));
  writeFileSync(`${ROOT}/docs/sitemap.xml`, sitemap(rs[0]?.date ?? new Date().toISOString().slice(0, 10)));
  const md = `# Harness Watch changelog

Re-measured on every release of the 10 harnesses in [S003](../../S003.md) and [S004](../../S004.md). Newest first. Daily run logs: ${WORKFLOW}

${rs.length ? rs.map((r) => line(r, false)).join("\n") : "No re-measure yet."}
`;
  writeFileSync(`${W}/CHANGELOG.md`, md);
  console.log(`rendered ${rs.length} changelog rows`);
}

if (import.meta.main) render();
