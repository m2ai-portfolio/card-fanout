# card-fanout

Turn a markdown work card into a parallel agent fan-out — deterministic parsing outside,
cheap workers and acceptance verdicts inside. For [Claude Code](https://claude.com/claude-code)'s
Workflow tool.

## The idea

If you track work as one markdown card per task (YAML front-matter with `owner` / `sink` /
`kill` guards, an `## Action` list, a `## Done when` sentence), then **the card already IS
the plan**. You should not pay an LLM to re-plan it, and you should not let a re-plan drift
from the card's own rubric.

`card-fanout` splits the pipeline where the runtime forces it to split:

| Half | Runs where | Does what |
|---|---|---|
| **`fan-out.py`** | plain Python, zero LLM calls | parses the card, refuses it if guards are fake or dependencies aren't done, extracts Action items, derives acceptance checks, emits args JSON |
| **`card-fanout.js`** | Claude Code Workflow tool | fans out one agent per item — read-only recon, or execution with per-item acceptance verdicts |

Workflow scripts have no filesystem access, so the parsing half *must* live outside. That
constraint turns out to be the feature: validation is deterministic and free, and the
expensive part starts only after the card has earned it.

## Usage

```bash
# 1. Parse + validate the card, emit args
python3 fan-out.py MY-CARD-0042 --mode recon --out args.json
# refuses (exit 2) if owner/sink/kill are empty/none/tbd or a dependency isn't done

# 2. In Claude Code, launch the workflow with those args
#    Workflow({scriptPath: "card-fanout.js", args: <contents of args.json>})
```

Two modes:

- **`recon`** (default): one **read-only** agent per Action item. Each returns structured
  findings, a pass/fail where verifiable read-only, and an exact live-probe plan for the
  mutating part. Run this before you decide anything.
- **`execute`**: cheap pinned workers (default `sonnet`) complete each item in parallel;
  the session model judges every result against its acceptance check and returns
  `{passed, failed: [{title, reason, fix}], artifacts}`. Run the session on your strongest
  model — it does the judging, the cheap model does the lifting.

No card? Pass `args: {request: "what to do", mode: "execute"}` and the session model plans
3-7 independent items first (the original plan/execute/verify shape this tool grew from).

## Card format

```markdown
---
id: MY-CARD-0042
title: One line
status: todo            # todo | doing | done | blocked
owner: who reads the result
sink: where the result lands
kill: when to stop trying
depends_on: []
---
## Action
1. First item ...
2. Second item ...
## Done when
One sentence an observer could verify.
```

The `owner`/`sink`/`kill` refusal implements the "no orphan loops" convention: work with no
reader, no destination, or no stop condition does not get to spend tokens.

Cards directory: `--cards-dir`, or `$CARDS_DIR`, or `~/vault/active-work/cards` by default.
An example card lives in [`example/`](example/).

## Why recon-first is the default

The first live run of this tool root-caused a file-permission regression that three prior
hypotheses (all plausible, all wrong) would have wasted a build cycle on: one read-only
Sonnet agent diffed two container versions, ruled out two of the three suggested fixes, and
returned the exact patch plan. Cheap recon before expensive build is the whole posture.

## Requirements

- Claude Code with the Workflow tool (paid plan; v2.1.154+)
- Python 3.9+ (stdlib only)

## License

MIT
