// Policy loader for the multichat router. Parses `chats/policy.yaml`
// from a base directory, validates against a Zod schema in strict mode
// (unknown fields raise ZodError), and exposes typed accessors.
//
// Schema design rationale:
//   * `.strict()` on ChatPolicySchema catches typos before they become
//     silent misconfiguration (Zod's default strip would mask them).
//   * Chat-id keys are stringified — negative group ids must stay
//     quoted in YAML so they survive numeric coercion.
//   * Defaults for `idle_ttl_ms` (30 min) and `max_queue_depth` (1)
//     match the values declared in PLAN.md section 2 / 7 so a missing
//     entry in policy.yaml is interpreted identically across modules.

import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { JSON_SCHEMA, load as parseYaml } from 'js-yaml'
import { z } from 'zod'

// Per-chat deny rules. All three lists are optional; when omitted the
// pre-tool-use hook applies no restrictions for that category.
// `read_paths` and `mcp_tools` use glob (fnmatch) semantics in the hook;
// `bash_patterns` is matched as substring (case-insensitive) so the
// hook does not have to guess command word boundaries.
export const DenyRulesSchema = z
  .object({
    read_paths: z.array(z.string()).optional(),
    mcp_tools: z.array(z.string()).optional(),
    bash_patterns: z.array(z.string()).optional(),
  })
  .strict()

// One chat's policy. `.strict()` is critical — a typo in a YAML key
// (e.g. `streming` instead of `streaming`) will throw at load time
// rather than silently default to the wrong behaviour.
export const ChatPolicySchema = z
  .object({
    mode: z.enum(['private', 'public']),
    streaming: z.enum(['progress', 'off']),
    tmux_mirror: z.boolean(),
    edit_message_progress: z.boolean(),
    delivery: z.enum(['streamed', 'final_only']),
    persona_file: z.string().min(1),
    handoff_file: z.string().min(1),
    deny: DenyRulesSchema.optional(),
    system_reminder: z.string(),
    idle_ttl_ms: z.number().int().positive().default(1_800_000),
    max_queue_depth: z.number().int().positive().default(1),
  })
  .strict()

// Top-level policy.yaml shape. `version` is locked to 1 — a future
// breaking change should bump it and add a migration path.
export const MultichatPolicySchema = z
  .object({
    version: z.literal(1),
    allowlist: z
      .object({
        chats: z.array(z.string().min(1)),
        users: z.array(z.string().min(1)),
      })
      .strict(),
    mention_allowlist: z.array(z.string().min(1)),
    chats: z.record(z.string().min(1), ChatPolicySchema),
  })
  .strict()

export type DenyRules = z.infer<typeof DenyRulesSchema>
export type ChatPolicy = z.infer<typeof ChatPolicySchema>
export type MultichatPolicy = z.infer<typeof MultichatPolicySchema>

/**
 * Load and validate `policy.yaml` from a base directory.
 *
 * Reads `{basePath}/policy.yaml`, parses with js-yaml, and validates
 * against {@link MultichatPolicySchema}. Throws on missing file (the
 * caller decides whether multichat is required), invalid YAML
 * (YAMLException), or schema violation (ZodError). No error swallowing
 * here — callers must decide policy-vs-fatal.
 *
 * @param basePath directory containing `policy.yaml` (typically
 *   `~/.claude-lab/thrall/.claude/chats`)
 * @returns validated, fully-typed multichat policy
 */
export function loadPolicy(basePath: string): MultichatPolicy {
  const policyPath = join(basePath, 'policy.yaml')

  // M12 fix (2026-05-23): refuse to load a world-writable policy file.
  // policy.yaml is the source of truth for allowlists, persona files,
  // and deny rules — a world-writable mode (others-write bit set)
  // means any local user can rewrite the gate. We do NOT enforce
  // group-writable: in some deploys the file is owned by a deploy
  // group and that is fine. We also do not check ownership against
  // process.getuid(): the plugin may run under a service account
  // distinct from the file's owner (e.g. systemd DynamicUser=).
  //
  // statSync throws ENOENT to the caller via readFileSync's own
  // throw later, so we tolerate stat failures here (the next
  // readFileSync will produce a more useful error message).
  try {
    const st = statSync(policyPath)
    const worldWritable = (st.mode & 0o002) !== 0
    if (worldWritable) {
      throw new Error(
        `policy.yaml is world-writable (mode ${(st.mode & 0o777).toString(8)}) at ${policyPath} — refusing to load. ` +
          `Run \`chmod o-w ${policyPath}\` and retry.`,
      )
    }
  } catch (err) {
    // Only rethrow our own perms-error; let readFileSync below
    // surface "file not found" etc. with its native message.
    if (err instanceof Error && err.message.includes('world-writable')) {
      throw err
    }
  }

  const raw = readFileSync(policyPath, 'utf8')
  // H9 fix (2026-05-23): force JSON_SCHEMA so the parser only emits
  // JSON-compatible types (plain objects, arrays, strings, numbers,
  // booleans, null). js-yaml's DEFAULT_SCHEMA tolerates Date, RegExp,
  // and custom tags — none of which a policy file should ever produce,
  // and any of which could be a vector for prototype pollution or type
  // confusion if policy.yaml is ever influenced by an attacker.
  const parsed = parseYaml(raw, { schema: JSON_SCHEMA })
  return MultichatPolicySchema.parse(parsed)
}

/**
 * Look up a chat's policy by stringified chat id.
 *
 * Returns `null` when the chat is not declared in policy.yaml — the
 * caller must treat this as "chat not configured" (typically a hard
 * drop in the gate). Group chat ids are negative, so always pass the
 * id as a string (e.g. `"-1003784643974"`).
 *
 * @param policy loaded multichat policy
 * @param chatId stringified Telegram chat id
 * @returns the chat's policy, or `null` if not configured
 */
export function getChatPolicy(
  policy: MultichatPolicy,
  chatId: string,
): ChatPolicy | null {
  const entry = policy.chats[chatId]
  return entry ?? null
}
