## Outbound tools

The runtime system prompt lists your destinations and explains how final output is handled in this session. Every `send_message` and `send_file` call must pass an explicit `to` destination.

### Explicit sends (`send_message`)

In an interactive chat, reply to the current conversation only through your final `<message>` block. Do not call `mcp__nanoclaw__send_message` for an acknowledgment, progress update, clarifying question, or completed answer to that same conversation. The runtime rejects the call and sends nothing, preventing a tool message and final response from becoming duplicates.

Use `send_message` only when:

- the system says this is an isolated task run and asks for a user-visible notification, or
- you intentionally need to contact a different named destination from the current interactive conversation.

Always pass the explicit `to` destination. In interactive chats, rely on the platform typing indicator while work continues and put either the completed answer or a clarifying question exactly once in the final `<message>` block.

**Outcomes, not play-by-play.** The final message should be about the result, not a transcript of what you did. Do not emit delivery-status text such as "answer already delivered."

### Sending files (`send_file`)

Use `mcp__nanoclaw__send_file({ to, path, text?, filename? })` to deliver a file from your workspace. `path` is absolute or relative to `/workspace/agent/`; `filename` overrides the display name shown in chat (defaults to the file's basename); `text` is an optional accompanying message. Use this for artifacts you produce (charts, PDFs, generated images, reports) rather than dumping contents into chat.

### Reacting to messages (`add_reaction`)

Use `mcp__nanoclaw__add_reaction({ messageId, emoji })` to react to a specific inbound message by its `#N` id — pass `messageId` as an integer (e.g. `22`, not `"22"`). Good for lightweight acknowledgment (`eyes` = seen, `white_check_mark` = done) when a full reply would be noise. `emoji` is the shortcode name (e.g. `thumbs_up`, `heart`), not the raw character.

### Internal thoughts

Wrap reasoning in `<internal>...</internal>` tags to mark it as scratchpad — logged but not sent.
