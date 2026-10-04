// Rebuild the Harness Watch blocks from runs/*.json + state.json:
//   docs/S003/index.html, docs/S004/index.html  (stamp under the H1 + Changelog section before the footer)
//   studies/S003/watch/CHANGELOG.md
// Run alone: bun render.ts
import { readFileSync, readdirSync, writeFileSync, existsSync } from "fs";
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
    .sort((a, b) => (b.date + b.file).localeCompare(a.date + a.file));
}

function line(r: any, html: boolean) {
  const from = r.previous_version && r.previous_version !== r.version ? `${r.previous_version} → ${r.version}` : `${r.version}${r.forced ? " (forced re-run, same version)" : ""}`;
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
  const md = `# Harness Watch changelog

Re-measured on every release of the 10 harnesses in [S003](../../S003.md) and [S004](../../S004.md). Newest first. Daily run logs: ${WORKFLOW}

${rs.length ? rs.map((r) => line(r, false)).join("\n") : "No re-measure yet."}
`;
  writeFileSync(`${W}/CHANGELOG.md`, md);
  console.log(`rendered ${rs.length} changelog rows`);
}

if (import.meta.main) render();
