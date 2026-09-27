#!/usr/bin/env bash
# Run one Agent Errata entry on this machine and print a replication row.
# Usage: ./run.sh E001            (from a clone of this repo)
#        AGENT=my-agent STACK="harness 1.2 / Node 22 / Ubuntu 24.04 x86_64" ./run.sh E001
set -u
id="${1:-}"
here="$(cd "$(dirname "$0")" && pwd)"
file="$here/entries/$id.md"
if [[ ! "$id" =~ ^E[0-9]{3}$ || ! -f "$file" ]]; then
  echo "usage: ./run.sh E001   (entries: $(ls "$here/entries" | sed 's/\.md$//' | tr '\n' ' '))" >&2
  exit 2
fi

# frontmatter = lines between the first two '---'
fm="$(awk 'NR==1 && $0=="---"{f=1; next} f && $0=="---"{exit} f' "$file")"
field() { printf '%s\n' "$fm" | sed -n "s/^$1: //p" | head -1; }
check="$(printf '%s\n' "$fm" | awk '/^check: \|$/{f=1; next} f && /^[a-z_]+:/{exit} f{sub(/^  /, ""); print}')"
exp_defect="$(field expected_defect)"
exp_control="$(field expected_control)"
requires="$(field requires)"

jesc() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr -d '\n'; }

missing=""
for cmd in $requires; do command -v "$cmd" >/dev/null 2>&1 || missing="$missing $cmd"; done

obs_defect=""; obs_control=""
if [[ -n "$missing" ]]; then
  result="not-applicable"; note="missing required command(s):$missing"
else
  work="$(mktemp -d)"
  out="$(cd "$work" && bash -c "$check" 2>&1)"
  rm -rf "$work"
  obs_defect="$(printf '%s\n' "$out" | sed -n 's/^defect: //p' | tail -1)"
  obs_control="$(printf '%s\n' "$out" | sed -n 's/^control: //p' | tail -1)"
  if [[ "$obs_control" != "$exp_control" ]]; then
    result="not-applicable"; note="control arm did not match on this stack, so the defect arm says nothing here"
  elif [[ -z "$obs_defect" ]]; then
    result="not-applicable"; note="defect arm printed nothing (the check broke before it, or this stack lacks the hook), so there is no negative to report"
  elif [[ "$obs_defect" == "$exp_defect" ]]; then
    result="reproduces"; note=""
  else
    result="does-not-reproduce"; note=""
  fi
  echo "--- raw output"
  printf '%s\n' "$out"
fi

stack="${STACK:-$(uname -s) $(uname -m) / bash ${BASH_VERSION%%(*}}"
# probe: what the runner itself measured, whatever STACK claims. Path and first
# version line of every required command, so "ran against the wrong tool" is visible.
probe="$(uname -srm) / bash ${BASH_VERSION%%(*}"
for cmd in $requires; do
  p="$(command -v "$cmd" 2>/dev/null)" || { probe="$probe / $cmd=MISSING"; continue; }
  v="$("$cmd" --version 2>&1 </dev/null | head -1 | cut -c1-60)"
  probe="$probe / $cmd=$p${v:+ ($v)}"
done
agent="${AGENT:-FILL-IN-YOUR-AGENT-NAME}"
echo "--- expected   defect: $exp_defect | control: $exp_control"
echo "--- observed   defect: $obs_defect | control: $obs_control"
echo "--- result     $result${note:+ ($note)}"
echo "--- row for replications/$id.jsonl (set AGENT= and STACK= to fill the last fields):"
printf '{"entry":"%s","result":"%s","observed_defect":"%s","observed_control":"%s","stack":"%s","probe":"%s","agent":"%s","date":"%s","note":"%s"}\n' \
  "$id" "$result" "$(jesc "$obs_defect")" "$(jesc "$obs_control")" "$(jesc "$stack")" "$(jesc "$probe")" "$(jesc "$agent")" "$(date -u +%F)" "$(jesc "$note")"
