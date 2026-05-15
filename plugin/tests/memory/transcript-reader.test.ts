// Phase 8 / T5 — transcript-reader tests.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readLastAssistantText } from '../../src/memory/transcript-reader.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dashi-transcript-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function write(name: string, content: string): string {
  const p = join(dir, name)
  writeFileSync(p, content, 'utf8')
  return p
}

function line(obj: unknown): string {
  return JSON.stringify(obj) + '\n'
}

describe('readLastAssistantText', () => {
  test('returns text from last assistant message with single text block', async () => {
    const path = write('t.jsonl',
      line({ message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }) +
      line({ message: { role: 'assistant', content: [{ type: 'text', text: 'hello back' }] } }),
    )
    expect(await readLastAssistantText(path)).toBe('hello back')
  })

  test('joins multiple text blocks with \\n', async () => {
    const path = write('t.jsonl',
      line({
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'part1' },
            { type: 'tool_use', id: 'tu', name: 'X', input: {} },
            { type: 'text', text: 'part2' },
          ],
        },
      }),
    )
    expect(await readLastAssistantText(path)).toBe('part1\npart2')
  })

  test('returns the LAST assistant message, not the first', async () => {
    const path = write('t.jsonl',
      line({ message: { role: 'assistant', content: [{ type: 'text', text: 'first' }] } }) +
      line({ message: { role: 'user', content: [{ type: 'text', text: 'next' }] } }) +
      line({ message: { role: 'assistant', content: [{ type: 'text', text: 'second' }] } }),
    )
    expect(await readLastAssistantText(path)).toBe('second')
  })

  test('skips assistant messages that have only tool_use blocks', async () => {
    const path = write('t.jsonl',
      line({ message: { role: 'assistant', content: [{ type: 'text', text: 'real reply' }] } }) +
      line({ message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu', name: 'X', input: {} }] } }),
    )
    expect(await readLastAssistantText(path)).toBe('real reply')
  })

  test('returns null when no assistant message exists', async () => {
    const path = write('t.jsonl',
      line({ message: { role: 'user', content: [{ type: 'text', text: 'only user' }] } }),
    )
    expect(await readLastAssistantText(path)).toBeNull()
  })

  test('returns null for empty file', async () => {
    const path = write('t.jsonl', '')
    expect(await readLastAssistantText(path)).toBeNull()
  })

  test('returns null when path does not exist (no throw)', async () => {
    expect(await readLastAssistantText(join(dir, 'missing.jsonl'))).toBeNull()
  })

  test('handles malformed JSON line gracefully by skipping it', async () => {
    const path = write('t.jsonl',
      line({ message: { role: 'assistant', content: [{ type: 'text', text: 'good' }] } }) +
      'this is not json\n',
    )
    expect(await readLastAssistantText(path)).toBe('good')
  })

  test('drops possibly-truncated first line when file > TAIL_BYTES', async () => {
    // Construct: a giant first line we DO NOT want to read, then a
    // smaller assistant text we expect to find. Total > 256 KB.
    const huge = JSON.stringify({
      message: { role: 'assistant', content: [{ type: 'text', text: 'X'.repeat(300_000) }] },
    }) + '\n'
    const wanted = JSON.stringify({
      message: { role: 'assistant', content: [{ type: 'text', text: 'KEEP-ME' }] },
    }) + '\n'
    const path = write('t.jsonl', huge + wanted)
    const out = await readLastAssistantText(path)
    expect(out).toBe('KEEP-ME')
  })

  test('ignores entries where message.content is not an array', async () => {
    const path = write('t.jsonl',
      line({ message: { role: 'assistant', content: 'string-not-array' } }) +
      line({ message: { role: 'assistant', content: [{ type: 'text', text: 'final' }] } }),
    )
    expect(await readLastAssistantText(path)).toBe('final')
  })
})
