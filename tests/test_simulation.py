"""Tests for the Python quantitative engine.

Run with: .venv/Scripts/python -m unittest discover -s tests -p "test_*.py"
"""

import json
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MAIN = ROOT / "python" / "main.py"


def call(task, payload=None):
    proc = subprocess.run(
        [sys.executable, str(MAIN)],
        input=json.dumps({"task": task, "payload": payload or {}}),
        capture_output=True,
        text=True,
        cwd=ROOT,
        check=False,
    )
    return json.loads(proc.stdout)


class EngineProtocolTests(unittest.TestCase):
    def test_ping_reports_library_versions(self):
        out = call("ping")
        self.assertTrue(out["ok"])
        self.assertIn("numpy", out["result"])

    def test_unknown_task_is_reported_as_json_error(self):
        out = call("does_not_exist")
        self.assertFalse(out["ok"])
        self.assertIn("Unknown task", out["error"])


if __name__ == "__main__":
    unittest.main()
