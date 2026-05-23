// Inbound message handlers for Telegram.
//
// T4 scope: each handler extracts the gate inputs from a grammY Context,
// calls gateTelegramMessage, and on allow forwards a minimal placeholder
// notification through the MCP channel. Drops log at debug only.
//
// T7 added reply-context wrapping via prompt/build.ts (untrusted_metadata
// for reply bodies). T8 adds media descriptors: each media handler now
// builds a typed MediaDescriptor, renders it via renderMediaDescriptor,
// and passes the result through buildChannelContent so the prompt the
// agent sees has `<media kind="..." .../>` tags above the user text.
//
// Photo handler additionally downloads the photo after the allowlist gate
// passes (mirrors gateway.py:863-901 + server.ts:791-815). Voice handler
// optionally calls Groq Whisper via maybeTranscribeVoice — failure does
// not crash, the descriptor records transcription_status=failed/missing_key.
import type { Context } from 'grammy'
import type { Server } from '@modelcontextprotocol/sdk/server/index.js'

import type { AppConfig, StatePaths } from '../config.js'
import type { Logger } from '../log.js'
import type { TelegramApi } from '../channel/tools.js'
import type { StatusManager } from '../status/status-manager.js'
import type { MultichatPolicy } from '../chats/policy-loader.js'
import type { MultichatRouter } from '../router/multichat-router.js'
import type { InboundMessage } from '../router/inbox-bridge.js'
import { sendChannelNotification, type ChannelEvent } from '../channel/notify.js'
import { gateTelegramMessage, type GateInput } from './gate.js'
import { isAddressedToBot } from './addressing.js'
import {
  buildChannelContent,
  type BotIdentity,
  type TelegramReplyMessage,
} from '../prompt/build.js'
import {
  downloadPhotoToInbox,
  maybeTranscribeVoice,
  renderMediaDescriptor,
  type BotApiForDownload,
  type MediaDescriptor,
} from './media.js'
import {
  executeOobResult,
  handleOobCommand,
  parseOobCommand,
  type OobContext,
  type TmuxMirrorControl,
} from '../commands/oob.js'
import {
  isPermissionApprover,
  parsePermissionTextReply,
  type PermissionRelayHooks,
} from '../channel/permissions.js'
import { AlbumBuffer, type Album } from './album-buffer.js'
import type { InboundWatcher } from './watcher.js'

// A single buffered album item — one Telegram update that belongs to an
// album. We capture everything needed to emit a combined channel notification
// without re-parsing the original ctx (which is short-lived per update).
export interface AlbumEntry {
  /** Pre-rendered `<media .../>` descriptor strings for this item. */
  descriptors: string[]
  /** Local filesystem paths for downloaded media in this item (router path).
   *  Empty when no media in this item was downloaded inline (only `photo`
   *  triggers an immediate download today). */
  mediaPaths: string[]
  /** Trimmed caption text for this item ('' when no caption). */
  caption: string
  /** Per-item message_id — used to surface first message_id in meta. */
  messageId: number | undefined
  /** Reply context, if this item was a reply. First non-null wins on flush. */
  reply: TelegramReplyMessage | undefined
}

// Album-level dispatch deps. Subset of HandlerDeps used by sendAlbumNotification.
export interface AlbumDispatchDeps {
  server: Server
  config: AppConfig
  log: Logger
  bot: BotIdentity
  telegramApi: TelegramApi
  statusManager?: StatusManager
  // Multichat router + policy. When both present, album flushes are
  // dispatched as a single InboundMessage (captions merged, media_paths
  // concatenated). Otherwise the legacy MCP notify path runs.
  router?: MultichatRouter
  policy?: MultichatPolicy
}

export interface HandlerDeps {
  server: Server
  config: AppConfig
  statePaths: StatePaths
  telegramApi: TelegramApi
  log: Logger
  // BotIdentity is shared by reference from server.ts — its id/username are
  // populated by grammy's onStart callback before any update reaches us.
  bot: BotIdentity
  // Bot.api passthrough for photo download (getFile). Kept narrow so the
  // handler module never reaches into grammY internals.
  botApi: BotApiForDownload
  // Telegram bot token, used to build file-CDN URLs. Redacted in logs by
  // config.redactToken before any error escapes the process.
  botToken: string
  // Minimal env subset — currently only GROQ_API_KEY for voice transcription.
  env: { GROQ_API_KEY?: string }
  // Permission relay hooks — when present, the text handler intercepts
  // "yes <id>" / "no <id>" replies from approvers and emits verdicts.
  // Optional so older tests that don't exercise permissions still compile.
  permissionHooks?: PermissionRelayHooks
  // T11: status manager owns the "Печатает.../🔧 tool" transient. Optional
  // so older T4-T10 tests that pre-date T11 still compile against this
  // type — when absent we just skip status creation.
  statusManager?: StatusManager
  // T9: album buffer collects per-mgid items and fires a flush callback
  // after `config.album.flush_ms` of silence. Optional so older T4-T8
  // tests still compile — when absent, every media message goes through
  // the single-media path (no album merging).
  albumBuffer?: AlbumBuffer<AlbumEntry>
  // PR-A3 (2026-05-20): InboundWatcher fires an auto-reply «Тралл занят»
  // when the warchief sends plain text mid-tool. Optional so older tests
  // compile — when absent, the watcher branch is skipped and behaviour
  // matches the pre-A3 path. Insertion point in handleInboundText sits
  // AFTER OOB resolution and BEFORE gateAndNotify: OOB still wins, and
  // Claude still receives the channel notification regardless.
  watcher?: InboundWatcher
  // TmuxMirror control surface, used by /mirror OOB command. Optional —
  // when tmux_mirror.enabled=false at startup the mirror instance is
  // never created and the OOB handler replies «disabled in config».
  tmuxMirror?: TmuxMirrorControl
  // Multichat router. When present together with `policy`, all gated
  // inbound traffic is dispatched to the per-chat tmux session via
  // `router.dispatch(InboundMessage)` instead of the legacy
  // sendChannelNotification path. Absent in legacy single-chat
  // deployments — handlers fall back to the historical MCP notify path.
  router?: MultichatRouter
  // Multichat policy. Drives gate.ts group-chat allowlist, addressing
  // mention_allowlist, and per-chat behaviour. MUST be paired with
  // `router` to flip the dispatch path; passing one without the other
  // is a wiring bug at the server.ts level (Batch 5 enforces this).
  policy?: MultichatPolicy
}

