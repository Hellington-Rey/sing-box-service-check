#!/bin/sh
# Copy user configuration from installations before the package rename.
set -eu
prefix="${SBSC_MIGRATE_ROOT:-}"
old="$prefix/etc/forkop-servicecheck"
new="$prefix/etc/sing-box-service-check"
[ -d "$old" ] || exit 0
mkdir -p "$new"
for source in "$old"/*; do
    [ -f "$source" ] && [ ! -L "$source" ] || continue
    target="$new/${source##*/}"
    [ -e "$target" ] || cp -p "$source" "$target"
done
[ ! -f "$new/gemini_api_key" ] || chmod 0600 "$new/gemini_api_key"
