#!/usr/bin/env bash
# Wrapper: syncs the project into WSL's ext4 filesystem, puts the toolchain on PATH,
# and runs sncast against Sepolia.
#
#   wsl -d Ubuntu -- bash "/mnt/c/Users/USER/demi the builder/gate-account/scripts/snc.sh" \
#       --account gate_deployer declare --contract-name GateAccount
#
# Two sncast 0.64 CLI traps this hides:
#   - `--network` / `--url` are SUBCOMMAND flags -> appended last.
#   - `--account` / `--wait` / `--json` are GLOBAL -> pass them before the subcommand.
# Building on /mnt/c is an order of magnitude slower, so sources are copied first.
set -euo pipefail

export PATH="/home/user_realz/.local/bin:/home/user_realz/.cargo/bin:$PATH"

SRC="/mnt/c/Users/USER/demi the builder/gate-account"
RUN="/home/user_realz/gate-account-run"
LOCK="/home/user_realz/.gate-account-sync.lock"

# Serialise the sync: two parallel invocations otherwise race on rm -rf/cp.
# The lock is released when the subshell exits, before sncast runs.
(
  flock 9
  mkdir -p "$RUN"
  rm -rf "$RUN/src" "$RUN/tests"
  cp -r "$SRC/src" "$RUN/"
  [ -d "$SRC/tests" ] && cp -r "$SRC/tests" "$RUN/"
  cp "$SRC/Scarb.toml" "$RUN/"
  [ -f "$SRC/Scarb.lock" ] && cp "$SRC/Scarb.lock" "$RUN/"
) 9>"$LOCK"

cd "$RUN"
exec sncast "$@" --network sepolia
