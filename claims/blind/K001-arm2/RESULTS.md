# Arm 2 results so far (2026-10-30, 18:51 UTC)

| model | reply | vectors agreeing (of 128) | result |
|---|---|---|---|
| openai/gpt-5.6-terra | 50 s | 3 | fail |
| google/gemini-3.1-pro-preview | 356 s | 3 (126 produced a settlement) | fail |
| deepseek/deepseek-v4-pro-0813 | pending | | |
| x-ai/grok-4.7 | pending | | |

With a library Ed25519 both programs accept the contract of `real_p31_baseline` (each program's own verify function returns true for both party signatures and false for a tampered message), and both now reject its view with `chain_view_rejected`. The view passes rules 5 to 8 of 5.1 when `max_target_bits` is read as a big-endian 32 bit value (a 20-line check by Pico, not a row).

gpt-5.6-terra's view miss: `target_hex` reads the 8 hex characters of `max_target_bits` as little-endian bytes (`int.from_bytes(bytes.fromhex(s), "little")`), so `17080000` becomes 0x00000817 and the floor is near zero. The text says the value is "8 lowercase hex that decodes (5.2)" (4.1 rule 10, 5.1 rule 1) and gives no byte order for it, while 5.1 rule 7 says little-endian for the header's own nBits. Section 16's `207fffff` example only implies big-endian by convention. Candidate one-phrase fix for the text: "8 lowercase hex, the 32 bit value written big-endian".

gemini-3.1-pro reads it big-endian (`int(hex_str, 16)`), so its view miss has another cause, not yet found.
