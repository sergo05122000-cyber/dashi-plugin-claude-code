// Phase 8 / T4 — prompt-buffer tests.
//
// All time-sensitive assertions use a fake clock so tests don't rely on
// setTimeout latency.

import { describe, expect, test } from 'bun:test'
import { PromptBuffer } from '../../src/memory/prompt-buffer.js'

function fakeClock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start
  return {
    now: () => t,
    advance: (ms) => { t += ms },
  }
}

describe('PromptBuffer', () => {
  test('set + take returns the buffered prompt and removes it', () => {
    const c = fakeClock()
    const buf = new PromptBuffer(60_000, 100, c.now)
    buf.set('chat1', 'hello', 'sid-1')
    const v = buf.take('chat1')
    expect(v?.prompt).toBe('hello')
    expect(v?.sessionId).toBe('sid-1')
    expect(v?.ts).toBe(1_000_000)
    // Second take is a miss — entries are one-shot.
    expect(buf.take('chat1')).toBeUndefined()
  })

  test('take on unknown chatId returns undefined', () => {
    const buf = new PromptBuffer(60_000, 100)
    expect(buf.take('never-set')).toBeUndefined()
  })

  test('TTL expiry: take returns undefined and removes the stale entry', () => {
    const c = fakeClock()
    const buf = new PromptBuffer(60_000, 100, c.now)
    buf.set('chat1', 'hi', null)
    c.advance(60_001) // just past the TTL
    expect(buf.take('chat1')).toBeUndefined()
    // And the underlying map no longer holds the entry.
    expect(buf.size()).toBe(0)
  })

  test('TTL boundary: exactly ttlMs old is still valid (>, not >=)', () => {
    const c = fakeClock()
    const buf = new PromptBuffer(60_000, 100, c.now)
    buf.set('chat1', 'hi', null)
    c.advance(60_000)
    const v = buf.take('chat1')
    expect(v?.prompt).toBe('hi')
  })

  test('LRU cap: oldest chat is evicted when maxEntries exceeded', () => {
    const c = fakeClock()
    const buf = new PromptBuffer(60_000, 2, c.now)
    buf.set('chat1', 'p1', null)
    c.advance(10)
    buf.set('chat2', 'p2', null)
    c.advance(10)
    buf.set('chat3', 'p3', null) // chat1 evicted

    expect(buf.size()).toBe(2)
    expect(buf.take('chat1')).toBeUndefined()
    expect(buf.take('chat2')?.prompt).toBe('p2')
    expect(buf.take('chat3')?.prompt).toBe('p3')
  })

  test('overwriting same chatId bumps it to MRU', () => {
    const c = fakeClock()
    const buf = new PromptBuffer(60_000, 2, c.now)
    buf.set('chat1', 'old', null)
    c.advance(10)
    buf.set('chat2', 'mid', null)
    c.advance(10)
    buf.set('chat1', 'new', null) // chat1 is now MRU
    c.advance(10)
    buf.set('chat3', 'fresh', null) // should evict chat2, not chat1
    expect(buf.take('chat2')).toBeUndefined()
    expect(buf.take('chat1')?.prompt).toBe('new')
    expect(buf.take('chat3')?.prompt).toBe('fresh')
  })

  test('lazy evict on insert drops expired entries before LRU check', () => {
    const c = fakeClock()
    const buf = new PromptBuffer(1_000, 3, c.now)
    buf.set('a', 'pa', null)
    buf.set('b', 'pb', null)
    buf.set('c', 'pc', null)
    c.advance(2_000) // all three expire
    buf.set('d', 'pd', null) // evict-pass should clear a/b/c
    expect(buf.size()).toBe(1)
    expect(buf.take('d')?.prompt).toBe('pd')
  })

  test('sessionId null preserved through the round-trip', () => {
    const buf = new PromptBuffer(60_000, 10)
    buf.set('chat1', 'p', null)
    const v = buf.take('chat1')
    expect(v?.sessionId).toBeNull()
  })

  test('default clock is Date.now (smoke — no fake injection)', () => {
    const buf = new PromptBuffer(60_000, 10)
    buf.set('chat1', 'p', null)
    const before = Date.now()
    const v = buf.take('chat1')
    const after = Date.now()
    expect(v).toBeDefined()
    expect(v!.ts).toBeGreaterThanOrEqual(before)
    expect(v!.ts).toBeLessThanOrEqual(after)
  })
})
