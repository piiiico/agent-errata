#!/usr/bin/env bash
# S002: are the payment addresses you published the ones you can sign for?
# Usage: MINE="0xYourAddr SolAddr ..." ./paycheck.sh DIR_OR_FILE [...]
# MINE = addresses DERIVED from your keys right now (not copied from a config file).
# Prints each EVM (0x+40 hex) or Solana-shaped (base58, 32-44 chars) address that sits on a line
# telling someone where money goes (pay to, recipient, send, fund, tip, donate, wallet, receive,
# treasury, beneficiary), tagged MINE or OTHER, then totals.
# Skips .git, node_modules, lockfiles, and lines over 400 chars (embedded fonts/images are base58-shaped noise).
# Exit 2: MINE empty. Exit 3: read 0 files. Needs bash + perl (macOS and Linux have both).
set -u
[ -n "${MINE:-}" ] || { echo "set MINE to your key-derived address(es)" >&2; exit 2; }
find "$@" -type f -not -path '*/.git/*' -not -path '*/node_modules/*' \
  -not -name '*.lock' -not -name '*.lockb' -not -name 'package-lock.json' -size -2M -print0 |
MINE="$MINE" perl -0 -ne '
  BEGIN { %mine = map { lc($_) => 1 } split " ", $ENV{MINE}; $files = 0; $m = 0; $o = 0; $/ = "\0"; }
  chomp; my $f = $_; next unless -f $f; $files++;
  open(my $fh, "<", $f) or next; my $n = 0;
  local $/ = "\n";
  while (my $l = <$fh>) { $n++;
    next if length($l) > 400;
    next unless $l =~ /(pay[_ ]?to|recipient|send|fund|tip|donat|wallet|receiv|treasury|beneficiar)/i;
    my @a = ($l =~ /\b(0x[0-9a-fA-F]{40})(?![0-9a-fA-F])/g);
    push @a, grep { /[0-9]/ } ($l =~ /(?:^|[\s"'"'"'`(:=,<>\[])([1-9A-HJ-NP-Za-km-z]{32,44})(?=$|[\s"'"'"'`),.<>\]])/g);
    for my $a (@a) { if ($mine{lc $a}) { $m++; print "MINE  $f:$n:$a\n" } else { $o++; print "OTHER $f:$n:$a\n" } }
  }
  END { if ($files == 0) { print STDERR "read 0 files\n"; exit 3 } print "files=$files pay_line_addresses=".($m+$o)." mine=$m other=$o\n" }
'
