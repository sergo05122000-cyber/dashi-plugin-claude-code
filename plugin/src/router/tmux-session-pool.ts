// Per-chat tmux session pool for the multichat router.
//
// Each chat that has passed gating gets exactly one long-lived tmux
// session running an interactive `claude` process. The pool owns:
//   * lifecycle (spawn, kill, watchdog idle-kill at policy.idle_ttl_ms)
//   * sessions.json persistence so we re-attach to live tmux sessions
//     after a plugin restart instead of orphaning them
//   * a per-chat mutex so two concurrent inbound messages for the same
//     chat never race spawn() — see PLAN.md section 1.E
//
// Architecture decisions baked in (PLAN.md section 2):
//   * One tmux session per chat (not N MCP transports). Communication is
//     file-based via inbox-bridge.ts — no Unix sockets.
//   * `spawn()` uses child_process.spawn (no shell) so chat ids and
//     paths cannot be injected through tmux command construction.
//   * sessions.json writes go through .tmp + rename for crash safety.
//   * loadSessions() prunes dead entries on startup via `tmux has-session`.
//
// Entrypoint contract: when {entrypointScript} is provided, tmux runs it
// as the session's foreground command. The script is expected to set up
// per-chat env (persona injection, hook config) and finally exec `claude`.
// When omitted (MVP), tmux runs `{claudeBinary}` directly — the
// SessionStart hook handles persona injection via CHAT_ID env.

import { spawn, type SpawnOptions } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { MultichatPolicy } from '../chats/policy-loader.ts'

// Environment variables that, if present in the plugin's own env, must
// NEVER be inherited by the spawned `claude` tmux session. Telegram /
// Groq / gbrain credentials belong to the plugin orchestrator, not to
// the user-facing claude instance — leaking them gives a compromised
// session unintended escalation paths. L7 fix (2026-05-23): we log a
// warning if any of these are set in our env so an operator catches
// accidental inheritance, and `spawnInternal` explicitly overrides
// PATH/HOME/USER on the tmux invocation rather than letting tmux pass
// the full parent env verbatim.
const SENSITIVE_ENV_VARS = [
  'TELEGRAM_BOT_TOKEN',
  'GROQ_API_KEY',
  'GBRAIN_BEARER',
  'GBRAIN_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
] as const

// In-memory + persisted view of a live tmux session.
export type SessionHandle = {
  chatId: string
  sessionName: string
  spawnedAt: number
  lastMessageAt: number
}

// Minimal logger contract — matches the shape used by status-manager and
// tmux-mirror so callers can pass the same instance.
export interface PoolLogger {
  info(msg: string, ctx?: object): void
  warn(msg: string, ctx?: object): void
  error(msg: string, ctx?: object): void
}

export interface TmuxSessionPoolOptions {
  policy: MultichatPolicy
  // Root for plugin state. sessions.json lives at {stateDir}/sessions.json;
  // per-chat dirs live at {stateDir}/chats/{chatId}/{inbox,outbox}.
  stateDir: string
  // Workspace root used for persona-relative path resolution by hooks
  // and as the canonical CLAUDE_WORKSPACE_DIR exported into the tmux
  // session. Typically `~/.claude-lab/thrall/.claude`.
  workspaceDir: string
  // Working directory for the spawned claude process. When provided,
  // tmux runs `new-session -c {chatsBasePath}` so that claude picks up
  // the workspace `.claude/settings.json` located at
  // `{chatsBasePath}/.claude/settings.json` (this is where the
  // SessionStart / PreToolUse hooks are registered — C4 fix).
  //
  // Defaults to `{workspaceDir}/chats` when omitted.
  chatsBasePath?: string
  claudeBinary?: string
  // Optional wrapper script. When set, tmux runs `{entrypointScript}`
  // instead of `claude` directly — the wrapper is responsible for
  // exec'ing claude with any extra env / flags. C1 fix: the wrapper
  // runs the inbox -> pty injection loop in the background and execs
  // claude in the foreground.
  entrypointScript?: string
  logger: PoolLogger
}

