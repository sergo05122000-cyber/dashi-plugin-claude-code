// Phase 8 / T4 — per-chatId TTL+LRU buffer of the last UserPromptSubmit.
//
// Claude's UserPromptSubmit hook fires when the user submits a prompt;
// Stop fires when the turn ends. We need the prompt text at Stop time
// to write a turn entry (user line in recent.md, user field in
// verbose.jsonl), but the Stop payload itself doesn't carry the prompt.
// This buffer holds the most recent UserPromptSubmit per chatId until
// the matching Stop arrives.
//
// Eviction strategy:
//   - TTL: entries older than ttlMs are dropped at insert and at take.
//   - LRU cap: at most maxEntries simultaneous chats; on overflow we
//     drop the oldest (Map iteration is insertion order in V8/Bun).
// A fake `now()` injection makes time-based tests deterministic.

export interface BufferedPrompt {
  prompt: string
  ts: number // ms timestamp at buffering (now()).
  sessionId: string | null
}

export class PromptBuffer {
  private map = new Map<string, BufferedPrompt>()

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * Buffer a prompt for `chatId`. Overwrites any prior entry. Evicts
   * expired entries first (lazy O(k) where k = expired count), then
   * drops the oldest entry if we'd exceed maxEntries.
   */
  set(chatId: string, prompt: string, sessionId: string | null): void {
    this.evict()
    // Delete-then-set bumps insertion order so the new entry is "newest"
    // even when we're overwriting an existing chatId — keeps LRU
    // semantics correct on repeated submits from the same chat.
    this.map.delete(chatId)
    if (this.map.size >= this.maxEntries) {
      const oldest = this.map.keys().next().value
      if (oldest !== undefined) this.map.delete(oldest)
    }
    this.map.set(chatId, { prompt, ts: this.now(), sessionId })
  }

  /**
   * Atomically read-and-remove the buffered prompt for `chatId`.
   * Returns undefined if no entry exists or if the entry has expired.
   * Removing on read prevents stale prompts from leaking into a later
   * Stop that belongs to a different turn (or a different agent run).
   */
  take(chatId: string): BufferedPrompt | undefined {
    const v = this.map.get(chatId)
    if (!v) return undefined
    if (this.now() - v.ts > this.ttlMs) {
      this.map.delete(chatId)
      return undefined
    }
    this.map.delete(chatId)
    return v
  }

  /** Test-only: how many entries are currently buffered. */
  size(): number {
    return this.map.size
  }

  private evict(): void {
    const cutoff = this.now() - this.ttlMs
    for (const [k, v] of this.map) {
      if (v.ts < cutoff) {
        this.map.delete(k)
      } else {
        // Map iteration is insertion order — once we hit an entry that
        // hasn't expired, every later entry is even fresher.
        break
      }
    }
  }
}
