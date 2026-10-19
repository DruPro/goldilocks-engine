# Running the Goldilocks Discovery Engine locally and with Claude Code

## 1. Set up (once)

1. Install Bun: `curl -fsSL https://bun.sh/install | bash` (Windows: see bun.sh).
2. Unzip the project and enter it:
   ```sh
   unzip goldilocks-phase3.zip -d goldilocks && cd goldilocks
   bun install          # dev types only; the engine has no runtime dependencies
   bun test             # about 2 minutes; expect 50 pass
   ```
3. Optional shortcut: `alias gde="bun $(pwd)/src/cli.ts"` (add it to your shell profile).
4. Optional, for the LLM agents: `export ANTHROPIC_API_KEY=...`. Everything except
   `--llm`, `draft-roots` and `draft-evidence` works without it.

Try the worked example: `gde run --oracle truth`, then open
`runs/<run_id>/report.html` in a browser.

## 2. Try a new problem by hand

```sh
gde init problems/my-cache          # copies templates/blank (a small worked example)
# edit problems/my-cache/{problem,catalog,roots,decompositions,config}.yaml
gde approve roots problems/my-cache/roots.yaml --by "Your Name"
gde run --inputs problems/my-cache
```

What each file holds:

| File | You describe |
|---|---|
| `problem.yaml` | goals and constraints in words, plus hard pass/fail gates |
| `catalog.yaml` | the choices: dimensions × options, each with attributes (`value` for facts, `range` for estimates, each with a source) |
| `roots.yaml` | each requirement as a number: bound, target, weight, and a formula for it |
| `decompositions.yaml` | uncertain drivers the formulas use (traffic, data size, load) |
| `config.yaml` | τ, ε, particles, budget; set `axis.node` to the main load driver and `utility.spend_root` to the spend requirement |

If the run stops with "waiting for a measurement of X": measure it, then
```sh
gde draft-evidence <run_id> --notes "five reads: 2.4, 2.9, 2.7, 3.1, 2.5 ms"   # or write the file
gde approve evidence runs/<run_id>/drafts/<file>.yaml --by "Your Name"
gde resume <run_id> --evidence runs/<run_id>/drafts/<file>.yaml
```
What-if: `gde rerun <run_id> --with my-changed-catalog.yaml`, then read `diff.md`.

## 3. Use it from Claude Code

1. Install Claude Code (instructions: https://docs.claude.com/en/docs/claude-code/overview)
   and start it in the project folder: `cd goldilocks && claude`.
2. Claude Code reads `CLAUDE.md` automatically, and the `goldilocks` skill in
   `.claude/skills/goldilocks/` gives it the step-by-step workflow. Nothing else to
   configure.
3. Ask in plain words, for example:
   > Use the goldilocks skill. We need to pick a job queue for an order pipeline:
   > 2k jobs/s peak, p99 enqueue under 20 ms, under $1,500/month, one on-call engineer.
   > Options we are considering: managed queue, self-hosted broker on VMs, database-backed queue.
4. Claude scaffolds `problems/<name>/`, writes the catalog and requirements with you,
   and asks what it cannot infer. It shows you the roots and stops; you approve them
   yourself with `gde approve roots …`. Then it runs the engine and explains the brief.
5. Keep going in the same session: "what if the managed queue costs twice as much?"
   (rerun with diff), "plan the next measurement", "explain why family F3 fails".

Claude is told never to rank options itself, never to sign approvals, and to label any
number it estimates as `llm_guess`, so the engine stays the decision-maker.

## 4. Good to know
- Practical size: up to roughly 2,000 option combinations at default settings.
- Choices must be discrete; list sizes or counts as separate options.
- Answers are only as good as the formulas and ranges; the brief shows how much rests
  on guessed numbers.