type SessionsFile = {
  version: 1
  sessions: Record<string, Omit<SessionHandle, 'chatId'>>
}

const SESSIONS_FILE_VERSION = 1
const DEFAULT_WATCHDOG_INTERVAL_MS = 60_000

/**
 * Manages the per-chat-id tmux session lifecycle.
 *
 * Thread-safety: getOrSpawn is the only public method that touches the
 * sessions map under concurrent inbound traffic — it serialises via
 * `pendingSpawns` so two callers for the same chatId resolve to the
 * same SessionHandle. All other public methods are intended to be
 * called from the router's single event loop and do not race.
 */
export class TmuxSessionPool {
  private readonly policy: MultichatPolicy
  private readonly stateDir: string
  private readonly workspaceDir: string
  private readonly chatsBasePath: string
  private readonly claudeBinary: string
  private readonly entrypointScript: string | undefined
  private readonly logger: PoolLogger
  private readonly sessionsFilePath: string

  // chatId -> live session metadata.
  private readonly sessions = new Map<string, SessionHandle>()

  // chatId -> in-flight spawn promise; subsequent callers await the
  // same promise instead of racing into duplicate tmux processes.
  private readonly pendingSpawns = new Map<string, Promise<SessionHandle>>()

  private watchdogHandle: ReturnType<typeof setInterval> | null = null

  constructor(opts: TmuxSessionPoolOptions) {
    this.policy = opts.policy
    this.stateDir = opts.stateDir
    this.workspaceDir = opts.workspaceDir
    // chatsBasePath is the cwd handed to tmux — claude's per-workspace
    // `.claude/settings.json` lookup is relative to cwd, so this MUST
    // point at the directory whose `.claude/` subdir contains our
    // hooks registration. Default mirrors the canonical Thrall layout
    // (`{workspace}/chats/.claude/settings.json`).
    this.chatsBasePath = opts.chatsBasePath ?? join(opts.workspaceDir, 'chats')
    this.claudeBinary = opts.claudeBinary ?? 'claude'
    this.entrypointScript = opts.entrypointScript
    this.logger = opts.logger
    this.sessionsFilePath = join(this.stateDir, 'sessions.json')

    // L7 audit: tmux inherits the parent process env unless we use
    // `-e` to override or `env -i` to wipe. Wiping is too aggressive
    // (claude needs PATH/HOME/USER and the user's normal toolchain),
    // so spawnInternal pins those three plus the chat-specific vars
    // and lets everything else inherit. Loud-warn for known-sensitive
    // vars so an operator notices a misconfigured systemd unit /
    // shell rc leaking credentials into the multichat sessions.
    for (const varName of SENSITIVE_ENV_VARS) {
      if (process.env[varName] !== undefined && process.env[varName] !== '') {
        this.logger.warn('pool.sensitive_env_inherited', {
          var: varName,
          note: 'tmux child will inherit; ensure plugin runs with these masked when not strictly required',
        })
      }
    }
  }

  /**
   * Return an alive session for `chatId`, spawning one if necessary.
   * Concurrent callers for the same chatId share the same in-flight
   * promise via {@link pendingSpawns}.
   *
   * H10 fix (2026-05-23): check order is now (1) sync pendingSpawns.get,
   * (2) sync sessions.get + await isAlive, (3) seed pendingSpawns and
   * spawn. The pre-fix order had `await isAlive` between the sessions
   * lookup and the pending lookup — in Node's current single-threaded
   * model that window can't actually race, but the pattern is brittle:
   * any future micro-task interleaving (e.g. async aliveness probes
   * over a socket) would open a duplicate-spawn hole. Checking pending
   * first is also strictly cheaper — it's a pure Map.get with no I/O.
   */
  async getOrSpawn(chatId: string): Promise<SessionHandle> {
    // 1. Synchronous: is a spawn already in flight for this chat?
    //    If so, join it — no need to probe tmux or seed a new promise.
    const pending = this.pendingSpawns.get(chatId)
    if (pending !== undefined) return pending

    // 2. Synchronous lookup + async aliveness probe. We split these
    //    so the await never sits between two Map reads (H10).
    const existing = this.sessions.get(chatId)
    if (existing !== undefined && (await this.isAlive(existing.sessionName))) {
      return existing
    }

    // 3. No pending spawn, no alive session — claim the chat by seeding
    //    pendingSpawns BEFORE awaiting spawnInternal so concurrent
    //    callers landing here in the same tick share the same promise.
    const promise = this.spawnInternal(chatId).finally(() => {
      this.pendingSpawns.delete(chatId)
    })
    this.pendingSpawns.set(chatId, promise)
    return promise
  }

