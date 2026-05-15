# Canary Telegram smoke bot status

Recorded on 2026-05-14 PDT after the operator approved live testing with a separate canary Telegram bot token.

## Current migration stage

The migration is in the canary runtime smoke-test stage.

Implemented and verified:

- repo-local canary supervisor scaffold: `scripts/dashi-channel-supervisor`;
- repo-local Telegram canary smoke runner: `scripts/dashi-telegram-canary-bot`;
- canary token stored outside git under the local runtime secret path;
- `tmux` session `orgrimmar-canary` started for the canary runner;
- Telegram API smoke poll succeeded before the tmux start;
- production token files, launchd jobs, gateway config, and production tmux sessions remain untouched.

Still not complete:

- Claude Code channel CLI syntax is not confirmed locally;
- the canary smoke runner is not the final Claude channel plugin;
- no production agent has been cut over;
- billing classification, permission relay, parity, and rollback evidence remain open.

## Running canary process

The canary runner is launched in tmux with the token read only from the secret file:

```bash
tmux new-session -d -s orgrimmar-canary 'cd /Users/jasonqwwen/qwwiwi-channel-telegram-Claude-code && DASHI_CHANNEL_RUNTIME_ROOT=/Users/jasonqwwen/.claude-lab/shared/channel-runtime PYTHONUNBUFFERED=1 scripts/dashi-telegram-canary-bot --poll-timeout 20 >> /Users/jasonqwwen/.claude-lab/shared/channel-runtime/canary/logs/stdout.log 2>> /Users/jasonqwwen/.claude-lab/shared/channel-runtime/canary/logs/stderr.log'
```

The command line does not contain the token value.

## Operator test

Send any message to the separate canary Telegram bot. Expected reply:

```text
dashi canary ack: message received at <timestamp>
```

This only proves Telegram token, long polling, `sendMessage`, tmux persistence, and local runtime paths. It does not prove Claude Code channel integration yet.

## Inspection commands

```bash
DASHI_CHANNEL_RUNTIME_ROOT=/Users/jasonqwwen/.claude-lab/shared/channel-runtime scripts/dashi-channel-supervisor status canary --json
DASHI_CHANNEL_RUNTIME_ROOT=/Users/jasonqwwen/.claude-lab/shared/channel-runtime scripts/dashi-channel-supervisor logs canary
tail -n 20 /Users/jasonqwwen/.claude-lab/shared/channel-runtime/canary/logs/stdout.log
tail -n 20 /Users/jasonqwwen/.claude-lab/shared/channel-runtime/canary/logs/stderr.log
```

In Codex sandboxed shells, direct `tmux ls` may fail with `Operation not permitted`. Run it with host-level permission when checking the live tmux socket.

## Stop command

```bash
tmux kill-session -t orgrimmar-canary
```

Use this only for the canary tmux session. It does not affect production launchd jobs or production Telegram consumers.
