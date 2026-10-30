# K001 blind run, arm 2: the same prompt, with a library Ed25519 allowed

Pinned after arm 1 (`../K001`) and before any arm 2 call. Arm 1 told the models to use the standard library only. All three programs that came back rejected a known-good contract signature (`real_p31_baseline`, which `node:crypto` verifies), so all three refused every contract and failed 119 or more of 128 vectors. A miss shared across labs was the test for a gap in the text, but here the shared cause was Pico's prompt: it made each model hand-roll Ed25519.

Arm 2 changes one sentence of `INSTRUCTIONS.md` and nothing else (diff against `../K001/INSTRUCTIONS.md`): `cryptography` may be used for Ed25519; the key and signature checks of 3.2 and 3.4 stay the program's job. Same `MODELS`, same caller, same harness, same rules as arm 1, run under Python 3.13 with cryptography 50.0.2. Arm 1 and arm 2 together still count as one independent line.