  /**
   * Kill the tmux session for `chatId` (if any) and remove it from the
   * pool. Safe to call when no session exists.
   *
   * H7 fix (2026-05-23): after killing the tmux session we recursively
   * delete `state/chats/{chatId}/inbox` and `state/chats/{chatId}/outbox`.
   * Before this fix an idle-killed session left behind any half-written
   * outbox file (e.g. a partial JSON that the previous claude wrote
   * just before tmux died); on the next respawn the router's outbox
   * loop would deliver that stale message as if it came from the
   * freshly-spawned session — confusing the user and burning replies
   * against the wrong context. handoff.md is preserved on purpose:
   * it carries cross-session memory and MUST survive idle-kills.
   *
   * The router's outbox poller continues running in parallel; that is
   * fine because pollOutboxOnce treats a missing outbox dir as "no
   * messages" (readdir error → empty array) and the next dispatch()
   * will re-create the dirs via ensureChatStateDirs.
   */
  async kill(chatId: string): Promise<void> {
    const handle = this.sessions.get(chatId)
    if (handle === undefined) return
    try {
      await runTmux(['kill-session', '-t', handle.sessionName])
    } catch (err) {
      this.logger.warn('tmux kill-session failed', {
        chatId,
        sessionName: handle.sessionName,
        error: err instanceof Error ? err.message : String(err),
      })
    }
    this.sessions.delete(chatId)

    // H7: scrub per-chat queue directories. force:true treats missing
    // paths as success, so the second consecutive kill (or a kill on a
    // chat that never had any inbound traffic) is a no-op.
    const chatStateDir = join(this.stateDir, 'chats', chatId)
    try {
      await rm(join(chatStateDir, 'inbox'), { recursive: true, force: true })
      await rm(join(chatStateDir, 'outbox'), { recursive: true, force: true })
    } catch (cleanupErr) {
      this.logger.warn('tmux kill: queue cleanup failed', {
        chatId,
        error:
          cleanupErr instanceof Error
            ? cleanupErr.message
            : String(cleanupErr),
      })
    }

    await this.atomicSaveSessions().catch((saveErr) => {
      this.logger.error('sessions.json save failed after kill', {
        chatId,
        error: saveErr instanceof Error ? saveErr.message : String(saveErr),
      })
    })
  }

  /** True iff `tmux has-session -t {sessionName}` exits 0. */
  async isAlive(sessionName: string): Promise<boolean> {
    try {
      await runTmux(['has-session', '-t', sessionName])
      return true
    } catch {
      return false
    }
  }

  /** Mark the chat as having received a message just now. */
  touch(chatId: string): void {
    const handle = this.sessions.get(chatId)
    if (handle === undefined) return
    handle.lastMessageAt = Date.now()
    // Async-fire-and-forget — touch happens per message, blocking the
    // hot path on disk flush would add latency for no benefit.
    void this.atomicSaveSessions().catch((err) => {
      this.logger.warn('sessions.json save failed after touch', {
        chatId,
        error: err instanceof Error ? err.message : String(err),
      })
    })
  }

  /** Start the idle-kill watchdog. Idempotent. */
  startWatchdog(intervalMs: number = DEFAULT_WATCHDOG_INTERVAL_MS): void {
    if (this.watchdogHandle !== null) return
    this.watchdogHandle = setInterval(() => {
      this.runIdleCheck().catch((err) => {
        this.logger.error('watchdog idle check failed', {
          error: err instanceof Error ? err.message : String(err),
        })
      })
    }, intervalMs)
    // Don't keep the event loop alive solely for the watchdog —
    // server.ts owns shutdown via stopWatchdog().
    this.watchdogHandle.unref?.()
  }

