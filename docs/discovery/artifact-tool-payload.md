# Artifact Tool Payload Discovery

Status: implementation baseline from local Claude Code research docs, not a live publish capture.

Claude Code hook payloads share common fields such as `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `tool_name`, and `tool_input`. Artifact publish is a tool call matched with `Artifact` in `PreToolUse` and `PostToolUse`.

ArtiLens treats the Artifact schema as unstable. Hook parsers search these possible fields defensively:

- source path: `tool_input.file_path`, `tool_input.path`, `tool_input.filename`, `tool_input.file`, `tool_input.artifact.file_path`
- inline source: `tool_input.content`, `tool_input.html`, `tool_input.markdown`
- title: `tool_input.title`, `tool_input.name`, parsed `<title>`, parsed first `<h1>`
- output URL: `tool_response.url`, `tool_response.artifact_url`, `tool_output.url`, first `https://claude.ai/code/artifact/...` in response text

Failure policy:

- If no artifact source can be found, hooks fail open and append a log record.
- If guard finds a high-confidence secret in extracted content, publish is denied.
- Registry snapshot errors never block publish.

Manual follow-up: run a real Artifact publish in Claude Code, capture PreToolUse and PostToolUse payloads, and replace this note with exact examples when available.
