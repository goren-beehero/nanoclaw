from __future__ import annotations

import importlib.util
from pathlib import Path
import unittest

from evaluate_bobi_trajectory import evaluate_turn


TRACE_PATH = Path(__file__).with_name("trace-bobi-session.py")
TRACE_SPEC = importlib.util.spec_from_file_location("trace_bobi_session", TRACE_PATH)
assert TRACE_SPEC and TRACE_SPEC.loader
TRACE_MODULE = importlib.util.module_from_spec(TRACE_SPEC)
TRACE_SPEC.loader.exec_module(TRACE_MODULE)
classify_bash_command = TRACE_MODULE.classify_bash_command
is_broad_search_tool = TRACE_MODULE.is_broad_search_tool


class EvaluateBobiTrajectoryTests(unittest.TestCase):
    def test_classifies_mounted_writes_artifacts_and_broad_searches(self) -> None:
        self.assertEqual(
            classify_bash_command("tee /workspace/extra/ds-pip/new.py; find /workspace/extra"),
            (True, False, True),
        )
        self.assertEqual(
            classify_bash_command("python make_report.py > /workspace/agent/report.html"),
            (False, True, False),
        )
        self.assertTrue(is_broad_search_tool("Grep", {"path": "/workspace/extra/agents-team"}))
        self.assertFalse(
            is_broad_search_tool(
                "Grep",
                {"path": "/workspace/extra/agents-kb/KB/knowledge/data-model.md"},
            )
        )

    def test_supported_turn_accepts_workspace_artifact_only(self) -> None:
        turn = {
            "knowledge_gap_calls": 0,
            "subagent_calls": 0,
            "broad_search_attempts": [],
            "mounted_repo_write_attempts": [],
            "workspace_artifact_write_attempts": ["Write:/workspace/agent/report.html"],
            "exact_duplicate_count": 0,
            "outbound_count": 1,
            "outbound_kind_counts": {"chat": 1},
            "outbound_destinations": ["slack:slack:C-TEST"],
        }

        self.assertEqual(evaluate_turn(turn, expected_platform_id="slack:C-TEST"), [])

    def test_reports_gap_subagent_broad_search_mount_write_duplicate_and_route(self) -> None:
        turn = {
            "knowledge_gap_calls": 1,
            "subagent_calls": 1,
            "broad_search_attempts": ["find /workspace/extra"],
            "mounted_repo_write_attempts": ["Write:/workspace/extra/repo/result.py"],
            "exact_duplicate_count": 1,
            "outbound_count": 2,
            "outbound_kind_counts": {"chat": 2},
            "outbound_destinations": ["slack:slack:C-WRONG"],
        }

        errors = evaluate_turn(turn, expected_platform_id="slack:C-TEST")

        self.assertEqual(len(errors), 6)
        self.assertTrue(any("knowledge_gap_calls" in error for error in errors))
        self.assertTrue(any("wrong outbound destinations" in error for error in errors))

    def test_allows_one_expected_boundary_gap(self) -> None:
        turn = {
            "knowledge_gap_calls": 1,
            "subagent_calls": 0,
            "broad_search_attempts": [],
            "mounted_repo_write_attempts": [],
            "exact_duplicate_count": 0,
            "outbound_count": 1,
            "outbound_kind_counts": {"chat": 1},
            "outbound_destinations": ["slack:slack:C-TEST"],
        }

        self.assertEqual(
            evaluate_turn(turn, expected_platform_id="slack:C-TEST", max_gap_calls=1),
            [],
        )


if __name__ == "__main__":
    unittest.main()
