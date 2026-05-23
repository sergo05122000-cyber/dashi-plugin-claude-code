// MultichatRouter — orchestrator for the per-chat tmux session fleet.
//
// Wires together the pieces that Batches 1 and 2 produced:
//   * gate / addressing (handlers.ts decides what reaches us)
//   * MultichatPolicy (defines allowlist + per-chat behaviour)
//   * TmuxSessionPool (spawns and supervises per-chat `claude` tmux sessions)
//   * inbox-bridge (file-based JSON pipe to the tmux side)
//   * Telegram API (egress for outbox messages produced by the tmux side)
//
// dispatch() is the single entry point for inbound traffic; start()/stop()
// manage the background pollers and the session pool watchdog. The router
// never owns the bot or its rate-limit queue — egress goes through the
// existing TelegramApi instance so safe-telegram-api still applies its
// per-chat throttle and redactor pipeline.
//
// Outbox loop design (H2 fix, 2026-05-23):
//   Per-chat setInterval (200 ms cadence) that drains the outbox via
//   pollOutboxOnce — now a two-phase claim/confirm/reject protocol so a
//   transient Telegram send error no longer destroys the message.
//   pollOutboxOnce rename-locks each file into `outbox/processing/`;
//   we send to Telegram and then call either confirmOutboxClaim
//   (success — unlink processing file) or rejectOutboxClaim (failure —
//   move to `outbox/dead-letter/` with a `.fail.json` sidecar). Files
//   are consumed in arrival order. The interval is `unref`'d so it
//   does not keep the process alive when server.ts shuts down without
//   an explicit stop() — defence in depth.

import { readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'

import type { TelegramApi } from '../channel/tools.js'
import type { Logger } from '../log.js'
import {
  getChatPolicy,
  type MultichatPolicy,
} from '../chats/policy-loader.js'
import {
  confirmOutboxClaim,
  ensureChatStateDirs,
  pollOutboxOnce,
  rejectOutboxClaim,
  writeToInbox,
  type InboundMessage,
  type OutboxClaim,
} from './inbox-bridge.js'
import type { TmuxSessionPool } from './tmux-session-pool.js'

// Telegram surface the router actually touches. We only need sendMessage —
// editMessageText is owned by StatusManager / TmuxMirror, not the outbox
// path. Keep the type narrow so unit tests can stub a minimal surface.
export interface MultichatTelegramApi {
  sendMessage: TelegramApi['sendMessage']
}

export interface RouterDeps {
  policy: MultichatPolicy
  pool: TmuxSessionPool
  // State root for inbox/outbox dirs and sessions.json. Must match the
  // value passed to TmuxSessionPool to keep both sides talking to the
  // same per-chat directory.
  stateDir: string
  // Workspace root that owns `chats/{chatId}/persona.md`. Reserved for
  // future router-side persona resolution; today the SessionStart hook
  // reads it inside the tmux session via CHAT_ID env.
  workspaceDir: string
  telegramApi: MultichatTelegramApi
  logger: Logger
}

// Default polling cadence. 200ms gives sub-second perceived latency
// for replies without hammering the disk (one readdir per chat).
// Matches PLAN.md section 2 ("setInterval(200ms)").
const DEFAULT_OUTBOX_POLL_INTERVAL_MS = 200

// Per-chat outbox loop bookkeeping. fs.watch is intentionally NOT used
// today — Node's watcher behaviour differs across platforms (linux
// inotify vs macOS FSEvents) and the 200ms poll is well within latency
// budget. The struct keeps a `watcher` slot for a future PR.
interface OutboxLoopHandle {
  interval: ReturnType<typeof setInterval>
}

export class MultichatRouter {
  private readonly policy: MultichatPolicy
  private readonly pool: TmuxSessionPool
  private readonly stateDir: string
  // Workspace root surfaced for callers that need to derive the
  // chats base path (e.g. for persona resolution outside the tmux
  // session). Accessed only through `chatsBasePath()` — direct
  // field access would couple consumers to the implementation.
  private readonly workspaceDir: string
  private readonly telegramApi: MultichatTelegramApi
  private readonly logger: Logger
  // chatId -> outbox loop handle. Presence in the map means polling is
  // active; absence means we are not draining this chat's outbox yet.
  private readonly outboxLoops = new Map<string, OutboxLoopHandle>()
  private started = false

  constructor(deps: RouterDeps) {
    this.policy = deps.policy
    this.pool = deps.pool
    this.stateDir = deps.stateDir
    this.workspaceDir = deps.workspaceDir
    this.telegramApi = deps.telegramApi
    this.logger = deps.logger
  }

  /**
   * Start the router: rehydrate the session pool from disk, arm the
   * watchdog, and spin up outbox loops for every session that survived
   * the load. Idempotent — repeated calls are no-ops after the first.
   */
  async start(): Promise<void> {
    if (this.started) return
    this.started = true

    await this.pool.loadSessions()
    this.pool.startWatchdog()

    // Re-arm outbox pollers for sessions that survived a plugin restart.
    // We rely on the policy.allowlist.chats to enumerate known chat ids;
    // sessions.json only records what was once spawned, but the policy
    // is the source of truth for "this chat is configured at all".
    for (const chatId of this.policy.allowlist.chats) {
      this.startOutboxLoop(chatId)
    }

    this.logger.info('multichat router started', {
      chats: this.policy.allowlist.chats.length,
    })
  }

  /**
   * Stop background activity owned by the router. tmux sessions are
   * deliberately NOT killed — they stay alive across plugin restarts so
   * the next start() reattaches without losing conversation context.
   */
  async stop(): Promise<void> {
    if (!this.started) return
    this.started = false

    for (const chatId of Array.from(this.outboxLoops.keys())) {
      this.stopOutboxLoop(chatId)
    }
    this.pool.stopWatchdog()

    this.logger.info('multichat router stopped')
  }

  /**
   * Absolute path to the directory that holds per-chat persona files.
   *
   * Equivalent to `{workspaceDir}/chats`. Exposed so callers that need
   * to resolve personas outside the tmux session (e.g. an admin tool
   * or future SessionStart hook variant) can read the same path the
   * router was constructed with.
   */
  getChatsBasePath(): string {
    return chatsBasePath(this.workspaceDir)
  }

  /**
   * Route an inbound message into the per-chat tmux session.
   *
   * Flow (in order — H5 spawn-order fix 2026-05-23):
   *   1. Defence-in-depth allowlist check (handlers.ts already gated,
   *      but a buggy caller must not bypass policy). AND-logic for
   *      groups (C2): require both chat AND chat-policy presence;
   *      for DMs, require user in allowlist.users.
   *   2. Ensure the per-chat inbox/outbox directories exist.
   *   3. Atomically write the inbound JSON to the inbox.
   *   4. Spawn-or-attach the chat's tmux session — the entrypoint
   *      watcher drains the inbox on first poll, so the inbox must
   *      already contain this message before the wrapper starts.
   *   5. Update lastMessageAt so the watchdog does not idle-kill.
   *   6. Arm the outbox poller if it is not already running.
   */
  async dispatch(input: InboundMessage): Promise<void> {
    // 1. Defence in depth — handlers.ts already authorized at the
    //    gate, but a buggy caller (or future refactor) must not be
    //    able to inject traffic for an unconfigured chat / user.
    //
    //    AND-logic, separated by chat kind (C2 fix):
    //      * DM (chat_id == user_id in Telegram private chats):
    //        require user_id in allowlist.users. ChatPolicy may
    //        still be missing — pool.spawnInternal performs the
    //        final policy-presence check before tmux spawn (C3).
    //      * Group/supergroup (chat_id != user_id, typically
    //        negative): require BOTH chat_id in allowlist.chats AND
    //        a corresponding entry in policy.chats. Missing either
    //        is a silent drop with a warn log — gate.ts should have
    //        already filtered these, but defence in depth.
    //
    //    Note on isPrivate detection: Telegram private chats have
    //    chat.id == user.id (both positive). Groups have negative
    //    chat.id that never matches user.id. This shortcut avoids
    //    threading chatType through the InboundMessage DTO.
    const chatAllowed = this.policy.allowlist.chats.includes(input.chat_id)
    const userAllowed = this.policy.allowlist.users.includes(input.user_id)
    const chatPolicy = getChatPolicy(this.policy, input.chat_id)
    const isPrivate = input.chat_id === input.user_id

    if (isPrivate) {
      if (!userAllowed) {
        this.logger.warn('router.dispatch.dm_unauthorized', {
          chat_id: input.chat_id,
          user_id: input.user_id,
        })
        return
      }
    } else {
      if (!chatAllowed || chatPolicy === null) {
        this.logger.warn('router.dispatch.group_unauthorized', {
          chat_id: input.chat_id,
          user_id: input.user_id,
          chat_in_allowlist: chatAllowed,
          has_chat_policy: chatPolicy !== null,
        })
        return
      }
    }

    // 2. Ensure dirs FIRST (H5). The pool's entrypoint wrapper drains
    //    the inbox on its initial pass — if we spawn before the inbox
    //    exists, the wrapper logs and exits its initial drain on an
    //    empty dir, then waits for inotify which would race against
    //    the first writeToInbox.
    try {
      await ensureChatStateDirs(input.chat_id, this.stateDir)
    } catch (err) {
      this.logger.error('router.dispatch.ensure_dirs_failed', {
        chat_id: input.chat_id,
        error: err instanceof Error ? err.message : String(err),
      })
      return
    }

    // 2b. M10 fix (2026-05-23): enforce `policy.chats[*].max_queue_depth`.
    //     If the inbox is already at or above the cap, drop the
    //     oldest pending message(s) before writing the new one. Default
    //     cap is 1 (matches policy-loader's Zod default and PLAN.md §7
    //     — "one message in flight per chat").
    //
    //     Rationale for drop-oldest (rather than drop-newest or
    //     reject):
    //       * newest carries the user's freshest intent — discarding it
    //         feels like the bot ignored them outright.
    //       * rejecting the dispatch would require a Telegram error
    //         reply, which complicates the gate path and risks
    //         re-entrancy.
    //       * dropping the oldest gives "we're catching up, latest
    //         wins" semantics that match how a human would behave
    //         under a backlog.
    //
    //     `chatPolicy` was already looked up above for the gate check;
    //     reuse it. For DMs without a per-chat policy entry, fall back
    //     to the same default (1) so the global guarantee holds.
    const maxDepth = chatPolicy?.max_queue_depth ?? 1
    const inboxDir = join(this.stateDir, 'chats', input.chat_id, 'inbox')
    try {
      const inboxEntries = await readdir(inboxDir).catch(() => [])
      // Only .json files count toward the queue depth — `.tmp` writers
      // are mid-rename and will appear as committed files in the next
      // poll, but they are not yet "pending" from the watcher's POV.
      const pending = inboxEntries
        .filter((name) => name.endsWith('.json') && !name.endsWith('.tmp'))
        .sort() // timestamp-prefixed → oldest first
      while (pending.length >= maxDepth) {
        const oldest = pending.shift()
        if (oldest === undefined) break
        const oldestPath = join(inboxDir, oldest)
        await unlink(oldestPath).catch((unlinkErr: unknown) => {
          this.logger.warn('router.dispatch.queue_overflow.drop_failed', {
            chat_id: input.chat_id,
            file: oldest,
            error:
              unlinkErr instanceof Error
                ? unlinkErr.message
                : String(unlinkErr),
          })
        })
        this.logger.warn('router.dispatch.queue_overflow.dropped_oldest', {
          chat_id: input.chat_id,
          dropped: oldest,
          max_depth: maxDepth,
        })
      }
    } catch (err) {
      // Cap enforcement is best-effort — a readdir failure must not
      // block delivery of the fresh inbound. Continue to writeToInbox.
      this.logger.warn('router.dispatch.queue_overflow.check_failed', {
        chat_id: input.chat_id,
        error: err instanceof Error ? err.message : String(err),
      })
    }

    // 3. Atomic inbox write BEFORE spawn (H5). The .tmp + rename
    //    pattern means a partial JSON is never visible to the
    //    watcher, even if it polls between our write and rename.
    try {
      await writeToInbox(input.chat_id, input, this.stateDir)
    } catch (err) {
      this.logger.error('router.dispatch.inbox_write_failed', {
        chat_id: input.chat_id,
        error: err instanceof Error ? err.message : String(err),
      })
      return
    }

    // 4. Spawn-or-attach AFTER the inbox is populated (H5). The pool
    //    serialises concurrent callers for the same chat via its
    //    pendingSpawns mutex, so a burst of inbound messages cannot
    //    race into duplicate tmux sessions. spawnInternal also
    //    enforces the chat-in-policy invariant (C3).
    try {
      await this.pool.getOrSpawn(input.chat_id)
    } catch (err) {
      this.logger.error('router.dispatch.spawn_failed', {
        chat_id: input.chat_id,
        error: err instanceof Error ? err.message : String(err),
      })
      return
    }

    // 5. Mark activity for the idle-kill watchdog.
    this.pool.touch(input.chat_id)

    // 6. Arm outbox poll if missing. Idempotent.
    this.startOutboxLoop(input.chat_id)

    this.logger.debug?.('router.dispatch.ok', {
      chat_id: input.chat_id,
      user_id: input.user_id,
    })
  }

  // ───── outbox loop internals ─────

  /**
   * Begin polling the chat's outbox. No-op when a loop is already
   * armed for this chat.
   */
  private startOutboxLoop(chatId: string): void {
    if (this.outboxLoops.has(chatId)) return
    const interval = setInterval(() => {
      this.drainOutbox(chatId).catch((err: unknown) => {
        // drainOutbox catches its own errors; this is belt-and-braces
        // so an unforeseen throw cannot crash the interval callback
        // and silently stop polling.
        this.logger.warn('router.outbox.uncaught', {
          chat_id: chatId,
          error: err instanceof Error ? err.message : String(err),
        })
      })
    }, DEFAULT_OUTBOX_POLL_INTERVAL_MS)
    // Do not keep the event loop alive solely for an outbox poller —
    // server.ts owns shutdown via stop().
    interval.unref?.()
    this.outboxLoops.set(chatId, { interval })
    this.logger.debug?.('router.outbox.started', { chat_id: chatId })
  }

  /**
   * Tear down a chat's outbox loop. No-op when no loop is armed.
   */
  private stopOutboxLoop(chatId: string): void {
    const handle = this.outboxLoops.get(chatId)
    if (handle === undefined) return
    clearInterval(handle.interval)
    this.outboxLoops.delete(chatId)
    this.logger.debug?.('router.outbox.stopped', { chat_id: chatId })
  }

  /**
   * Single drain pass with two-phase delivery (H2):
   *
   * 1. pollOutboxOnce returns claims, each one is a file that has
   *    already been moved into `outbox/processing/`.
   * 2. For every claim we attempt sendMessage. On success we confirm
   *    (unlink processing/), on failure we reject (move to
   *    dead-letter/ with sidecar).
   *
   * Send failures are logged at warn level so an operator notices
   * dead-lettered messages — but they do NOT break the loop, the
   * remaining claims still get processed.
   */
  private async drainOutbox(chatId: string): Promise<void> {
    let claims: OutboxClaim[]
    try {
      claims = await pollOutboxOnce(chatId, this.stateDir)
    } catch (err) {
      this.logger.warn('router.outbox.poll_failed', {
        chat_id: chatId,
        error: err instanceof Error ? err.message : String(err),
      })
      return
    }
    if (claims.length === 0) return

    for (const claim of claims) {
      await this.deliverClaim(chatId, claim)
    }
  }

  /**
   * Send one claimed outbox message to Telegram and resolve the claim
   * (confirm on success, reject on failure). `reply_to` is a
   * stringified Telegram message_id — convert via parseInt with NaN
   * guard so a bogus payload becomes a dead-letter rather than a
   * loop-killing throw.
   */
  private async deliverClaim(
    chatId: string,
    claim: OutboxClaim,
  ): Promise<void> {
    const message = claim.message
    const opts: { reply_to_message_id?: number; parse_mode?: 'HTML' | 'MarkdownV2' } = {}
    if (message.reply_to !== undefined) {
      const parsed = Number.parseInt(message.reply_to, 10)
      if (Number.isFinite(parsed) && parsed > 0) {
        opts.reply_to_message_id = parsed
      } else {
        this.logger.warn('router.outbox.bad_reply_to', {
          chat_id: chatId,
          reply_to: message.reply_to,
        })
      }
    }
    try {
      await this.telegramApi.sendMessage(chatId, message.text, opts)
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      this.logger.warn('router.outbox.send_failed', {
        chat_id: chatId,
        error: reason,
        original: claim.originalName,
      })
      await rejectOutboxClaim(claim, { reason }).catch((rejectErr: unknown) => {
        this.logger.error('router.outbox.dead_letter_failed', {
          chat_id: chatId,
          original: claim.originalName,
          error:
            rejectErr instanceof Error ? rejectErr.message : String(rejectErr),
        })
      })
      return
    }
    await confirmOutboxClaim(claim).catch((confirmErr: unknown) => {
      // Confirm failure means the file lingers in processing/ but the
      // Telegram message already went out — log so an operator can
      // sweep stale processing files. NEVER retry the send: that would
      // duplicate the user-visible message.
      this.logger.warn('router.outbox.confirm_failed', {
        chat_id: chatId,
        original: claim.originalName,
        error:
          confirmErr instanceof Error ? confirmErr.message : String(confirmErr),
      })
    })
  }
}

// Re-export workspaceDir alias for callers that want to read this
// router's view of the chats base path without importing fs internals.
// Keeps the field private while exposing a derived path consumers can
// pass to `resolvePersona`.
export function chatsBasePath(workspaceDir: string): string {
  return `${workspaceDir}/chats`
}