// Coerce grammY's reply_to_message Message shape into the narrower
// TelegramReplyMessage that prompt/build.ts consumes. Only the fields the
// classifier uses are forwarded — full Message type carries dozens of
// service-message fields that the prompt builder ignores by design.
function adaptReply(
  reply: NonNullable<Context['message']>['reply_to_message'] | undefined,
): TelegramReplyMessage | undefined {
  if (!reply) return undefined
  const out: TelegramReplyMessage = {
    message_id: reply.message_id,
    date: reply.date,
  }
  if (reply.from) {
    out.from = {
      id: reply.from.id,
      is_bot: reply.from.is_bot,
      ...(reply.from.username !== undefined ? { username: reply.from.username } : {}),
    }
  }
  if (reply.text !== undefined) out.text = reply.text
  if (reply.caption !== undefined) out.caption = reply.caption
  return out
}

// PR-A3 — auto-reply gate. The InboundWatcher must never fire for
// senders/chats that aren't on the allowlist: a future group-chat use of
// the bot would otherwise leak bot activity to non-allowed senders. We
// mirror the OOB short-circuit's allowlist check (allowed_user_ids AND
// allowed_chat_ids — defence in depth even when the gate lets the message
// through). DM-only is NOT required here; auto-reply makes sense in any
// allowlisted chat. Returns true when the watcher is permitted to fire.
function watcherAllowed(
  ctx: Context,
  config: AppConfig,
  policy?: MultichatPolicy,
): boolean {
  const senderNum = ctx.from?.id
  const chatNum = ctx.chat?.id
  if (senderNum === undefined || chatNum === undefined) return false
  // Multichat: defer to policy.allowlist for both user and chat. Symmetric
  // with the gate's group branch — a sender allowed by policy in a
  // policy-listed chat may trigger the auto-reply even in a group.
  if (policy) {
    const userOk = policy.allowlist.users.includes(String(senderNum))
    const chatOk = policy.allowlist.chats.includes(String(chatNum))
    return userOk && chatOk
  }
  if (!config.allowed_user_ids.includes(senderNum)) return false
  // allowed_chat_ids may be a mix of strings and numbers — coerce both
  // sides to string for comparison, same as the OOB block does.
  const allowedChatSet = new Set(config.allowed_chat_ids.map((v) => String(v)))
  if (!allowedChatSet.has(String(chatNum))) return false
  return true
}

// Fire-and-forget watcher trigger. Encapsulates the allowlist gate +
// `void`/`.catch` boilerplate so every inbound handler (text + media) can
// invoke the watcher with one call. Optional `deps.watcher` makes this a
// no-op when the watcher isn't configured — older tests stay compatible.
function maybeTriggerWatcher(ctx: Context, deps: HandlerDeps): void {
  if (!deps.watcher) return
  if (!watcherAllowed(ctx, deps.config, deps.policy)) return
  const chatNum = ctx.chat?.id
  const msgId = ctx.message?.message_id
  if (chatNum === undefined || msgId === undefined) return
  void deps.watcher
    .maybeAutoReply({ chatId: String(chatNum), messageId: msgId })
    .catch((err) => {
      deps.log.warn('watcher auto-reply error (ignored)', {
        chat_id: String(chatNum),
        error: err instanceof Error ? err.message : String(err),
      })
    })
}

// Fire-and-forget mirror bump. Triggered by an inbound message from an
// allowed sender so the rolling tmux-mirror message is re-anchored at
// the bottom of the chat (warchief asked for this 2026-05-20: the mirror
// was scrolling up out of view as the conversation progressed). Reuses
// the same allowlist gate as the watcher so a non-allowed message never
// disturbs the mirror. `bump` is optional on TmuxMirrorControl, so when
// the wired mirror predates this method we silently skip.
function maybeBumpMirror(ctx: Context, deps: HandlerDeps): void {
  if (!deps.tmuxMirror?.bump) return
  if (!watcherAllowed(ctx, deps.config, deps.policy)) return
  const chatNum = ctx.chat?.id
  if (chatNum === undefined) return
  void deps.tmuxMirror.bump().catch((err) => {
    deps.log.warn('tmux mirror bump error (ignored)', {
      chat_id: String(chatNum),
      error: err instanceof Error ? err.message : String(err),
    })
  })
}

