import { describe, expect, test } from 'bun:test'

import { reminderForChat, renderContext } from '../../scripts/channel-reminder.js'

describe('reminderForChat', () => {
  test('positive (DM) chat id → strict reply-tool reminder', () => {
    const r = reminderForChat('164795011')
    expect(r).toContain('mcp__dashi-channel__reply')
    expect(r).toContain('MUST')
  })

  test('negative (group) chat id → outbox-aware reminder, no forced reply', () => {
    const r = reminderForChat('-1003784643974')
    expect(r).toContain('public/multichat')
    expect(r).toContain('outbox')
    // Must NOT order a manual reply call in groups (the outbox delivers).
    expect(r).not.toContain('MUST go through')
  })

  test('absent chat id → generic DM-safe reminder', () => {
    const r = reminderForChat(undefined)
    expect(r).toContain('Telegram')
    expect(r).toContain('reply tool')
  })

  test('blank/whitespace chat id → generic', () => {
    expect(reminderForChat('   ')).toBe(reminderForChat(undefined))
  })
})

describe('renderContext', () => {
  test('emits the exact UserPromptSubmit additionalContext envelope', () => {
    const out = JSON.parse(renderContext('hello'))
    expect(out).toEqual({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: 'hello',
      },
    })
  })

  test('is single-line JSON (safe as sole stdout)', () => {
    expect(renderContext(reminderForChat('164795011')).includes('\n')).toBe(false)
  })
})

// Integration: run the hook as a real process and assert the executable
// contract (Codex/Fable review): exit 0, stdout = valid envelope only,
// stderr empty, private stdin never echoed, CHAT_ID never leaked.
import { spawnSync } from 'child_process'
import { join } from 'path'

const HOOK = join(import.meta.dir, '..', '..', 'scripts', 'channel-reminder.ts')

function runHook(chatId: string | undefined, stdin: string) {
  const env = { ...process.env }
  if (chatId === undefined) delete env.CHAT_ID
  else env.CHAT_ID = chatId
  return spawnSync('bun', [HOOK], { input: stdin, encoding: 'utf8', env })
}

describe('channel-reminder.ts — process contract', () => {
  test('DM: exit 0, stdout is the envelope only, stderr empty, no stdin/CHAT_ID leak', () => {
    const secret = 'PRIVATE-PROMPT-BODY-do-not-echo'
    const r = runHook('164795011', secret)
    expect(r.status).toBe(0)
    expect(r.stderr).toBe('')
    const parsed = JSON.parse(r.stdout)
    expect(parsed.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit')
    expect(parsed.hookSpecificOutput.additionalContext).toContain('mcp__dashi-channel__reply')
    expect(r.stdout).not.toContain(secret)
    expect(r.stdout).not.toContain('164795011')
  })

  test('group CHAT_ID → outbox-aware envelope, exit 0', () => {
    const r = runHook('-1003784643974', 'hi')
    expect(r.status).toBe(0)
    const parsed = JSON.parse(r.stdout)
    expect(parsed.hookSpecificOutput.additionalContext).toContain('outbox')
  })

  test('absent CHAT_ID → exit 0, generic envelope', () => {
    const r = runHook(undefined, 'hi')
    expect(r.status).toBe(0)
    expect(JSON.parse(r.stdout).hookSpecificOutput.additionalContext).toContain('Telegram')
  })
})
