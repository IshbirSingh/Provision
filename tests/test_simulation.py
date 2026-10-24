"""Tests for the Python quantitative engine (spec section 8).

Run with: .venv/Scripts/python -m unittest discover -s tests -p "test_*.py"
"""

import copy
import json
import subprocess
import sys
import unittest
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
MAIN = ROOT / "python" / "main.py"
sys.path.insert(0, str(ROOT / "python"))

import analysis  # noqa: E402
import demand_model  # noqa: E402
import metrics  # noqa: E402
import policies  # noqa: E402
import simulation  # noqa: E402

QUANTILES = {"lean": 0.5, "balanced": 0.8, "resilient": {"critical": 0.95, "essential": 0.9, "standard": 0.8}}


def call(task, payload=None):
    proc = subprocess.run(
        [sys.executable, str(MAIN)],
        input=json.dumps({"task": task, "payload": payload or {}}),
        capture_output=True, text=True, cwd=ROOT, check=False,
    )
    return json.loads(proc.stdout)


def product(name="Rice", priority="essential", mu=10.0, var=None, stock=60, lead=3, shelf=None, batches=None, category="staple_carbohydrates"):
    return {
        "name": name, "category": category, "priority": priority, "unit": "bag",
        "dailyDemand": mu, "dailyVariance": mu if var is None else var, "seasonalMultiplier": 1.0,
        "currentStock": stock, "leadTimeDays": lead, "shelfLifeDays": shelf, "unitCost": None,
        "batches": batches or [],
    }


def payload(products, runs=400, horizon=21, seed=7, capacity=None, success=1.0, **cfg):
    config = {
        "scenarioId": "normal_operations", "demandIncrease": 0.0, "reserveDays": 7, "applyReserve": False,
        "additionalDeliveryDelayDays": 0, "deliveryQuantityReduction": 0.0, "planningHorizonDays": horizon,
        "numberOfRuns": runs, "randomSeed": seed,
    }
    config.update(cfg)
    return {
        "config": config,
        "asOf": "2026-10-24",
        "global": {"reviewPeriodDays": 7, "deliverySuccessProbability": success, "quantiles": QUANTILES, "categoryCapacity": capacity or {}},
        "products": products,
    }


class EngineProtocolTests(unittest.TestCase):
    def test_ping_reports_library_versions(self):
        out = call("ping")
        self.assertTrue(out["ok"])
        self.assertIn("numpy", out["result"])

    def test_unknown_task_is_reported_as_json_error(self):
        out = call("does_not_exist")
        self.assertFalse(out["ok"])
        self.assertIn("Unknown task", out["error"])

    def test_invalid_scenario_is_rejected(self):
        out = call("simulate", payload({"rice": product()}, demandIncrease=1.5))
        self.assertFalse(out["ok"])
        self.assertIn("demandIncrease", out["error"])


class DemandModelTests(unittest.TestCase):
    def test_samples_are_non_negative_integers(self):
        rng = np.random.default_rng(1)
        for alpha in (0.0, 0.3):
            x = demand_model.sample(rng, 5.0, alpha, (10000,))
            self.assertEqual(x.dtype.kind, "i")
            self.assertGreaterEqual(x.min(), 0)

    def test_poisson_mean_and_variance_converge(self):
        x = demand_model.sample(np.random.default_rng(2), 12.0, 0.0, (200000,))
        self.assertAlmostEqual(x.mean(), 12.0, delta=0.05)
        self.assertAlmostEqual(x.var(), 12.0, delta=0.2)

    def test_negative_binomial_follows_mean_dispersion_form(self):
        mu, alpha = 8.0, 0.25
        x = demand_model.sample(np.random.default_rng(3), mu, alpha, (400000,))
        self.assertAlmostEqual(x.mean(), mu, delta=0.05)
        self.assertAlmostEqual(x.var(), mu + alpha * mu ** 2, delta=0.25)  # 24

    def test_method_of_moments_matches_spec_for_weekly_totals(self):
        weekly = [70, 84, 56, 91, 63]
        mu, v = demand_model.estimate_daily(weekly, [7] * 5)
        self.assertAlmostEqual(mu, np.mean(weekly) / 7)
        self.assertAlmostEqual(v, np.var(weekly, ddof=1) / 7)
        self.assertEqual(demand_model.choose_model(10, 8), ("poisson", 0.0))
        model, alpha = demand_model.choose_model(10, 30)
        self.assertEqual(model, "negative_binomial")
        self.assertAlmostEqual(alpha, 0.2)

    def test_horizon_quantile_is_exact_for_sums_of_days(self):
        rng = np.random.default_rng(4)
        for alpha in (0.0, 0.2):
            sums = demand_model.sample(rng, 6.0, alpha, (100000, 10)).sum(axis=1)
            for q in (0.5, 0.8, 0.95):
                exact = demand_model.horizon_quantile(6.0, alpha, 10, q)
                self.assertLessEqual(abs(exact - np.quantile(sums, q)), 2, (alpha, q))


