# Harness Watch

S003 and S004, re-measured on every release of the 10 harnesses.

- `.github/workflows/harness-watch.yml` runs daily on `ubuntu-latest` (and on demand). Its run logs are public.
- `watch.ts` looks up each harness's latest version (npm, PyPI, GitHub releases). For each version that differs from `state.json`, it installs that version, builds the fixtures (`../sweep/fixture.sh`, `../sweep/fixture-symlink.sh`), runs arms a to f against the capture endpoint (`../sweep/cap.ts`) with dummy keys, an empty `HOME` and no CI variables, then scores the main request (`../sweep/score.ts`) and splits arm b into tokens (`../../S004/tokens.py`).
- It writes `runs/<date>-<harness>-<version>.json` (tokens per arm, symlink occurrence counts, S004 split; no system prompt text) and rebuilds the changelog on both pages and in `CHANGELOG.md` (`render.ts`).
- A row counts as **changed** if any arm loads a different set of files, a symlink arm sends the content a different number of times, or the S004 total moves more than 10%. A changed row opens an issue in this repo.
- Exit code 2 if any version lookup or re-measure failed. A failed run does not write a row, and the harness is retried the next day.

`harnesses.ts` holds the install source, config and command for each harness (the same commands as `../sweep/README.md`).

Run it yourself: `bun watch.ts --check` lists versions; `bun watch.ts --force codex` re-measures one harness at its current version (needs `pip install tiktoken`).

The baseline in `state.json` is the 2026-10-02 sweep (Linux aarch64). Re-measures in CI run on Linux x86_64.
