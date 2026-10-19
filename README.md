# Goldilocks Discovery Engine

**Find viable solutions. Eliminate unnecessary complexity. Learn what matters before you commit.**

Goldilocks is a requirements-driven system-design discovery engine. It searches a defined space of possible architectures to identify cost-efficient solutions that meet minimum requirements with a sufficiently high probability of success.

Instead of starting with a preferred architecture and trying to make it work, Goldilocks starts with the problem:

**What are the simplest, most cost-effective solutions that could meet these requirements—and what do we need to learn before choosing one?**

You define the requirements, available building blocks, uncertain assumptions, and measurement costs. Goldilocks explores the combinations, evaluates their feasibility under uncertainty, identifies the viable candidates, and prioritizes the information most likely to improve the decision.

The result is not a claim that one architecture is universally best. It is a reproducible, evidence-driven map of the solutions worth considering.

## Why Goldilocks?

System design is a search problem.

A backend can combine different compute environments, databases, storage systems, queues, deployment models, and transaction-integrity mechanisms. Each choice introduces trade-offs in cost, performance, reliability, and complexity.

The challenge is not simply finding a design that works. It is finding one that meets the actual requirements without paying for capabilities you do not need.

Goldilocks approaches this problem by:

* **Searching the design space:** systematically evaluating combinations of available options.
* **Enforcing minimum requirements:** rejecting candidates that violate hard constraints.
* **Modeling uncertainty:** estimating how likely each candidate is to satisfy the requirements when key inputs are not known precisely.
* **Finding the Goldilocks set:** retaining sufficiently reliable candidates near the cost of the cheapest qualifying solution.
* **Prioritizing learning:** estimating which measurements could meaningfully change the decision.
* **Maintaining an audit trail:** making runs reproducible, inspectable, and comparable.

The goal is not to build the most sophisticated architecture. It is to discover which solutions are sufficient, affordable, and worth pursuing.

## How it works

### 1. Define the problem

Describe what the system must accomplish, what it must never violate, and what you are optimizing.

Requirements are quantified wherever possible—for example:

* Monthly infrastructure spend must stay below a budget.
* p99 latency must remain below a limit.
* A transaction ledger must satisfy a tamper-evidence requirement.

Each requirement has a target, an acceptable bound, a weight, and a formula for evaluating a candidate design.

Hard constraints filter out invalid candidates before scoring begins.

### 2. Build the solution space

Represent the available design choices in a catalog.

For example:

| Dimension             | Possible options                                |
| --------------------- | ----------------------------------------------- |
| Compute               | VPS, serverless                                 |
| Database              | PostgreSQL, other catalogued options            |
| Storage               | Local or object storage                         |
| Transaction integrity | Database-only, additional tamper-evident ledger |

These are illustrative choices, not a claim that the engine includes every technology by default.

Goldilocks enumerates the combinations defined by the catalog and evaluates each as a candidate solution. It does not assume that the first plausible architecture is the only one worth exploring.

### 3. Model what you don't know

Real design decisions involve uncertainty: future traffic, data volume, latency, operating costs, and other quantities may not be known precisely.

Goldilocks represents uncertain quantities with probability distributions called **priors**. Each parameter records the source of its estimate, such as a measurement, documentation, expert judgment, or an LLM-generated guess.

Guesses must use sufficiently broad uncertainty ranges rather than presenting false precision.

The engine samples possible scenarios—called *particles*—to evaluate how candidate architectures behave across the modeled uncertainty.

### 4. Evaluate feasibility and cost

For each candidate, Goldilocks evaluates the requirements across the sampled scenarios.

It estimates **P(in zone)**: the proportion of modeled scenarios in which the candidate satisfies the scoring criteria.

The default qualifying threshold is 0.85, or 85%.

Goldilocks then identifies the *Goldilocks set*: candidates whose estimated probability of success meets the threshold and whose cost falls within a specified tolerance of the cheapest qualifying candidate.

By default, that tolerance is 25%.

The cheapest qualifying candidate is recommended, while the other candidates remain available for comparison.

This balances cost against modeled feasibility rather than selecting the cheapest option regardless of risk—or the most expensive option simply because it appears safer.

### 5. Discover what is worth measuring

Sometimes the biggest obstacle to making a good decision is not a lack of candidate architectures. It is uncertainty about one or two important inputs.

Goldilocks estimates the **Expected Value of Partial Perfect Information (EVPPI)** for uncertain parameters.

In practical terms, it asks:

