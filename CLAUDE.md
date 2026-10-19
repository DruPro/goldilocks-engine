# Goldilocks Discovery Engine — notes for Claude

This repo is a CLI that finds the cheapest architecture that meets quantified
requirements with high probability. Run it with `bun src/cli.ts <command>` (alias `gde`).
For any request to evaluate, compare or choose an architecture, use the `goldilocks`
skill in `.claude/skills/goldilocks/SKILL.md`.

## Rules
- The engine decides. Never rank, score or pick candidates yourself, and never edit
  numbers in `runs/`. Explain results only from `report.json` / `report.md`.
- Never fill in `approved_by` or run `gde approve` on the user's behalf. Approval is a
  human gate: show the file, then let the user run the approve command themselves.
- Tag every number you write into an input file with its source (`measured`,
  `document`, `expert`, `llm_guess`). Numbers you estimate are `llm_guess` and must be
  wide; the loader refuses narrow ones.
- Never present invented numbers as facts about real vendors or products. Use generic
  option names unless the user supplies real data.
- After changing code, run `bun test` (about 2 minutes) and `bun run typecheck`.

## Layout
- `src/` engine (core math, model, engine loop, agents, report), `tests/`
- `fixtures/cloud/` worked example; `templates/blank/` starting point for new problems
- `runs/<run_id>/` outputs: `report.html`, `report.md`, `report.json`, snapshots, events
