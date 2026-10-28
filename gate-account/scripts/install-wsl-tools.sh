#!/usr/bin/env bash
# Installs Scarb 2.21.0 + Starknet Foundry 0.64.1 into ~/.local/bin (no sudo needed).
set -euo pipefail

HOME_DIR="/home/user_realz"
LOCAL="$HOME_DIR/.local"
TARBALLS="/tmp"

mkdir -p "$TARBALLS"
if [ ! -f "$TARBALLS/scarb.tar.gz" ]; then
  echo "downloading scarb..."
  curl -sSL -o "$TARBALLS/scarb.tar.gz" \
    https://github.com/software-mansion/scarb/releases/download/v2.21.0/scarb-v2.21.0-x86_64-unknown-linux-gnu.tar.gz
fi

if [ ! -x "$LOCAL/scarb-v2.21.0-x86_64-unknown-linux-gnu/bin/scarb" ]; then
  echo "extracting scarb..."
  tar -xzf "$TARBALLS/scarb.tar.gz" -C "$LOCAL"
fi

if [ ! -x "$LOCAL/starknet-foundry-v0.64.1-x86_64-unknown-linux-gnu/bin/snforge" ]; then
  if [ ! -f "$TARBALLS/snforge.tar.gz" ]; then
    echo "downloading starknet-foundry..."
    curl -sSL -o "$TARBALLS/snforge.tar.gz" \
      https://github.com/foundry-rs/starknet-foundry/releases/download/v0.64.1/starknet-foundry-v0.64.1-x86_64-unknown-linux-gnu.tar.gz
  fi
  echo "extracting starknet-foundry..."
  tar -xzf "$TARBALLS/snforge.tar.gz" -C "$LOCAL"
fi

USC_DIR="$LOCAL/universal-sierra-compiler-v2.10.3-x86_64-unknown-linux-gnu"
if [ ! -d "$USC_DIR" ]; then
  if [ ! -f "$TARBALLS/usc.tar.gz" ]; then
    echo "downloading universal-sierra-compiler..."
    curl -sSL -o "$TARBALLS/usc.tar.gz" \
      https://github.com/software-mansion/universal-sierra-compiler/releases/download/v2.10.3/universal-sierra-compiler-v2.10.3-x86_64-unknown-linux-gnu.tar.gz
  fi
  echo "extracting universal-sierra-compiler..."
  tar -xzf "$TARBALLS/usc.tar.gz" -C "$LOCAL"
fi

mkdir -p "$LOCAL/bin"
USC_BIN="$(find "$USC_DIR" -maxdepth 2 -type f -name universal-sierra-compiler | head -1)"
ln -sf "$USC_BIN" "$LOCAL/bin/universal-sierra-compiler"
ln -sf "$LOCAL/scarb-v2.21.0-x86_64-unknown-linux-gnu/bin/scarb" "$LOCAL/bin/scarb"
ln -sf "$LOCAL/starknet-foundry-v0.64.1-x86_64-unknown-linux-gnu/bin/snforge" "$LOCAL/bin/snforge"
ln -sf "$LOCAL/starknet-foundry-v0.64.1-x86_64-unknown-linux-gnu/bin/sncast" "$LOCAL/bin/sncast"

if ! grep -q 'user_realz/.local/bin' "$HOME_DIR/.bashrc" 2>/dev/null; then
  printf '\nexport PATH="$HOME/.local/bin:$PATH"\n' >> "$HOME_DIR/.bashrc"
fi

export PATH="$LOCAL/bin:$PATH"
echo "--- versions ---"
scarb --version
snforge --version
sncast --version
echo "--- done ---"
