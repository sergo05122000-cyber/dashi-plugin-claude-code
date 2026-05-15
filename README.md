# qwwiwi-channel-telegram-Claude-code

Custom Claude Code **channel plugin** для Telegram — миграция Orgrimmar agents с Python `claude -p` gateway на channel-pattern до **15 июня 2026**.

## TL;DR

С 2026-06-15 Anthropic разделяет биллинг: `claude -p` и Agent SDK уходят в отдельный $200/мес pool. Текущий Jarvis Gateway спавнит `claude -p` на каждый Telegram-turn → весь трафик 5 агентов утечёт в SDK pool.

Решение: MCP-плагин с capability `claude/channel`, который пушит Telegram events в живую interactive-сессию Claude Code. Сессия классифицируется как interactive → остаётся в Max subscription.

Параллельно: Anthropic-зависимые кроны (reflection summary, weekly digest и т.д.) переезжают на Tyrande / Hermes / MiniMax M2.7 — zero Anthropic dependency.

## Status (2026-05-15)

**Плагин готов, осталась production cutover.**

| Фаза | PR | Что вошло |
|------|----|-----------|
| Phase 1–6 | [#1](https://github.com/qwwiwi/qwwiwi-channel-telegram-Claude-code/pull/1) ✅ merged | Bun MCP channel plugin, port от gateway.py: inbound text/voice/media/albums, OOB commands (`/help`, `/status`, `/stop`, `/reset`, `/new`), status ticker, webhook scaffold, permission relay, anti-spoof gates, `--dangerously-skip-permissions` parity |
| Phase 7 | [#2](https://github.com/qwwiwi/qwwiwi-channel-telegram-Claude-code/pull/2) ✅ merged | Jarvis-parity hooks: PreToolUse/PostToolUse/Stop/UserPromptSubmit/SessionStart → Telegram статус-сообщение с rolling 5-call `<pre>` блоком инструментов + гуманизацией (Bash → «calling API», git → «git command») + маскировкой секретов |
| Phase 8 | [#3](https://github.com/qwwiwi/qwwiwi-channel-telegram-Claude-code/pull/3) ✅ merged | Memory hooks parity: после Stop hook плагин пишет 200-char summary в `<workspace>/core/hot/recent.md` + полный turn record в `<workspace_parent>/logs/verbose-YYYY-MM-DD.jsonl` (Cognee cron подхватывает) |
| Phase 9 | pending | **Production cutover** — 5 launchd plists `ai.orgrimmar.channel.{silvana,kaelthas,garrosh,claude,arthas}`, per-agent токены, остановка legacy `ai.orgrimmar.gateway` (Python), smoke 5 ботов, rollback plan. RED-операция, требует явный prince approval |

**Tests:** 425 pass / 0 fail / 2150 expect() across 27 files. `tsc --noEmit` clean (strict + exactOptionalPropertyTypes + noUncheckedIndexedAccess).

**Canary бот:** `@testmyfirsttmuxbot` (id `8507713167`) — для smoke-test против тестового workspace. Production токены не трогаем до cutover.

## Документация

| Док | Содержание |
|-----|-----------|
| [docs/01-context.md](docs/01-context.md) | Зачем переезд, что меняется у Anthropic, цель |
| [docs/02-architecture.md](docs/02-architecture.md) | Текущая vs целевая архитектура, capabilities, loop guards |
| [docs/03-plan.md](docs/03-plan.md) | Pre-flight + Phase 0–5 + Phase A–C + таймлайн до 15.06 |
| [docs/04-codex-review.md](docs/04-codex-review.md) | Codex GPT-5.5 ревью: 6 правок до старта |
| [docs/05-success-criteria.md](docs/05-success-criteria.md) | 8 чеков перед D-day + rollback strategy |
| [docs/06-tmux-migration-goal-plan.md](docs/06-tmux-migration-goal-plan.md) | Архивный tmux-first goal plan (ушли в чистый channel plugin, без tmux supervisor) |
| [docs/07-runtime-baseline-and-canary-runbook.md](docs/07-runtime-baseline-and-canary-runbook.md) | Local runtime baseline + safe tmux/channel canary gates |
| [docs/08-dashi-channel-supervisor-spec.md](docs/08-dashi-channel-supervisor-spec.md) | `dashi-channel-supervisor` command contract, state layout, safety gates |
| [docs/09-canary-supervisor-execution-log.md](docs/09-canary-supervisor-execution-log.md) | Canary-only supervisor scaffold execution log |
| [docs/10-canary-telegram-smoke-bot.md](docs/10-canary-telegram-smoke-bot.md) | Live canary Telegram smoke bot status |
| [plugin/docs/canary-smoke.md](plugin/docs/canary-smoke.md) | 15-row smoke matrix против `@testmyfirsttmuxbot` |

## Презентации (HTML)

| Файл | Назначение |
|------|------------|
| [artifacts/jarvis-channel-migration.html](artifacts/jarvis-channel-migration.html) | Первая версия — концепция, почему остаёмся на Max |
| [artifacts/jarvis-channel-action-plan.html](artifacts/jarvis-channel-action-plan.html) | Промежуточный план — Phase 1–5 + Phase A–C |
| [artifacts/jarvis-channel-action-plan-v2.html](artifacts/jarvis-channel-action-plan-v2.html) | Финальный план после Codex review — с Phase 0 канарейкой |

## What's done vs what's left

✅ **Done (через 3 merged PR):**
- Full plugin port от Python gateway.py (inbound, OOB, voice, media, albums, status, permissions, anti-spoof)
- Jarvis-parity hook integration (tool calls + reasoning видны в Telegram статусе)
- Memory parity (recent.md + verbose.jsonl writers — Cognee cron работает без изменений)
- Dual-model code review (Codex GPT-5.5 + Opus параллельно) на каждой фазе
- 425 tests passing, strict TypeScript clean
- Loop-coding runs архивированы в `.claude-lab/silvana/.claude/loop-coding-runs/`

⏸ **Pending (Phase 9, отдельный run с prince approval):**
- Per-agent токены (5 ботов: Silvana, Kaelthas, Garrosh, Claude, Arthas)
- 5 launchd plists `ai.orgrimmar.channel.{agent}.plist`
- Per-agent state-dirs + workspace mapping
- Smoke 5 ботов по [plugin/docs/canary-smoke.md](plugin/docs/canary-smoke.md)
- Stop legacy `ai.orgrimmar.gateway` (Python daemon)
- Rollback plan обратно на gateway.py
- Anthropic Max billing verification: 5 параллельных Claude Code сессий укладываются в подписку до 2026-06-15

📋 **Followups (после cutover):**
- Phase A — inventory кронов с Anthropic зависимостью + миграция на Tyrande/Hermes
- Phase B — pilot reflection summary через MiniMax M2.7
- Phase C — миграция остальных Anthropic-зависимых кронов

## Stack

- Bun 1.3.14 / TypeScript strict (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `noImplicitAny`)
- `@modelcontextprotocol/sdk` (Channels API v2.1.80+)
- Telegram Bot API через grammY
- launchd (Mac mini) — per-agent plist per cutover
- Tyrande / Hermes на 165.245.219.131 (MiniMax M2.7) — для крон-нагрузки без Anthropic

## Related repos

- [qwwiwi/gateway-dashis-agents](https://github.com/qwwiwi/gateway-dashis-agents) (private) — текущий Python gateway, который заменяем
- [qwwiwi/jarvis-telegram-gateway](https://github.com/qwwiwi/jarvis-telegram-gateway) (public) — generic база
- [qwwiwi/agents-edgelab](https://github.com/qwwiwi/agents-edgelab) (private) — Tyrande / Hermes (берёт крон-нагрузку без Anthropic)

## External references

- [Anthropic billing support article](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)
- [Claude Code Channels reference](https://code.claude.com/docs/en/channels-reference)
- [Telegram Bot Features (bot-to-bot)](https://core.telegram.org/bots/features)

## Owner

@qwwiwi (Dashi) · Orgrimmar Silvana coordination

**D-day: 2026-06-15** — Anthropic billing split.
