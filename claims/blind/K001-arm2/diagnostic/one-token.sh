#!/bin/bash
# DIAGNOSTIC ONLY, never a row (PROTOCOL rule 1 binds rows): copies of two arm 2 programs with one token
# changed each, to see what each program misses once its view bug is out of the way.
#   gpt-5.6-terra  line 218: max_target_bits read "little" -> "big"
#   gemini-3.1-pro line 622: proof of work compared on h_hash[::-1] (the raw digest) -> h_hash (display order)
#   grok-4.7       too_deep(): adds the missing `elif c in "}]": depth -= 1`, so it counts nesting, not every bracket
# Usage: bash one-token.sh <inputs-only dir> <vectors dir> <python with cryptography>
set -euo pipefail
R=$(dirname "$0")/../runs; I=$1; V=$2; PY=$3; T=$(mktemp -d)
sed '218s/"little"/"big"/' "$R/openai_gpt-5.6-terra/settle.py" > "$T/gpt_be.py"
sed 's/if int.from_bytes(h_hash\[::-1\], .big.) > target/if int.from_bytes(h_hash, "big") > target/' "$R/google_gemini-3.1-pro-preview/settle.py" > "$T/gem_pow.py"
[ "$(diff "$R/openai_gpt-5.6-terra/settle.py" "$T/gpt_be.py" | grep -c '^>')" = 1 ] && [ "$(diff "$R/google_gemini-3.1-pro-preview/settle.py" "$T/gem_pow.py" | grep -c '^>')" = 1 ] || { echo "edit did not apply" >&2; exit 1; }
python3 - "$R/x-ai_grok-4.7/settle.py" "$T/grok_depth.py" <<'PY'
import sys
s = open(sys.argv[1]).read()
old = "            if depth > 512:\n                return True\n        i += 1\n    return False"
assert s.count(old) == 1, "grok edit did not apply"
open(sys.argv[2], "w").write(s.replace(old, old.replace("        i += 1", "        elif c in \"}]\":\n            depth -= 1\n        i += 1")))
PY
for p in gpt_be gem_pow grok_depth; do "$PY" "$(dirname "$0")/../compare.py" "$T/$p.py" "$I" "$V" "$T/$p.json" > "$(dirname "$0")/$p.txt" || true; tail -1 "$(dirname "$0")/$p.txt"; done
