#!/usr/bin/env bash
# Syncs the Windows project into WSL's ext4 filesystem and runs snforge.
set -euo pipefail

export PATH="/home/user_realz/.local/bin:/home/user_realz/.cargo/bin:$PATH"

SRC="/mnt/c/Users/USER/demi the builder/gate-account"
RUN="/home/user_realz/gate-account-run"

mkdir -p "$RUN"
rm -rf "$RUN/src" "$RUN/tests"
cp -r "$SRC/src" "$SRC/tests" "$RUN/"
cp "$SRC/Scarb.toml" "$SRC/Scarb.lock" "$RUN/"

cd "$RUN"
exec snforge test "$@"
