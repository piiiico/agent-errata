# S003 sweep: capture-endpoint runs, no model key

Each harness is pointed at `cap.ts`, a local server that writes every request body to disk and answers "NONE" in the dialect it was asked in (Anthropic messages, OpenAI chat completions and responses, Gemini generateContent). Nothing reaches a model. `score.ts` then greps the **main request** (the first request that carries the prompt and a tool list; Gemini CLI and opencode send a routing or title request first) for `S003C-` tokens.

`fixture.sh` builds four arms under `/tmp/s003fx/<harness>/`. Keep them outside any directory that holds a `CLAUDE.md` or `AGENTS.md`: our first Claude Code run was inside our own workspace and picked up our own 47 KB `CLAUDE.md` from a parent directory (that is arm d).

| arm | layout | cwd |
|---|---|---|
| a | `parent/AGENTS.md` above the git root; `parent/repo/` (git root) holds `AGENTS.md`, `AGENTS.override.md`, `CLAUDE.md`, `CLAUDE.local.md`, `GEMINI.md`, `QWEN.md`, `CRUSH.md`, `CONVENTIONS.md`, `.cursorrules`, `.cursor/rules/s003.mdc`, `.windsurfrules`, `.clinerules`, `.goosehints`, `.github/copilot-instructions.md`, `.kilocode/rules/s003.md`, `sub/AGENTS.md` | `parent/repo` |
| b | `AGENTS.md` + `CLAUDE.md`, git root | `repo` |
| c | monorepo: `mono/AGENTS.md` (git root) + `mono/child/AGENTS.md` | `mono/child` |
| d | `CLAUDE.md` one level ABOVE the git root; the repo has only `AGENTS.md` | `repo` |

`HOME` is a fresh scratch dir per harness, so no real config or key is read. Commands (`$P` = capture port, `$PROMPT` set by `run1.sh`):

```
claude   ANTHROPIC_BASE_URL=http://127.0.0.1:$P ANTHROPIC_API_KEY=sk-ant-fake claude -p "$PROMPT"
codex    CAPKEY=x codex exec --skip-git-repo-check -c model_provider=cap \
           -c 'model_providers.cap={name="cap",base_url="http://127.0.0.1:$P/v1",env_key="CAPKEY",wire_api="responses"}' -m gpt-5 "$PROMPT"
gemini   GEMINI_CLI_TRUST_WORKSPACE=true GEMINI_API_KEY=x GOOGLE_GEMINI_BASE_URL=http://127.0.0.1:$P gemini -p "$PROMPT"
           (~/.gemini/settings.json: {"security":{"auth":{"selectedType":"gemini-api-key"}}})
qwen     OPENAI_API_KEY=x OPENAI_BASE_URL=http://127.0.0.1:$P/v1 OPENAI_MODEL=qwen3-coder-plus qwen -p "$PROMPT"
           (~/.qwen/settings.json: {"security":{"auth":{"selectedType":"openai"}}})
opencode opencode run -m cap/test-model "$PROMPT"
kilo     kilo run -m cap/test-model "$PROMPT"
           (~/.config/{opencode,kilo}/: provider "cap", npm @ai-sdk/openai-compatible, baseURL http://127.0.0.1:$P/v1)
crush    crush run "$PROMPT"
           (~/.config/crush/crush.json: provider "cap", type openai-compat, base_url http://127.0.0.1:$P/v1; large+small = cap/test-model)
goose    GOOSE_DISABLE_KEYRING=1 GOOSE_PROVIDER=openai GOOSE_MODEL=gpt-4o OPENAI_HOST=http://127.0.0.1:$P OPENAI_API_KEY=x \
           goose run --no-session -t "$PROMPT"
aider    OPENAI_API_KEY=x aider --openai-api-base http://127.0.0.1:$P/v1 --model openai/test-model --no-check-update \
           --analytics-disable --yes-always --no-auto-commits --message "$PROMPT"      (control run: add --read CONVENTIONS.md)
pi       pi -p --model cap/test-model "$PROMPT"
           (~/.pi/agent/models.json: provider "cap", api openai-completions, baseUrl http://127.0.0.1:$P/v1)
```

Example: `./run1.sh codex a 18103 -- sh -c 'CAPKEY=x codex exec ... "$PROMPT"'`, then arms b, c, d (arm a builds the fixture).

`redact.ts` turns a raw capture into the files under `../captures/`: request list, sizes, tool count, system prompt length, the tokens found, and at most 110 characters around each token. Raw bodies hold each vendor's full system prompt and are not published.
