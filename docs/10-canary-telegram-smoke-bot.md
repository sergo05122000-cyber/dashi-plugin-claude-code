# Canary Telegram bot status

Recorded on 2026-05-14 PDT after the operator approved live testing with a separate canary Telegram bot token. Updated during the real-reply continuation.

## Current migration stage

The migration is in the canary runtime smoke-test stage with a repo-local fallback bridge implemented.

Implemented and verified:

- repo-local canary supervisor scaffold: `scripts/dashi-channel-supervisor`;
- repo-local Telegram canary smoke runner: `scripts/dashi-telegram-canary-bot`;
- canary-only Claude fallback mode: `scripts/dashi-telegram-canary-bot --reply-mode claude`;
- canary token stored outside git under the local runtime secret path;
- `tmux` session `orgrimmar-canary` started for the canary runner;
- Telegram API smoke poll succeeded before the tmux start;
- production token files, launchd jobs, gateway config, and production tmux sessions remain untouched.

Still not complete:

- the true Claude Code channel path is not running;
- channel flags are hidden from `claude --help`; parser probes accept `--channels` and `--dangerously-load-development-channels`, but live channel startup cannot be proven from this sandbox;
- `claude auth status` reports not logged in in this sandbox, so `claude --print` fallback calls cannot produce model replies here;
- the default tmux socket is not reachable from this sandbox, so the existing ACK poller cannot be stopped/replaced here;
- the fallback bridge is not the final billing-safe Claude channel plugin;
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

## Canary-only Claude fallback bridge

The fallback bridge is implemented for canary testing only. It calls Claude Code through:

```bash
claude --print --max-budget-usd 0.05 -- '<redacted prompt built from the Telegram message>'
```

The command is invoked with an argument list, not through a shell, and the Telegram token is read only from the canary secret file. If Claude is unavailable, the bot sends a redacted `Claude fallback unavailable` message instead of an ACK.

Do not start this while the existing ACK poller may still own the canary token. The safe host-level replacement sequence is:

```bash
tmux kill-session -t orgrimmar-canary
tmux new-session -d -s orgrimmar-canary 'cd /Users/jasonqwwen/qwwiwi-channel-telegram-Claude-code && DASHI_CHANNEL_RUNTIME_ROOT=/Users/jasonqwwen/.claude-lab/shared/channel-runtime PYTHONUNBUFFERED=1 scripts/dashi-telegram-canary-bot --reply-mode claude --poll-timeout 20 >> /Users/jasonqwwen/.claude-lab/shared/channel-runtime/canary/logs/stdout.log 2>> /Users/jasonqwwen/.claude-lab/shared/channel-runtime/canary/logs/stderr.log'
```

Before using that replacement command, verify on the host:

```bash
claude auth status
tmux ls
```

In this Codex sandbox, `claude auth status` reported `loggedIn: false` and `tmux ls` failed with `Operation not permitted`, so the replacement was not launched here.

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