*If we could eliminate uncertainty about this particular factor, how much could that knowledge improve our decision, in expected dollar terms?*

The engine ranks measurements by their estimated value relative to their cost. When a parameter cannot be measured directly, the parameter decomposition model can identify finer-grained quantities to investigate.

This helps direct effort toward the unknowns most likely to change the outcome.

### 6. Update the decision as evidence arrives

As new evidence is approved and introduced, Goldilocks updates its probability model.

It uses tempered importance reweighting, resampling, and MCMC rejuvenation when effective sample size falls below half the particle count.

The engine can then reevaluate candidates and reprioritize measurements.

The process stops when no remaining measurement is worth its cost and the Goldilocks set has remained stable for two iterations, or when the configured iteration budget is exhausted.

## What you get

Each run generates three reports:

* `report.html` — a visual decision brief.
* `report.md` — a portable Markdown summary.
* `report.json` — structured results for programmatic inspection.

The brief includes:

| Output                | Purpose                                                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------ |
| Recommended solutions | Estimated success probabilities, intervals, cost ranges, and requirement margins                 |
| Solution map          | Groups of candidates with similar behavior as load increases, including why rejected groups fail |
| Requirement analysis  | Binding constraints, available slack, conflicts, and the consequences of relaxing requirements   |
| Parameter ledger      | Sources, prior-to-posterior changes, EVPPI, and dependence on uncertain assumptions              |
| Measurement plan      | Ranked investigations, estimated value, and evidence that could change the recommendation        |
| Audit trail           | Run identifiers, input hashes, event history, approvals, and agent proposals                     |

The result is more than a ranked list. It is a record of why the candidates were evaluated the way they were, what remains uncertain, and what could change the answer.

## Quick start

### Requirements

