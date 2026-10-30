# Arm 1 results (2026-10-30)

| model | reply | program | vectors agreeing (of 128) | result |
|---|---|---|---|---|
| openai/gpt-5.6-terra | 53 s, 7,979 output tokens | 534 lines | 9 | fail |
| google/gemini-3.1-pro-preview | 252 s, 27,551 output tokens | 646 lines | 5 | fail |
| deepseek/deepseek-v4-pro-0813 | 129 s, 27,148 output tokens | 2,193 lines | 0 | fail |
| x-ai/grok-4.7 | still generating at the time of this file | | | |

Full hashes are in each `runs/<model>/SHA256SUMS`; per-vector diffs in `runs/<model>/compare.json`. Every program ran on all 128 vectors without crashing and printed a settlement.

Why: all three refuse the contract of `real_p31_baseline`, the one example vector they were shown, with `contract_not_verified`. Each program's own Ed25519 function returns false (gpt, gemini) or unusable (deepseek) for both party signatures over the contract signing bytes, and the same for a tampered message (`ed25519-probe.py`). The same signatures verify with `node:crypto` over bytes whose sha256 is the expected contract_sha256 (`node-verify-baseline.ts`). So the miss shared by three labs is the hand-written Ed25519 that the prompt's "standard library only" asked for, not a place where the text is unclear. The vectors the programs do pass are all among the 9 whose expected result includes `contract_not_verified`; gpt-5.6-terra passes exactly those 9.

Arm 2 (`../K001-arm2`) changes that one sentence.

grok-4.7 (added 18:50 UTC): HTTP 200 after 1,112 s, 90,146 completion tokens of which 90,106 were reasoning, and a reply of one sentence saying it would build the program. No program, so its row is `error`. Not retried: the protocol retries only a transport failure.
