# Skills

The plugin ships ArtiLens skills for:

- `artilens:artifacts`
- `artilens:lens`
- `artilens:pr`
- `artilens:git`
- `artilens:coverage`
- `artilens:agents`
- `artilens:todos`
- `artilens:commands`
- `artilens:docs-health`
- `artilens:incident`
- `artilens:board`
- `artilens:compare`
- `artilens:release`
- `artilens:deps`

Every skill runs the CLI for deterministic, scrubbed data collection (recipe skills gather data from the conversation or repo instead), then dispatches a background subagent that authors and publishes the artifact HTML directly via the native `artifact-design` skill.

