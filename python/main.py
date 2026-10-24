"""Provision quantitative engine entry point.

Reads {"task": ..., "payload": {...}} as JSON from stdin and writes
{"ok": true, "result": ...} or {"ok": false, "error": ...} to stdout.
This process never reads or writes data/data.json.
"""

import json
import sys
import traceback

import numpy as np
import pandas as pd
import scipy

import analysis
import capacity
import simulation


def ping(_payload):
    return {
        "python": sys.version.split()[0],
        "numpy": np.__version__,
        "pandas": pd.__version__,
        "scipy": scipy.__version__,
    }


TASKS = {
    "ping": ping,
    "analyse": analysis.run,
    "simulate": simulation.run,
    "preview": simulation.preview,
    "capacity": capacity.run,
}


def _to_jsonable(obj):
    """Convert NumPy types so json.dumps can serialise them."""
    if isinstance(obj, np.integer):
        return int(obj)
    if isinstance(obj, np.floating):
        value = float(obj)
        return None if np.isnan(value) or np.isinf(value) else value
    if isinstance(obj, np.ndarray):
        return obj.tolist()
    raise TypeError(f"Object of type {type(obj).__name__} is not JSON serialisable")


def main():
    try:
        request = json.loads(sys.stdin.read() or "{}")
        task = request.get("task")
        if task not in TASKS:
            raise ValueError(f"Unknown task: {task!r}")
        result = TASKS[task](request.get("payload") or {})
        out = {"ok": True, "result": result}
    except Exception as exc:  # report every failure as JSON to the bridge
        out = {"ok": False, "error": str(exc), "trace": traceback.format_exc()}
    sys.stdout.write(json.dumps(out, default=_to_jsonable, allow_nan=False))


if __name__ == "__main__":
    main()
