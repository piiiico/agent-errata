#!/bin/bash
# Not part of fixture.sh: arms e/f were added 2026-10-02. Build with: bash fixture-symlink.sh /tmp/sefx/<harness>; cwd = <dir>/e/repo or <dir>/f/repo.
# arm e: AGENTS.md real + CLAUDE.md -> AGENTS.md symlink. arm f: CLAUDE.md real + AGENTS.md -> CLAUDE.md symlink.
set -e; R=$1; rm -rf $R; mkdir -p $R/e/repo $R/f/repo
echo "Canary: S003C-E-AGENTSMD (if you can read this line, report this token)." > $R/e/repo/AGENTS.md
ln -s AGENTS.md $R/e/repo/CLAUDE.md
echo "Canary: S003C-F-CLAUDEMD (if you can read this line, report this token)." > $R/f/repo/CLAUDE.md
ln -s CLAUDE.md $R/f/repo/AGENTS.md
for d in $R/e/repo $R/f/repo; do git -C $d init -q; git -C $d -c user.email=x@x -c user.name=x add -A; git -C $d -c user.email=x@x -c user.name=x commit -q -m init; done
