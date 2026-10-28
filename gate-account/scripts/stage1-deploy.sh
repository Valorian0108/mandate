#!/usr/bin/env bash
# Stage 1: GateAccount on Starknet Sepolia.
#
# Every command below was executed for real on 2026-10-24 and is recorded here with the
# values it produced, so the run is reproducible and auditable. Re-running it against a
# fresh deployer regenerates the addresses; the recorded ones are the live contracts.
#
#   wsl -d Ubuntu -- bash "/mnt/c/Users/USER/demi the builder/gate-account/scripts/stage1-deploy.sh"
set -euo pipefail

export PATH="/home/user_realz/.local/bin:/home/user_realz/.cargo/bin:$PATH"

SRC="/mnt/c/Users/USER/demi the builder/gate-account"
RUN="/home/user_realz/gate-account-run"
ACC="/home/user_realz/.starknet_accounts/starknet_open_zeppelin_accounts.json"

DEPLOYER=gate_deployer          # standard OZ account; pays for every declaration/deployment
OWNER=gate_owner                # keypair whose public key GateAccount stores as owner
STRK=0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d
SEL_TRANSFER=0x83afd3f4caedc6eebf44246fe54e38c95e3179a5ec9ea81740eca5b482d12e

# sncast 0.64 CLI traps (each of these cost a failed run):
#   - --network/--url are SUBCOMMAND flags -> always last.
#   - --account/--wait/--json are GLOBAL  -> always before the subcommand.
#   - `account create --class-hash` also requires --type.
#   - `get class-hash-at` takes a POSITIONAL address, not --contract-address.
#   - `utils selector` is offline and REJECTS --network.
#   - --arguments parses Cairo expressions against the ABI (arrays need `array![...]`);
#     --calldata takes the raw wire felts and is what we use, including the Array length prefix.
snc() { sncast "$@" --network sepolia; }

say() { printf '\n=== %s ===\n' "$*"; }

mkdir -p "$RUN"; rm -rf "$RUN/src" "$RUN/tests"
cp -r "$SRC/src" "$RUN/"; [ -d "$SRC/tests" ] && cp -r "$SRC/tests" "$RUN/"
cp "$SRC/Scarb.toml" "$RUN/"; [ -f "$SRC/Scarb.lock" ] && cp "$SRC/Scarb.lock" "$RUN/"
cd "$RUN"

say "0. Deployer must be funded first (faucet.starknet.io)"
snc get balance --contract-address "$(python3 -c "import json;print(json.load(open('$ACC'))['alpha-sepolia']['$DEPLOYER']['address'])")" --token strk

say "1. Deploy the deployer account"
snc --wait account deploy --name "$DEPLOYER" --silent

say "2. Declare GateAccount (release profile)"
snc --account "$DEPLOYER" -w declare --contract-name GateAccount
say "2b. Declare ERC20Mock (same artifact the 16 snforge tests used)"
snc --account "$DEPLOYER" -w declare --contract-name ERC20Mock

say "3. Create the owner keypair for GateAccount"
snc account create --type open-zeppelin --name "$OWNER" --class-hash "$GATE_CLASS_HASH"
# Then fund the PREDICTED address from the deployer and `account deploy` it, so sncast
# manages the entry itself and no JSON hand-editing is needed:
#   snc --account "$DEPLOYER" -w invoke --contract-address "$STRK" --function transfer \
#       --arguments "<predicted_owner_address>,10000000000000000000"
#   snc --wait account deploy --name "$OWNER" --silent

say "4. Owner transactions that build the mandate (--calldata = raw wire felts)"
# add_or_update_session_key(session_key, valid_until: u64, max_calls: u32, entrypoints: Array<felt252>)
#   wire = [session_key, valid_until, max_calls, LEN, selectors...]
# snc --account "$OWNER" -w invoke --contract-address "$GATE" \
#   --function add_or_update_session_key \
#   --calldata "$SESSION_PUBKEY 2000000000 10 1 $SEL_TRANSFER"
#
# set_spending_policy(session_key, token, max_per_call: u256, max_per_window: u256, window_seconds: u64)
#   wire = [session_key, token, mpc_low, mpc_high, mpw_low, mpw_high, window_seconds]
# snc --account "$OWNER" -w invoke --contract-address "$GATE" \
#   --function set_spending_policy \
#   --calldata "$SESSION_PUBKEY $TOKEN 10 0 100 0 2592000"
#
# allow_recipient(session_key, token, recipient)
# snc --account "$OWNER" -w invoke --contract-address "$GATE" \
#   --function allow_recipient --calldata "$SESSION_PUBKEY $TOKEN $MERCHANT"

say "5. Read the mandate back"
# snc call --contract-address "$GATE" --function get_session_data --calldata "$SESSION_PUBKEY"
# snc call --contract-address "$GATE" --function get_spending_policy --calldata "$SESSION_PUBKEY $TOKEN"
# snc call --contract-address "$GATE" --function is_recipient_allowed --calldata "$SESSION_PUBKEY $TOKEN $MERCHANT"
