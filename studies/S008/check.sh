#!/usr/bin/env bash
# S008: find your harness's compaction prompt and answer four questions about it.
# Usage: ./check.sh <install dir or binary>   (read-only; no network)
set -u
T=${1:?usage: check.sh <install dir or binary>}
dump() { if [ -f "$T" ]; then strings -n 8 "$T"; else find "$T" -type f \( -name '*.js' -o -name '*.mjs' -o -name '*.txt' -o -name '*.md' -o -name '*.py' -o -perm -u+x \) -size -200M -print0 | xargs -0 strings -n 8 2>/dev/null; fi; }
TMP=$(mktemp); dump > "$TMP"; N=$(wc -l < "$TMP")
[ "$N" -gt 0 ] || { echo "read 0 lines from $T: wrong path?"; exit 3; }
echo "lines read: $N"
echo "== candidate compaction prompts (first lines):"
grep -n -i -E "(summari[sz]e|summary of) (the|this) (conversation|chat history|session)|context checkpoint|state_snapshot|compact(ion)? summary|only memory of|ONLY context available" "$TMP" | cut -c1-200 | head -12
# Q1-Q3 read only the text around the candidate prompts: a whole-install grep counts unrelated "untrusted" strings.
W=$(mktemp); grep -n -i -E "(summari[sz]e|summary of) (the|this) (conversation|chat history|session)|context checkpoint|state_snapshot|only memory of|ONLY context available" "$TMP" | cut -d: -f1 | head -40 | while read L; do sed -n "$((L>20?L-20:1)),$((L+60))p" "$TMP"; done > "$W"
echo "window lines: $(wc -l < "$W")"; [ -s "$W" ] || { echo "no compaction prompt found: read Q1-Q3 by hand"; }
echo "== Q1 does it warn that history may carry instructions? (matching lines in window)"
grep -i -E "prompt injection|adversarial content|treat .{0,40}as data|untrusted" "$W" | cut -c1-200 | sort -u | head -3
echo "== Q2 does it keep user messages apart from tool output?"
grep -i -E "user messages.{0,40}not tool results|verbatim user" "$W" | cut -c1-200 | head -3
echo "== Q3 constraint field wording (read it: does it say where a rule came from?)"
grep -i -E "constraint" "$W" | cut -c1-200 | sort -u | head -5
rm -f "$TMP" "$W"
echo "Q4 (role the summary comes back as) needs the code that re-inserts it; say 'not read' if you can't find it."
