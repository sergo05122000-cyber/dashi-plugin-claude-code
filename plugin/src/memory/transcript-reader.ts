// Phase 8 / T5 — tail-read the last assistant text from a Claude
// transcript JSONL file.
//
// Claude Code persists each session as `~/.claude/projects/<slug>/<sid>.jsonl`
// with one JSON object per line. We're interested in the last line whose
// `message.role === 'assistant'` and whose `message.content` array has
// at least one `{type: 'text', text: ...}` block — that's the text the
// user would have seen at the end of the turn. Tool-use only assistant
// messages are skipped (they have content[].type === 'tool_use').
//
// Strategy: open the file, read at most the trailing TAIL_BYTES bytes
// to keep memory bounded on multi-megabyte transcripts, drop the first
// (possibly-truncated) line when we didn't start at byte 0, then walk
// the lines backward and return the first parseable assistant text.
//
// All errors are swallowed and surface as `null` — the caller treats
// "no agent text" as "(inline)". Missing files, permission denied,
// malformed JSON, schema drift — none of them should block the hot/
// verbose writes for the user side.

import { open, type FileHandle } from 'node:fs/promises'

const TAIL_BYTES = 256 * 1024

export async function readLastAssistantText(
  transcriptPath: string,
): Promise<string | null> {
  let handle: FileHandle | undefined
  try {
    handle = await open(transcriptPath, 'r')
    const st = await handle.stat()
    if (st.size === 0) return null
    const len = Math.min(st.size, TAIL_BYTES)
    const start = st.size - len
    const buf = Buffer.alloc(len)
    await handle.read(buf, 0, len, start)
    const text = buf.toString('utf8')

    // Drop possibly-truncated first chunk if we didn't start at byte 0;
    // also filter empty lines so a trailing newline doesn't produce an
    // empty parse attempt.
    const split = text.split('\n')
    const lines = (start > 0 ? split.slice(1) : split).filter((l) => l.length > 0)

    for (let i = lines.length - 1; i >= 0; i--) {
      // Permissive parse: valid JSON with the wrong shape (null, a bare
      // array, a string, …) used to bypass the per-line try/catch and
      // throw at the next `obj.message?.role` access, escaping to the
      // OUTER catch and short-circuiting earlier valid assistant text.
      // Each line is now its own boundary — shape mismatch = skip, not
      // abort.
      let obj: unknown
      try {
        obj = JSON.parse(lines[i]!)
      } catch {
        continue
      }
      if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) continue
      const msg = (obj as { message?: unknown }).message
      if (typeof msg !== 'object' || msg === null) continue
      const role = (msg as { role?: unknown }).role
      if (role !== 'assistant') continue
      const content = (msg as { content?: unknown }).content
      if (!Array.isArray(content)) continue
      const parts: string[] = []
      for (const c of content) {
        if (typeof c !== 'object' || c === null) continue
        const block = c as { type?: unknown; text?: unknown }
        if (block.type === 'text' && typeof block.text === 'string') {
          parts.push(block.text)
        }
      }
      if (parts.length > 0) return parts.join('\n')
    }
    return null
  } catch {
    return null
  } finally {
    if (handle) {
      try {
        await handle.close()
      } catch {
        // close() race on an already-closed handle is harmless
      }
    }
  }
}