* [Bun](https://bun.sh/)
* The repository and its dependencies
* An Anthropic API key only if you want to use the optional LLM agents

The core engine is designed to work offline without runtime dependencies. LLM-assisted drafting and explanation are optional.

### Run the worked example

```bash
# Install Bun if needed:
curl -fsSL https://bun.sh/install | bash

# Install development dependencies
bun install

# Run the test suite
bun test

# Run the worked example using simulated measurements
bun src/cli.ts run --oracle truth

# Open the generated HTML brief
open runs/<run_id>/report.html
```

Replace `<run_id>` with the identifier created by the run.

The bundled example models a single-operator wallet and ledger platform using invented, vendor-neutral numbers. It demonstrates the workflow; its results are not production cost estimates or recommendations for a real deployment.

### Start your own discovery problem

```bash
# Create a problem from the starter template
bun src/cli.ts init problems/my-problem
```

Edit the generated configuration files:

* `problem.yaml` — objectives, constraints, and hard gates.
* `roots.yaml` — quantified requirements.
* `catalog.yaml` — design dimensions and available options.
* `decompositions.yaml` — uncertainty drivers and their breakdowns.
* `config.yaml` — inference settings, thresholds, budget, and model configuration.
* `evidence/*.yaml` — observations and their likelihood models.

Approve the requirements before running the engine:

```bash
bun src/cli.ts approve roots problems/my-problem/roots.yaml --by "Your Name"

bun src/cli.ts run --inputs problems/my-problem
```

See [`GUIDE.md`](GUIDE.md) for the full walkthrough, including use from Claude Code.

## Command reference

| Command                                 | Purpose                                         |
| --------------------------------------- | ----------------------------------------------- |
| `init <dir>`                            | Create a problem from the starter template      |
| `run`                                   | Run the discovery and measurement loop          |
| `resume <run_id>`                       | Continue a run with optional new evidence       |
| `replay <run_id>`                       | Replay a recorded run and compare snapshots     |
| `rerun <run_id> --with <file>`          | Run a what-if scenario with changed inputs      |
| `approve roots <file> --by <name>`      | Record human approval of requirements           |
| `approve evidence <file> --by <name>`   | Record human approval of evidence               |
| `draft-roots --inputs <dir>`            | Draft requirements from a problem statement     |
| `draft-evidence <run_id> --notes "..."` | Draft an evidence record from measurement notes |
| `schemas`                               | Emit JSON Schemas for inputs and records        |

Use `bun src/cli.ts <command> --help` where supported to inspect command options.

## Reproducibility and auditability

Architecture recommendations are only useful if their reasoning can be inspected and their results reproduced.

Goldilocks is designed around deterministic execution:

* A seeded random-number generator with named streams.
* Portable mathematical functions and canonical JSON serialization.
* Input, configuration, and tool-version hashes.
* An event log recording execution steps and input/output hashes.
* Snapshots that allow runs to resume and replay.
* A CI check that compares snapshots from repeated runs and replay.

The run directory contains the manifest, copied inputs, event history, cached LLM responses where applicable, and iteration snapshots.

The intended guarantee is that a recorded run can be reproduced byte-for-byte under the engine's defined execution environment and inputs—not that the underlying real-world assumptions are guaranteed to be correct.

## Optional LLM agents

Six optional agents can help prepare inputs and explain results:

| Agent        | Role                                                             |
| ------------ | ---------------------------------------------------------------- |
| Requirements | Drafts quantified requirements                                   |
| Decomposer   | Proposes finer-grained uncertainty parameters                    |
| Hybrids      | Proposes variants of existing options under defined restrictions |
| Evidence     | Converts measurement notes into structured evidence              |
| Critic       | Reviews the engine's checks                                      |
| Explainer    | Drafts human-readable explanations                               |

**LLMs propose; the engine validates and decides.**

Agent responses are checked against JSON schemas and semantic constraints. Human approval is required where specified. Rejected responses are retried with validation errors, then fail explicitly if they remain invalid.

Responses are cached by model, prompt, and schema hashes so recorded runs do not need to call the API again during replay.

The default model configuration uses Claude Opus for requirements, decomposition, and critique, and Claude Sonnet for evidence and explanation. Using the agents requires `ANTHROPIC_API_KEY`; the core discovery engine does not require it.

## Validation

The repository's worked-example acceptance tests report the following results:

| Check                                                      | Reported result                                   |
| ---------------------------------------------------------- | ------------------------------------------------- |
| Posterior interval coverage across 20 seeds                | 90.0%, within the reported 99% band of 86.7–93.3% |
| Average posterior width for measured parameters            | Reduced to 22% of prior width                     |
| Wrong selections versus the engine's modeled probabilities | 1 in 20                                           |
| Over-built selections in the worked example                | 0 of 20                                           |
| EVPPI identifies the deliberately decisive parameter       | 5 of 5 seeds                                      |
| Run, resume, and replay reproducibility                    | Byte-identical snapshots                          |
| Adversarial LLM text changes candidate rankings            | Never in the tested cases                         |

These results describe the bundled validation setup, not a universal guarantee of real-world accuracy. The example uses a known simulated truth, and real projects may have misspecified models, missing options, or incorrect cost assumptions.

## Design boundaries and limitations

Goldilocks deliberately operates within a defined scope.

* **Finite search space:** every candidate comes from the supplied catalog. Practical capacity is roughly 2,000 combinations.
* **Discrete choices:** continuous settings must be represented as discrete options.
* **One decision at a time:** the engine evaluates a particular design problem, rather than jointly optimizing an entire portfolio of decisions.
* **Model-dependent results:** requirements, formulas, priors, and cost estimates determine the quality of the conclusions.
* **Soundness is not completeness:** the qualifying set is designed to satisfy its probability threshold under the model, but potentially viable options may be omitted—particularly when their feasibility depends on uncertainty the engine judges not worth measuring.
* **No automatic deployment:** the engine evaluates and compares proposed designs; it does not establish that a candidate is production-ready or deploy it for you.

Goldilocks can systematically search a defined space. It cannot discover an option that was never represented, compensate for every missing requirement, or turn an unsupported assumption into reliable evidence.

## Repository structure

```text
src/
  cli.ts                 Command-line entry point
  commands.ts            Command implementations
  core/                  RNG, math, distributions, statistics, formulas
  model/                 Schemas, loader, parameter tree
  engine/                Generation, evaluation, updating, selection, planning
  agents/                Optional LLM client, agents, caching, guards
  report/                 Report data, Markdown, HTML, charts, diffs
  approval.ts             Human approval gates

fixtures/cloud/           Worked example
templates/blank/          Starter template
tests/                    Unit and acceptance tests
GUIDE.md                  Full walkthrough
CLAUDE.md                 Claude Code project instructions
.claude/skills/goldilocks/ Goldilocks workflow instructions
```

## The guiding principle

**Don't overbuild because you're uncertain. Find out which solutions satisfy the requirements, identify the unknowns that matter, and spend effort where it can improve the decision.**

Goldilocks turns system design from a search driven primarily by intuition into a structured process of requirements, candidate discovery, probabilistic evaluation, evidence gathering, and reproducible decisions.
