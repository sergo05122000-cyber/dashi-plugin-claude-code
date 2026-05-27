// StatusManager — owns the transient "Печатает.../Думает.../🔧 tool" message
// the bot edits while Claude works on a reply. Mirrors gateway.py:2895-2930
// behaviour: lazy status message, periodic edit while task is in flight, delete
// (or finalize) before the real answer ships.
//
// Design notes:
//   * One active StatusHandle per chatId. Calling start() while another is
//     active silently cancels the previous one (no edit to "canceled" label —
//     the new status starts immediately and is what the user sees).
//   * Timers are injected via setTimer/clearTimer so tests can drive the
//     ticker with fake clocks. We never call global setInterval directly.
//   * Telegram edit failures are SWALLOWED (logged at warn). A flaky edit
//     must never propagate to a 500 in the tool layer — the real reply path
//     is the source of truth.
//   * TTL guard auto-cancels after `config.status.ttl_ms` so a stuck status
//     (e.g. Claude crashed without firing complete()) doesn't haunt the chat
//     forever.

import type { AppConfig } from '../config.js'
import type { Logger } from '../log.js'
import type { ChatAction, TelegramApi } from '../channel/tools.js'
import type { MultichatPolicy } from '../chats/policy-loader.js'
import { escapeHtml } from '../format/html.js'
import type { ActivityStatusEvent } from '../hooks/claude-events.js'
import {
  buildActivityDetail,
  buildHumanizedActivityLine,
  maskSecrets,
  renderActivityBlock,
  type ActivityCall,
  type ActivitySnapshot,
} from './activity-renderer.js'

/**
 * Multichat policy gate for progress streaming.
 *
 * Returns whether the StatusManager should emit interim "Печатает..." /
 * activity edits for a chat. Public groups configured with
 * `streaming: 'off'` get the final reply from the router's outbox
 * loop only — no rolling status, no tool-by-tool edits, no chat
 * action pulses.
 *
 * When no policy is provided (legacy single-chat deployments) the
 * default is `true` so existing callers keep their streaming without
 * touching wiring code.
 *
 * @param chatId stringified Telegram chat id
 * @param policy loaded multichat policy, or `undefined` for legacy mode
 * @returns `true` when interim progress edits should be sent
 */
export function shouldStream(
  chatId: string,
  policy?: MultichatPolicy,
): boolean {
  const entry = policy?.chats[chatId]
  if (entry === undefined) return true
  return entry.streaming === 'progress'
}

// Telegram's `sendChatAction` indicator expires after 5 s; re-pulse on a 4 s
// timer to keep the header animation continuous without spamming the API.
const CHAT_ACTION_PULSE_MS = 4000

// All active StatusStates map to a single `typing` action. Tool-specific
// actions (`upload_document`, etc.) are not used today because Telegram's
// header animation is the same for `typing` and we want to keep the contract
// simple. Extend here if a per-tool icon becomes worth the noise.
function chatActionFor(state: StatusState): ChatAction | null {
  switch (state.kind) {
    case 'typing':
    case 'thinking':
    case 'tool':
    case 'activity':
      return 'typing'
    case 'stopped':
    case 'error':
      return null
  }
}

export type StatusState =
  | { kind: 'typing' }
  | { kind: 'thinking' }
  | { kind: 'tool'; toolName: string }
  | { kind: 'activity'; snapshot: ActivitySnapshot }
  | { kind: 'stopped'; reason?: string }
  | { kind: 'error'; reason?: string }

// Cap on the in-memory tool-call buffer per active chat. Gateway uses 10
// (gateway.py:1876-1879); render window is 5 (`activity-renderer.ts`
// `ACTIVITY_WINDOW`). Keeping more than we render lets the "+N earlier"
// summary stay accurate after collapses without an unbounded buffer.
const ACTIVITY_MAX_BUFFER = 10

// Throttle non-Agent tool edits to once per this many ms. Agent dispatches
// always edit immediately. Mirrors gateway.py:1738 `_last_tool_render` + 5 s
// throttle in `_TaskBoundaryTracker`.
const ACTIVITY_EDIT_THROTTLE_MS = 5000

export interface StatusHandle {
  readonly chatId: string
  readonly messageId: number
  readonly startedAt: number
}

