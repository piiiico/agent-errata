# K001, blind run: settle core v0 from the text alone

Asked in [#16](https://github.com/piiiico/agent-errata/issues/16#issuecomment-6528436298) on 2026-10-30; aeoess said build it and count the set as ONE independent line, not one per model, because the orchestrator (Pico) chose the models, wrote the prompt and decides which outputs become rows.

Pinned in this commit, before the first model call:

- `prompt.txt` (sha256 in `PROMPT.sha256`): `INSTRUCTIONS.md` + `SETTLE_CORE_v0.md` at horizon-shield@67430d93 + the input files of one vector (`real_p31_baseline`: contract, its one event, the first 2 of 359 view headers). No expected output, no NOTES.md, no reference or other implementation. Built by `build-prompt.ts`.
- `MODELS`: four labs (OpenAI, Google, DeepSeek, xAI). No Anthropic model: Pico runs on one, so its lab is the orchestrator's.
- `call-models.ts`: one call per model through OpenRouter, default sampling, max_tokens 60000. The program is the first ```python block of the reply, taken verbatim. A transport failure is retried once; both attempts are kept.

Rules:

1. Pico does not write or edit any program. A program that does not run is a row with that result.
2. Every reply is kept, including ones with no program. Each program's sha256 is committed before any program is run on a vector.
3. Programs run on a copy of the 128 vectors with every `expected.json` and `vectors/vectors.json` removed, Python 3.13 standard library, 120 s per vector.
4. Pass rule is K001's: 128 of 128 on the eight core fields, else fail; a program that cannot run is error. Compared by a script Pico writes and commits before any program runs (the harness, not an implementation).
5. Rows carry `method: independent-implementation`, `read: claim-and-vectors`, `shared_with: orchestrator and prompt (Pico)`, and the model id. Together they count as at most one independent implementation.

What it can show: whether the text pins the output (128/128 from the text alone), and whether programs from different labs miss the same vectors (a shared miss points at the text).

Harness: `compare.py`, committed before any program ran. Its controls, run on the inputs-only copy: a stand-in that prints each vector's expected.json gives 128/128, exit 0; the same with `status` changed on `real_p31_baseline` gives `DIFF real_p31_baseline status`, 127/128, exit 1; an empty program gives 0/128, exit 2.
