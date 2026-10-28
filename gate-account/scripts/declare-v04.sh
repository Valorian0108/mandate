#!/usr/bin/env bash
# v0.4 declare: publish the controller-or-self guard class on Starknet Sepolia.
#
# House pattern from stage1-deploy.sh (same traps, same run dir): copy src into a
# WSL-native directory (/mnt/c is slow and scarb's git deps resolve there), then
# declare with the gas-only deployer account. sncast defaults to the RELEASE
# profile (the state.json note); the DEV profile was proven separately by
# `snforge test` - 48/48 including the new t39/t40/t41 v0.4 pins.
#
#   wsl -d Ubuntu -- bash "/mnt/c/Users/USER/demi the builder/gate-account/scripts/declare-v04.sh"
#
# Output of interest (last lines): transaction_hash + class_hash. The class hash
# is recorded in .sepolia/state.json as pending_upgrade; the upgrade itself is an
# OWNER-signed action through the console (deployer never touches ownership).
set -euo pipefail
export PATH="/home/user_realz/.local/bin:/home/user_realz/.cargo/bin:$PATH"

SRC="/mnt/c/Users/USER/demi the builder/gate-account"
RUN="/home/user_realz/gate-account-run"
ACC="/home/user_realz/.starknet_accounts/starknet_open_zeppelin_accounts.json"
DEPLOYER=gate_deployer   # gas-only infra key; pays the declare fee, nothing else

printf '\n=== 0. Deployer STRK balance (declare costs ~0.01-0.1) ===\n'
DEPLOYER_ADDR=$(python3 -c "import json;print(json.load(open('$ACC'))['alpha-sepolia']['$DEPLOYER']['address'])")
sncast get balance --contract-address "$DEPLOYER_ADDR" --token strk --network sepolia

mkdir -p "$RUN"; rm -rf "$RUN/src" "$RUN/tests"
cp -r "$SRC/src" "$RUN/"
cp "$SRC/Scarb.toml" "$RUN/"
[ -f "$SRC/Scarb.lock" ] && cp "$SRC/Scarb.lock" "$RUN/"
cd "$RUN"

printf '\n=== 1. Declare GateAccount v0.4 (release profile, deployer pays) ===\n'
# sncast CLI traps (stage1-deploy.sh): --account/--wait are GLOBAL (before the
# subcommand), --network is a SUBCOMMAND flag (always last).
# The printed class_hash + transaction_hash ARE the authoritative output; they go
# into .sepolia/state.json as pending_upgrade. On-chain proof that the upgrade
# landed comes later from starknet_getClassHashAt on the gate itself.
sncast --account "$DEPLOYER" -w declare --contract-name GateAccount --network sepolia
