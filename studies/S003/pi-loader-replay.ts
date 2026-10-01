// S003, pi arm: rebuild what pi's resource loader puts in front of the model, without
// starting a model, and report which planted canary tokens it contains.
//
//   PI=/path/to/node_modules/@earendil-works/pi-coding-agent \
//   bun pi-loader-replay.ts <cwd> <agentDir> <map.tsv> [skillDir...]
//
// Mirrors the options a pi embedding passes (noSkills + additionalSkillPaths, context files on).
// It reads the same files pi reads; it does NOT see text the embedding adds itself
// (e.g. a systemPromptOverride built from another file). Check those separately.
const [cwd, agentDir, mapPath, ...skillDirs] = process.argv.slice(2);
if (!cwd || !agentDir || !mapPath) {
  console.error("usage: bun pi-loader-replay.ts <cwd> <agentDir> <map.tsv> [skillDir...]");
  process.exit(2);
}
const PI = process.env.PI ?? "/app/node_modules/@earendil-works/pi-coding-agent";
const pi = await import(`${PI}/dist/index.js`);
const version = (await Bun.file(`${PI}/package.json`).json()).version;

const loader = new pi.DefaultResourceLoader({
  cwd, agentDir,
  settingsManager: pi.SettingsManager.inMemory(),
  noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
  noContextFiles: false,
  additionalSkillPaths: skillDirs,
});
await loader.reload();

const ctx = loader.getAgentsFiles().agentsFiles as { path: string; content: string }[];
const skills = loader.getSkills().skills as any[];
const skillBlock = pi.formatSkillsForPrompt(skills);
const append = (loader.getAppendSystemPrompt?.() ?? []).join("\n");

const rows = (await Bun.file(mapPath).text()).trim().split("\n").map((l) => l.split("\t"));
if (rows.length === 0 || !rows[0][0]?.startsWith("S003C-")) {
  console.error("no tokens in map");
  process.exit(3);
}
console.log(`pi ${version} | cwd ${cwd} | context files: ${ctx.map((c) => c.path).join(", ") || "none"} | skills in prompt: ${skills.length}`);
let seen = 0;
for (const [tok, file] of rows) {
  const where: string[] = [];
  for (const c of ctx) if (c.content.includes(tok)) where.push(`context:${c.path}`);
  if (skillBlock.includes(tok)) where.push("skill-list");
  if (append.includes(tok)) where.push("APPEND_SYSTEM");
  if (where.length) seen++;
  console.log(`${tok}\t${where.length ? where.join(",") : "not-loaded"}\t${file}`);
}
console.log(`planted=${rows.length} in_loader_output=${seen}`);
