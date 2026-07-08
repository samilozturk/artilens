# Hooks

Required plugin hooks:

- `PostToolUse` with matcher `Artifact`: snapshots the published page with the
  bundled registry hook.

Failure policy:

- Registry runtime failures fail open and log under `.claude/artilens/`.

Optional hooks are installed with:

```bash
pnpm cli -- init --optional-hooks
```

They add context threshold nudges and event logging without automatic
publishing. When installed from the public plugin, these project hooks are
written as `node "<installed-plugin>/scripts/*.mjs"` commands so they do not
require a global `artilens` executable.
