#!/usr/bin/env python3
"""Validate one turn from trace-bobi-session.py against rollout invariants."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


def evaluate_turn(
    turn: dict[str, Any],
    *,
    expected_platform_id: str | None = None,
    max_gap_calls: int = 0,
    max_subagent_calls: int = 0,
    max_broad_searches: int = 0,
    max_mounted_writes: int = 0,
    max_exact_duplicates: int = 0,
) -> list[str]:
    errors: list[str] = []
    checks = (
        ("knowledge_gap_calls", max_gap_calls),
        ("subagent_calls", max_subagent_calls),
        ("broad_search_attempts", max_broad_searches),
        ("mounted_repo_write_attempts", max_mounted_writes),
        ("exact_duplicate_count", max_exact_duplicates),
    )
    for field, maximum in checks:
        value = turn.get(field, 0)
        count = len(value) if isinstance(value, list) else int(value or 0)
        if count > maximum:
            errors.append(f"{field}={count} exceeds {maximum}")

    if expected_platform_id:
        destinations = turn.get("outbound_destinations") or []
        wrong = [destination for destination in destinations if not destination.endswith(f":{expected_platform_id}")]
        if wrong:
            errors.append(f"wrong outbound destinations: {wrong}")
        if turn.get("outbound_count", 0) and not destinations:
            chat_count = int((turn.get("outbound_kind_counts") or {}).get("chat", 0))
            if chat_count:
                errors.append("chat output has no explicit destination")
    return errors


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("trace", type=Path)
    selector = parser.add_mutually_exclusive_group(required=True)
    selector.add_argument("--turn", type=int)
    selector.add_argument("--inbound-id")
    parser.add_argument("--expected-platform-id")
    parser.add_argument("--max-gap-calls", type=int, default=0)
    parser.add_argument("--max-subagent-calls", type=int, default=0)
    parser.add_argument("--max-broad-searches", type=int, default=0)
    parser.add_argument("--max-mounted-writes", type=int, default=0)
    parser.add_argument("--max-exact-duplicates", type=int, default=0)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    payload = json.loads(args.trace.read_text())
    turns = payload.get("turns") or []
    if args.turn is not None:
        try:
            turn = turns[args.turn]
        except IndexError as exc:
            raise SystemExit(f"turn index out of range: {args.turn}") from exc
    else:
        turn = next((item for item in turns if item.get("inbound_id") == args.inbound_id), None)
        if turn is None:
            raise SystemExit(f"inbound id not found: {args.inbound_id}")

    errors = evaluate_turn(
        turn,
        expected_platform_id=args.expected_platform_id,
        max_gap_calls=args.max_gap_calls,
        max_subagent_calls=args.max_subagent_calls,
        max_broad_searches=args.max_broad_searches,
        max_mounted_writes=args.max_mounted_writes,
        max_exact_duplicates=args.max_exact_duplicates,
    )
    print(json.dumps({"inbound_id": turn.get("inbound_id"), "ok": not errors, "errors": errors}, indent=2))
    if errors:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
