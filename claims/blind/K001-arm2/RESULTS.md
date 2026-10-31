# Arm 2 results (2026-10-30 and 31)

| model | reply | vectors agreeing (of 128) | result |
|---|---|---|---|
| openai/gpt-5.6-terra | 50 s | 3 | fail |
| google/gemini-3.1-pro-preview | 356 s | 3 (126 produced a settlement) | fail |
| deepseek/deepseek-v4-pro-0813 | 607 s | 0 (no vector produced a settlement) | error: the program never imports `json`, so it crashes on its first print (`NameError`), on every vector. Not edited (rule 1). |
| x-ai/grok-4.7 | 1,542 s (re-called alone on 2026-10-31: the first call was lost with its container, no response file; scratch copy of `call-models.ts` with `MODELS` cut to this line, same `prompt.txt`) | 124 | fail: the 4 misses are the vectors with the `real_r2` view (537 `{`/`[` in total). Its `too_deep()` adds 1 per bracket and never subtracts, so it counts brackets, not nesting, and refuses the input at 513. 2.2 says "nested deeper than 512 levels", so this is the program's. |

With a library Ed25519 both programs accept the contract of `real_p31_baseline` (each program's own verify function returns true for both party signatures and false for a tampered message), and both now reject its view with `chain_view_rejected`. The view passes rules 5 to 8 of 5.1 when `max_target_bits` is read as a big-endian 32 bit value (a 20-line check by Pico, not a row).

gpt-5.6-terra's view miss: `target_hex` reads the 8 hex characters of `max_target_bits` as little-endian bytes (`int.from_bytes(bytes.fromhex(s), "little")`), so `17080000` becomes 0x00000817 and the floor is near zero. The text says the value is "8 lowercase hex that decodes (5.2)" (4.1 rule 10, 5.1 rule 1) and gives no byte order for it, while 5.1 rule 7 says little-endian for the header's own nBits. Section 16's `207fffff` example only implies big-endian by convention. Candidate one-phrase fix for the text: "8 lowercase hex, the 32 bit value written big-endian".

gemini-3.1-pro reads it big-endian (`int(hex_str, 16)`), so its view miss has another cause: line 622 compares the proof of work on `h_hash[::-1]`, where `h_hash` is already the byte-reversed (display order) hash, so it reads the raw digest as the big-endian number. 5.1 rule 7 and the paragraph after it say the display-order hash is the number, so this one is the program's, not the text's.

## Diagnostic, not rows (2026-10-31)

`diagnostic/one-token.sh` copies three programs, makes one small change in each (gpt line 218 `"little"` to `"big"`; gemini line 622 `h_hash[::-1]` to `h_hash`; grok's `too_deep()` gets the missing decrement) and runs the same harness. The rows stay as the unedited programs scored (rule 1). Output in `diagnostic/*.txt`:

| copy | vectors agreeing (of 128) |
|---|---|
| gpt-5.6-terra, max_target_bits big-endian | 84 |
| gemini-3.1-pro, proof of work on the display-order hash | 112 |
| grok-4.7, `too_deep()` subtracts on `}` and `]` (two lines) | 128 |

So the byte order accounts for gpt's view rejection, not for all its misses: 44 remain, 19 of them parent-contract vectors (`synth_parent_*`). 

Nine vectors are missed by both the gpt and gemini copies; the grok copy passes all of them. Seven of them are every vector whose expected reasons include one from the 4.2 table (`too_many_witnesses`, `tie_policy_refused`, `ack_window_missing`, `finality_policy_missing`, `grant_action_name_invalid`, `unscoped_approvals_refused`, `key_conflict`): expected `event_set` is `[]` and `dispositions` is `{}`, and both programs go on to accept the record. The text says the stop once, in the summary of 2.3 ("If a problem was found in 4.1, 4.2 or 5.1 rules 1 to 8, no record is examined further"). 4.2 itself does not say it, while 4.3 says its own checks "do not stop the walk", and the `event_set` row of 9.1 lists the reasons that do not empty it without listing the ones that do. A miss shared by two labs, at a rule stated only in the summary; a third lab's program got it right from the same text, so the text is readable, just easy to miss. Candidate for one sentence in 4.2, "Any of these stops the computation: no record is examined further (2.3)". The other two shared misses (`synth_action_name_not_canonical`, `synth_record_field_outside_schema`) have different causes in each program. In the unedited programs every one of these is hidden behind the view rejection.


## Learn-line answer

Does SETTLE_CORE_v0.md alone pin the output for models from four labs? No program did 128/128 as written: across both arms the best is grok-4.7 at 124. One program (grok, two lines away) shows the text can carry a stranger to 128/128 without NOTES.md, the reference or any expected output; that is a diagnostic, not a pass. The misses do not coincide on one place in the text, except the 4.2 stop that the gpt and gemini programs both skip.