  stopWatchdog(): void {
    if (this.watchdogHandle === null) return
    clearInterval(this.watchdogHandle)
    this.watchdogHandle = null
  }

  /**
   * Iterate live sessions, kill any whose idle time exceeds the
   * chat's policy.idle_ttl_ms (or the policy default if the chat is
   * absent from the policy — which would be a bug, but we still want
   * the pool to self-heal).
   */
  async runIdleCheck(): Promise<void> {
    const now = Date.now()
    const toKill: string[] = []
    for (const [chatId, handle] of this.sessions) {
      const chatPolicy = this.policy.chats[chatId]
      // 30min default mirrors policy-loader's Zod default.
      const ttl = chatPolicy?.idle_ttl_ms ?? 1_800_000
      const idle = now - handle.lastMessageAt
      if (idle > ttl) {
        this.logger.info('tmux session idle-kill', {
          chatId,
          sessionName: handle.sessionName,
          idleMs: idle,
          ttlMs: ttl,
        })
        toKill.push(chatId)
      }
    }
    for (const chatId of toKill) {
      await this.kill(chatId)
    }
  }

  /**
   * Load sessions.json from disk, then prune entries whose tmux
   * sessions are no longer alive. Call once at router startup before
   * accepting traffic.
   */
  async loadSessions(): Promise<void> {
    if (!existsSync(this.sessionsFilePath)) return
    let parsed: SessionsFile
    try {
      const raw = await readFile(this.sessionsFilePath, 'utf8')
      parsed = JSON.parse(raw) as SessionsFile
    } catch (err) {
      this.logger.warn('sessions.json unreadable; starting empty', {
        path: this.sessionsFilePath,
        error: err instanceof Error ? err.message : String(err),
      })
      return
    }
    if (parsed.version !== SESSIONS_FILE_VERSION) {
      this.logger.warn('sessions.json version mismatch; ignoring', {
        expected: SESSIONS_FILE_VERSION,
        got: parsed.version,
      })
      return
    }

    for (const [chatId, meta] of Object.entries(parsed.sessions)) {
      const handle: SessionHandle = { chatId, ...meta }
      if (await this.isAlive(handle.sessionName)) {
        this.sessions.set(chatId, handle)
      } else {
        this.logger.info('pruning dead tmux session from sessions.json', {
          chatId,
          sessionName: handle.sessionName,
        })
      }
    }
    // Persist the pruned set so next boot does not retry the same
    // dead sessions.
    await this.atomicSaveSessions()
  }

  // ─────────────────────────────────────────────────────────────────
  // Internals
  // ─────────────────────────────────────────────────────────────────

