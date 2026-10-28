#!/usr/bin/env bash
# Minimal Rust toolchain — needed because Scarb builds the snforge plugin from source on Linux.
set -euo pipefail

HOME_DIR="/home/user_realz"
export HOME="$HOME_DIR"
export CARGO_HOME="$HOME_DIR/.cargo"
export RUSTUP_HOME="$HOME_DIR/.rustup"

if [ ! -x "$CARGO_HOME/bin/cargo" ]; then
  curl -sSf https://sh.rustup.rs -o /tmp/rustup.sh
  sh /tmp/rustup.sh -y --profile minimal --no-modify-path
fi

if ! grep -q '.cargo/bin' "$HOME_DIR/.bashrc" 2>/dev/null; then
  printf '\nexport PATH="$HOME/.cargo/bin:$PATH"\n' >> "$HOME_DIR/.bashrc"
fi

"$CARGO_HOME/bin/cargo" --version
