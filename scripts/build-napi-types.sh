#!/usr/bin/env bash
# Regenerate src/native/generated.d.ts from the Rust.
#
# One crate at a time on purpose: napi-derive APPENDS to TYPE_DEF_TMP_PATH while
# cargo compiles, and a parallel build interleaves the writes — definitions go
# missing, silently, and the generated file comes out short.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

CRATES=(ream-events-napi ream-http-napi ream-scheduler-napi)
combined="$(mktemp)"
one="$(mktemp)"
trap 'rm -f "$combined" "$one"' EXIT

for crate in "${CRATES[@]}"; do
  : > "$one"
  TYPE_DEF_TMP_PATH="$one" cargo build -p "$crate" >/dev/null
  count=$(wc -l < "$one")
  if [ "$count" -eq 0 ]; then
    echo "[napi-types] $crate emitted nothing — is napi-derive's \"type-def\" feature on?" >&2
    exit 1
  fi
  cat "$one" >> "$combined"
done

node scripts/generate-napi-types.mjs "$combined" src/native/generated.d.ts

# Formatted here rather than excluded from the linter: the file is checked in,
# so it should read like the rest of the tree — and formatting it at generation
# means it never shows up as a diff someone has to fix by hand.
../../node_modules/.bin/biome format --write src/native/generated.d.ts >/dev/null
