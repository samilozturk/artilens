# Getting Started

## Public Install

1. Add the public GitHub marketplace and install the plugin from Claude Code:

   ```text
   /plugin marketplace add samilozturk/artilens
   /plugin install artilens@artilens-marketplace
   ```

2. Use a skill when the corresponding workflow appears:

   ```text
   /artilens:lens
   /artilens:usage
   /artilens:git
   /artilens:pr
   /artilens:docs-health
   ```

The marketplace install includes the bundled ArtiLens CLI. No global npm package
is required. Each skill generates scrubbed `--data` JSON through the bundled CLI
and dispatches a background subagent that authors and publishes the artifact as a
native Claude Code Artifact.

## Local Development

1. Install dependencies and build:

   ```bash
   pnpm install
   pnpm build
   ```

2. Initialize a project:

   ```bash
   pnpm cli -- init
   ```

3. Generate scrubbed data for a view:

   ```bash
   pnpm cli -- lens --latest --data .claude/artilens/lens.data.json
   ```

4. Test the plugin locally with `claude --plugin-dir ./plugin` or by adding the
   checkout as a local development marketplace.

If Artifact publish is unavailable, ask the subagent to write the HTML to a
local file instead so it can be opened in a browser.
