#!/usr/bin/env bash
# S003 canary: does your harness load the instruction files you think it loads?
#
#   ./canary.sh plant FILE...      append one random token line to each file, save the map
#   ./canary.sh hook               print a token + a hook command line that writes it when the hook runs
#   ./canary.sh score ANSWER_FILE  compare the tokens a fresh session reported against what was planted
#   ./canary.sh remove             strip every planted line (each file is restored byte for byte)
#
# State lives in $S003_STATE (default ./.s003-canaries). Needs bash, od, grep, cmp.
set -u
STATE="${S003_STATE:-./.s003-canaries}"
cmd="${1:-}"; shift || true

tok() { printf 'S003C-%s' "$(od -An -N5 -tx1 /dev/urandom | tr -d ' \n')"; }

case "$cmd" in
plant)
  [ "$#" -gt 0 ] || { echo "usage: canary.sh plant FILE..." >&2; exit 2; }
  mkdir -p "$STATE/orig"
  for f in "$@"; do
    [ -f "$f" ] || { echo "skip (no such file): $f" >&2; continue; }
    if grep -q 'S003C-' "$f"; then
      if [ -L "$f" ]; then echo "skip (symlink to $(readlink "$f"), planted there already; a session reading either name sees the same token): $f" >&2
      else echo "skip (already planted): $f" >&2; fi
      continue
    fi
    t=$(tok)
    key=$(printf '%s' "$f" | od -An -tx1 | tr -d ' \n' | cut -c1-80)
    cp -p "$f" "$STATE/orig/$key"
    # newline first if the file does not end in one, so the token is its own line
    nl=keep; if [ -s "$f" ] && [ -n "$(tail -c1 "$f")" ]; then printf '\n' >> "$f"; nl=added; fi
    printf '%s (instruction-load canary for agent-errata S003; ignore it)\n' "$t" >> "$f"
    printf '%s\t%s\t%s\t%s\n' "$t" "$f" "$key" "$nl" >> "$STATE/map.tsv"
    printf 'planted %s  %s\n' "$t" "$f"
  done ;;
hook)
  mkdir -p "$STATE"
  t=$(tok); fired="$(cd "$STATE" && pwd)/hook-fired.txt"
  printf '%s\t%s\t-\n' "$t" "HOOK" >> "$STATE/map.tsv"
  echo "token: $t"
  echo "hook command (add it to your harness's session-start or pre-tool hook):"
  echo "  echo $t; echo $t >> $fired"
  echo "If the hook runs, the token lands in $fired (and, where hook stdout reaches the model, in context)." ;;
score)
  ans="${1:-}"; [ -f "$ans" ] || { echo "usage: canary.sh score ANSWER_FILE" >&2; exit 2; }
  [ -s "$STATE/map.tsv" ] || { echo "nothing planted (no $STATE/map.tsv)" >&2; exit 3; }
  planted=0; seen=0
  while IFS=$'\t' read -r t f _; do
    planted=$((planted+1))
    s=no
    grep -q -- "$t" "$ans" && s=yes
    [ "$f" = HOOK ] && [ -f "$STATE/hook-fired.txt" ] && grep -q -- "$t" "$STATE/hook-fired.txt" && s="hook-fired"
    case "$s" in yes|hook-fired) seen=$((seen+1));; esac
    printf '%-22s %-14s %s\n' "$t" "$s" "$f"
  done < "$STATE/map.tsv"
  # tokens the session reported that were never planted: it guessed or copied, and the run is void
  extra=$(grep -o 'S003C-[0-9a-f]\{10\}' "$ans" | sort -u | while read -r x; do grep -q -- "$x" "$STATE/map.tsv" || echo "$x"; done)
  echo "planted=$planted seen=$seen invented=$(printf '%s' "$extra" | grep -c . )"
  [ -n "$extra" ] && { echo "invented tokens (run is void): $extra"; exit 4; }
  exit 0 ;;
remove)
  [ -s "$STATE/map.tsv" ] || { echo "nothing to remove" >&2; exit 3; }
  bad=0
  while IFS=$'\t' read -r t f key nl; do
    [ "$f" = HOOK ] && { echo "hook $t: delete the hook line from your harness config by hand"; continue; }
    grep -v -- "$t" "$f" > "$f.s003tmp" || true
    if [ "$nl" = added ]; then printf '%s' "$(cat "$f.s003tmp")" > "$f"; else cat "$f.s003tmp" > "$f"; fi
    rm -f "$f.s003tmp"
    # never overwrite: if the file changed for another reason since plant, say so and keep the saved copy
    if cmp -s "$f" "$STATE/orig/$key"; then echo "restored $f"; else echo "DIFFERS from the pre-plant copy (edited meanwhile?): $f  saved copy: $STATE/orig/$key" >&2; bad=1; fi
  done < "$STATE/map.tsv"
  [ "$bad" = 0 ] && rm -rf "$STATE"
  exit "$bad" ;;
*)
  sed -n '2,9p' "$0"; exit 2 ;;
esac
