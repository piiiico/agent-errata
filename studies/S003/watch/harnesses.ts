// Harness Watch registry: where each harness's version comes from, how to install it, how to point it at cap.ts.
// Commands are the ones in ../sweep/README.md. No model key: every key below is a dummy, every base URL is the local capture port.
import { mkdirSync, writeFileSync } from "fs";

export type Source = { npm: string } | { pypi: string } | { github: string };
export type Harness = {
  id: string; label: string; source: Source;
  bin: string;                                   // executable name inside the install dir's bin path
  setup?: (home: string, port: number) => void;  // config files under the scratch HOME
  env?: (port: number) => Record<string, string>;
  args: (port: number, prompt: string) => string[];
};

const put = (path: string, data: unknown) => {
  mkdirSync(path.replace(/\/[^/]+$/, ""), { recursive: true });
  writeFileSync(path, typeof data === "string" ? data : JSON.stringify(data));
};
const openaiCompat = (port: number) => ({
  $schema: "https://opencode.ai/config.json",
  provider: { cap: { npm: "@ai-sdk/openai-compatible", name: "cap", options: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: "x" }, models: { "test-model": { name: "test-model" } } } },
});

export const HARNESSES: Harness[] = [
  {
    id: "claude", label: "Claude Code", source: { npm: "@anthropic-ai/claude-code" }, bin: "claude",
    env: (p) => ({ ANTHROPIC_BASE_URL: `http://127.0.0.1:${p}`, ANTHROPIC_API_KEY: "sk-ant-fake" }),
    args: (_p, q) => ["-p", q],
  },
  {
    id: "codex", label: "Codex CLI", source: { npm: "@openai/codex" }, bin: "codex",
    env: () => ({ CAPKEY: "x" }),
    args: (p, q) => ["exec", "--skip-git-repo-check", "-c", "model_provider=cap", "-c",
      `model_providers.cap={name="cap",base_url="http://127.0.0.1:${p}/v1",env_key="CAPKEY",wire_api="responses"}`, "-m", "gpt-5", q],
  },
  {
    id: "gemini", label: "Gemini CLI", source: { npm: "@google/gemini-cli" }, bin: "gemini",
    setup: (h) => put(`${h}/.gemini/settings.json`, { security: { auth: { selectedType: "gemini-api-key" } } }),
    env: (p) => ({ GEMINI_CLI_TRUST_WORKSPACE: "true", GEMINI_API_KEY: "x", GOOGLE_GEMINI_BASE_URL: `http://127.0.0.1:${p}` }),
    args: (_p, q) => ["-p", q],
  },
  {
    id: "qwen", label: "Qwen Code", source: { npm: "@qwen-code/qwen-code" }, bin: "qwen",
    setup: (h) => put(`${h}/.qwen/settings.json`, { security: { auth: { selectedType: "openai" } } }),
    env: (p) => ({ OPENAI_API_KEY: "x", OPENAI_BASE_URL: `http://127.0.0.1:${p}/v1`, OPENAI_MODEL: "qwen3-coder-plus" }),
    args: (_p, q) => ["-p", q],
  },
  {
    id: "opencode", label: "opencode", source: { npm: "opencode-ai" }, bin: "opencode",
    setup: (h, p) => put(`${h}/.config/opencode/opencode.json`, openaiCompat(p)),
    args: (_p, q) => ["run", "-m", "cap/test-model", q],
  },
  {
    id: "kilo", label: "Kilo CLI", source: { npm: "@kilocode/cli" }, bin: "kilo",
    setup: (h, p) => { put(`${h}/.config/kilo/opencode.json`, openaiCompat(p)); put(`${h}/.config/kilo/kilo.json`, openaiCompat(p)); },
    args: (_p, q) => ["run", "-m", "cap/test-model", q],
  },
  {
    id: "crush", label: "Crush", source: { npm: "@charmland/crush" }, bin: "crush",
    setup: (h, p) => put(`${h}/.config/crush/crush.json`, {
      providers: { cap: { type: "openai-compat", base_url: `http://127.0.0.1:${p}/v1`, api_key: "x", models: [{ id: "test-model", name: "test-model", context_window: 128000, default_max_tokens: 4096 }] } },
      models: { large: { model: "test-model", provider: "cap" }, small: { model: "test-model", provider: "cap" } },
    }),
    args: (_p, q) => ["run", q],
  },
  {
    id: "goose", label: "goose", source: { github: "block/goose" }, bin: "goose",
    env: (p) => ({ GOOSE_DISABLE_KEYRING: "1", GOOSE_PROVIDER: "openai", GOOSE_MODEL: "gpt-4o", OPENAI_HOST: `http://127.0.0.1:${p}`, OPENAI_API_KEY: "x" }),
    args: (_p, q) => ["run", "--no-session", "-t", q],
  },
  {
    id: "aider", label: "aider", source: { pypi: "aider-chat" }, bin: "aider",
    env: () => ({ OPENAI_API_KEY: "x" }),
    args: (p, q) => ["--openai-api-base", `http://127.0.0.1:${p}/v1`, "--model", "openai/test-model", "--no-check-update",
      "--analytics-disable", "--yes-always", "--no-auto-commits", "--message", q],
  },
  {
    id: "pi", label: "pi", source: { npm: "@earendil-works/pi-coding-agent" }, bin: "pi",
    setup: (h, p) => put(`${h}/.pi/agent/models.json`, { providers: { cap: { baseUrl: `http://127.0.0.1:${p}/v1`, api: "openai-completions", apiKey: "x", models: [{ id: "test-model" }] } } }),
    args: (_p, q) => ["-p", "--model", "cap/test-model", q],
  },
];
