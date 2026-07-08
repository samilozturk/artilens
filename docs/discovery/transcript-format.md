# Transcript Format Discovery

Status: implementation baseline from local Claude Code research docs.

Claude Code stores transcripts as JSONL under:

- `CLAUDE_CONFIG_DIR/projects/<project-key>/<session-id>.jsonl`
- `%USERPROFILE%/.claude/projects/...` on Windows
- `~/.claude/projects/...` on Unix

Each line is a JSON-safe object. Known useful fields:

- `timestamp`
- `type`
- `message.role`
- `message.content`
- `message.usage`
- tool blocks inside `message.content[]` with `type: "tool_use"` or `type: "tool_result"`

Subagent transcripts may live below `subagents/`; large tool outputs may spill to `tool-results/`. The active transcript path is most reliable from hook or statusline input via `transcript_path`.

Parser rules for ArtiLens:

- Bad JSON line: count as `parseErrors` and continue.
- Unknown shape: count as `unknownLines` and continue.
- Token totals use `message.usage` first. Missing usage falls back to `bytes / 4` and is marked estimated.
- Raw transcript content is never embedded in dashboards; examples are scrubbed and trimmed.
