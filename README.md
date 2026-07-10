# card-fanout

Turn a markdown work card into a parallel agent fan-out — deterministic parsing outside,
cheap workers and acceptance verdicts inside. For [Claude Code](https://claude.com/claude-code)'s
Workflow tool.

## What's in the box

**"card-fanout" is the name of the pipeline, not a command — there is no `card-fanout`
executable.** The repo ships two files that run separately, in two different runtimes,
in sequence:

| File | What it is | Who runs it | What it does |
|---|---|---|---|
| **`fan-out.py`** | a normal Python CLI | **you**, in a shell | reads a card file, validates its guards and dependencies, extracts the Action items, and prints an **args JSON**. Zero LLM calls — it never launches agents. |
| **`card-fanout.js`** | a Claude Code **Workflow script** — not executable on its own | **Claude Code's Workflow tool**, with the JSON from step 1 as `args` | the actual fan-out: one agent per item, in the mode the JSON specifies |

The output of the first is the input of the second. That's the whole contract.

There is no `--tags` or similar routing flag: the only switch is `--mode recon|execute`
on the Python side, which just gets embedded in the JSON.

## The easy path (inside Claude Code)

In practice you rarely run either half by hand. In a Claude Code session, say:

> Fan out card MY-CARD-0042 in recon mode using fan-out.py and card-fanout.js.

Claude runs the Python step, takes the JSON, and launches the Workflow for you. The manual
two-step below only matters when you want to inspect or edit the args between the halves —
or on the first run, so you see what each half actually produces.

## The manual two-step

```bash
# Step 1 (your shell): parse + validate the card, emit args
python3 fan-out.py MY-CARD-0042 --mode recon --out args.json
# refuses (exit 2) if owner/sink/kill are empty/none/tbd or a dependency isn't done

# Step 2 (inside Claude Code): launch the workflow with those args
#   Workflow({scriptPath: "card-fanout.js", args: <contents of args.json>})
# or simply tell Claude: "run card-fanout.js with the args in args.json"
```

## The idea

If you track work as one markdown card per task (YAML front-matter with `owner` / `sink` /
`kill` guards, an `## Action` list, a `## Done when` sentence), then **the card already IS
the plan**. You should not pay an LLM to re-plan it, and you should not let a re-plan drift
from the card's own rubric.

Why two files instead of one? Workflow scripts have no filesystem access, so the parsing
half *must* live outside. That constraint turns out to be the feature: validation is
deterministic and free, and the expensive part starts only after the card has earned it.

## Two modes

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