  private async spawnInternal(chatId: string): Promise<SessionHandle> {
    // C3 fix (2026-05-23): refuse to spawn for a chat without an
    // explicit ChatPolicy entry, even if it sits in allowlist.chats.
    // A missing policy entry means SessionStart can't load persona +
    // system_reminder, PreToolUse can't load deny rules — master Thrall
    // would launch without isolation. Hard error is better than a
    // silent persona-less spawn that leaks gbrain MCP into a public
    // group.
    if (!this.policy.chats[chatId]) {
      throw new Error(
        `tmux-session-pool: chat ${chatId} not found in policy.chats — ` +
          `refusing to spawn. Add a ChatPolicy entry to policy.yaml ` +
          `before allowing this chat.`,
      )
    }

    const sessionName = buildSessionName(chatId)

    // Guard against stale map entries pointing to a session that died
    // since the last touch.
    if (await this.isAlive(sessionName)) {
      const stamp = Date.now()
      const handle: SessionHandle = {
        chatId,
        sessionName,
        spawnedAt: stamp,
        lastMessageAt: stamp,
      }
      this.sessions.set(chatId, handle)
      await this.atomicSaveSessions()
      return handle
    }

    // C4 fix (2026-05-23): cwd MUST be chatsBasePath so claude's
    // workspace-settings lookup finds `{chatsBasePath}/.claude/
    // settings.json` (the file that registers SessionStart + PreToolUse
    // hooks). CLAUDE_WORKSPACE_DIR is still exported because the
    // SessionStart hook reads persona / policy via it — those files
    // live one level up at `{workspaceDir}/chats/{CHAT_ID}/...`.
    //
    // TMUX_PANE: tmux auto-populates this inside each pane, but we
    // pass it through explicitly so the entrypoint wrapper's
    // background watcher (which runs in a subshell) is guaranteed
    // to see it. Defence in depth — covers shells / wrappers that
    // strip non-whitelisted env on inherit.
    //
    // L7 env-filter (2026-05-23): we pin PATH, HOME, USER explicitly
    // alongside the chat-specific vars. tmux still inherits the rest
    // of the parent env, but the explicit pins ensure that even if
    // the plugin runs under a stripped-env wrapper (systemd
    // Environment= directives, restrictive shells) the spawned
    // claude session still has the basics it needs to start.
    // `env -i` would be more rigorous but tmux + shell startup
    // breaks under a truly empty env in unpredictable ways; opt for
    // explicit-override + sensitive-var audit (constructor warn).
    const args = [
      'new-session',
      '-d',
      '-s',
      sessionName,
      '-e',
      `CHAT_ID=${chatId}`,
      '-e',
      `MULTICHAT_STATE_DIR=${this.stateDir}`,
      '-e',
      `CLAUDE_WORKSPACE_DIR=${this.workspaceDir}`,
      '-e',
      `PATH=${process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin'}`,
      '-e',
      `HOME=${process.env.HOME ?? ''}`,
      '-e',
      `USER=${process.env.USER ?? ''}`,
      '-e',
      'TMUX_PANE',
      '-c',
      this.chatsBasePath,
      // Run wrapper if provided, else claude directly. The wrapper is
      // expected to perform the inbox -> pty injection (C1 fix) and
      // finally `exec claude`.
      this.entrypointScript ?? this.claudeBinary,
    ]

    try {
      await runTmux(args)
    } catch (err) {
      this.logger.error('tmux new-session failed', {
        chatId,
        sessionName,
        error: err instanceof Error ? err.message : String(err),
      })
      throw err
    }

    const stamp = Date.now()
    const handle: SessionHandle = {
      chatId,
      sessionName,
      spawnedAt: stamp,
      lastMessageAt: stamp,
    }
    this.sessions.set(chatId, handle)
    await this.atomicSaveSessions()

    this.logger.info('tmux session spawned', { chatId, sessionName })
    return handle
  }

  private async atomicSaveSessions(): Promise<void> {
    const payload: SessionsFile = {
      version: SESSIONS_FILE_VERSION,
      sessions: {},
    }
    for (const [chatId, handle] of this.sessions) {
      payload.sessions[chatId] = {
        sessionName: handle.sessionName,
        spawnedAt: handle.spawnedAt,
        lastMessageAt: handle.lastMessageAt,
      }
    }

    await mkdir(dirname(this.sessionsFilePath), { recursive: true })
    const tmp = `${this.sessionsFilePath}.tmp`
    await writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8')
    await rename(tmp, this.sessionsFilePath)
  }
}

// ──────────────────────────────────────────────────────────────────────
// Pure helpers (no class state)
// ──────────────────────────────────────────────────────────────────────

function buildSessionName(chatId: string): string {
  // tmux session names cannot contain `.` or `:`; chat ids are numeric
  // (group ids may start with `-`). The plain `multichat-{chatId}`
  // shape is safe for all current allowed chat ids.
  return `multichat-${chatId}`
}

function runTmux(args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const opts: SpawnOptions = {
      stdio: ['ignore', 'pipe', 'pipe'],
    }
    const child = spawn('tmux', args as string[], opts)
    let stderrBuf = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString('utf8')
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`tmux ${args.join(' ')} exited ${code}: ${stderrBuf.trim()}`))
    })
  })
}
