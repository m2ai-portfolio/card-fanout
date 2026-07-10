#!/usr/bin/env python3
"""fan-out.py — deterministic front-end of the card fan-out pipeline.

Pairs with the durable runtime card-fanout.js (a Claude Code Workflow script).
The split is structural: Workflow scripts have no filesystem access, so card
parsing must happen out here. And because the card already IS the plan, the
runtime's LLM planner phase is skipped entirely when items come from a card
(cheaper, and the run converges to the card's own rubric instead of a re-plan).

What it does (pure Python stdlib, zero LLM calls):
  1. parse the card's YAML front-matter; validate owner/sink/kill are REAL values
     (empty / none / tbd / n/a are refused) and that depends_on cards are done —
     the no-orphan-loops contract, enforced before a single token is spent
  2. extract the numbered items under `## Action` (whole section = 1 item if unnumbered)
  3. derive each item's acceptance check (item text + the card's `## Done when`)
  4. emit the args JSON for card-fanout.js

Card format expected (one markdown file per unit of work):
  ---
  id: Q-YYYYMMDD-NNNN         # any stable id works
  title: <one line>
  status: todo                 # todo | doing | done | blocked
  owner: <who reads the result>
  sink: <where the result lands>
  kill: <when to stop trying>
  depends_on: []
  ---
  ## Action
  1. First item ...
  2. Second item ...
  ## Done when
  <one observable sentence>

Usage:
  fan-out.py <card-id-or-path> [--mode recon|execute] [--out ARGS.json] [--force]
              [--cards-dir DIR]
Then, in Claude Code:
  Workflow({scriptPath: "<path-to>/card-fanout.js", args: <the JSON>})

Cards directory resolution: --cards-dir flag, else $CARDS_DIR env,
else ~/vault/active-work/cards.

Exit codes: 0 ok · 1 usage/not-found · 2 guard/dep validation refusal (--force overrides)
MIT. https://github.com/m2ai-portfolio/card-fanout
"""

import json
import os
import re
import sys
from pathlib import Path

DEFAULT_CARDS_DIR = Path(
    os.environ.get("CARDS_DIR", Path.home() / "vault" / "active-work" / "cards")
)
BAD_GUARD = {"", "none", "tbd", "-", "n/a", "na", "todo", "?"}
REQUIRED = ("title", "owner", "sink", "kill")


def find_card(arg: str, cards_dir: Path) -> Path:
    p = Path(arg)
    if p.is_file():
        return p
    hits = sorted(cards_dir.glob(f"{arg}*.md"))
    if not hits:
        sys.exit(f"fan-out.py: no card matching '{arg}' in {cards_dir}")
    if len(hits) > 1:
        sys.exit(f"fan-out.py: ambiguous '{arg}': " + ", ".join(h.name for h in hits))
    return hits[0]


def parse_card(path: Path):
    lines = path.read_text().split("\n")
    if lines[0].strip() != "---":
        sys.exit(f"fan-out.py: {path.name} has no YAML front-matter")
    end = next(i for i in range(1, len(lines)) if lines[i].strip() == "---")
    fm = {}
    for line in lines[1:end]:
        m = re.match(r"^(\w[\w-]*):\s*(.*)$", line)
        if m:
            fm[m.group(1)] = m.group(2).strip()
    return fm, lines[end + 1:]


def section(body, heading):
    out, active = [], False
    for line in body:
        if line.startswith("## "):
            active = line.strip().lower() == f"## {heading}".lower()
            continue
        if active:
            out.append(line)
    return out


def action_items(body):
    """Numbered items under '## Action' (continuations folded); whole section as 1 item if unnumbered."""
    sec = section(body, "Action")
    items, current = [], None
    for line in sec:
        m = re.match(r"^(\d+)\.\s+(.*)$", line)
        if m:
            if current:
                items.append(current)
            current = m.group(2).strip()
        elif current is not None and line.strip():
            current += " " + line.strip()
    if current:
        items.append(current)
    if not items:
        whole = " ".join(l.strip() for l in sec if l.strip())
        if whole:
            items = [whole]
    return items


