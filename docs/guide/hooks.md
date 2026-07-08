# Hooks

Required plugin hooks:

- `PreToolUse` with matcher `Artifact`: validates the page with `artilens hook guard`.
- `PostToolUse` with matcher `Artifact`: snapshots the published page with `artilens hook registry`.

Failure policy:

- High-confidence secrets deny publish.
- Guard or registry runtime failures fail open and log under `.claude/artilens/`.

Optional hooks are installed with:

```bash
artilens init --optional-hooks
```

They add context threshold nudges and event logging without automatic publishing.

