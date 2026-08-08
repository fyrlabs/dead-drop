# CLAUDE.md

The instructions for this repository live in [AGENTS.md](AGENTS.md). Read that file.

It is kept as the single source so the guidance cannot drift between tools. Nothing repository-specific belongs here; add it to AGENTS.md instead.

Quick orientation while you fetch it:

```bash
npm install
npm run verify      # lint, build, tests with coverage thresholds. Must pass.
```

AGENTS.md covers the layout, the nine invariants that are bugs to break even when tests pass, the commit convention, and the platform traps that have already caused real failures here.
