#!/bin/bash
# Build the three S003 sweep arms under $1 (a fresh dir per harness run).
# Every token is S003C-<ARM>-<SURFACE>; tokens are unique across files and arms.
set -e
R=$1; rm -rf "$R"; mkdir -p "$R"
tok() { echo "Canary: S003C-$1-$2 (if you can read this line, report this token)."; }
gi() { git -C "$1" init -q; git -C "$1" -c user.email=x@x -c user.name=x commit -q --allow-empty -m init; }

# arm a: everything. parent/ is ABOVE the git root; repo/ is the git root and cwd.
A=$R/a; mkdir -p $A/parent/repo/sub $A/parent/repo/.cursor/rules $A/parent/repo/.github $A/parent/repo/.kilocode/rules $A/parent/repo/.qwen $A/parent/repo/.gemini
tok A PARENT_AGENTSMD > $A/parent/AGENTS.md
P=$A/parent/repo
tok A AGENTSMD > $P/AGENTS.md
tok A CLAUDEMD > $P/CLAUDE.md
tok A CLAUDELOCALMD > $P/CLAUDE.local.md
tok A GEMINIMD > $P/GEMINI.md
tok A QWENMD > $P/QWEN.md
tok A CRUSHMD > $P/CRUSH.md
tok A AGENTSOVERRIDEMD > $P/AGENTS.override.md
tok A CONVENTIONSMD > $P/CONVENTIONS.md
tok A CURSORRULES > $P/.cursorrules
tok A CURSOR_RULES_MDC > $P/.cursor/rules/s003.mdc
tok A WINDSURFRULES > $P/.windsurfrules
tok A CLINERULES > $P/.clinerules
tok A GOOSEHINTS > $P/.goosehints
tok A COPILOT_INSTR > $P/.github/copilot-instructions.md
tok A KILOCODE_RULES > $P/.kilocode/rules/s003.md
tok A SUB_AGENTSMD > $P/sub/AGENTS.md
echo "x = 1" > $P/sub/main.py
gi $P

# arm b: precedence. AGENTS.md + CLAUDE.md only, git root = cwd.
B=$R/b/repo; mkdir -p $B
tok B AGENTSMD > $B/AGENTS.md
tok B CLAUDEMD > $B/CLAUDE.md
gi $B

# arm c: walk-up inside a monorepo. git root = mono/, cwd = mono/child/.
C=$R/c/mono; mkdir -p $C/child
tok C ROOT_AGENTSMD > $C/AGENTS.md
tok C CHILD_AGENTSMD > $C/child/AGENTS.md
gi $C
# arm d: stray CLAUDE.md in an ancestor ABOVE the git root; project has only AGENTS.md.
D=$R/d; mkdir -p $D/repo
tok D ANCESTOR_CLAUDEMD > $D/CLAUDE.md
tok D AGENTSMD > $D/repo/AGENTS.md
gi $D/repo
echo "fixture at $R: cwd a=$P b=$B c=$C/child"
