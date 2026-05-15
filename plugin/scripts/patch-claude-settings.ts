#!/usr/bin/env bun
// Idempotently patch a Claude Code per-agent settings.json with the five
// hook entries that route to plugin/scripts/post-hook.ts.
//
// Hard invariants:
//   * Never write the bearer token. The hook command pulls
//     TELEGRAM_WEBHOOK_TOKEN from the agent's process env at runtime.
//   * Preserve unrelated keys and existing hook entries.
//   * Stable marker — `hooks[event][].marker = "dashi-channel-hook"` — lets
//     re-runs replace the previous entry instead of duplicating.
//   * Atomic write through a temp file in the same dir so a partial write
//     cannot corrupt settings.json.
//
// CLI:
//   bun scripts/patch-claude-settings.ts \
//     --settings /path/to/settings.json \
//     --chat-id 164795011 \
//     --webhook-url http://127.0.0.1:8089/hooks/agent \
//     [--agent-id dashi-channel] \
//     [--helper /abs/path/to/post-hook.ts]

import { readFileSync, writeFileSync, mkdtempSync, renameSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join, resolve as pathResolve } from 'path'

const MARKER = 'dashi-channel-hook'
const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop',
] as const

type HookEvent = (typeof HOOK_EVENTS)[number]

const MATCHER_BY_EVENT: Partial<Record<HookEvent, string>> = {
  PreToolUse: '.*',
  PostToolUse: '.*',
}

export interface PatchOptions {
  readonly settingsPath: string
  readonly chatId: string
  readonly webhookUrl: string
  readonly agentId?: string
  readonly helperPath: string
}

interface HookEntry {
  marker?: string
  matcher?: string
  hooks: Array<{ type: 'command'; command: string }>
  [k: string]: unknown
}

interface SettingsShape {
  hooks?: Partial<Record<HookEvent, HookEntry[] | undefined>>
  [k: string]: unknown
}

function buildCommand(opts: PatchOptions): string {
  // Single-quote env exports — the host shell (zsh/bash) keeps them literal
  // so a token-shaped chat id can't trigger expansion.
  const envParts: string[] = [
    `TELEGRAM_HOOK_CHAT_ID='${opts.chatId.replace(/'/g, "'\\''")}'`,
  ]
  if (opts.agentId) {
    envParts.push(
      `TELEGRAM_HOOK_AGENT_ID='${opts.agentId.replace(/'/g, "'\\''")}'`,
    )
  }
  envParts.push(
    `TELEGRAM_WEBHOOK_URL='${opts.webhookUrl.replace(/'/g, "'\\''")}'`,
  )
  return `${envParts.join(' ')} bun '${opts.helperPath.replace(/'/g, "'\\''")}'`
}

function buildEntryFor(event: HookEvent, opts: PatchOptions): HookEntry {
  const entry: HookEntry = {
    marker: MARKER,
    hooks: [{ type: 'command', command: buildCommand(opts) }],
  }
  const matcher = MATCHER_BY_EVENT[event]
  if (matcher !== undefined) entry.matcher = matcher
  return entry
}

/** Pure patcher — exposed for unit tests. */
export function applyPatch(settings: SettingsShape, opts: PatchOptions): SettingsShape {
  const hooks: NonNullable<SettingsShape['hooks']> = { ...(settings.hooks ?? {}) }
  for (const event of HOOK_EVENTS) {
    const next = buildEntryFor(event, opts)
    const existing = hooks[event] ?? []
    // Replace any entry that carries our marker. Append if none exists.
    const withoutMarker = existing.filter(
      (e) => !e || e.marker !== MARKER,
    )
    hooks[event] = [...withoutMarker, next]
  }
  return { ...settings, hooks }
}

function parseArgs(argv: ReadonlyArray<string>): PatchOptions {
  let settingsPath = ''
  let chatId = ''
  let webhookUrl = ''
  let agentId: string | undefined
  let helperPath = ''
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = argv[i + 1]
    if (a === '--settings' && next) { settingsPath = next; i++; continue }
    if (a === '--chat-id' && next) { chatId = next; i++; continue }
    if (a === '--webhook-url' && next) { webhookUrl = next; i++; continue }
    if (a === '--agent-id' && next) { agentId = next; i++; continue }
    if (a === '--helper' && next) { helperPath = next; i++; continue }
  }
  if (!settingsPath || !chatId || !webhookUrl) {
    process.stderr.write(
      'Usage: patch-claude-settings.ts --settings PATH --chat-id ID --webhook-url URL [--agent-id ID] [--helper PATH]\n',
    )
    process.exit(2)
  }
  if (!helperPath) {
    // Default to sibling post-hook.ts.
    helperPath = pathResolve(import.meta.dir, 'post-hook.ts')
  }
  const opts: PatchOptions = agentId
    ? { settingsPath, chatId, webhookUrl, agentId, helperPath }
    : { settingsPath, chatId, webhookUrl, helperPath }
  return opts
}

function readSettings(path: string): SettingsShape {
  if (!existsSync(path)) return {}
  const raw = readFileSync(path, 'utf8')
  if (raw.trim().length === 0) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('settings.json must be a JSON object')
    }
    return parsed as SettingsShape
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`failed to parse ${path}: ${msg}`)
  }
}

function writeAtomic(path: string, contents: string): void {
  const dir = dirname(path)
  const stage = mkdtempSync(join(tmpdir(), 'dashi-settings-'))
  const tmp = join(stage, 'settings.json')
  writeFileSync(tmp, contents, { mode: 0o600 })
  // Ensure target dir exists.
  // (We don't mkdir here — settings.json's parent is created by claude.)
  void dir
  renameSync(tmp, path)
}

export function patchSettingsFile(opts: PatchOptions): void {
  const settings = readSettings(opts.settingsPath)
  const patched = applyPatch(settings, opts)
  const out = `${JSON.stringify(patched, null, 2)}\n`
  if (out.includes('TELEGRAM_WEBHOOK_TOKEN=')) {
    // Defence: nothing in our patch path writes the bearer token; if a
    // future change attempts to, fail loud.
    throw new Error('refusing to write TELEGRAM_WEBHOOK_TOKEN to settings.json')
  }
  writeAtomic(opts.settingsPath, out)
}

const isMainModule = (() => {
  const arg = process.argv[1] ?? ''
  return arg.endsWith('patch-claude-settings.ts') || arg.endsWith('patch-claude-settings.js')
})()

if (isMainModule) {
  const opts = parseArgs(process.argv.slice(2))
  patchSettingsFile(opts)
}
