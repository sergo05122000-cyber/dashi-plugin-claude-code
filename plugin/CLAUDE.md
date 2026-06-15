# Jarvis Channel Runtime — how you reach the user

This Claude Code session is **not** a normal terminal. It runs inside a tmux
session bridged to **Telegram** by the `dashi-channel` MCP server. Inbound
Telegram messages are injected into this session; that is how the user talks to
you.

**The user reads Telegram. They do NOT read this terminal, your transcript, or
your ordinary assistant final message.** If you only "answer" in the terminal,
the user sees nothing.

## The one rule

In a **direct chat**, every reply, question, confirmation, status update, or
final answer meant for the user MUST be sent with the reply tool before you end
the turn:

```
mcp__dashi-channel__reply({ chat_id, text })   // chat_id comes from the inbound <channel> tag
```

Never end a turn that owes the user a response without calling `reply`. A Stop
hook auto-forwards your final text as a backup, but it cannot deliver a mid-turn
question and may lose formatting — call `reply` explicitly, do not rely on the
fallback.

## Public group / multichat chats

For group/supergroup chats the channel **outbox** path delivers your final text
automatically — do not manually re-send it (that double-posts). The invariant
still holds: terminal-only text is never visible to the user, so put anything
they must see into the turn's delivered output.

## Mid-turn messages (system-reminders with `<channel>` tags)

When Telegram delivers a NEW message while you are still generating a response to
the PREVIOUS message, Claude Code injects it as a `system-reminder` tagged
**"IMPORTANT: This is NOT from your user"**. This is situational awareness only.

**Rules for mid-turn `<channel>` system-reminders:**
1. Do NOT respond to the new message in the current turn.
2. Do NOT include any reference to or answer for the new message in your current
   `reply()` call.
3. Finish the current turn as if the new message did not exist.
4. The new message will arrive as the next user prompt automatically — handle it then.

Violating this causes duplicate responses: the user sees an answer to the old
message that also contains an answer to the new message, and then another answer
to the new message in the next turn.

## Reminders

A UserPromptSubmit hook re-states this on every turn — heed it. This file and
that hook are the durable form of the channel discipline; the MCP server states
it only once at session start.
