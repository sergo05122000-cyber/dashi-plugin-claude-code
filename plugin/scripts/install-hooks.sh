#!/usr/bin/env bash
# Install Claude Code hooks that route stdin to the dashi-channel plugin's
# webhook. Operator passes the per-agent settings.json explicitly — no
# auto-discovery of ~/.claude/settings.json.
#
# Usage:
#   scripts/install-hooks.sh \
#     --settings /path/to/agent/settings.json \
#     --chat-id 164795011 \
#     --webhook-url http://127.0.0.1:8089/hooks/agent \
#     [--agent-id dashi-channel]
#
# Hard rules:
#   * The bearer token (TELEGRAM_WEBHOOK_TOKEN) is NEVER written to
#     settings.json — operator exports it in the agent's runtime env.
#   * Idempotent: re-running the same command replaces the previous entry
#     rather than duplicating it (stable marker = "dashi-channel-hook").

set -euo pipefail

SETTINGS=""
CHAT_ID=""
WEBHOOK_URL=""
AGENT_ID=""
HELPER=""

while [ $# -gt 0 ]; do
  case "$1" in
    --settings)
      SETTINGS="$2"; shift 2;;
    --chat-id)
      CHAT_ID="$2"; shift 2;;
    --webhook-url)
      WEBHOOK_URL="$2"; shift 2;;
    --agent-id)
      AGENT_ID="$2"; shift 2;;
    --helper)
      HELPER="$2"; shift 2;;
    -h|--help)
      sed -n 's/^# \{0,1\}//p' "$0" | head -n 18
      exit 0;;
    *)
      echo "install-hooks.sh: unknown arg '$1'" >&2
      exit 2;;
  esac
done

if [ -z "$SETTINGS" ] || [ -z "$CHAT_ID" ] || [ -z "$WEBHOOK_URL" ]; then
  echo "install-hooks.sh: --settings, --chat-id, --webhook-url are required" >&2
  exit 2
fi

# Reject non-http(s) URLs — a typo'd `file:///etc/passwd` or `javascript:`
# would otherwise be written into settings.json and become a hook command
# (review L3). The post-hook.ts helper uses fetch() which refuses file://
# anyway, but stop the bad value at install time so settings.json never
# carries it.
if [[ ! "$WEBHOOK_URL" =~ ^https?:// ]]; then
  echo "install-hooks.sh: --webhook-url must start with http:// or https:// (got '$WEBHOOK_URL')" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PATCH_TS="$SCRIPT_DIR/patch-claude-settings.ts"

if [ ! -f "$PATCH_TS" ]; then
  echo "install-hooks.sh: missing helper '$PATCH_TS'" >&2
  exit 3
fi

if [ -z "$HELPER" ]; then
  HELPER="$SCRIPT_DIR/post-hook.ts"
fi

# Build arg array so paths with spaces survive intact.
ARGS=(
  "$PATCH_TS"
  --settings "$SETTINGS"
  --chat-id "$CHAT_ID"
  --webhook-url "$WEBHOOK_URL"
  --helper "$HELPER"
)
if [ -n "$AGENT_ID" ]; then
  ARGS+=(--agent-id "$AGENT_ID")
fi

# Ensure the parent dir exists so `bun` can write the file atomically.
mkdir -p "$(dirname "$SETTINGS")"

bun "${ARGS[@]}"

echo "install-hooks.sh: patched $SETTINGS" >&2
