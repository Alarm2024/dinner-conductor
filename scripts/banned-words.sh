#!/bin/sh
# Fails when a banned word appears in public text paths.
# "read-only" is the one allowed use of the second word in the list.
set -u
cd "$(dirname "$0")/.."
paths="README.md FRICTION.md sim src tests"
existing=""
for p in $paths; do
  if [ -e "$p" ]; then
    existing="$existing $p"
  fi
done
hits=$(grep -rniwE 'audit|profit|trading|guaranteed?|only|launched|live' $existing 2>/dev/null | grep -vi 'read-only' || true)
if [ -n "$hits" ]; then
  echo "$hits"
  echo "banned words found"
  exit 1
fi
echo "banned words: none"