// Extract the four fields the gate cares about from a grammY Context. Kept
// separate so unit tests for gate.ts don't need a real Context shape.
function gateInputFromContext(ctx: Context): GateInput {
  const chatType = ctx.chat?.type
  const chatId = ctx.chat?.id !== undefined ? String(ctx.chat.id) : undefined
  const senderId = ctx.from?.id !== undefined ? String(ctx.from.id) : undefined
  const isBot = ctx.from?.is_bot
  return {
    // grammY's chat.type is a wider union (incl. 'channel') — we narrow here.
    chatType: chatType as GateInput['chatType'],
    chatId,
    senderId,
    isBot,
  }
}

// Shared metadata layout. Identifier-style keys only — notify.normalizeMeta
// will silently drop hyphens, but we never emit them in the first place.
function buildMeta(
  decision: { kind: 'allow'; senderId: string; chatId: string },
  ctx: Context,
): Record<string, string> {
  const meta: Record<string, string> = {
    source: 'telegram',
    chat_id: decision.chatId,
    user_id: decision.senderId,
    ts: new Date().toISOString(),
  }
  if (ctx.message?.message_id !== undefined) {
    meta.message_id = String(ctx.message.message_id)
  }
  return meta
}

// Common gate+notify body. Each per-kind handler computes its primary text
// and (in T8+) a list of MediaDescriptors via buildMedia. We render the
// descriptors and feed them to buildChannelContent so the agent sees
// `<media .../>` tags above the user's text and reply block.
async function gateAndNotify(
  ctx: Context,
  deps: HandlerDeps,
  buildText: () => string,
  buildMedia: (() => Promise<MediaDescriptor[]>) | undefined,
  kind: string,
): Promise<void> {
  const input = gateInputFromContext(ctx)
  // Multichat-aware gate: policy unlocks group/supergroup paths. Without
  // policy the legacy "DM-only or drop" behaviour is preserved by gate.ts.
  const decision = gateTelegramMessage(input, deps.config, deps.policy)
  if (decision.kind === 'drop') {
    deps.log.debug('inbound dropped', {
      reason: decision.reason,
      chat_type: input.chatType,
      kind,
      // sender_id / chat_id only at debug — operator can opt in via LOG_LEVEL.
      sender_id: input.senderId,
      chat_id: input.chatId,
    })
    return
  }

  // Group/supergroup addressing gate: only senders in `mention_allowlist`
  // (typically just the warchief) may summon the bot via @-mention or
  // reply-to-bot. Silent drop — no reaction, no notify, no router dispatch.
  // DM passes through unchanged because isAddressedToBot returns true for
  // private chats regardless of the allowlist parameter.
  if (deps.policy && input.chatType !== 'private') {
    const addressed = isAddressedToBot(ctx, deps.policy.mention_allowlist)
    if (!addressed) {
      deps.log.debug('handlers.not_addressed', {
        chat_id: decision.chatId,
        user_id: decision.senderId,
        kind,
      })
      return
    }
  }

  // Media build runs ONLY after the gate allows the message — never download
  // or transcribe for un-allowlisted senders. Mirrors gateway.py: download
  // path is guarded by allowlist check at 2117+ (auto_transcribe_group_voice
  // is invoked from already-allowlisted handlers).
  const descriptors = buildMedia ? await buildMedia() : []
  const renderedMedia = descriptors.map(renderMediaDescriptor)

  // Router path: when wired, dispatch to the per-chat tmux session via
  // file-based inbox instead of MCP-notifying the master session. The
  // router takes full ownership — no fallback to sendChannelNotification
  // so the master Claude session never sees traffic that belongs to a
  // different chat (defence in depth, persona isolation).
  if (deps.router && deps.policy) {
    // Open a status before dispatch — symmetric with the legacy path so
    // the user sees "Печатает..." within a tick. Streaming is per-chat
    // gated inside StatusManager.start via `streamingEnabled`.
    if (deps.statusManager && deps.config.status.enabled) {
      try {
        await deps.statusManager.start(decision.chatId, ctx.message?.message_id)
      } catch (err) {
        deps.log.warn('status start failed (continuing without status)', {
          chat_id: decision.chatId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    // Extract media local paths from descriptors. Only `photo` carries
    // localPath today (downloaded inline in handleInboundPhoto); the
    // rest are pure metadata — the tmux session can call
    // `download_attachment` if it wants the bytes. We filter to defined
    // strings so the DTO never holds `undefined` entries.
    const mediaPaths = descriptors
      .map((m) =>
        m.kind === 'photo' && typeof m.localPath === 'string' ? m.localPath : undefined,
      )
      .filter((p): p is string => p !== undefined)

    // Reply-context payload: serialise via the same buildChannelContent
    // helper so the tmux side sees the identical `<reply>` block format
    // the master session would have received. Cheap defence against
    // schema drift between the two paths.
    const replyContext = ctx.message?.reply_to_message
      ? buildChannelContent({
          text: '',
          bot: deps.bot,
          reply: adaptReply(ctx.message.reply_to_message)!,
        })
      : undefined

    const inboundMsg: InboundMessage = {
      text: buildText(),
      chat_id: decision.chatId,
      user_id: decision.senderId,
      user:
        ctx.from?.username !== undefined
          ? ctx.from.username
          : ctx.from?.first_name !== undefined
            ? ctx.from.first_name
            : 'unknown',
      timestamp: new Date().toISOString(),
      ...(replyContext !== undefined ? { reply_context: replyContext } : {}),
      ...(mediaPaths.length > 0 ? { media_paths: mediaPaths } : {}),
    }

    deps.log.info('inbound dispatched to router', { kind, chat_id: decision.chatId })
    try {
      await deps.router.dispatch(inboundMsg)
    } catch (err) {
      // Router errors are logged and swallowed inside dispatch() for the
      // pool/spawn/inbox-write branches, but a top-level throw is still
      // possible (e.g. policy mutation mid-flight). Surface as throw so
      // the poller dead-letters the update — symmetric with the legacy
      // sendChannelNotification path.
      throw new Error(
        `router dispatch failed — ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    return
  }

  // Legacy path: MCP-notify the master Claude session. Kept for the
  // single-chat (DM-only) wiring; will be removed once all deployments
  // run multichat.
  const content = buildChannelContent({
    text: buildText(),
    bot: deps.bot,
    ...(ctx.message?.reply_to_message
      ? { reply: adaptReply(ctx.message.reply_to_message)! }
      : {}),
    ...(renderedMedia.length > 0 ? { mediaDescriptors: renderedMedia } : {}),
  })

  const event: ChannelEvent = {
    content,
    meta: buildMeta(decision, ctx),
  }

  // Open a status before notifying the channel — this way the user sees
  // "Печатает..." within a tick of sending their message, not after the
  // first tool call completes. Errors here are best-effort: a failed
  // sendMessage must not block delivery of the actual channel event.
  if (deps.statusManager && deps.config.status.enabled) {
    const replyTo = ctx.message?.message_id
    try {
      await deps.statusManager.start(decision.chatId, replyTo)
    } catch (err) {
      deps.log.warn('status start failed (continuing without status)', {
        chat_id: decision.chatId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  deps.log.info('inbound delivered', { kind, chat_id: decision.chatId })
  const delivered = await sendChannelNotification(deps.server, event, deps.log)
  if (!delivered) {
    // Throw so the poller dead-letters this update AND advances offset (it
    // does that on every handler throw). We never want infinite redelivery
    // for a notify-transport failure — the channel may be torn down.
    throw new Error('channel notify failed — message dead-lettered')
  }
}

// ─────────────────────────────────────────────────────────────────────
// Album path — buffer media-group items and emit ONE combined channel
// notification after `config.album.flush_ms` of silence. Mirrors
// gateway.py:3154-3234 (_buffer_media_group + _flush_media_group).
// ─────────────────────────────────────────────────────────────────────

// Try to route this update into the album buffer. Returns true if the
// item was buffered (caller MUST NOT continue with single-media path).
// Returns false when the message has no media_group_id or no buffer
// configured — caller proceeds with the existing gateAndNotify flow.
async function tryRouteToAlbumBuffer(
  ctx: Context,
  deps: HandlerDeps,
  buildDescriptors: () => Promise<MediaDescriptor[]>,
  kind: string,
): Promise<boolean> {
  const mgid = ctx.message?.media_group_id
  if (!mgid) return false
  if (!deps.albumBuffer) return false

  // Gate FIRST — never download/transcribe for non-allowlisted senders,
  // and never start an album buffer entry for a dropped sender either
  // (otherwise allowlisted noise could be merged into a denied bucket).
  const input = gateInputFromContext(ctx)
  const decision = gateTelegramMessage(input, deps.config, deps.policy)
  if (decision.kind === 'drop') {
    deps.log.debug('inbound dropped', {
      reason: decision.reason,
      chat_type: input.chatType,
      kind,
      sender_id: input.senderId,
      chat_id: input.chatId,
    })
    return true // we *handled* it (by dropping) — do NOT fall through
  }

  // Group addressing gate (mention_allowlist). Symmetric with gateAndNotify
  // so albums posted in a group by a non-allowlisted sender silently drop
  // without spawning a buffer entry.
  if (deps.policy && input.chatType !== 'private') {
    const addressed = isAddressedToBot(ctx, deps.policy.mention_allowlist)
    if (!addressed) {
      deps.log.debug('handlers.album.not_addressed', {
        chat_id: decision.chatId,
        user_id: decision.senderId,
        kind,
      })
      return true
    }
  }

  const descriptors = await buildDescriptors()
  const rendered = descriptors.map(renderMediaDescriptor)
  const caption = (ctx.message?.caption ?? '').trim()
  const reply = ctx.message?.reply_to_message
    ? adaptReply(ctx.message.reply_to_message)
    : undefined
  const mediaPaths = descriptors
    .map((m) => (m.kind === 'photo' && typeof m.localPath === 'string' ? m.localPath : undefined))
    .filter((p): p is string => p !== undefined)
  const entry: AlbumEntry = {
    descriptors: rendered,
    mediaPaths,
    caption,
    messageId: ctx.message?.message_id,
    reply,
  }

  // Open the status transient on first inbound — gateway.py does this
  // on EVERY message but for albums one "Печатает..." per album is more
  // honest about what's happening. We attempt on every push; status
  // manager dedups via isActive check internally (best-effort).
  if (deps.statusManager && deps.config.status.enabled) {
    try {
      await deps.statusManager.start(decision.chatId, ctx.message?.message_id)
    } catch (err) {
      deps.log.warn('status start failed (continuing without status)', {
        chat_id: decision.chatId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const dispatchDeps: AlbumDispatchDeps = {
    server: deps.server,
    config: deps.config,
    log: deps.log,
    bot: deps.bot,
    telegramApi: deps.telegramApi,
    ...(deps.statusManager !== undefined ? { statusManager: deps.statusManager } : {}),
    ...(deps.router !== undefined ? { router: deps.router } : {}),
    ...(deps.policy !== undefined ? { policy: deps.policy } : {}),
  }
  const chatIdAtPush = decision.chatId
  const senderIdAtPush = decision.senderId
  // Capture sender's display handle at push time — by the time the album
  // flushes the ctx is long gone, and the router DTO requires a `user`.
  const userAtPush =
    ctx.from?.username !== undefined
      ? ctx.from.username
      : ctx.from?.first_name !== undefined
        ? ctx.from.first_name
        : 'unknown'

  deps.albumBuffer.push(mgid, entry, (album) => {
    void sendAlbumNotification(
      album,
      {
        chatId: chatIdAtPush,
        senderId: senderIdAtPush,
        user: userAtPush,
        mediaGroupId: mgid,
        kind,
      },
      dispatchDeps,
    )
  })
  deps.log.debug('album buffered', {
    kind,
    media_group_id: mgid,
    chat_id: decision.chatId,
  })
  return true
}

// Build one combined channel notification from a flushed Album. Captions
// are merged with blank-line separators (matches gateway.py:3184-3193);
// media descriptors are concatenated in insertion order; meta carries
// album_size and media_group_id so the agent can recognise this as a
// single album rather than a deluge of photos.
export async function sendAlbumNotification(
  album: Album<AlbumEntry>,
  ids: {
    chatId: string
    senderId: string
    user: string
    mediaGroupId: string
    kind: string
  },
  deps: AlbumDispatchDeps,
): Promise<void> {
  // Merge captions: non-empty in order, joined by blank line. This matches
  // gateway.py's `"\n\n".join(captions)`. When every caption is empty the
  // merged text is empty — buildChannelContent skips it correctly.
  const captions = album.messages.map((m) => m.caption).filter((c) => c.length > 0)
  const mergedText = captions.join('\n\n')

  // Concatenate all media descriptors in insertion order.
  const combinedDescriptors: string[] = []
  for (const m of album.messages) {
    for (const d of m.descriptors) combinedDescriptors.push(d)
  }

  // First non-null reply wins. Albums rarely contain replies, but if the
  // user replied with the first photo of the album we forward that context.
  const reply = album.messages.find((m) => m.reply !== undefined)?.reply

  // Router path: synthesise one InboundMessage that carries the merged
  // caption + every downloaded media path. Symmetric with the single-
  // message router branch in gateAndNotify so the tmux side sees a
  // consistent DTO shape regardless of album vs solo arrival.
  if (deps.router && deps.policy) {
    const combinedMediaPaths: string[] = []
    for (const m of album.messages) {
      for (const p of m.mediaPaths) combinedMediaPaths.push(p)
    }
    const replyContext = reply
      ? buildChannelContent({ text: '', bot: deps.bot, reply })
      : undefined
    const inboundMsg: InboundMessage = {
      text: mergedText,
      chat_id: ids.chatId,
      user_id: ids.senderId,
      user: ids.user,
      timestamp: new Date().toISOString(),
      ...(replyContext !== undefined ? { reply_context: replyContext } : {}),
      ...(combinedMediaPaths.length > 0 ? { media_paths: combinedMediaPaths } : {}),
    }
    deps.log.info('album dispatched to router', {
      kind: ids.kind,
      chat_id: ids.chatId,
      media_group_id: ids.mediaGroupId,
      album_size: album.messages.length,
    })
    try {
      await deps.router.dispatch(inboundMsg)
    } catch (err) {
      // Albums have no dead-letter path — match the legacy notify branch's
      // best-effort logging instead of throwing.
      deps.log.warn('album router dispatch failed — content lost', {
        media_group_id: ids.mediaGroupId,
        chat_id: ids.chatId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
    return
  }

  const content = buildChannelContent({
    text: mergedText,
    bot: deps.bot,
    ...(reply ? { reply } : {}),
    ...(combinedDescriptors.length > 0 ? { mediaDescriptors: combinedDescriptors } : {}),
  })

  const firstMessageId = album.messages[0]?.messageId
  const meta: Record<string, string> = {
    source: 'telegram',
    chat_id: ids.chatId,
    user_id: ids.senderId,
    ts: new Date().toISOString(),
    album_size: String(album.messages.length),
    media_group_id: ids.mediaGroupId,
  }
  if (firstMessageId !== undefined) {
    meta.message_id = String(firstMessageId)
  }

  const event: ChannelEvent = { content, meta }
  deps.log.info('album delivered', {
    kind: ids.kind,
    chat_id: ids.chatId,
    media_group_id: ids.mediaGroupId,
    album_size: album.messages.length,
  })
  const delivered = await sendChannelNotification(deps.server, event, deps.log)
  if (!delivered) {
    deps.log.warn('album notify failed — content lost (no dead-letter for album path)', {
      media_group_id: ids.mediaGroupId,
      chat_id: ids.chatId,
    })
  }
}

// ─────────────────────────────────────────────────────────────────────
// Text handler — no media descriptors.
// ─────────────────────────────────────────────────────────────────────

export async function handleInboundText(ctx: Context, deps: HandlerDeps): Promise<void> {
  const text = ctx.message?.text ?? ''

  // Auto-react 👀 on inbound — prince visibility signal, replaces typing indicator.
  // ONLY for messages addressed to this bot (DM, @mention, or reply to bot).
  // Without this gate the bot would react to every group message it sees.
  // Multichat: mention_allowlist further restricts which senders trigger the
  // reaction in groups (a non-warchief @mention is a silent no-op — no react).
  if (isAddressedToBot(ctx, deps.policy?.mention_allowlist)) {
    try {
      const _chatId = ctx.chat?.id
      const _msgId = ctx.message?.message_id
      if (_chatId !== undefined && _msgId !== undefined) {
        await deps.telegramApi.setMessageReaction(String(_chatId), _msgId, '👀')
      }
    } catch (_e) { /* react best-effort */ }
  }

  // Permission-text short-circuit. BEFORE the OOB check: when the sender is
  // an approver AND text matches `yes <id>` / `no <id>` AND that id is
  // currently pending, emit the verdict and DO NOT forward as a channel
  // notification. If the id is unknown, fall through so the text still
  // reaches the agent — a normal message like "yes abcde fix it" would
  // otherwise be lost. Mirrors refs/telegram-official/server.ts:412-443.
  // DM-only guard: permission verdicts (`yes <id>` / `no <id>`) MUST come
  // from a private chat. In a group/supergroup/channel we fall through to the
  // normal channel forward so the agent still sees the text — we never emit
  // a verdict from a non-DM context.
  if (deps.permissionHooks && ctx.from?.id !== undefined && ctx.chat?.type === 'private') {
    const decision = parsePermissionTextReply(text)
    if (decision && isPermissionApprover(ctx.from.id, deps.config)) {
      if (deps.permissionHooks.isPending(decision.requestId)) {
        deps.permissionHooks.consumePending(decision.requestId)
        await deps.permissionHooks.emitVerdict(decision)
        const chatNum = ctx.chat?.id
        const msgId = ctx.message?.message_id
        if (chatNum !== undefined && msgId !== undefined) {
          const emoji = decision.behavior === 'allow' ? '✅' : '❌'
          try {
            await deps.telegramApi.setMessageReaction(String(chatNum), msgId, emoji)
          } catch (err) {
            deps.log.debug('permission text reply reaction failed', {
              chat_id: String(chatNum),
              message_id: msgId,
              error: err instanceof Error ? err.message : String(err),
            })
          }
        }
        deps.log.info('permission text verdict', {
          request_id: decision.requestId,
          behavior: decision.behavior,
        })
        return
      }
      deps.log.warn('permission text reply with unknown request_id', {
        request_id: decision.requestId,
      })
      // fall through — text might genuinely be "yes abcde fix it" if the user
      // ever starts a sentence that way. Channel sees the message.
    }
  }
  // OOB short-circuit: when the sender is allowed AND the chat is a DM AND
  // the text parses as a known /command, handle it inline and DO NOT fall
  // through to the normal channel notification. Mirrors gateway.py:3037-3133
  // (_is_oob_command + _handle_oob_command running on the producer thread
  // before the consumer ever sees the update).
  const parsed = parseOobCommand(text, deps.bot.username)
  if (parsed) {
    const chatType = ctx.chat?.type
    const chatId = ctx.chat?.id !== undefined ? String(ctx.chat.id) : undefined
    const senderId = ctx.from?.id !== undefined ? String(ctx.from.id) : undefined
    const senderNum = ctx.from?.id
    const chatNum = ctx.chat?.id
    const allowedSender =
      senderNum !== undefined
      && deps.config.allowed_user_ids.includes(senderNum)
    // Defence-in-depth: even DM from allowed user must come from a chat in
    // allowed_chat_ids. The allowlists can drift (chat list tighter than user
    // list); without this check an OOB command could run from an unverified
    // chat slot. Coerce config ids to string for comparison since the gate
    // does the same elsewhere.
    const allowedChatSet = new Set(deps.config.allowed_chat_ids.map((v) => String(v)))
    const allowedChat = chatNum !== undefined && allowedChatSet.has(String(chatNum))
    if (chatType === 'private' && chatId && senderId && allowedSender && allowedChat) {
      const oobCtx: OobContext = {
        chatId,
        senderId,
        config: deps.config,
        telegramApi: deps.telegramApi,
        log: deps.log,
        botId: deps.bot.id,
        stateDir: deps.statePaths.root,
        ...(deps.statusManager
          ? {
              statusManager: {
                isActive: (id: string) => deps.statusManager!.isActive(id),
                cancel: (id: string, reason: string) => deps.statusManager!.cancel(id, reason),
              },
            }
          : {}),
        ...(deps.tmuxMirror ? { tmuxMirror: deps.tmuxMirror } : {}),
      }
      const result = await handleOobCommand(parsed, oobCtx)
      await executeOobResult(result, oobCtx, deps.server)
      return
    }
  }

  // PR-A3 watcher hook (after OOB resolution, before gate/notify): if Claude
  // is mid-tool for this chat, auto-reply «Тралл занят». Gated on the
  // allowlist — only allowed senders in allowed chats can trigger it.
  // Fire-and-forget — channel-notification latency must NOT depend on the
  // auto-reply round-trip. Auto-reply does NOT replace the channel notification
  // — gateAndNotify still runs below so Claude sees the message normally.
  maybeTriggerWatcher(ctx, deps)
  maybeBumpMirror(ctx, deps)

  await gateAndNotify(ctx, deps, () => text, undefined, 'text')
}

// ─────────────────────────────────────────────────────────────────────
// Photo — picks largest size, downloads to inbox after the gate allows.
// ─────────────────────────────────────────────────────────────────────

export async function handleInboundPhoto(ctx: Context, deps: HandlerDeps): Promise<void> {
  // PR-A3: same watcher hook as text. Media handlers must surface
  // «Тралл занят» too — otherwise a busy-session photo/voice silently waits.
  maybeTriggerWatcher(ctx, deps)
  maybeBumpMirror(ctx, deps)
  const buildPhoto = async (): Promise<MediaDescriptor[]> => {
    const sizes = ctx.message?.photo
    if (!sizes || sizes.length === 0) return []
    // Telegram photo array is sorted ascending by resolution — pick last.
    const largest = sizes[sizes.length - 1]
    if (!largest) return []

    const localPath = await downloadPhotoToInbox(
      deps.botApi,
      deps.botToken,
      largest.file_id,
      deps.statePaths.inbox,
    )

    const md: MediaDescriptor = {
      kind: 'photo',
      fileId: largest.file_id,
      ...(largest.file_unique_id !== undefined ? { uniqueId: largest.file_unique_id } : {}),
      ...(localPath !== undefined ? { localPath } : {}),
      ...(largest.width !== undefined ? { width: largest.width } : {}),
      ...(largest.height !== undefined ? { height: largest.height } : {}),
      ...(largest.file_size !== undefined ? { size: largest.file_size } : {}),
    }
    return [md]
  }
  if (await tryRouteToAlbumBuffer(ctx, deps, buildPhoto, 'photo')) return
  await gateAndNotify(ctx, deps, () => ctx.message?.caption ?? '', buildPhoto, 'photo')
}

// ─────────────────────────────────────────────────────────────────────
// Document — pure metadata, no download. Claude triggers download via the
// download_attachment tool when needed.
// ─────────────────────────────────────────────────────────────────────

export async function handleInboundDocument(ctx: Context, deps: HandlerDeps): Promise<void> {
  maybeTriggerWatcher(ctx, deps)
  maybeBumpMirror(ctx, deps)
  const buildDoc = async (): Promise<MediaDescriptor[]> => {
    const doc = ctx.message?.document
    if (!doc) return []
    const md: MediaDescriptor = {
      kind: 'document',
      fileId: doc.file_id,
      ...(doc.file_name !== undefined ? { name: doc.file_name } : {}),
      ...(doc.mime_type !== undefined ? { mime: doc.mime_type } : {}),
      ...(doc.file_size !== undefined ? { size: doc.file_size } : {}),
    }
    return [md]
  }
  if (await tryRouteToAlbumBuffer(ctx, deps, buildDoc, 'document')) return
  await gateAndNotify(ctx, deps, () => ctx.message?.caption ?? '', buildDoc, 'document')
}

// ─────────────────────────────────────────────────────────────────────
// Voice — calls Groq Whisper if GROQ_API_KEY is set. Transcript folds into
// the descriptor; failure does not crash.
// ─────────────────────────────────────────────────────────────────────

export async function handleInboundVoice(ctx: Context, deps: HandlerDeps): Promise<void> {
  maybeTriggerWatcher(ctx, deps)
  maybeBumpMirror(ctx, deps)
  await gateAndNotify(
    ctx,
    deps,
    () => ctx.message?.caption ?? '',
    async () => {
      const voice = ctx.message?.voice
      if (!voice) return []

      const transcription = await maybeTranscribeVoice(
        {
          fileId: voice.file_id,
          ...(voice.duration !== undefined ? { durationSec: voice.duration } : {}),
          ...(voice.file_size !== undefined ? { size: voice.file_size } : {}),
          ...(voice.mime_type !== undefined ? { mime: voice.mime_type } : {}),
          downloadFile: (fileId: string) =>
            deps.telegramApi.downloadFile(fileId, deps.statePaths.inbox),
        },
        deps.config,
        deps.env,
      )

      if (transcription.status === 'failed' || transcription.status === 'skipped') {
        deps.log.warn('voice transcription failed', {
          status: transcription.status,
          error: transcription.errorMessage,
        })
      }

      const md: MediaDescriptor = {
        kind: 'voice',
        fileId: voice.file_id,
        ...(voice.mime_type !== undefined ? { mime: voice.mime_type } : {}),
        ...(voice.file_size !== undefined ? { size: voice.file_size } : {}),
        ...(voice.duration !== undefined ? { durationSec: voice.duration } : {}),
        ...(transcription.transcript !== undefined
          ? { transcript: transcription.transcript }
          : {}),
        transcriptionStatus: transcription.status,
      }
      return [md]
    },
    'voice',
  )
}

// ─────────────────────────────────────────────────────────────────────
// Audio — metadata only (title/performer for songs).
// ─────────────────────────────────────────────────────────────────────

export async function handleInboundAudio(ctx: Context, deps: HandlerDeps): Promise<void> {
  maybeTriggerWatcher(ctx, deps)
  maybeBumpMirror(ctx, deps)
  const buildAudio = async (): Promise<MediaDescriptor[]> => {
    const audio = ctx.message?.audio
    if (!audio) return []
    const md: MediaDescriptor = {
      kind: 'audio',
      fileId: audio.file_id,
      ...(audio.file_name !== undefined ? { name: audio.file_name } : {}),
      ...(audio.title !== undefined ? { title: audio.title } : {}),
      ...(audio.performer !== undefined ? { performer: audio.performer } : {}),
      ...(audio.mime_type !== undefined ? { mime: audio.mime_type } : {}),
      ...(audio.file_size !== undefined ? { size: audio.file_size } : {}),
      ...(audio.duration !== undefined ? { durationSec: audio.duration } : {}),
    }
    return [md]
  }
  if (await tryRouteToAlbumBuffer(ctx, deps, buildAudio, 'audio')) return
  await gateAndNotify(ctx, deps, () => ctx.message?.caption ?? '', buildAudio, 'audio')
}

// ─────────────────────────────────────────────────────────────────────
// Video — metadata only.
// ─────────────────────────────────────────────────────────────────────

export async function handleInboundVideo(ctx: Context, deps: HandlerDeps): Promise<void> {
  maybeTriggerWatcher(ctx, deps)
  maybeBumpMirror(ctx, deps)
  const buildVideo = async (): Promise<MediaDescriptor[]> => {
    const video = ctx.message?.video
    if (!video) return []
    const md: MediaDescriptor = {
      kind: 'video',
      fileId: video.file_id,
      ...(video.file_name !== undefined ? { name: video.file_name } : {}),
      ...(video.mime_type !== undefined ? { mime: video.mime_type } : {}),
      ...(video.file_size !== undefined ? { size: video.file_size } : {}),
      ...(video.duration !== undefined ? { durationSec: video.duration } : {}),
      ...(video.width !== undefined ? { width: video.width } : {}),
      ...(video.height !== undefined ? { height: video.height } : {}),
    }
    return [md]
  }
  if (await tryRouteToAlbumBuffer(ctx, deps, buildVideo, 'video')) return
  await gateAndNotify(ctx, deps, () => ctx.message?.caption ?? '', buildVideo, 'video')
}

// ─────────────────────────────────────────────────────────────────────
// Video note — round selfie videos. Always square, no name/mime in the
// Telegram object (only length+duration+thumb).
// ─────────────────────────────────────────────────────────────────────

export async function handleInboundVideoNote(ctx: Context, deps: HandlerDeps): Promise<void> {
  maybeTriggerWatcher(ctx, deps)
  maybeBumpMirror(ctx, deps)
  await gateAndNotify(
    ctx,
    deps,
    () => '',
    async () => {
      const note = ctx.message?.video_note
      if (!note) return []
      const md: MediaDescriptor = {
        kind: 'video_note',
        fileId: note.file_id,
        ...(note.file_size !== undefined ? { size: note.file_size } : {}),
        ...(note.duration !== undefined ? { durationSec: note.duration } : {}),
      }
      return [md]
    },
    'video_note',
  )
}

// ─────────────────────────────────────────────────────────────────────
// Sticker — emoji + optional set name.
// ─────────────────────────────────────────────────────────────────────

export async function handleInboundSticker(ctx: Context, deps: HandlerDeps): Promise<void> {
  maybeTriggerWatcher(ctx, deps)
  maybeBumpMirror(ctx, deps)
  await gateAndNotify(
    ctx,
    deps,
    () => '',
    async () => {
      const sticker = ctx.message?.sticker
      if (!sticker) return []
      const md: MediaDescriptor = {
        kind: 'sticker',
        fileId: sticker.file_id,
        ...(sticker.emoji !== undefined ? { emoji: sticker.emoji } : {}),
        ...(sticker.set_name !== undefined ? { setName: sticker.set_name } : {}),
        ...(sticker.file_size !== undefined ? { size: sticker.file_size } : {}),
      }
      return [md]
    },
    'sticker',
  )
}
