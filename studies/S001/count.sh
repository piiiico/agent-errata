#!/usr/bin/env bash
# S001: how many of the dates cited in your rules/memory files are older than
# your oldest raw transcript (a log that holds tool calls AND their outputs)?
#
# usage: CUTOFF=YYYY-MM-DD ./count.sh <rules-file> [more files...]
#   CUTOFF = date of your oldest raw transcript
#   YEAR   = year assumed for dates written without one (default: this year)
#   TODAY  = dates after this are deadlines, not incidents (default: today)
#
# Prints one line. Dates are tokens like 08-21 or 2026-08-21.
set -euo pipefail
: "${CUTOFF:?set CUTOFF=YYYY-MM-DD, the date of your oldest raw transcript}"
YEAR=${YEAR:-$(date +%Y)}
TODAY=${TODAY:-$(date +%Y-%m-%d)}
[ "$#" -ge 1 ] || { echo "usage: CUTOFF=YYYY-MM-DD $0 <rules-file>..." >&2; exit 2; }
for f in "$@"; do [ -r "$f" ] || { echo "cannot read $f" >&2; exit 2; }; done

cat "$@" | grep -oE '[0-9-]+' | sed 's/^-*//; s/-*$//' \
  | grep -E '^(20[0-9]{2}-)?(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$' \
  | awk -v y="$YEAR" -v c="$CUTOFF" -v t="$TODAY" '
      { d = (length($0) == 5) ? y "-" $0 : $0
        if (d > t) { future++; next }
        n++; seen[d] = 1
        if (d < c) { before++; bseen[d] = 1 }
        if (min == "" || d < min) min = d }
      END {
        for (k in seen) nd++; for (k in bseen) nb++
        if (n == 0) { print "no dated citations parsed (check the file)"; exit 3 }
        printf "cited=%d before_cutoff=%d (%.1f%%) distinct_dates=%d distinct_before=%d oldest=%s cutoff=%s skipped_future=%d\n",
          n, before, 100 * before / n, nd, nb + 0, min, c, future + 0 }'
