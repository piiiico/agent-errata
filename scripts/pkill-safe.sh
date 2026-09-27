#!/usr/bin/env bash
# pkill -f without killing your own caller (E021). Lists pgrep -f hits, drops
# every PID on this script's ancestor chain and every PID descended from it,
# then kills only what is left and says what it spared.
# Usage: scripts/pkill-safe.sh [-SIGNAL] PATTERN     exit 1 if nothing left to kill
set -u
sig=TERM; [[ "${1:-}" == -* ]] && { sig="${1#-}"; shift; }
pat="${1:?usage: pkill-safe.sh [-SIGNAL] PATTERN}"
up() { local p=$1; while [[ -n "$p" && "$p" != 0 ]]; do echo "$p"; [[ "$p" == 1 ]] && break; p=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' '); done; }
mine=" $(up $$ | tr '\n' ' ') "
hits=$(pgrep -f -- "$pat")
kill_list=""
for c in $hits; do
  if [[ "$mine" == *" $c "* ]] || up "$c" | grep -qx "$$"; then
    echo "spared $c (own chain): $(ps -o args= -p "$c" 2>/dev/null | cut -c1-80)" >&2
  else
    kill_list="$kill_list $c"
  fi
done
[[ -z "$kill_list" ]] && { echo "nothing to kill for: $pat" >&2; exit 1; }
kill -"$sig" $kill_list && echo "killed:$kill_list"
