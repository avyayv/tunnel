#!/usr/bin/env bash
set -euo pipefail

REPO_URL="https://github.com/avyayv/tunnel.git"
INSTALL_DIR="${TUNNEL_INSTALL_DIR:-${HOME}/.local/share/tunnel}"
BIN_DIR="${TUNNEL_BIN_DIR:-${HOME}/.local/bin}"
LINK="${BIN_DIR}/tunnel"

for dependency in git bun; do
  if ! command -v "$dependency" >/dev/null 2>&1; then
    printf 'tunnel: %s is required; install it and retry\n' "$dependency" >&2
    exit 1
  fi
done

mkdir -p "$BIN_DIR" "$(dirname "$INSTALL_DIR")"
if [ -e "$INSTALL_DIR/.git" ]; then
  git -C "$INSTALL_DIR" pull --ff-only
elif [ -e "$INSTALL_DIR" ]; then
  printf 'tunnel: install path exists and is not a tunnel checkout: %s\n' "$INSTALL_DIR" >&2
  exit 1
else
  git clone "$REPO_URL" "$INSTALL_DIR"
fi

if [ -e "$LINK" ] || [ -L "$LINK" ]; then
  if [ -L "$LINK" ] && [ "$(readlink "$LINK")" = "$INSTALL_DIR/cli.ts" ]; then
    :
  else
    printf 'tunnel: refusing to replace existing path: %s\n' "$LINK" >&2
    exit 1
  fi
else
  ln -s "$INSTALL_DIR/cli.ts" "$LINK"
fi

printf 'Installed tunnel at %s\n' "$LINK"
case ":${PATH}:" in
  *":${BIN_DIR}:"*) ;;
  *) printf 'Add %s to your PATH (for example: export PATH="%s:$PATH")\n' "$BIN_DIR" "$BIN_DIR" ;;
esac