def item_title(text: str, n: int) -> str:
    m = re.match(r"\*\*(.+?)[:.]?\*\*", text)
    return m.group(1).strip() if m else f"item {n}"


def dep_status(dep_id: str, cards_dir: Path) -> str:
    dirs = [cards_dir] + ([cards_dir / "done"] if (cards_dir / "done").is_dir() else [])
    for d in dirs:
        hits = sorted(d.glob(f"{dep_id}*.md"))
        if hits:
            fm, _ = parse_card(hits[0])
            return fm.get("status", "unknown")
    return "MISSING"


def main(argv):
    if len(argv) < 2 or argv[1] in ("-h", "--help"):
        print(__doc__)
        return 1
    mode, out_path, force, cards_dir = "recon", None, False, DEFAULT_CARDS_DIR
    rest = argv[1:]
    if "--mode" in rest:
        i = rest.index("--mode")
        mode = rest[i + 1]
        del rest[i:i + 2]
    if "--out" in rest:
        i = rest.index("--out")
        out_path = Path(rest[i + 1])
        del rest[i:i + 2]
    if "--cards-dir" in rest:
        i = rest.index("--cards-dir")
        cards_dir = Path(rest[i + 1])
        del rest[i:i + 2]
    if "--force" in rest:
        force = True
        rest.remove("--force")
    if mode not in ("recon", "execute"):
        sys.exit(f"fan-out.py: bad --mode '{mode}' (recon|execute)")

    card_path = find_card(rest[0], cards_dir)
    fm, body = parse_card(card_path)
    card_id = fm.get("id", card_path.stem)
    print(f"card:   {card_id} ({card_path})", file=sys.stderr)
    print(f"title:  {fm.get('title', '?')}", file=sys.stderr)
    print(f"status: {fm.get('status', '?')}  mode: {mode}", file=sys.stderr)

    refuse = []
    for key in REQUIRED:
        val = fm.get(key, "")
        ok = val.lower() not in BAD_GUARD
        print(f"guard {key:6s}: {'OK ' if ok else 'BAD'} {val[:100]}", file=sys.stderr)
        if not ok:
            refuse.append(f"guard '{key}' is not a real value")
    for d in re.findall(r"[A-Za-z]+-\d{8}-\d{4}", fm.get("depends_on", "")):
        s = dep_status(d, cards_dir)
        print(f"dep {d}: {s}", file=sys.stderr)
        if s != "done":
            refuse.append(f"dependency {d} is {s}, not done")
    if refuse and not force:
        for r in refuse:
            print(f"REFUSED: {r}", file=sys.stderr)
        print("(--force to override)", file=sys.stderr)
        return 2

    raw_items = action_items(body)
    done_when = " ".join(l.strip() for l in section(body, "Done when") if l.strip())
    items = [
        {
            "n": i + 1,
            "title": item_title(t, i + 1),
            "detail": t,
            "acceptance": f"This item is genuinely satisfied: {t} "
                          f"(interpret against the card's Done-when: {done_when})",
        }
        for i, t in enumerate(raw_items)
    ]
    print(f"items:  {len(items)}", file=sys.stderr)
    for it in items:
        print(f"  {it['n']}. {it['title']}: {it['detail'][:90]}", file=sys.stderr)

    payload = {
        "card_id": card_id,
        "card_path": str(card_path),
        "mode": mode,
        "done_when": done_when,
        "items": items,
    }
    text = json.dumps(payload, indent=2)
    if out_path:
        out_path.write_text(text)
        print(f"wrote args: {out_path}", file=sys.stderr)
    print(text)
    print(
        "\nnext: Workflow({scriptPath: '<path-to>/card-fanout.js', args: <the JSON above>})",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