// Telegram surface the manager actually touches. Pulled out of channel/tools
// TelegramApi so we can extend with deleteMessage without bloating that
// type's import graph elsewhere.
export interface TelegramApiForStatus {
  sendMessage: TelegramApi['sendMessage']
  editMessageText: TelegramApi['editMessageText']
  deleteMessage?: (chatId: string, messageId: number) => Promise<void>
  // Native Telegram `typing` indicator in the chat header. Optional so unit
  // tests can stub a minimal surface. Action expires after 5 s on Telegram's
  // side, so the manager re-pulses on a 4 s timer while a status is active.
  sendChatAction?: TelegramApi['sendChatAction']
}

export interface StatusManagerDeps {
  telegramApi: TelegramApiForStatus
  config: AppConfig
  log: Logger
  now?: () => number
  setTimer?: (cb: () => void, ms: number) => NodeJS.Timeout
  clearTimer?: (handle: NodeJS.Timeout) => void
  // Optional: multichat policy gate. Default `true` keeps existing
  // callers behaviour-identical. `false` turns the manager into a
  // no-op shell — start/update/cancel/complete and the activity hook
  // path all return early without sending or editing any messages.
  // Final replies in public chats arrive via the router's outbox
  // loop, not StatusManager, so leaving this off is safe.
  streamingEnabled?: boolean
}

// Internal mirror of StatusHandle without the `readonly` modifiers — we
// mutate messageId lazily when the bubble is created after a typing-only
// start. The public StatusHandle (returned to callers) stays readonly.
interface MutableHandle {
  chatId: string
  messageId: number
  startedAt: number
}

interface InternalEntry {
  handle: MutableHandle
  state: StatusState
  // Cycle index used to advance the dot animation on each tick.
  tick: number
  lastText: string
  intervalHandle: NodeJS.Timeout | null
  ttlHandle: NodeJS.Timeout | null
  // Separate cadence from the message edit ticker — see CHAT_ACTION_PULSE_MS.
  chatActionHandle: NodeJS.Timeout | null
  // Original reply target captured from start(). Re-used when the bubble is
  // created lazily on the first non-typing transition so it threads under
  // the same inbound message the user originally sent.
  replyToMessageId: number | undefined
  // True when sendMessage has not been called yet because state is still
  // typing and suppress_typing_bubble is on. Lazy-create path flips this on
  // first non-typing transition.
  bubbleSuppressed: boolean
  // Rolling activity state — kept on the entry even while state.kind!=
  // 'activity' so a Stop after a non-tool reasoning phase still has the
  // recorded history. Last-tool-render timestamp throttles non-Agent edits.
  activityCalls: ActivityCall[]
  activityPhase: 'reasoning' | 'tool'
  activityStartedAt: number
  lastToolRenderAt: number
  // Map tool_use_id → call buffer index, so PostToolUse Agent can update
  // the recorded line with a short done summary.
  toolUseIndex: Map<string, number>
}

// Reuse Telegram's "message is not modified" detection. We can't import a
// real grammY error class here (would couple status module to grammY); use
// a substring check that matches the wire payload Telegram returns.
function isMessageNotModifiedError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /message is not modified/i.test(msg)
}

function renderState(state: StatusState, tick: number, nowMs: number): string {
  // Ellipsis animation for typing/thinking: 1→2→3 dots.
  const dotCount = (tick % 3) + 1
  const dots = '.'.repeat(dotCount)
  switch (state.kind) {
    case 'typing':
      return `<i>Печатает${dots}</i>`
    case 'thinking':
      return `<i>Думает${dots}</i>`
    case 'tool':
      return `<i>🔧 ${escapeHtml(state.toolName)}</i>`
    case 'activity':
      return renderActivityBlock(state.snapshot, nowMs)
    case 'stopped': {
      const tail = state.reason ? `: ${escapeHtml(state.reason)}` : ''
      return `<i>Остановлено${tail}</i>`
    }
    case 'error': {
      const tail = state.reason ? `: ${escapeHtml(state.reason)}` : ''
      return `<i>Ошибка${tail}</i>`
    }
  }
}

export class StatusManager {
  private readonly telegramApi: TelegramApiForStatus
  private readonly config: AppConfig
  private readonly log: Logger
  private readonly now: () => number
  private readonly setTimer: (cb: () => void, ms: number) => NodeJS.Timeout
  private readonly clearTimer: (handle: NodeJS.Timeout) => void
  private readonly entries: Map<string, InternalEntry>
  // When `false`, every public mutation is a no-op. Distinct from any
  // per-chat streaming flag — this is a global construction-time gate
  // typically wired from `shouldStream(chatId, policy)`. We do not flip
  // it at runtime; callers construct a separate StatusManager per chat
  // when behaviour must differ.
  private readonly streamingEnabled: boolean

