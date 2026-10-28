#!/usr/bin/env bash
# Reads the full mandate back off Sepolia and checks the deny-by-default behaviour on a
# live network (not a simulation): a merchant that was never listed must read as denied.
#
#   wsl -d Ubuntu -- bash "/mnt/c/Users/USER/demi the builder/gate-account/scripts/verify-mandate.sh"
set -euo pipefail
export PATH="/home/user_realz/.local/bin:/home/user_realz/.cargo/bin:$PATH"

GATE=0x2502f82a773faa4bc2cec186dc2fca432fa36c22138f977ac5307ce74673d25
TOKEN=0x01f51d5179be8f437eddbcce8ece762d780ab2940e10cc6750c33fa9201494dd
SESSION=0x100d2c0e1428a218c21fbbdb88aa30570674e17a79003f39e62a08115806185
MERCHANT=0x079e0a000fc86b5e2b157b4e5bc2e2deee93499141f84c4214c30362bd55cf38
STRANGER=0x16cb41ec11efcc9129d858ae07449f4f1a31d7d292269a5e7c40cd4d33db371

snc() { sncast "$@" --network sepolia; }
show() { printf '\n--- %s ---\n' "$*"; }

show "owner key stored in the account"
snc call --contract-address "$GATE" --function get_public_key | grep -E 'Response:'

show "session granted to the agent"
snc call --contract-address "$GATE" --function get_session_data --calldata "$SESSION" | grep -E 'Response:'

show "spending policy for (session, token)"
snc call --contract-address "$GATE" --function get_spending_policy --calldata "$SESSION $TOKEN" | grep -E 'Response:'

show "listed merchant -> must be true"
snc call --contract-address "$GATE" --function is_recipient_allowed --calldata "$SESSION $TOKEN $MERCHANT" | grep -E 'Response'

show "UNLISTED address -> must be false (deny by default, on a live network)"
snc call --contract-address "$GATE" --function is_recipient_allowed --calldata "$SESSION $TOKEN $STRANGER" | grep -E 'Response'

show "token balance held by the account"
snc call --contract-address "$TOKEN" --function balance_of --calldata "$GATE" | grep -E 'Response:'

show "SRC-5: does it advertise ISRC6?"
# Authoritative value, copied from OZ cairo-contracts v4.0.1
# packages/interfaces/src/account/accounts.cairo:  pub const ISRC6_ID: felt252 = ...
# (Do not trust a remembered constant here - the first version of this script had one wrong
#  in its 9th hex digit, which would have read as "the account does not support ISRC6".)
ISRC6_ID=0x2ceccef7f994940b3962a6c67e0ba4fcd37df7d131417c604f91e03caecc1cd
snc call --contract-address "$GATE" --function supports_interface \
  --calldata "$ISRC6_ID" | grep -E 'Response'
