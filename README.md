# Goldilocks Discovery Engine

A command-line tool that finds the **minimum viable set of solutions** to a system-design
problem: the cheapest architectures that meet your requirements with high probability,
without being over-built.

You describe the requirements, the options you could combine, and what you are unsure
about. The engine models that uncertainty with Bayesian inference, decides what is worth
measuring next, updates as evidence arrives, and produces a decision brief. Language
models can help draft inputs and explain results, but **code makes every decision**, and
every run reproduces byte for byte.

- TypeScript on [Bun](https://bun.sh), zero runtime dependencies (math, YAML, hashing all built in)
- 50 tests, including statistical acceptance tests of the inference
- Works offline; LLM agents are optional

---

## How it works

1. **Requirements (roots).** Each goal is a number with a band: e.g. p99 latency ≤ 40 ms
   (target 25), spend ≤ $2,600/month. Each root has a weight and a formula computing it
   for a given design.
2. **Solution space.** A catalog of dimensions (compute, store, queue…) and options. Every
   combination is a candidate. Hard gates (e.g. "ledger must be tamper-evident") filter
   candidates before any scoring.
3. **Uncertainty.** Unknown quantities (traffic, latencies, data volume) are a tree of
   parameters with priors. Each carries a source: `measured`, `document`, `expert` or
   `llm_guess` (guesses must be wide; narrow ones are refused).
4. **Scoring.** For each candidate and each of N parameter draws (particles), every
   requirement gets a slack (1 = at target, 0 = at the bound, negative = miss). A soft-min
   combines slacks into a fitness; **P(in zone)** is the share of draws where it is ≥ 0.
5. **Goldilocks set.** Candidates with P ≥ τ (default 0.85), keeping only those within
   (1 + ε) of the cheapest such candidate (default ε = 0.25). The cheapest is recommended.
6. **What to learn next.** For every parameter the engine computes **EVPPI**: the dollars
   that perfect knowledge of it could save. It measures the parameter with the best
   EVPPI/cost, or decomposes it into measurable parts if it can't be measured directly.
7. **Update.** Evidence updates the particles by tempered importance reweighting, with
   resampling and MCMC rejuvenation whenever the effective sample size drops below N/2.
8. **Stop.** When no measurement is worth its cost and the set has been stable for two
   iterations, or when the iteration budget runs out.

## The brief

Each run writes `report.html`, `report.md` and `report.json`:

1. **Recommended solutions:** P(in zone) with an interval, spend range, a margin chart per requirement
2. **Solution map:** candidates clustered into families by how their success probability falls
   as load grows (k-means++ and functional PCA), with the requirement each rejected family fails
3. **Minimum requirements:** binding vs. slack requirements, what each relaxation would admit, conflicts, requirements at risk
4. **Parameter ledger:** every parameter's source, prior → posterior, and EVPPI, plus how
   much the answer depends on guessed priors
5. **Next measurements:** ranked by EVPPI/cost, the learning path, and what would flip the recommendation
6. **Audit trail:** run id, manifest hash, event log, approvals, agent proposals

## Quick start

```sh
curl -fsSL https://bun.sh/install | bash   # once
bun install                                # dev types only
bun test                                   # ~2 minutes, 50 tests

bun src/cli.ts run --oracle truth          # worked example with simulated measurements
open runs/<run_id>/report.html
```

Start your own problem:

```sh
bun src/cli.ts init problems/my-problem    # small worked template
# edit problem.yaml, catalog.yaml, roots.yaml, decompositions.yaml, config.yaml
bun src/cli.ts approve roots problems/my-problem/roots.yaml --by "Your Name"
bun src/cli.ts run --inputs problems/my-problem
```

See [GUIDE.md](GUIDE.md) for the full walkthrough, including use from Claude Code.

## Commands

| Command | What it does |
|---|---|
| `init <dir>` | New problem from the blank template |
| `run [--inputs DIR] [--oracle truth\|prior] [--llm] [--set key=value]` | Run the loop; pauses when it needs a real measurement |
| `resume <run_id> [--evidence FILE] [--from-iter K]` | Continue a run, optionally with new approved evidence |
| `replay <run_id>` | Re-execute from the run folder with no network and compare every snapshot byte for byte |
| `rerun <run_id> --with FILE` | What-if: rerun with a changed input, then diff the two briefs |
| `approve roots\|evidence <file> --by NAME` | Human sign-off, bound to a hash of the content |
| `draft-roots --inputs DIR` | LLM drafts requirements from the problem statement (unapproved) |
| `draft-evidence <run_id> --notes "..."` | LLM turns measurement notes into an evidence record (unapproved) |
| `schemas` | Emit JSON Schemas for every input and record |

## Inputs

| File | Contents |
|---|---|
| `problem.yaml` | Objectives, constraints, hard gates |
| `roots.yaml` | Quantified requirements; must be approved by a person |
| `catalog.yaml` | Dimensions × options with fixed values or uncertain ranges |
| `decompositions.yaml` | Priors for drivers, and how nodes break down into finer parts |
| `config.yaml` | Seed, particles, τ, ε, β, budget, load axis, utility, model IDs |
| `evidence/*.yaml` | Observations with a likelihood model and an approval record |

## Reproducibility

- One seeded RNG; every random stream is named by (seed, module, iteration, purpose), so
  resuming from any snapshot matches an uninterrupted run exactly
- Portable `exp`/`log` (fdlibm ports) and canonical JSON, so hashes match across machines
- Each run folder holds `manifest.json` (config, input hashes, tool version, model IDs),
  `events.jsonl` (every step with input/output hashes), copied `inputs/`, `llm_cache/`,
  and `snapshots/iter_<k>.json`
- CI test: two runs and one replay produce identical snapshot hashes

## LLM agents (optional)

Six agents propose; code checks and decides. Each answer must pass a strict JSON schema
plus semantic checks; a rejected answer is retried twice with the errors, then the run
fails loudly. Responses are cached by hash of (model, prompts, schema), so reruns and
replays never call the API again.

| Agent | Proposes | Guardrails |
|---|---|---|
| requirements | a draft `roots.yaml` | unapproved until signed; source set by code |
| decomposer | sub-parameters for a node | must include a measurable child; must stay consistent with the current prior |
| hybrids | variants of existing options, only when no candidate is comfortably safe | inherit every fixed attribute; may only re-estimate ranges |
| evidence | an evidence record from free-text notes | every number must appear in the notes |
| critic | advice on the engine's checks | never stored in snapshots |
| explainer | prose for the brief | no digits; numbers only via placeholders filled by code |

Models default to `claude-opus-5-5` (requirements, decomposer, critic) and
`claude-sonnet-5-5` (evidence, explainer). Requires `ANTHROPIC_API_KEY`.

## Validation

| Check | Result on the worked example |
|---|---|
| 90% posterior intervals contain the truth (20 seeds, truth drawn from the prior) | 90.0%, inside the 99% band 86.7–93.3% |
| Measured parameters narrow | to 22% of prior width on average |
| Wrong picks vs. the engine's own probabilities | 1 in 20, against 0.92 expected (99% bound 3) |
| Picks over-built (true cost beyond ε of the true cheapest) | 0 of 20 |
| EVPPI ranks the planted decisive parameter first | 5 of 5 seeds |
| Replay, resume and run-twice | byte-identical |
| Adversarial LLM text changes any ranking | never |

## Limits

- The solution space is enumerated: practical up to roughly 2,000 combinations
- Choices are discrete; continuous settings must be listed as options
- One decision at one point in time
- Results are only as good as the formulas and ranges; the brief shows how much rests on guesses
- The Goldilocks set is guaranteed sound in probability, not complete: options whose
  feasibility hinges on parameters the engine judged not worth measuring may be left out
- The bundled example uses invented, vendor-neutral numbers

## Repository layout

```
src/cli.ts, src/commands.ts   command line
src/core/       RNG, portable math, distributions, safe formula evaluator, stats, eigen
src/model/      schemas (types + JSON Schema from one definition), loader, parameter tree
src/engine/     generator, evaluator, updater, selector, planner, clusterer, critic, oracle, loop
src/agents/     LLM client and cache, the six agents, number guard
src/report/     report data, markdown, HTML brief, SVG charts, rerun diff
src/approval.ts human approval gates
fixtures/cloud/ worked example (single-operator wallet and ledger platform)
templates/blank starting point for new problems
tests/          unit and acceptance tests
CLAUDE.md, .claude/skills/goldilocks/  instructions for using it from Claude Code
```
