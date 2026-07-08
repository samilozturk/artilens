# Getting Started

1. Install dependencies and build:

   ```bash
   pnpm install
   pnpm build
   ```

2. Initialize a project:

   ```bash
   artilens init
   ```

3. Generate scrubbed data for a view (the CLI never renders HTML itself):

   ```bash
   artilens lens --latest --data .claude/artilens/lens.data.json
   ```

4. Use `/artilens:lens`, `/artilens:pr`, `/artilens:coverage`, or `/artilens:docs-health` from the plugin when the corresponding workflow appears — each skill reads the `--data` JSON and dispatches a background subagent that authors and publishes the artifact as a native Claude Code Artifact.

If Artifact publish is unavailable, ask the subagent to write the HTML to a local file instead so it can be opened in a browser.

