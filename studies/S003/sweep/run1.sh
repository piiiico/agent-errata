#!/bin/bash
# run1.sh <harness> <arm a|b|c> <port> -- command...   (runs in arm cwd, HOME=scratch, env CAP=http://127.0.0.1:<port>)
S=${S003_SWEEP:-$(cd "$(dirname "$0")" && pwd)/work}; mkdir -p $S; SRC=$(cd "$(dirname "$0")" && pwd)
H=$1; ARM=$2; PORT=$3; shift 4
FX=/tmp/s003fx/$H; OUT=$S/caps/$H/$ARM
[ "$ARM" = a ] && [ -z "$KEEPFX" ] && bash $SRC/fixture.sh $FX >/dev/null
rm -rf $OUT; mkdir -p $OUT
case $ARM in a) CWD=$FX/a/parent/repo;; b) CWD=$FX/b/repo;; c) CWD=$FX/c/mono/child;; d) CWD=$FX/d/repo;; esac
export HOME=$S/home/$H; mkdir -p $HOME
export CAP=http://127.0.0.1:$PORT
PORT=$PORT OUT=$OUT bun $SRC/cap.ts > $OUT/cap.stdout 2>&1 & CP=$!
sleep 0.7
export PROMPT="Without using any tools, list every token starting with S003C- in your instructions or context, with where it appears. If you see none, say NONE."
cd $CWD && timeout ${TMO:-150} "$@" > $OUT/harness.stdout 2> $OUT/harness.stderr < /dev/null; echo "exit=$?" > $OUT/exit
kill $CP 2>/dev/null; wait $CP 2>/dev/null
bun $SRC/score.ts $OUT