  constructor(deps: StatusManagerDeps) {
    this.telegramApi = deps.telegramApi
    this.config = deps.config
    this.log = deps.log
    this.now = deps.now ?? (() => Date.now())
    // Bind to global timers as a default so production code doesn't need to
    // pass anything. Tests inject deterministic fake timers.
    this.setTimer = deps.setTimer ?? ((cb, ms) => setTimeout(cb, ms))
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h))
    this.entries = new Map()
    this.streamingEnabled = deps.streamingEnabled ?? true
  }

  isActive(chatId: string): boolean {
    return this.entries.has(chatId)
  }

  // List of active chat ids — used by shutdown to flush all status messages.
  activeChatIds(): string[] {
    return Array.from(this.entries.keys())
  }

  async start(
    chatId: string,
    replyToMessageId: number | undefined,
    initialState: StatusState = { kind: 'typing' },
  ): Promise<StatusHandle> {
    if (!this.streamingEnabled) {
      // No-op shell: return a sentinel handle that does not correspond
      // to any real Telegram message. update()/cancel()/complete() all
      // bail out because `entries.get(chatId)` will be undefined.
      // Callers that store the handle and later mutate it observe the
      // same idempotent silence — defence-in-depth for misuse.
      return {
        chatId,
        messageId: 0,
        startedAt: this.now(),
      }
    }
    // Only one active status per chat at a time: finalise the previous one
    // (edit the old message to "Остановлено: superseded" and clear timers)
    // so we don't leak a stale "Печатает…" message on top of the new one.
    // Album-path callers in handlers.ts call start() once per album item;
    // without this terminate step the first item's pulse stays forever.
    if (this.entries.has(chatId)) {
      await this.cancel(chatId, 'superseded')
    }

    const suppressBubble =
      this.config.status.suppress_typing_bubble && initialState.kind === 'typing'

    const text = renderState(initialState, 0, this.now())
    let messageId = 0
    if (!suppressBubble) {
      const sendOpts: { parse_mode: 'HTML'; reply_to_message_id?: number } = {
        parse_mode: 'HTML',
      }
      if (replyToMessageId !== undefined) sendOpts.reply_to_message_id = replyToMessageId

      let sent: { message_id: number }
      try {
        sent = await this.telegramApi.sendMessage(chatId, text, sendOpts)
      } catch (err) {
        // If we can't even send the initial status, log and rethrow — caller
        // can decide whether to proceed without status. (handlers.ts treats
        // status as best-effort and will catch this.)
        this.log.warn('status start failed', {
          chat_id: chatId,
          error: err instanceof Error ? err.message : String(err),
        })
        throw err
      }
      messageId = sent.message_id
    }

    const handle: MutableHandle = {
      chatId,
      messageId,
      startedAt: this.now(),
    }
    const entry: InternalEntry = {
      handle,
      state: initialState,
      tick: 0,
      lastText: suppressBubble ? '' : text,
      intervalHandle: null,
      ttlHandle: null,
      chatActionHandle: null,
      replyToMessageId,
      bubbleSuppressed: suppressBubble,
      activityCalls: [],
      activityPhase: 'reasoning',
      activityStartedAt: this.now(),
      // Sentinel — first non-Agent tool call always renders. Throttle only
      // applies AFTER a render has actually occurred.
      lastToolRenderAt: Number.NEGATIVE_INFINITY,
      toolUseIndex: new Map(),
    }
    this.entries.set(chatId, entry)

    // Fire-and-forget initial chat action so the Telegram header shows
    // `typing…` immediately, not on the first pulse 4 s in. Keeps firing
    // even when the message bubble is suppressed — the native indicator
    // is what the warchief still wants to see.
    void this.pulseChatAction(entry)
    entry.chatActionHandle = this.setTimer(
      () => this.chatActionTick(chatId),
      CHAT_ACTION_PULSE_MS,
    )

    // Periodic tick — re-edit with advanced ellipsis (typing/thinking only)
    // or keep the same text for tool/stopped/error states. Same-text edits
    // collapse via the "message is not modified" swallow path below.
    //
    // While the bubble is suppressed we still advance the tick counter so
    // animation timing stays continuous when the bubble eventually appears,
    // but `editSafely` short-circuits because messageId is 0.
    const tick = (): void => {
      const live = this.entries.get(chatId)
      if (!live) return
      live.tick += 1
      if (!live.bubbleSuppressed) {
        const next = renderState(live.state, live.tick, this.now())
        void this.editSafely(live, next)
      }
      // Re-arm next tick.
      live.intervalHandle = this.setTimer(tick, this.config.status.interval_ms)
    }
    entry.intervalHandle = this.setTimer(tick, this.config.status.interval_ms)

    // TTL guard. On expiry we cancel with reason='ttl' so the message turns
    // into "Остановлено: ttl" rather than vanishing silently. When the
    // bubble was suppressed end-to-end (pure typing session that timed
    // out) cancel() turns into a quiet cleanup with no Telegram edit.
    entry.ttlHandle = this.setTimer(() => {
      const live = this.entries.get(chatId)
      if (!live) return
      void this.cancel(chatId, 'ttl')
    }, this.config.status.ttl_ms)

    return {
      chatId: handle.chatId,
      messageId: handle.messageId,
      startedAt: handle.startedAt,
    }
  }

  // Lazy-create the Telegram message bubble when state advances from typing
  // to anything else (thinking/tool/activity/stopped/error). No-op when the
  // bubble already exists. Used by update() and recordActivityByChatId().
  private async ensureBubble(entry: InternalEntry, state: StatusState): Promise<void> {
    if (!entry.bubbleSuppressed) return
    if (state.kind === 'typing') return
    const text = renderState(state, 0, this.now())
    const sendOpts: { parse_mode: 'HTML'; reply_to_message_id?: number } = {
      parse_mode: 'HTML',
    }
    if (entry.replyToMessageId !== undefined) {
      sendOpts.reply_to_message_id = entry.replyToMessageId
    }
    try {
      const sent = await this.telegramApi.sendMessage(entry.handle.chatId, text, sendOpts)
      entry.handle.messageId = sent.message_id
      entry.lastText = text
      entry.bubbleSuppressed = false
    } catch (err) {
      // Best-effort — log and leave bubble suppressed. Next non-typing
      // event will retry the send.
      this.log.warn('status lazy-send failed (ignored)', {
        chat_id: entry.handle.chatId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  async update(handle: StatusHandle, state: StatusState): Promise<void> {
    const entry = this.entries.get(handle.chatId)
    if (!entry) return
    // Staleness check is messageId-based, but a still-suppressed entry has
    // messageId 0 in both the caller's handle (returned from start) and the
    // internal entry, so the comparison still passes. Once the bubble has
    // been created lazily, callers using the original 0-handle drift into
    // staleness — by then they should be using updateByChatId, which is the
    // documented path for late edits.
    if (entry.handle.messageId !== handle.messageId && !entry.bubbleSuppressed) {
      // Stale handle — caller is editing something already completed.
      return
    }
    entry.state = state
    // Reset tick on state change so the ellipsis animation restarts at 1.
    entry.tick = 0
    if (entry.bubbleSuppressed) {
      await this.ensureBubble(entry, state)
      // ensureBubble already wrote the rendered text for non-typing states
      // and flipped bubbleSuppressed off. Nothing else to edit on this turn.
      return
    }
    const text = renderState(state, 0, this.now())
    await this.editSafely(entry, text)
  }

  // Convenience for the MCP `status` tool: the agent only has the chat_id,
  // not a StatusHandle (which is internal to the gateAndNotify caller). This
  // lets the tool re-target whichever status is currently active for the chat.
  async updateByChatId(chatId: string, state: StatusState): Promise<void> {
    const entry = this.entries.get(chatId)
    if (!entry) return
    await this.update(entry.handle, state)
  }

  /**
   * Apply a Claude Code hook event to the chat's status. Opens a new status
   * with no `reply_to_message_id` if none is active (SessionStart /
   * UserPromptSubmit / PreToolUse all act as openers — gateway parity).
   * Stop completes via `complete()` so existing delete_on_complete behaviour
   * holds.
   *
   * Non-Agent PreToolUse calls are recorded immediately but the on-Telegram
   * edit is throttled to once per 5 s; the next reasoning/Agent/Stop event
   * flushes the buffer (mirrors gateway.py:1738 `_last_tool_render`).
   */
  async recordActivityByChatId(chatId: string, event: ActivityStatusEvent): Promise<void> {
    if (!this.streamingEnabled) {
      // Hook events arrive whether or not we want to surface them; the
      // policy decides whether the chat sees streaming. Drop silently
      // — final reply ships via the router outbox loop, not here.
      return
    }
    // Stop closes the session. Use existing complete() so delete_on_complete
    // semantics + timer cleanup stay in one place.
    if (event.kind === 'session_stop') {
      await this.complete(chatId)
      return
    }

    // Lazy-open: hook events can arrive before any inbound Telegram message.
    // In that case we open a status with no reply target so the rendering
    // surface exists. Initial state is `activity` so the first edit shows
    // the working block, not "Печатает…".
    let entry = this.entries.get(chatId)
    if (!entry) {
      const initial: StatusState = {
        kind: 'activity',
        snapshot: this.buildSnapshot([], 'reasoning', this.now()),
      }
      try {
        await this.start(chatId, undefined, initial)
      } catch {
        // Telegram send failed — already logged inside start(). Visibility
        // failure must not back-pressure Claude hooks; bail silently.
        return
      }
      entry = this.entries.get(chatId)
      if (!entry) return
    }

    const now = this.now()
    let shouldRender = false
    let isAgentEvent = false

    switch (event.kind) {
      case 'session_start':
      case 'reasoning': {
        entry.activityPhase = 'reasoning'
        shouldRender = true
        break
      }
      case 'tool_start': {
        // Record every call up to the buffer cap so PostToolUse can pair.
        const detail = buildActivityDetail(event.toolName, event.toolInput)
        const humanized = buildHumanizedActivityLine(event.toolName, event.toolInput)
        const call: ActivityCall = { toolName: event.toolName, detail, humanized }
        entry.activityCalls.push(call)
        if (entry.activityCalls.length > ACTIVITY_MAX_BUFFER) {
          entry.activityCalls.shift()
          // After shifting, indexes in toolUseIndex are stale; rebuild
          // lazily — only PostToolUse readers touch them.
          const rebuilt = new Map<string, number>()
          for (const [k, v] of entry.toolUseIndex.entries()) {
            if (v > 0) rebuilt.set(k, v - 1)
          }
          entry.toolUseIndex = rebuilt
        }
        entry.toolUseIndex.set(event.toolUseId, entry.activityCalls.length - 1)
        entry.activityPhase = 'tool'

        isAgentEvent = event.toolName === 'Agent'
        if (isAgentEvent) {
          shouldRender = true
        } else if (now - entry.lastToolRenderAt >= ACTIVITY_EDIT_THROTTLE_MS) {
          shouldRender = true
        } else {
          // Throttled — buffer remains; next render flush will surface it.
          shouldRender = false
        }
        break
      }
      case 'tool_end': {
        entry.activityPhase = 'reasoning'
        // For Agent PostToolUse, attach a short done summary to the matching
        // line — capped at 30 chars + masked AT STORE TIME (review §7).
        // Pre-fix the raw tool_result lived in the buffer until render; an
        // in-memory leak (debug dump, future log sink, serializer) would
        // surface raw tokens. Masking here means the buffer never holds an
        // unmasked secret-shaped string.
        if (event.toolName === 'Agent' && event.toolResult !== undefined) {
          const idx = entry.toolUseIndex.get(event.toolUseId)
          if (idx !== undefined && idx >= 0 && idx < entry.activityCalls.length) {
            const rawSummary =
              typeof event.toolResult === 'string'
                ? event.toolResult.slice(0, 30)
                : ''
            const summary = rawSummary ? maskSecrets(rawSummary) : ''
            if (summary) {
              const prev = entry.activityCalls[idx]
              if (prev) {
                entry.activityCalls[idx] = {
                  toolName: prev.toolName,
                  detail: `${prev.detail} — ${summary}`,
                  humanized:
                    prev.humanized !== null
                      ? `${prev.humanized} — ${escapeHtml(summary)}`
                      : null,
                }
              }
            }
          }
        }
        shouldRender = true
        break
      }
    }

    if (!shouldRender) return

    if (event.kind === 'tool_start' && !isAgentEvent) {
      entry.lastToolRenderAt = now
    } else if (event.kind === 'tool_start' && isAgentEvent) {
      entry.lastToolRenderAt = now
    }

    const snapshot = this.buildSnapshot(
      entry.activityCalls,
      entry.activityPhase,
      entry.activityStartedAt,
    )
    entry.state = { kind: 'activity', snapshot }
    entry.tick = 0
    if (entry.bubbleSuppressed) {
      // First non-typing event creates the bubble with the activity render
      // directly — no «Печатает.» preamble.
      await this.ensureBubble(entry, entry.state)
      return
    }
    const text = renderState(entry.state, 0, now)
    await this.editSafely(entry, text)
  }

  private buildSnapshot(
    calls: ReadonlyArray<ActivityCall>,
    phase: 'reasoning' | 'tool',
    startedAtMs: number,
  ): ActivitySnapshot {
    return {
      startedAtMs,
      // Defensive copy so consumers don't see future mutations.
      calls: calls.slice(),
      phase,
    }
  }

  async complete(chatId: string): Promise<void> {
    const entry = this.entries.get(chatId)
    if (!entry) return
    this.stopTimers(entry)
    this.entries.delete(chatId)
    // Suppressed bubble = never sent a Telegram message, nothing to delete.
    if (entry.bubbleSuppressed) return
    if (this.config.status.delete_on_complete && this.telegramApi.deleteMessage) {
      try {
        await this.telegramApi.deleteMessage(chatId, entry.handle.messageId)
      } catch (err) {
        // Stale message, deleted by user, or permission issue — never fatal.
        this.log.debug('status delete failed (ignored)', {
          chat_id: chatId,
          message_id: entry.handle.messageId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }

  async cancel(chatId: string, reason: string): Promise<void> {
    const entry = this.entries.get(chatId)
    if (!entry) return
    this.stopTimers(entry)
    this.entries.delete(chatId)
    // Pure typing session that ended without ever transitioning — no bubble
    // exists on Telegram, so there is nothing to mark as «Остановлено».
    if (entry.bubbleSuppressed) return
    const text = renderState({ kind: 'stopped', reason }, 0, this.now())
    try {
      await this.telegramApi.editMessageText(
        chatId,
        entry.handle.messageId,
        text,
        { parse_mode: 'HTML' },
      )
    } catch (err) {
      if (!isMessageNotModifiedError(err)) {
        this.log.warn('status cancel edit failed', {
          chat_id: chatId,
          message_id: entry.handle.messageId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }

  // ───── internals ─────

  private async editSafely(entry: InternalEntry, text: string): Promise<void> {
    // Bubble suppressed — no Telegram message to edit. Caller is expected to
    // go through ensureBubble() instead. Guard defends timer-driven ticks
    // that fire before the first non-typing transition.
    if (entry.bubbleSuppressed || entry.handle.messageId === 0) return
    if (text === entry.lastText) {
      // Skip the network roundtrip; Telegram would respond with "message is
      // not modified" anyway and we'd swallow it.
      return
    }
    try {
      await this.telegramApi.editMessageText(
        entry.handle.chatId,
        entry.handle.messageId,
        text,
        { parse_mode: 'HTML' },
      )
      entry.lastText = text
    } catch (err) {
      if (isMessageNotModifiedError(err)) {
        // Treat as success — sync our local cache so we don't retry next tick.
        entry.lastText = text
        return
      }
      this.log.warn('status edit failed (ignored)', {
        chat_id: entry.handle.chatId,
        message_id: entry.handle.messageId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  private stopTimers(entry: InternalEntry): void {
    if (entry.intervalHandle !== null) {
      this.clearTimer(entry.intervalHandle)
      entry.intervalHandle = null
    }
    if (entry.ttlHandle !== null) {
      this.clearTimer(entry.ttlHandle)
      entry.ttlHandle = null
    }
    if (entry.chatActionHandle !== null) {
      this.clearTimer(entry.chatActionHandle)
      entry.chatActionHandle = null
    }
  }

  // Send a single chat action for the entry's current state. Swallows
  // errors — the header indicator is best-effort and a flaky call must
  // not derail the message edit path or surface to the agent.
  private async pulseChatAction(entry: InternalEntry): Promise<void> {
    if (!this.telegramApi.sendChatAction) return
    const action = chatActionFor(entry.state)
    if (action === null) return
    try {
      await this.telegramApi.sendChatAction(entry.handle.chatId, action)
    } catch (err) {
      this.log.debug('sendChatAction failed (ignored)', {
        chat_id: entry.handle.chatId,
        action,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  private chatActionTick(chatId: string): void {
    const live = this.entries.get(chatId)
    if (!live) return
    void this.pulseChatAction(live)
    live.chatActionHandle = this.setTimer(
      () => this.chatActionTick(chatId),
      CHAT_ACTION_PULSE_MS,
    )
  }
}
