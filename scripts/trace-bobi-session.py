#!/usr/bin/env python3
"""Summarize one Bobi NanoClaw session without printing message contents."""

from __future__ import annotations

import argparse
import json
import re
import sqlite3
from collections import Counter
from datetime import datetime
from pathlib import Path


AGENT_GROUP_ID = "ag-1783583592620-z4xczb"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("session_id")
    parser.add_argument("--root", type=Path, default=Path("data/v2-sessions"))
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    group_root = args.root / AGENT_GROUP_ID
    outbound_db = group_root / args.session_id / "outbound.db"

    session_root = group_root / args.session_id
    inbound_db = session_root / "inbound.db"

    with sqlite3.connect(f"file:{outbound_db}?mode=ro", uri=True) as db:
        row = db.execute(
            "SELECT value FROM session_state WHERE key = ?",
            ("continuation:claude",),
        ).fetchone()
    if not row:
        raise SystemExit(f"No Claude continuation for {args.session_id}")

    continuation = row[0]
    trace = (
        group_root
        / ".claude-shared/projects/-workspace-agent"
        / f"{continuation}.jsonl"
    )

    requests: dict[str, dict] = {}
    tool_ids: set[str] = set()
    tool_names: list[str] = []
    tool_errors = 0
    compactions = 0
    timestamps: list[datetime] = []

    trace_turns: list[dict] = []
    current_turn: dict | None = None

    with trace.open() as handle:
        for line in handle:
            event = json.loads(line)
            timestamp = event.get("timestamp")
            if timestamp:
                timestamps.append(datetime.fromisoformat(timestamp.replace("Z", "+00:00")))

            if event.get("type") == "system" and event.get("subtype") == "compact_boundary":
                compactions += 1

            message = event.get("message") or {}
            content = message.get("content") or []
            is_inbound_turn = (
                event.get("type") == "user"
                and message.get("role") == "user"
                and isinstance(content, str)
            )
            if is_inbound_turn:
                current_turn = {
                    "started_at": timestamp,
                    "request_ids": set(),
                    "tool_names": [],
                    "tool_errors": 0,
                    "write_attempts": [],
                }
                trace_turns.append(current_turn)

            request_id = event.get("requestId")
            if event.get("type") == "assistant" and request_id and message.get("usage"):
                requests[request_id] = event
                if current_turn is not None:
                    current_turn["request_ids"].add(request_id)

            if not isinstance(content, list):
                continue
            for item in content:
                if not isinstance(item, dict):
                    continue
                if item.get("type") == "tool_use":
                    tool_ids.add(item["id"])
                    tool_name = item.get("name", "unknown")
                    tool_names.append(tool_name)
                    if current_turn is not None:
                        current_turn["tool_names"].append(tool_name)
                        tool_input = item.get("input") or {}
                        command = str(tool_input.get("command") or "")
                        if tool_name in {"Write", "Edit", "NotebookEdit"}:
                            current_turn["write_attempts"].append(tool_name)
                        elif tool_name == "Bash":
                            source_write = re.search(
                                r"(?:tee|cp|mv|rm|mkdir|touch)\s+[^\n]*(?:/workspace/(?:extra|agent)|/opt/repos)",
                                command,
                            ) or re.search(r">>?\s*(?:/workspace/(?:extra|agent)|/opt/repos)", command)
                            artifact_write = any(
                                marker in command
                                for marker in (
                                    "git commit", "aws s3 cp", "aws s3 rm",
                                    "run_analysis.py", " deploy", " publish",
                                )
                            )
                            if source_write or artifact_write:
                                current_turn["write_attempts"].append(command[:180])
                elif item.get("type") == "tool_result" and item.get("is_error"):
                    tool_errors += 1
                    if current_turn is not None:
                        current_turn["tool_errors"] += 1

    usages = [(event.get("message") or {}).get("usage") or {} for event in requests.values()]

    def total(key: str) -> int:
        return sum(int(usage.get(key) or 0) for usage in usages)

    peak_context = max(
        (
            int(usage.get("input_tokens") or 0)
            + int(usage.get("cache_creation_input_tokens") or 0)
            + int(usage.get("cache_read_input_tokens") or 0)
            for usage in usages
        ),
        default=0,
    )
    duration = (max(timestamps) - min(timestamps)).total_seconds() if timestamps else 0

    with sqlite3.connect(f"file:{inbound_db}?mode=ro", uri=True) as db:
        db.row_factory = sqlite3.Row
        inbound = list(db.execute(
            "SELECT id, seq, timestamp, status FROM messages_in ORDER BY seq"
        ))
        delivered = {
            row["message_out_id"]: row
            for row in db.execute(
                "SELECT message_out_id, platform_message_id, delivered_at FROM delivered"
            )
        }

    with sqlite3.connect(f"file:{outbound_db}?mode=ro", uri=True) as db:
        db.row_factory = sqlite3.Row
        outbound = list(db.execute(
            "SELECT id, seq, in_reply_to, timestamp, kind, content FROM messages_out ORDER BY seq"
        ))

    def parse_time(value: str | None) -> datetime | None:
        if not value:
            return None
        return datetime.fromisoformat(value.replace("Z", "+00:00") + ("+00:00" if "T" not in value and "+" not in value else ""))

    turn_rows = []
    for index, inbound_row in enumerate(inbound):
        replies = [row for row in outbound if row["in_reply_to"] == inbound_row["id"]]
        start = parse_time(inbound_row["timestamp"])
        first_out = min((parse_time(row["timestamp"]) for row in replies), default=None)
        delivered_times = [
            parse_time(delivered[row["id"]]["delivered_at"])
            for row in replies if row["id"] in delivered
        ]
        first_delivery = min(delivered_times, default=None)
        normalized = []
        for row in replies:
            try:
                normalized.append(json.loads(row["content"]).get("text", "").strip())
            except (json.JSONDecodeError, AttributeError):
                normalized.append(row["content"].strip())
        counts = Counter(normalized)
        trace_turn = trace_turns[index] if index < len(trace_turns) else {}
        request_ids = trace_turn.get("request_ids", set())
        turn_usages = [
            (requests[request_id].get("message") or {}).get("usage") or {}
            for request_id in request_ids if request_id in requests
        ]
        turn_peak = max((
            int(usage.get("input_tokens") or 0)
            + int(usage.get("cache_creation_input_tokens") or 0)
            + int(usage.get("cache_read_input_tokens") or 0)
            for usage in turn_usages
        ), default=0)
        turn_rows.append({
            "inbound_id": inbound_row["id"],
            "inbound_seq": inbound_row["seq"],
            "status": inbound_row["status"],
            "outbound_count": len(replies),
            "exact_duplicate_count": sum(count - 1 for count in counts.values()),
            "latency_to_first_outbound_seconds": round((first_out - start).total_seconds(), 3) if start and first_out else None,
            "latency_to_first_delivery_seconds": round((first_delivery - start).total_seconds(), 3) if start and first_delivery else None,
            "requests": len(request_ids),
            "tool_calls": len(trace_turn.get("tool_names", [])),
            "tool_names": trace_turn.get("tool_names", []),
            "tool_errors": trace_turn.get("tool_errors", 0),
            "peak_context_tokens": turn_peak,
            "write_attempts": trace_turn.get("write_attempts", []),
        })

    print(
        json.dumps(
            {
                "session_id": args.session_id,
                "continuation": continuation,
                "trace": str(trace),
                "duration_seconds": round(duration, 3),
                "requests": len(requests),
                "input_tokens": total("input_tokens"),
                "cache_creation_tokens": total("cache_creation_input_tokens"),
                "cache_read_tokens": total("cache_read_input_tokens"),
                "output_tokens": total("output_tokens"),
                "peak_context_tokens": peak_context,
                "tool_calls": len(tool_ids),
                "tool_errors": tool_errors,
                "tool_names": tool_names,
                "compactions": compactions,
                "turns": turn_rows,
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