class MetricTests(unittest.TestCase):
    def test_cvar_is_mean_of_worst_tail(self):
        losses = np.arange(1, 101)  # worst 5% are 96..100
        self.assertAlmostEqual(metrics.cvar(losses, 0.95), 98.0)

    def test_service_level_undefined_without_demand(self):
        self.assertIsNone(metrics.service_level([0, 0], [0, 0]))
        self.assertAlmostEqual(metrics.service_level([5], [50]), 0.9)


class SimulationTests(unittest.TestCase):
    def test_reproducible_with_same_seed(self):
        p = payload({"rice": product(), "beans": product("Beans", var=40)})
        a, b = simulation.run(copy.deepcopy(p)), simulation.run(copy.deepcopy(p))
        a.pop("runtimeMs"), b.pop("runtimeMs")
        self.assertEqual(json.dumps(a, sort_keys=True), json.dumps(b, sort_keys=True))

    def test_does_not_modify_the_approved_baseline(self):
        p = payload({"rice": product()}, demandIncrease=0.5, additionalDeliveryDelayDays=4)
        before = copy.deepcopy(p)
        simulation.run(p)
        self.assertEqual(p, before)

    def test_invariants_hold(self):
        out = simulation.run(payload({"rice": product(stock=5), "beans": product("Beans", var=60, stock=200)}, success=0.7))
        self.assertTrue(out["checks"]["inventoryNonNegative"])
        self.assertTrue(out["checks"]["inventoryBalances"])
        self.assertTrue(out["checks"]["demandNonNegativeIntegers"])

    def test_policies_are_ordered_lean_balanced_resilient(self):
        out = simulation.run(payload({"rice": product(var=30)}))
        t = {k: v["products"]["rice"]["target"] for k, v in out["policies"].items()}
        self.assertLess(t["lean"], t["balanced"])
        self.assertLessEqual(t["balanced"], t["resilient"])
        u = {k: v["totals"]["expectedUnmet"] for k, v in out["policies"].items()}
        self.assertGreaterEqual(u["lean"], u["balanced"])
        self.assertGreaterEqual(u["balanced"], u["resilient"])

    def test_deliveries_arrive_only_after_lead_time(self):
        # No stock and a 5-day lead time: nothing can be served on days 0-4.
        out = simulation.run(payload({"rice": product(stock=0, lead=5)}, runs=200, horizon=10))
        daily = out["policies"]["resilient"]["products"]["rice"]["daily"]["mean"]
        self.assertEqual(daily[:5], [0.0] * 5)
        self.assertEqual(out["policies"]["resilient"]["products"]["rice"]["shortageBeforeFirstDelivery"], 1.0)

    def test_inventory_position_includes_orders_in_transit(self):
        # Long lead time: with orders in transit counted, later orders stay small.
        out = simulation.run(payload({"rice": product(stock=0, lead=14)}, runs=100, horizon=28))
        r = out["policies"]["balanced"]["products"]["rice"]
        self.assertLessEqual(r["averageOrdered"], r["target"] + 10 * 28)

    def test_increased_demand_and_disruption_increase_shortages(self):
        prods = {"rice": product(var=30, stock=80), "formula": product("Formula", "critical", mu=3, var=6, stock=15)}
        base = simulation.run(payload(prods))
        more = simulation.run(payload(prods, scenarioId="increased_demand", demandIncrease=0.4))
        late = simulation.run(payload(prods, scenarioId="delivery_disruption", additionalDeliveryDelayDays=7, deliveryQuantityReduction=0.3))
        for pol in ("lean", "balanced"):
            self.assertGreater(more["policies"][pol]["totals"]["expectedUnmet"], base["policies"][pol]["totals"]["expectedUnmet"])
            self.assertGreater(late["policies"][pol]["totals"]["expectedUnmet"], base["policies"][pol]["totals"]["expectedUnmet"])

    def test_reserve_raises_or_keeps_targets(self):
        prods = {"rice": product(var=30)}
        base = simulation.run(payload(prods))
        safe = simulation.run(payload(prods, scenarioId="safety_first", reserveDays=21, applyReserve=True))
        for pol in ("balanced", "resilient"):
            self.assertGreaterEqual(safe["policies"][pol]["products"]["rice"]["target"], base["policies"][pol]["products"]["rice"]["target"])
        self.assertEqual(safe["policies"]["balanced"]["products"]["rice"]["target"], 210)  # ceil(21 * 10)
        self.assertEqual(safe["policies"]["lean"]["products"]["rice"]["target"], base["policies"]["lean"]["products"]["rice"]["target"])

    def test_capacity_caps_orders(self):
        prods = {"rice": product(stock=0), "pasta": product("Pasta", priority="standard", stock=0)}
        out = simulation.run(payload(prods, capacity={"staple_carbohydrates": 50}))
        for pol in out["policies"].values():
            orders = sum(pol["products"][p]["initialOrder"] for p in prods)
            self.assertLessEqual(orders, 50)
            # Essential rice is filled before standard pasta.
            self.assertGreaterEqual(pol["products"]["rice"]["initialOrder"], pol["products"]["pasta"]["initialOrder"])
            self.assertLessEqual(pol["totals"]["utilisation"]["staple_carbohydrates"]["max"], 1.0)

    def test_fefo_uses_earliest_dated_stock_first(self):
        # 40 units expire in 5 days, 40 later. At 10/day FEFO uses the early batch first: no waste.
        batches = [{"quantity": 40, "expiryDate": "2026-10-29"}, {"quantity": 40, "expiryDate": "2027-06-01"}]
        out = simulation.run(payload({"rice": product(mu=10, stock=80, batches=batches)}, runs=300))
        waste = out["policies"]["lean"]["products"]["rice"]["expectedWaste"]
        self.assertLess(waste, 3)

    def test_waste_is_unavailable_without_expiry_data(self):
        out = simulation.run(payload({"rice": product()}))
        self.assertIsNone(out["policies"]["lean"]["products"]["rice"]["expectedWaste"])
        self.assertIsNone(out["policies"]["lean"]["totals"]["expectedWaste"])

    def test_perishable_deliveries_expire(self):
        out = simulation.run(payload({"apples": product("Apples", "standard", mu=2, stock=0, lead=1, shelf=3, category="fresh_produce")}, horizon=28))
        self.assertGreater(out["policies"]["resilient"]["products"]["apples"]["expectedWaste"], 0)

    def test_policies_share_random_conditions(self):
        p = payload({"rice": product(var=25)})
        out = simulation.run(p)
        # Same demand across policies: simulated demand means are identical.
        means = {v["products"]["rice"]["simulatedDemandMean"] for v in out["policies"].values()}
        self.assertEqual(len(means), 1)

    def test_preview_reports_where_reserve_binds(self):
        out = simulation.preview(payload({"rice": product(var=30)}))
        days = out["rice"]["bindsFromDays"]["balanced"]
        self.assertEqual(days, out["rice"]["balanced"] // 10 + 1)


class AnalysisTests(unittest.TestCase):
    def records(self, quantities, hints=None):
        from datetime import date, timedelta
        start = date(2026, 1, 5)
        return [
            {"productId": "rice", "date": (start + timedelta(weeks=i)).isoformat(), "quantity": q, "movementHints": (hints or {}).get(i, [])}
            for i, q in enumerate(quantities)
        ]

    def run_one(self, quantities, hints=None):
        out = analysis.run({
            "asOf": "2026-04-01", "horizonDays": 14, "holidays": [],
            "products": {"rice": {"name": "Rice", "category": "staple_carbohydrates", "priority": "essential"}},
            "records": self.records(quantities, hints), "batches": [],
        })
        return out["products"]["rice"]

    def test_falls_are_inferred_consumption_and_rises_are_not_used(self):
        a = self.run_one([200, 130, 60, 250, 180, 110])
        self.assertEqual(a["observations"]["byType"]["fall"], 4)
        self.assertEqual(a["observations"]["byType"]["rise"], 1)
        self.assertAlmostEqual(a["demand"]["weeklyMean"], 70.0)
        self.assertEqual(a["demand"]["label"], "inferred consumption")

    def test_notes_and_stockouts_are_excluded(self):
        a = self.run_one([200, 130, 0, 250, 120, 50, 0], hints={4: ["transfer"]})
        self.assertEqual(a["observations"]["byType"]["excluded"], 1)
        self.assertEqual(a["observations"]["byType"]["censored"], 2)
        codes = {f["code"] for f in a["flags"]}
        self.assertIn("stockouts", codes)
        self.assertIn("excluded_movements", codes)

    def test_insufficient_data_is_not_filled_in(self):
        a = self.run_one([200, 250])
        self.assertFalse(a["demand"]["available"])
        self.assertIn("no_estimate", {f["code"] for f in a["flags"]})


if __name__ == "__main__":
    unittest.main()
