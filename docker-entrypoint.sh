#!/usr/bin/env sh
set -eu

export PATH="${HOME:-/root}/.local/bin:$PATH"

if [ -z "${CURSOR_AGENT_EXECUTABLE:-}" ]; then
  if command -v cursor-agent >/dev/null 2>&1; then
    export CURSOR_AGENT_EXECUTABLE="$(command -v cursor-agent)"
  elif command -v agent >/dev/null 2>&1; then
    export CURSOR_AGENT_EXECUTABLE="$(command -v agent)"
  fi
fi

if [ "$#" -eq 0 ]; then
  set -- serve
fi

case "$1" in
  -*)
    set -- serve "$@"
    ;;
esac

case "$1" in
  serve|server)
    shift
    exec node dist/server/main.js "$@"
    ;;
  cursor-agent|agent)
    exec "$@"
    ;;
  login|logout|status|whoami|models|about|update)
    exec "${CURSOR_AGENT_EXECUTABLE:-cursor-agent}" "$@"
    ;;
  *)
    exec "$@"
    ;;
esac
